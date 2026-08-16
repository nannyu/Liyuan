/**
 * 对话流轻量 markdown 切分（纯函数，可 node:test）。
 *
 * 不全量 CommonMark：只做与酒馆观感对齐、纯预设消息可读所需的子集。
 * - 围栏代码块 ``` / ```lang … ```
 * - GFM 管道表格（预设「角色表」等——纯预设会话裸奔主凶之一）
 * - 字母选项列表 A. B. C.（预设「他人推动」等，连续升序 ≥3 项才认，防误伤正文）
 * - 行内：**粗体** / *动作斜体* / 对白着色（splitRpInline，Messages.renderRp 消费）
 *
 * Options 等标签在服务端 unwrap 后常留下无 lang 围栏；此处收成代码块，
 * 围栏字符本身不显示，块有独立底色与正文区分。
 */

export type MdPart =
	| { kind: "text"; text: string }
	| { kind: "code"; lang: string; code: string }
	| { kind: "table"; header: string[]; rows: string[][] }
	| { kind: "blockquote"; lines: string[] }
	| { kind: "options"; items: { key: string; text: string }[] };

/** 管道行 → 单元格（去首尾空管道；不处理转义 \| ——预设表格不用它） */
function splitCells(line: string): string[] {
	let t = line.trim();
	if (t.startsWith("|")) t = t.slice(1);
	if (t.endsWith("|")) t = t.slice(0, -1);
	return t.split("|").map((c) => c.trim());
}

/** 是否表头分隔行：| --- | :---: | …（至少一个 -，只含 - : | 空格） */
function isTableSeparator(line: string): boolean {
	const t = line.trim();
	if (!/^\|?[\s:|-]+\|?$/.test(t)) return false;
	if (!t.includes("-")) return false;
	// 每格都必须是 :?-+:? 形态
	return splitCells(t).every((c) => /^:?-+:?$/.test(c) && c.length > 0);
}

/** 选项行：A. / A、 / A．开头（半角句点/顿号/全角句点），键为单个大写字母 */
const OPTION_LINE_RE = /^\s*([A-Z])[.、．]\s*(\S.*)$/;

type LineRun =
	| { kind: "table"; start: number; end: number; header: string[]; rows: string[][] }
	| { kind: "blockquote"; start: number; end: number; lines: string[] }
	| { kind: "options"; start: number; end: number; items: { key: string; text: string }[] };

/** 行首 `>`（允许缩进与紧跟一个空格）——markdown 引用块 */
const QUOTE_LINE_RE = /^[ \t]{0,3}>[ \t]?/;

/** 在行数组里找下一个表格/选项块（从 from 行起）；找不到返回 null */
function findNextRun(lines: string[], from: number): LineRun | null {
	for (let i = from; i < lines.length; i++) {
		// 表格：本行含 | 且下一行是分隔行，且列数一致（≥2 列才算表，单列多是竖线装饰）
		if (i + 1 < lines.length && lines[i].includes("|") && isTableSeparator(lines[i + 1])) {
			const header = splitCells(lines[i]);
			const sepCols = splitCells(lines[i + 1]).length;
			if (header.length >= 2 && header.length === sepCols) {
				const rows: string[][] = [];
				let j = i + 2;
				while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
					const cells = splitCells(lines[j]);
					// 列数容错：截断/补空对齐表头
					rows.push(header.map((_, k) => cells[k] ?? ""));
					j++;
				}
				return { kind: "table", start: i, end: j, header, rows };
			}
		}
		// 选项列表：从 A 起严格升序，允许项间单空行，≥3 项
		const m = OPTION_LINE_RE.exec(lines[i]);
		if (m && m[1] === "A") {
			const items: { key: string; text: string }[] = [];
			let j = i;
			let expect = 65; // "A"
			while (j < lines.length) {
				const line = lines[j];
				if (line.trim() === "") {
					// 允许一个空行分组（截图形态：D 与 E 之间空行）；连续空行或其后非选项则止
					const nm = j + 1 < lines.length ? OPTION_LINE_RE.exec(lines[j + 1]) : null;
					if (nm && nm[1].charCodeAt(0) === expect) {
						j++;
						continue;
					}
					break;
				}
				const om = OPTION_LINE_RE.exec(line);
				if (!om || om[1].charCodeAt(0) !== expect) break;
				items.push({ key: om[1], text: om[2].trim() });
				expect++;
				j++;
			}
			if (items.length >= 3) {
				return { kind: "options", start: i, end: j, items };
			}
		}
		// 引用块：连续的行首 `>`（放在表格/选项之后判，两者的既有行为逐字不变）。
		// 作者用它写「导演附录」这类旁注；不支持时 `>` 会当字面文本上屏、每行还各成一段（酒馆是一个引用框）。
		if (QUOTE_LINE_RE.test(lines[i])) {
			const quoted: string[] = [];
			let j = i;
			while (j < lines.length && QUOTE_LINE_RE.test(lines[j])) {
				quoted.push(lines[j].replace(QUOTE_LINE_RE, ""));
				j++;
			}
			return { kind: "blockquote", start: i, end: j, lines: quoted };
		}
	}
	return null;
}

/** 在纯文本段内切出表格/选项块（供 splitMarkdownParts 的 text 段二次细分） */
export function splitTextRuns(text: string): MdPart[] {
	if (!text) return [];
	const lines = text.split("\n");
	const out: MdPart[] = [];
	let cursor = 0;
	for (;;) {
		const run = findNextRun(lines, cursor);
		if (!run) break;
		if (run.start > cursor) {
			const chunk = lines.slice(cursor, run.start).join("\n");
			if (chunk.trim()) out.push({ kind: "text", text: chunk });
		}
		if (run.kind === "table") {
			out.push({ kind: "table", header: run.header, rows: run.rows });
		} else if (run.kind === "blockquote") {
			out.push({ kind: "blockquote", lines: run.lines });
		} else {
			out.push({ kind: "options", items: run.items });
		}
		cursor = run.end;
	}
	if (cursor < lines.length) {
		const rest = lines.slice(cursor).join("\n");
		if (rest.trim()) out.push({ kind: "text", text: rest });
	}
	return out.length > 0 ? out : [{ kind: "text", text }];
}

/**
 * 切出 markdown 围栏代码块；未闭合围栏当普通文本。
 * 仅认行首 ```（起点为 0 或前一字符为换行）。
 * 围栏外的文本段再细分表格/选项块。
 */
export function splitMarkdownParts(text: string): MdPart[] {
	if (!text) return [];
	const re = /```([^\n`]*)\r?\n([\s\S]*?)\r?\n```[ \t]*/g;
	const parts: MdPart[] = [];
	const pushText = (t: string) => {
		if (t) parts.push(...splitTextRuns(t));
	};
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text)) !== null) {
		// 行首约束
		if (m.index > 0 && text[m.index - 1] !== "\n") {
			continue;
		}
		if (m.index > last) {
			pushText(text.slice(last, m.index));
		}
		parts.push({
			kind: "code",
			lang: (m[1] ?? "").trim(),
			code: (m[2] ?? "").replace(/\s+$/g, ""),
		});
		last = m.index + m[0].length;
		// 闭合后多余换行并入下一段起点，避免代码块后多一空段
		if (text[last] === "\r" && text[last + 1] === "\n") last += 2;
		else if (text[last] === "\n") last += 1;
		re.lastIndex = last;
	}
	if (last < text.length) {
		pushText(text.slice(last));
	}
	return parts.length > 0 ? parts : [{ kind: "text", text }];
}

export type InlineToken =
	| { kind: "plain"; text: string }
	| { kind: "strong"; text: string }
	| { kind: "em"; text: string }
	| { kind: "quote"; text: string };

/**
 * 行内 RP/markdown 标记：**粗体**（吃掉星号）、*动作*（吃掉星号转斜体）、
 * "对白"/“对白”/「对白」（保留引号着色）。纯函数供 Messages.renderRp 与测试。
 */
export function splitRpInline(line: string): InlineToken[] {
	const parts = line.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*|"[^"\n]+"|“[^”\n]+”|「[^」\n]+」)/g);
	const out: InlineToken[] = [];
	for (const p of parts) {
		if (!p) continue;
		if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
			out.push({ kind: "strong", text: p.slice(2, -2) });
		} else if (p.startsWith("*") && p.endsWith("*") && p.length > 2) {
			out.push({ kind: "em", text: p.slice(1, -1) });
		} else if (/^["“「]/.test(p)) {
			out.push({ kind: "quote", text: p });
		} else {
			out.push({ kind: "plain", text: p });
		}
	}
	return out;
}
