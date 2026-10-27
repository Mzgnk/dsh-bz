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

/** 取会话 id：宿主不同版本字段可能不同，逐个试，⛔ 不崩 */
function sessionIdOf(agent) {
  try {
    const s = agent?.session;
    if (typeof s === 'string') return s;
    return s?.id ?? s?.sessionId ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 取工作目录：用于解析项目级规则 */
function cwdOf(agent) {
  try {
    return (
      agent?.workingDirectory ??
      agent?.cwd ??
      agent?.session?.workingDirectory ??
      process.cwd()
    );
  } catch {
    return process.cwd();
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
    const home = dshHome();
    if (p.startsWith(home)) return '$DSH_HOME' + p.slice(home.length).replace(/\\/g, '/');
  } catch {
    /* ignore */
  }
  return p.replace(/\\/g, '/');
}

async function handleApi(request) {
  try {
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
  dshHome,
  homedir,
};