/**
 * 对话流 HTML 底座：从正文中切出 ```html 代码块 / 整页文档 / 顶层标准容器块，供 Messages 渲染。
 * 卡皮肤产物（div 等）在此切成 html 段进无痕帧；自定义状态标签不在此列。
 *
 * 整页界面卡(如 某卡 开局正则)：替换结果是「``` + 完整 HTML 文档 + ```」，
 * 文档内可能含大量 ``` 字符——必须用「首开 + 末闭」认领，禁止非贪婪中途截断再被 splitTopLevel 撕碎。
 */

export type TextPart =
	| { kind: "text"; text: string }
	| { kind: "html"; html: string; /** 围栏标记 scripts / +js 时为 true */ scripts: boolean };

/** 标准容器标签白名单:皮肤/界面产物以它们开头;自定义标签(状态栏族)绝不在此列 */
const BLOCK_TAGS = /^(div|section|article|table|figure|details|style)$/i;

/** 文档内是否含可执行脚本（决定 HtmlFrame scripts 沙箱） */
export function htmlLooksInteractive(html: string): boolean {
	return /<script[\s>]/i.test(html) || /\bon[a-z]+\s*=/i.test(html);
}

/**
 * body 是否为「恰好一份」完整 HTML 文档（末尾 </html> 后仅空白）。
 * 多状态栏会连续产出多份 ```html …</html>```；若用末闭会把它们捏成单帧。
 * 程序卡单文档内若含行首 ```，通常在真 </html> 之前，不会误判为单文档。
 */
function bodyIsSingleCompleteDoc(body: string): boolean {
	const re = /<\/html\s*>/gi;
	let m: RegExpExecArray | null;
	let count = 0;
	let lastEnd = -1;
	while ((m = re.exec(body)) !== null) {
		count++;
		lastEnd = m.index + m[0].length;
	}
	if (count === 1) return body.slice(lastEnd).trim() === "";
	if (count === 0) {
		// 无 doctype 的大块 UI 根：首个合法闭合即可
		return body.length >= 200 && /<\/(div|section|body)>/i.test(body);
	}
	return false;
}

/**
 * 从文本中定位「围栏包裹的 HTML 文档/大界面」（卡显示正则常见产物）。
 *
 * 梨园开场白会加前缀「【开场 · 卡名】\n」+ 占位符，皮肤替换后变成：
 *   【开场 · …】\n```\n<!doctype html>…</html>\n```
 * 因此不能要求整段以 ``` 开头；在文中找行首围栏即可。
 *
 * 闭合策略：
 * 1) **优先** 首个「恰好一份完整文档」的行首 ```（多 state/options 各进独立帧）
 * 2) 否则回退 **末闭**（单文档内含行首 ``` 时避免提前截断）
 * 后续围栏由 splitHtmlParts 递归认领。
 */
export function findFencedHtmlDocument(
	text: string,
): { html: string; scripts: boolean; start: number; end: number } | null {
	if (!text) return null;
	const openRe = /(^|\n)(```([^\n`]*)\r?\n)/g;
	let om: RegExpExecArray | null;
	while ((om = openRe.exec(text)) !== null) {
		const fenceStart = om.index + om[1].length;
		const openTok = om[2];
		const lang = (om[3] ?? "").trim();
		if (lang && !/^html\b/i.test(lang) && !/^(?:html\s*\+?\s*(?:scripts?|js))$/i.test(lang)) {
			continue;
		}
		const contentStart = fenceStart + openTok.length;
		const probe = text.slice(contentStart, contentStart + 80).trimStart().toLowerCase();
		if (!probe.startsWith("<!doctype html") && !probe.startsWith("<html")) {
			// 大块 UI 根（无 doctype 的界面片段）
			if (!/^<(div|section|article|main|body)\b/i.test(probe) || text.length < 200) {
				continue;
			}
		}
		const rest = text.slice(contentStart);
		// 收集合法闭合：优先单文档首闭，否则末闭
		const closeRe = /\r?\n```[ \t]*(?=\r?\n|$)/g;
		let cm: RegExpExecArray | null;
		let firstSingleClose = -1;
		let firstSingleEnd = -1;
		let lastClose = -1;
		let lastEnd = -1;
		while ((cm = closeRe.exec(rest)) !== null) {
			const body = rest.slice(0, cm.index);
			if (!/<\/html\s*>/i.test(body) && !(body.length >= 200 && /<\/(div|section|body)>/i.test(body))) {
				continue;
			}
			lastClose = cm.index;
			lastEnd = cm.index + cm[0].length;
			if (firstSingleClose < 0 && bodyIsSingleCompleteDoc(body)) {
				firstSingleClose = cm.index;
				firstSingleEnd = cm.index + cm[0].length;
			}
		}
		const bestClose = firstSingleClose >= 0 ? firstSingleClose : lastClose;
		const bestEnd = firstSingleClose >= 0 ? firstSingleEnd : lastEnd;
		if (bestClose < 0) continue;
		const html = rest.slice(0, bestClose).replace(/^\uFEFF/, "").trim();
		if (!html) continue;
		const isDoc = looksLikeHtmlDocument(html);
		const isUiRoot = /^<(div|section|article|main|body)\b/i.test(html) && html.length >= 200;
		if (!isDoc && !isUiRoot) continue;
		const scripts = htmlLooksInteractive(html) || /\bscripts?\b|\bjs\b|\+/i.test(lang);
		return {
			html,
			scripts,
			start: fenceStart,
			end: contentStart + bestEnd,
		};
	}
	return null;
}

/** 整段 trim 后恰为围栏 HTML 文档时返回（兼容旧调用） */
export function claimFencedHtmlDocument(text: string): { html: string; scripts: boolean } | null {
	const t = text.trim();
	const found = findFencedHtmlDocument(t);
	if (!found) return null;
	// 整段认领：前缀/后缀仅空白
	const pre = t.slice(0, found.start).trim();
	const post = t.slice(found.end).trim();
	if (pre || post) return null;
	return { html: found.html, scripts: found.scripts };
}

/** 在纯文本段中切出行首起始、深度配平的标准 HTML 块 */
function splitTopLevelBlocks(text: string): TextPart[] {
	const openRe = /^[ \t]*<(\w+)(\s[^>]*)?>/gm;
	const parts: TextPart[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = openRe.exec(text)) !== null) {
		const tag = m[1];
		if (!BLOCK_TAGS.test(tag)) continue;
		// 从开标签起做同名深度配平
		const tagRe = new RegExp(`<(/?)${tag}(?:\\s[^>]*)?>`, "gi");
		tagRe.lastIndex = m.index;
		let depth = 0;
		let end = -1;
		let t: RegExpExecArray | null;
		while ((t = tagRe.exec(text)) !== null) {
			depth += t[1] ? -1 : 1;
			if (depth === 0) {
				end = t.index + t[0].length;
				break;
			}
		}
		if (end < 0) continue; // 未闭合:整段留作文本
		const before = text.slice(last, m.index);
		if (before.trim()) parts.push({ kind: "text", text: before });
		parts.push({ kind: "html", html: text.slice(m.index, end).trim(), scripts: false });
		last = end;
		openRe.lastIndex = end;
	}
	if (parts.length === 0) return [{ kind: "text", text }];
	const rest = text.slice(last);
	if (rest.trim()) parts.push({ kind: "text", text: rest });
	return parts;
}

/**
 * 拆分：```html ... ``` / ```html scripts ... ``` / ```html+js ... ```
 * 未闭合的围栏当普通文本。随后对 text 段再扫行首标准容器块。
 *
 * 优先：围栏 HTML 文档（卡开局 / 多状态栏）整段认领；**连续多份各自成段**，
 * 禁止把 state1+state2+options 捏进同一 html（见 findFencedHtmlDocument 首闭策略）。
 */
export function splitHtmlParts(text: string): TextPart[] {
	if (!text) return [];
	// 文中/整段围栏 HTML 文档（开场前缀 + 开局正则 / 多状态栏产物）
	const found = findFencedHtmlDocument(text);
	if (found) {
		const parts: TextPart[] = [];
		const pre = text.slice(0, found.start);
		if (pre.trim()) parts.push(...splitTopLevelBlocks(pre));
		parts.push({ kind: "html", html: found.html, scripts: found.scripts });
		const post = text.slice(found.end);
		// 后缀可能还有下一份 ```html 文档（LWS 多 state + options）
		if (post.trim()) parts.push(...splitHtmlParts(post));
		return parts;
	}
	// 整段裸 HTML 文档
	if (looksLikeHtmlDocument(text.trim())) {
		const html = text.trim();
		return [{ kind: "html", html, scripts: htmlLooksInteractive(html) }];
	}
	// lang: html | html scripts | html+js | html+script（短片段，非贪婪；大文档应已被 claimFenced 吃掉）
	const re = /```html(?:\s*\+?\s*(?:scripts?|js))?[ \t]*\r?\n([\s\S]*?)```/gi;
	const parts: TextPart[] = [];
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		if (m.index > last) {
			const chunk = text.slice(last, m.index);
			if (chunk) parts.push({ kind: "text", text: chunk });
		}
		const fence = m[0].slice(0, m[0].indexOf("\n") >= 0 ? m[0].indexOf("\n") : 8);
		const html = m[1].replace(/^\uFEFF/, "").trim();
		const scripts = /\bscripts?\b|\bjs\b|\+/i.test(fence) || htmlLooksInteractive(html);
		if (html) parts.push({ kind: "html", html, scripts });
		last = m.index + m[0].length;
	}
	if (last < text.length) {
		const rest = text.slice(last);
		if (rest) parts.push({ kind: "text", text: rest });
	}
	const base = parts.length > 0 ? parts : [{ kind: "text", text } as TextPart];
	// 文本段二次扫描:行首标准容器块(皮肤产物)切成 html 段
	return base.flatMap((p) => (p.kind === "text" ? splitTopLevelBlocks(p.text) : [p]));
}

/** 粗判：整段以 doctype/html 开头的文档 */
export function looksLikeHtmlDocument(text: string): boolean {
	const t = text.trimStart().slice(0, 200).toLowerCase();
	return t.startsWith("<!doctype html") || t.startsWith("<html");
}

/**
 * 整条消息就是一个界面——整楼模式(spec §4 落位 1)。
 * 允许仅有短前缀（如【开场 · 卡名】），主体为围栏/裸 HTML 文档。
 */
export function isFullInterface(text: string): boolean {
	const found = findFencedHtmlDocument(text);
	if (found) {
		const pre = text.slice(0, found.start).trim();
		const post = text.slice(found.end).trim();
		// 前缀只允许开场标注类短文本
		if (post) return false;
		if (!pre) return true;
		return pre.length <= 80 && !pre.includes("```") && !looksLikeHtmlDocument(pre);
	}
	if (looksLikeHtmlDocument(text.trim())) return true;
	const parts = splitHtmlParts(text);
	return parts.length === 1 && parts[0].kind === "html";
}
