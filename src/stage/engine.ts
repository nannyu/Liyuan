/**
 * 台上引擎（PLAN-RP-HARNESS M1）——RP 原生回合循环（R1 循环自持）。
 *
 * 一拍 = 装配（f(分支)）→ 一次流式生成（M1 零工具）→ assistant 落树 → 谢幕。
 * 没有 steer/followUp 队列，没有续轮判定：harness 知道自己在哪一幕。
 *
 * 竞态两律（R9）在此落地：
 * - 回合互斥：忙时新输入进队列，本拍收尾后依序开演；
 * - 谢幕由 harness 判定：流结束即收轮，不存在模型可续的循环。
 *
 * 依赖全部注入（SessionManager / 模型 / 流函数），可用 faux provider 离线整测。
 */

import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

import { applyProjectedSamplers } from "../samplers.ts";
import { extractDraftRules } from "../draft.ts";
import {
	appendOverlayEntry,
	loreFingerprint,
	overlayPathFor,
	scanEntries,
	searchEntries,
} from "../lorebook.ts";
import { loadCodexEntries } from "../codex.ts";
import { formatPanelIndex, formatPanelSnapshot, loadPanels } from "../panels.ts";
import { dir } from "../paths.ts";
import {
	lookupBlockRule,
	reportItemFor,
	splitBlockContent,
	type AssemblyReportItem,
} from "../preset-split.ts";
import { formatRosterIndex, formatState, saveState } from "../state.ts";
import { isBackstageText } from "../stance.ts";
import type { LorebookEntry } from "../types.ts";
import {
	buildStageInjection,
	buildStageSystemPrompt,
	codexNamesFromBranch,
	detectsLanguageMismatch,
	formatLoreIndex,
	rebuildHistory,
	stateFromBranch,
	type BranchEntryLike,
	type PresetResidentContent,
} from "./assemble.ts";
import {
	constantLoreOf,
	evalPostHistoryBlocks,
	loadStageConfig,
	loadStageMaterials,
	type StageMaterials,
} from "./materials.ts";
import {
	MANUAL_MIN_COMPACT_CHARS,
	runCompaction,
	SUMMARY_ENTRY_TYPE,
	type CompactOutcome,
	type RpSummaryData,
} from "./compact.ts";
import { runScribeTurn, STATE_ENTRY_TYPE } from "./scribe-run.ts";
import { runRosterRefresh } from "./roster-refresh.ts";
import {
	MAX_ROUNDS,
	runStageTool,
	stageTools,
	writeTools,
	writingGuideTool,
	type MemoryHitLike,
	type StageTool,
	type StageToolDeps,
	type ToolRunResult,
} from "./tools.ts";
import { unifiedStageToolNames } from "../tools/adapters/stage.ts";
import {
	mcpStageTools,
	mcpStageToolNames,
	runMcpStageTool,
	type McpStageDeps,
} from "./mcp-stage.ts";
import {
	mediaStageToolNames,
	mediaStageTools,
	runMediaStageTool,
	type MediaStageResult,
} from "./media-stage.ts";
import { assistantStageTool, runAssistantStageTool } from "./assistant-stage.ts";
import type { MemoryChunkLike } from "../tools/memory.ts";
import { extractDraftBody, hasFormatTag } from "../draft.ts";
import {
	createWorkspace,
	finalTimeline,
	splitDraftSegments,
	projectedState,
	recordSegment,
	runWriteTool,
	type TurnWorkspace,
	type WorkspaceDeps,
} from "./workspace.ts";

// ---------------- 依赖面（结构类型，不引 @liyuan/agent-runtime） ----------------

export interface StageSessionManager {
	getBranch(): unknown[];
	getLeafId(): string | null;
	appendMessage(message: unknown): string;
	appendCustomMessageEntry(customType: string, content: string, display: boolean): string;
	/** CustomEntry（不进 LLM 上下文）：账本快照用 */
	appendCustomEntry(customType: string, data?: unknown): string;
	getSessionId(): string;
	flush(): void;
}

export interface StageModelLike {
	id: string;
	provider?: string;
	api?: unknown;
	baseUrl?: string;
	[k: string]: unknown;
}

/** @liyuan/ai streamSimple 的结构子集 */
export type StageStreamFn = (
	model: StageModelLike,
	context: { systemPrompt?: string; messages: unknown[] },
	options?: Record<string, unknown>,
) => AsyncIterable<StageStreamEvent> & { result(): Promise<AssistantMsgLike> };

export interface AssistantMsgLike {
	role: "assistant";
	content: Array<{
		type: string;
		text?: string;
		thinking?: string;
		name?: string;
		arguments?: Record<string, unknown>;
	}>;
	stopReason?: string;
	errorMessage?: string;
	[k: string]: unknown;
}

export interface StageStreamEvent {
	type: string;
	delta?: string;
	contentIndex?: number;
	toolCall?: { name?: string; arguments?: Record<string, unknown> };
	partial?: AssistantMsgLike;
	message?: AssistantMsgLike;
	error?: AssistantMsgLike;
}

export interface StageTurnEndInfo {
	aborted: boolean;
	/** 非空 = 本拍以错误收场（已通知，无正文落树） */
	error?: string;
	/** 落树的 assistant 条目 id（错误/空拍时无） */
	entryId?: string;
}

export interface StageEvents {
	onTurnStart?: () => void;
	/** 流式增量（转 WS delta 帧；kind 对应正文/思考通道） */
	/**
	 * 流式增量。draft=true 表示该增量是 draft_write 参数的转发
	 * （稿件流 = 替换语义：多稿重交原地更新，前端不得叠加）；
	 * reset=true 表示本次调用的首个分片（前端据此清掉旧稿）。
	 */
	onDelta?: (kind: "text" | "thinking", delta: string, draft?: boolean, reset?: boolean) => void;
	/**
	 * 中间轮旁白清理：稿落地前的工具轮吐出的 text（读题/计划旁白）已流式上屏，
	 * 但不是正文——通知前端把它收进过程条并从正文区移除（8/09 实弹：读题文字
	 * 先挂在正文顶部、落树后又拼到正文尾部）。
	 */
	onStreamClear?: () => void;
	/**
	 * 稿件分段重同步（修复后）：前端把屏上全部稿段**原位**替换为 segments。
	 * 与 onDelta 的稿件流互补——流式分片管「一段段长出来」，resync 管「原地变新」：
	 * draft_edit 改稿成功后按当前稿全量重切下发，修后的段就是用户看到的段。
	 */
	onDraftResync?: (segments: string[]) => void;
	onTurnEnd?: (info: StageTurnEndInfo) => void;
	/** 面向用户的告警（宏降级等）；每种只发一次 */
	onNotify?: (level: "info" | "warning" | "error", text: string) => void;
	/** 过程条短句（验收/修订进度；kind:"note" 形态，无需工具名） */
	onActivity?: (detail: string) => void;
}

export interface StageEngineDeps {
	cwd: string;
	getSessionManager: () => StageSessionManager;
	getModel: () => StageModelLike | undefined;
	getAuth: (model: StageModelLike) => Promise<{ apiKey?: string; headers?: Record<string, string> }>;
	/** 会话当前思考档（用户自由，引擎透传） */
	getThinking?: () => string | undefined;
	/** 账本磁盘缓存路径（.liyuan-state/<sessionId>.json）；给出则场记落盘（fs.watch → state 帧） */
	getStateFile?: (sessionId: string) => string | undefined;
	/** 剧情库检索（memory_search 工具用）；未注入 = 该工具恒返回无命中 */
	searchMemory?: (sessionId: string, query: string) => Promise<MemoryHitLike[]>;
	/**
	 * 向量库写侧三件（M-D3）。均由宿主按「当前对话 + 当前卡」绑定 MemoryScope 后注入——
	 * **作用域不经模型**（PLAN-RP-TOOLING M-D3：scope 全隐藏），引擎只透传 sessionId。
	 * 未注入 = 台上无对应工具（依赖缺失的工具不上清单）。
	 */
	addMemory?: (
		sessionId: string,
		input: { text: string; title?: string },
	) => Promise<{ added: number; total: number; chunks: number }>;
	listMemory?: (sessionId: string, storeId: string) => MemoryChunkLike[];
	deleteMemory?: (sessionId: string, storeId: string, id: string) => boolean;
	/**
	 * 面板读写（M-D5）。由宿主按当前会话绑定 artifacts 文件后注入。
	 * 未注入 = 台上无面板工具（依赖缺失的工具不上清单）。
	 */
	loadPanels?: (sessionId: string) => Record<string, { name: string; kind: "markdown" | "svg" | "html"; content: string; archived?: boolean }>;
	writePanel?: (sessionId: string, input: { name: string; kind: string; content: string }) => { ok: true; created: boolean; reopened: boolean; activeCount: number; overLimit: boolean } | { ok: false; error: string };
	closePanel?: (sessionId: string, name: string) => { ok: boolean; error?: string };
	/** 被压缩裁掉的早期正文归档进剧情库（供 memory_search 召回细节）；未注入 = 只落摘要不归档 */
	archiveCompacted?: (sessionId: string, text: string) => Promise<void>;
	/**
	 * 世界书条目启停落盘（lorebook_toggle 工具用，M-D2）：写 config.disabledLore 并重装素材。
	 * 由宿主注入——落盘与热重载归 server/ 侧（引擎不碰 server 的 writeJsonWithBackup）。
	 * 未注入 = 台上无 lorebook_toggle 工具。
	 */
	setDisabledLore?: (fingerprints: string[], enabled: boolean) => number;
	/**
	 * MCP 外设（8/06 重新接线）：宿主注入 hub 的两个能力，台上据此挂 mcp__ 工具。
	 * 未注入 = 台上无 MCP 工具（依赖缺失的工具不上清单）。
	 * hub 单例由宿主持有——引擎不自建，避免第二个实例（见 src/mcp.ts 的 globalThis 槽）。
	 */
	mcp?: McpStageDeps;
	/**
	 * 媒体交付工具（8/06 重接）：show_image/audio/video/html + tts。
	 * 与 MCP 同源的断链——消费端（wire.ts）一直健在，缺的是台上生产端。
	 * false/省略 = 不挂（tts 另需服务端 TTS 环境，由 ttsAvailable 决定）。
	 */
	media?: boolean;
	/** TTS 环境是否就绪（未就绪则 tts 不上清单——依赖缺失的工具不上清单） */
	ttsAvailable?: () => boolean;
	/**
	 * 剧情决策询问（ask 工具，P7 接回）：弹出选择卡等用户应答。
	 * 应答 = 用户选择的选项原文（作为新输入回喂模型，计划据此重拟）；
	 * undefined = 用户停止（笔还给用户，本拍收束）。
	 * 未注入 = 台上无 ask 工具（依赖缺失的工具不上清单）。
	 */
	askUser?: (question: string, options: string[], signal?: AbortSignal) => Promise<string | undefined>;
	streamFn: StageStreamFn;
	events?: StageEvents;
}

// ---------------- 引擎 ----------------

const nowMsg = (text: string) => ({
	role: "user",
	content: [{ type: "text", text }],
	timestamp: Date.now(),
});

const textOfAssistant = (m: AssistantMsgLike | null): string => {
	if (!m) return "";
	return m.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("")
		.trim();
};

/**
 * 轮次卡（P1 注入层）：按工作区状态给出「你现在在第几步」的显式信号。
 *
 * 对照 opencode 的 plan-mode / build-switch 每轮注入：模型从注入状态知道自己
 * 在流程的哪个位置，而不是从静态系统提示词里猜。卡只在状态切换时注入一轮
 * （见 agentLoop 的 lastCard 去重），不在历史里累积。
 */
function roundCardFor(
	ws: TurnWorkspace,
	userName: string,
	wordRange?: { min: number; max: number },
	statusBarTags?: string[],
): string | undefined {
	if (ws.plan.length === 0 && ws.draft.trim() === "") {
		const range = wordRange ? `，本拍总字数约 ${wordRange.min}–${wordRange.max} 字，列路标时把字数分配到每一步（几步就分几份，心里有数）` : "";
		return (
			`【第 1 步·规划】你还没有落笔、也还没有计划。这一轮思考只做三件事：` +
			`读题（谁在场、上文到哪、用户要什么）、探索（拿不准就查设定/记忆/账本）、` +
			`列路标（\`beat_plan\`）${range}。\`beat_plan\` 被接受前，不要落任何正文。` +
			`预设的文风与行为边界从落笔起生效，这一轮不用逐条读。\n` +
			`用户输入本身在求方向/递笔的（「接下来去找谁」「给个选项」）——直接 \`ask\`，那不需要上文。` +
			`读题发现的**未定型重大变量**（如新人物还没定的性格/立场）——不要脑补定型：记着它，` +
			`演到它实际影响剧情的段落之前再 \`ask\` 请用户定（那时用户手里有上文才好选；哪些变量值得问是动态的，` +
			`看它此刻对剧情的影响程度，不是新的就要问）。\n` +
			`**路标只写到「发生什么」的抽象层**（如「被值守弟子拦下」「褪衣取砚」）——` +
			`具体怎么演（动作的先后、神态的变化、对白的语气、情绪的流转）留给演到那一段时再想，` +
			`不要在这一轮预演各段的细节。\n` +
			`思考全程用中文，与正文同语言。`
		);
	}
	if (ws.plan.length > 0 && ws.appends === 0 && ws.draft.trim() === "") {
		return (
			`【开工】计划已接受。从现在起进入演出：把自己当成一位资深作家，发挥强大的剧情构思能力，肆意展现你的文笔。` +
			`按第一条未完成的演，一段一段交（\`draft_append\`，一个自然段就交）。正文只在稿纸上诞生。思考全程用中文，与正文同语言。`
		);
	}
	// 修复卡（8/09 问题：修复注入缺失）：上一段验收出的违规未修，优先注入修复指令——
	// 否则模型被「演段回看卡」的构思引导带走，把修复攒到末尾统一做（实弹：四段写完才修）。
	// 修复是这一步唯一该做的事：先修干净，再谈下一段。
	if (ws.appends > 0 && ws.pendingViolations.length > 0) {
		return (
			`【修复】上一段还有 ${ws.pendingViolations.length} 处未修：\n` +
			ws.pendingViolations.map((v) => `- ${v}`).join("\n") +
			`\n先用 \`draft_edit\` 逐处修掉（old 逐字引用现稿原文、须唯一，可一次给多处），` +
			`验收过了再构思下一段——已经交给用户看的段落必须是定稿。\n思考全程用中文。`
		);
	}
	// 谢幕卡（8/09 review）：已封笔后不再催演/催构思——sealed 语境下回看/续写/
	// 收笔评估卡全部失效（实弹：seal 后的记账轮被回看卡催「构思下一段」）。
	// 封笔后的剩余正务只有记账与谢幕：状态栏等格式块是本拍最后的产出。
	if (ws.appends > 0 && ws.sealed) {
		const sb =
			statusBarTags && statusBarTags.length > 0
				? `然后输出状态栏（${statusBarTags.map((t) => `<${t}>`).join(" 或 ")}）等格式块——` +
					`状态栏意味着本拍结束，输出完即停`
				: `没有格式块要输出就直接停笔`;
		return `【谢幕】已封笔，不要再写正文。世界有变动就先 \`world_state_update\` 记账；${sb}。`;
	}
	if (ws.appends > 0 && ws.plan.some((s) => !s.done)) {
		return (
			`【演段回看】已演 ${ws.appends} 段。你需要在落笔前完成这一轮的工作：\n` +
			`\u2460 回看：读一遍刚写下的段落，接住它的气口。\n` +
			`\u2461 构思剧情走向：发挥自己职业作家的水平，思考这一段剧情往哪走、人物此刻的状态与下一步的抉择。\n` +
			`\u2462 全力构思文笔：倾尽所有的去构思这一段怎么写得精彩——镜头、动作、感官细节、神态情绪、节奏、点睛。力求为用户提供最好的体验。\n` +
			`\u2463 按需调写作方法论：写作上拿不准就调 \`writing_guide\` 读对应主题（general/nsfw），读完照着写。\n` +
			`\u2464 重新评估：剧情到岔路就用 \`ask\` 问用户；路标不成立就重拟 \`beat_plan\`；戏到停点就收笔——收笔前先确认自然下文是否涉及 ${userName} 的行动或选择，涉及就先 \`ask\`，再 \`draft_seal\`（清单没勾完也没关系）。\n` +
			`思考全程用中文。正文只在稿纸上写——思考里想戏与文笔，落笔交给 \`draft_append\`。`
		);
	}
	// 路标已全部演完（或本来就没有计划）：这一拍的主体已完成。按字数决定去向——
	// 字数不够 → 续写自然下文（8/09 定案：续写是「用户输入少 + 字数目标高」时的出口，
	// 模型绞尽脑汁扩写不如承接世界书里的下一步；续写会自然走到岔路触发 ask，
	// 也杜绝了「路标演完自由发散」——扶南女王那次就是没有续写出口、卡催构思导致的）。
	// 字数达标 → 收笔评估。
	const draftBodyChars = ws.draft.trim() ? extractDraftBody(ws.draft).replace(/\s+/g, "").length : 0;
	if (ws.appends > 0) {
		if (wordRange && draftBodyChars < wordRange.min) {
			return (
				`【续写】路标已全部演完，但本拍正文还没到目标（当前约 ${draftBodyChars} 字 / 目标 ${wordRange.min}–${wordRange.max} 字）。` +
				`承接刚写下的，续写这一拍的自然下文——设定/世界书里的下一步（如「润墨之后的试墨」）。一段一段演。\n` +
				`续写中涉及 ${userName} 的行动或选择，用 \`ask\` 停下来问；` +
				`写到字数达标、戏到停点，用 \`draft_seal\` 收笔。` +
				`状态栏等格式块是本拍**最后**的产出——续写全部完成之前不要输出。思考全程用中文。`
			);
		}
		// 收笔评估卡（8/09 卡序纠正）：ask/续写判断必须在 seal **之前**——旧卡把
		// 「到停点就 seal」排在第一步，模型照卡执行：封完笔才评估出「下文是用户的
		// 行动、该 ask」，全成马后炮（实弹：想 ask 却已 seal，转头记账收场，
		// ask 没发、状态栏也没了，还替用户把下一步演进了正文）。卡序 = 行为序。
		return (
			`【收笔评估】路标已全部演完，戏到了一个停点。按顺序评估，评估完再动手：\n` +
			`① 这一拍的自然下文是否涉及 ${userName} 的行动或选择（如「润墨之后该试墨」）——` +
			`涉及就先用 \`ask\` 问用户、按答案续写，此时不要收笔；\n` +
			`② 不涉及，再看剧情是否停在 ${userName} 可以接话、可以行动的位置——不在就续写到停点；\n` +
			`③ 以上都满足，\`draft_seal\` 收笔；\n` +
			`④ 封笔之后最后一步：输出状态栏等格式块——状态栏意味着本拍结束，` +
			`必须是这拍的最后产出（续写/ask 全部完成之前不要输出）。\n` +
			`思考全程用中文。`
		);
	}
	return undefined;
}

/**
 * 定稿合并：稿件为主体；text 通道里**格式特征**的尾巴（状态栏占位 / catsay / w2g…）
 * 拼回，纯文本增量（闲聊收笔）丢弃——树上正文 = 用户最终该看到的全部内容。
 *
 * 模型常把 draft_write 理解成「交正文」，把格式栈尾巴走普通 text 通道输出。
 * 旧逻辑 `ws.draft.trim() ? ws.draft : text` 是二选一，尾巴连同 token 一起被丢弃
 * （8/05 实锤：模型思考里宣告「body, status bar, and cat commentary」，
 * draft_write 只交了 679 字正文，状态栏与咪咪点评凭空蒸发）。
 * 但也不能无脑全拼——纯文本尾巴（"就这样吧。"）是收笔闲聊，不该进正文。
 */
const FORMAT_TAIL_RE = /<(?:[A-Za-z_\u4e00-\u9fff][\w\u4e00-\u9fff.\-]*)(?:\s[^>]*)?\/?\s*>/;
const looksLikeFormatTail = (tail: string): boolean =>
	FORMAT_TAIL_RE.test(tail) || /^```/m.test(tail);

const mergeFinalText = (draft: string, text: string): string => {
	const d = draft.trim();
	const t = text.trim();
	if (!d) return t;
	if (!t || d === t) return d;
	// 稿件已包含 text（模型边写边交，text 是半截）：稿件已是全量
	if (d.includes(t)) return d;
	// text 含稿件：取稿件之后的增量（尾巴在后）；不含：整段视作尾巴
	const idx = t.indexOf(d);
	const tail = idx >= 0 ? t.slice(idx + d.length) : t;
	if (!looksLikeFormatTail(tail)) return d;
	return [d, tail].filter(Boolean).join("\n\n");
};

/**
 * 收尾放行门控：上一轮（或首轮）思考宣告了「还要写格式栈尾巴」才多给一轮。
 * 无条件放行会多拉一轮 LLM，把场记兜底响应当叙事轮消费（8/05 测试实证）；
 * 而 8/05 实弹里模型确实在思考里宣告过 status bar / cat commentary。
 */
const TAIL_INTENT_RE =
	/(状态栏|点评|选择框|选项|摘要|咪咪|猫猫|吐槽|catsay|w2g|status|summary|choice|comment)/i;
const hasTailIntent = (m: AssistantMsgLike | null): boolean => {
	if (!m || !Array.isArray(m.content)) return false;
	const think = m.content
		.filter((c): c is { type: string; thinking?: string } => c.type === "thinking")
		.map((c) => c.thinking ?? "")
		.join("");
	return TAIL_INTENT_RE.test(think);
};

export class StageEngine {
	#deps: StageEngineDeps;
	#busy = false;
	#queue: string[] = [];
	#abort: AbortController | null = null;
	#warnedMacros = "";
	#warnedAuditDrop = 0;
	#warnedProtocolDrop = "";
	#lastAssemblyJson = "";

	constructor(deps: StageEngineDeps) {
		this.#deps = deps;
	}

	get isStreaming(): boolean {
		return this.#busy;
	}

	/** 用户新输入开一拍：先落 user 消息再开演；忙时排队（流式中送达的输入不打断叙事） */
	async performTurn(userText: string): Promise<void> {
		if (this.#busy) {
			this.#queue.push(userText);
			return;
		}
		await this.#run(userText);
		await this.#drain();
	}

	/** 再生成：叶已钉在 user（swipe/reroll 已 branch），不追加 user 消息直接开演 */
	async regenerate(): Promise<void> {
		if (this.#busy) return;
		await this.#run(null);
		await this.#drain();
	}

	/** 强制停止本拍：已流出的部分正文仍落树可见 */
	abort(): void {
		this.#abort?.abort();
	}

	async #drain(): Promise<void> {
		while (this.#queue.length > 0 && !this.#busy) {
			const next = this.#queue.shift();
			if (next !== undefined) await this.#run(next);
		}
	}

	async #run(userText: string | null): Promise<void> {
		const ev = this.#deps.events ?? {};
		this.#busy = true;
		ev.onTurnStart?.();
		let endInfo: StageTurnEndInfo = { aborted: false };
		try {
			endInfo = await this.#turn(userText);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			ev.onNotify?.("error", `本拍开演失败：${msg}`);
			endInfo = { aborted: false, error: msg };
		} finally {
			this.#busy = false;
			this.#abort = null;
			ev.onTurnEnd?.(endInfo);
		}
	}

	async #turn(userText: string | null): Promise<StageTurnEndInfo> {
		const { cwd, events: ev = {} } = this.#deps;
		const sm = this.#deps.getSessionManager();

		// 素材现读：改卡/改预设/挂书即时生效
		const materials = loadStageMaterials(cwd);
		const { config, card } = materials;
		if (materials.macroWarnings.length > 0) {
			const key = materials.macroWarnings.join(",");
			if (key !== this.#warnedMacros) {
				this.#warnedMacros = key;
				ev.onNotify?.("warning", `预设含未支持的宏（已置空处理）：${materials.macroWarnings.join("、")}`);
			}
		}

		if (userText !== null) {
			sm.appendMessage(nowMsg(userText));
			// 后台任务的接受边界：用户输入先落树并强制物化会话。即使随后无模型、
			// provider 报错或浏览器已经关闭，刷新后也仍能看到自己提交过什么。
			sm.flush();
		}

		const model = this.#deps.getModel();
		if (!model) {
			ev.onNotify?.("error", "尚未配置剧情模型——请先在「连接」面板选择模型。");
			return { aborted: false, error: "no-model" };
		}

		// 上下文 = f(分支)
		const branch = sm.getBranch() as BranchEntryLike[];
		const state = stateFromBranch(branch);
		const { history, lastUserText, lastNarrativeText, summary } = rebuildHistory(branch);
		if (!history.some((m) => m.role === "user")) {
			ev.onNotify?.("error", "没有可开演的用户输入。");
			return { aborted: false, error: "no-user-input" };
		}

		const languageMismatch = lastNarrativeText
			? detectsLanguageMismatch(lastNarrativeText, config.language)
			: false;
		const windowText = history
			.slice(-config.scanDepth)
			.map((m) => m.text)
			.join("\n");
		const activated = scanEntries(materials.entries, windowText, config.maxLoreInjections);

		// 面板快照（M1 读磁盘缓存；写侧与分支化随 M3）
		let panelIndex: string | undefined;
		try {
			const panels = loadPanels(join(dir(cwd, "artifacts"), `${sm.getSessionId()}.json`));
			panelIndex = formatPanelSnapshot(panels) ?? formatPanelIndex(panels) ?? undefined;
		} catch {
			panelIndex = undefined;
		}

		// 旧会话遗留的戏外轮：不注预设末端模板（不按剧情模板硬写）
		const legacyBackstage = !!lastUserText && isBackstageText(lastUserText);

		// postHistory 每拍求值（{{lastusermessage}} 在此生效）+ M-C 拆层分流：
		// A 原文/B/C 归拢进末端；D/E 已在装载期静态入 skillPacks（此处跳过）；G/H/I 退场。
		const phAll = legacyBackstage ? [] : (evalPostHistoryBlocks(materials, lastUserText) ?? []);
		const phTail: PresetResidentContent = { aBlocks: [], styleTexts: [], boundaryTexts: [] };
		const phReport: AssemblyReportItem[] = [];
		for (const b of phAll) {
			if (!b.content.trim()) continue;
			const rule = lookupBlockRule(materials.splitTable, b.name);
			const pieces = splitBlockContent(rule, b.name, b.content);
			for (const r of pieces.resident) {
				if (r.section === "A") phTail.aBlocks.push({ ...b, content: r.text });
				else if (r.section === "B") phTail.styleTexts.push(r.text);
				else phTail.boundaryTexts.push(r.text);
			}
			phReport.push(reportItemFor(pieces, b.name, "postHistory", b.content.length));
		}
		if (materials.auditLinesDropped > 0 && materials.auditLinesDropped !== this.#warnedAuditDrop) {
			this.#warnedAuditDrop = materials.auditLinesDropped;
			console.error(`[stage] 拆层句级过滤：摘掉 ${materials.auditLinesDropped} 行验算指令`);
		}
		// M-C2：外部插件协议条目退场（世界书/卡内嵌通道 H 类）——每套组合只播报一次
		if (materials.protocolDrops.length > 0) {
			const key = materials.protocolDrops.map((d) => `${d.family}:${d.title}`).join("|");
			if (key !== this.#warnedProtocolDrop) {
				this.#warnedProtocolDrop = key;
				const chars = materials.protocolDrops.reduce((n, d) => n + d.chars, 0);
				const titles = materials.protocolDrops.map((d) => `${d.label}「${d.title}」`).join("、");
				console.error(
					`[stage] 外部插件协议退场：${materials.protocolDrops.length} 条 / ${chars} 字（${titles}）——梨园以工具记账，无需模型手写格式块`,
				);
			}
		}

		// 装配报告落盘（PLAN §5.3 可视化）：system 侧静态 + postHistory 侧每拍；内容变了才写
		this.#writeAssemblyReport(cwd, materials, phReport, phTail);

		// M-A 工具组 + M-C writing_guide（skill 包非空才挂——不凭空点名）。
		// 回合工作区 = 正文工件的落点；纪律规则在此提取一次，draft_check 全程复用。
		// 读侧依赖先建：统一层按注入情况决定哪些世界书工具上清单（M-D2）。
		const skillTopics = [...materials.skillPacks.keys()];
		const readDeps = this.#toolDeps(lastUserText);
		// MCP 外设（8/06 重接）：hub 里本会话已连接的工具并入清单。
		// 空数组＝没启用/没连上，与「未注入 mcp 依赖」同效——都不上清单。
		const mcpTools = mcpStageTools(this.#deps.mcp);
		// 媒体交付（8/06 重接）：tts 另需服务端环境，未就绪不上清单
		const mediaOpts = { tts: this.#deps.ttsAvailable?.() === true };
		const mediaTools = this.#deps.media ? mediaStageTools(config.language, mediaOpts) : [];
		// 助手委托（8/06 重接）：runner 未注册时不上清单
		const assistantTool = assistantStageTool();
		// P7：ask 工具依赖宿主注入 askUser（选择卡通道）；未注入则从清单剔除
		const askEnabled = !!this.#deps.askUser;
		const tools = [
			...stageTools(config.language, readDeps),
			...(skillTopics.length > 0 ? [writingGuideTool(config.language, skillTopics)] : []),
			...writeTools(config.language).filter((t) => t.name !== "ask" || askEnabled),
			...mediaTools,
			...(assistantTool ? [assistantTool] : []),
			...mcpTools,
		];
		const ws = createWorkspace();
		const wsDeps: WorkspaceDeps = {
			rules: extractDraftRules(
				[...materials.presetRuleTexts, ...phAll.map((b) => b.content)],
				materials.statusBarFormats,
			),
			userName: config.userName,
			charName: card.name,
			baseState: state,
			...(materials.sovereigntyRelaxed ? { relaxSovereignty: true } : {}),
		};

		const systemPrompt = buildStageSystemPrompt({
			card,
			config,
			constantLore: constantLoreOf(materials),
			presetResident: {
				aBlocks: materials.presetResidentA,
				styleTexts: materials.presetResidentB,
				boundaryTexts: materials.presetResidentC,
			},
			skillTopics,
			presetActive: materials.presetActive,
			statusBarFormats: materials.statusBarFormats,
			tools: tools.length > 0,
			// MCP 外设索引进 system（不进每拍注入）：会话内字节稳定，不破前缀缓存。
			// 与旧 director.ts 同一位置——工具清单里有 mcp__ 工具，这里说明它们是什么。
			mcpTools: mcpTools.map((t) => ({ name: t.name, description: t.description })),
		});
		const injection = buildStageInjection({
			state,
			activatedLore: activated,
			card,
			config,
			presetTail: phTail,
			presetActive: materials.presetActive,
			statusBarFormats: materials.statusBarFormats,
			languageMismatch,
			panelIndex,
			// P14：rehearsalGuard 默认开——「思考的用法」是轮次纪律的一部分（只读题、
			// 不排练正文）。显式置 false 才关闭（速度基线对照用）。
			rehearsalGuard: config.rehearsalGuard !== false,
			...(wsDeps.rules.wordRange ? { wordRange: wsDeps.rules.wordRange } : {}),
			loreIndex: formatLoreIndex(materials.entries),
			rosterIndex: formatRosterIndex(state),
			tools: tools.length > 0,
		});

		// 末端消息 = 动态注入 + 本拍用户原话。
		// 顺序要紧：用户当拍的话必须落在**整个上下文的最后一句**。
		// 注入块（世界状态/索引/导演备注）压在提问之后时，模型会把提问读成历史里的旧话，
		// 于是既不检索也不正面回应——8/03 实测：同一提问，挪到注入之后立刻触发 lorebook_search。
		const endsWithUser = history[history.length - 1]?.role === "user";
		const past = endsWithUser ? history.slice(0, -1) : history;
		// P1 注入层：首轮（规划轮）卡并入注入块（用户话之前）——用户当拍的话必须保持
		// 上下文最后一句（8/03 教训：注入块压提问之后，模型会把提问读成历史旧话）。
		// 轮次卡是工作指令（如 opencode 的 system-reminder），随注入区在用户话前送达。
		const firstCard = roundCardFor(ws, config.userName, wsDeps.rules.wordRange, wsDeps.rules.statusBarTagGroup);
		const injWithCard = firstCard ? `${injection}\n\n${firstCard}` : injection;
		const tailText = endsWithUser ? `${injWithCard}\n\n${history[history.length - 1].text}` : injWithCard;

		const messages: unknown[] = [
			// M4 前情提要：被 rp-summary 覆盖的早期剧情在此回读（历史里那段已整体不存在）。
			// 以 user 角色打头，措辞与 system「消息流约定」里的【前情提要】对上。
			...(summary
				? [
						{
							role: "user",
							content: [{ type: "text", text: `【前情提要】以下是更早剧情的接力摘要，是既定事实：\n\n${summary}` }],
							timestamp: 0,
						},
					]
				: []),
			...past.map((m) =>
				m.role === "user"
					? { role: "user", content: [{ type: "text", text: m.text }], timestamp: 0 }
					: {
							role: "assistant",
							content: [{ type: "text", text: m.text }],
							api: "openai-completions",
							provider: "history",
							model: "history",
							usage: {
								input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: 0,
						},
			),
			{ role: "user", content: [{ type: "text", text: tailText }], timestamp: Date.now() },
		];

		const { apiKey, headers } = await this.#deps.getAuth(model);
		this.#abort = new AbortController();
		const options: Record<string, unknown> = {
			apiKey,
			headers,
			signal: this.#abort.signal,
			sessionId: sm.getSessionId(),
		};
		const thinking = this.#deps.getThinking?.();
		if (thinking) options.reasoning = thinking;
		const samplers = materials.preset?.samplers;
		if (samplers && Object.keys(samplers).length > 0) {
			options.onPayload = (payload: unknown, m: StageModelLike) => {
				if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
				return applyProjectedSamplers(payload as Record<string, unknown>, samplers, {
					provider: m.provider,
					modelId: m.id,
					baseUrl: m.baseUrl,
					api: typeof m.api === "string" ? m.api : undefined,
				});
			};
		}

		const s = this.#deps.streamFn(model, { systemPrompt, messages, tools }, options);
		let final: AssistantMsgLike | null = null;
		let errored: string | undefined;
		let text = "";
		const fwd = this.#draftForwarder();
		for await (const e of s) {
			if (e.type === "done") {
				final = e.message ?? null;
			} else if (e.type === "error") {
				final = e.error ?? null;
				errored = final?.errorMessage || "provider error";
			} else if (e.type === "text_delta" && e.delta) {
				text += e.delta;
				ev.onDelta?.("text", e.delta);
			} else if (e.type === "thinking_delta" && e.delta) {
				recordSegment(ws, { kind: "thinking", text: e.delta });
				ev.onDelta?.("thinking", e.delta);
			} else {
				fwd(e);
			}
		}

		// 尾巴口径（8/09）：稿落地后的 text 通道产出。稿落地前工具轮的旁白（读题/计划）
		// 不算——旁白曾被 mergeFinalText 当尾巴拼到正文尾部（实弹：读题文字跑进正文）。
		let loopTail = "";
		// M-A agent 循环（PLAN-RP-AGENT-EXEC §2.3）：思考→工具→看结果→再思考，直到交稿定稿。
		// 首轮无论 stopReason 都进循环——模型直出正文不调工具时由循环做宽进严出代收（D2）。
		if (!errored && final && final.stopReason !== "aborted") {
			const turn = await this.#agentLoop({
				model,
				options,
				systemPrompt,
				messages,
				first: final,
				tools,
				ws,
				wsDeps,
				language: config.language,
				readDeps,
				directText: text,
			});
			if (turn.final) final = turn.final;
			if (turn.errored) errored = turn.errored;
			text += turn.text;
			loopTail = turn.tailText ?? turn.text;
		}

		const aborted = final?.stopReason === "aborted";
		if (!text) text = textOfAssistant(final);

		// M-E 兜底封笔：分段续写完但模型始终没调 draft_seal（催告已给过一轮）。
		// 不封笔的稿从未按完整稿验收过——此处程序化补一次，让字数/模块/主权
		// 与一次性交稿走同一口径；报告只进日志，不再回喂模型（本拍已谢幕）。
		if (ws.appends > 0 && !ws.sealed && ws.draft.trim()) {
			runWriteTool(ws, wsDeps, "draft_seal", {});
		}

		// 定稿 = 工作区稿（工件）；工作区空（中断半拍/循环认栽）退回直出正文
		// **但**模型常把格式栈尾巴（状态栏/catsay 等）走 text 通道而非 draft_write 参数：
		// 二选一会把那部分连内容一起扔掉（8/05 实锤：模型宣告要出「正文+状态栏+咪咪点评」，
		// draft_write 只交了正文，屏上流式见过三样、落树只剩一样）。故此处**合并**：
		// 稿件为主体，text 里**格式特征**的尾巴补回（纯文本闲聊不进正文）。
		const finalText = mergeFinalText(ws.draft, ws.draft.trim() ? loopTail : text);

		// 落树：正文以定稿为准（保留思考块，剥离工具调用轨迹）；纯错误/空拍不落
		let entryId: string | undefined;
		if (final && finalText) {
			const keep = (final.content ?? []).filter((c) => c.type === "thinking");
			// 时间线随 details 持久化：定稿只留最后一稿正文，但用户要看的
			// 「思考→工具→正文」全链在此保住——resyncAll 全量重放与刷新后仍在。
			// 稿段以定稿为准（工作区空时退回直出正文，时间线里也可能没有稿段）。
			const timeline = finalTimeline(ws, finalText);
			const prevDetails =
				final.details && typeof final.details === "object" && !Array.isArray(final.details)
					? (final.details as Record<string, unknown>)
					: undefined;
			const details = timeline.length ? { ...prevDetails, rpTimeline: timeline } : prevDetails;
			entryId = sm.appendMessage({
				...final,
				content: [...keep, { type: "text", text: finalText }],
				...(details ? { details } : {}),
			});
			sm.flush();
		}

		// 媒体交付落树（8/06 重接）：wire 只认树上的 toolResult 出 image/audio/video/html 帧。
		// 落在正文**之后**——屏上顺序与演出顺序一致（先看正文，再看图）。
		// 正文空拍时也要落：用户可能只让「把刚才那张图再给我看看」，没有正文照样得交付。
		if (!aborted && ws.mediaDeliveries?.length) {
			for (const d of ws.mediaDeliveries) {
				sm.appendMessage({
					role: "toolResult",
					toolName: d.toolName,
					content: [{ type: "text", text: d.text }],
					details: d.details,
					isError: false,
					timestamp: Date.now(),
				});
			}
			sm.flush();
		}

		if (errored && !aborted) {
			ev.onNotify?.("error", `生成失败：${errored}`);
			return { aborted: false, error: errored, entryId };
		}

		// 空手认栽（循环逼稿一次仍无产出）：明说，不再静默丢拍（实弹三拍 0 字正文的教训）
		if (!errored && !aborted && !finalText) {
			ev.onNotify?.("warning", "本拍模型未交出任何正文（已催稿一次仍空手）——请重试或更换模型。");
			return { aborted: false, error: "no-draft" };
		}

		// M-A：#revise 旁路停用（职责由 draft_check 报告 → 模型自改取代；draft_edit 随 M-B）。
		// 记账：world_state_update 干跑验证过的 patch 在此统一落账——
		// 落树刚完成、叶即本拍新条目，无叶漂移窗口；模型是记账主体，harness 只执行。
		if (entryId && !aborted && ws.patches.length > 0) {
			const nextState = projectedState(ws, state);
			sm.appendCustomEntry(STATE_ENTRY_TYPE, nextState);
			const stateFile = this.#deps.getStateFile?.(sm.getSessionId());
			if (stateFile) {
				try {
					saveState(stateFile, nextState);
				} catch {
					// 缓存写失败不影响树上快照（账本权威在树，磁盘只是缓存）
				}
			}
			ev.onActivity?.(`记账 ${ws.patches.length} 笔（模型提交）`);
			sm.flush();
		}

		// 场记兜底（D5）：模型本拍没调 world_state_update 才旁路补账，M-B 视实弹数据决定退役。
		if (entryId && !aborted && finalText && ws.patches.length === 0) {
			const r = await runScribeTurn(
				{
					// 2048：账本+名录随剧情增长，patch 可能很长；1024 实测会截断出半截 JSON（8/03）
					sideText: (sp, ut) => this.#sideText(model, sp, ut, { apiKey, headers }, 2048),
					appendStateEntry: (s) => sm.appendCustomEntry(STATE_ENTRY_TYPE, s),
					getLeafId: () => sm.getLeafId(),
					stateFile: this.#deps.getStateFile?.(sm.getSessionId()),
					onActivity: (d) => ev.onActivity?.(d),
				},
				{
					state,
					userText: lastUserText,
					assistantText: finalText,
					charName: materials.card.name,
					userName: materials.config.userName,
				},
			);
			if (r.kind === "failed") console.error(`[stage-scribe] 记账跳过：${r.error}`);
			sm.flush();
		}

		// 登场名录定拍刷新：名称在 applyPatch 时立即入册；每 N 个完整叙事拍，场记根据
		// 最新账本 + 最近剧情更新一句话近况。进度写进 rp-state，故 rewind/swipe/分支天然隔离；
		// 失败不推进进度，下一拍重试。放在记账后，确保它看到本拍刚落下的最新事实。
		if (entryId && !aborted && finalText) {
			try {
				const refreshBranch = sm.getBranch() as BranchEntryLike[];
				const refreshed = await runRosterRefresh(
					{
						sideText: (sp, ut) => this.#sideText(model, sp, ut, { apiKey, headers }, 2048),
						appendStateEntry: (next) => sm.appendCustomEntry(STATE_ENTRY_TYPE, next),
						getLeafId: () => sm.getLeafId(),
						stateFile: this.#deps.getStateFile?.(sm.getSessionId()),
						onActivity: (detail) => ev.onActivity?.(detail),
					},
					{
						branch: refreshBranch,
						state: stateFromBranch(refreshBranch),
						everyNTurns: config.rosterRefreshEveryNTurns ?? 5,
						charName: materials.card.name,
						userName: materials.config.userName,
					},
				);
				if (refreshed.kind === "failed") console.error(`[stage-roster] 名录刷新跳过：${refreshed.error}`);
				if (refreshed.kind === "refreshed") sm.flush();
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				console.error(`[stage-roster] 名录刷新异常：${message}`);
			}
		}

		// M4 长局压缩：攒够拍数就把早期剧情摘要成 rp-summary（装配时回读为【前情提要】）。
		// 放在谢幕前的最后一步——记账已落，摘要能读到最新账本；叶守卫在 runCompaction 内。
		// 压缩失败/未到期都只是跳过，下一拍会再判一次。
		if (entryId && !aborted && finalText) {
			await this.#compact(model, { apiKey, headers }, config.compactEveryNTurns ?? 30);
		}
		return { aborted, entryId };
	}

	/**
	 * 手动压缩（/compact）：不等周期，立刻把早期剧情摘要成 rp-summary。
	 * everyNTurns=1 + 更低的字数地板 = 「只要真有可裁的早期剧情就压」
	 * （仍守最近 KEEP_RECENT_BEATS 拍原文，续演点不动）。
	 * 流式中拒绝——压缩要改上下文，不能与正在装配的一拍打架。
	 */
	async compactNow(): Promise<CompactOutcome> {
		if (this.#busy) return { kind: "skipped", reason: "busy" };
		const model = this.#deps.getModel();
		if (!model) return { kind: "failed", error: "尚未配置剧情模型" };
		this.#busy = true;
		try {
			const { apiKey, headers } = await this.#deps.getAuth(model);
			return await this.#compact(model, { apiKey, headers }, 1, MANUAL_MIN_COMPACT_CHARS);
		} catch (err) {
			return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
		} finally {
			this.#busy = false;
		}
	}

	/** 压缩一次（自动/手动共用）。失败只记日志不抛——压缩从不影响正文。 */
	async #compact(
		model: StageModelLike,
		auth: { apiKey?: string; headers?: Record<string, string> },
		everyNTurns: number,
		minChars?: number,
	): Promise<CompactOutcome> {
		const ev = this.#deps.events ?? {};
		const sm = this.#deps.getSessionManager();
		const { config, card } = loadStageMaterials(this.#deps.cwd);
		try {
			const branch = sm.getBranch() as BranchEntryLike[];
			const c = await runCompaction(
				{
					// 4096：摘要要装下前情/人物/伏笔/事实账五节，且要合并上一份摘要
					sideText: (sp, ut) => this.#sideText(model, sp, ut, auth, 4096),
					appendSummaryEntry: (data: RpSummaryData) => sm.appendCustomEntry(SUMMARY_ENTRY_TYPE, data),
					getLeafId: () => sm.getLeafId(),
					archive: this.#deps.archiveCompacted
						? (text) => this.#deps.archiveCompacted!(sm.getSessionId(), text)
						: undefined,
					onActivity: (d) => ev.onActivity?.(d),
				},
				{
					branch,
					state: stateFromBranch(branch),
					language: config.language,
					userName: config.userName,
					charName: card.name,
					everyNTurns,
					...(minChars !== undefined ? { minChars } : {}),
				},
			);
			if (c.kind === "failed") console.error(`[stage-compact] 压缩跳过：${c.error}`);
			if (c.kind === "compacted") sm.flush();
			return c;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(`[stage-compact] 压缩异常：${msg}`);
			return { kind: "failed", error: msg };
		}
	}

	/**
	 * M-A agent 循环（开放式，PLAN-RP-AGENT-EXEC §2.3）。取代 M3 的检索封顶循环。
	 * 谢幕条件 = 模型停调工具且工作区有稿。宽进严出（D2）：直出正文自动代收为 draft_write
	 * （跑验收，未全绿则报告喂回一轮）；无稿也无正文 → 逼稿一次；MAX_ROUNDS 安全阀，
	 * 触阀撤工具强制收笔。返回续轮累计直出正文（首轮由调用方持有）。
	 */
	async #agentLoop(o: {
		model: StageModelLike;
		options: Record<string, unknown>;
		systemPrompt: string;
		messages: unknown[];
		first: AssistantMsgLike;
		tools: StageTool[];
		ws: TurnWorkspace;
		wsDeps: WorkspaceDeps;
		/** 剧情语言（统一工具层按面装配描述/schema，M-D1） */
		language: string;
		/** 读侧工具依赖（装配清单与执行同源，M-D2） */
		readDeps: StageToolDeps;
		/** 首轮直出正文（调用方已流式外发） */
		directText: string;
	}): Promise<{ final: AssistantMsgLike | null; errored?: string; text: string; tailText?: string }> {
		const ev = this.#deps.events ?? {};
		const readDeps = o.readDeps;
		// 走 tools.ts 派发的工具（统一层世界书族/向量库族 + 台上读侧两件）；其余归工作区执行器。
		// 统一层含写侧（lorebook_write/toggle、memory_add/delete），但它们写的是设定集/记忆库
		// 而不是本拍草稿，故仍走 tools.ts 而非 workspace——「读/写」在此不是路由依据，工件归属才是。
		const READ_TOOLS = new Set([
			...unifiedStageToolNames(readDeps),
			"world_state_get",
			"writing_guide",
		]);
		// MCP 外设（8/06 重接）：只认**本会话已连接**的限定名——不能只看 mcp__ 前缀，
		// 否则模型幻觉出的服务器名会被当成 MCP 调用，错过「未知工具」的正常报错路径。
		const MCP_TOOLS = mcpStageToolNames(this.#deps.mcp);
		// 媒体交付（8/06 重接）：结果带 details.rp*，收尾时落成 toolResult 条目供 wire 出帧
		const MEDIA_TOOLS = this.#deps.media
			? mediaStageToolNames({ tts: this.#deps.ttsAvailable?.() === true })
			: new Set<string>();
		const convo = [...o.messages];
		let last: AssistantMsgLike = o.first;
		let text = "";
		let nudged = false; // 逼稿/报告喂回各只给一轮机会，防空转
		let tailPass = false; // 收尾放行（模型停手且有稿时，给一轮机会写格式栈尾巴）
		let sealNudged = false; // 封笔催告（M-E：分段续写完但忘了 draft_seal），只给一轮
		let askEarlyNudged = false; // ask 时机门禁：首轮无上文时暂缓一次，坚持再调放行（求选项例外）
		let userStopped = false; // P7：用户在 ask 选择卡上点了停止——本拍收束
		let lastConsumed = 0; // 本轮开始时 text 长度——判定「本轮新产出文本」用
		// 稿首次落地时的 text 长度：之前的 text 是读题/计划旁白（工具轮的 text 通道产出），
		// 不算正文也不算尾巴；之后的 text 才是尾巴候选（状态栏等）。-1 = 稿未落地。
		let tailStart = -1;
		// 尾巴口径：稿落地后的 text 通道产出（未落地=全量，直出正文路径要整段保留）
		const tailOf = () => (tailStart >= 0 ? text.slice(tailStart) : text);
		// P1 注入层：轮次卡去重——只在工作区状态跨卡类型切换时注入，历史不累积。
		// 首轮（规划卡）已在装配时随 tailText 送达，这里从「开工」状态起跟踪。
		let lastCard = o.ws.plan.length > 0 ? "open" : "plan";

		for (let round = 0; round < MAX_ROUNDS; round++) {
			lastConsumed = text.length; // 本轮之前的累计文本
			const calls = (last.content ?? []).filter(
				(c): c is { type: string; id?: string; name?: string; arguments?: Record<string, unknown> } =>
					c.type === "toolCall",
			);

			if (calls.length === 0) {
				// 模型停手：有稿即谢幕——但先确认它不是「还打算写尾巴」。
				//
				// 预设格式栈（状态栏 / catsay 等）常被模型放在 draft_write **之后**的
				// 一轮里输出。旧逻辑在此直接 break，那一轮流式从未发起，模型思考里
				// 「Now the status bar and cat commentary」的意图永远兑现不了——
				// 同一输入 roll 三次，写在同轮的两次有、留到下轮的那次没有（8/05 实锤）。
				// 故：有稿、本轮零产出、且上一轮思考宣告过写尾巴的意图时，
				// 放行一轮收尾（tailPass 只给一次，防空转）。
				if (o.ws.draft.trim()) {
					// M-E：分段续写忘了封笔——稿在但从未按完整稿验收过。催一次封笔
					// （只给一次，防空转）；仍不封则谢幕时兜底封笔，不让本拍丢正文。
					if (o.ws.appends > 0 && !o.ws.sealed && !sealNudged) {
						sealNudged = true;
						convo.push(last);
						convo.push({
							role: "user",
							content: [
								{
									type: "text",
									text:
										`你用 draft_append 续写了 ${o.ws.appends} 段但还没封笔。` +
										`正文写完了就调用 draft_seal 按完整稿验收（字数/禁词/格式/主权全量判定）；还没写完就接着续写。`,
								},
							],
							timestamp: Date.now(),
						});
						continue;
					}
					if (tailPass) break; // 谢幕轮只给一次，防空转
					// 程序化谢幕（8/09 输出形式定案）：状态栏 = 本拍结束的标志，必须最后出现。
					// 卡/预设定义了格式块而稿与 text 通道都还没出现过 → 必开一轮谢幕并点名清单，
					// 不再靠思考关键词（hasTailIntent）碰运气——实弹：模型记完账思考里没提
					// 状态栏三个字，直接收场，状态栏整拍蒸发。关键词判定仅兜「rules 没
					// 提取到但模型自己宣告了尾巴」的残余场景。
					// 首轮直出的正文（o.directText）也算已产出——寒暄拍模型第一轮就带状态栏时不再重催
					const producedSoFar = `${o.ws.draft}\n${o.directText}\n${text}`;
					const missingReq = o.wsDeps.rules.requiredTags.filter((t) => !hasFormatTag(producedSoFar, t));
					const sbGroup = o.wsDeps.rules.statusBarTagGroup;
					const sbMissing = sbGroup.length > 0 && !sbGroup.some((t) => hasFormatTag(producedSoFar, t));
					const wanted = [
						...(sbMissing ? [`状态栏（${sbGroup.map((t) => `<${t}>`).join(" 或 ")}）`] : []),
						...missingReq.map((t) => `<${t}>`),
					];
					// 缺格式块时无论本轮有无产出都催（产出里已有就不算缺）；不缺按旧逻辑收场
					if (wanted.length === 0) {
						if (text.trim()) break; // 本轮已有产出（可能正是尾巴）→ 正常谢幕
						if (!hasTailIntent(last) && !hasTailIntent(o.first)) break;
					}
					tailPass = true;
					convo.push(last);
					convo.push({
						role: "user",
						content: [
							{
								type: "text",
								text: wanted.length
									? `剧情已收笔。最后一步：输出 ${wanted.join("、")}——预设定义的谢幕格式块，` +
										`在正文之外直接输出（不进稿纸），输出完本拍结束。不要再写正文。`
									: `正文已收稿。若本拍还有正文之外的收尾内容（状态栏、点评等预设格式块），` +
										`现在直接输出；没有则回空，本拍就此收束。`,
							},
						],
						timestamp: Date.now(),
					});
				} else {
				const direct = `${o.directText}${text}`.trim();
				if (direct) {
					// 宽进严出：直出正文代收为 draft_write（已流式外发过，不重复上屏）。
					// internal=true 跳过门禁——代收是兜底，被拦下就等于把这拍正文丢了。
					const r = runWriteTool(o.ws, o.wsDeps, "draft_write", { content: direct }, true);
					ev.onActivity?.("直出正文已代收为 draft_write");
					// 有计划 = 这拍有戏（8/09 实弹：列了 3 条路标却 385 字一次直出，代收全绿
						// 静默放行，又短又糙还没状态栏）——即使全绿也喂一轮让模型自决续/收
						if ((o.ws.lastGreen && o.ws.plan.length === 0) || nudged) break;
					nudged = true;
					convo.push(last);
					convo.push({
						role: "user",
						content: [
							{
								type: "text",
								text:
									`你的正文已被代收为 draft_write（正文本应经此工具提交）。验收报告：\n${r.text}\n` +
									(o.ws.plan.length > 0
											? `你列了路标却把整拍一次直出——已代收，不推倒重来。接下来自决：` +
												`戏还没演完就用 draft_append 接着演；演完了就输出状态栏等格式块（若本卡定义）收场。`
											: `如需修改请调用 draft_write 重新提交完整正文；无需修改则直接结束。`),
							},
						],
						timestamp: Date.now(),
					});
				} else {
					// 空手停笔（实弹三拍 0 字正文的病灶）：逼稿一次，仍空手才认栽
					if (nudged) break;
					nudged = true;
					convo.push(last);
					convo.push({
						role: "user",
						content: [
							{
							type: "text",
							text:
								o.ws.lookups > 0
									? "你还没有落笔——用 draft_append 一段一段演（一段约一个自然段），演完 draft_seal 收笔，否则本拍无产出。"
									: "你还没有落笔——用 draft_append 演一段（这一拍没有戏才用 draft_write 一次交完），否则本拍无产出。",
						},
						],
						timestamp: Date.now(),
					});
				}
				}
			} else {
				convo.push(last);
				// 演段轮连发门禁（8/08 晚定案）：同一轮生成里只允许演**一段**。
				// 模型连发 append+done+append 时，轮次卡（下一轮才注入）追不上它——
				// 「回看→重新评估→再演」必须在两次生成之间发生，不能靠工具连发绕过。
				// 故：本轮已 append 过后，再来的 draft_append 拒收，回喂四问，强制停下思考。
				let appendedThisRound = false;
				for (const call of calls) {
					const name = call.name ?? "";
					// P7：ask 工具——弹出选择卡等用户应答，答案作为新输入回喂（计划据此重拟）。
					// 用户停止（undefined）→ 本拍收束：不再续轮，直接以现稿定稿。
					let r: ToolRunResult | MediaStageResult;
					if (name === "ask" && this.#deps.askUser) {
						// ask 时机门禁（8/09 三分类）：①主动触发（用户在求方向/递笔）随时可问，含第 1 轮；
						// ②变量触发需要正文上文——没落笔时暂缓一次，导向「记着变量，演到跟前再问」。
						// 引擎分不清 ①②（意图在用户输入里），故软硬结合：首拦一次；模型坚持再调
						// ＝它判断属于①类（拒收文案已给出该例外），放行。
						if (o.ws.appends === 0 && !o.ws.draft.trim() && !askEarlyNudged) {
							askEarlyNudged = true;
							r = {
								text:
									`还没落笔，暂缓一步：**变量类**的拍板要等用户看到段落上文才好选——记着这个变量，` +
									`演到它实际影响剧情的段落之前再 ask。` +
									`但如果用户本轮输入本身就是在求方向/递笔（「接下来去找谁」「给个选项」「让我选」），` +
									`那属于主动触发、不需要上文——再调一次 ask 即可，会照常弹给用户。`,
								activity: "ask 被暂缓（变量类需演出上文）",
								ok: false,
							};
							ev.onActivity?.(r.activity);
							recordSegment(o.ws, {
								kind: "tool",
								activity: { kind: "tool_start", name: "ask", detail: r.activity },
							});
							convo.push({
								role: "toolResult",
								toolCallId: call.id,
								toolName: "ask",
								content: [{ type: "text", text: r.text }],
								isError: false,
								timestamp: Date.now(),
							});
							continue;
						}
						const q = String(call.arguments?.question ?? "").trim() || "请你定夺";
						const raw = call.arguments?.options;
						const options = Array.isArray(raw)
							? raw.map((s) => String(s).trim()).filter(Boolean)
							: [];
						// 停下来等用户：回合制共创，不设超时；abort 信号透传（用户点停止即收敛）
						const answer = await this.#deps.askUser(q, options, this.#abort?.signal);
						o.ws.lookups++; // 用户参与选择＝这一拍有戏（draft_write 门禁判据）
						if (answer === undefined) {
							// 用户停止：笔还给用户，本拍收束——标记后跳出循环
							ev.onActivity?.(`ask「${q.slice(0, 24)}」· 用户停止`);
							userStopped = true;
							recordSegment(o.ws, {
								kind: "tool",
								activity: { kind: "tool_start", name: "ask", detail: "用户停止——笔还给用户" },
							});
							break;
						}
						r = {
							text:
								`用户已作答：「${answer}」。按这个答案继续演——` +
								`如果它改变了剧情走向，先 beat_plan 重拟剩下的步骤再往下写。`,
							activity: `ask「${q.slice(0, 24)}」· 用户作答`,
						};
						ev.onActivity?.(r.activity);
						recordSegment(o.ws, {
							kind: "tool",
							activity: { kind: "tool_start", name: "ask", detail: r.activity },
						});
						convo.push({
							role: "toolResult",
							toolCallId: call.id,
							toolName: "ask",
							content: [{ type: "text", text: r.text }],
							timestamp: Date.now(),
						});
						continue;
					}
					// 演段轮连发门禁（8/08 晚定案）：同一轮生成里只允许演**一段**。
					// 模型连发 append+done+append 时，轮次卡（下一轮才注入）追不上——
					// 「回看→重新评估→再演」必须在两次生成之间发生。本轮已 append 过，
					// 再来的 draft_append 拒收并回喂四问，强制模型停下思考再生成。
					if (name === "draft_append" && appendedThisRound) {
						r = {
							text:
								`已收上一段。同一轮里只演一段——先回看刚写下的，重新评估：` +
								`这段的戏接下去怎么演、要不要 \`ask\` 用户（剧情到岔路了吗）、` +
								`剩余路标还成立吗（不成立就 \`beat_plan\` 重拟）、戏到停点了吗。` +
								`想清楚，下一轮再落下一段。`,
							activity: "同轮连演被拦下（需回看思考）",
							ok: false,
						};
						ev.onActivity?.(r.activity);
						recordSegment(o.ws, {
							kind: "tool",
							activity: { kind: "tool_start", name, detail: r.activity },
						});
						convo.push({
							role: "toolResult",
							toolCallId: call.id,
							toolName: name,
							content: [{ type: "text", text: r.text }],
							isError: false,
							timestamp: Date.now(),
						});
						continue;
					}
					// 演段轮零思考门禁（8/08 晚定案）：上一条消息没有思考就 append，
					// 说明没承接路标想「这段怎么演」——拒收一次，回喂承接指引。
					// 判定看 last.content 是否含 thinking 块（思考+工具同轮输出也算有思考——
					// 8/08 修：thinking_delta 可能不走流式而随消息到达，上一轮 stream 统计会漏判）。
					// 只拦「续写第二段及以后」：首段前有第 1 轮的大构思，不算零思考。
					const lastHadThink = (last.content ?? []).some(
						(c) => c.type === "thinking" && (c.thinking ?? "").trim().length > 0,
					);
					if (name === "draft_append" && o.ws.appends > 0 && !lastHadThink) {
						r = {
							text:
								`未收段。你上一轮没有思考就直接落笔——路标只说「发生什么」，` +
								`这一段的**戏与文笔**要在落笔前想清楚：镜头从哪开、动作怎么拆、` +
								`感官细节（光线/声音/气味/触感）、人物此刻的状态与神态、` +
								`节奏松紧与对白语气、有没有一个细节立住这一段。` +
								`回看刚写下的，承接路标把这一段写好，想好了再交。`,
							activity: "零思考落笔被拦下（需承接路标）",
							ok: false,
						};
						ev.onActivity?.(r.activity);
						recordSegment(o.ws, {
							kind: "tool",
							activity: { kind: "tool_start", name, detail: r.activity },
						});
						convo.push({
							role: "toolResult",
							toolCallId: call.id,
							toolName: name,
							content: [{ type: "text", text: r.text }],
							isError: false,
							timestamp: Date.now(),
						});
						continue;
					}
					// 演段轮未修违规门禁（8/08 晚定案 + 8/09 收紧）：
					// 上一段验收出的违规未修掉就不许**任何推进**（append/done/seal）——
					// 用户看到的每一段，在他看下一段之前必须是最终形态。
					// 8/09：原来只拦 append，模型照样勾步/封笔把修复拖走；现在
					// 只放行修复相关（draft_edit/draft_write）与只读（read/search/check）。
					// 修复是写段后的固定下一步：写完 → 报告 → 只能修 → 替换上屏 → 才继续。
					const ADVANCE_TOOLS = new Set(["draft_append", "beat_step_done", "draft_seal"]);
					if (ADVANCE_TOOLS.has(name) && o.ws.pendingViolations.length > 0) {
						r = {
							text:
								`${name === "draft_append" ? "未收段" : name === "draft_seal" ? "未封笔" : "未勾步"}。` +
								`上一段还有 ${o.ws.pendingViolations.length} 处未修：\n` +
								o.ws.pendingViolations.map((v) => `- ${v}`).join("\n") +
								`\n先用 \`draft_edit\` 逐处修掉（old 逐字引用现稿原文、须唯一，可一次给多处），` +
								`验收过了再继续——已经交给用户看的段落必须是定稿。`,
							activity: `推进被拦下（${o.ws.pendingViolations.length} 处未修）`,
							ok: false,
						};
						ev.onActivity?.(r.activity);
						recordSegment(o.ws, {
							kind: "tool",
							activity: { kind: "tool_start", name, detail: r.activity },
						});
						convo.push({
							role: "toolResult",
							toolCallId: call.id,
							toolName: name,
							content: [{ type: "text", text: r.text }],
							isError: false,
							timestamp: Date.now(),
						});
						continue;
					}
					if (name === "draft_append") appendedThisRound = true;
					// 三态路由 +MCP：统一层/台上读侧 → tools.ts；MCP 外设 → hub；其余 → 工作区。
					// MCP 走网络/子进程，可能很慢——把本拍 abort 信号透传下去，用户点停止能立刻中断。
					r = name === "assistant_run"
						? ((await runAssistantStageTool(name, call.arguments ?? {}, this.#abort?.signal)) ?? {
								text: `未知工具「${name}」。`,
								isError: true,
							})
						: MCP_TOOLS.has(name)
							? ((await runMcpStageTool(
									this.#deps.mcp!,
									name,
									call.arguments ?? {},
									this.#abort?.signal,
								)) ?? { text: `未知工具「${name}」。`, isError: true })
							: MEDIA_TOOLS.has(name)
								? ((await runMediaStageTool(this.#deps.cwd, name, call.arguments ?? {})) ?? {
										text: `未知工具「${name}」。`,
										isError: true,
									})
								: READ_TOOLS.has(name)
									? await this.#runReadTool(o, readDeps, name, call.arguments ?? {})
									: runWriteTool(o.ws, o.wsDeps, name, call.arguments ?? {});
					// 媒体交付要落成 toolResult 条目（wire 只认树上的 toolResult 出媒体帧）——
					// 台上引擎默认剥离工具轨迹，故在此单独收集，谢幕后随正文一起落树。
					const mediaDetails = (r as MediaStageResult).details;
					if (MEDIA_TOOLS.has(name) && mediaDetails && (r as MediaStageResult).isError !== true) {
						o.ws.mediaDeliveries = o.ws.mediaDeliveries ?? [];
						o.ws.mediaDeliveries.push({ toolName: name, details: mediaDetails, text: r.text });
					}
					// 每轮修复可见性（8/09 输出形式定案）：draft_edit 修改后**分段重同步**——
					// 前端把全部稿段原位替换成修后分段，该段原地变新，无重复、不塌段。
					// （旧做法发「全稿 + reset」只替换末段，前面稿段还在屏上 → 正文重复。）
					if (name === "draft_edit" && r.ok !== false && o.ws.draft.trim()) {
						ev.onDraftResync?.(splitDraftSegments(o.ws.draft));
					}
					// 时间线：工具按调用位置入档（draft_write/edit 的正文另由 #recordDraft 记）
					recordSegment(o.ws, { kind: "tool", activity: { kind: "tool_start", name, detail: r.activity ?? "" } });
					if (r.activity) ev.onActivity?.(r.activity);
					convo.push({
						role: "toolResult",
						toolCallId: call.id,
						toolName: name,
						content: [{ type: "text", text: r.text }],
						// MCP 失败必须如实标记：模型据此改道或如实告知用户，而不是当成功往下演
						isError: (r as { isError?: boolean }).isError === true,
						timestamp: Date.now(),
					});
				}
			}

			// P7：用户停止（ask 卡上点了停止）——本拍收束，不再续轮
			if (userStopped) break;

			// 中间轮旁白（8/09 实弹）：稿落地前、工具轮里流出的 text 是读题/计划旁白——
			// 通知前端清掉（收进过程条）；tailStart 一旦标记（稿已落地），之后的 text
			// 归尾巴候选，不再清（状态栏后调记账的场景，状态栏不能被当旁白删掉）。
			// round 0 的旁白在 performTurn 首轮流里（o.directText），不在本层 text 统计中。
			if (tailStart < 0) {
				const talked = text.length > lastConsumed || (round === 0 && o.directText.trim().length > 0);
				if (calls.length > 0 && talked) ev.onStreamClear?.();
				if (o.ws.draft.trim()) tailStart = text.length;
			}

			// 安全阀最后一轮撤掉工具：模型只能收笔（触阀后以现稿/直出定稿）
			const lastRound = round >= MAX_ROUNDS - 1;
			const ctx: Record<string, unknown> = { systemPrompt: o.systemPrompt, messages: convo };
			if (!lastRound) ctx.tools = o.tools;
			else {
				// 8/09：撤工具的同时必须告知收场（实弹：轮次耗尽后模型不明所以干想一轮
				// 散场，状态栏没了）——点名输出格式块，这一轮产出走 text 通道拼进定稿。
				const sbG = o.wsDeps.rules.statusBarTagGroup;
				const sbNote =
					sbG.length > 0 && !sbG.some((t) => hasFormatTag(`${o.ws.draft}\n${text}`, t))
						? `直接输出状态栏（${sbG.map((t) => `<${t}>`).join(" 或 ")}）等格式块收场——不要再写正文。`
						: `就此收场，不要再写正文。`;
				convo.push(nowMsg(`【收场】本拍轮次已达上限，工具已收起。${sbNote}`));
			}

			// P1 注入层：按工作区状态注入当前轮次卡。
			// 规划/开工卡：状态切换才注入一次（一次性指令）。
			// 演段回看卡 / 收笔评估卡：**每轮都注入**——循环指令，每轮重新看到
			// （8/08 修：旧逻辑只切一次，模型后面几轮看不到评估指令）。
			// 用替换语义防累积：推新卡前把上一张卡从 convo 里移除。
			const card = roundCardFor(o.ws, o.wsDeps.userName, o.wsDeps.rules.wordRange, o.wsDeps.rules.statusBarTagGroup);
			const hasPending = o.ws.plan.some((s) => !s.done);
			const draftBodyChars = o.ws.draft.trim() ? extractDraftBody(o.ws.draft).replace(/\s+/g, "").length : 0;
			const wordRange = o.wsDeps.rules.wordRange;
			// 修复态优先：有未修违规 → "fix"（修复卡，先修再演）
			const fixing = o.ws.appends > 0 && o.ws.pendingViolations.length > 0;
			// 续写态：路标演完但字数未达标——cardKind 归 "extend"，走替换语义
			const extending = !fixing && o.ws.appends > 0 && !hasPending && !!wordRange && draftBodyChars < wordRange.min;
			const cardKind = o.ws.appends > 0
				? fixing ? "fix" : o.ws.sealed ? "curtain" : extending ? "extend" : hasPending ? "review" : "seal"
				: o.ws.plan.length > 0 ? "open" : "plan";
			if (card) {
				if (cardKind === "review" || cardKind === "seal" || cardKind === "extend" || cardKind === "fix" || cardKind === "curtain") {
					// 替换上一张卡（找最后一个 role=user 且以各卡名开头）
					for (let k = convo.length - 1; k >= 0; k--) {
						const msg = convo[k] as { role?: string; content?: Array<{ type?: string; text?: string }> };
						const txt = Array.isArray(msg.content)
							? msg.content.map((c) => c.text ?? "").join("")
							: "";
						if (msg.role === "user" && (txt.includes("【演段回看】") || txt.includes("【收笔评估】") || txt.includes("【续写】") || txt.includes("【修复】") || txt.includes("【谢幕】"))) {
							convo.splice(k, 1);
							break;
						}
					}
					convo.push(nowMsg(card));
				} else if (cardKind !== lastCard) {
					lastCard = cardKind;
					convo.push(nowMsg(card));
				}
			}

			const s = this.#deps.streamFn(o.model, ctx as never, o.options);
			let final: AssistantMsgLike | null = null;
			const fwd = this.#draftForwarder();
			// thinking_delta 入时间线（思考→工具→正文全链）。零思考门禁的判定
			// 看 last.content 是否含 thinking 块（见 append 拦截处），不在流式层统计。
			for await (const e of s) {
				if (e.type === "done") final = e.message ?? null;
				else if (e.type === "error") {
					return { final: e.error ?? null, errored: e.error?.errorMessage || "provider error", text, tailText: tailOf() };
				} else if (e.type === "text_delta" && e.delta) {
					text += e.delta;
					// 稿已存在后的正文外产出（状态栏/catsay 等格式尾巴）入时间线按序记档；
					// 定稿时由 finalTimeline 吸收进稿段（内容以 mergeFinalText 为准）。
					if (o.ws.draft.trim()) recordSegment(o.ws, { kind: "text", text: e.delta });
					ev.onDelta?.("text", e.delta);
				} else if (e.type === "thinking_delta" && e.delta) {
					recordSegment(o.ws, { kind: "thinking", text: e.delta });
					ev.onDelta?.("thinking", e.delta);
				} else {
					fwd(e);
				}
			}
			if (!final) return { final: last, text, tailText: tailOf() };
			last = final;
			if (final.stopReason === "aborted") break;
		}
		return { final: last, text, tailText: tailOf() };
	}

	/**
	 * 台上读侧工具，并把「查过世界」记进工作区。
	 *
	 * lookups 是 draft_write 门禁的判据（见 workspace.ts runWriteTool）：查过设定/旧账/
	 * 账本＝这一拍中途确实有要停下来处理的事＝有戏，本该一段一段演。
	 * writing_guide 读的是写作方法论而非世界事实，不计入。
	 */
	async #runReadTool(
		o: { ws: TurnWorkspace; language: string },
		readDeps: StageToolDeps,
		name: string,
		args: Record<string, unknown>,
	): Promise<ToolRunResult> {
		if (name !== "writing_guide") o.ws.lookups++;
		return runStageTool(readDeps, name, args, o.language);
	}

	/**
	 * D1：draft_write / draft_append 的正文参数流式转发——工件正文照常逐字上屏。
	 * toolcall_delta 用渐进解析的 arguments（openai-completions 每帧重解 partialArgs）；
	 * toolcall_end 兜底补齐后缀（faux 等不做渐进解析的 provider 在此整段上屏）。
	 * 每条流各建一个（sent 按 contentIndex 记已发长度，保证不重发）。
	 *
	 * M-E：draft_append 是**追加**语义，reset 必须为 false——已上屏的段落是
	 * 已经发生的事，续写不能把它擦掉重排（那正是分段续写要消除的体验）。
	 */
	#draftForwarder(): (e: StageStreamEvent) => void {
		const ev = this.#deps.events ?? {};
		const sent = new Map<number, number>();
		const forward = (idx: number, content: unknown, append = false) => {
			if (typeof content !== "string") return;
			const prev = sent.get(idx) ?? 0;
			if (content.length <= prev) return;
			// draft=true：稿件流是替换语义（重交不叠加）——与 runWriteTool 的
			// replaceDraftSegment 同语义，wire 层透传给前端时间线。
			// reset=true：本次 draft_write 调用的首个分片——前端用它清掉旧稿。
			const isFirst = !append && !sent.has(idx);
			ev.onDelta?.("text", content.slice(prev), true, isFirst);
			sent.set(idx, content.length);
		};
		/** 取正文参数：draft_write 用 content，draft_append 用 segment */
		const pick = (name: string | undefined, args: Record<string, unknown> | undefined) => {
			if (name === "draft_write") return { text: args?.content, append: false };
			if (name === "draft_append") return { text: args?.segment, append: true };
			return undefined;
		};
		return (e) => {
			const idx = e.contentIndex;
			if (typeof idx !== "number") return;
			if (e.type === "toolcall_delta") {
				const block = e.partial?.content?.[idx];
				if (block?.type !== "toolCall") return;
				const p = pick(block.name, block.arguments);
				if (p) forward(idx, p.text, p.append);
			} else if (e.type === "toolcall_end") {
				const p = pick(e.toolCall?.name, e.toolCall?.arguments);
				if (p) forward(idx, p.text, p.append);
			}
		};
	}

	/**
	 * 台上工具的执行依赖（每次取用现读素材/账本——工具看到的世界与装配同源）。
	 * lastUserText 供写入门禁判定（M-D2）：门禁问的是「用户本拍有没有要求记录」。
	 */
	#toolDeps(lastUserText = ""): StageToolDeps {
		const cwd = this.#deps.cwd;
		const sm = this.#deps.getSessionManager();
		/** 台上补充设定集路径（写侧落点；卡未装载时为空＝无 lorebook_write） */
		const overlayOf = (): string => {
			try {
				const m = loadStageMaterials(cwd);
				return overlayPathFor(cwd, m.card.name);
			} catch {
				return "";
			}
		};
		return {
			searchLore: (query, limit) => {
				const m = loadStageMaterials(cwd);
				// 语料 = 世界书 + 补充设定集（materials 已剥离外部插件协议条目）+ 当前分支挂载的知识库。
				// 知识库此前只有扩展侧搜得到，台上描述却一直承诺「已挂载知识库」——M-D1 补齐（PLAN-RP-TOOLING）。
				const codex: LorebookEntry[] = [];
				for (const name of codexNamesFromBranch(sm.getBranch() as BranchEntryLike[])) {
					try {
						codex.push(...(loadCodexEntries(cwd, name) ?? []));
					} catch {
						// 单个库读不出不该拖垮整次检索
					}
				}
				return searchEntries(codex.length > 0 ? [...m.entries, ...codex] : m.entries, query, limit);
			},
			// ---- M-D2 世界书族 ----
			writeLore: (input) => {
				const overlay = overlayOf();
				if (!overlay) return null;
				return appendOverlayEntry(overlay, input);
			},
			listLore: () => loadStageMaterials(cwd).entries,
			fingerprint: loreFingerprint,
			...(this.#deps.setDisabledLore ? { toggleLore: this.#deps.setDisabledLore } : {}),
			gate: () => ({ lastUserText, creationMode: loadStageConfig(cwd).creationMode }),
			searchMemory: async (query) => {
				const search = this.#deps.searchMemory;
				if (!search) return [];
				return search(sm.getSessionId(), query);
			},
			// ---- M-D3 向量库写侧：scope 由宿主绑定，模型只给内容（作用域不经模型） ----
			...(this.#deps.addMemory
				? { addMemory: (input: { text: string; title?: string }) => this.#deps.addMemory!(sm.getSessionId(), input) }
				: {}),
			...(this.#deps.listMemory
				? { listMemory: (storeId: string) => this.#deps.listMemory!(sm.getSessionId(), storeId) }
				: {}),
			...(this.#deps.deleteMemory
				? { deleteMemory: (storeId: string, id: string) => this.#deps.deleteMemory!(sm.getSessionId(), storeId, id) }
				: {}),
			// ---- M-D4 角色库：只读卡面 ----
			readCard: () => {
				const m = loadStageMaterials(cwd);
				const c = m.card;
				if (!c) return null;
				return {
					name: c.name,
					description: c.description,
					personality: c.personality,
					scenario: c.scenario,
					firstMes: c.firstMes,
					mesExample: c.mesExample,
					systemPrompt: c.systemPrompt,
					creatorNotes: c.creatorNotes,
					tags: c.tags,
					alternateGreetings: c.alternateGreetings,
				};
			},
			// ---- M-D5 面板：读/写/关（依赖由宿主按 session 注入） ----
			...(this.#deps.loadPanels
				? {
						loadPanels: () => this.#deps.loadPanels!(sm.getSessionId()),
						writePanel: (input: { name: string; kind: string; content: string }) =>
							this.#deps.writePanel!(sm.getSessionId(), input),
						closePanel: (name: string) => this.#deps.closePanel!(sm.getSessionId(), name),
					}
				: {}),
			getState: () => stateFromBranch(sm.getBranch() as BranchEntryLike[]),
			formatState,
			getSkill: (topic) => loadStageMaterials(cwd).skillPacks.get(topic),
		};
	}

	/** 装配报告写盘（.liyuan/preset-assembly.json）——每块预设去向可查；内容不变不写 */
	#writeAssemblyReport(
		cwd: string,
		materials: StageMaterials,
		phReport: AssemblyReportItem[],
		phTail: PresetResidentContent,
	): void {
		try {
			const report = {
				preset: materials.preset?.name ?? null,
				splitTable: materials.splitTable?.key ?? null,
				sovereigntyRelaxed: materials.sovereigntyRelaxed,
				// 常驻字数 = system 静态 + postHistory 每拍归拢（两通道合计才是真常驻）
				residentChars: {
					A:
						materials.presetResidentA.reduce((n, b) => n + b.content.length, 0) +
						phTail.aBlocks.reduce((n, b) => n + b.content.length, 0),
					B: materials.presetResidentB.join("").length + phTail.styleTexts.join("").length,
					C: materials.presetResidentC.join("").length + phTail.boundaryTexts.join("").length,
				},
				skillChars: Object.fromEntries([...materials.skillPacks].map(([t, s]) => [t, s.length])),
				// M-C2：世界书/卡内嵌通道被判死的外部插件协议条目（判据可回溯）
				protocolDrops: materials.protocolDrops,
				blocks: [...materials.presetAssembly, ...phReport],
			};
			const json = JSON.stringify(report, null, "\t");
			if (json === this.#lastAssemblyJson) return;
			this.#lastAssemblyJson = json;
			const outDir = join(cwd, ".liyuan");
			mkdirSync(outDir, { recursive: true });
			writeFileSync(join(outDir, "preset-assembly.json"), json, "utf8");
		} catch {
			// 报告写失败不影响演出
		}
	}

	// M-A 起 #revise 精修旁路退役：职责由「draft_check 报告 → 模型自改重交」结构性取代。
	// revise.ts 的补丁解析函数保留给 M-B 的 draft_edit 工具复用。

	/** 旁路文本调用（精修/场记用）：静默收集，不外发增量；失败返回 {error} */
	async #sideText(
		model: StageModelLike,
		systemPrompt: string,
		userText: string,
		auth: { apiKey?: string; headers?: Record<string, string> },
		maxTokens = 8192,
	): Promise<string | { error: string }> {
		const options: Record<string, unknown> = {
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens,
			signal: this.#abort?.signal,
			// 精修是 harness 的机械窄题，强制关思考：zen go 对 low/high 无可靠节流（8/02 实测），
			// 放开推理会把 maxTokens 整个烧在隐形思考里、正文零输出。思考档的用户自由只属于主演调用。
			reasoning: "off",
		};
		try {
			const s = this.#deps.streamFn(
				model,
				{
					systemPrompt,
					messages: [{ role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() }],
				},
				options,
			);
			let final: AssistantMsgLike | null = null;
			for await (const e of s) {
				if (e.type === "done") final = e.message ?? null;
				else if (e.type === "error") {
					return { error: e.error?.errorMessage || `stopReason=${e.error?.stopReason ?? "?"}` };
				}
			}
			if (!final) return { error: "流未产出最终消息" };
			const text = textOfAssistant(final);
			return text || { error: "最终消息无文本" };
		} catch (err) {
			return { error: err instanceof Error ? err.message : String(err) };
		}
	}
}
