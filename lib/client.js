// dsh-bz 前端：在设置面板里加一个「bz 规则」页。
// 手写 __ModuleLoader__ 工厂（⛔ 无构建步骤）。唯一的外部 require 是 react，
// 由宿主的 loader 模块表提供 —— 这与 dsh-global-rules 同款做法。
window.__ModuleLoader__.load({ id: "dsh-bz", factory: (require) => {
	var module = { exports: {} };
	var exports = module.exports;
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	let react = require("react");
	const h = react.createElement;
	const { useState, useEffect, useCallback } = react;

	const NS = "bz-rules";
	const inject = ["slots", "locale"];
	const API_PATH = "/api/bz-rules";

	const DICTS = {
		zh: {
			label: "bz 规则",
			desc: "三级规则注入器：全局 / 项目 / 会话。这里编辑的是**全局层**（跨项目生效）。",
			globalTitle: "全局规则（每行一条）",
			path: "路径：{path}",
			notExists: "文件尚不存在，保存将创建它。",
			loading: "加载中…",
			placeholder: "# bz 全局规则\n\n- 同一命令连续跑 3 次 → 停\n- 说「完成」必须附证据",
			save: "保存全局规则",
			saving: "保存中…",
			refresh: "重新读取",
			saved: "已保存。新会话立即生效。",
			saveError: "保存失败：{error}",
			readError: "读取失败：{error}",
			authFailed: "会话未通过鉴权，请刷新页面后重试",
			unknownError: "未知错误",
			statusTitle: "注入状态",
			statusOn: "✅ 生效中",
			statusOff: "⛔ 已暂停（熔断）",
			pause: "暂停注入",
			resume: "恢复注入",
			pausedOk: "已暂停规则注入。",
			resumedOk: "已恢复规则注入。",
			scopeTitle: "三级作用域",
			scopeGlobal: "全局：$DSH_HOME/bz-rules/global.md",
			scopeProject: "项目：<工作目录>/.dsh/bz-rules/project.md",
			scopeSession: "会话：/bz add <文本> 写入，随会话持久化",
		},
		en: {
			label: "bz Rules",
			desc: "Three-scope rule injector: global / project / session. This page edits the **global** layer.",
			globalTitle: "Global rules (one per line)",
			path: "Path: {path}",
			notExists: "File does not exist yet; saving will create it.",
			loading: "Loading…",
			placeholder: "# bz global rules\n\n- Stop after the same command runs 3 times\n- Report completion with evidence",
			save: "Save global rules",
			saving: "Saving…",
			refresh: "Reload",
			saved: "Saved. New sessions take effect immediately.",
			saveError: "Save failed: {error}",
			readError: "Read failed: {error}",
			authFailed: "Session authentication failed, please refresh the page and try again",
			unknownError: "Unknown error",
			statusTitle: "Injection status",
			statusOn: "✅ Active",
			statusOff: "⛔ Paused (loop-breaker)",
			pause: "Pause injection",
			resume: "Resume injection",
			pausedOk: "Rule injection paused.",
			resumedOk: "Rule injection resumed.",
			scopeTitle: "Three scopes",
			scopeGlobal: "global: $DSH_HOME/bz-rules/global.md",
			scopeProject: "project: <cwd>/.dsh/bz-rules/project.md",
			scopeSession: "session: /bz add <text>, persisted per session",
		},
	};

	function failureCode(res) {
		return res.status === 401 || res.status === 403 ? "authFailed" : "HTTP " + res.status;
	}

	const TEXTAREA_STYLE = {
		width: "100%",
		minHeight: "300px",
		boxSizing: "border-box",
		fontFamily: "ui-monospace, 'Cascadia Mono', Consolas, monospace",
		fontSize: "13px",
		lineHeight: 1.5,
		padding: "10px",
		background: "transparent",
		color: "inherit",
		border: "0.5px solid var(--dsw-alias-border-l4)",
		borderRadius: "var(--dsw-radius-md)",
		resize: "vertical",
	};

	const ROW_STYLE = { display: "flex", alignItems: "center", gap: "10px", marginTop: "10px", flexWrap: "wrap" };

	const BUTTON_CSS = [
		".dbz-btn { display:inline-flex; align-items:center; justify-content:center; height:36px;",
		"  padding:0 14px; border:none; border-radius:var(--dsw-radius-md); cursor:pointer;",
		"  font-size:14px; background:var(--dsw-alias-button-primary-fill);",
		"  color:var(--dsw-alias-label-primary-foreground); }",
		".dbz-btn:disabled { opacity:.5; cursor:default; }",
		".dbz-btn-ghost { background:transparent; color:inherit;",
		"  border:0.5px solid var(--dsw-alias-border-l4); }",
		".dbz-h { font-size:15px; font-weight:600; margin:18px 0 6px; }",
		".dbz-muted { font-size:13px; opacity:.75; }",
		".dbz-err { font-size:13px; color:var(--dsw-alias-state-error-primary); }",
		".dbz-ok { font-size:13px; color:var(--dsw-alias-state-success-primary); }",
	].join("\n");

	function BzRulesSection(props) {
		const t = props.t;
		const [content, setContent] = useState("");
		const [path, setPath] = useState("");
		const [exists, setExists] = useState(true);
		const [paused, setPaused] = useState(false);
		const [loading, setLoading] = useState(true);
		const [busy, setBusy] = useState(false);
		const [notice, setNotice] = useState(null);

		const load = useCallback(() => {
			setLoading(true);
			fetch(API_PATH, { cache: "no-store" })
				.then((res) => {
					if (!res.ok) throw { code: failureCode(res) };
					return res.json();
				})
				.then((data) => {
					setContent(data.globalContent || "");
					setPath(data.globalPath || "");
					setExists(data.exists !== false);
					setPaused(data.paused === true);
					setNotice(null);
				})
				.catch((err) => setNotice({ kind: "error", key: err && err.code ? err.code : "unknownError" }))
				.finally(() => setLoading(false));
		}, []);

		useEffect(() => { load(); }, [load]);

		const post = useCallback((payload, okKey) => {
			setBusy(true);
			fetch(API_PATH, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			})
				.then((res) => {
					if (!res.ok) throw { code: failureCode(res) };
					return res.json();
				})
				.then((data) => {
					if (data && typeof data.paused === "boolean") setPaused(data.paused);
					setNotice({ kind: "ok", key: okKey });
				})
				.catch((err) => setNotice({ kind: "error", key: err && err.code ? err.code : "unknownError" }))
				.finally(() => setBusy(false));
		}, []);

		const onSave = useCallback(() => {
			post({ action: "save-global", content }, "saved");
		}, [content, post]);

		const onToggle = useCallback(() => {
			if (paused) post({ action: "resume" }, "resumedOk");
			else post({ action: "pause" }, "pausedOk");
		}, [paused, post]);

		return h("div", null,
			h("style", null, BUTTON_CSS),
			h("div", { className: "dbz-muted" }, t("desc")),

			h("div", { className: "dbz-h" }, t("statusTitle")),
			h("div", { className: paused ? "dbz-err" : "dbz-ok" }, paused ? t("statusOff") : t("statusOn")),
			h("div", { style: ROW_STYLE },
				h("button", {
					className: "dbz-btn" + (paused ? "" : " dbz-btn-ghost"),
					onClick: onToggle,
					disabled: busy,
				}, paused ? t("resume") : t("pause")),
				h("span", { className: "dbz-muted" }, t("scopeSession")),
			),

			h("div", { className: "dbz-h" }, t("globalTitle")),
			path ? h("div", { className: "dbz-muted" }, t("path", { path })) : null,
			!exists ? h("div", { className: "dbz-muted" }, t("notExists")) : null,
			h("textarea", {
				style: { ...TEXTAREA_STYLE, marginTop: "8px" },
				value: content,
				disabled: loading || busy,
				placeholder: t("placeholder"),
				onChange: (e) => setContent(e.target.value),
				spellCheck: false,
			}),
			h("div", { style: ROW_STYLE },
				h("button", { className: "dbz-btn", onClick: onSave, disabled: loading || busy },
					busy ? t("saving") : t("save")),
				h("button", { className: "dbz-btn dbz-btn-ghost", onClick: load, disabled: loading || busy },
					t("refresh")),
				loading ? h("span", { className: "dbz-muted" }, t("loading")) : null,
			),
			notice
				? h("div", { className: notice.kind === "ok" ? "dbz-ok" : "dbz-err", style: { marginTop: "8px" } },
					t(notice.key))
				: null,

			h("div", { className: "dbz-h" }, t("scopeTitle")),
			h("div", { className: "dbz-muted" }, t("scopeGlobal")),
			h("div", { className: "dbz-muted" }, t("scopeProject")),
		);
	}

	function apply(ctx) {
		ctx.effect(() => ctx.locale.register(NS, DICTS), "bz-rules: dictionaries");
		const t = ctx.locale.bind(NS);
		ctx.slots.inject("settings.section", () => ctx.slots.register({
			name: "settings.section",
			id: "bz-rules",
			order: 31,
			locale: NS,
			label: () => t("label"),
		}, BzRulesSection));
	}

	exports.name = NS;
	exports.inject = inject;
	exports.apply = apply;
	exports.DICTS = DICTS;
	return module.exports;
}});