/**
 * dsh-bz —— 零依赖规则注入器（host 端）
 *
 * ⭐⭐ 铁律（2026-10-27 实测踩出来的）：
 *   **外部插件 ⛔ 不能 import `@deepseek-ai/*` 的包。**
 *   实测：`import { createUserMessage } from '@deepseek-ai/dsh-llm'`
 *   ⇒ `ERR_MODULE_NOT_FOUND: Cannot find package` ⇒ **插件加载直接失败**。
 *   原因：profile 的 node_modules 里**没有 @deepseek-ai 目录** —— 那是宿主自己的，
 *   不给插件解析（对照：能工作的 `dsh-global-rules` 只 import `node:` 内置模块）。
 *   ⇒ 必须内联。`schemastery`（Config 校验）同理，改为手写校验。
 *
 * ⭐ 它解决的问题：把「必须做 / 禁止做」这类约束**在会话生命周期里反复注入**，
 *   而不是只在第一条消息说一次（后者在长对话、/compact、/resume 之后就丢了）。
 */
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

import { collect, render, fingerprint, dshHome, globalRulesPath, rulesRoot } from './rules.js';
import { isPaused, pausePath, setPaused } from './store.js';
import { handle } from './command.js';
// ⭐ 会话字段解析的唯一正本 —— command.js 用的是同一份，⛔ 两侧不许再各猜一套
import { sessionIdOf, cwdOf } from './session.js';

/** Cordis 插件名（loader 诊断 + 注入消息 source 用） */
export const name = 'bz-rules';

/** 需要的宿主服务。⛔ 少声明一个就会被 Cordis 拒绝挂载。 */
export const inject = ['agents', 'commands'];

/* ════════════════════════════════════════════════════════════
 * 内联 1：消息构造
 *   （替代 @deepseek-ai/dsh-llm 的 createUserMessage）
 *   宿主实现：deepFreeze(structuredClone({ ...input, id: brandString(uuid) }))
 *   brandString 只是**类型标记**，运行时就是字符串 ⇒ 直接用 randomUUID()
 * ════════════════════════════════════════════════════════════ */
function deepFreeze(o) {
  try {
    if (o && typeof o === 'object' && !Object.isFrozen(o)) {
      Object.freeze(o);
      for (const k of Object.keys(o)) deepFreeze(o[k]);
    }
  } catch {
    /* 冻结失败不影响使用 */
  }
  return o;
}

function createUserMessage(input) {
  const base = { ...input, id: randomUUID(), role: 'user' };
  let copy;
  try {
    copy = structuredClone(base);              // Node 17+ 内置
  } catch {
    copy = JSON.parse(JSON.stringify(base));   // 兜底
  }
  return deepFreeze(copy);
}

/* ════════════════════════════════════════════════════════════
 * 内联 2：配置校验（替代 @deepseek-ai/schemastery 的 z.object）
 *   ⛔ 不 import schemastery —— 它同样不在 profile 里。
 *   策略：容忍一切非法值，回落到默认 —— 配置错不该让插件挂不上。
 * ════════════════════════════════════════════════════════════ */
const DEFAULTS = { maxBytes: 8192, refreshAfterSteps: 20, injectAtEveryStep: false };

function normalizeConfig(raw) {
  const c = { ...DEFAULTS };
  if (raw && typeof raw === 'object') {
    if (Number.isFinite(raw.maxBytes)) c.maxBytes = Math.max(256, Math.floor(raw.maxBytes));
    if (Number.isFinite(raw.refreshAfterSteps)) {
      c.refreshAfterSteps = Math.max(0, Math.floor(raw.refreshAfterSteps));
    }
    if (typeof raw.injectAtEveryStep === 'boolean') c.injectAtEveryStep = raw.injectAtEveryStep;
  }
  return c;
}

/* ════════════════════════════════════════════════════════════
 * 主体
 * ════════════════════════════════════════════════════════════ */

/** 每个会话上一次注入的 { digest, step } —— 去重与定期重发 */
const lastInjected = new Map();

/** 去重表的容量上限：只存几十字节，但长跑进程不该无限增长 */
const MAX_TRACKED_SESSIONS = 500;

/** 超过上限就丢掉最早插入的一条（Map 保持插入顺序） */
function trimTracked() {
  try {
    while (lastInjected.size > MAX_TRACKED_SESSIONS) {
      const oldest = lastInjected.keys().next().value;
      if (oldest === undefined) break;
      lastInjected.delete(oldest);
    }
  } catch {
    /* ignore */
  }
}

/** 渲染当前该注入的正文。⛔ 任何异常都吞掉并返回 undefined（= 这次不注入） */
function renderFor(agent, cfg) {
  try {
    if (isPaused()) return undefined;              // 熔断：全局暂停
    const sessionId = sessionIdOf(agent);
    const cwd = cwdOf(agent);
    const rules = collect({ cwd, sessionId });
    const text = render(rules, cfg.maxBytes);
    if (!text) return undefined;
    return { text, digest: fingerprint(text) };
  } catch {
    return undefined;                              // ⛔ 读不到规则就不注入，绝不崩
  }
}

/** 插件入口 */
export function apply(ctx, rawConfig = {}) {
  const cfg = normalizeConfig(rawConfig);

  // ── 生命周期：会话启动 ⇒ 丢掉去重记录，下次强制重发 ──
  try {
    ctx.on('agent/session-start', ({ agent }) => {
      try {
        lastInjected.delete(sessionIdOf(agent));
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* 宿主没这个事件就跳过，⛔ 不影响主功能 */
  }

  // ── 核心：每一步之前决定要不要注入 ──
  try {
    ctx.on(
      'agent/pre-step',
      async ({ agent, step, signal }, next) => {
        // 宿主没给 next（旧版本）：无法安全接管这一步，直接放行 —— ⛔ 别抛 TypeError 打断会话
        if (typeof next !== 'function') return undefined;
        const decision = await next();     // ⛔ 别人的错不归我们兜，照常抛
        try {
          if (!decision || decision.kind === 'reject' || signal?.aborted) return decision;

          const injected = renderFor(agent, cfg);
          if (!injected) return decision;

          const sid = sessionIdOf(agent);
          const prev = lastInjected.get(sid);
          const unchanged = prev !== undefined && prev.digest === injected.digest;
          const refreshAfter = cfg.refreshAfterSteps;
          const stale =
            prev !== undefined &&
            (step < prev.step || (refreshAfter > 0 && step - prev.step >= refreshAfter));

          if (!cfg.injectAtEveryStep && unchanged && !stale) return decision;

          lastInjected.set(sid, { digest: injected.digest, step });
          trimTracked();

          return {
            kind: 'enter',
            messages: [
              ...(decision.messages || []),
              createUserMessage({
                content: [{ type: 'text', text: injected.text }],
                source: {
                  kind: 'plugin:' + name,
                  form: 'snapshot',
                  sections: [{ name, text: injected.text }],
                },
              }),
            ],
          };
        } catch {
          // ⛔ 注入失败绝不影响这一步 —— 规则是辅助，不能挡路
          return decision;
        }
      },
      { prepend: true },
    );
  } catch (e) {
    try {
      ctx.logger?.warn?.(`[${name}] pre-step 钩子挂载失败：${e?.message ?? e}`);
    } catch {
      /* ignore */
    }
  }

  // ── 命令：/bz ──
  try {
    ctx.effect(function* () {
      yield ctx.commands.register({
        name: 'bz',
        description: 'bz 规则注入器：查看/增删本会话规则、体检冲突、暂停注入',
        input: { hint: 'status | add <text> | clear | check | pause | resume' },
        handler: (invocation) => handle(ctx, invocation, { pausePath: pausePath() }),
      });
    }, 'bz-rules lifecycle');
  } catch (e) {
    try {
      ctx.logger?.warn?.(`[${name}] 命令注册失败：${e?.message ?? e}`);
    } catch {
      /* ignore */
    }
  }

  // ── 面板 HTTP 端点（给 Web 设置页用）──
  //   机制与 dsh-global-rules 同款：走 connection 的 fetch 注册表，
  //   自动落在宿主的 Host/Origin 围栏与浏览器鉴权之内。
  try {
    ctx.inject(['connection'], (host) => {
      try {
        host.connection.fetch.register({
          path: '/api/bz-rules',
          methods: ['GET', 'POST'],
          requestBody: 'buffered',
          fetch: (request) => handleApi(request),
        });
      } catch (e) {
        try {
          ctx.logger?.warn?.(`[${name}] 面板端点注册失败：${e?.message ?? e}`);
        } catch {
          /* ignore */
        }
      }
    });
  } catch {
    /* 宿主没有 connection 服务就跳过（CLI 模式会这样） */
  }
}

/* ════════════════════════════════════════════════════════════
 * 面板 API（host 侧）
 *   GET  /api/bz-rules              读三级规则 + 暂停状态
 *   POST /api/bz-rules  {action}    保存全局规则 / 暂停 / 恢复
 * ════════════════════════════════════════════════════════════ */
function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/** 把绝对路径显示成符号路径（⛔ 不外泄机器绝对路径） */
function displayPath(p) {
  try {
    const home = dshHome().replace(/\\/g, '/').replace(/\/+$/, '');
    const norm = String(p || '').replace(/\\/g, '/');
    // ⛔ 必须按路径分隔符判断：只 startsWith 会把 `~/.dsh2` 误认成 `~/.dsh` 内部
    if (norm === home) return '$DSH_HOME';
    if (norm.startsWith(home + '/')) return '$DSH_HOME' + norm.slice(home.length);
    return norm;
  } catch {
    return String(p || '').replace(/\\/g, '/');
  }
}

/**
 * 面板端点的来源校验（纵深防御）
 *
 * 宿主的 connection.fetch 注册表本应落在它自己的 Host/Origin 围栏内，
 * 但这层围栏是**宿主实现细节**，不是本插件的保证。而 `POST save-global`
 * 能往 global.md 写任意内容 —— 那是会注入到**所有会话**的持久化入口，
 * 不值得把安全性全部押在别人身上。
 *
 * 策略（宁可漏拦，⛔ 不可误伤）：
 *   · 没有 Origin 头 ⇒ 非浏览器 / 同源直连，放行
 *   · Origin 是本机或内网地址 ⇒ 放行（DSH Web 常跑在 localhost / 局域网）
 *   · Origin 的 host 与请求 Host 头一致 ⇒ 放行（同一台服务）
 *   · 其余（公网域名跨站发起的请求）⇒ 拒绝 403
 */
const LOOPBACK_OR_PRIVATE =
  /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i;

function originAllowed(request) {
  try {
    const origin = request?.headers?.get?.('origin');
    if (!origin) return true;
    const u = new URL(origin);
    if (LOOPBACK_OR_PRIVATE.test(u.hostname)) return true;
    const hostHeader = String(request?.headers?.get?.('host') || '').split(':')[0];
    return !!hostHeader && hostHeader.toLowerCase() === u.hostname.toLowerCase();
  } catch {
    return true; // 解析不了就放行，⛔ 别因为一个畸形头把面板锁死
  }
}

async function handleApi(request) {
  try {
    // ⛔ 先校验来源：save-global 是「写入即注入所有会话」的入口，不能裸奔
    if (!originAllowed(request)) {
      return jsonResponse(403, { error: '来源不被允许（跨站请求已拒绝）' });
    }

    if (request.method === 'GET') {
      const gp = globalRulesPath();
      let content = '';
      let exists = true;
      try {
        content = await readFile(gp, 'utf8');
      } catch (e) {
        exists = e?.code !== 'ENOENT';
        content = '';
      }
      return jsonResponse(200, {
        paused: isPaused(),
        exists,
        globalPath: displayPath(gp),
        rulesRoot: displayPath(rulesRoot()),
        globalContent: content,
      });
    }

    let body;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return jsonResponse(400, { error: 'body 必须是 JSON' });
    }

    const action = body?.action;

    if (action === 'save-global') {
      if (typeof body.content !== 'string') {
        return jsonResponse(400, { error: 'content 必须是字符串' });
      }
      if (Buffer.byteLength(body.content, 'utf8') > 256 * 1024) {
        return jsonResponse(413, { error: '内容过大（上限 256KB）' });
      }
      const gp = globalRulesPath();
      await mkdir(join(gp, '..'), { recursive: true });
      await writeFile(gp, body.content, 'utf8');
      return jsonResponse(200, { ok: true, globalPath: displayPath(gp) });
    }

    if (action === 'pause') {
      return jsonResponse(200, { ok: setPaused(true), paused: true });
    }
    if (action === 'resume') {
      return jsonResponse(200, { ok: setPaused(false), paused: false });
    }

    return jsonResponse(400, { error: '未知 action：' + String(action) });
  } catch (e) {
    return jsonResponse(500, { error: String(e?.message ?? e) });
  }
}

/** 供测试直接引用（⛔ 宿主不用） */
export const __internal = {
  sessionIdOf,
  cwdOf,
  renderFor,
  normalizeConfig,
  createUserMessage,
  displayPath,
  originAllowed,
  dshHome,
  homedir,
};