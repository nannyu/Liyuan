/**
 * 旧梨园预设格式（v1.4.1 及以前）的读取面。
 *
 * 8/15 起**落盘即原文**：新导入的预设以酒馆原始 JSON 存档，装配由 src/preset-assemble.ts
 * 按酒馆自己的协议现场完成（见 docs/PLAN-PRESET-PIPELINES.md §四之一）。
 * 本文件只剩兼容读——已发布用户手里的 `{name, samplers, blocks}` 文件还要能装载。
 * 那次转换是有损的（marker 全丢、prompt_order 压平），重新导入原始预设即可恢复。
 */

export interface PresetBlock {
	/** ST identifier（保留以便追溯） */
	id: string;
	name: string;
	/** 递送通道：system prompt 区 / 每轮末端注入区（post-history） */
	channel: "system" | "postHistory";
	role: "system" | "user" | "assistant";
	content: string;
	enabled: boolean;
	/** in-chat 深度注入的原始 depth */
	depth?: number;
}

export interface RpPreset {
	name: string;
	/**
	 * 采样参数（键与 OpenAI 兼容体一致）。
	 * 文件/UI 里常驻全套；真正发请求时由 `projectSamplers` 按渠道投影（见 src/samplers.ts）。
	 */
	samplers: Record<string, number>;
	blocks: PresetBlock[];
}

/** 采样参数搬运名单（酒馆原始格式取顶层同名键，旧梨园格式取 samplers 子对象） */
export const SAMPLER_KEYS = [
	"temperature",
	"top_p",
	"top_k",
	"frequency_penalty",
	"presence_penalty",
	"repetition_penalty",
] as const;

/** 载入旧梨园格式（宽容解析） */
export function normalizeRpPreset(raw: unknown): RpPreset {
	const obj = (raw ?? {}) as Partial<RpPreset>;
	const blocks = Array.isArray(obj.blocks)
		? obj.blocks.filter(
				(b): b is PresetBlock =>
					!!b && typeof b === "object" && typeof (b as PresetBlock).content === "string",
			)
		: [];
	const samplers: Record<string, number> = {};
	if (obj.samplers && typeof obj.samplers === "object") {
		for (const [k, v] of Object.entries(obj.samplers)) {
			if (typeof v === "number" && Number.isFinite(v)) samplers[k] = v;
		}
	}
	return { name: typeof obj.name === "string" ? obj.name : "preset", samplers, blocks };
}
