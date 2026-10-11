// Token 小票
//   把某一天 Claude Code 和 WorkBuddy 用掉的 token 排成一张购物小票（SVG），可以复制成图片、存成 PNG 放进库里
//   取数：直接读本机的会话记录，不联网
//     · Claude Code：~/.claude/projects 下的 *.jsonl，取每条 assistant 消息的 message.usage；
//                    同一条回复会写成好几行，按 message.id + requestId 去重
//     · WorkBuddy：~/.workbuddy/projects 下的 *.jsonl，取每次请求的 providerData.rawUsage
//   金额：Claude 按 API 标价折算（订阅用户并非实付），价目表在设置里可改；WorkBuddy 只列 token
//   订阅：会话记录里有「额度用满」的提示和重置时间，小票上列出当天用满了几次；填了月费就按当月天数摊出当天实付
//   一天按本机时区的 0 点到 24 点算；界面和小票跟 Obsidian 的语言走（中文 / 英文），也可以在设置里指定
//   命令：打开 Token 小票 / 把今天的小票存成 PNG / 把今天的小票插入到光标处（快捷键自己绑）
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
};

const DEFAULT_SETTINGS = {
	claudeDir: "~/.claude/projects",
	workbuddyDir: "~/.workbuddy/projects",
	title: "",
	language: "auto",
	monthlyFee: 0,
	exportFolder: "",
	exportScale: 3,
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
		total: "合计 TOKEN", claudeAt: "Claude 折算", covered: "订阅抵扣", paid: "订阅实付",
		note: "金额按 API 标价折算，订阅用户并非实付",
		noteFee: (fee, days) => `折算按 API 标价；实付按月费 ${fee} ÷ ${days} 天摊到当天`,
		noteUnpriced: "标「—」的模型不在价目表里，没有计入金额",
		thanks: "谢谢惠顾 · THANK YOU",
		prev: "前一天", next: "后一天", today: "回到今天", refresh: "重新统计", copy: "复制成图片", save: "存成 PNG 放进库里",
		counting: "正在统计…", failed: "统计失败：", copied: "小票已复制成图片", copyFailed: "复制失败：", saved: "小票已存到 ", saveFailed: "导出失败：",
		renderFailed: "小票图片渲染失败", fileName: "Token小票",
		cmdOpen: "打开 Token 小票", cmdExport: "把今天的小票存成 PNG", cmdInsert: "把今天的小票插入到光标处",
		sTitle: ["小票抬头", "印在小票最上面的那行大字，留空用默认的。"],
		sLang: ["小票语言", "界面和小票用哪种语言。命令名称重启后生效。"], langAuto: "跟随 Obsidian",
		sFee: ["订阅月费（美元）", "填了就在小票上按当月天数摊出当天的订阅实付，并列出比 API 标价省了多少。填 0 不显示。"],
		sClaude: ["Claude Code 会话目录", "Claude Code 存会话记录的地方，~ 代表用户目录。"],
		sWb: ["WorkBuddy 会话目录", "WorkBuddy 存会话记录的地方。这个目录不存在时，小票上不出现 WorkBuddy 这一栏。"],
		sFolder: ["PNG 存到哪个文件夹", "留空就跟「文件与链接」里的附件位置走。"], folderHint: "例如 assets/小票",
		sScale: ["PNG 清晰度", "导出图片相对小票原始尺寸的倍数，3 倍适合发图和贴进笔记。"], scale: (n) => `${n} 倍`,
		sPrices: ["Claude 价目表", "美元 / 百万 token。in 输入、out 输出、read 缓存读；缓存写按输入价的 1.25 倍（5 分钟）和 2 倍（1 小时）算；fast 是快速模式的倍数。模型名按前缀匹配，不在表里的模型只列 token。"],
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
		total: "TOTAL TOKENS", claudeAt: "Claude at API rates", covered: "Covered by plan", paid: "You paid",
		note: "Amounts are API list prices, not what a plan costs",
		noteFee: (fee, days) => `API list prices; paid = ${fee} plan ÷ ${days} days`,
		noteUnpriced: "Models marked — are not in the price table",
		thanks: "THANK YOU · COME AGAIN",
		prev: "Previous day", next: "Next day", today: "Back to today", refresh: "Recount", copy: "Copy as image", save: "Save as PNG in the vault",
		counting: "Counting…", failed: "Could not count: ", copied: "Receipt copied as an image", copyFailed: "Could not copy: ", saved: "Receipt saved to ", saveFailed: "Could not save: ",
		renderFailed: "Could not render the receipt image", fileName: "Token receipt",
		cmdOpen: "Open receipt", cmdExport: "Save today's receipt as PNG", cmdInsert: "Insert today's receipt at the cursor",
		sTitle: ["Receipt title", "The big line at the top of the receipt. Leave empty for the default."],
		sLang: ["Receipt language", "Language of the interface and the receipt. Command names change after a restart."], langAuto: "Same as Obsidian",
		sFee: ["Monthly plan fee (USD)", "When set, the receipt shows what the day cost you on your plan (the fee divided by the days in the month) and how much that saves against API prices. 0 hides it."],
		sClaude: ["Claude Code session folder", "Where Claude Code keeps its session logs. ~ is your home folder."],
		sWb: ["WorkBuddy session folder", "Where WorkBuddy keeps its session logs. When this folder does not exist, the receipt has no WorkBuddy section."],
		sFolder: ["Folder for PNG files", "Leave empty to use the attachment location from Files and links."], folderHint: "e.g. assets/receipts",
		sScale: ["PNG resolution", "Size of the saved image relative to the receipt. 3× suits sharing and notes."], scale: (n) => `${n}×`,
		sPrices: ["Claude price table", "USD per million tokens. in = input, out = output, read = cache read. Cache writes cost 1.25× input (5 minutes) or 2× input (1 hour). fast is the fast mode multiplier. Model names match by prefix; models not listed show tokens only."],
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

// 按文件的修改时间和大小缓存解析结果；某一天的账只可能在「那天 0 点之后还改过」的文件里
class Ledger {
	constructor() {
		this.cache = new Map();
	}

	async rows(dir, parse, since) {
		const files = (await walk(expand(dir))).filter((f) => f.mtimeMs >= since);
		const out = [];
		for (const f of files) {
			let c = this.cache.get(f.file);
			if (!c || c.mtimeMs !== f.mtimeMs || c.size !== f.size) {
				const rows = [];
				await eachLine(f.file, (line) => {
					const r = parse(line);
					if (r) rows.push(r);
				});
				c = { mtimeMs: f.mtimeMs, size: f.size, rows };
				this.cache.set(f.file, c);
			}
			out.push(c.rows);
		}
		return out;
	}

	async day(date, settings) {
		const start = date.getTime();
		const [claude, wb] = await Promise.all([
			this.rows(settings.claudeDir, parseClaudeLine, start),
			this.rows(settings.workbuddyDir, parseWorkBuddyLine, start),
		]);
		const sum = summarize(date, claude, wb, settings.prices);
		sum.wb.shown = fs.existsSync(expand(settings.workbuddyDir));
		return sum;
	}
}

function priceOf(model, prices) {
	if (prices[model]) return prices[model];
	let best = null;
	for (const k of Object.keys(prices)) {
		if (model.startsWith(k) && (!best || k.length > best.length)) best = k;
	}
	return best ? prices[best] : null;
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

function summarize(date, claudeFiles, wbFiles, prices) {
	const start = date.getTime();
	const M = 1e6;

	const claude = { models: [], limits: [], sessions: 0, requests: 0, tokens: 0, cost: 0, unpriced: false };
	const cm = new Map();
	const cs = new Set();
	const lm = new Map();
	for (const r of pick(claudeFiles, start)) {
		if (r.limit) {
			const type = r.limit === "five_hour" || r.limit === "seven_day" ? r.limit : "other";
			if (!lm.has(type)) lm.set(type, { type, hits: [] });
			lm.get(type).hits.push(r);
			continue;
		}
		let m = cm.get(r.model);
		if (!m) {
			m = { id: r.model, label: modelLabel(r.model), reqs: 0, tokens: 0, cost: 0, priced: !!priceOf(r.model, prices),
				in: 0, out: 0, read: 0, w5: 0, w1h: 0, cIn: 0, cOut: 0, cRead: 0, cW5: 0, cW1h: 0 };
			cm.set(r.model, m);
		}
		const p = priceOf(r.model, prices);
		const k = p ? (r.fast ? p.fast || 1 : 1) / M : 0;
		m.reqs++;
		m.in += r.in; m.out += r.out; m.read += r.read; m.w5 += r.w5; m.w1h += r.w1h;
		if (p) {
			m.cIn += r.in * p.in * k;
			m.cOut += r.out * p.out * k;
			m.cRead += r.read * (p.read != null ? p.read : p.in * 0.1) * k;
			m.cW5 += r.w5 * p.in * 1.25 * k;
			m.cW1h += r.w1h * p.in * 2 * k;
		}
		if (r.sid) cs.add(r.sid);
	}
	for (const m of cm.values()) {
		m.tokens = m.in + m.out + m.read + m.w5 + m.w1h;
		m.cost = m.cIn + m.cOut + m.cRead + m.cW5 + m.cW1h;
		claude.requests += m.reqs;
		claude.tokens += m.tokens;
		claude.cost += m.cost;
		if (!m.priced) claude.unpriced = true;
	}
	claude.models = [...cm.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens);
	claude.sessions = cs.size;
	claude.limits = ["five_hour", "seven_day", "other"].filter((k) => lm.has(k)).map((k) => {
		const l = lm.get(k);
		l.hits.sort((a, b) => a.t - b.t);
		return l;
	});

	const wb = { models: [], sessions: 0, requests: 0, tokens: 0, shown: true };
	const wm = new Map();
	const ws = new Set();
	for (const r of pick(wbFiles, start)) {
		let m = wm.get(r.model);
		if (!m) {
			m = { id: r.model, label: r.name || r.model, reqs: 0, tokens: 0, in: 0, hit: 0, out: 0 };
			wm.set(r.model, m);
		}
		m.reqs++;
		m.in += r.in; m.hit += r.hit; m.out += r.out;
		if (r.sid) ws.add(r.sid);
	}
	for (const m of wm.values()) {
		m.tokens = m.in + m.hit + m.out;
		wb.requests += m.reqs;
		wb.tokens += m.tokens;
	}
	wb.models = [...wm.values()].sort((a, b) => b.tokens - a.tokens);
	wb.sessions = ws.size;

	return { date, claude, wb, tokens: claude.tokens + wb.tokens };
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

let uid = 0;

function renderReceipt(sum, opt) {
	const W = 380, M = 22, P = 24, LH = 19, TOOTH = 10, TH = 5;
	const x0 = M, x1 = M + W, cx = M + W / 2;
	const xL = x0 + P, xR = x1 - P, xItem = xL + 12, xTok = xR - 78;
	const INK = "#26231f", DIM = "#8b867c";
	const T = I18N[opt.lang] || I18N.en;
	const id = "tr" + (++uid);
	const body = [];
	let y = M + TH;

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
	const section = (name, info) => {
		y += LH + 2;
		text(xL, name, { bold: true, size: 13.5, ls: 1 });
		text(xR, info, { anchor: "end", size: 11 });
	};
	const model = (m) => {
		y += LH + 3;
		text(xL, m.label, { bold: true });
		text(xR, T.times(num(m.reqs)), { anchor: "end", size: 11 });
	};

	// 抬头
	y += 44;
	text(cx, opt.title || T.title, { anchor: "middle", size: 24, bold: true, ls: 2 });
	y += 21;
	text(cx, T.subtitle, { anchor: "middle", size: 12, ls: 3 });
	y += 26;
	text(cx, `${ymd(sum.date)}  ${T.week[sum.date.getDay()]}`, { anchor: "middle" });
	y += LH + 2;
	const now = new Date();
	text(xL, `${T.no} #${ymd(sum.date).replace(/-/g, "")}-${String(sum.claude.requests + sum.wb.requests).padStart(4, "0")}`, { size: 11 });
	text(xR, `${T.printed} ${pad2(now.getHours())}:${pad2(now.getMinutes())}`, { anchor: "end", size: 11 });
	rule();
	y += LH - 4;
	text(xL, T.item, { size: 11 });
	text(xTok, T.tokens, { anchor: "end", size: 11 });
	text(xR, T.amount, { anchor: "end", size: 11 });
	y -= 4;
	rule();
	y -= 6;

	// Claude Code
	const c = sum.claude;
	section("CLAUDE CODE", T.sessions(num(c.sessions), num(c.requests)));
	if (!c.models.length) row(T.none, null, null, { dim: true });
	for (const m of c.models) {
		model(m);
		const amt = (v) => (m.priced ? usd(v) : "—");
		if (m.in) row(T.input, num(m.in), amt(m.cIn));
		if (m.out) row(T.output, num(m.out), amt(m.cOut));
		if (m.read) row(T.read, num(m.read), amt(m.cRead));
		if (m.w5) row(T.write5, num(m.w5), amt(m.cW5));
		if (m.w1h) row(T.write1h, num(m.w1h), amt(m.cW1h));
	}
	if (c.models.length) {
		y += 4;
		row(T.subtotal, num(c.tokens), usd(c.cost), { indent: false, bold: true });
	}
	// 订阅额度：当天用满了几次，各自几点重置
	for (const l of c.limits) {
		y += 4;
		row(T.limits[l.type], null, `× ${l.hits.length}`, { indent: false, bold: true });
		const at = l.hits.map((h) => resetLabel(h, sum.date)).filter(Boolean);
		if (at.length) {
			y += LH - 2;
			text(xItem, `${T.resets} ${at.slice(0, 5).join(" · ")}${at.length > 5 ? " …" : ""}`, { size: 11 });
		}
	}
	const w = sum.wb;
	if (w.shown) {
		rule();
		y -= 6;

		// WorkBuddy
		section("WORKBUDDY", T.sessions(num(w.sessions), num(w.requests)));
		if (!w.models.length) row(T.none, null, null, { dim: true });
		for (const m of w.models) {
			model(m);
			if (m.in) row(T.input, num(m.in));
			if (m.hit) row(T.hit, num(m.hit));
			if (m.out) row(T.output, num(m.out));
		}
		if (w.models.length) {
			y += 4;
			row(T.subtotal, num(w.tokens), T.unpricedTag, { indent: false, bold: true, amountDim: true });
		}
	}
	rule("double");

	// 合计。填了月费：按当月天数摊出当天实付，比 API 标价省下的那部分列成抵扣
	const big = { bold: true, size: 15 };
	const bigEnd = { anchor: "end", bold: true, size: 15 };
	y += LH + 4;
	text(xL, T.total, big);
	text(xR, num(sum.tokens), bigEnd);
	y += LH + 5;
	text(xL, T.claudeAt, big);
	text(xR, usd(c.cost), bigEnd);
	const fee = Number(opt.monthlyFee) || 0;
	const days = new Date(sum.date.getFullYear(), sum.date.getMonth() + 1, 0).getDate();
	if (fee > 0) {
		const paid = fee / days;
		if (c.cost > paid) {
			y += LH + 3;
			text(xL, T.covered);
			text(xR, "-" + usd(c.cost - paid), { anchor: "end" });
		}
		y += LH + 5;
		text(xL, T.paid, big);
		text(xR, usd(paid), bigEnd);
	}
	rule();
	y += LH - 4;
	text(cx, fee > 0 ? T.noteFee(usd(fee), days) : T.note, { anchor: "middle", size: 10.5, dim: true });
	if (c.unpriced) {
		y += 15;
		text(cx, T.noteUnpriced, { anchor: "middle", size: 10.5, dim: true });
	}

	// 条形码：日期 + 合计 token，只做样子，扫不出来
	const code = ymd(sum.date).replace(/-/g, "") + String(Math.round(sum.tokens)).padStart(10, "0");
	const bars = [];
	let units = 0;
	const seq = [];
	for (let i = 0; i < code.length; i++) {
		const v = code.charCodeAt(i) * 7 + i * 3;
		seq.push(1 + (v % 3), 1 + ((v >> 2) % 2), 1 + ((v >> 3) % 3), 1 + ((v >> 1) % 2));
	}
	for (const s of seq) units += s;
	const bw = 232 / units;
	let bx = cx - 116;
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

	// 纸：上下两边是锯齿撕口
	const yTop = M, yBot = y + TH;
	const n = W / TOOTH;
	let d = `M${x0} ${yTop + TH}`;
	for (let i = 0; i < n; i++) d += `L${x0 + i * TOOTH + TOOTH / 2} ${yTop}L${x0 + (i + 1) * TOOTH} ${yTop + TH}`;
	d += `L${x1} ${yBot - TH}`;
	for (let i = n; i > 0; i--) d += `L${x0 + i * TOOTH - TOOTH / 2} ${yBot}L${x0 + (i - 1) * TOOTH} ${yBot - TH}`;
	d += "Z";

	const width = W + M * 2, height = yBot + M;
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
		+ `<defs>`
		+ `<filter id="${id}s" x="-10%" y="-5%" width="120%" height="110%"><feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="#3b3526" flood-opacity=".22"/></filter>`
		+ `<linearGradient id="${id}g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#000" stop-opacity=".05"/><stop offset=".08" stop-color="#000" stop-opacity="0"/>`
		+ `<stop offset=".92" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".06"/></linearGradient>`
		+ `<clipPath id="${id}c"><path d="${d}"/></clipPath>`
		+ `</defs>`
		+ `<rect width="${width}" height="${height}" rx="12" fill="#eceae3"/>`
		+ `<path d="${d}" fill="#fcfbf6" filter="url(#${id}s)"/>`
		+ `<rect x="${x0}" y="${yTop}" width="${W}" height="${yBot - yTop}" fill="url(#${id}g)" clip-path="url(#${id}c)"/>`
		+ `<g font-family="Menlo, 'PingFang SC', 'Microsoft YaHei', monospace" fill="${INK}">${body.join("")}</g>`
		+ `</svg>`;
	return { svg, width, height };
}

async function svgToPng(svg, width, height, scale, failText) {
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
	return await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
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
		bar.createDiv("token-receipt-spacer");
		btn("refresh-cw", T.refresh, () => this.refresh());
		btn("copy", T.copy, () => this.plugin.copyImage(this.date));
		btn("image-down", T.save, () => this.plugin.exportPng(this.date));

		this.stage = root.createDiv("token-receipt-stage");
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

	async refresh(quiet) {
		const date = this.date;
		this.dateEl.value = ymd(date);
		if (!quiet) {
			this.stage.empty();
			this.stage.createDiv({ cls: "token-receipt-hint", text: this.plugin.t().counting });
		}
		try {
			const { svg } = await this.plugin.build(date);
			if (date !== this.date) return;
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
		this.ledger = new Ledger();

		const T = this.t();
		this.registerView(VIEW_TYPE, (leaf) => new ReceiptView(leaf, this));
		this.addRibbonIcon("receipt", T.name, () => this.openView());
		this.addCommand({ id: "open", name: T.cmdOpen, callback: () => this.openView() });
		this.addCommand({ id: "export-today", name: T.cmdExport, callback: () => this.exportPng(dayStart(new Date())) });
		this.addCommand({
			id: "insert-today",
			name: T.cmdInsert,
			editorCallback: async (editor) => {
				const file = await this.exportPng(dayStart(new Date()), true);
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

	async build(date) {
		const sum = await this.ledger.day(date, this.settings);
		return Object.assign({ sum }, renderReceipt(sum, { title: this.settings.title, lang: langOf(this.settings.language), monthlyFee: this.settings.monthlyFee }));
	}

	async png(date) {
		const { svg, width, height } = await this.build(date);
		return await svgToPng(svg, width, height, Number(this.settings.exportScale) || 3, this.t().renderFailed);
	}

	async copyImage(date) {
		try {
			const blob = await this.png(date);
			await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
			new Notice(this.t().copied);
		} catch (e) {
			console.error("[token-receipt]", e);
			new Notice(this.t().copyFailed + e.message);
		}
	}

	// 同一天重复导出会覆盖原来那张
	async exportPng(date, quiet) {
		try {
			const data = await (await this.png(date)).arrayBuffer();
			const vault = this.app.vault;
			const name = `${this.t().fileName}-${ymd(date)}.png`;
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
		new Setting(containerEl).setName(T.sFee[0]).setDesc(T.sFee[1]).addText((t) => t
			.setPlaceholder("0")
			.setValue(s.monthlyFee ? String(s.monthlyFee) : "")
			.onChange(async (v) => { s.monthlyFee = Math.max(0, parseFloat(v) || 0); await this.plugin.saveSettings(); }));
		textSetting(T.sClaude, "claudeDir", DEFAULT_SETTINGS.claudeDir);
		textSetting(T.sWb, "workbuddyDir", DEFAULT_SETTINGS.workbuddyDir);
		textSetting(T.sFolder, "exportFolder", T.folderHint);

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
module.exports.core = { Ledger, summarize, renderReceipt, parseClaudeLine, parseWorkBuddyLine, dayStart, DEFAULT_SETTINGS };
