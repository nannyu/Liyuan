/**
 * 角色卡常见「状态栏」标签的展示层拆分。
 *
 * 与后端 postprocess 策略对齐：**名称像状态** → 抽成面板；不维护无穷精确名单。
 * 标签本身不进正文；只抽出 body 画面板。
 */

export type StatusPart =
	| { kind: "text"; text: string }
	| { kind: "status"; tag: string; body: string };

/** 规范化标签名（小写 + 去下划线）便于匹配 */
export function normalizeStatusTag(tag: string): string {
	return tag.trim().toLowerCase().replace(/_/g, "");
}

/** 名称是否像状态栏（与 src/postprocess PANEL_NAME_RE 同思路，含 stateN 序号形） */
export function isPanelTagName(tag: string): boolean {
	const raw = tag.trim();
	const n = normalizeStatusTag(raw);
	return /^(?:status(?:block|bar)?|normalstatus|specialstatus|char(?:acter)?status|state\d+|状态|状态栏|人物状态|场景状态)$/i.test(
		n,
	) || /^(?:status(?:_?block|bar)?|normal_?status|special_?status)$/i.test(raw);
}

/** 已知标签 → 中文标题（键用 normalizeStatusTag） */
const LABEL_BY_NORM: Record<string, string> = {
	normalstatus: "场景状态",
	specialstatus: "人物状态",
	statusblock: "状态",
	status: "状态",
	statusbar: "状态",
	descriptiveanalysis: "描写分析",
	nextcharacterpanel: "角色登场",
};

/** 任意「像状态」的开标签 + 少量历史别名 */
const OPEN_RE =
	/<(StatusBlock|status_block|statusblock|status|statusbar|normal_status|special_status|NextCharacterPanel|[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.\-]*)(?:\s[^>]*)?>/gi;

function isStatusOpen(tag: string): boolean {
	const n = normalizeStatusTag(tag);
	// 历史别名：曾当面板渲染的（descriptive_analysis 已改走思维链，此处不再画面板）
	if (n === "nextcharacterpanel") return true;
	return isPanelTagName(tag);
}

/** plot 等不再当状态面板——后端已 unwrap 进正文；此处只处理 panel 族 */
function closePattern(tag: string): RegExp {
	const n = normalizeStatusTag(tag);
	if (n === "statusblock" || n === "status" || n === "statusbar") {
		return /<\/(?:StatusBlock|status_block|statusblock|status|statusbar)\s*>/i;
	}
	if (n === "normalstatus") return /<\/normal_status\s*>/i;
	if (n === "specialstatus") return /<\/special_status\s*>/i;
	return new RegExp(`</${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*>`, "i");
}

/**
 * 顺序扫描：仅状态类开标签 → 闭合 → body 进 status 段；其它标签留给正文（后端多已 unwrap）。
 */
export function splitStatusParts(text: string): StatusPart[] {
	if (!text) return [];
	const parts: StatusPart[] = [];
	let cursor = 0;
	OPEN_RE.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = OPEN_RE.exec(text)) !== null) {
		const tag = m[1];
		if (!isStatusOpen(tag)) {
			// 非状态标签：跳过这个开标签位置，继续找（避免把 <content> 当状态）
			continue;
		}
		const openStart = m.index;
		const openEnd = m.index + m[0].length;
		if (openStart > cursor) {
			const chunk = text.slice(cursor, openStart);
			if (chunk) parts.push({ kind: "text", text: stripOrphanStatusTags(chunk) });
		}

		const rest = text.slice(openEnd);
		const closeRe = closePattern(tag);
		const closeM = closeRe.exec(rest);
		let body: string;
		let nextCursor: number;

		if (closeM && closeM.index >= 0) {
			body = rest.slice(0, closeM.index);
			nextCursor = openEnd + closeM.index + closeM[0].length;
		} else {
			// 无闭合：吃到下一个状态开标签或文末
			OPEN_RE.lastIndex = openEnd;
			let nextOpen: RegExpExecArray | null = null;
			let probe: RegExpExecArray | null;
			const saved = OPEN_RE.lastIndex;
			while ((probe = OPEN_RE.exec(text)) !== null) {
				if (probe.index >= openEnd && isStatusOpen(probe[1])) {
					nextOpen = probe;
					break;
				}
			}
			OPEN_RE.lastIndex = saved;
			if (nextOpen && nextOpen.index >= openEnd) {
				body = text.slice(openEnd, nextOpen.index);
				nextCursor = nextOpen.index;
			} else {
				body = text.slice(openEnd);
				nextCursor = text.length;
			}
		}

		body = body.replace(/^\uFEFF/, "").trim();
		const norm = normalizeStatusTag(tag);
		if (body) {
			parts.push({ kind: "status", tag: norm, body });
		}
		cursor = nextCursor;
		OPEN_RE.lastIndex = cursor;
	}
	if (cursor < text.length) {
		const rest = stripOrphanStatusTags(text.slice(cursor));
		if (rest) parts.push({ kind: "text", text: rest });
	}
	return parts.length > 0 ? parts : [{ kind: "text", text: stripOrphanStatusTags(text) }];
}

/** 兜底：正文段里若还残留状态标签字样，删掉 */
export function stripOrphanStatusTags(text: string): string {
	return text
		.replace(
			/<\/?(?:StatusBlock|status_block|statusblock|status|statusbar|normal_status|special_status|state_?\d+)(?:\s[^>]*)?>/gi,
			"",
		)
		.replace(/^\s*$/gm, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function statusLabel(tag: string): string {
	const n = normalizeStatusTag(tag);
	return LABEL_BY_NORM[n] ?? "状态";
}

/** CSS 用的稳定 class 后缀 */
export function statusClassSuffix(tag: string): string {
	const n = normalizeStatusTag(tag);
	if (n === "statusblock" || n === "status" || n === "statusbar") return "statusblock";
	if (n === "specialstatus") return "special_status";
	if (n === "normalstatus") return "normal_status";
	return n || "status";
}

/**
 * 是否「整段就是一份 yaml 状态」——仅用于纯 pre 展示。
 * 含 HTML 标签、多段 markdown 围栏、summary 分节等混合体时必须 false，
 * 否则会把 <summary> 与 ``` 整坨丢进 pre 原样漏出（玄牝状态栏回归）。
 */
export function looksLikeYamlBlock(body: string): boolean {
	const t = body.trim();
	if (!t) return false;
	// 整段单一 yaml 围栏
	if (/^```ya?ml\b/i.test(t) && (t.match(/^```/gm) ?? []).length === 2) return true;
	// 混合 markdown / 标签 → 走 Paragraphs + 策略过滤
	if (/<[A-Za-z_/\u4e00-\u9fff]/.test(t)) return false;
	if (/```/.test(t)) return false;
	const lines = t.split(/\r?\n/).filter((l) => l.trim());
	if (lines.length < 2) return false;
	const kv = lines.filter((l) => /[:：]/.test(l)).length;
	return kv >= Math.ceil(lines.length * 0.5);
}

export function stripYamlFence(body: string): string {
	const t = body.trim();
	const m = /^```ya?ml\s*\r?\n([\s\S]*?)```\s*$/i.exec(t);
	return m ? m[1].trim() : t;
}
