/**
 * 台上装配器（PLAN-RP-HARNESS M1）——旧 director.ts 的转世。
 *
 * 职责：把「当前分支 + 素材」装配成一次 LLM 调用的完整上下文。
 * - system prompt 会话内字节稳定（R3，利于前缀缓存）；动态内容全走末端注入
 * - 历史 = f(分支)：往拍只留定稿正文（补丁已套、工具痕迹不存在），过程不进历史
 * - 世界状态 = f(分支)：从 rp-state 快照重建（R4）
 *
 * M3 起台上有三件只读检索工具（lorebook_search / memory_search / world_state_get），
 * 提示词在此声明用法纪律；写入类工具仍然没有（记账归场记独占，R8）。
 * 本模块纯函数、零 pi 依赖、可单测。
 */

import { applyMacros } from "../card.ts";
import { applyDraftOps, type DraftMsgLike } from "../draft.ts";
import { cleanAssistantText } from "../postprocess.ts";
import { formatState, defaultState } from "../state.ts";
import { isBackstageText } from "../stance.ts";
import type { PresetBlock } from "../preset.ts";
import type { CharacterCard, LorebookEntry, MacroContext, RpConfig, WorldState } from "../types.ts";

// ---------------- 分支 → 历史 ----------------

/** 会话树条目的结构子集（不引 @liyuan/agent-runtime 类型，保持 src/ 独立） */
export interface BranchEntryLike {
	/** 树上条目 id（前情摘要用它锚定「覆盖到哪」） */
	id?: string;
	type?: string;
	customType?: string;
	content?: unknown;
	data?: unknown;
	display?: boolean;
	message?: { role?: string; content?: unknown; stopReason?: string };
}

/** 装配产物里的一条历史消息（引擎再转 @liyuan/ai Message） */
export interface BeatMsg {
	role: "user" | "assistant";
	text: string;
}

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof p === "object" && (p as { type?: unknown }).type === "text"
				? String((p as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
};

/** 叙事向 custom 消息 → 历史角色映射；不在表内的 custom 不进送模流 */
const CUSTOM_AS_ASSISTANT = new Set(["rp-greeting", "rp-edited-reply"]);
const CUSTOM_AS_USER = new Set(["rp-import"]);

export interface RebuiltHistory {
	history: BeatMsg[];
	/** 最后一条用户消息原文（postHistory 宏 / 求方向判定用） */
	lastUserText: string;
	/** 最后一条台上叙事文本（语言自愈检测源；开场白计入，幕后轮的回复不计） */
	lastNarrativeText: string;
	/** 前情提要：被摘要覆盖的早期剧情（rp-summary / 旧 compaction 条目）；无则 undefined */
	summary?: string;
}

/** 前情摘要的会话树条目类型（CustomEntry：不进 pi 上下文，装配由台上引擎自管） */
export const SUMMARY_ENTRY_TYPE = "rp-summary";

/** rp-summary 条目的 data 形状 */
export interface RpSummaryData {
	/** 接力摘要正文（已合并更早的摘要） */
	summary: string;
	/** 覆盖到哪条为止（含）——该条及其之前的条目不再进历史 */
	coversThroughId: string;
	/** 本次摘要覆盖的叙事拍数（过程条用） */
	turns?: number;
	/** 被摘要替换的原文字数（过程条用） */
	chars?: number;
}

const summaryDataOf = (e: BranchEntryLike): RpSummaryData | null => {
	if (e.type !== "custom" || e.customType !== SUMMARY_ENTRY_TYPE) return null;
	const d = e.data as Partial<RpSummaryData> | undefined;
	if (!d || typeof d !== "object") return null;
	if (typeof d.summary !== "string" || !d.summary.trim()) return null;
	if (typeof d.coversThroughId !== "string" || !d.coversThroughId) return null;
	return d as RpSummaryData;
};

/**
 * 分支上生效的前情摘要 = **最后一条**摘要条目（每次压缩都把上一份合并进来，故后者全覆盖前者）。
 * 兼容旧会话里 pi 写的 `compaction` 条目：覆盖边界取 firstKeptEntryId 的前一条。
 * 返回 cut = 需要从历史里去掉的条目数（分支前缀长度）。
 */
export function activeSummary(branch: BranchEntryLike[]): { summary: string; cut: number } | null {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		const data = summaryDataOf(e);
		if (data) {
			const at = branch.findIndex((x) => x.id === data.coversThroughId);
			// 覆盖锚点找不到（异常树）时退守到摘要条目自身之前
			return { summary: data.summary, cut: at >= 0 ? at + 1 : i };
		}
		// 旧会话：pi 的 compaction 条目（summary + firstKeptEntryId）
		if (e.type === "compaction") {
			const legacy = e as unknown as { summary?: unknown; firstKeptEntryId?: unknown };
			if (typeof legacy.summary !== "string" || !legacy.summary.trim()) continue;
			const keptAt =
				typeof legacy.firstKeptEntryId === "string"
					? branch.findIndex((x) => x.id === legacy.firstKeptEntryId)
					: -1;
			return { summary: legacy.summary, cut: keptAt >= 0 ? keptAt : i };
		}
	}
	return null;
}

/**
 * 分支条目 → 往拍历史。
 * 补丁（rp-draft-op）先套用；assistant 文本过 cleanAssistantText；
 * 工具调用/思考块/账本快照等过程条目一律不进历史（R3：装配时就不存在）。
 * 相邻同角色文本合并（API 安全）。
 *
 * M4：有 rp-summary 时，被覆盖的早期条目整段不进历史，改由 summary 字段回读为【前情提要】。
 */
export function rebuildHistory(branch: BranchEntryLike[]): RebuiltHistory {
	const active = activeSummary(branch);
	const live = active ? branch.slice(active.cut) : branch;

	// 1) 取叙事相关条目为 MsgLike 流（保留 rp-draft-op 供补丁函数消费）
	const stream: Array<DraftMsgLike & { _role: "user" | "assistant" }> = [];
	for (const e of live) {
		if (e.type === "message" && e.message) {
			const r = e.message.role;
			if (r === "user" || r === "assistant") {
				stream.push({ role: r, content: e.message.content, _role: r });
			}
			continue;
		}
		if (e.type === "custom_message" && typeof e.customType === "string") {
			if (e.customType === "rp-draft-op") {
				stream.push({ role: "custom", customType: e.customType, content: e.content, _role: "assistant" });
			} else if (CUSTOM_AS_ASSISTANT.has(e.customType)) {
				stream.push({ role: "custom", customType: e.customType, content: e.content, _role: "assistant" });
			} else if (CUSTOM_AS_USER.has(e.customType)) {
				stream.push({ role: "custom", customType: e.customType, content: e.content, _role: "user" });
			}
			// 其余 custom（rp-audio 等展示件）不进送模流
		}
	}

	// 2) 套补丁（rp-draft-op 出流；assistant 文本被定点替换）
	const { messages: patched } = applyDraftOps(stream);

	// 3) 转历史：清洗 + 空文过滤 + 相邻同角色合并
	const history: BeatMsg[] = [];
	for (const m of patched) {
		const role = (m as { _role?: "user" | "assistant" })._role ?? (m.role === "user" ? "user" : "assistant");
		let text = textOf(m.content);
		if (role === "assistant") text = cleanAssistantText(text);
		text = text.trim();
		if (!text) continue;
		const prev = history[history.length - 1];
		if (prev && prev.role === role) {
			prev.text = `${prev.text}\n\n${text}`;
		} else {
			history.push({ role, text });
		}
	}

	// 4) 最后用户原文 + 最后台上叙事（幕后轮的回复不作语言检测源）
	let lastUserText = "";
	for (let i = history.length - 1; i >= 0; i--) {
		if (history[i].role === "user") {
			lastUserText = history[i].text;
			break;
		}
	}
	let lastNarrativeText = "";
	{
		let inBackstageTurn = false;
		for (const m of history) {
			if (m.role === "user") {
				inBackstageTurn = isBackstageText(m.text);
			} else if (!inBackstageTurn) {
				lastNarrativeText = m.text;
			}
		}
	}
	return { history, lastUserText, lastNarrativeText, ...(active ? { summary: active.summary } : {}) };
}

/** 世界状态 = f(分支)：最近一条 rp-state 快照；无快照 = 初始状态（R4 读侧） */
export function stateFromBranch(branch: BranchEntryLike[]): WorldState {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type === "custom" && e.customType === "rp-state" && e.data && typeof e.data === "object") {
			return { ...defaultState(), ...(e.data as Partial<WorldState>) };
		}
	}
	return defaultState();
}

/**
 * 当前分支上挂载的知识库名（rp-codex 快照，随 rewind/fork 走）。
 * 与扩展 restoreCodexFromBranch / main.ts mountedCodexes 同规则——取最近一条快照。
 */
export function codexNamesFromBranch(branch: BranchEntryLike[]): string[] {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type === "custom" && e.customType === "rp-codex" && e.data && typeof e.data === "object") {
			const mounted = (e.data as { mounted?: unknown }).mounted;
			return Array.isArray(mounted) ? mounted.filter((n): n is string => typeof n === "string") : [];
		}
	}
	return [];
}

// ---------------- system prompt（字节稳定） ----------------

/** M-C 拆层后的预设常驻内容（materials/engine 产出；A 原文 + B/C 归拢文本） */
export interface PresetResidentContent {
	/** A 破限/身份契约：原文原序（不动不压不拆） */
	aBlocks: PresetBlock[];
	/** B 全程文风（写每句都用） */
	styleTexts: string[];
	/** C 行为规则（违反即坏拍的边界） */
	boundaryTexts: string[];
}

export interface StageSystemOptions {
	card: CharacterCard;
	config: RpConfig;
	constantLore: LorebookEntry[];
	/** M-C：system 通道的预设常驻内容（拆层产物） */
	presetResident?: PresetResidentContent;
	/** writing_guide 可用主题（skill 包非空才有；空＝工具未挂，只字不提） */
	skillTopics?: string[];
	presetActive?: boolean;
	statusBarFormats?: string[];
	/** false = 不声明检索工具（M1 前过渡形态；M3 起默认开） */
	tools?: boolean;
	/**
	 * MCP 外设工具（8/06 重接）：本会话已连接的 mcp__ 工具，空/省略＝只字不提。
	 * 进 system 而非每拍注入——会话内字节稳定，不破前缀缓存（与旧 director.ts 同位置）。
	 */
	mcpTools?: Array<{ name: string; description: string }>;
}

/** 状态栏格式条目是否占位符型（自闭合 <Tag/>——界面由卡渲染，模型只留占位） */
export function isPlaceholderStatusFormat(f: string): boolean {
	return /\/>\s*$/.test(f.trim().replace(/^`|`$/g, ""));
}

/** 状态栏提示词：占位符型（自闭合）与面板型（成对、模型填内容）语义相反，分开写 */
export function buildStatusBarPrompt(statusBarFormats: string[]): string {
	const placeholders = statusBarFormats.filter(isPlaceholderStatusFormat);
	const panels = statusBarFormats.filter((f) => !isPlaceholderStatusFormat(f));
	const parts: string[] = [];
	if (placeholders.length > 0) {
		parts.push(
			`本卡用占位符渲染状态栏界面：每拍在正文之后**原样输出** ${placeholders.join("；")}（自闭合标签，` +
				`不要展开成成对写法、不要往里填内容——界面由卡自动渲染）`,
		);
	}
	if (panels.length > 0) {
		parts.push(
			`用该标签包住整块写出，字段随本拍剧情更新（地点/时间/关系/数值等）——格式线索：${panels.join("；")}`,
		);
	}
	return `${parts.join("；")}——这是卡作者设计的一部分，不依赖预设是否开启。`;
}

export function buildStageSystemPrompt({
	card,
	config,
	constantLore,
	presetResident,
	skillTopics,
	presetActive,
	statusBarFormats,
	tools,
	mcpTools,
}: StageSystemOptions): string {
	const macro: MacroContext = { charName: card.name, userName: config.userName };
	const m = (s: string) => applyMacros(s, macro);
	const sections: string[] = [];

	sections.push(
		`# 舞台
你在进行一场长篇沉浸式角色扮演：扮演 ${card.name}，以及剧情需要的一切配角、路人与世界本身。用户扮演 ${config.userName}。`,
	);

	const charParts: string[] = [`# 你扮演的角色：${card.name}`];
	if (card.description) charParts.push(m(card.description));
	if (card.personality) charParts.push(`## 性格\n${m(card.personality)}`);
	if (card.scenario) charParts.push(`## 当前场景\n${m(card.scenario)}`);
	if (card.mesExample) {
		charParts.push(`## 对白示例（仅供文风与语气参考，不是已发生的剧情）\n${m(card.mesExample)}`);
	}
	sections.push(charParts.join("\n\n"));

	const userParts: string[] = [`# 用户扮演：${config.userName}`];
	userParts.push(config.userPersona ? m(config.userPersona) : `（${config.userName} 的具体形象由用户在剧情中自行呈现）`);
	sections.push(userParts.join("\n"));

	if (constantLore.length > 0) {
		const loreText = constantLore.map((e) => `- ${e.comment ? `【${e.comment}】` : ""}${m(e.content)}`).join("\n");
		sections.push(`# 世界设定（常驻事实）\n${loreText}`);
	}

	sections.push(
		`# 叙事与文风
${
	presetActive
		? `- **扮演规范以用户预设为准**：人称视角、代言/抢话边界、文风、篇幅、节奏等一律按预设执行；预设未提及的按角色卡与上下文自然处理。`
		: `- 以 ${card.name} 的视角行动和说话；动作、神态与场景描写用 *斜体*，对白用引号。
- 【硬边界·用户主权】绝不替 ${config.userName} 说话、行动或代述内心想法——${config.userName} 的一切由用户本人书写。
- 用具体的感官细节（光线、声音、气味、触感、温度）落实场景，不抽象概括情绪。
- 每拍至少推进一小步（新信息、新动作、环境或情绪转折）；不原地兜圈，不复读前文。
- ${card.name} 是有自我的人物：有欲望、恐惧、底线与秘密，会拒绝、犹豫、犯错、撒娇或撒谎，不做有求必应的客服。
- 忌 AI 腔：不总结升华、不说教、不加免责声明；避免万能句式（如反复的"眼中闪过一丝……"）。`
}
- 【语言】无论角色卡、开场白或世界书原文是什么语言，你的叙事与对白一律使用${config.language}（人名、地名等专有名词可保留原文）。

# 输出结构
1. **正文**：纯剧情叙事与对白。不要把正文包进 \`<content>\` 之类的分析标签，不要写 HTML 注释式导演旁注。篇幅：有用户预设则跟预设；无预设时可见正文约 800–1500 字（短打约 400）。
2. **状态栏**：${
			statusBarFormats && statusBarFormats.length > 0
				? `本卡定义了状态栏。${buildStatusBarPrompt(statusBarFormats)}`
				: `本卡未检测到状态栏格式；**不要硬造**状态栏。若卡作者在说明里另有约定，按卡作者格式执行。`
		}`,
	);

	if (tools !== false) {
		sections.push(
			`# 怎么演这一拍
把自己当成一位资深作家，发挥你强大的剧情构思能力，肆意展现你的文笔，为用户提供最好的扮演体验。

第 1 轮：你需要读懂本拍处境，探索拿不准的信息，列出这一拍的路标，用 \`beat_plan\` 记下每一步发生什么。

每一轮开始：你需要回看刚写下的段落，发挥自己职业作家的水平去构思这一段的剧情走向。

写作过程中：你需要承接路标，倾尽所有的去构思这一段怎么写得精彩——镜头、动作、感官细节、神态情绪、节奏、点睛，把这一段写好再落笔，力求为用户提供最好的体验。

写完后：你需要重新评估——剧情到岔路就用 \`ask\` 问用户，路标不成立就重拟 \`beat_plan\`，戏到停点就 \`draft_seal\` 收笔。

每拍演完：你需要停在 ${config.userName} 可以接话、可以行动的位置。

具体的每一步由每轮注入的轮次卡（【第 1 步·规划】【开工】【演段回看】等）指示，以注入为准。`,
		);
	}

	// MCP 外设（8/06 重接）：用户在「扩展能力 → MCP」接入的外部服务器。
	// 工具已在清单里，这里只说明它们是什么、以及 RP 语境下的三条纪律。
	// 措辞承自旧 director.ts（009e22e 换引擎时随 director 一起失联）。
	if (mcpTools && mcpTools.length > 0) {
		const index = mcpTools.map((t) => `- \`${t.name}\`：${t.description}`).join("\n");
		sections.push(
			`# MCP 外设（用户接入的外部工具）
以 \`mcp__\` 开头的工具来自用户接入的外部服务器（识图、搜索、浏览器等），**直接调用**即可。
- **只在剧情真需要时用**——它们是外部服务，不是演出的一部分；能靠设定和想象写出来的，就不要调。
- 调用结果**用户看不见**：要让用户知道的内容，必须由你写进正文。
- 工具报错就如实说，不要假装成功；不可逆或高风险操作（删文件、付款、发帖）先问用户。
当前可用：
${index}`,
		);
	}

	sections.push(
		`# 消息流约定
- 标注【开场】的消息是 ${card.name} 的既定开场白，剧情从那一刻继续。
- 标注【前情提要】的消息是更早剧情的接力摘要，是既定事实。
- 标注【世界状态】的消息是当前事实基准：剧情记忆与它冲突时，以状态为准并在叙事内自然圆回，绝不跳出剧情解释。
- 标注【相关设定】的消息是自动附上的世界书参考，按需取用。
- 标注【剧情记忆】的消息是历史正文检索片段，按需取用，勿整段照抄。`,
	);

	// M-C 拆层常驻区：A 破限原文（原序）+ B 文风与写法 + C 行为边界。
	// 引导语点明分工：内容照着写，机械纪律归验收器——不给「逐条自查」留借口。
	if (presetResident) {
		const { aBlocks, styleTexts, boundaryTexts } = presetResident;
		if (aBlocks.length > 0) {
			sections.push(`# 预设指令（用户自备，按原序）\n${aBlocks.map((b) => b.content).join("\n\n")}`);
		}
		if (styleTexts.length > 0) {
			sections.push(
				`# 文风与写法（用户预设）\n以下是本场演出的文风与写法要求，写作时照此执行：\n\n${styleTexts.join("\n\n")}`,
			);
		}
		if (boundaryTexts.length > 0) {
			sections.push(`# 行为边界（用户预设）\n写作时刻刻要守的边界：\n\n${boundaryTexts.join("\n\n")}`);
		}
	}

	if (card.systemPrompt) {
		sections.push(`# 卡作者附加指令（优先级最高）\n${m(card.systemPrompt)}`);
	}

	return sections.join("\n\n");
}

// ---------------- 末端注入（每拍动态） ----------------

/** 设定集索引单行渲染的字符预算（超出按条目边界截断，补「等 N 条」） */
const LORE_INDEX_MAX_CHARS = 500;

/** 设定集条目索引行：`共 N 条：标题A、标题B、……`；只出名字，无可列返回 undefined */
export function formatLoreIndex(entries: Array<Pick<LorebookEntry, "comment" | "keys" | "enabled">>): string | undefined {
	const titles: string[] = [];
	for (const e of entries) {
		if (e.enabled === false) continue;
		const title = (e.comment || e.keys?.[0] || "").trim();
		if (title) titles.push(title);
	}
	if (titles.length === 0) return undefined;

	const shown: string[] = [];
	let used = 0;
	for (const t of titles) {
		if (used + t.length + 1 > LORE_INDEX_MAX_CHARS) break;
		shown.push(t);
		used += t.length + 1;
	}
	const rest = titles.length - shown.length;
	return `共 ${titles.length} 条：${shown.join("、")}${rest > 0 ? `……等（另 ${rest} 条未列出）` : ""}`;
}

export interface StageInjectionOptions {
	state: WorldState;
	activatedLore: LorebookEntry[];
	card: CharacterCard;
	config: RpConfig;
	/** M-C：postHistory 通道的预设常驻内容（引擎每拍按真实求值内容拆层产出） */
	presetTail?: PresetResidentContent;
	presetActive?: boolean;
	statusBarFormats?: string[];
	/** 上一拍台上叙事语言与配置不符（harness 检测） */
	languageMismatch?: boolean;
	/** 活跃面板全文快照（formatPanelSnapshot 产出）或一行速览 */
	panelIndex?: string;
	/**
	 * M4.5 给排练断粮（慢因 A）：末端明示思考只用于读题与决定，不在思考里起草正文。
	 * false = 关闭（速度基线对照用）。
	 */
	rehearsalGuard?: boolean;
	/** 预设字数规则（extractDraftRules 提取）——构成性目标写作时必须在场，验算归代码 */
	wordRange?: { min: number; max: number };
	/** 设定集索引行（formatLoreIndex 产出） */
	loreIndex?: string;
	/** 登场名录索引行（formatRosterIndex 产出） */
	rosterIndex?: string;
	/** false = 台上无检索工具（过渡形态）；影响索引块的措辞 */
	tools?: boolean;
}

/** 每拍注入消息流末端的动态内容（以 user 角色送达） */
export function buildStageInjection({
	state,
	activatedLore,
	card,
	config,
	presetTail,
	presetActive,
	statusBarFormats,
	languageMismatch,
	panelIndex,
	rehearsalGuard,
	wordRange,
	loreIndex,
	rosterIndex,
	tools,
}: StageInjectionOptions): string {
	const macro: MacroContext = { charName: card.name, userName: config.userName };
	const blocks: string[] = [];

	blocks.push(
		`【世界状态】当前事实基准，正文不得与之矛盾——物品在谁手里、现在是第几天几点、人在哪里，以下面为准；剧情记忆与之冲突时在叙事内自然圆回：\n${formatState(state)}`,
	);

	if (rosterIndex) {
		blocks.push(
			`【登场名录】以下条目登场过但已不在当前状态（离场/失去/了结），括号内是定拍维护的最近已知状态：${rosterIndex}。剧情重新带回其中条目时忠于既定事实，${
				tools === false
					? "细节记不清就模糊带过，不得凭空改写"
					: "细节记不清就**先用 `memory_search` 查**，查不到才模糊带过，不得凭空改写"
			}；名录里没有的名字才是真正的新登场。`,
		);
	}

	if (panelIndex) {
		blocks.push(`【活跃面板·当前内容】以下为最新版（用户可能手改过），其中事实为准：\n${panelIndex}`);
	}

	if (activatedLore.length > 0) {
		const lore = activatedLore
			.map((e) => `- ${e.comment ? `【${e.comment}】` : ""}${applyMacros(e.content, macro)}`)
			.join("\n");
		blocks.push(`【相关设定】\n${lore}`);
	}

	if (loreIndex) {
		blocks.push(
			`【设定集索引】${loreIndex}。正文将涉及其中条目而其内容未出现在上方【相关设定】时，${
				tools === false
					? "谨慎带过、禁止臆造细节。"
					: "**先用 `lorebook_search` 查出正文再写**——禁止凭想象编造已被写下的设定。"
			}`,
		);
	}

	// M-C：postHistory 通道常驻内容（A 原文按原序；B/C 归拢——depth 排序意义随拆层消解）
	if (presetTail) {
		if (presetTail.aBlocks.length > 0) {
			blocks.push(`【预设末端指令】\n${presetTail.aBlocks.map((b) => b.content).join("\n\n")}`);
		}
		if (presetTail.styleTexts.length > 0) {
			blocks.push(
				`【文风与写法】写作时照此执行（从落笔起生效）：\n${presetTail.styleTexts.join("\n\n")}`,
			);
		}
		if (presetTail.boundaryTexts.length > 0) {
			blocks.push(`【行为边界】写作时刻刻要守（从落笔起生效）：\n${presetTail.boundaryTexts.join("\n\n")}`);
		}
	}

	// 末端导演备注：上下文末尾权重最大，语言与主权纪律钉在这里。
	// P9：一个提醒一件事——状态栏/思考用法各自成块，不挤在导演备注里互相稀释。
	const notes: string[] = [];
	if (card.postHistoryInstructions) {
		notes.push(applyMacros(card.postHistoryInstructions, macro));
	}
	if (presetActive) {
		notes.push(`以${config.language}写叙事与对白（专有名词可保留原文）；人称视角与代言/抢话边界按用户预设执行。`);
	} else {
		notes.push(`以${config.language}写叙事与对白（专有名词可保留原文）；不替 ${config.userName} 行动、说话或代述想法。`);
	}
	// 篇幅：一次性任务信息，不是待通过的考试。
	//
	// 旧文案「由验收器核验，写作时朝这个量落笔即可」把篇幅变成了落笔前必须对准的
	// 总量目标，而它又坐在末端注入（权重最高、紧贴用户话）的位置上——8/08 实弹里
	// 模型逐字引用这一行后当场在思考里写完整篇初稿（13587 字思考），清单退化成
	// 事后补登记。故：去掉验收暗示与「朝这个量落笔」的规划指令，只留一句背景信息，
	// 并让它排在导演备注靠前的位置，把末尾权重留给语言/主权/状态栏这些真纪律。
	if (wordRange) {
		notes.push(`这一拍大约 ${wordRange.min}–${wordRange.max} 字（不含状态栏等格式区块），心里有数即可，不必核算。`);
	} else if (presetActive) {
		notes.push(`篇幅与格式优先遵循上方预设要求（若有）。`);
	} else {
		notes.push(`这一拍可见正文约 800–1500 字（短打约 400），心里有数即可。`);
	}
	notes.push(`演完本拍即停，停在 ${config.userName} 可接话处；不连演多拍，不写总结式收场白。`);
	blocks.push(`【导演备注】\n${notes.join("\n")}`);

	// 状态栏独立成块（P9：一个提醒一件事，不挤进导演备注）。
	// 时序与谢幕链对齐（8/09 输出形式）：状态栏是本拍**最后**的产出——
	// seal 回执、收笔评估卡、程序化谢幕说的都是同一件事，这里不能说成「正文之后」
	// 就完事，否则模型在续写/ask 未完时提前输出（实弹：状态栏出完又问试墨）。
	if (statusBarFormats && statusBarFormats.length > 0) {
		const placeholders = statusBarFormats.filter(isPlaceholderStatusFormat);
		const panels = statusBarFormats.filter((f) => !isPlaceholderStatusFormat(f));
		if (placeholders.length > 0 && panels.length === 0) {
			blocks.push(
				`【状态栏】本卡扮演的一部分：本拍所有剧情（含续写与 ask）完成后，原样输出 ${placeholders.join(" 或 ")}（自闭合占位符，界面由卡渲染）。状态栏意味着本拍结束——它必须是最后的产出，漏写即未完成本拍。`,
			);
		} else {
			blocks.push(
				`【状态栏】本卡扮演的一部分：本拍所有剧情（含续写与 ask）完成后，输出状态栏，格式 ${statusBarFormats.join(" 或 ")}，字段随本拍剧情更新。状态栏意味着本拍结束——它必须是最后的产出，漏写即未完成本拍。`,
			);
		}
	}
	if (languageMismatch) {
		blocks.push(
			`【语言纠正】你上一拍使用了错误的语言。从本拍起，全部叙事与对白必须使用${config.language}（专有名词可保留原文）。这是硬性要求，立即纠正。`,
		);
	}
	// M4.5 给排练断粮（慢因 A）：思考通道的职能被 harness 逐项接管后，明示它只剩读题与决定。
	// 8/08 修正：旧文案连「构思」一起禁了，与「先 beat_plan 列路标」的协议自相矛盾——
	// 网页版对照实验证明，分步骤+抽象配额是模型写命题作文的天然健康策略，该留；
	// 病的是把构思写成成段正文。故此处只禁起草文字。
	// 8/08 晚二次修正：本块是**每拍都在的静态注入**（规划轮也在场）——分轮职责
	// （当前段怎么演/要不要 ask/路标是否重拟/戏是否到停点）只准出现在演段回看卡
	// （roundCardFor，appends>0 才注入）。写在这里会泄漏给第 1 轮，把规划轮思考
	// 撑到 3k 字（20:13 实弹 3034 字复现）。本块只留轮次无关的纯纪律。
	if (rehearsalGuard) {
		blocks.push(
			`【思考的用法】思考全程用中文（与正文同语言）。思考与正文的分界：不要在思考里起草或逐句打磨任何一段正文——正文只在稿纸上写。` +
				`也不要在思考里逐条复核禁词、句式、字数：这些由剧场在你收笔后程序化核验，需要改会把原文和违规清单一并交给你定点修订。`,
		);
	}

	return blocks.join("\n\n");
}

/**
 * 检测文本语言是否与目标语言失配。v0 只实现中文目标的检测
 * （其他语言返回 false，不误报）。用于 harness 级语言自愈。
 */
export function detectsLanguageMismatch(text: string, language: string): boolean {
	if (!/中文|汉语|chinese/i.test(language)) return false;
	const letters = text.match(/\p{L}/gu) ?? [];
	if (letters.length < 40) return false; // 样本太短不判定
	const cjk = letters.filter((ch) => /\p{Script=Han}/u.test(ch)).length;
	return cjk / letters.length < 0.3;
}
