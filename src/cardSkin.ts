/**
 * 一档卡皮肤:在显示文本上应用卡作者的美化正则(spec §7 P1)。
 * 纯函数、无 DOM——server wire 与 web 显示管线共用。
 * 只跑显示层——送模历史在 cleanAssistantText 路径，不经此处。
 * 单条规则失败静默跳过:显示层宁可少化妆,不能白屏。
 */

import type { DisplayRule } from "./cardfront.ts";

const escapeReg = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 超过此长度视为「整页/程序卡」替换串：`$` 一律按字面，只认 {{match}} */
const LITERAL_REPLACE_THRESHOLD = 8_000;

function substMacros(text: string, macros: { charName: string; userName: string }, forRegex: boolean): string {
	const char = forRegex ? escapeReg(macros.charName) : macros.charName;
	const user = forRegex ? escapeReg(macros.userName) : macros.userName;
	return text.replace(/\{\{\s*char\s*\}\}/gi, char).replace(/\{\{\s*user\s*\}\}/gi, user);
}

/**
 * 展开捕获组 / {{match}}（短模板与长程序卡共用）。
 *
 * **不可**把模板直接交给 `String.replace(re, template)`：
 * JS 会把 `$'`（后文）、`$``（前文）当特殊序列。
 * 某程序卡的 replaceString 里有字面量 `'$'`，会被吃坏。
 *
 * 规则：
 * - 始终展开：`$$` → `$`；`$1`…`$n`（n ≤ 实际捕获组数）→ 对应捕获
 * - 长模板（≥8KB 程序卡 HTML）**不**展开 `$&`：卡内常有字面 `\$&` 片段，展开会毁掉 JS
 * - 短模板展开 `$&` → 整段命中
 * - **永不**展开 `$'` / `$``（本函数不匹配它们）
 *
 * 某卡的状态栏模板 >8KB 且依赖 `rawData = \`$2\``——若长串一律不展开 $n，
 * 会变成字面 `$2` → 状态栏空、源码泄漏。故长串也必须展开有效 $n。
 */
export function expandSkinReplacement(template: string, match: string, captures: Array<string | undefined>): string {
	const withMatch = template.replace(/\{\{\s*match\s*\}\}/gi, () => match);
	const isLong = template.length >= LITERAL_REPLACE_THRESHOLD;
	return withMatch.replace(/\$(\$|&|\d{1,2})/g, (whole, kind: string) => {
		if (kind === "$") return "$";
		if (kind === "&") {
			// 长程序卡：保留字面 $&；短模板：整段命中
			return isLong ? whole : match;
		}
		const n = Number(kind);
		// 仅当本规则真有该捕获组时才展开；否则保留字面 $1（程序卡内可能出现）
		if (n >= 1 && n <= captures.length) {
			return captures[n - 1] ?? "";
		}
		return whole;
	});
}

export function applyCardSkin(
	text: string,
	rules: DisplayRule[],
	macros: { charName: string; userName: string },
): string {
	let out = text;
	for (const r of rules) {
		try {
			const re = new RegExp(substMacros(r.source, macros, true), r.flags);
			const template = substMacros(r.replace, macros, false);
			out = out.replace(re, (match, ...args) => {
				// args: g1, g2, …, offset, input[, groupsObj]
				const last = args[args.length - 1];
				const hasNamed = typeof last === "object" && last !== null;
				const captEnd = hasNamed ? args.length - 3 : args.length - 2;
				const captures = args.slice(0, Math.max(0, captEnd)) as Array<string | undefined>;
				return expandSkinReplacement(template, match, captures);
			});
		} catch {
			// 单条坏规则不拖累整条管线
		}
	}
	return out;
}
