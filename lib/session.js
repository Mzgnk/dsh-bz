/**
 * 会话上下文解析 —— index.js（注入侧）与 command.js（命令侧）共用的唯一正本
 *
 * ⭐ 为什么单独抽出来（2026-10-28 审计修复）：
 *   原来两侧各写一套「猜宿主字段名」的代码：
 *     · index.js  读 agent.session.id / sessionId
 *     · command.js 读 invocation.sessionId / invocation.session?.id / ...
 *   两处路径完全不同，一旦猜到的 sessionId 不一致，`/bz add` 会写进
 *   `sessions/unknown.json`，而注入侧读的是 `sessions/<真实ID>.json`
 *   ⇒ **规则加了却永远不生效**，且多个会话共用同一个 unknown.json 串规则。
 *   同理 cwd：status 显示的项目规则文件可能不是实际注入的那一个。
 *
 *   ⇒ 单一解析函数，谁需要就 import，⛔ 不要再自己猜字段。
 *
 * ⛔ 本模块零依赖、无副作用、不读盘：只做字段探测。
 */

/** 宿主不同版本字段名不同，按优先级逐个试；都没有返回 'unknown' */
export function sessionIdOf(src) {
  try {
    if (!src || typeof src !== 'object') return 'unknown';
    const s = src.session;
    if (typeof s === 'string' && s) return s;
    const candidates = [
      s?.id,
      s?.sessionId,
      src.sessionId,
      src.agent?.session?.id,
      src.agent?.session?.sessionId,
      src.agent?.sessionId,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c) return c;
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 取工作目录：用于解析项目级规则。⚠️ 必须与注入侧同源，否则 status 会骗人 */
export function cwdOf(src) {
  try {
    if (!src || typeof src !== 'object') return process.cwd();
    const candidates = [
      src.workingDirectory,
      src.cwd,
      src.session?.workingDirectory,
      src.session?.cwd,
      src.agent?.workingDirectory,
      src.agent?.cwd,
      src.agent?.session?.workingDirectory,
    ];
    for (const c of candidates) {
      if (typeof c === 'string' && c) return c;
    }
    return process.cwd();
  } catch {
    return process.cwd();
  }
}
