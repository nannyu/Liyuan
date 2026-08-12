/**
 * 预设块性质分类（PLAN-RP-HARNESS M5 §7，2026-08-03 用户定调）。
 *
 * 预设页签现有三个页签（采样参数 / 系统区 / 末端注入）是**递送通道**轴——内容送到哪。
 * 本模块加的是**性质**轴——内容是什么。两条轴正交：一个 system 块可以是文风也可以是噪声。
 *
 * 为什么要分：实测某预设一拍占上下文 9536 字（占比 86%），其中 35% 是噪声
 * （空块、装饰分隔、纯 setvar 链、破限话术）。上下文预算就是注意力预算——
 * 用户原话「文风这种东西就应该做完提示词就行」，说的就是各归各位。
 *
 * 四类去向：
 *   style   文风  → 写作阶段在场（模型照着写）
 *   police  纪律  → 只在精修阶段送（禁词/句式代码判得了，写作时看见只会引发脑内验算）
 *   format  结构  → 写作阶段在场（输出模块/标签/顺序/字数，不知道就写错格式）
 *   noise   噪声  → 不入场（对演出零贡献，纯占预算）
 *
 * **兜底归 style**：分类器不可能全对，判错方向要选代价小的那个——
 * 把文风误判成噪声＝正文变差（用户立刻能感知），把噪声误判成文风＝多几十字（几乎无感）。
 *
 * 纯函数、零依赖、可单测。
 */

import { isPoliceBlock } from "./draft.ts";

export type BlockKind = "style" | "police" | "format" | "noise";

export interface BlockClassification {
	kind: BlockKind;
	/** 判定依据（UI 里给用户看「为什么归这类」，便于手动改判） */
	reason: string;
}

/** 噪声：破限/哄劝话术——对「演得好」零贡献，纯占注意力 */
const JAILBREAK_CHATTER =
	/(抗注入宣言|无欲无求|约定第一|可耻小人|拿出你的武器|这个就是考验|奇怪的xml|官腔的垃圾话)/i;

/** 结构：谈输出形态的词 */
const FORMAT_HINTS =
	/(输出格式|格式要求|strict_format|按顺序输出|不得调换顺序|标签名|闭合|状态栏|选择框|插图|音频|前端|UpdateVariable|字数|word_count|response_length)/i;

/** 文风：谈怎么写的词 */
const STYLE_HINTS =
	/(文风|叙事|对白|台词|视角|人称|节奏|感官|描写|情感|氛围|活人感|基调|性格|心理|情节|剧情|角色)/;

/**
 * 剥掉不进模型视野的东西：注释宏、纯赋值宏、空白。
 * 剥完为空 = 这个块对模型什么也没说（纯变量组/纯装饰）。
 */
function visibleText(content: string): string {
	return (
		content
			.replace(/\{\{\/\/[\s\S]*?\}\}/g, "") // {{// 注释}}：只给预设作者看
			// setvar/addvar 的**值**是真内容：`{{setvar::hook:: <规则>…}}` 里那段规则会被
			// 后面的 {{getvar::hook}} 放出来送进模型。故只剥宏壳、留值——
			// 2026-08-03 审查发现：整条剥掉会把「防打断」「Claude 禁词表」「详略得当」
			// 这类真·写作指令误判成噪声，等于静默删掉预设的内容。
			.replace(/\{\{(?:setvar|addvar)::[^:}]*::/gi, "")
			.replace(/\{\{(?:trim|newline)(?:::[^}]*)?\}\}/gi, "")
			.replace(/\}\}/g, "")
			.trim()
	);
}

/**
 * 给一个预设块定性。content 为**宏求值前**的原文（noise 判定要看得见 setvar 结构）。
 * name 仅作辅助（分隔条类的块名常是 ━━━━ 标题 ━━━━）。
 */
export function classifyBlock(content: string, name = ""): BlockClassification {
	const raw = (content ?? "").trim();
	if (!raw) return { kind: "noise", reason: "空块" };

	// 纯装饰行（分隔条）：剥掉装饰符与两侧短标题后无实质内容。
	// 形如「━━━━ 文风 ━━━━」是页签里的分组标题——它进上下文只是几个字的噪声，
	// 但**块名要保留给 UI**（用户靠它认位置），故只判内容不判名字。
	const deco = raw.replace(/[-=━─—_~|｜*#\s]/g, "");
	if (!deco) return { kind: "noise", reason: "纯分隔装饰" };
	if (deco.length <= 6 && !/[，。：；、？！]/.test(deco) && raw.length <= 40) {
		return { kind: "noise", reason: `分组标题「${deco}」，非指令内容` };
	}

	const vis = visibleText(raw);
	if (!vis) return { kind: "noise", reason: "只有空赋值与注释，对模型无可见内容" };
	// 剥掉宏壳后只剩零星符号/变量名（如 `<Lore>`、`"zh-CN"`）——是装配用的开关，不是给模型的指令
	if (vis.length <= 12 && !/[，。：；、？！]/.test(vis)) {
		return { kind: "noise", reason: "仅变量开关值，非指令内容" };
	}

	if (JAILBREAK_CHATTER.test(vis)) return { kind: "noise", reason: "破限/哄劝话术" };

	// 纪律优先于结构与文风：禁词表/句式禁令/比喻原则（沿用已实弹验证的判据，R7）
	if (isPoliceBlock(vis)) return { kind: "police", reason: "纪律细则（禁词/句式/比喻），验收层已退役（8/10），去向待重分拣" };

	// 结构与文风：谁的特征更强算谁；两者都无则兜底文风
	const fmt = FORMAT_HINTS.test(vis);
	const sty = STYLE_HINTS.test(vis);
	if (fmt && !sty) return { kind: "format", reason: "输出结构/格式要求" };
	if (sty && !fmt) return { kind: "style", reason: "文风与写法" };
	if (fmt && sty) {
		// 同时命中：看哪类词更密（结构块常整段在讲标签与顺序）
		const fmtHits = (vis.match(FORMAT_HINTS) ?? []).length + (vis.match(/<\/?[a-zA-Z_][\w-]*>/g) ?? []).length;
		const styHits = (vis.match(STYLE_HINTS) ?? []).length;
		return fmtHits > styHits
			? { kind: "format", reason: "结构特征强于文风（标签/格式密集）" }
			: { kind: "style", reason: "文风特征为主（含少量格式提及）" };
	}
	// 兜底：留在写作台上（误判代价最小的方向）
	return { kind: "style", reason: "未命中明确特征，保守留在写作阶段" };
}

/** 写作阶段是否入场：文风与结构在场，纪律只在精修，噪声不入场 */
export function entersWritingStage(kind: BlockKind): boolean {
	return kind === "style" || kind === "format";
}

export interface BucketSummary {
	style: number;
	police: number;
	format: number;
	noise: number;
	/** 各类字符数 */
	chars: Record<BlockKind, number>;
	/** 写作阶段实际入场字符数 */
	writingChars: number;
	/** 全量字符数 */
	totalChars: number;
}

/** 汇总一份预设的分桶分布（导入报告 / 页签统计用） */
export function summarizeBuckets(blocks: Array<{ content: string; name?: string }>): BucketSummary {
	const out: BucketSummary = {
		style: 0,
		police: 0,
		format: 0,
		noise: 0,
		chars: { style: 0, police: 0, format: 0, noise: 0 },
		writingChars: 0,
		totalChars: 0,
	};
	for (const b of blocks) {
		const len = (b.content ?? "").length;
		const { kind } = classifyBlock(b.content, b.name);
		out[kind]++;
		out.chars[kind] += len;
		out.totalChars += len;
		if (entersWritingStage(kind)) out.writingChars += len;
	}
	return out;
}
