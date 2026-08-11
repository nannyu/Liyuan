/**
 * 预设拆层（PLAN-RP-AGENT-EXEC M-C / docs/PRESET-SPLIT-TAXONOMY.md）。
 *
 * 预设内容九性质五去向（TAXONOMY §1）：
 *   A 破限/身份契约 → 常驻原文（原序原通道，不动不压不拆）
 *   B 全程文风       → 常驻「文风与写法」节（写每句都用）
 *   C 行为规则       → 常驻「行为边界」节（违反即坏拍）
 *   D 通用方法论     → skill（writing_guide 按需读，工具结果不落历史=用完即走）
 *   E 场景专题包     → skill 分主题（瑟瑟语料只在瑟瑟拍进上下文）
 *   F 机械纪律       → 已死路由（8/10 验收退役：检测不复存在；条目冻结待重分拣）
 *   G 验算指令       → 丢弃（思考塌缩的直接抓手；8/10 起 harness 侧验收同样不存在）
 *   H 脑内 harness   → 丢弃（预设自带的提示词版引擎：COT/格式栈/Prism/变量/包装，
 *                      agent 循环/工具/装配/压缩/渲染已原生实现同功能）
 *   I 噪声/死块      → 蒸发
 *
 * 执行形态（TAXONOMY §4.1 v0）：三份实证预设走**内置手工拆层表**（本文件常量），
 * 未知预设回落 preset-classify 四类粗分兜底（拿不准归常驻——宁多几百字不丢内容）。
 * LLM 离线拆层通解（任意社区预设）后置 v1。
 *
 * 块不是拆层原子（TAXONOMY §3.4）：块级定主性质 + 段级 segments 分拆 + 句级 strip/keep；
 * 变量级条目处理「setvar 在 X 块、getvar 放出点在被退场的 Y 块」的内容（防打断 hook 等），
 * 兼救死变量（set 了没人 get 的启用块内容）。supplements 是从被退场块里**转述救出**的
 * 规则句（手工改写，报告注明出处块——不是生成内容，是拆层校准的一部分）。
 *
 * 纯函数 + 常量表，零模块级可变状态（jiti 二象性红线），可单测。
 */

import { classifyBlock } from "./preset-classify.ts";

export type SplitFate = "resident" | "skill" | "rules-only" | "drop";
export type ResidentSection = "A" | "B" | "C";
export type BlockNature = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I";

/** 段级拆分：match 命中的片段单独定去向；未命中任何 segment 的剩余内容走块级 fate */
export interface SegmentRule {
	match: RegExp;
	fate: SplitFate;
	section?: ResidentSection;
	topic?: string;
}

export interface BlockSplitRule {
	/** 启用块名，trim 后精确匹配 */
	name: string;
	nature: BlockNature;
	fate: SplitFate;
	section?: ResidentSection;
	topic?: string;
	/** 句级：摘掉命中行（作用于 resident/skill 产物） */
	stripLines?: RegExp[];
	segments?: SegmentRule[];
	/** 该块声明了自定义用户代言边界（如话痨卡允许代写对白）→ 主权检查降档 */
	note?: string;
}

/** 变量级去向：值从求值后的变量表取（放出点块被退场/死变量救活两种场景） */
export interface VarSplitRule {
	name: string;
	fate: "resident" | "skill" | "drop";
	section?: "B" | "C";
	topic?: string;
	stripLines?: RegExp[];
}

/** 从被退场块转述救出的规则句（手工校准；source=出处块名，进装配报告） */
export interface SupplementRule {
	section: "B" | "C";
	text: string;
	source: string;
}

export interface PresetSplitTable {
	key: string;
	/** 启用块名命中 ≥2 个指纹即认定（预设改名/魔改容错） */
	fingerprints: string[];
	blocks: BlockSplitRule[];
	vars: VarSplitRule[];
	supplements: SupplementRule[];
}

// ---------------- 内置拆层表（TAXONOMY §2，逐块人工校准 2026-08-03） ----------------

const TGBREAK: PresetSplitTable = {
	key: "tgbreak-v2",
	fingerprints: ["🍭TGD咪咪吐槽", "😀话痨抢话", "👻TG推荐文风", "⬇️⬇️COT-开始（中文）⬇️⬇️"],
	blocks: [
		{ name: "⚠️⚠️使用必看⚠️⚠️", nature: "I", fate: "drop" },
		{ name: "😾😾别关", nature: "I", fate: "drop" },
		{ name: "🚫魔改🚫二创🚫商用", nature: "A", fate: "resident", section: "A" },
		{ name: "miumiu~", nature: "A", fate: "resident", section: "A" },
		{ name: "ฅ^•ﻌ•^ฅ", nature: "A", fate: "resident", section: "A" },
		{ name: "遇到道歉就重ROLL", nature: "H", fate: "drop", note: "Story setting 包装标签，装配已有【相关设定】结构" },
		{ name: "故事设定结束", nature: "H", fate: "drop" },
		{ name: "886#####", nature: "H", fate: "drop" },
		{ name: "668#####", nature: "H", fate: "drop" },
		{ name: "写作要求开始👇️👇️", nature: "H", fate: "drop" },
		{ name: "---文风选择----", nature: "H", fate: "drop" },
		{ name: "👻TG推荐文风", nature: "B", fate: "resident", section: "B" },
		{ name: "👻瑟瑟语料（可叠加其他文风）", nature: "E", fate: "skill", topic: "nsfw", note: "内嵌禁用词小节由规则提取扫全量覆盖" },
		{ name: "---文风选择结束---", nature: "H", fate: "drop" },
		{
			name: "😀话痨抢话",
			nature: "C",
			fate: "resident",
			section: "C",
		},
		{ name: "✔️超级禁八股（最新版）", nature: "G", fate: "drop", note: "「生成前逐句扫描」类验算指令（验收已整体退役）" },
		{ name: "✔️文笔优化-比喻", nature: "F", fate: "rules-only" },
		{ name: "✔️禁八股(测试版)", nature: "F", fate: "rules-only" },
		{ name: "✔️角色防绝望", nature: "C", fate: "resident", section: "C" },
		{ name: "✔️优化文字", nature: "B", fate: "resident", section: "B" },
		{ name: "写作要求结束👆️👆️", nature: "H", fate: "drop" },
		{ name: "----人称3选1-----", nature: "H", fate: "drop", note: "引导语指向已退场的 interaction_record 标签" },
		{ name: "第一人称视角", nature: "C", fate: "resident", section: "C" },
		{ name: "------推进速度(4选1)--------", nature: "H", fate: "drop" },
		{ name: "正常", nature: "I", fate: "drop", note: "「正常速度」＝默认行为，无信息量；用户换开快进/慢速块时走兜底入 B" },
		{ name: "------预设功能--------", nature: "H", fate: "drop" },
		{ name: "🥵瑟瑟描述", nature: "E", fate: "skill", topic: "nsfw" },
		{ name: "🥵瑟瑟多样化", nature: "E", fate: "skill", topic: "nsfw" },
		{ name: "👁️‍🗨️防全知", nature: "C", fate: "resident", section: "C", note: "「默念思考」在 agent 环境＝动笔前读题，非事后验算，整块保留" },
		{
			name: "💞活人感（测试版）",
			nature: "D",
			fate: "skill",
			topic: "general",
			stripLines: [/^```|随机运算|使用代码进行运算思考|^多个角色则依次套用/],
			note: "random 伪代码运算壳摘除，保留去刻板印象方法论",
		},
		{ name: "⚙️转述+扩写", nature: "H", fate: "drop", note: "实质规则经 supplements 转述救出" },
		{ name: "------粉丝定制--------", nature: "I", fate: "drop" },
		{ name: "🍭行动选项", nature: "H", fate: "drop", note: "w2g 选择框——M-B 账本渲染补回（D-C3）" },
		{ name: "🍭TGD咪咪吐槽", nature: "C", fate: "resident", section: "C", note: "catsay 状态栏——用户预设功能，保留" },
		{ name: "------预设功能结束--------", nature: "I", fate: "drop" },
		{ name: "⬇️⬇️COT-开始（中文）⬇️⬇️", nature: "H", fate: "drop" },
		{ name: "cot-✔️基础思维-必开", nature: "H", fate: "drop", note: "七步 COT＝agent 循环取代；夹带规则经 supplements 救出" },
		{ name: "cot-🔞深度瑟瑟（不瑟时候关掉）", nature: "E", fate: "skill", topic: "nsfw", note: "情欲场景写法要点，动笔前参考" },
		{ name: "⬆️⬆️COT-结束⬆️⬆️", nature: "H", fate: "drop" },
		{ name: "---字数2选1-------", nature: "I", fate: "drop" },
		{ name: "⚙️中字数设定（否则开我）", nature: "F", fate: "rules-only" },
		{ name: "😏摘要（省token、防变傻神器）", nature: "H", fate: "drop", note: "M4 压缩已原生做摘要" },
		{ name: "检查格式", nature: "H", fate: "drop", note: "strict_format 顺序栈＝工具流取代" },
		{ name: "❄️带think模型--底部1", nature: "H", fate: "drop", note: "压制原生思考通道，与 harness 冲突" },
		{ name: "❄️带think模型--底部2", nature: "H", fate: "drop" },
	],
	vars: [],
	supplements: [
		{
			section: "C",
			text: "用户输入只描述用户角色自己的决策与行动，不改变其他角色与世界——其他人如何回应、世界如何变化由你决定。",
			source: "cot-✔️基础思维-必开",
		},
		{ section: "C", text: "叙事时间只向前流动，禁止时间倒流。", source: "cot-✔️基础思维-必开" },
		{
			section: "C",
			text: "用户输入中的动作、对白与细节全部要在正文中体现，一个不漏；正文从用户输入里最早的动作接起，不跳过它直接写后续。",
			source: "⚙️转述+扩写",
		},
	],
};

const SHUANGREN: PresetSplitTable = {
	key: "shuangren-v10",
	fingerprints: ["🔒 ┏ 双人成行（Atri&Deach）", "🔒 ┗ 尽可能不要动（变量组）", "🗡丨草稿@Kemini", "🔒丨User_Input"],
	blocks: [
		{ name: "🔒 ┏ 双人成行（Atri&Deach）", nature: "A", fate: "resident", section: "A" },
		{ name: "🔒 ┣ 双人出发", nature: "A", fate: "resident", section: "A" },
		{ name: "🔒 ┗ 尽可能不要动（变量组）", nature: "I", fate: "drop", note: "变量清空组，求值即蒸发；meta 经 vars 表救出" },
		{ name: "✨丨通用", nature: "H", fate: "drop" },
		{ name: "😀丨活人感与动作塑造基准", nature: "D", fate: "skill", topic: "general", stripLines: [/^写完后检查/] },
		{ name: "😀丨叙事推进基准", nature: "D", fate: "skill", topic: "general" },
		{ name: "🔤丨COT语言", nature: "H", fate: "drop" },
		{ name: "🔤丨输出语言", nature: "H", fate: "drop", note: "config.language 原生承接" },
		{ name: "💬丨字数设定", nature: "F", fate: "rules-only" },
		{ name: "🌕丨无基调", nature: "I", fate: "drop" },
		{ name: "♻️丨防打断（新）", nature: "C", fate: "drop", note: "内容经 vars: hook 入常驻 C；hook_check 丢" },
		{ name: "⚠️丨扩写+加强复述", nature: "C", fate: "drop", note: "内容经 vars: push_rule 入常驻 C" },
		{ name: "🎨丨Claude详略得当（测试版）", nature: "D", fate: "drop", note: "死变量（anti_verbose 无人 getvar）——经 vars 救活入 skill" },
		{ name: "🚫丨反全知", nature: "C", fate: "resident", section: "C" },
		{
			name: "🚫丨禁用词表（测试）",
			nature: "F",
			fate: "rules-only",
			segments: [{ match: /允许使用自然中文里的整体表情动作[^\n]*/, fate: "resident", section: "B" }],
			note: "禁词/句式→代码；表情写法白名单句救入 B（高频写法供给）",
		},
		{ name: "🎨丨Claude禁词表", nature: "F", fate: "rules-only", note: "死变量；规则提取扫全量已覆盖" },
		{ name: "📢丨增加对白", nature: "B", fate: "resident", section: "B" },
		{ name: "❎丨杀超雄", nature: "G", fate: "drop" },
		{ name: "🔒丨文风", nature: "H", fate: "drop", note: "文风槽壳；用户开启的文风包经 vars: base_writing 等入 B" },
		{ name: "🔒丨Prism", nature: "H", fate: "drop", note: "每段 html 注释自提醒＝验算外显（两个同名块同判）" },
		{ name: "🔒", nature: "A", fate: "resident", section: "A", note: "锵锵仪式（人格连续）" },
		{ name: "🔒丨User_Input", nature: "H", fate: "drop", note: "latest_human_message 包装＝装配原生保证；hook/meta 经 vars 救出" },
		{ name: "🔒丨COT_开始", nature: "H", fate: "drop" },
		{ name: "🔒丨强化思考@leyangzhoumichael0421", nature: "H", fate: "drop", note: "「思考必须≥3500 tokens」——思考膨胀直接教唆，必丢" },
		{ name: "✨丨思考模式（繁）", nature: "H", fate: "drop" },
		{ name: "🗡丨草稿@Kemini", nature: "H", fate: "drop", note: "每段前注释打草稿＝排练外显" },
		{ name: "🔒丨Core", nature: "H", fate: "drop", note: "输出格式栈" },
		{ name: "━━━━ 尾部 ━━━━", nature: "A", fate: "resident", section: "A", note: "「设定仅为创作需要」+talk 引导（随块出场）" },
		{ name: "✨丨Gemini", nature: "H", fate: "drop" },
		{ name: "━━ 情感基调@四神花ル水 ━━", nature: "I", fate: "drop", note: "基调定义壳——tone 变量当前空转" },
		{ name: "⚫ ┏", nature: "H", fate: "drop", note: "Lore 包装标签（[World Loading]）" },
		{ name: "⚫ ┗", nature: "H", fate: "drop" },
		{ name: "┏", nature: "H", fate: "drop", note: "<context> 包装——历史结构装配原生" },
		{ name: "🎭丨神秘高压向", nature: "I", fate: "drop" },
	],
	vars: [
		{ name: "hook", fate: "resident", section: "C" },
		{ name: "push_rule", fate: "resident", section: "C" },
		{ name: "meta", fate: "resident", section: "C" },
		{ name: "anti_verbose", fate: "skill", topic: "general" },
		{ name: "base_writing", fate: "resident", section: "B" },
		{ name: "patch", fate: "resident", section: "B" },
		{ name: "char", fate: "resident", section: "B" },
		{ name: "sex_4", fate: "skill", topic: "nsfw" },
		{ name: "sex_3", fate: "skill", topic: "nsfw" },
		{ name: "sex", fate: "skill", topic: "nsfw" },
		{ name: "sex_1", fate: "skill", topic: "nsfw" },
		{ name: "sex_2", fate: "skill", topic: "nsfw" },
		{ name: "nsfw_symbols", fate: "skill", topic: "nsfw" },
	],
	supplements: [],
};

const XIAJIN: PresetSplitTable = {
	key: "xiajin-v2",
	fingerprints: ["基础框架/用户画像", "精神分析", "思维链首", "情节设计/文风细节"],
	blocks: [
		{ name: "USER设定", nature: "H", fate: "drop" },
		{ name: "USER设定/角色设定", nature: "H", fate: "drop" },
		{ name: "角色设定/世界观设定", nature: "H", fate: "drop" },
		{ name: "世界观设定/前文", nature: "H", fate: "drop" },
		{ name: "前文", nature: "H", fate: "drop" },
		{
			name: "基础框架/用户画像",
			nature: "D",
			fate: "skill",
			topic: "general",
			segments: [{ match: /<主要任务>[\s\S]*?<\/主要任务>/, fate: "resident", section: "C" }],
			note: "任务定义句常驻；受众画像入 skill",
		},
		{ name: "精神分析", nature: "D", fate: "skill", topic: "general" },
		{
			name: "内容禁令",
			nature: "F",
			fate: "rules-only",
			note: "禁词（喉结/纽扣）→代码；语义级禁元素经 supplements 转一句 C",
		},
		{
			name: "情节设计/文风细节",
			nature: "D",
			fate: "drop",
			segments: [
				{ match: /<情节设计>[\s\S]*?<\/情节设计>/, fate: "skill", topic: "general" },
				{ match: /<文风细节>[\s\S]*?<\/文风细节>/, fate: "resident", section: "B" },
			],
		},
		{
			name: "色情描写/防重复",
			nature: "E",
			fate: "resident",
			section: "C",
			segments: [
				{ match: /<色情描写规则>[\s\S]*?<\/色情描写规则>/, fate: "skill", topic: "nsfw" },
				{ match: /<防重复要求>[\s\S]*?<\/防重复要求>/, fate: "drop" },
			],
			stripLines: [/^<\/?用户基础需求>/],
			note: "剩余（抗升华/纯中文/不预告）常驻 C",
		},
		{ name: "思维链首", nature: "H", fate: "drop" },
		{ name: "思维链尾", nature: "H", fate: "drop", note: "「字数须超1000」单边下限，规则提取暂不支持（TAXONOMY §2.3）" },
	],
	vars: [],
	supplements: [
		{
			section: "C",
			text: "不使用具体数值与序数词，不用生理学、物理学、医学术语，不出现先进科技元素，不出现血液、受伤、划痕。",
			source: "内容禁令",
		},
	],
};

export const BUILTIN_SPLIT_TABLES: PresetSplitTable[] = [TGBREAK, SHUANGREN, XIAJIN];

// ---------------- 匹配与分流 ----------------

/** 按启用块名指纹认表（≥2 命中）；认不出返回 null（走四类兜底） */
export function findSplitTable(enabledNames: Array<string | undefined>): PresetSplitTable | null {
	const names = new Set(enabledNames.map((n) => (n ?? "").trim()).filter(Boolean));
	for (const table of BUILTIN_SPLIT_TABLES) {
		const hits = table.fingerprints.filter((f) => names.has(f)).length;
		if (hits >= 2) return table;
	}
	return null;
}

export function lookupBlockRule(table: PresetSplitTable | null, name: string | undefined): BlockSplitRule | undefined {
	if (!table || !name) return undefined;
	return table.blocks.find((b) => b.name === name.trim());
}

/**
 * 格式栈指令行（兜底安全网）：未知预设粗分进 skill/B 的内容里，摘掉「必须输出 <tag> /
 * 按标签输出 / 严格按顺序输出模块」类行——格式栈功能已由工具/渲染承接，指令残留＝
 * 引导模型手写格式块。宁漏勿误：只认明确的输出指令句式。
 */
const FORMAT_STACK_LINE =
	/(必须输出|最先输出|先输出|按照\s*<[^>]+>\s*标签|标签名输出|请勿修改标签|严格按顺序输出|不得调换顺序|所有标签.{0,6}闭合|输出格式[:：]|strict_format)/i;

export function stripFormatStackLines(content: string): { text: string; dropped: number } {
	if (!content) return { text: content, dropped: 0 };
	const lines = content.split("\n");
	const kept: string[] = [];
	let dropped = 0;
	for (const line of lines) {
		if (FORMAT_STACK_LINE.test(line)) {
			dropped++;
			continue;
		}
		kept.push(line);
	}
	if (dropped === 0) return { text: content, dropped: 0 };
	return { text: kept.join("\n").replace(/\n{3,}/g, "\n\n"), dropped };
}

const stripByPatterns = (content: string, patterns: RegExp[] | undefined): string => {
	if (!patterns || patterns.length === 0) return content;
	const kept = content.split("\n").filter((line) => !patterns.some((p) => p.test(line)));
	return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
};

/** 单块分流产物：resident/skill 各自的文本片段（一个块可拆出多段） */
export interface BlockSplitPieces {
	resident: Array<{ section: ResidentSection; text: string }>;
	skill: Array<{ topic: string; text: string }>;
	/** 命中的规则（报告用）；undefined＝走了四类兜底 */
	rule?: BlockSplitRule;
	/** 兜底时的四类判定（报告用） */
	fallbackKind?: string;
}

const pushPiece = (
	out: BlockSplitPieces,
	fate: SplitFate,
	text: string,
	section?: ResidentSection,
	topic?: string,
): void => {
	const t = text.trim();
	if (!t) return;
	if (fate === "resident") out.resident.push({ section: section ?? "B", text: t });
	else if (fate === "skill") out.skill.push({ topic: topic ?? "general", text: t });
	// rules-only / drop：不产出文本（规则提取始终扫全量原文，与此处无关）
};

/**
 * 对一个（宏求值后非空的）块执行拆层。有表规则按规则；无规则走四类兜底：
 * style→常驻 B、police→rules-only、format→skill general（叠格式栈行过滤）、noise→drop。
 */
export function splitBlockContent(rule: BlockSplitRule | undefined, name: string, content: string): BlockSplitPieces {
	const out: BlockSplitPieces = { resident: [], skill: [] };
	if (rule) {
		out.rule = rule;
		let rest = content;
		if (rule.segments) {
			for (const seg of rule.segments) {
				const m = seg.match.exec(rest);
				if (!m) continue;
				pushPiece(out, seg.fate, stripByPatterns(m[0], rule.stripLines), seg.section, seg.topic);
				rest = rest.replace(m[0], "");
			}
		}
		pushPiece(out, rule.fate, stripByPatterns(rest, rule.stripLines), rule.section, rule.topic);
		return out;
	}
	// 四类兜底（未知预设/表未覆盖的新开块）
	const kind = classifyBlock(content, name).kind;
	out.fallbackKind = kind;
	if (kind === "style") pushPiece(out, "resident", content, "B");
	else if (kind === "format") pushPiece(out, "skill", stripFormatStackLines(content).text, undefined, "general");
	// police → rules-only；noise → drop：无产出
	return out;
}

// ---------------- 装配报告 ----------------

export interface AssemblyReportItem {
	name: string;
	channel: "system" | "postHistory";
	chars: number;
	nature: BlockNature | `兜底:${string}`;
	fate: string;
	note?: string;
}

export function reportItemFor(
	pieces: BlockSplitPieces,
	name: string,
	channel: "system" | "postHistory",
	chars: number,
): AssemblyReportItem {
	const rule = pieces.rule;
	const dests: string[] = [];
	for (const r of pieces.resident) dests.push(`常驻${r.section}`);
	for (const s of pieces.skill) dests.push(`skill:${s.topic}`);
	if (rule?.fate === "rules-only") dests.push("仅规则提取");
	if (dests.length === 0) dests.push("退场");
	return {
		name,
		channel,
		chars,
		nature: rule ? rule.nature : (`兜底:${pieces.fallbackKind ?? "?"}` as const),
		fate: dests.join("+"),
		...(rule?.note ? { note: rule.note } : {}),
	};
}
