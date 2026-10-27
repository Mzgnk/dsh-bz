/**
 * 会话规则的持久化 + 熔断开关 —— 零外部依赖
 *
 * ⭐ 为什么要持久化：`/bz add` 加的是**会话级**规则。
 *   如果只放内存，`/resume` 或崩溃重启就没了 —— 那等于没加。
 *   ⇒ 按 sessionId 落盘到 `$DSH_HOME/bz-rules/sessions/<id>.json`。
 *
 * ⛔ 所有写操作都 try-catch：写不进去只影响这一条规则，⛔ 绝不让主程序崩。
 */
import fs from 'node:fs';
import path from 'node:path';
import { rulesRoot, sessionRulesPath } from './rules.js';

function ensureDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {
    /* 建不了目录就算了，调用方会失败得很难看，但不崩 */
  }
}

/** 读会话规则数组 */
export function loadSession(sessionId) {
  const p = sessionRulesPath(sessionId);
  try {
    if (!fs.existsSync(p)) return [];
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(j.rules) ? j.rules.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 写会话规则数组（原子写：先写 tmp 再 rename） */
export function saveSession(sessionId, rules) {
  const p = sessionRulesPath(sessionId);
  ensureDir(path.dirname(p));
  const body = JSON.stringify(
    { sessionId: String(sessionId || 'unknown'), updatedAt: new Date().toISOString(), rules },
    null,
    2,
  );
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    return false;
  }
}

/** 追加一条会话规则；返回新的总数 */
export function addSessionRule(sessionId, text) {
  const t = String(text || '').trim();
  if (!t) return loadSession(sessionId).length;
  const cur = loadSession(sessionId);
  if (!cur.includes(t)) cur.push(t);
  saveSession(sessionId, cur);
  return cur.length;
}

/** 清空会话规则 */
export function clearSession(sessionId) {
  saveSession(sessionId, []);
  return 0;
}

/* ────────────────────────────────────────────────────────────
 * 熔断开关（防死循环）
 *   ⭐ 本体要求：工程脚本可调用 pause 强制暂停注入。
 *   ⇒ 实现成「一个标记文件」：存在 = 暂停。
 *     为什么用文件而不是内存：跨进程有效，脚本和 DSH 是两个进程。
 * ──────────────────────────────────────────────────────────── */

export function pausePath() {
  return path.join(rulesRoot(), 'PAUSED');
}

export function isPaused() {
  try {
    return fs.existsSync(pausePath());
  } catch {
    return false;
  }
}

export function setPaused(on) {
  const p = pausePath();
  try {
    if (on) {
      ensureDir(path.dirname(p));
      fs.writeFileSync(p, new Date().toISOString() + '\n', 'utf8');
    } else if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
    return true;
  } catch {
    return false;
  }
}
