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
import { applyCardSkin } from "../cardSkin.ts";
import { applyDraftOps, type DraftMsgLike } from "../draft.ts";
import { cleanAssistantText } from "../postprocess.ts";
import { formatState, defaultState } from "../state.ts";
import { isBackstageText } from "../stance.ts";
import type { DisplayRule } from "../cardfront.ts";
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
 * promptRules：作者正则里 promptOnly / 破坏性那批（对齐酒馆送模侧，engine.js:352）。
 * 挂在**策略引擎之前**跑——cleanAssistantText 的 unwrap 会先拆掉 <w2g> 等标签，
 * 正则必须先于它应用（与显示层「禁止 unwrap 先于作者正则」同一条纪律）。
 *
 * M4：有 rp-summary 时，被覆盖的早期条目整段不进历史，改由 summary 字段回读为【前情提要】。
 */
export function rebuildHistory(branch: BranchEntryLike[], promptRules: DisplayRule[] = []): RebuiltHistory {
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
		// 送模侧作者正则（promptOnly/破坏性）剥「作者不想让模型看」的块——必须在策略引擎
		// **之前**跑：cleanAssistantText 的 unwrap 会先拆掉 <w2g> 等标签，晚了正则打空
		// （与显示层「禁止 unwrap 先于作者正则」同一条纪律）。
		if (promptRules.length > 0) text = applyCardSkin(text, promptRules, { charName: "", userName: "" });
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

export interface StageSystemOptions {
	card: CharacterCard;
	config: RpConfig;
	constantLore: LorebookEntry[];
	/**
	 * 预设装配产物（历史前段）：原文、原序，marker 槽位已由预设作者的位置填入梨园材料。
	 * 它是 system prompt 的**主体**，排在最前——harness 骨架殿后（PLAN-PRESET-PIPELINES §四之四）。
	 */
	presetBefore?: string[];
	/**
	 * 预设声明过的 marker 槽位 id。没声明的槽位，梨园按兜底版式补上——
	 * 否则旧格式预设（无 marker）会让角色卡整个丢失。
	 */
	declaredMarkers?: Set<string>;
	/** skill 素材位（M-R2）：常驻包正文进 system；拉取包进 L1 索引 */
	skills?: Array<{ name: string; description: string; resident: boolean; body: string }>;
	/** false = 不声明工具协议（M1 前过渡形态；M3 起默认开） */
	tools?: boolean;
	/**
	 * MCP 外设工具（8/06 重接）：本会话已连接的 mcp__ 工具，空/省略＝只字不提。
	 * 进 system 而非每拍注入——会话内字节稳定，不破前缀缓存（与旧 director.ts 同位置）。
	 */
	mcpTools?: Array<{ name: string; description: string }>;
}

export function buildStageSystemPrompt({
	card,
	config,
	constantLore,
	presetBefore,
	declaredMarkers,
	skills,
	tools,
	mcpTools,
}: StageSystemOptions): string {
	const macro: MacroContext = { charName: card.name, userName: config.userName };
	const m = (s: string) => applyMacros(s, macro);
	const sections: string[] = [];
	const declared = declaredMarkers ?? new Set<string>();

	// 0) 梨园架构段：讲清脚下的机器怎么转（轮次、思考/扮演/写作三活动的位置、注入帧），供预设自行适配。
	//    只写架构，不写角色（碰破限）、不教写作（那是预设的教导权）、不举写作细节（工具描述里已有）。
	//    先于预设装配段：模型最先读到梨园怎么运转，再读预设教它演什么。
	sections.push(
		`# 梨园运行架构
每拍按轮次推进，思考、扮演、写作在轮次中分开进行。
- 首轮只规划：读题、探索、请用户定夺、列路标。路标是这一步的剧情走向，只到这一步为止。
- 扮演轮逐路标推进：思考本路标剧情 → 构思怎么落笔 → 产出正文段落 → 推进路标。
- 每轮出现的【进度】【判定】【记账】是当前状态，以它为准。`,
	);

	// 1) 预设装配段：原文原序，零 harness 引导语。卡/世界书/人设已在预设作者指定的槽位里。
	if (presetBefore && presetBefore.length > 0) sections.push(presetBefore.join("\n\n"));

	// 2) 兜底：预设没声明的 marker 槽位，梨园按自己的版式补——补的是位置，不是措辞之外的话。
	const charParts: string[] = [];
	if (!declared.has("charDescription") && card.description) charParts.push(m(card.description));
	if (!declared.has("charPersonality") && card.personality) charParts.push(`## 性格\n${m(card.personality)}`);
	if (!declared.has("scenario") && card.scenario) charParts.push(`## 当前场景\n${m(card.scenario)}`);
	if (!declared.has("dialogueExamples") && card.mesExample) {
		charParts.push(`## 对白示例（仅供文风与语气参考，不是已发生的剧情）\n${m(card.mesExample)}`);
	}
	if (charParts.length > 0) sections.push([`# 你扮演的角色：${card.name}`, ...charParts].join("\n\n"));

	if (!declared.has("personaDescription")) {
		sections.push(
			[
				`# 用户扮演：${config.userName}`,
				config.userPersona ? m(config.userPersona) : `（${config.userName} 的具体形象由用户在剧情中自行呈现）`,
			].join("\n"),
		);
	}

	if (!declared.has("worldInfoBefore") && !declared.has("worldInfoAfter") && constantLore.length > 0) {
		const loreText = constantLore.map((e) => `- ${e.comment ? `【${e.comment}】` : ""}${m(e.content)}`).join("\n");
		sections.push(`# 世界设定（常驻事实）\n${loreText}`);
	}

	// 3) harness 骨架殿后：梨园自己的协议面，与预设作者的字分开。
	sections.push(
		`# 舞台
你在进行一场长篇沉浸式角色扮演：扮演 ${card.name}，以及剧情需要的一切配角、路人与世界本身。用户扮演 ${config.userName}。`,
	);

	// M-R1（PLAN-RECTIFY §2.1-5）：纯协议，零扮演词。扮演的每个字都有署名主人（P1）。
	if (tools !== false) {
		sections.push(
			`# 工作方式
每拍第 1 轮用 \`beat_plan\` 列路标（没有戏的拍可 \`draft_write\` 一次交完）；正文用 \`draft_append\` 逐路标写在稿纸上，写完 \`draft_seal\` 收笔。剧情走向要用户拍板时随时 \`ask\`。每轮注入的【进度】【判定】【记账】【谢幕】是当前状态，以它为准。`,
		);
	}

	// skill 素材位（M-R2 §4.C）：常驻包正文随 system 送达（署名数据，零 harness 引导语）；
		// 非驻留 skill 的清单不在这里——由「skill指导」每轮必读时动态生成（一张表），此处零重复。
	if (skills && skills.length > 0) {
		for (const sk of skills.filter((x) => x.resident)) {
			sections.push(`# skill：${sk.name}（常驻）\n${sk.body}`);
		}
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
- 标注【登场名录】的消息是登场过但已不在当前状态的条目索引（离场/失去/了结）${tools !== false ? "，细节可用 `memory_search` 查" : ""}；名录之外的名字才是新登场。
- 标注【活跃面板】的消息是各面板的当前内容（用户可能手改过），其中事实为准。
- 标注【相关设定】的消息是自动附上的世界书参考，按需取用。
- 标注【设定集索引】的消息是设定条目的标题索引${tools !== false ? "，内容未出现在【相关设定】时可用 `lorebook_search` 取原文" : ""}。
- 标注【剧情记忆】的消息是历史正文检索片段，按需取用，勿整段照抄。`,
	);

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
	/** M-R1：postHistory 通道的预设常驻内容（引擎每拍按真实求值内容拆层产出），原文原序 */
	presetTail?: string[];
	/** 上一拍台上叙事语言与配置不符（harness 检测） */
	languageMismatch?: boolean;
	/** 活跃面板全文快照（formatPanelSnapshot 产出）或一行速览 */
	panelIndex?: string;
	/** 预设字数规则（extractDraftRules 提取）——纯事实一行，无落笔指令（P2） */
	wordRange?: { min: number; max: number };
	/** 设定集索引行（formatLoreIndex 产出） */
	loreIndex?: string;
	/** 登场名录索引行（formatRosterIndex 产出） */
	rosterIndex?: string;
}

/**
 * 每拍注入消息流末端的动态内容（以 user 角色送达）。
 *
 * M-R1（PLAN-RECTIFY §2.2）：全部是事实块——数据带【标注】送达，语义在 system
 * 「消息流约定」里一次说清，不逐拍复述。【导演备注】容器解散：卡末端指令独立成块，
 * 主权兜底迁默认预设，「演完即停」由判定/谢幕的日程表达；【状态栏】【思考的用法】退场。
 */
export function buildStageInjection({
	state,
	activatedLore,
	card,
	config,
	presetTail,
	languageMismatch,
	panelIndex,
	wordRange,
	loreIndex,
	rosterIndex,
}: StageInjectionOptions): string {
	const macro: MacroContext = { charName: card.name, userName: config.userName };
	const blocks: string[] = [];

	blocks.push(`【世界状态】\n${formatState(state)}`);

	if (rosterIndex) {
		blocks.push(`【登场名录】${rosterIndex}`);
	}

	if (panelIndex) {
		blocks.push(`【活跃面板】\n${panelIndex}`);
	}

	if (activatedLore.length > 0) {
		const lore = activatedLore
			.map((e) => `- ${e.comment ? `【${e.comment}】` : ""}${applyMacros(e.content, macro)}`)
			.join("\n");
		blocks.push(`【相关设定】\n${lore}`);
	}

	if (loreIndex) {
		blocks.push(`【设定集索引】${loreIndex}`);
	}

	// 预设末端内容：原文直通，零归拢零引导语（M-R1）
	if (presetTail && presetTail.length > 0) {
		blocks.push(`【预设末端指令】\n${presetTail.join("\n\n")}`);
	}

	// 卡末端指令：独立块（旧【导演备注】容器解散后的存留者——卡数据，原文直通）
	if (card.postHistoryInstructions) {
		blocks.push(`【卡作者末端指令】\n${applyMacros(card.postHistoryInstructions, macro)}`);
	}

	blocks.push(`【语言】以${config.language}写叙事与对白（专有名词可保留原文）。`);

	// 字数一行：纯事实（无「朝这个量落笔」类指令）；无目标不出行
	if (wordRange) {
		blocks.push(`本拍约 ${wordRange.min}–${wordRange.max} 字`);
	}

	if (languageMismatch) {
		blocks.push(
			`【语言纠正】你上一拍使用了错误的语言。从本拍起，全部叙事与对白必须使用${config.language}（专有名词可保留原文）。这是硬性要求，立即纠正。`,
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
