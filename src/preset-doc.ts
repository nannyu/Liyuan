/**
 * 预设文档层 —— 磁盘上存什么、UI 看到什么、开关写回哪里。
 *
 * 定案（docs/PLAN-PRESET-PIPELINES.md §四之一）：**落盘即原文**。用户从酒馆导出的那份
 * JSON 原样存进 `assets/presets/`，导入不转换、不分拣、不判断。要什么信息，读的时候投影。
 *
 * 三条规矩：
 * 1. **原文只增删被点名的字节**：改开关只动 `prompt_order[].enabled`，改内容只动
 *    `prompts[].content`，其余键原样透传——包括梨园根本不认识的键。
 * 2. **预设名＝文件名**。酒馆预设本身没有 `name` 字段（45 个顶层键里没有），
 *    名字在酒馆就是文件名；梨园不往原文里塞私有键，重命名＝重命名文件。
 * 3. **旧梨园格式继续能读**（v1.4.1 及以前导入的 `{name, samplers, blocks}`）：
 *    走降级路径，marker 归位不可用——重新导入原始预设即可恢复。
 */

import {
	type AssemblyEntry,
	type PieceRole,
	pickPromptOrderIndex,
	rpEntries,
	stEntries,
} from "./preset-assemble.ts";
import { normalizeRpPreset, SAMPLER_KEYS } from "./preset.ts";

export type PresetKind = "st" | "rp";

export interface PresetDoc {
	kind: PresetKind;
	/** 预设名＝文件名（不来自文件内容） */
	name: string;
	samplers: Record<string, number>;
	/** 原始文件内容，原样持有；写回基于它改 */
	raw: Record<string, unknown>;
	/** 装配用归一条目（含 marker），顺序即 prompt_order */
	entries: AssemblyEntry[];
}

/** 给 UI / 助手工具看的块视图。`channel` 是**派生只读值**，不是可选属性 */
export interface PresetBlockView {
	id: string;
	name: string;
	role: PieceRole;
	enabled: boolean;
	/** 酒馆内置槽位（Chat History / Char Description …）：占位，不可编辑内容 */
	marker: boolean;
	/** 派生：相对 chatHistory 槽位的前后（酒馆里这是位置，不是属性） */
	channel: "system" | "postHistory";
	/** in-chat 深度注入才有 */
	depth?: number;
	chars: number;
	content?: string;
}

export interface PresetBlockPatch {
	id: string;
	enabled?: boolean;
	name?: string;
	content?: string;
	/** 从预设里整块移除（prompts 与 prompt_order 同时摘掉）——8/12 用户点名保留的能力 */
	remove?: boolean;
}

export interface PresetPatch {
	samplers?: Record<string, number>;
	blocks?: PresetBlockPatch[];
}

const isStRaw = (raw: Record<string, unknown>): boolean =>
	Array.isArray(raw.prompts) || Array.isArray(raw.prompt_order);

function stSamplers(raw: Record<string, unknown>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const key of SAMPLER_KEYS) {
		const v = raw[key];
		if (typeof v === "number" && Number.isFinite(v)) out[key] = v;
	}
	return out;
}

/** 读一份预设文件：原文持有 + 归一条目投影。`name` 由调用方按文件名给 */
export function loadPresetDoc(raw: unknown, name: string): PresetDoc {
	const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
	if (isStRaw(obj)) {
		return { kind: "st", name, samplers: stSamplers(obj), raw: obj, entries: stEntries(obj) };
	}
	const rp = normalizeRpPreset(obj);
	return { kind: "rp", name, samplers: rp.samplers, raw: obj, entries: rpEntries(rp) };
}

/** 归一条目 → UI 视图（channel 由 chatHistory 槽位现场派生） */
export function presetDocView(doc: PresetDoc, opts: { full?: boolean } = {}): PresetBlockView[] {
	const out: PresetBlockView[] = [];
	let afterHistory = false;
	for (const e of doc.entries) {
		if (e.marker && e.identifier === "chatHistory") {
			// chatHistory 本身也列出来：它在酒馆里是可见可拖动的条目，是"历史插在哪"的声明
			out.push({
				id: e.identifier,
				name: e.name,
				role: e.role,
				enabled: e.enabled,
				marker: true,
				channel: afterHistory ? "postHistory" : "system",
				chars: 0,
				...(opts.full ? { content: "" } : {}),
			});
			afterHistory = true;
			continue;
		}
		out.push({
			id: e.identifier,
			name: e.name,
			role: e.role,
			enabled: e.enabled,
			marker: e.marker,
			channel: afterHistory ? "postHistory" : "system",
			...(e.injectionPosition === 1 ? { depth: e.injectionDepth } : {}),
			chars: e.content.length,
			...(opts.full ? { content: e.content } : {}),
		});
	}
	return out;
}

/**
 * 把补丁写回**原文**，返回新的原始 JSON（不改入参）。
 * 只动被点名的字段：开关落 `prompt_order[].enabled`，名字/内容落 `prompts[]`，其余原样。
 */
export function patchPresetRaw(doc: PresetDoc, patch: PresetPatch): Record<string, unknown> {
	const next = structuredClone(doc.raw) as Record<string, unknown>;
	const byId = new Map((patch.blocks ?? []).map((p) => [p.id, p]));
	const removed = new Set((patch.blocks ?? []).filter((p) => p.remove).map((p) => p.id));

	if (doc.kind === "st") {
		// 开关：写进装配时选中的那一份 order（选序规则与 stEntries 同源）
		const orderIdx = pickPromptOrderIndex(next);
		if (orderIdx >= 0) {
			const chosen = (next.prompt_order as Record<string, unknown>[])[orderIdx];
			const order = (chosen?.order ?? []) as Record<string, unknown>[];
			for (const o of order) {
				const p = typeof o.identifier === "string" ? byId.get(o.identifier) : undefined;
				if (p && typeof p.enabled === "boolean") o.enabled = p.enabled;
			}
			if (removed.size > 0 && chosen) {
				chosen.order = order.filter((o) => !(typeof o.identifier === "string" && removed.has(o.identifier)));
			}
		}
		const prompts = (Array.isArray(next.prompts) ? next.prompts : []) as Record<string, unknown>[];
		for (const def of prompts) {
			const p = typeof def.identifier === "string" ? byId.get(def.identifier) : undefined;
			if (!p) continue;
			if (typeof p.name === "string" && p.name.trim()) def.name = p.name.trim();
			if (typeof p.content === "string") def.content = p.content;
			// 没有 prompt_order 时，开关只能落在 prompts[].enabled 上
			if (orderIdx < 0 && typeof p.enabled === "boolean") def.enabled = p.enabled;
		}
		if (removed.size > 0) {
			next.prompts = prompts.filter((d) => !(typeof d.identifier === "string" && removed.has(d.identifier)));
		}
		if (patch.samplers) {
			for (const key of SAMPLER_KEYS) {
				const v = patch.samplers[key];
				if (typeof v === "number" && Number.isFinite(v)) next[key] = v;
			}
		}
		return next;
	}

	// 旧梨园格式：原样落回 blocks
	const blocks = (Array.isArray(next.blocks) ? next.blocks : []) as Record<string, unknown>[];
	for (const b of blocks) {
		const p = typeof b.id === "string" ? byId.get(b.id) : undefined;
		if (!p) continue;
		if (typeof p.enabled === "boolean") b.enabled = p.enabled;
		if (typeof p.name === "string" && p.name.trim()) b.name = p.name.trim();
		if (typeof p.content === "string") b.content = p.content;
	}
	next.blocks = removed.size > 0 ? blocks.filter((b) => !(typeof b.id === "string" && removed.has(b.id))) : blocks;
	if (patch.samplers) {
		const s: Record<string, number> = {};
		for (const [k, v] of Object.entries(patch.samplers)) {
			if (typeof v === "number" && Number.isFinite(v)) s[k] = v;
		}
		next.samplers = s;
	}
	return next;
}

/** 取单块全文（含 marker 槽位——它没有内容，返回空串） */
export function presetDocBlock(doc: PresetDoc, id: string): PresetBlockView | null {
	return presetDocView(doc, { full: true }).find((b) => b.id === id) ?? null;
}
