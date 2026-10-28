/**
 * `/bz` 命令处理 —— 零外部依赖
 *
 * ⭐ 指令集（本体要求）：
 *   status   查看当前生效的三级规则
 *   add <文本>  添加本会话临时规则（持久化到 sessions/<id>.json）
 *   clear    清空本会话临时规则
 *   check    扫三级规则，正则检测冲突（「必须」vs「禁止」）
 *   pause    暂停规则注入（熔断）
 *   resume   恢复注入
 *
 * ⛔ 每个分支都 try-catch：命令报错只返回一行提示，⛔ 不让主程序崩。
 */
import {
  collect, globalRulesPath, projectRulesPath,
} from './rules.js';
import { addSessionRule, clearSession, isPaused, setPaused } from './store.js';
// ⭐ 与注入侧共用同一份会话解析 —— ⛔ 别在这里再猜一遍字段名，
//    否则 /bz add 写进的 sessionId 和注入时读的可能是两个文件（规则加了不生效）。
import { sessionIdOf, cwdOf } from './session.js';

/** 冲突检测：同一条规则里同时出现「必须」和「禁止」类词，或语义相反 */
// ⛔ `must(?!\s+not)` —— 否则 "You must not skip tests" 这种**正常规则**
//    会同时命中「必须」和「禁止」两侧，被当成自相矛盾误报。
const MUST_WORDS = /必须|一定|务必|总是|都要|must(?!\s+not)/i;
const NEVER_WORDS = /⛔|禁止|不要|不许|绝不|永不|never|must\s+not|don'?t/i;

export function detectConflicts(rules) {
  const out = [];
  for (const r of rules) {
    const must = MUST_WORDS.test(r);
    const never = NEVER_WORDS.test(r);
    if (must && never) {
      out.push({ kind: '同条自相矛盾', text: r });
    }
  }
  return out;
}

/** 把结果包成宿主能显示的文本（宿主的 handler 返回字符串即可） */
function reply(lines) {
  return lines.filter(Boolean).join('\n');
}

export async function handle(ctx, invocation, runtime) {
  const raw = String(
    invocation?.input ?? invocation?.text ?? invocation?.args ?? '',
  ).trim();
  const [sub, ...rest] = raw.split(/\s+/);
  const arg = rest.join(' ').trim();

  // 会话 id / 工作目录：走 session.js 的唯一正本（与注入侧同源，⛔ 不在这里猜字段）
  const sessionId = sessionIdOf(invocation);

  try {
    switch ((sub || 'status').toLowerCase()) {
      case 'status': {
        const cwd = cwdOf(invocation);
        const rules = collect({ cwd, sessionId });
        const paused = isPaused();
        const lines = [
          `═══ bz 规则状态 ═══`,
          `注入：${paused ? '⛔ 已暂停（/bz resume 恢复）' : '✅ 生效中'}`,
          `会话：${sessionId}`,
          `工作目录：${cwd}`,
          '',
          `全局（${rules.global.length} 条）  ${globalRulesPath()}`,
          ...rules.global.map((t) => `  - ${t}`),
          '',
          `项目（${rules.project.length} 条）  ${projectRulesPath(cwd)}`,
          ...rules.project.map((t) => `  - ${t}`),
          '',
          `会话（${rules.session.length} 条）`,
          ...rules.session.map((t) => `  - ${t}`),
        ];
        return reply(lines);
      }

      case 'add': {
        if (!arg) return '⛔ 用法：/bz add <规则文本>';
        const n = addSessionRule(sessionId, arg);
        return `✅ 已加入本会话规则（现有 ${n} 条）。⚠️ 会话级规则只在本会话有效。`;
      }

      case 'clear': {
        clearSession(sessionId);
        return `✅ 已清空本会话的临时规则（全局/项目规则不受影响）。`;
      }

      case 'check': {
        const cwd = cwdOf(invocation);
        const rules = collect({ cwd, sessionId });
        const conflicts = detectConflicts(rules.all);
        const lines = [
          `═══ bz 规则体检 ═══`,
          `全局 ${rules.global.length} 条 ｜ 项目 ${rules.project.length} 条 ｜ 会话 ${rules.session.length} 条`,
          `合计 ${rules.all.length} 条`,
          '',
        ];
        if (rules.all.length === 0) {
          lines.push('ℹ️ 一条规则都没有 —— 不是「没问题」，是**还没写**。');
          lines.push(`   全局规则文件：${globalRulesPath()}`);
          lines.push(`   项目规则文件：${projectRulesPath(cwd)}`);
        } else if (conflicts.length === 0) {
          lines.push('✅ 没检出明显冲突（只查「同一条里同时有必须/禁止」这类）。');
        } else {
          lines.push(`🔴 检出 ${conflicts.length} 条可疑：`);
          for (const c of conflicts) lines.push(`  · [${c.kind}] ${c.text}`);
        }
        return reply(lines);
      }

      case 'pause': {
        const ok = setPaused(true);
        return ok
          ? `⛔ 已暂停规则注入（熔断）。恢复：/bz resume\n   暂停标记：${runtime?.pausePath || '(见 bz-rules/PAUSED)'}`
          : `🔴 暂停失败（写不了标记文件，检查 $DSH_HOME 权限）。`;
      }

      case 'resume': {
        const ok = setPaused(false);
        return ok ? `✅ 已恢复规则注入。` : `🔴 恢复失败（删不掉暂停标记）。`;
      }

      case 'help':
      default: {
        return reply([
          'bz 规则注入器 · 指令',
          '  /bz status   查看三级规则',
          '  /bz add <文本>  加一条本会话规则',
          '  /bz clear    清空本会话规则',
          '  /bz check    体检（找冲突）',
          '  /bz pause    暂停注入（熔断）',
          '  /bz resume   恢复注入',
          '',
          '三级作用域：全局 $DSH_HOME/bz-rules/global.md ｜ 项目 <cwd>/.dsh/bz-rules/project.md ｜ 会话（/bz add 写入）',
        ]);
      }
    }
  } catch (e) {
    return `🔴 bz 命令出错（已兜住，不影响主程序）：${e && e.message ? e.message : e}`;
  }
}
