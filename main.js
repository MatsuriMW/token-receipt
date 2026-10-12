// Token 小票
//   把某一天 Claude Code、Codex 和 WorkBuddy 用掉的 token 排成一张购物小票（SVG），可以复制成图片、存成 WebP / PNG 或动画 SVG 放进库里
//   取数：直接读本机的会话记录，不联网
//     · Claude Code：~/.claude/projects 下的 *.jsonl，取每条 assistant 消息的 message.usage；
//                    同一条回复会写成好几行，按 message.id + requestId 去重
//     · Codex：~/.codex/sessions（和同级的 archived_sessions）下的 rollout-*.jsonl，取 token_count 事件里的累计值，逐条相减
//     · WorkBuddy：~/.workbuddy/projects 下的 *.jsonl，取每次请求的 providerData.rawUsage
//     · Magpie（可选）：~/.config/magpie 下的 usage.jsonl（经它网关转发的请求，已经直接读的三家跳过）、
//                    quota-history.json（各家额度的剩余百分比）、balance-history.json（账户余额），有就加上，没有就不加
//   金额：Claude 和 Codex 按 API 标价折算（订阅用户并非实付），价目表在设置里可改；WorkBuddy 只列 token
//   额度：Claude 的会话记录里有「额度用满」的提示和重置时间，Codex 的记录里有额度已用百分比，都印在各自那一栏
//   桌号 / 餐位：小票上印本机的局域网 IP 和系统版本（从系统直接读，不联网），设置里可以关
//   场景：同一张小票可以摆进不同的场景（打印机出纸、木桌、软木板、手账、账单夹板、纯净），按俯拍静物照的样子做，带入场动效
//   一天按本机时区的 0 点到 24 点算；界面和小票跟 Obsidian 的语言走（中文 / 英文），也可以在设置里指定
//   命令：打开 Token 小票 / 把今天的小票存成图片 / 把今天的小票插入到光标处（快捷键自己绑）
const { Plugin, ItemView, Notice, PluginSettingTab, Setting, normalizePath, setIcon, getLanguage, moment } = require("obsidian");
const fs = require("fs");
const path = require("path");
const os = require("os");
const readline = require("readline");

const VIEW_TYPE = "token-receipt";
const DAY = 24 * 3600 * 1000;

// 美元 / 百万 token。read 是缓存读；缓存写按输入价的 1.25 倍（5 分钟）和 2 倍（1 小时）算；fast 是快速模式的倍数
const DEFAULT_PRICES = {
	"claude-fable-5-1":  { in: 10,  out: 50,  read: 0.25 },
	"claude-fable-5":    { in: 10,  out: 50,  read: 1 },
	"claude-opus-5-5":   { in: 4,   out: 20,  read: 0.2, fast: 2 },
	"claude-opus-5":     { in: 5,   out: 25,  read: 0.5, fast: 2 },
	"claude-opus-4-8":   { in: 5,   out: 25,  read: 0.5 },
	"claude-opus-4-7":   { in: 5,   out: 25,  read: 0.5 },
	"claude-opus-4-6":   { in: 5,   out: 25,  read: 0.5 },
	"claude-sonnet-5-5": { in: 2,   out: 10,  read: 0.2 },
	"claude-sonnet-5":   { in: 2,   out: 10,  read: 0.2 },
	"claude-sonnet-4-6": { in: 3,   out: 15,  read: 0.3 },
	"claude-haiku-5-5":  { in: 0.1, out: 0.5, read: 0.01 },
	"claude-haiku-4-5":  { in: 1,   out: 5,   read: 0.1 },
	// OpenAI 的几个没有官方来源核对过，取自第三方价目汇总；没写 read 的按输入价的一成算
	"gpt-5.5":           { in: 5,    out: 30,  read: 0.5 },
	"gpt-5.4":           { in: 2.5,  out: 15,  read: 0.25 },
	"gpt-5.4-mini":      { in: 0.75, out: 4.5, read: 0.075 },
	"gpt-5.3-codex":     { in: 1.75, out: 14 },
};

const SCENE_ORDER = ["printer", "desk", "cork", "tape", "clip", "plain"];

const DEFAULT_SETTINGS = {
	claudeDir: "~/.claude/projects",
	codexDir: "~/.codex/sessions",
	workbuddyDir: "~/.workbuddy/projects",
	magpieDir: "~/.config/magpie",
	title: "",
	language: "auto",
	scene: "printer",
	showHost: true,
	exportFolder: "",
	exportScale: 2,
	exportFormat: "webp",
	prices: DEFAULT_PRICES,
};

const I18N = {
	zh: {
		name: "Token 小票",
		title: "TOKEN 小票",
		subtitle: "AI 用量结算单",
		week: ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"],
		no: "单号", printed: "出票", item: "品名", tokens: "TOKEN", amount: "金额 USD",
		sessions: (s, r) => `${s} 个会话 · ${r} 次请求`,
		times: (n) => `× ${n} 次`,
		input: "输入", output: "输出", read: "缓存读", write5: "缓存写 5m", write1h: "缓存写 1h", hit: "缓存命中",
		subtotal: "小计", unpricedTag: "不计价", none: "今日无消费",
		limits: { five_hour: "5 小时额度用满", seven_day: "周额度用满", other: "额度用满" },
		resets: "重置",
		total: "合计 TOKEN", apiAt: "API 折算", table: "桌号", seat: "餐位",
		window: (min, name) => (min === 300 ? "5 小时额度" : min === 10080 ? "周额度" : min === 43200 ? "月额度" : min ? `${Math.round(min / 1440)} 天额度` : `${name || "额度"} `) + "已用",
		balance: "余额", left: "还剩",
		sMagpie: ["Magpie 目录", "Magpie 的配置目录。有的话，小票会加上它记的额度百分比、账户余额变化和经它网关转发的请求；目录不存在就什么都不加。"],
		scenes: { printer: "打印机出纸", desk: "木桌", cork: "软木板", tape: "手账胶带", clip: "账单夹板", plain: "纯净" },
		saveSvg: "存成动画 SVG 放进库里", replay: "重放入场动效",
		note: "金额按 API 标价折算，订阅用户并非实付",
		noteUnpriced: "标「—」的模型不在价目表里，没有计入金额",
		thanks: "谢谢惠顾 · THANK YOU",
		prev: "前一天", next: "后一天", today: "回到今天", refresh: "重新统计", copy: "复制成图片", save: "存成图片放进库里",
		counting: "正在统计…", failed: "统计失败：", copied: "小票已复制成图片", copyFailed: "复制失败：", saved: "小票已存到 ", saveFailed: "导出失败：",
		renderFailed: "小票图片渲染失败", fileName: "Token小票",
		cmdOpen: "打开 Token 小票", cmdExport: "把今天的小票存成图片", cmdInsert: "把今天的小票插入到光标处",
		sTitle: ["小票抬头", "印在小票最上面的那行大字，留空用默认的。"],
		sLang: ["小票语言", "界面和小票用哪种语言。命令名称重启后生效。"], langAuto: "跟随 Obsidian",
		sScene: ["呈现方式", "小票摆在什么场景里。存下来的图和侧边栏里看到的一样；入场动效只在侧边栏和动画 SVG 里有。"],
		sHost: ["印上桌号和餐位", "在单号下面印一行本机的局域网 IP（桌号）和系统版本（餐位）。从系统直接读，不联网。要把小票发给别人、又不想带这两样时关掉。"],
		sCodex: ["Codex 会话目录", "Codex 存会话记录的地方。同级的 archived_sessions 也会一起统计。"],
		sClaude: ["Claude Code 会话目录", "Claude Code 存会话记录的地方，~ 代表用户目录。"],
		sWb: ["WorkBuddy 会话目录", "WorkBuddy 存会话记录的地方。"],
		sFormat: ["图片格式", "WebP 文件小，带纹理的场景用它；PNG 无损，但一张要好几 MB。复制到剪贴板的始终是 PNG。"],
		sFolder: ["图片存到哪个文件夹", "留空就跟「文件与链接」里的附件位置走。"], folderHint: "例如 assets/小票",
		sScale: ["图片清晰度", "导出图片相对小票原始尺寸的倍数，2 倍够贴进笔记。"], scale: (n) => `${n} 倍`,
		sPrices: ["价目表", "美元 / 百万 token。in 输入、out 输出、read 缓存读（不写就按输入价的一成）；Claude 的缓存写按输入价的 1.25 倍（5 分钟）和 2 倍（1 小时）算；fast 是快速模式的倍数。模型名要和记录里的一致，带日期后缀的也认；不在表里的模型只列 token。"],
		reset: "恢复默认",
	},
	en: {
		name: "Token Receipt",
		title: "TOKEN RECEIPT",
		subtitle: "AI USAGE STATEMENT",
		week: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
		no: "No.", printed: "Printed", item: "ITEM", tokens: "TOKENS", amount: "AMOUNT USD",
		sessions: (s, r) => `${s} sessions · ${r} requests`,
		times: (n) => `× ${n}`,
		input: "Input", output: "Output", read: "Cache read", write5: "Cache write 5m", write1h: "Cache write 1h", hit: "Cache hit",
		subtotal: "Subtotal", unpricedTag: "not priced", none: "No usage",
		limits: { five_hour: "5-hour limit hit", seven_day: "Weekly limit hit", other: "Usage limit hit" },
		resets: "resets",
		total: "TOTAL TOKENS", apiAt: "At API rates", table: "Table", seat: "Seat",
		window: (min, name) => (min === 300 ? "5-hour limit" : min === 10080 ? "Weekly limit" : min === 43200 ? "Monthly limit" : min ? `${Math.round(min / 1440)}-day limit` : name || "Limit") + " used",
		balance: "balance", left: "left",
		sMagpie: ["Magpie folder", "Magpie's config folder. When it exists, the receipt adds the limit percentages, balance changes and gateway requests Magpie has recorded. Nothing is added when the folder is missing."],
		scenes: { printer: "Thermal printer", desk: "Wooden desk", cork: "Cork board", tape: "Notebook and tape", clip: "Clipboard", plain: "Plain" },
		saveSvg: "Save as animated SVG in the vault", replay: "Replay the entrance",
		note: "Amounts are API list prices, not what a plan costs",
		noteUnpriced: "Models marked — are not in the price table",
		thanks: "THANK YOU · COME AGAIN",
		prev: "Previous day", next: "Next day", today: "Back to today", refresh: "Recount", copy: "Copy as image", save: "Save as an image in the vault",
		counting: "Counting…", failed: "Could not count: ", copied: "Receipt copied as an image", copyFailed: "Could not copy: ", saved: "Receipt saved to ", saveFailed: "Could not save: ",
		renderFailed: "Could not render the receipt image", fileName: "Token receipt",
		cmdOpen: "Open receipt", cmdExport: "Save today's receipt as an image", cmdInsert: "Insert today's receipt at the cursor",
		sTitle: ["Receipt title", "The big line at the top of the receipt. Leave empty for the default."],
		sLang: ["Receipt language", "Language of the interface and the receipt. Command names change after a restart."], langAuto: "Same as Obsidian",
		sScene: ["Scene", "Where the receipt is shown. Saved images look like the sidebar; the entrance animation plays in the sidebar and in animated SVG files."],
		sHost: ["Print table and seat", "Adds a line under the receipt number with this computer's local network address (the table) and system version (the seat). Both are read from the system; nothing goes over the network. Turn it off if you share receipts and would rather leave them out."],
		sCodex: ["Codex session folder", "Where Codex keeps its session logs. The archived_sessions folder next to it is counted too."],
		sClaude: ["Claude Code session folder", "Where Claude Code keeps its session logs. ~ is your home folder."],
		sWb: ["WorkBuddy session folder", "Where WorkBuddy keeps its session logs."],
		sFormat: ["Image format", "WebP keeps textured scenes small. PNG is lossless but runs to several MB. Copying to the clipboard always uses PNG."],
		sFolder: ["Folder for saved images", "Leave empty to use the attachment location from Files and links."], folderHint: "e.g. assets/receipts",
		sScale: ["Image resolution", "Size of the saved image relative to the receipt. 2× is enough for notes."], scale: (n) => `${n}×`,
		sPrices: ["Price table", "USD per million tokens. in = input, out = output, read = cache read (a tenth of input when left out). Claude cache writes cost 1.25× input (5 minutes) or 2× input (1 hour). fast is the fast mode multiplier. Model names must match the logs, with or without a date suffix; models not listed show tokens only."],
		reset: "Restore defaults",
	},
};

function langOf(setting) {
	if (setting === "zh" || setting === "en") return setting;
	let l = "";
	if (typeof getLanguage === "function") l = getLanguage();
	else if (moment) l = moment.locale();
	return String(l || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
}

// ---------- 取数 ----------

const expand = (p) => (p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p);

async function walk(dir, out = [], depth = 0) {
	let entries;
	try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { return out; }
	for (const e of entries) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (depth < 5) await walk(p, out, depth + 1);
		} else if (e.name.endsWith(".jsonl")) {
			try {
				const s = await fs.promises.stat(p);
				out.push({ file: p, mtimeMs: s.mtimeMs, size: s.size });
			} catch (err) { /* 刚被删掉的文件 */ }
		}
	}
	return out;
}

function eachLine(file, onLine) {
	return new Promise((resolve) => {
		const input = fs.createReadStream(file, { encoding: "utf8" });
		input.on("error", resolve);
		const rl = readline.createInterface({ input, crlfDelay: Infinity });
		rl.on("line", onLine);
		rl.on("close", resolve);
	});
}

function parseClaudeLine(line) {
	if (!line.includes('"usage"') && !line.includes("rate_limit")) return null;
	let d;
	try { d = JSON.parse(line); } catch (e) { return null; }
	const m = d.message;
	if (!m || d.type !== "assistant") return null;
	const t = Date.parse(d.timestamp);
	if (!t) return null;
	// 额度用满时 Claude Code 写一条 <synthetic> 消息：「You've hit your session limit · resets 2:20am」，新版本还带 quotaLimits
	if (m.model === "<synthetic>") {
		if (d.error !== "rate_limit") return null;
		const q = d.quotaLimits || {};
		const txt = Array.isArray(m.content) && m.content[0] ? String(m.content[0].text || "") : "";
		const type = q.rateLimitType || (/weekly/i.test(txt) ? "seven_day" : /session limit/i.test(txt) ? "five_hour" : "");
		if (!type) return null;
		const rm = txt.match(/resets\s+([^(·]+)/i);
		return { t, limit: type, resetsAt: q.resetsAt ? q.resetsAt * 1000 : 0, resetText: rm ? rm[1].trim() : "", key: `limit|${type}|${q.resetsAt || txt}` };
	}
	const u = m.usage;
	if (!u || !m.model) return null;
	const cc = u.cache_creation || {};
	const w1h = cc.ephemeral_1h_input_tokens || 0;
	const w5 = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, (u.cache_creation_input_tokens || 0) - w1h);
	return {
		t,
		key: m.id && d.requestId ? m.id + "|" + d.requestId : d.uuid || null,
		sid: d.sessionId,
		model: m.model,
		fast: u.speed === "fast",
		in: u.input_tokens || 0,
		out: u.output_tokens || 0,
		read: u.cache_read_input_tokens || 0,
		w5,
		w1h,
	};
}

function parseWorkBuddyLine(line) {
	if (!line.includes('"providerData"')) return null;
	let d;
	try { d = JSON.parse(line); } catch (e) { return null; }
	const p = d.providerData;
	if (!p || (!p.rawUsage && !p.usage)) return null;
	const t = typeof d.timestamp === "number" ? d.timestamp : Date.parse(d.timestamp);
	if (!t) return null;
	const r = p.rawUsage || {};
	const u = p.usage || {};
	const input = r.prompt_tokens != null ? r.prompt_tokens : u.inputTokens || 0;
	const hit = Math.max(
		r.prompt_cache_hit_tokens || 0,
		(r.prompt_tokens_details || {}).cached_tokens || 0,
		r.cache_read_input_tokens || 0,
		((u.inputTokensDetails || [])[0] || {}).cached_tokens || 0,
	);
	return {
		t,
		key: p.messageId || d.id || null,
		sid: d.sessionId,
		model: p.model || p.requestModelId || "unknown",
		name: p.requestModelName || "",
		in: Math.max(0, input - hit),
		hit: Math.min(hit, input),
		out: r.completion_tokens != null ? r.completion_tokens : u.outputTokens || 0,
	};
}

// Codex 的 token_count 记的是整个会话的累计值，同一个值会重复写好几次：逐条和上一条相减，没变就不算
// 每条还带当时的额度占用（rate_limits：已用百分比、窗口长度、几点重置）
function codexParser() {
	let prev = null, model = "unknown", sid = "";
	return (line) => {
		if (!line.includes('"token_count"') && !line.includes('"turn_context"') && !line.includes('"session_meta"')) return null;
		let d;
		try { d = JSON.parse(line); } catch (e) { return null; }
		const p = d.payload || {};
		if (d.type === "session_meta") { sid = p.id || p.session_id || sid; return null; }
		if (d.type === "turn_context") { if (p.model) model = p.model; return null; }
		if (d.type !== "event_msg" || p.type !== "token_count") return null;
		const t = Date.parse(d.timestamp);
		if (!t) return null;
		const row = { t, sid, model, key: null, in: 0, read: 0, out: 0, quota: [] };
		const rl = p.rate_limits || {};
		for (const k of ["primary", "secondary"]) {
			const q = rl[k];
			if (q && q.used_percent != null) row.quota.push({ minutes: q.window_minutes || 0, used: q.used_percent, resetsAt: (q.resets_at || 0) * 1000 });
		}
		const tot = p.info && p.info.total_token_usage;
		if (tot && (!prev || tot.total_tokens !== prev.total_tokens)) {
			const last = p.info.last_token_usage;
			let u = last || tot;
			if (prev) {
				u = {
					input_tokens: tot.input_tokens - prev.input_tokens,
					cached_input_tokens: (tot.cached_input_tokens || 0) - (prev.cached_input_tokens || 0),
					output_tokens: tot.output_tokens - prev.output_tokens,
				};
				if (u.input_tokens < 0 || u.output_tokens < 0) u = last || tot;
			}
			prev = tot;
			const cached = Math.min(u.cached_input_tokens || 0, u.input_tokens || 0);
			row.in = (u.input_tokens || 0) - cached;
			row.read = cached;
			row.out = u.output_tokens || 0;
			row.key = sid ? `codex|${sid}|${tot.total_tokens}` : null;
			row.used = true;
		}
		return row.used || row.quota.length ? row : null;
	};
}

// Magpie 网关转发的请求。Claude Code、Codex、WorkBuddy 自己的记录已经直接读了，这三家走网关的请求跳过，免得算两遍
const MAGPIE_DIRECT = new Set(["claude", "claude-code", "codex", "workbuddy", "codebuddy"]);

function parseMagpieLine(line) {
	let d;
	try { d = JSON.parse(line); } catch (e) { return null; }
	if (!d || !d.t || MAGPIE_DIRECT.has(d.agent) || d.status >= 400) return null;
	const t = Date.parse(d.t);
	if (!t) return null;
	return {
		t,
		key: d.route_id ? "magpie|" + d.route_id : null,
		sid: d.session || d.agent || "",
		model: d.served || d.model || "unknown",
		in: d.in || 0,
		read: d.cache_read || 0,
		out: d.out || 0,
	};
}

async function readJson(file) {
	try { return JSON.parse(await fs.promises.readFile(file, "utf8")); } catch (e) { return null; }
}

// Magpie 隔一阵记一次各家额度还剩百分之几、账户余额还有多少。取这一天里的采样：
//   额度：同一个窗口（重置时间相同，差几分钟也算同一个）只留最后一次采样
//   余额：把这一天里每次减少的量加起来，充值不算
async function magpieExtras(dir, date) {
	const start = date.getTime(), end = start + DAY;
	const out = { quota: {}, balances: [] };
	if (!dir) return out;
	const [hist, bal, now] = await Promise.all(["quota-history.json", "balance-history.json", "quotas.json"].map((f) => readJson(path.join(dir, f))));
	const names = {}, symbols = {};
	for (const [k, v] of Object.entries(now || {})) {
		const p = k.split("/")[0], q = (v && v.quota) || {};
		if (q.name) names[p] = q.name;
		const m = typeof q.balance === "string" && q.balance.match(/^[^\d-]+/);
		if (m) symbols[p] = m[0].trim();
	}
	for (const [k, wins] of Object.entries(hist || {})) {
		const p = k.split("|")[0];
		for (const [name, samples] of Object.entries(wins || {})) {
			const inst = new Map();
			let first = null, last = null;
			for (const s of samples || []) {
				const at = Date.parse(s.at);
				if (!(at >= start && at < end) || typeof s.left !== "number") continue;
				if (first == null) first = s.left;
				last = s.left;
				const r = s.resetsAt ? Date.parse(s.resetsAt) : 0;
				inst.set(r ? Math.round(r / 600000) : 0, { at, used: 100 - s.left, resetsAt: r });
			}
			// 没有重置时间的采样是「这个窗口还没开始」，有别的窗口时不用它
			if (inst.size > 1) inst.delete(0);
			if (!inst.size) continue;
			const m = name.match(/^(\d+)\s*(hour|day)/i);
			(out.quota[p] = out.quota[p] || []).push({
				minutes: m ? Number(m[1]) * (m[2].toLowerCase() === "hour" ? 60 : 1440) : 0,
				name,
				provider: names[p] || p,
				list: [...inst.values()].sort((a, b) => a.at - b.at),
				changed: first !== last,
				magpie: true,
			});
		}
	}
	for (const [k, samples] of Object.entries(bal || {})) {
		const p = k.split("|")[0];
		let prev = null, spent = 0, left = null;
		for (const s of samples || []) {
			const at = Date.parse(s.at);
			if (!(at < end) || typeof s.amount !== "number") continue;
			if (at >= start) {
				if (prev != null && s.amount < prev) spent += prev - s.amount;
				left = s.amount;
			}
			prev = s.amount;
		}
		if (spent > 0.004) out.balances.push({ name: names[p] || p, symbol: symbols[p] || "", spent, left });
	}
	return out;
}

// 按文件的修改时间和大小缓存解析结果；某一天的账只可能在「那天 0 点之后还改过」的文件里
class Ledger {
	constructor() {
		this.cache = new Map();
	}

	async rows(dirs, makeParser, since) {
		const all = [];
		for (const dir of dirs) await walk(expand(dir), all);
		const out = [];
		for (const f of all) {
			if (f.mtimeMs >= since) out.push(await this.parse(f, makeParser));
		}
		return out;
	}

	async parse(f, makeParser) {
		let c = this.cache.get(f.file);
		if (!c || c.mtimeMs !== f.mtimeMs || c.size !== f.size) {
			const rows = [];
			const parse = makeParser();
			await eachLine(f.file, (line) => {
				const r = parse(line);
				if (r) rows.push(r);
			});
			c = { mtimeMs: f.mtimeMs, size: f.size, rows };
			this.cache.set(f.file, c);
		}
		return c.rows;
	}

	// 单独一个文件（Magpie 的 usage.jsonl），不存在就当没有
	async file(file, makeParser) {
		try {
			const st = await fs.promises.stat(file);
			return [await this.parse({ file, mtimeMs: st.mtimeMs, size: st.size }, makeParser)];
		} catch (e) {
			return [];
		}
	}

	async day(date, settings) {
		const start = date.getTime();
		// Codex 归档的会话挪到同级的 archived_sessions 里
		const codexDirs = [settings.codexDir];
		const cd = expand(settings.codexDir).replace(/\/+$/, "");
		if (path.basename(cd) === "sessions") codexDirs.push(path.join(path.dirname(cd), "archived_sessions"));
		const mdir = settings.magpieDir ? expand(settings.magpieDir) : "";
		const [claude, codex, wb, magpie, extras] = await Promise.all([
			this.rows([settings.claudeDir], () => parseClaudeLine, start),
			this.rows(codexDirs, codexParser, start),
			this.rows([settings.workbuddyDir], () => parseWorkBuddyLine, start),
			mdir ? this.file(path.join(mdir, "usage.jsonl"), () => parseMagpieLine) : [],
			magpieExtras(mdir, date),
		]);
		return summarize(date, { claude, codex, wb, magpie }, settings.prices, extras);
	}
}

// 价目表里的名字要完全一致，或者只多一段日期后缀（claude-haiku-4-5-20251001、gpt-5.4-2026-03-05）
function priceOf(model, prices) {
	if (prices[model]) return prices[model];
	const base = model.replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "");
	return prices[base] || null;
}

function modelLabel(id) {
	if (!id.startsWith("claude-")) return id;
	const parts = id.slice(7).replace(/-\d{8}$/, "").split("-");
	const names = parts.filter((x) => /[a-z]/i.test(x)).map((x) => x[0].toUpperCase() + x.slice(1));
	const nums = parts.filter((x) => /^\d+$/.test(x));
	return names.join(" ") + (nums.length ? " " + nums.join(".") : "");
}

// 同一个 key 只留一行；还在写的回复，前几行的 output 可能偏小，取最大的
function pick(fileRows, start) {
	const end = start + DAY;
	const seen = new Map();
	const out = [];
	for (const rows of fileRows) {
		for (const r of rows) {
			if (r.t < start || r.t >= end) continue;
			if (r.key && seen.has(r.key)) {
				const old = seen.get(r.key);
				if (r.out > old.out) old.out = r.out;
				continue;
			}
			const copy = Object.assign({}, r);
			if (r.key) seen.set(r.key, copy);
			out.push(copy);
		}
	}
	return out;
}

// 每个来源一栏：models 里每个模型有几行明细（lines），priced 的来源才有金额
const LINE_ORDER = {
	claude: ["input", "output", "read", "write5", "write1h"],
	codex: ["input", "read", "output"],
	wb: ["input", "hit", "output"],
	magpie: ["input", "read", "output"],
};

function newSection(id, name, priced) {
	return { id, name, priced, models: new Map(), sids: new Set(), limits: [], quota: [], extras: [], sessions: 0, requests: 0, tokens: 0, cost: 0, unpriced: false };
}

// parts：[明细的名字, token 数, 每个 token 多少美元]
function addRow(sec, r, label, priced, parts) {
	let m = sec.models.get(r.model);
	if (!m) {
		m = { id: r.model, label, priced, reqs: 0, tokens: 0, cost: 0, lines: new Map() };
		sec.models.set(r.model, m);
	}
	m.reqs++;
	for (const [key, tokens, rate] of parts) {
		if (!tokens) continue;
		let l = m.lines.get(key);
		if (!l) { l = { key, tokens: 0, cost: 0 }; m.lines.set(key, l); }
		l.tokens += tokens;
		l.cost += tokens * rate;
		m.tokens += tokens;
		m.cost += tokens * rate;
	}
	if (r.sid) sec.sids.add(r.sid);
}

function finish(sec) {
	const models = [...sec.models.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
	for (const m of models) {
		m.lines = LINE_ORDER[sec.id].map((k) => m.lines.get(k)).filter(Boolean);
		sec.requests += m.reqs;
		sec.tokens += m.tokens;
		sec.cost += m.cost;
		if (sec.priced && !m.priced) sec.unpriced = true;
	}
	sec.models = models;
	sec.sessions = sec.sids.size;
	delete sec.sids;
	sec.shown = models.length > 0 || sec.limits.length > 0 || sec.quota.length > 0 || sec.extras.length > 0;
	return sec;
}

function summarize(date, files, prices, magpie) {
	const start = date.getTime();
	const M = 1e6;

	const claude = newSection("claude", "CLAUDE CODE", true);
	const lm = new Map();
	for (const r of pick(files.claude || [], start)) {
		if (r.limit) {
			const type = r.limit === "five_hour" || r.limit === "seven_day" ? r.limit : "other";
			if (!lm.has(type)) lm.set(type, { type, hits: [] });
			lm.get(type).hits.push(r);
			continue;
		}
		const p = priceOf(r.model, prices);
		const k = p ? (r.fast ? p.fast || 1 : 1) / M : 0;
		const rate = (v) => (p ? v * k : 0);
		addRow(claude, r, modelLabel(r.model), !!p, [
			["input", r.in, rate(p && p.in)],
			["output", r.out, rate(p && p.out)],
			["read", r.read, rate(p && (p.read != null ? p.read : p.in * 0.1))],
			["write5", r.w5, rate(p && p.in * 1.25)],
			["write1h", r.w1h, rate(p && p.in * 2)],
		]);
	}
	claude.limits = ["five_hour", "seven_day", "other"].filter((k) => lm.has(k)).map((k) => {
		const l = lm.get(k);
		l.hits.sort((a, b) => a.t - b.t);
		return l;
	});

	const codex = newSection("codex", "CODEX", true);
	let latest = null;
	for (const r of pick(files.codex || [], start)) {
		if (r.quota.length && (!latest || r.t > latest.t)) latest = r;
		if (!r.used) continue;
		const p = priceOf(r.model, prices);
		const rate = (v) => (p ? v / M : 0);
		addRow(codex, r, r.model, !!p, [
			["input", r.in, rate(p && p.in)],
			["read", r.read, rate(p && (p.read != null ? p.read : p.in * 0.1))],
			["output", r.out, rate(p && p.out)],
		]);
	}
	if (latest) codex.quota = latest.quota.map((q) => ({ minutes: q.minutes, list: [{ used: q.used, resetsAt: q.resetsAt }] }));

	const wb = newSection("wb", "WORKBUDDY", false);
	for (const r of pick(files.wb || [], start)) {
		addRow(wb, r, r.name || r.model, false, [["input", r.in, 0], ["hit", r.hit, 0], ["output", r.out, 0]]);
	}

	const mg = newSection("magpie", "MAGPIE", true);
	for (const r of pick(files.magpie || [], start)) {
		const p = priceOf(r.model, prices);
		const rate = (v) => (p ? v / M : 0);
		addRow(mg, r, r.model, !!p, [
			["input", r.in, rate(p && p.in)],
			["read", r.read, rate(p && (p.read != null ? p.read : p.in * 0.1))],
			["output", r.out, rate(p && p.out)],
		]);
	}
	// Magpie 记的额度：有自己那一栏的（当天用过、记录里又没带百分比）印在那一栏；别家的只在当天有变化时印在 Magpie 这一栏
	const own = { claude, codex, workbuddy: wb, "workbuddy-ai": wb };
	for (const [p, list] of Object.entries((magpie && magpie.quota) || {})) {
		const sec = own[p];
		if (sec) {
			// 积分这类不按时间重置的额度，当天没变化就不印
			if (sec.models.size && !sec.quota.length) sec.quota = list.filter((q) => q.minutes || q.changed);
		} else {
			for (const q of list) if (q.changed) mg.quota.push(Object.assign({ label: q.provider }, q));
		}
	}
	mg.extras = (magpie && magpie.balances) || [];

	const sections = [finish(claude), finish(codex), finish(wb), finish(mg)];
	const sum = { date, sections, tokens: 0, cost: 0, requests: 0, unpriced: false };
	for (const s of sections) {
		sum.tokens += s.tokens;
		sum.requests += s.requests;
		if (s.priced) sum.cost += s.cost;
		if (s.unpriced) sum.unpriced = true;
	}
	return sum;
}

// 桌号和餐位：本机的局域网 IPv4（优先 en0，没连网就是 127.0.0.1）和系统版本，都是从系统直接读的
function hostInfo() {
	let ip = "127.0.0.1";
	const nets = os.networkInterfaces();
	const names = Object.keys(nets).sort((a, b) => (a === "en0" ? -1 : b === "en0" ? 1 : 0));
	for (const n of names) {
		const hit = (nets[n] || []).find((x) => (x.family === "IPv4" || x.family === 4) && !x.internal);
		if (hit) { ip = hit.address; break; }
	}
	const name = { darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform] || process.platform;
	const version = typeof process.getSystemVersion === "function" ? process.getSystemVersion() : os.release();
	return { ip, system: `${name} ${version}` };
}

// ---------- 小票 ----------

const pad2 = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const num = (n) => Math.round(n).toLocaleString("en-US");
const usd = (n) => "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 额度几点重置：当天和次日只写时分，更远的带上日期
function resetLabel(hit, date) {
	if (!hit.resetsAt) return hit.resetText;
	const r = new Date(hit.resetsAt);
	const hm = `${pad2(r.getHours())}:${pad2(r.getMinutes())}`;
	return dayStart(r).getTime() - date.getTime() > DAY ? `${pad2(r.getMonth() + 1)}-${pad2(r.getDate())} ${hm}` : hm;
}

const INK = "#1f2026", DIM = "#85817a", PAPER = "#fcfbf7";
const FONT = "Menlo, Consolas, 'DejaVu Sans Mono', 'PingFang SC', 'Microsoft YaHei', monospace";
const UI_FONT = "'Helvetica Neue', Arial, sans-serif";
let uid = 0;

// 小票正文。坐标以纸的左上角为原点，返回正文的 SVG 片段和纸的宽高；纸本身和背景由场景去画
function buildPaper(sum, opt) {
	const W = 380, P = 24, LH = 19, TH = 5;
	const cx = W / 2, xL = P, xR = W - P, xItem = xL + 12, xTok = xR - 78;
	const T = I18N[opt.lang] || I18N.en;
	const body = [];
	let y = TH;

	const text = (x, s, o = {}) => {
		body.push(`<text x="${x}" y="${y}"${o.anchor ? ` text-anchor="${o.anchor}"` : ""} font-size="${o.size || 12.5}"`
			+ `${o.bold ? ' font-weight="700"' : ""}${o.dim ? ` fill="${DIM}"` : ""}${o.ls ? ` letter-spacing="${o.ls}"` : ""}>${esc(s)}</text>`);
	};
	const line = (yy, dash) => `<line x1="${xL}" x2="${xR}" y1="${yy}" y2="${yy}" stroke="${INK}" stroke-width="1"${dash ? ' stroke-dasharray="4 3"' : ""}/>`;
	const rule = (kind) => {
		y += 11;
		if (kind === "double") { body.push(line(y - 1.5), line(y + 1.5)); } else body.push(line(y, true));
		y += 7;
	};
	const row = (label, tokens, amount, o = {}) => {
		y += LH;
		text(o.indent === false ? xL : xItem, label, o);
		if (tokens != null) text(xTok, tokens, Object.assign({ anchor: "end" }, o));
		if (amount != null) text(xR, amount, Object.assign({ anchor: "end" }, o, o.amountDim ? { dim: true, bold: false, size: 11 } : {}));
	};

	// 抬头：一枚代币，店名，日期
	y += 34;
	body.push(`<circle cx="${cx}" cy="${y}" r="16" fill="none" stroke="${INK}" stroke-width="3"/>`
		+ `<circle cx="${cx}" cy="${y}" r="11.5" fill="none" stroke="${INK}" stroke-width="1" stroke-dasharray="2 2"/>`
		+ `<path d="M${cx - 6} ${y - 6}h12M${cx} ${y - 6}v13" stroke="${INK}" stroke-width="3" fill="none"/>`);
	y += 48;
	text(cx, opt.title || T.title, { anchor: "middle", size: 24, bold: true, ls: 2 });
	y += 21;
	text(cx, T.subtitle, { anchor: "middle", size: 12, ls: 3 });
	y += 26;
	text(cx, `${ymd(sum.date)}  ${T.week[sum.date.getDay()]}`, { anchor: "middle" });
	y += LH + 2;
	const now = new Date();
	text(xL, `${T.no} #${ymd(sum.date).replace(/-/g, "")}-${String(sum.requests).padStart(4, "0")}`, { size: 11 });
	text(xR, `${T.printed} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`, { anchor: "end", size: 11 });
	if (opt.host) {
		y += LH - 3;
		text(xL, `${T.table} ${opt.host.ip}`, { size: 11 });
		text(xR, `${T.seat} ${opt.host.system}`, { anchor: "end", size: 11 });
	}
	rule();
	y += LH - 4;
	text(xL, T.item, { size: 11 });
	text(xTok, T.tokens, { anchor: "end", size: 11 });
	text(xR, T.amount, { anchor: "end", size: 11 });
	y -= 4;
	rule();
	y -= 6;

	// 每个来源一栏，当天没用过的不印
	const shown = sum.sections.filter((s) => s.shown);
	if (!shown.length) {
		y += LH + 8;
		text(cx, T.none, { anchor: "middle", dim: true });
		y += 4;
	}
	shown.forEach((s, i) => {
		if (i) { rule(); y -= 6; }
		y += LH + 2;
		text(xL, s.name, { bold: true, size: 13.5, ls: 1 });
		if (s.models.length) text(xR, T.sessions(num(s.sessions), num(s.requests)), { anchor: "end", size: 11 });
		for (const m of s.models) {
			y += LH + 3;
			text(xL, m.label, { bold: true });
			text(xR, T.times(num(m.reqs)), { anchor: "end", size: 11 });
			for (const l of m.lines) row(T[l.key], num(l.tokens), s.priced ? (m.priced ? usd(l.cost) : "—") : null);
		}
		if (s.models.length) {
			y += 4;
			row(T.subtotal, num(s.tokens), s.priced ? usd(s.cost) : T.unpricedTag, { indent: false, bold: true, amountDim: !s.priced });
		}
		// 订阅额度：当天用满了几次（Claude），或者已经用掉百分之几（Codex 的记录里有，别家靠 Magpie 的采样）
		for (const l of s.limits) {
			y += 4;
			row(T.limits[l.type], null, `× ${l.hits.length}`, { indent: false, bold: true });
			const at = l.hits.map((h) => resetLabel(h, sum.date)).filter(Boolean);
			if (at.length) {
				y += LH - 2;
				text(xItem, `${T.resets} ${at.slice(0, 5).join(" · ")}${at.length > 5 ? " …" : ""}`, { size: 11 });
			}
		}
		for (const q of s.quota) {
			y += 4;
			const list = q.list.slice(-4);
			row((q.label ? q.label + " " : "") + T.window(q.minutes, q.name), null, list.map((x) => `${Math.round(x.used)}%`).join(" · "), { indent: false, bold: true });
			const at = list.map((x) => (x.resetsAt ? resetLabel(x, sum.date) : "")).filter(Boolean);
			if (at.length) {
				y += LH - 2;
				text(xItem, `${T.resets} ${at.join(" · ")}`, { size: 11 });
			}
		}
		// 账户余额当天花掉多少
		for (const e of s.extras) {
			y += 4;
			row(`${e.name} ${T.balance}`, null, `-${e.symbol}${e.spent.toFixed(2)}`, { indent: false, bold: true });
			y += LH - 2;
			text(xItem, `${T.left} ${e.symbol}${e.left.toFixed(2)}`, { size: 11 });
		}
	});
	rule("double");

	// 合计
	const big = { bold: true, size: 15 };
	const bigEnd = { anchor: "end", bold: true, size: 15 };
	y += LH + 4;
	text(xL, T.total, big);
	text(xR, num(sum.tokens), bigEnd);
	y += LH + 5;
	text(xL, T.apiAt, big);
	text(xR, usd(sum.cost), bigEnd);
	rule();
	y += LH - 4;
	text(cx, T.note, { anchor: "middle", size: 10.5, dim: true });
	if (sum.unpriced) {
		y += 15;
		text(cx, T.noteUnpriced, { anchor: "middle", size: 10.5, dim: true });
	}

	// 条形码：日期 + 合计 token，只做样子，扫不出来
	const code = ymd(sum.date).replace(/-/g, "") + String(Math.round(sum.tokens)).padStart(10, "0");
	const seq = [];
	for (let i = 0; i < code.length; i++) {
		const v = code.charCodeAt(i) * 7 + i * 3;
		seq.push(1 + (v % 3), 1 + ((v >> 2) % 2), 1 + ((v >> 3) % 3), 1 + ((v >> 1) % 2));
	}
	const bw = 232 / seq.reduce((a, b) => a + b, 0);
	let bx = cx - 116;
	const bars = [];
	y += 20;
	seq.forEach((s, i) => {
		if (i % 2 === 0) bars.push(`<rect x="${bx.toFixed(2)}" y="${y}" width="${(s * bw).toFixed(2)}" height="40" fill="${INK}"/>`);
		bx += s * bw;
	});
	body.push(bars.join(""));
	y += 40 + 15;
	text(cx, code, { anchor: "middle", size: 10.5, ls: 3 });
	y += 25;
	text(cx, T.thanks, { anchor: "middle", size: 12, ls: 2 });
	y += 26;

	return { W, H: y + TH, body: body.join("") };
}

// ---------- 场景 ----------
// 都按「俯拍静物照」来做：光从左上来，材质的纹理、投影、颗粒全用 SVG 滤镜算出来，不带任何图片

// 纸的轮廓：上下两边可以是锯齿撕口，也可以是平的（被夹子压住、还连在打印机里）
function paperPath(W, H, top, bottom) {
	const TOOTH = 10, TH = 5, n = W / TOOTH;
	let d;
	if (top) {
		d = `M0 ${TH}`;
		for (let i = 0; i < n; i++) d += `L${i * TOOTH + TOOTH / 2} 0L${(i + 1) * TOOTH} ${TH}`;
	} else d = `M0 0L${W} 0`;
	if (bottom) {
		d += `L${W} ${H - TH}`;
		for (let i = n; i > 0; i--) d += `L${i * TOOTH - TOOTH / 2} ${H}L${(i - 1) * TOOTH} ${H - TH}`;
	} else d += `L${W} ${H}L0 ${H}`;
	return d + "Z";
}

const stops = (list) => list.map(([o, c, a]) => `<stop offset="${o}" stop-color="${c}"${a != null ? ` stop-opacity="${a}"` : ""}/>`).join("");
const blur = (id, n) => `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${n}"/></filter>`;
// 把噪声当高度图打一束斜光，得到一层有起伏的灰度纹理，叠（正片叠底）在底色上
const relief = (id, freq, octaves, scale, seed) => `<filter id="${id}" x="0" y="0" width="100%" height="100%">`
	+ `<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${octaves}" seed="${seed}"/>`
	+ `<feDiffuseLighting surfaceScale="${scale}" diffuseConstant="1.12" lighting-color="#fff"><feDistantLight azimuth="225" elevation="58"/></feDiffuseLighting>`
	+ `<feComposite in2="SourceAlpha" operator="in"/></filter>`;
const MULTIPLY = 'style="mix-blend-mode:multiply"';

// 一张纸：两层投影、纸面纤维、顺着纸卷方向的起伏、可选的折痕，再用「热敏打印」的墨迹印上正文。
// o.under 画在纸面上、字下面，o.over 压在最上面（图钉、胶带）
function sheet(p, id, o) {
	const H = p.H + (o.extra || 0), W = p.W;
	const d = paperPath(W, H, o.top !== false, o.bottom !== false);
	const [dx, dy, soft, op] = o.shadow;
	const defs = `<filter id="${id}s" x="-45%" y="-15%" width="200%" height="140%"><feDropShadow dx="1" dy="1.5" stdDeviation="1.8" flood-color="#140e06" flood-opacity=".4"/>`
		+ `<feDropShadow dx="${dx}" dy="${dy}" stdDeviation="${soft}" flood-color="#140e06" flood-opacity="${op}"/></filter>`
		+ relief(id + "pt", 0.85, 3, 0.8, 4)
		// 墨迹：轻微晕开，大面积上深浅不匀，再随机掉一些点
		+ `<filter id="${id}ink" x="-2%" y="-1%" width="104%" height="102%"><feGaussianBlur in="SourceGraphic" stdDeviation="0.24" result="b"/>`
		+ `<feTurbulence type="fractalNoise" baseFrequency="0.011 0.03" numOctaves="2" seed="5"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -0.55 1.28" result="fade"/>`
		+ `<feComposite in="b" in2="fade" operator="in" result="f"/>`
		+ `<feTurbulence type="fractalNoise" baseFrequency="1.3" numOctaves="1" seed="9"/><feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 7 -1.1" result="drop"/>`
		+ `<feComposite in="f" in2="drop" operator="in"/></filter>`
		+ `<linearGradient id="${id}g" x1="0" x2="1" y1="0" y2="0">${stops([[0, "#000", 0.07], [0.05, "#000", 0.015], [0.14, "#fff", 0.35], [0.5, "#000", 0], [0.88, "#000", 0.02], [1, "#000", 0.1]])}</linearGradient>`
		+ `<linearGradient id="${id}u" x1="0" x2="0" y1="0" y2="1">${stops([[0, "#000", 0.03], [0.1, "#fff", 0.3], [0.27, "#000", 0.028], [0.45, "#fff", 0.22], [0.63, "#000", 0.03], [0.8, "#fff", 0.2], [1, "#000", 0.06]])}</linearGradient>`
		+ blur(id + "cr", 0.9)
		+ `<clipPath id="${id}c"><path d="${d}"/></clipPath>`;
	let folds = "";
	if (o.folds) {
		for (const f of [0.335, 0.672]) {
			const y = Math.round(H * f);
			folds += `<g filter="url(#${id}cr)"><line x1="-4" x2="${W + 4}" y1="${y}" y2="${y + 1.5}" stroke="#000" stroke-opacity=".2" stroke-width="1.3"/>`
				+ `<line x1="-4" x2="${W + 4}" y1="${y + 2.2}" y2="${y + 3.7}" stroke="#fff" stroke-opacity=".9" stroke-width="1.6"/></g>`;
		}
	}
	const g = `<g transform="translate(${o.x} ${o.y})${o.rot ? ` rotate(${o.rot} ${W / 2} ${H / 2})` : ""}">`
		+ `<path d="${d}" fill="${PAPER}" filter="url(#${id}s)"/>`
		+ `<g clip-path="url(#${id}c)"><rect width="${W}" height="${H}" filter="url(#${id}pt)" opacity=".3" ${MULTIPLY}/>`
		+ `<rect width="${W}" height="${H}" fill="url(#${id}u)"/><rect width="${W}" height="${H}" fill="url(#${id}g)"/>${folds}${o.under || ""}</g>`
		+ `<g font-family="${FONT}" fill="${INK}" filter="url(#${id}ink)">${p.body}</g>${o.over || ""}</g>`;
	return { defs, g, H };
}

// 入场动效：所有动画共用一个 8 秒的周期，前一两秒演完（出纸 1.3 秒），后面停在最终画面。
// once 只演一遍（侧边栏里看），loop 循环（存成动画 SVG 贴进 README 之类的地方）
function motionCss(mode) {
	const run = `8s ${mode === "loop" ? "infinite" : "1"} both`;
	return `<style>`
		+ `.tr-drop{animation:tr-drop ${run}}`
		+ `.tr-print{animation:tr-print ${run};animation-timing-function:steps(40,end)}`
		+ `.tr-pop{animation:tr-pop ${run};transform-box:fill-box;transform-origin:center}`
		+ `.tr-bit{animation:tr-bit ${run};transform-box:fill-box;transform-origin:center}`
		+ `@keyframes tr-drop{0%{opacity:0;transform:translateY(-46px)}7%{opacity:1;transform:translateY(4px)}9%,100%{opacity:1;transform:none}}`
		+ `@keyframes tr-print{0%{transform:translateY(var(--h))}16%,100%{transform:none}}`
		+ `@keyframes tr-pop{0%,9%{opacity:0;transform:scale(2.4)}13%,100%{opacity:1;transform:none}}`
		+ `@keyframes tr-bit{0%,16%{opacity:0;transform:none}18%{opacity:1}34%{opacity:1}42%,100%{opacity:0;transform:translate(var(--x),var(--y)) rotate(var(--r))}}`
		+ `@media (prefers-reduced-motion:reduce){.tr-drop,.tr-print,.tr-pop{animation:none}.tr-bit{animation:none;opacity:0}}`
		+ `</style>`;
}

const anim = (on, cls, inner, vars) => (on ? `<g class="${cls}"${vars ? ` style="${vars}"` : ""}>${inner}</g>` : inner);

// 最后盖一层光：左上的一片暖光、斜着的窗影、四角压暗、胶片颗粒；整张图裁成圆角
function frame(id, w, h, defs, content, motion, o = {}) {
	const light = o.flat ? "" : `<rect width="${w}" height="${h}" fill="url(#${id}lp)" style="mix-blend-mode:soft-light"/>`
		+ `<g filter="url(#${id}wb)" opacity="${o.bands != null ? o.bands : 0.2}" ${MULTIPLY} fill="#2b1d10" transform="rotate(-24 ${w / 2} ${h / 2})">`
		+ `<rect x="${-w}" y="${h * 0.12}" width="${w * 3}" height="${h * 0.07}"/><rect x="${-w}" y="${h * 0.42}" width="${w * 3}" height="${h * 0.045}"/>`
		+ `<rect x="${-w}" y="${h * 0.78}" width="${w * 3}" height="${h * 0.09}"/></g>`
		+ `<rect width="${w}" height="${h}" fill="url(#${id}vg)"/>`
		+ `<rect width="${w}" height="${h}" filter="url(#${id}gr)" opacity=".5" style="mix-blend-mode:overlay"/>`;
	const lightDefs = o.flat ? "" : `<radialGradient id="${id}lp" cx=".22" cy=".14" r=".95">${stops([[0, "#fff6e0", 0.85], [0.55, "#fff", 0.1], [1, "#000", 0.35]])}</radialGradient>`
		+ `<radialGradient id="${id}vg" cx=".5" cy=".46" r=".78">${stops([[0.55, "#000", 0], [1, "#000", 0.42]])}</radialGradient>`
		+ blur(id + "wb", 26)
		+ `<filter id="${id}gr" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves="2" seed="2"/>`
		+ `<feColorMatrix values=".33 .33 .33 0 0  .33 .33 .33 0 0  .33 .33 .33 0 0  0 0 0 0 1"/></filter>`;
	return {
		width: w,
		height: h,
		svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${motion ? motionCss(motion) : ""}`
			+ `<defs>${defs}${lightDefs}<clipPath id="${id}r"><rect width="${w}" height="${h}" rx="14"/></clipPath></defs>`
			+ `<g clip-path="url(#${id}r)">${content}${light}</g></svg>`,
	};
}

// 木头桌面：把顺着木板方向拉长的噪声映射成深浅交替的年轮色带，再叠一层起伏；木板之间是带高光的拼缝
function wood(id, w, h, dark) {
	const t = dark
		? { r: "0.20 0.31 0.24 0.36 0.27 0.40", g: "0.12 0.19 0.14 0.22 0.16 0.25", b: "0.07 0.11 0.08 0.13 0.09 0.15" }
		: { r: "0.55 0.72 0.62 0.80 0.67 0.86", g: "0.36 0.50 0.42 0.58 0.46 0.64", b: "0.20 0.30 0.24 0.36 0.27 0.41" };
	const pw = 168;
	let seams = "";
	for (let i = 1; i * pw < w; i++) {
		const x = i * pw - 30;
		seams += `<rect x="${x}" width="2.2" height="${h}" fill="#000" opacity=".5"/><rect x="${x + 2.2}" width="1.2" height="${h}" fill="#fff" opacity=".16"/>`
			+ (i % 2 ? `<rect x="${x + 3.4}" width="${pw}" height="${h}" fill="#000" opacity=".07"/>` : "");
	}
	const defs = `<filter id="${id}w" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.3 0.0035" numOctaves="4" seed="8"/>`
		+ `<feColorMatrix values=".9 0 0 0 .05  .9 0 0 0 .05  .9 0 0 0 .05  0 0 0 0 1"/>`
		+ `<feComponentTransfer><feFuncR type="table" tableValues="${t.r}"/><feFuncG type="table" tableValues="${t.g}"/><feFuncB type="table" tableValues="${t.b}"/></feComponentTransfer></filter>`
		+ relief(id + "wr", "0.5 0.012", 3, 1.1, 3);
	const g = `<rect width="${w}" height="${h}" filter="url(#${id}w)"/><rect width="${w}" height="${h}" filter="url(#${id}wr)" opacity=".5" ${MULTIPLY}/>${seams}`;
	return { defs, g };
}

function coin(id, x, y, r, kind) {
	return `<circle cx="${x + 3}" cy="${y + 5}" r="${r}" fill="#000" opacity=".5" filter="url(#${id}b4)"/><circle cx="${x}" cy="${y}" r="${r}" fill="url(#${id}c${kind})"/>`
		+ `<circle cx="${x}" cy="${y}" r="${r - 0.8}" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="1"/>`
		+ `<circle cx="${x}" cy="${y}" r="${(r * 0.76).toFixed(1)}" fill="none" stroke="#000" stroke-opacity=".28" stroke-width="1.4"/>`
		+ `<circle cx="${x + 0.6}" cy="${y + 0.8}" r="${(r * 0.76).toFixed(1)}" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width=".8"/>`;
}

function pin(id, x, y, kind) {
	return `<ellipse cx="${x + 7}" cy="${y + 11}" rx="10" ry="6" fill="#000" opacity=".55" filter="url(#${id}b3)"/><circle cx="${x}" cy="${y}" r="9.5" fill="url(#${id}pin${kind})"/>`
		+ `<ellipse cx="${x - 3.2}" cy="${y - 3.6}" rx="3.2" ry="2.2" fill="#fff" opacity=".75" filter="url(#${id}b1)"/>`;
}

// 和纸胶带：半透明，带一点纸纹和投影
function tapeStrip(id, x, y, angle, color) {
	return `<g transform="translate(${x} ${y}) rotate(${angle})"><rect x="-49" y="-11" width="98" height="26" fill="#000" opacity=".3" filter="url(#${id}b3)"/>`
		+ `<rect x="-49" y="-13" width="98" height="26" fill="${color}" opacity=".8"/><rect x="-49" y="-13" width="98" height="26" fill="url(#${id}t)" opacity=".8"/>`
		+ `<rect x="-49" y="-13" width="98" height="26" filter="url(#${id}pt)" opacity=".5" ${MULTIPLY}/></g>`;
}

const radial = (id, list) => `<radialGradient id="${id}" cx=".34" cy=".28" r=".85">${list.map((s, i) => `<stop offset="${[0, 0.55, 1][i]}" stop-color="${s}"/>`).join("")}</radialGradient>`;

// 出纸口迸出来的彩纸：从 (cx, cy) 往上半圈散开
function confetti(cx, cy) {
	let seed = 23, out = "";
	const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
	const cols = ["#ff5a5f", "#ffb400", "#00a699", "#7b61ff", "#ff8fab", "#2d9cdb"];
	for (let i = 0; i < 34; i++) {
		const ang = Math.PI * (1.06 + rnd() * 0.88), dist = 90 + rnd() * 230;
		const vars = `--x:${(Math.cos(ang) * dist).toFixed(0)}px;--y:${(Math.sin(ang) * dist).toFixed(0)}px;--r:${Math.floor(rnd() * 720 - 360)}deg`;
		const fill = cols[i % cols.length];
		out += i % 3 === 0
			? `<circle class="tr-bit" style="${vars}" cx="${cx}" cy="${cy}" r="${(3.5 + rnd() * 2.5).toFixed(1)}" fill="${fill}"/>`
			: `<rect class="tr-bit" style="${vars}" x="${cx - 3}" y="${cy - 5}" width="${(6 + rnd() * 4).toFixed(1)}" height="${(10 + rnd() * 6).toFixed(1)}" rx="1.5" fill="${fill}"/>`;
	}
	return out;
}

const SCENES = {
	// 纯净：浅灰底，不加光影
	plain(p, id, a) {
		const s = sheet(p, id, { x: 26, y: 24, shadow: [2, 5, 7, 0.2] });
		const w = p.W + 52, h = s.H + 52;
		return frame(id, w, h, s.defs, `<rect width="${w}" height="${h}" fill="#e9e6de"/>${anim(a, "tr-drop", s.g)}`, a, { flat: true });
	},

	// 木桌：随手放在桌上，有折痕，旁边两枚硬币
	desk(p, id, a) {
		const s = sheet(p, id, { x: 88, y: 76, rot: -2.2, folds: true, shadow: [10, 18, 20, 0.34] });
		const w = p.W + 176, h = s.H + 160;
		const wd = wood(id, w, h, false);
		const defs = s.defs + wd.defs + blur(id + "b4", 4) + radial(id + "ca", ["#fff1bd", "#d6ab46", "#8a6418"]) + radial(id + "cb", ["#ffffff", "#b9bdc3", "#6c7178"]);
		return frame(id, w, h, defs, wd.g + anim(a, "tr-drop", s.g) + coin(id, 58, h - 70, 22, "a") + coin(id, 98, h - 44, 17, "b"), a);
	},

	// 打印机：小票还连在热敏打印机上，从出纸口一行一行走出来，走完迸一把彩纸
	printer(p, id, a) {
		const extra = 44, H = p.H + extra, px = 96, top = 52;
		const under = `<rect y="${H - 120}" width="${p.W}" height="120" fill="url(#${id}k)"/>`;
		const s = sheet(p, id, { x: px, y: top, bottom: false, extra, shadow: [8, 14, 16, 0.4], under });
		const w = p.W + 192, py = top + H - 22, h = py + 146;
		const wd = wood(id, w, h, true);
		const bx = 36, bw = w - 72, lx = bx + bw - 122, y0 = py + 46;
		const shape = `M${bx} ${h + 20}V${py + 20}a20 20 0 0 1 20 -20H${bx + bw - 20}a20 20 0 0 1 20 20V${h + 20}Z`;
		const label = (x, y, t) => `<text x="${x}" y="${y}" font-size="8.5" letter-spacing="1.2" fill="#9a9ea5">${t}</text>`;
		const machine = `<path d="${shape}" fill="#000" opacity=".6" filter="url(#${id}b12)" transform="translate(8 6)"/>`
			+ `<path d="${shape}" fill="url(#${id}pb)"/><path d="${shape}" filter="url(#${id}pl)" opacity=".55" ${MULTIPLY}/>`
			+ `<path d="M${bx + 20} ${py + 1.2}H${bx + bw - 20}" stroke="#fff" stroke-opacity=".3" stroke-width="1.6" filter="url(#${id}b1)"/>`
			+ `<rect x="${bx}" y="${py + 20}" width="2" height="${h}" fill="#fff" opacity=".1"/>`
			// 出纸口：一道深槽，下沿有一条反光
			+ `<rect x="${px - 18}" y="${py - 1}" width="${p.W + 36}" height="14" rx="7" fill="#000"/>`
			+ `<rect x="${px - 14}" y="${py + 13}" width="${p.W + 28}" height="1.6" rx=".8" fill="#fff" opacity=".22"/>`
			+ `<rect x="${px - 18}" y="${py + 15}" width="${p.W + 36}" height="16" fill="url(#${id}sl)"/>`
			+ `<g font-family="${UI_FONT}">`
			+ `<text x="${bx + 30}" y="${py + 67}" font-size="16" font-weight="700" letter-spacing="2.5" fill="#000" opacity=".55">TR-80</text>`
			+ `<text x="${bx + 30}" y="${py + 66}" font-size="16" font-weight="700" letter-spacing="2.5" fill="#6a6f77">TR-80</text>`
			+ `<text x="${bx + 30}" y="${py + 83}" font-size="7.5" letter-spacing="1.6" fill="#5b6067">THERMAL RECEIPT PRINTER</text>`
			+ `<circle cx="${lx}" cy="${y0}" r="13" fill="#63ff4e" opacity=".5" filter="url(#${id}b4)"/><circle cx="${lx}" cy="${y0}" r="4.6" fill="url(#${id}led)"/>${label(lx + 14, y0 + 3, "POWER")}`
			+ `<circle cx="${lx}" cy="${y0 + 22}" r="4.6" fill="#3d1a1a" stroke="#000" stroke-opacity=".5"/>${label(lx + 14, y0 + 25, "ERROR")}`
			+ `<circle cx="${lx}" cy="${y0 + 44}" r="4.6" fill="#33311c" stroke="#000" stroke-opacity=".5"/>${label(lx + 14, y0 + 47, "PAPER")}`
			+ `<rect x="${lx - 8}" y="${y0 + 61}" width="90" height="28" rx="14" fill="#000" opacity=".5"/>`
			+ `<rect x="${lx - 8}" y="${y0 + 60}" width="90" height="27" rx="13.5" fill="url(#${id}bt)" stroke="#55585e"/>`
			+ `<text x="${lx + 37}" y="${y0 + 77}" text-anchor="middle" font-size="8.5" letter-spacing="1.5" fill="#b3b7bd">FEED</text></g>`;
		const defs = s.defs + wd.defs + blur(id + "b1", 1) + blur(id + "b4", 5) + blur(id + "b12", 14)
			+ relief(id + "pl", 1.4, 2, 0.7, 6)
			+ `<linearGradient id="${id}k" x1="0" x2="0" y1="0" y2="1">${stops([[0, "#000", 0], [0.7, "#000", 0.08], [1, "#000", 0.3]])}</linearGradient>`
			+ `<linearGradient id="${id}pb" x1="0" x2="0" y1="0" y2="1">${stops([[0, "#4a4d53"], [0.06, "#33363b"], [1, "#17181a"]])}</linearGradient>`
			+ `<linearGradient id="${id}sl" x1="0" x2="0" y1="0" y2="1">${stops([[0, "#000", 0.35], [1, "#000", 0]])}</linearGradient>`
			+ `<linearGradient id="${id}bt" x1="0" x2="0" y1="0" y2="1">${stops([[0, "#3a3d42"], [1, "#222427"]])}</linearGradient>`
			+ radial(id + "led", ["#eaffe4", "#7dff68", "#2f9a22"]);
		return frame(id, w, h, defs, wd.g + anim(a, "tr-print", s.g, `--h:${H}px`) + machine + (a ? confetti(px + p.W / 2, py + 4) : ""), a, { bands: 0.14 });
	},

	// 软木板：用图钉钉在留言板上，后面露出半张便利贴
	cork(p, id, a) {
		const s = sheet(p, id, { x: 90, y: 92, rot: 1.6, folds: true, shadow: [7, 12, 12, 0.36], over: anim(a, "tr-pop", pin(id, p.W / 2, 13, "r")) });
		const w = p.W + 180, h = s.H + 184, f = 24;
		const board = `<rect width="${w}" height="${h}" filter="url(#${id}fw)"/><rect width="${w}" height="${h}" filter="url(#${id}fr)" opacity=".5" ${MULTIPLY}/>`
			+ `<rect x="${f - 2}" y="${f - 2}" width="${w - 2 * f + 4}" height="${h - 2 * f + 4}" fill="#000" opacity=".55"/>`
			+ `<rect x="${f}" y="${f}" width="${w - 2 * f}" height="${h - 2 * f}" filter="url(#${id}ck)"/>`
			+ `<rect x="${f}" y="${f}" width="${w - 2 * f}" height="${h - 2 * f}" filter="url(#${id}cr2)" opacity=".7" ${MULTIPLY}/>`
			+ `<rect x="${f}" y="${f}" width="${w - 2 * f}" height="16" fill="url(#${id}in)"/><rect x="${f}" y="${f}" width="16" height="${h - 2 * f}" fill="url(#${id}in2)"/>`;
		const note = `<g transform="translate(${w - 160} ${h - 212}) rotate(7)"><rect x="5" y="8" width="130" height="130" fill="#000" opacity=".5" filter="url(#${id}b4)"/><rect width="130" height="130" fill="#f7dc62"/>`
			+ `<rect width="130" height="130" filter="url(#${id}pt)" opacity=".6" ${MULTIPLY}/><rect width="130" height="130" fill="url(#${id}nt)"/>`
			+ `<path d="M18 56h88M18 76h70M18 96h82" stroke="#4d4424" stroke-opacity=".45" stroke-width="2.6" stroke-linecap="round" filter="url(#${id}b1)"/>${pin(id, 65, 14, "b")}</g>`;
		const defs = s.defs + blur(id + "b1", 0.6) + blur(id + "b3", 3) + blur(id + "b4", 5)
			// 软木：粗细两层颗粒
			+ `<filter id="${id}ck" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.55" numOctaves="3" seed="12"/>`
			+ `<feColorMatrix values=".9 0 0 0 .05  .9 0 0 0 .05  .9 0 0 0 .05  0 0 0 0 1"/><feComponentTransfer><feFuncR type="table" tableValues="0.50 0.66 0.78 0.72 0.86"/>`
			+ `<feFuncG type="table" tableValues="0.33 0.46 0.58 0.52 0.66"/><feFuncB type="table" tableValues="0.18 0.27 0.36 0.31 0.44"/></feComponentTransfer></filter>`
			+ relief(id + "cr2", 0.7, 3, 1.6, 21)
			// 木框
			+ `<filter id="${id}fw" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.004 0.3" numOctaves="4" seed="5"/>`
			+ `<feColorMatrix values=".9 0 0 0 .05  .9 0 0 0 .05  .9 0 0 0 .05  0 0 0 0 1"/><feComponentTransfer><feFuncR type="table" tableValues="0.30 0.44 0.36 0.50"/>`
			+ `<feFuncG type="table" tableValues="0.18 0.27 0.22 0.32"/><feFuncB type="table" tableValues="0.10 0.15 0.12 0.19"/></feComponentTransfer></filter>`
			+ relief(id + "fr", "0.012 0.5", 3, 1.1, 3)
			+ `<linearGradient id="${id}in" x1="0" x2="0" y1="0" y2="1">${stops([[0, "#000", 0.45], [1, "#000", 0]])}</linearGradient>`
			+ `<linearGradient id="${id}in2" x1="0" x2="1" y1="0" y2="0">${stops([[0, "#000", 0.4], [1, "#000", 0]])}</linearGradient>`
			+ `<linearGradient id="${id}nt" x1="0" x2="1" y1="0" y2="1">${stops([[0, "#fff", 0.25], [0.6, "#000", 0], [1, "#000", 0.14]])}</linearGradient>`
			+ radial(id + "pinr", ["#ffb3aa", "#d9342a", "#7a1410"]) + radial(id + "pinb", ["#bcd6ff", "#2f66d0", "#152f7a"]);
		return frame(id, w, h, defs, board + note + anim(a, "tr-drop", s.g), a);
	},

	// 手账：用两段和纸胶带贴在点阵本的一页上
	tape(p, id, a) {
		const over = anim(a, "tr-pop", tapeStrip(id, 20, 16, -38, "#6fc3b1")) + anim(a, "tr-pop", tapeStrip(id, p.W - 20, 16, 36, "#f09bae"));
		const s = sheet(p, id, { x: 94, y: 80, rot: -1.4, folds: true, shadow: [4, 7, 8, 0.26], over });
		const w = p.W + 164, h = s.H + 164;
		let holes = "";
		for (let y = 70; y < h - 30; y += 110) {
			holes += `<circle cx="29" cy="${y}" r="9.5" fill="#3b2d1e"/><circle cx="29" cy="${y}" r="9.5" fill="url(#${id}ho)"/>`;
		}
		const page = `<rect width="${w}" height="${h}" fill="#f4eedf"/><rect width="${w}" height="${h}" filter="url(#${id}pp)" opacity=".7" ${MULTIPLY}/>`
			+ `<rect width="${w}" height="${h}" fill="url(#${id}d)"/><rect width="60" height="${h}" fill="url(#${id}gu)"/>`
			+ `<line x1="60" x2="60" y1="0" y2="${h}" stroke="#d98787" stroke-opacity=".7" stroke-width="1.1"/>${holes}`;
		const defs = s.defs + blur(id + "b3", 3) + relief(id + "pp", 0.6, 4, 1.3, 14)
			+ `<pattern id="${id}d" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="10" cy="10" r="1" fill="#a79c82" opacity=".7"/></pattern>`
			+ `<pattern id="${id}t" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3.5" height="9" fill="#fff" opacity=".4"/></pattern>`
			+ `<linearGradient id="${id}gu" x1="0" x2="1" y1="0" y2="0">${stops([[0, "#000", 0.22], [0.5, "#000", 0.05], [1, "#000", 0]])}</linearGradient>`
			+ `<radialGradient id="${id}ho" cx=".4" cy=".35" r=".7">${stops([[0.55, "#000", 0], [1, "#000", 0.6]])}</radialGradient>`;
		return frame(id, w, h, defs, page + anim(a, "tr-drop", s.g), a, { bands: 0.13 });
	},

	// 账单夹板：像餐厅结账时那样夹在板子上递过来
	clip(p, id, a) {
		const s = sheet(p, id, { x: 92, y: 104, top: false, shadow: [4, 8, 8, 0.32] });
		const w = p.W + 184, h = s.H + 208, cx = w / 2;
		const bg = `<rect width="${w}" height="${h}" fill="#33443f"/><rect width="${w}" height="${h}" filter="url(#${id}fe)" opacity=".8" ${MULTIPLY}/>`;
		const bw = w - 96, bh = h - 82;
		const board = `<rect x="56" y="48" width="${bw}" height="${bh}" rx="18" fill="#000" opacity=".6" filter="url(#${id}b12)"/>`
			+ `<g clip-path="url(#${id}bc)"><rect x="48" y="36" width="${bw}" height="${bh}" filter="url(#${id}mw)"/>`
			+ `<rect x="48" y="36" width="${bw}" height="${bh}" filter="url(#${id}mr)" opacity=".5" ${MULTIPLY}/></g>`
			+ `<rect x="49" y="37" width="${bw - 2}" height="${bh - 2}" rx="17" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="1.5"/>`
			+ `<rect x="48" y="36" width="${bw}" height="${bh}" rx="18" fill="none" stroke="#000" stroke-opacity=".35"/>`;
		const metal = `<rect x="${cx - 96}" y="84" width="200" height="38" rx="7" fill="#000" opacity=".55" filter="url(#${id}b4)"/>`
			+ `<rect x="${cx - 46}" y="44" width="92" height="48" rx="16" fill="url(#${id}m)" stroke="#5f656c"/><circle cx="${cx}" cy="60" r="9" fill="#2a1d12" stroke="#5f656c"/>`
			+ `<rect x="${cx - 100}" y="76" width="200" height="38" rx="7" fill="url(#${id}m)" stroke="#5f656c"/>`
			+ `<rect x="${cx - 96}" y="78.5" width="192" height="2" rx="1" fill="#fff" opacity=".8"/>`
			+ `<circle cx="${cx - 78}" cy="96" r="4.2" fill="url(#${id}rv)" stroke="#4d5359"/><circle cx="${cx + 78}" cy="96" r="4.2" fill="url(#${id}rv)" stroke="#4d5359"/>`;
		const defs = s.defs + blur(id + "b4", 4) + blur(id + "b12", 13) + relief(id + "fe", 1.1, 2, 1.4, 17)
			+ `<clipPath id="${id}bc"><rect x="48" y="36" width="${bw}" height="${bh}" rx="18"/></clipPath>`
			// 夹板是压出来的硬纤维板：很细的斑点
			+ `<filter id="${id}mw" x="0" y="0" width="100%" height="100%" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.9 0.5" numOctaves="3" seed="31"/>`
			+ `<feColorMatrix values=".9 0 0 0 .05  .9 0 0 0 .05  .9 0 0 0 .05  0 0 0 0 1"/><feComponentTransfer><feFuncR type="table" tableValues="0.52 0.66 0.60 0.74"/>`
			+ `<feFuncG type="table" tableValues="0.34 0.45 0.40 0.52"/><feFuncB type="table" tableValues="0.20 0.27 0.24 0.33"/></feComponentTransfer></filter>`
			+ relief(id + "mr", 0.8, 2, 0.9, 8)
			+ `<linearGradient id="${id}m" x1="0" x2="0" y1="0" y2="1">${stops([[0, "#fbfcfc"], [0.3, "#b4b9bf"], [0.52, "#f1f3f4"], [0.7, "#c9cdd2"], [1, "#7c8289"]])}</linearGradient>`
			+ radial(id + "rv", ["#ffffff", "#9aa0a7", "#565c63"]);
		return frame(id, w, h, defs, bg + board + anim(a, "tr-drop", s.g) + metal, a, { bands: 0.16 });
	},
};

// opt.animate："once" / "loop" 带入场动效，不传就是静止的（导出 PNG 用）
function renderReceipt(sum, opt) {
	const paper = buildPaper(sum, opt);
	return (SCENES[opt.scene] || SCENES.plain)(paper, "tr" + (++uid), opt.animate || null);
}

async function svgToImage(svg, width, height, scale, failText, type) {
	const img = new Image();
	await new Promise((resolve, reject) => {
		img.onload = resolve;
		img.onerror = () => reject(new Error(failText));
		img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
	});
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(width * scale);
	canvas.height = Math.round(height * scale);
	canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
	return await new Promise((resolve) => canvas.toBlob(resolve, type || "image/png", 0.92));
}

// ---------- 视图 ----------

class ReceiptView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.date = dayStart(new Date());
		this.followToday = true;
	}

	getViewType() { return VIEW_TYPE; }
	getDisplayText() { return this.plugin.t().name; }
	getIcon() { return "receipt"; }

	async onOpen() {
		const root = this.contentEl;
		root.empty();
		root.addClass("token-receipt-view");

		const T = this.plugin.t();
		const bar = root.createDiv("token-receipt-bar");
		const btn = (icon, tip, fn) => {
			const b = bar.createEl("button", { cls: "clickable-icon", attr: { "aria-label": tip } });
			setIcon(b, icon);
			b.addEventListener("click", fn);
			return b;
		};
		btn("chevron-left", T.prev, () => this.shift(-1));
		this.dateEl = bar.createEl("input", { type: "date", cls: "token-receipt-date" });
		this.dateEl.addEventListener("change", () => {
			const [y, m, d] = this.dateEl.value.split("-").map(Number);
			if (y) this.setDate(new Date(y, m - 1, d));
		});
		btn("chevron-right", T.next, () => this.shift(1));
		btn("calendar-check", T.today, () => this.setDate(new Date()));
		this.sceneEl = bar.createEl("select", { cls: "dropdown token-receipt-scene", attr: { "aria-label": T.sScene[0] } });
		for (const k of SCENE_ORDER) this.sceneEl.createEl("option", { value: k, text: T.scenes[k] });
		this.sceneEl.addEventListener("change", async () => {
			this.plugin.settings.scene = this.sceneEl.value;
			await this.plugin.saveSettings();
			this.refresh();
		});
		bar.createDiv("token-receipt-spacer");
		btn("play", T.replay, () => this.refresh());
		btn("refresh-cw", T.refresh, () => this.refresh());
		btn("copy", T.copy, () => this.plugin.copyImage(this.date));
		btn("image-down", T.save, () => this.plugin.exportImage(this.date));
		btn("clapperboard", T.saveSvg, () => this.plugin.exportSvg(this.date));

		this.stage = root.createDiv("token-receipt-stage");
		this.stage.addEventListener("click", (e) => {
			if (e.target.closest("svg")) this.plugin.openInViewer(this.date);
		});
		// 开着看今天的小票时，隔几分钟跟着更新；过了零点自动翻到新的一天
		this.registerInterval(window.setInterval(() => {
			if (!this.followToday || !this.stage.isShown()) return;
			this.date = dayStart(new Date());
			this.refresh(true);
		}, 5 * 60 * 1000));
		await this.refresh();
	}

	shift(n) {
		this.setDate(new Date(this.date.getFullYear(), this.date.getMonth(), this.date.getDate() + n));
	}

	setDate(d) {
		this.date = dayStart(d);
		this.followToday = this.date.getTime() === dayStart(new Date()).getTime();
		this.refresh();
	}

	// 几次刷新叠在一起时，只让最后发起的那次画出来
	async refresh(quiet) {
		const date = this.date;
		const seq = (this.seq = (this.seq || 0) + 1);
		this.dateEl.value = ymd(date);
		this.sceneEl.value = this.plugin.settings.scene;
		if (!quiet) {
			this.stage.empty();
			this.stage.createDiv({ cls: "token-receipt-hint", text: this.plugin.t().counting });
		}
		try {
			// 自动刷新不重放入场动效
			const { svg } = await this.plugin.build(date, quiet ? null : "once");
			if (seq !== this.seq) return;
			const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
			this.stage.empty();
			this.stage.appendChild(this.stage.doc.importNode(doc.documentElement, true));
		} catch (e) {
			console.error("[token-receipt]", e);
			this.stage.empty();
			this.stage.createDiv({ cls: "token-receipt-hint", text: this.plugin.t().failed + e.message });
		}
	}
}

// ---------- 插件 ----------

class TokenReceiptPlugin extends Plugin {
	async onload() {
		const saved = (await this.loadData()) || {};
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		// 存下来的价目表盖在默认表上：自己改过的保留，默认表后来加的模型也能用上
		this.settings.prices = Object.assign({}, DEFAULT_PRICES, saved.prices || {});
		this.ledger = new Ledger();

		const T = this.t();
		this.registerView(VIEW_TYPE, (leaf) => new ReceiptView(leaf, this));
		this.addRibbonIcon("receipt", T.name, () => this.openView());
		this.addCommand({ id: "open", name: T.cmdOpen, callback: () => this.openView() });
		this.addCommand({ id: "export-today", name: T.cmdExport, callback: () => this.exportImage(dayStart(new Date())) });
		this.addCommand({
			id: "insert-today",
			name: T.cmdInsert,
			editorCallback: async (editor) => {
				const file = await this.exportImage(dayStart(new Date()), true);
				if (file) editor.replaceSelection(`![[${file.name}]]\n`);
			},
		});
		this.addSettingTab(new TokenReceiptSettingTab(this.app, this));
	}

	t() {
		return I18N[langOf(this.settings.language)];
	}

	async openView() {
		const ws = this.app.workspace;
		let leaf = ws.getLeavesOfType(VIEW_TYPE)[0];
		if (!leaf) {
			leaf = ws.getRightLeaf(false);
			await leaf.setViewState({ type: VIEW_TYPE, active: true });
		}
		ws.revealLeaf(leaf);
	}

	async build(date, animate) {
		const s = this.settings;
		const sum = await this.ledger.day(date, s);
		const opt = { title: s.title, lang: langOf(s.language), scene: s.scene, animate, host: s.showHost ? hostInfo() : null };
		return Object.assign({ sum }, renderReceipt(sum, opt));
	}

	async image(date, type) {
		const { svg, width, height } = await this.build(date);
		return await svgToImage(svg, width, height, Number(this.settings.exportScale) || 2, this.t().renderFailed, type);
	}

	async copyImage(date) {
		try {
			const blob = await this.image(date, "image/png");
			await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
			new Notice(this.t().copied);
		} catch (e) {
			console.error("[token-receipt]", e);
			new Notice(this.t().copyFailed + e.message);
		}
	}

	// 同一天重复导出会覆盖原来那张
	async save(name, data, quiet) {
		const vault = this.app.vault;
		const folder = (this.settings.exportFolder || "").trim();
		let file;
		if (folder) {
			const dir = normalizePath(folder);
			if (!vault.getAbstractFileByPath(dir)) await vault.createFolder(dir);
			file = vault.getAbstractFileByPath(normalizePath(dir + "/" + name));
		} else {
			file = this.app.metadataCache.getFirstLinkpathDest(name, "");
		}
		if (file) {
			await vault.modifyBinary(file, data);
		} else {
			const target = folder ? normalizePath(folder + "/" + name) : await this.app.fileManager.getAvailablePathForAttachment(name);
			file = await vault.createBinary(target, data);
		}
		if (!quiet) new Notice(this.t().saved + file.path);
		return file;
	}

	async exportImage(date, quiet) {
		try {
			const ext = this.settings.exportFormat === "png" ? "png" : "webp";
			const data = await (await this.image(date, "image/" + ext)).arrayBuffer();
			return await this.save(`${this.t().fileName}-${ymd(date)}.${ext}`, data, quiet);
		} catch (e) {
			console.error("[token-receipt]", e);
			new Notice(this.t().saveFailed + e.message);
			return null;
		}
	}

	// 放大看：先存成图片，再用 Obsidian 自带的图片查看器在新标签页里打开
	async openInViewer(date) {
		const file = await this.exportImage(date, true);
		if (file) await this.app.workspace.getLeaf("tab").openFile(file);
	}

	// 动画 SVG：入场动效循环播放，嵌进笔记或网页里会动
	async exportSvg(date) {
		try {
			const { svg } = await this.build(date, "loop");
			return await this.save(`${this.t().fileName}-${ymd(date)}.svg`, new TextEncoder().encode(svg).buffer);
		} catch (e) {
			console.error("[token-receipt]", e);
			new Notice(this.t().saveFailed + e.message);
			return null;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof ReceiptView) leaf.view.refresh(true);
		}
	}
}

class TokenReceiptSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		const s = this.plugin.settings;
		containerEl.empty();

		const T = this.plugin.t();
		const textSetting = (label, key, placeholder) => new Setting(containerEl).setName(label[0]).setDesc(label[1]).addText((t) => t
			.setPlaceholder(placeholder || "")
			.setValue(String(s[key]))
			.onChange(async (v) => { s[key] = v.trim(); await this.plugin.saveSettings(); }));

		textSetting(T.sTitle, "title", T.title);
		new Setting(containerEl).setName(T.sLang[0]).setDesc(T.sLang[1]).addDropdown((d) => d
			.addOptions({ auto: T.langAuto, zh: "中文", en: "English" })
			.setValue(s.language)
			.onChange(async (v) => { s.language = v; await this.plugin.saveSettings(); this.display(); }));
		new Setting(containerEl).setName(T.sScene[0]).setDesc(T.sScene[1]).addDropdown((d) => {
			for (const k of SCENE_ORDER) d.addOption(k, T.scenes[k]);
			d.setValue(s.scene).onChange(async (v) => { s.scene = v; await this.plugin.saveSettings(); });
		});
		new Setting(containerEl).setName(T.sHost[0]).setDesc(T.sHost[1]).addToggle((t) => t
			.setValue(s.showHost)
			.onChange(async (v) => { s.showHost = v; await this.plugin.saveSettings(); }));
		textSetting(T.sClaude, "claudeDir", DEFAULT_SETTINGS.claudeDir);
		textSetting(T.sCodex, "codexDir", DEFAULT_SETTINGS.codexDir);
		textSetting(T.sWb, "workbuddyDir", DEFAULT_SETTINGS.workbuddyDir);
		textSetting(T.sMagpie, "magpieDir", DEFAULT_SETTINGS.magpieDir);
		textSetting(T.sFolder, "exportFolder", T.folderHint);

		new Setting(containerEl).setName(T.sFormat[0]).setDesc(T.sFormat[1]).addDropdown((d) => d
			.addOptions({ webp: "WebP", png: "PNG" })
			.setValue(s.exportFormat)
			.onChange(async (v) => { s.exportFormat = v; await this.plugin.saveSettings(); }));
		new Setting(containerEl).setName(T.sScale[0]).setDesc(T.sScale[1]).addDropdown((d) => d
			.addOptions({ 2: T.scale(2), 3: T.scale(3), 4: T.scale(4) })
			.setValue(String(s.exportScale))
			.onChange(async (v) => { s.exportScale = Number(v); await this.plugin.saveSettings(); }));

		let area;
		new Setting(containerEl)
			.setName(T.sPrices[0])
			.setDesc(T.sPrices[1])
			.addButton((b) => b.setButtonText(T.reset).onClick(async () => {
				s.prices = JSON.parse(JSON.stringify(DEFAULT_PRICES));
				area.setValue(JSON.stringify(s.prices, null, 2));
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl).setClass("token-receipt-prices").addTextArea((t) => {
			area = t;
			t.setValue(JSON.stringify(s.prices, null, 2)).onChange(async (v) => {
				let parsed;
				try { parsed = JSON.parse(v); } catch (e) { t.inputEl.addClass("is-invalid"); return; }
				t.inputEl.removeClass("is-invalid");
				s.prices = parsed;
				await this.plugin.saveSettings();
			});
		});
	}
}

module.exports = TokenReceiptPlugin;
module.exports.core = { Ledger, summarize, renderReceipt, parseClaudeLine, parseWorkBuddyLine, codexParser, parseMagpieLine, magpieExtras, hostInfo, dayStart, DEFAULT_SETTINGS, SCENE_ORDER };
