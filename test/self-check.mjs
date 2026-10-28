/**
 * 本地自测 —— 不依赖宿主，直接验证规则逻辑
 *
 * 跑法：node test/self-check.mjs
 * ⛔ 不碰宿主的任何文件；只在临时目录里造规则。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 造隔离的 DSH_HOME，⛔ 别污染真实的 ~/.dsh
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bz-self-'));
process.env.DSH_HOME = tmp;

const { collect, render, fingerprint, splitRules, escapeReminder, globalRulesPath, projectRulesPath, sessionRulesPath } =
  await import('../lib/rules.js');
const { addSessionRule, clearSession, loadSession, isPaused, setPaused } = await import('../lib/store.js');
const { sessionIdOf, cwdOf } = await import('../lib/session.js');
const { detectConflicts } = await import('../lib/command.js');
const { __internal } = await import('../lib/index.js');

let pass = 0;
let fail = 0;
const failed = [];
function t(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log('  ✅ ' + name);
  } else {
    fail++;
    failed.push(name);
    console.log('  🔴 ' + name + (detail ? '\n       ' + detail : ''));
  }
}

console.log('\n【一】切条与转义');
t('标题不算规则', splitRules('# 标题\n- a\n- b').length === 2);
t('列表项去前缀', splitRules('- 必须写测试')[0] === '必须写测试');
t('⛔ 空行不算', splitRules('\n\n- x\n\n').length === 1);
t('转义 </system-reminder>', !escapeReminder('a</system-reminder>b').includes('</system-reminder>'));

console.log('\n【二】三级读取');
fs.mkdirSync(path.dirname(globalRulesPath()), { recursive: true });
fs.writeFileSync(globalRulesPath(), '- 全局规则甲\n- 全局规则乙\n', 'utf8');
const cwd = path.join(tmp, 'proj');
fs.mkdirSync(path.dirname(projectRulesPath(cwd)), { recursive: true });
fs.writeFileSync(projectRulesPath(cwd), '- 项目规则丙\n', 'utf8');
addSessionRule('sess-1', '会话规则丁');
const c = collect({ cwd, sessionId: 'sess-1' });
t('全局读到 2 条', c.global.length === 2, JSON.stringify(c.global));
t('项目读到 1 条', c.project.length === 1, JSON.stringify(c.project));
t('会话读到 1 条', c.session.length === 1, JSON.stringify(c.session));
t('合计 4 条', c.all.length === 4);

console.log('\n【三】渲染与预算');
const txt = render(c, 8192);
t('有正文', !!txt && txt.includes('全局规则甲'));
t('包了 system-reminder', txt.startsWith('<system-reminder>') && txt.trimEnd().endsWith('</system-reminder>'));
const tiny = render(c, 120);
t('预算紧时丢规则而不是截断', tiny === null || !tiny.includes('全局规则乙'), tiny ? '仍含乙' : '全丢');
t('无规则返回 null', render({ all: [], global: [], project: [], session: [] }, 8192) === null);

console.log('\n【四】去重指纹');
t('同文本同指纹', fingerprint('abc') === fingerprint('abc'));
t('异文本异指纹', fingerprint('abc') !== fingerprint('abd'));

console.log('\n【五】会话持久化（模拟 /resume）');
t('落盘后可读回', loadSession('sess-1').includes('会话规则丁'));
addSessionRule('sess-1', '会话规则戊');
t('追加生效', loadSession('sess-1').length === 2);
t('重复不加', (addSessionRule('sess-1', '会话规则丁'), loadSession('sess-1').length === 2));
clearSession('sess-1');
t('清空生效', loadSession('sess-1').length === 0);

console.log('\n【六】熔断');
t('默认没暂停', isPaused() === false);
setPaused(true);
t('暂停生效（标记文件存在）', isPaused() === true);
setPaused(false);
t('恢复生效', isPaused() === false);

console.log('\n【七】坏输入不崩');
fs.writeFileSync(sessionRulesPath('bad'), '{ 这不是 JSON', 'utf8');
t('坏 JSON 当没有，不抛', collect({ cwd, sessionId: 'bad' }).session.length === 0);
t('文件不存在返回空', collect({ cwd, sessionId: 'nope' }).session.length === 0);

console.log('\n【八】会话上下文解析（注入侧与命令侧必须同源）');
// 修复前：index.js 读 agent.session.id，command.js 读 invocation.sessionId，
// 两套逻辑各自猜 ⇒ /bz add 可能写进 unknown.json 而注入侧读不到（规则加了不生效）。
const fakeAgent = { session: { id: 'sess-9' }, workingDirectory: cwd };
const fakeInvocation = { sessionId: 'sess-9', cwd };
t('agent 形状可解析', sessionIdOf(fakeAgent) === 'sess-9');
t('invocation 形状可解析', sessionIdOf(fakeInvocation) === 'sess-9');
t('两侧解析结果一致（关键：不再分叉）', sessionIdOf(fakeAgent) === sessionIdOf(fakeInvocation));
t('cwd 两侧一致', cwdOf(fakeAgent) === cwdOf(fakeInvocation));
t('未知形状回落 unknown', sessionIdOf({}) === 'unknown');
t('空值不抛', sessionIdOf(null) === 'unknown' && cwdOf(undefined).length > 0);

console.log('\n【九】冲突检测不误报');
t('must not 不算自相矛盾', detectConflicts(['You must not skip tests']).length === 0);
t('中文正常规则不误报', detectConflicts(['必须先读文件']).length === 0);
t('真矛盾能检出', detectConflicts(['必须做完但禁止提交']).length === 1);

console.log('\n【十】项目规则来源标注（提示注入可识别）');
const withProject = render(collect({ cwd, sessionId: 'sess-1' }), 8192);
t('有项目规则时标注来源', !!withProject && withProject.includes('project.md'));
fs.rmSync(projectRulesPath(cwd), { force: true });
const noProject = render({ global: ['g'], project: [], session: [], all: ['g'] }, 8192);
t('无项目规则时不打标注', !!noProject && !noProject.includes('project.md'));

console.log('\n【十一】路径显示与来源校验');
t('$DSH_HOME 内正常缩略', __internal.displayPath(path.join(tmp, 'bz-rules', 'global.md')).startsWith('$DSH_HOME'));
t('同前缀不同目录不被误缩略', !__internal.displayPath(path.join(tmp + '2', 'x.md')).startsWith('$DSH_HOME'));
const mkReq = (h) => ({ headers: { get: (k) => h[k.toLowerCase()] ?? null } });
t('无 Origin 放行（非浏览器）', __internal.originAllowed(mkReq({})) === true);
t('localhost 放行', __internal.originAllowed(mkReq({ origin: 'http://localhost:3000' })) === true);
t('内网 IP 放行', __internal.originAllowed(mkReq({ origin: 'http://192.168.1.5:8080' })) === true);
t('公网跨站拒绝', __internal.originAllowed(mkReq({ origin: 'https://evil.example.com' })) === false);
t('Origin 与 Host 同源放行', __internal.originAllowed(mkReq({ origin: 'https://dsh.example.com', host: 'dsh.example.com' })) === true);

// 清理
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log('\n' + '='.repeat(60));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail) {
  console.log('失败：');
  for (const f of failed) console.log('  · ' + f);
}
console.log('='.repeat(60));
process.exit(fail ? 1 : 0);
