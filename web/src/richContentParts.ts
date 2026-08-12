/**
 * 对话流正文切分（RichContent 真路径，纯函数可测）。
 *
 * 顺序纪律（spec §7 P1 + skeptic fix）：
 * 1) 卡皮肤正则先认领 StatusBlock / 开局标记等 → 卡作者 HTML
 * 2) 整页围栏 HTML 文档整段认领（某卡 等），禁止撕碎
 * 3) 顶层标准容器 / 短 ```html 围栏切出
 * 4) 仅在剩余纯文本上再跑 splitStatusParts → 梨园统一状态卡
 *
 * **禁止二次皮肤**：wire 侧 prepareDisplayText 已应用显示正则。
 * 某卡等程序卡 HTML 内仍含占位串 `lucklyjkop`，再跑会把 2.6MB 脚本再嵌一遍 →
 * `Identifier has already been declared` → 按钮全死。
 */

import type { DisplayRule } from "../../src/cardfront.ts";
import { isHtmlDisplayPayload } from "../../src/postprocess.ts";
import { applyCardSkin } from "./cardSkin.ts";
import { findFencedHtmlDocument, looksLikeHtmlDocument, splitHtmlParts } from "./htmlEmbed.ts";
import { splitStatusParts, stripOrphanStatusTags } from "./statusBlocks.ts";

export type RichPart =
	| { kind: "text"; text: string }
	| { kind: "status"; tag: string; body: string }
	| { kind: "html"; html: string; scripts: boolean };

export type SkinMacros = { rules: DisplayRule[]; charName: string; userName: string };

function textToRichParts(text: string): RichPart[] {
	const out: RichPart[] = [];
	for (const s of splitStatusParts(text)) {
		if (s.kind === "status") {
			out.push({ kind: "status", tag: s.tag, body: s.body });
		} else if (s.text.trim()) {
			out.push({ kind: "text", text: stripOrphanStatusTags(s.text) });
		}
	}
	return out;
}

/** 正文是否已是皮肤/围栏产物（再套规则会二次替换） */
function alreadyDisplayHtml(text: string): boolean {
	if (!text) return false;
	if (isHtmlDisplayPayload(text)) return true;
	if (looksLikeHtmlDocument(text.trim())) return true;
	if (findFencedHtmlDocument(text)) return true;
	return false;
}

/**
 * 与 Messages.RichContent 同序：skin → HTML 块 → 状态标签 → 纯文本。
 * 返回可直接映射到 Paragraphs / StatusPanel / HtmlFrame 的序列。
 *
 * HTML 认领统一走 splitHtmlParts（含多份连续 ```html 文档各自成帧）。
 *
 * @param skin 仅在「原文尚未皮肤化」时使用（流式半截、或未走 wire 的本地文本）。
 *             已由 prepareDisplayText 处理过的消息务必仍可传入 skin，但会被跳过。
 */
export function splitRichContentParts(text: string, skin?: SkinMacros | null): RichPart[] {
	const needSkin = Boolean(skin && skin.rules.length > 0 && !alreadyDisplayHtml(text));
	const skinned = needSkin ? applyCardSkin(text, skin!.rules, skin!) : text;

	// 围栏整页 / 多状态栏 / 短 ```html / 顶层 div —— 全由 splitHtmlParts 认领（可递归多帧）
	const htmlClaimed = splitHtmlParts(skinned);
	const out: RichPart[] = [];
	for (const p of htmlClaimed) {
		if (p.kind === "html") {
			out.push({ kind: "html", html: p.html, scripts: p.scripts });
			continue;
		}
		out.push(...textToRichParts(p.text));
	}
	return out;
}
