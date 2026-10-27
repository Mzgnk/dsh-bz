/**
 * 规则读取与渲染 —— 纯函数，零外部依赖
 *
 * ⭐ 三级作用域：
 *   global   $DSH_HOME/bz-rules/global.md
 *   project  <cwd>/.dsh/bz-rules/project.md
 *   session  $DSH_HOME/bz-rules/sessions/<session_id>.json  （由 /bz add 写入）
 *
 * ⛔ 本模块只读文件、拼字符串，⛔ 不碰网络、不写文件（写由 store.js 负责）。
 * ⛔ 任何 IO 失败都返回空字符串，绝不让上层崩。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** $DSH_HOME：与宿主同款解析（非空环境变量优先，否则 ~/.dsh） */
export function dshHome() {
  const h = process.env.DSH_HOME;
  if (h && h.trim()) return h.trim();
  return path.join(os.homedir(), '.dsh');
}

/** 规则根目录 */
export function rulesRoot() {
  return path.join(dshHome(), 'bz-rules');
}

/** 全局规则文件 */
export function globalRulesPath() {
  return path.join(rulesRoot(), 'global.md');
}

/** 项目规则文件（相对会话工作目录） */
export function projectRulesPath(cwd) {
  return path.join(cwd || process.cwd(), '.dsh', 'bz-rules', 'project.md');
}

/** 单个会话的临时规则文件 */
export function sessionRulesPath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^\w.-]/g, '_');
  return path.join(rulesRoot(), 'sessions', safe + '.json');
}

/** 静默读文本；失败返回 '' */
export function readTextSafe(p) {
  try {
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 把规则正文切成条目。
 * · 以 `- ` / `* ` / `• ` 开头的行 = 一条
 * · 其余非空行 = 各自一条
 * · ⛔ 不解析 markdown 结构（规则就该是一行一条，简单可判）
 */
export function splitRules(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;          // 标题不算规则
    if (line.startsWith('<!--')) continue;       // 注释不算
    out.push(line.replace(/^[-*•]\s+/, ''));
  }
  return out;
}

/**
 * 转义 `</system-reminder>` —— ⛔ 防规则内容注入、提前闭合标签
 */
export function escapeReminder(text) {
  return String(text || '').replace(/<\/\s*system-reminder\s*>/gi, '<\\/system-reminder>');
}

/**
 * 收集三级规则。返回 { global, project, session, all }
 * ⛔ 任一层读失败只影响该层，不抛。
 */
export function collect({ cwd, sessionId } = {}) {
  const global = splitRules(readTextSafe(globalRulesPath()));
  const project = splitRules(readTextSafe(projectRulesPath(cwd)));
  let session = [];
  if (sessionId) {
    const raw = readTextSafe(sessionRulesPath(sessionId));
    if (raw) {
      try {
        const j = JSON.parse(raw);
        if (Array.isArray(j.rules)) session = j.rules.map(String).filter(Boolean);
      } catch {
        session = [];     // 坏 JSON ⇒ 当作没有，⛔ 不崩
      }
    }
  }
  return { global, project, session, all: [...global, ...project, ...session] };
}

/**
 * 渲染成注入正文。
 * · 按 maxBytes 逐条塞，超了就丢**最外层**（global 最先被丢，因为越具体越该保留）
 * · ⛔ 返回 null = 一条都没有，不该注入
 */
export function render(rules, maxBytes = 8192) {
  if (!rules || !rules.all || rules.all.length === 0) return null;

  // 越具体越优先保留：session > project > global
  const ordered = [
    ...rules.session.map((t) => ({ scope: 'session', text: t })),
    ...rules.project.map((t) => ({ scope: 'project', text: t })),
    ...rules.global.map((t) => ({ scope: 'global', text: t })),
  ];

  const head = [
    '<system-reminder>',
    '【bz 规则 · 本会话必须遵守】',
  ];
  const tail = ['</system-reminder>'];
  const overhead = Buffer.byteLength([...head, ...tail].join('\n'), 'utf8');

  const kept = [];
  let used = overhead;
  for (const r of ordered) {
    const line = `- [${r.scope}] ${r.text}`;
    const n = Buffer.byteLength(line + '\n', 'utf8');
    if (used + n > maxBytes) continue;   // ⛔ 超预算就跳过这条，不截断内容
    kept.push(line);
    used += n;
  }
  if (kept.length === 0) return null;

  // ⛔ 顺序很重要：**只转义规则正文**，⛔ 不能把自己刚加的闭合标签也转掉。
  //    2026-10-27 实测踩过：先拼后转 ⇒ 结尾成了 `<\/system-reminder>`，
  //    宿主认不出闭合标签 ⇒ 整段注入被当成普通文本（等于没生效）。
  const body = kept.map((l) => escapeReminder(l)).join('\n');
  return [...head, body, ...tail].join('\n');
}

/** 内容指纹（去重用） */
export function fingerprint(text) {
  try {
    return crypto.createHash('sha1').update(String(text || ''), 'utf8').digest('hex');
  } catch {
    return String(text || '').length + ':' + String(text || '').slice(0, 32);
  }
}
