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
	type AssemblyReportItem,
} from "../preset-split.ts";
import { splitWithManifest } from "../preset-skill.ts";
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
} from "./assemble.ts";
import {
	constantLoreOf,
	evalPostHistoryBlocks,
	loadStageConfig,
	loadStageMaterials,
	type ResidentPiece,
	type StageMaterials,
} from "./materials.ts";
import {
	buildDeclarePrompt,
	declareFingerprint,
	ensureDeclaredContract,
} from "./contract-declare.ts";
import {
	contractFromCard,
	curtainInjection,
	syncOutputContract,
} from "./output-contract.ts";
import {
	MANUAL_MIN_COMPACT_CHARS,
	runCompaction,
	SUMMARY_ENTRY_TYPE,
	type CompactOutcome,
	type RpSummaryData,
} from "./compact.ts";
import { runScribeTurn, STATE_ENTRY_TYPE } from "./scribe-run.ts";
import {
	MAX_ROUNDS,
	runStageTool,
	stageTools,
	writeTools,
	skillReadTool,
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
import { extractDraftBody } from "../draft.ts";
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
	/**
	 * 输出合约 v1 声明步（M-R4 首件）：装载期一次性旁路模型调用，声明本卡+预设的
	 * 谢幕格式块清单（落 .liyuan/output-contract.declared.json，按指纹缓存）。
	 * 未开启/声明失败 = v0 识别器供数（保守回退，不阻塞开演）。
	 */
	declareContract?: boolean;
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

// ---------------- 五注入（PLAN-RECTIFY §2.3：轮次层全部送模文案，文案即规格） ----------------

/** 规划卡：每拍第 1 轮随末端注入送达（工作区新建必空） */
export const PLAN_CARD =
	"【第 1 步·规划】本拍还没有计划。读题、探索（工具自取）；用户这句输入引出的未定变量——" +
	"取不同值这拍走向会分岔、且设定里查不到的——先 `ask` 请用户定，再用 `beat_plan` 列路标。" +
	"没有戏的拍可 `draft_write` 一次交完；用户本轮在求方向/递笔的，直接 `ask`。";

/** 记账注入：seal（含兜底封笔）之后第一件事；本拍已有落账（结构信号）时跳过 */
export const LEDGER_INJECTION =
	"【记账】已封笔。核对本拍变动并落账：世界状态用 `world_state_update`（物品/时间/位置/关系），" +
	"表格与面板用 `panel_write` 同步。没有变动就直接停。";

/** 验收口径正文字数（不含格式区块、不计空白）——进度行/判定注入的事实源 */
const draftBodyCharsOf = (ws: TurnWorkspace): number =>
	ws.draft.trim() ? extractDraftBody(ws.draft).replace(/\s+/g, "").length : 0;

const rangeNote = (wordRange?: { min: number; max: number }): string =>
	wordRange ? `（目标 ${wordRange.min}–${wordRange.max}）` : "";

/**
 * 进度行：每轮替换语义（替代开工卡/回看卡）。事实（路标进度与字数）+ 必读 skill 指令。
 * 8/12 复现并泛化（8/11 四改定形，原硬编码「剧情指导」→ 现认 frontmatter `每轮` 标志）：
 * 工具调用是模型可靠执行的动作、思考指令不是——把死磕挂到强制 skill_read 制造的停顿上，
 * 受理门（agentLoop 内）为其做结构保证；认数据不认名字（合铁律三）。
 *
 * 字数测量**只活在写作中的轮次层**（8/10 复核定案）：续写的触发条件就是
 * 「正文低于目标→接着写」，死板但有效——这是续写机能的燃料，不是修复诱饵。
 * 封笔之后（seal 回执/代收认收）保持零数字：写完之后的测量值只会喂出
 * 「超了 72 字→edit 删字」那条已处死的末端修复。
 */
export function progressLine(
	ws: TurnWorkspace,
	wordRange?: { min: number; max: number },
	packNames?: string[],
	forcedSkills?: string[],
): string {
	const parts: string[] = [];
	if (ws.plan.length > 0) {
		const i = ws.plan.findIndex((s) => !s.done);
		if (i >= 0) parts.push(`路标 ${i + 1}/${ws.plan.length}「${ws.plan[i]!.text}」`);
	}
	parts.push(`已演 ${ws.appends} 段，正文约 ${draftBodyCharsOf(ws)} 字${rangeNote(wordRange)}`);
	// 必定读取（每轮）skill：落笔前强制先读（受理门保证）——制造停顿=死磕燃料；标志在数据不在名字
	const forced =
		forcedSkills && forcedSkills.length > 0
			? `每段落笔前先 \`skill_read\`${forcedSkills.map((n) => `「${n}」`).join("")}构思本段，再 \`draft_append\`。`
			: "";
	const packs = packNames && packNames.length > 0 ? `可读场面包：${packNames.join(" / ")}。` : "";
	return `【进度】${parts.join("；")}。${forced}${packs}`;
}

/** 判定注入：收笔前一次性（8/12 起不再依赖路标勾选）——续写/ask/收笔归模型判断
 * （字数事实随行；8/12 删「路标已演完」半句：放宽到没勾完路标也送，路标进度由进度行
 * 覆盖，判定注入不重复报；ask 裁决句恢复 v1.3.0 实弹验证措辞，PLAN-ASK §2.1） */
export function verdictInjection(ws: TurnWorkspace, userName: string, wordRange?: { min: number; max: number }): string {
	return (
		`【判定】正文约 ${draftBodyCharsOf(ws)} 字${rangeNote(wordRange)}。` +
		`续写、\`ask\`、或 \`draft_seal\` 收笔——你判断；下文涉及 ${userName} 的行动或选择，先 \`ask\` 再动笔。`
	);
}

/** 进度行替换语义：移除 convo 里上一条【进度】再推新行（判定/记账/谢幕一次性，不替换） */
function replaceProgressLine(convo: unknown[], line: string): void {
	for (let k = convo.length - 1; k >= 0; k--) {
		const msg = convo[k] as { role?: string; content?: Array<{ type?: string; text?: string }> };
		const txt = Array.isArray(msg.content) ? msg.content.map((c) => c.text ?? "").join("") : "";
		if (msg.role === "user" && txt.startsWith("【进度】")) {
			convo.splice(k, 1);
			break;
		}
	}
	convo.push(nowMsg(line));
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
const FENCE_LINE_RE = /^```/m;

/**
 * 尾巴里格式内容的起点（第一个尖括号标签或行首 ``` 围栏）；没有 → -1。
 *
 * 8/10 实弹收口：旧口径整串检验、整串拼接——元话语（收笔自检逐条、ask 开场白
 * 起了又劝退）挂在格式块前面时跟着一起进定稿（HK 5 会话 11 拍：7 个裸尾巴段
 * 里 3 个带元话语，41 个稿段 0 违约）。改为**只取格式内容**：从第一个标签/围栏
 * 起切，之前的自由文本一律丢弃；纯自由文本尾巴（闲聊收笔）仍整段不进正文。
 */
export const formatTailStart = (tail: string): number => {
	const tag = FORMAT_TAIL_RE.exec(tail)?.index ?? -1;
	const fence = FENCE_LINE_RE.exec(tail)?.index ?? -1;
	if (tag < 0) return fence;
	return fence < 0 ? tag : Math.min(tag, fence);
};

/**
 * 逐字相同的格式块去重（8/10 实弹：预设状态栏规则＋谢幕注入双指令源下，
 * 模型把同一份状态栏在一条尾巴里输出了两遍）。零名单零识别——块＝任意
 * `<Tag>…</Tag>`，只删与已见块**完全相同**的重复，内容有任何差异都不动。
 */
export const dedupeIdenticalBlocks = (s: string): string => {
	const seen = new Set<string>();
	return s
		.replace(/<([A-Za-z][\w-]*)>[\s\S]*?<\/\1>/g, (block) => {
			const key = block.trim();
			if (seen.has(key)) return "";
			seen.add(key);
			return block;
		})
		.replace(/\n{3,}/g, "\n\n")
		.trim();
};

/**
 * 尾巴里 `<content>` 块以正文结尾文字开头（模型按卡格式在 `<content>` 里重述正文）时，
 * 裁掉重复前缀——正文以稿件为准，定稿不得出现两遍。
 * （8/13 实弹：B1 的 `<content>` 以正文末段开头 + 新内容；B2 的 `<content>` 整段重述正文。）
 */
const trimContentBodyRepeat = (body: string, inner: string): string => {
	const d = body.trim();
	const i0 = inner.trimStart();
	if (!d || !i0) return inner;
	for (let n = Math.min(d.length, i0.length); n > 0; n--) {
		const suffix = d.slice(d.length - n);
		if (i0.startsWith(suffix)) {
			const rest = i0.slice(n).trim();
			return rest ? `\n${rest}` : "";
		}
	}
	return inner;
};

export const mergeFinalText = (draft: string, text: string): string => {
	const d = draft.trim();
	const t = text.trim();
	if (!d) return dedupeIdenticalBlocks(t);
	if (!t || d === t) return d;
	// 稿件已包含 text（模型边写边交，text 是半截）：稿件已是全量
	if (d.includes(t)) return d;
	// 只认「稿件在尾巴开头」的续写增量（正文在前、尾巴在后）；稿件出现在尾巴中段
	// 不切——格式块（state1/options 等）在正文之前，indexOf 会把它当「增量起点」把
	// 前面的格式块一起切掉（8/13 实弹：<state1>…<content>正文</content>，状态栏全丢）。
	let tail = t;
	if (t.startsWith(d)) tail = t.slice(d.length);
	const from = formatTailStart(tail);
	if (from < 0) return d;
	// 尾巴里 `<content>` 重述的正文裁掉（正文以稿件为准）
	const tailPart = tail
		.slice(from)
		.trim()
		.replace(/<content>([\s\S]*?)<\/content>/g, (whole, inner: string) => {
			const trimmed = trimContentBodyRepeat(d, inner);
			return trimmed ? `<content>${trimmed}</content>` : "";
		});
	return dedupeIdenticalBlocks([d, tailPart].filter(Boolean).join("\n\n"));
};

export class StageEngine {
	#deps: StageEngineDeps;
	#busy = false;
	#queue: string[] = [];
	#abort: AbortController | null = null;
	#warnedMacros = "";
	#warnedAuditDrop = 0;
	#warnedProtocolDrop = "";
	/** 合约声明失败的指纹（本进程不再重试同指纹——失败不落缓存，重启/换卡自然重试） */
	#declareFailedFp = "";
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
		const { cwd, events: rawEv = {} } = this.#deps;
		const sm = this.#deps.getSessionManager();

		// ---- 全流程文字留档 ----
		// 前端能看到的每一个字、每一次工具调用/回执、每一次注入，按时序全记。
		const beatLog: Array<{ ts: number; ev: string; data: string }> = [];
		const blog = (event: string, data: string) => beatLog.push({ ts: Date.now(), ev: event, data });
		// 拦截所有发往前端的事件
		const ev: typeof rawEv = {
			...rawEv,
			onDelta: (kind, delta, draft, reset) => {
				blog(draft ? "draft_delta" : kind === "thinking" ? "thinking" : "text", delta);
				rawEv.onDelta?.(kind, delta, draft, reset);
			},
			onStreamClear: () => { blog("stream_clear", ""); rawEv.onStreamClear?.(); },
			onDraftResync: (segs) => { blog("draft_resync", segs.join("\n---\n")); rawEv.onDraftResync?.(segs); },
			onActivity: (d) => { blog("activity", d); rawEv.onActivity?.(d); },
			onNotify: (lv, t) => { blog("notify", `[${lv}] ${t}`); rawEv.onNotify?.(lv, t); },
		};
		// 工具调用/回执由 agentLoop 内记录（见下方 blog 透传）
		const _blog = blog; // 透传给 agentLoop 用

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

		const model = this.#deps.getModel();
		if (!model) {
			ev.onNotify?.("error", "尚未配置剧情模型——请先在「连接」面板选择模型。");
			return { aborted: false, error: "no-model" };
		}

		if (userText !== null) {
			sm.appendMessage(nowMsg(userText));
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
		// 常驻内容按原序进末端（M-R1 零归拢）；D/E 已在装载期静态入 skillPacks（此处跳过）；G/H/I 退场。
		const phAll = legacyBackstage ? [] : (evalPostHistoryBlocks(materials, lastUserText) ?? []);
		const phTail: ResidentPiece[] = [];
		const phReport: AssemblyReportItem[] = [];
		for (const b of phAll) {
			if (!b.content.trim()) continue;
			const rule = lookupBlockRule(materials.splitTable, b.name);
			const pieces = splitWithManifest(materials.presetSkillManifest, b.id, rule, b.name ?? "", b.content);
			for (const r of pieces.resident) {
				phTail.push({ name: b.name, section: r.section, text: r.text });
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

		// M-A 工具组 + skill_read（M-R2 名称制：文件包+进口包非空才挂——不凭空点名）。
		// 回合工作区 = 正文工件的落点；字数目标在此提取一次（数据，供末端注入）。
		// 读侧依赖先建：统一层按注入情况决定哪些世界书工具上清单（M-D2）。
		// 可读名单：拉取档 skill 文件（常驻档已随 system 全文送达，不重复上单）+ 进口 topic 包。
		// 必定读取（每轮）skill：受理门强制落笔前先读（认 frontmatter `每轮` 标志，不认具体名字）
		const forcedSkills = materials.skillFiles.filter((f) => f.everyBeat).map((f) => f.name);
		const skillNames = [
			...materials.skillFiles.filter((f) => !f.resident).map((f) => f.name),
			...materials.skillPacks.keys(),
		];
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
			...(skillNames.length > 0 ? [skillReadTool(config.language, skillNames)] : []),
			...writeTools(config.language).filter((t) => t.name !== "ask" || askEnabled),
			...mediaTools,
			...(assistantTool ? [assistantTool] : []),
			...mcpTools,
		];
		const ws = createWorkspace();
		const wsDeps: WorkspaceDeps = {
			rules: extractDraftRules([...materials.presetRuleTexts, ...phAll.map((b) => b.content)]),
			userName: config.userName,
			charName: card.name,
			baseState: state,
		};

		const systemPrompt = buildStageSystemPrompt({
			card,
			config,
			constantLore: constantLoreOf(materials),
			// M-R1：预设留驻内容原文原序直通（零归拢零引导语，PLAN-RECTIFY §2.1-9）
			presetResident: materials.presetResident.map((p) => p.text),
			// skill 素材位（M-R2）：常驻包全文 + 拉取包 L1 索引，无包零痕迹
			skills: materials.skillFiles,
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
			presetTail: phTail.map((p) => p.text),
			languageMismatch,
			panelIndex,
			...(wsDeps.rules.wordRange ? { wordRange: wsDeps.rules.wordRange } : {}),
			loreIndex: formatLoreIndex(materials.entries),
			rosterIndex: formatRosterIndex(state),
		});

		// §4.B 输出合约：v1 供数＝装载期一次性模型声明（M-R4 首件，指纹缓存，换卡/改预设即重声明）；
		// 未开启/声明失败 → v0 识别器供数（冻结、只降不升）。文件用户可改、改了以文件为准。
		// 谢幕注入消费合约——全仓库唯一提到状态栏的送模文案；合约空则不注入，拍自然收束。
		let contractGen = contractFromCard(materials.statusBarFormats);
		if (this.#deps.declareContract) {
			const fp = declareFingerprint(card, materials.preset);
			if (fp !== this.#declareFailedFp) {
				const declared = await ensureDeclaredContract(cwd, fp, async () => {
					ev.onActivity?.("装载声明：输出合约（本套卡+预设一次性）");
					const p = buildDeclarePrompt(card, materials.preset);
					// 声明是判断题：放开思考（透传会话档），maxTokens 给足防隐形思考烧光配额（8/02 教训）
					return this.#sideText(
						model,
						p.systemPrompt,
						p.userText,
						await this.#deps.getAuth(model),
						8192,
						this.#deps.getThinking?.(),
					);
				});
				if (declared) contractGen = declared;
				else this.#declareFailedFp = fp;
			}
		}
		const curtain = curtainInjection(syncOutputContract(cwd, contractGen));

		// 末端消息 = 动态注入 + 本拍用户原话。
		// 顺序要紧：用户当拍的话必须落在**整个上下文的最后一句**。
		// 注入块（世界状态/索引等）压在提问之后时，模型会把提问读成历史里的旧话，
		// 于是既不检索也不正面回应——8/03 实测：同一提问，挪到注入之后立刻触发 lorebook_search。
		const endsWithUser = history[history.length - 1]?.role === "user";
		const past = endsWithUser ? history.slice(0, -1) : history;
		// 规划卡（五注入之一）：每拍第 1 轮随末端注入送达（工作区新建必空），用户话保持最后一句。
		const injWithCard = tools.length > 0 ? `${injection}\n\n${PLAN_CARD}` : injection;
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
				// skill_read 名单投影 + 必定读取（每轮）skill 集合（受理门用）
				skillNames,
				forcedSkills,
				...(curtain ? { curtain } : {}),
				_blog,
			});
			if (turn.final) final = turn.final;
			if (turn.errored) errored = turn.errored;
			text += turn.text;
			loopTail = turn.tailText ?? turn.text;
		}

		const aborted = final?.stopReason === "aborted";
		if (!text) text = textOfAssistant(final);

		// M-E 兜底封笔：分段续写完但模型始终没调 draft_seal（催告已给过一轮）。
		// 8/10 起封笔只是状态切换（验收已整体退役），此处仅补齐工件状态。
		if (ws.appends > 0 && !ws.sealed && ws.draft.trim()) {
			runWriteTool(ws, wsDeps, "draft_seal", {});
		}

		// 定稿 = 工作区稿（工件）；工作区空（中断半拍/循环认栽）退回直出正文
		// **但**模型常把格式栈尾巴（状态栏/catsay 等）走 text 通道而非 draft_write 参数：
		// 二选一会把那部分连内容一起扔掉（8/05 实锤：模型宣告要出「正文+状态栏+咪咪点评」，
		// draft_write 只交了正文，屏上流式见过三样、落树只剩一样）。故此处**合并**：
		// 稿件为主体，text 里**格式特征**的尾巴补回（纯文本闲聊不进正文）。
		const finalText = mergeFinalText(ws.draft, ws.draft.trim() ? loopTail : text);

		// 全流程文字留档：beatLog 时序 + merge 四件全部落进 session JSONL
		_blog("merge_input_draft", ws.draft);
		_blog("merge_input_tail", loopTail);
		_blog("merge_output", finalText);
		sm.appendCustomEntry("rp-text-debug", { beatLog, draft: ws.draft, loopTail, finalText });

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

		// M-A：#revise 旁路停用（8/10 验收整体退役；修改由模型自发 draft_edit 承担）。
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
	 * M-A agent 循环（开放式）。M-R1（PLAN-RECTIFY §2.3）起由五注入日程驱动：
	 * 规划卡随首轮末端注入送达；未封笔的轮次注进度行（每轮替换）/判定（一次性）；
	 * seal（含兜底封笔）之后依次给记账、谢幕席位；日程走完、模型停手即收束。
	 * 宽进严出（D2）：直出正文自动代收为 draft_write；无稿也无正文 → 逼稿一次；
	 * MAX_ROUNDS 安全阀，触阀撤工具收场（谢幕注入未给过则并入收场句）。
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
		/** skill_read 可读名单投影（让模型知道有哪些 skill 可用） */
		skillNames: string[];
		/** 必定读取（每轮）skill 名单：落笔前受理门强制先读（制造停顿=死磕燃料） */
		forcedSkills: string[];
		/** 谢幕注入文案（输出合约非空才有；无 = 不注入，拍自然收束） */
		curtain?: string;
		/** 全流程文字留档 */
		_blog?: (event: string, data: string) => void;
	}): Promise<{ final: AssistantMsgLike | null; errored?: string; text: string; tailText?: string }> {
		const rawEv2 = this.#deps.events ?? {};
		const blog = o._blog ?? (() => {});
		const ev: typeof rawEv2 = {
			...rawEv2,
			onDelta: (kind, delta, draft, reset) => {
				blog(draft ? "draft_delta" : kind === "thinking" ? "thinking" : "text", delta);
				rawEv2.onDelta?.(kind, delta, draft, reset);
			},
			onStreamClear: () => { blog("stream_clear", ""); rawEv2.onStreamClear?.(); },
			onDraftResync: (segs) => { blog("draft_resync", segs.join("\n---\n")); rawEv2.onDraftResync?.(segs); },
			onActivity: (d) => { blog("activity", d); rawEv2.onActivity?.(d); },
		};
		const readDeps = o.readDeps;
		// 走 tools.ts 派发的工具（统一层世界书族/向量库族 + 台上读侧两件）；其余归工作区执行器。
		// 统一层含写侧（lorebook_write/toggle、memory_add/delete），但它们写的是设定集/记忆库
		// 而不是本拍草稿，故仍走 tools.ts 而非 workspace——「读/写」在此不是路由依据，工件归属才是。
		const READ_TOOLS = new Set([
			...unifiedStageToolNames(readDeps),
			"world_state_get",
			"skill_read",
		]);
		// MCP 外设（8/06 重接）：只认**本会话已连接**的限定名——不能只看 mcp__ 前缀，
		// 否则模型幻觉出的服务器名会被当成 MCP 调用，错过「未知工具」的正常报错路径。
		const MCP_TOOLS = mcpStageToolNames(this.#deps.mcp);
		// 媒体交付（8/06 重接）：结果带 details.rp*，收尾时落成 toolResult 条目供 wire 出帧
		const MEDIA_TOOLS = this.#deps.media
			? mediaStageToolNames({ tts: this.#deps.ttsAvailable?.() === true })
			: new Set<string>();
		// 写账工具（记账轮的结构信号——§2.3：判据必须是结构信号，禁止文本识别）
		const LEDGER_TOOLS = new Set(["world_state_update", "panel_write", "panel_close"]);
		const convo = [...o.messages];
		// 注入留档：所有 convo.push(inject(...)) 改用此函数，自动记录注入文字
		const inject = (text: string) => { blog("injection", text); return nowMsg(text); };
		let last: AssistantMsgLike = o.first;
		let text = "";
		let nudged = false; // 空手逼稿只给一轮机会，防空转
		let sealNudged = false; // 封笔催告（分段续写完但忘了 draft_seal），只给一轮
		let userStopped = false; // P7：用户在 ask 选择卡上点了停止——本拍收束
		let lastConsumed = 0; // 本轮开始时 text 长度——判定「本轮新产出文本」用
		// 五注入日程状态（D9：进度行替换语义；判定/记账/谢幕一次性）
		let verdictInjected = false;
		// 必定读取（每轮）受理门：每段落笔前必须先读完所有 forcedSkills（成功交段后每段重置）
		const readThisSeg = new Set<string>(); // 本段已读的 forcedSkill 名
		let forcedNudgedForSeg = false; // 本段已催过一次（防空转安全阀）
		const skillReadDone = new Set<string>(); // 重复读瘦身：本拍已读过全文的 skill 名
		let ledgerInjected = false;
		let ledgerDone = false;
		let curtainInjected = false;
		// 稿首次落地时的 text 长度：之前的 text 是读题/计划旁白（工具轮的 text 通道产出），
		// 不算正文也不算尾巴；之后的 text 才是尾巴候选（状态栏等）。-1 = 稿未落地。
		let tailStart = -1;
		// 尾巴口径：稿落地后的 text 通道产出（未落地=全量，直出正文路径要整段保留）
		const tailOf = () => (tailStart >= 0 ? text.slice(tailStart) : text);
		// 稿外直出记账（8/10 实弹：规划轮直出的开头因同轮带工具调用不触发代收，
		// 前端当旁白清屏、引擎侧永不入稿——定稿凭空缺前半场）。这里只记事实：
		// 代收消费过的部分不算，稿落地后的尾巴不算；余下的就是「流出去但不在稿内」。
		let directConsumed = false; // o.directText 已被代收进稿
		let strayFrom = 0; // 代收已消费的 text 前缀长度

		for (let round = 0; round < MAX_ROUNDS; round++) {
			lastConsumed = text.length; // 本轮之前的累计文本
			const calls = (last.content ?? []).filter(
				(c): c is { type: string; id?: string; name?: string; arguments?: Record<string, unknown> } =>
					c.type === "toolCall",
			);
			let ledgerCallThisRound = false;

			if (calls.length === 0) {
				// 模型停手：按五注入日程决定下一站，没有下一站才收束。
				if (o.ws.draft.trim()) {
					convo.push(last);
					if (!o.ws.sealed && o.ws.appends > 0 && !sealNudged) {
						// 催封笔（§2.4，只给一次）
						sealNudged = true;
						convo.push(inject(`已续写 ${o.ws.appends} 段未封笔。写完就 draft_seal，没写完接着写。`));
					} else {
						// 停手分支补判定（8/12）：模型勾完路标后直接停手（不调 seal、不调工具），
						// 工具轮判定分支只跑在模型还在调工具时，停手分支原先整个没有判定逻辑——
						// ask 裁决席位同样消失。兜底封笔前补一次（verdictInjected 守卫防循环）。
						if (!verdictInjected && o.ws.plan.length > 0 && draftBodyCharsOf(o.ws) > 0) {
							verdictInjected = true;
							convo.push(inject(verdictInjection(o.ws, o.wsDeps.userName, o.wsDeps.rules.wordRange)));
						} else {
							// 兜底封笔（催告已给过/全量稿天然封笔）→ 记账 → 谢幕：停手不越站
							if (!o.ws.sealed) runWriteTool(o.ws, o.wsDeps, "draft_seal", {});
							if (!ledgerDone && !ledgerInjected && o.ws.patches.length === 0 && o.ws.panelWrites === 0) {
								ledgerInjected = true;
								convo.push(inject(LEDGER_INJECTION));
							} else if (o.curtain && !curtainInjected) {
								ledgerDone = true;
								curtainInjected = true;
								convo.push(inject(o.curtain));
							} else {
								break; // 日程走完：本拍收束
							}
						}
					}
				} else {
					const direct = `${o.directText}${text}`.trim();
					if (direct) {
						// 宽进严出：直出正文代收为 draft_write（已流式外发过，不重复上屏）。
						// internal=true 跳过门禁——代收是兜底，被拦下就等于把这拍正文丢了。
						const r = runWriteTool(o.ws, o.wsDeps, "draft_write", { content: direct }, true);
						directConsumed = true;
						strayFrom = text.length;
						o.ws.strayText = "";
						ev.onActivity?.(r.ok ? "直出正文已代收为 draft_write" : "直出正文代收失败");
						convo.push(last);
						convo.push(inject("正文已代收为 draft_write。需要改就重交，不需要就结束。"));
					} else {
						// 空手停笔（实弹三拍 0 字正文的病灶）：逼稿一次，仍空手才认栽
						if (nudged) break;
						nudged = true;
						convo.push(last);
						convo.push(inject("你还没有落笔。用 draft_append 演出，或 draft_write 一次交完，否则本拍无产出。"));
					}
				}
			} else {
				convo.push(last);
				for (const call of calls) {
					const name = call.name ?? "";
					blog("tool_call", `${name}: ${JSON.stringify(call.arguments ?? {})}`);
					let r: ToolRunResult | MediaStageResult;
					// P7：ask 工具——弹出选择卡等用户应答，答案作为新输入回喂模型。
					// 用户停止（undefined）→ 本拍收束：不再续轮，直接以现稿定稿。
					if (name === "ask" && this.#deps.askUser) {
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
							text: `用户已作答：「${answer}」。`,
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
					// 记账轮的结构信号（§2.3）：写账工具被调＝记账仍在进行；面板写入计数进工作区
					if (LEDGER_TOOLS.has(name)) ledgerCallThisRound = true;
					if (name === "panel_write" || name === "panel_close") o.ws.panelWrites++;
					// 必定读取（每轮）受理门（复现 8/11「强制调用」，泛化为认 `每轮` 标志不认名字）：
					// 落笔前必须先 skill_read 完所有 forcedSkills——没读全就交段，本段首次不受理（回执指路）；
					// 模型执意重交则放行（每段只拦一次，防空转，安全阀同封笔催告）。
					const skillReadName =
						name === "skill_read" ? (call.arguments as { name?: string } | undefined)?.name : undefined;
					if (skillReadName && o.forcedSkills.includes(skillReadName)) readThisSeg.add(skillReadName);
					const unreadForced = o.forcedSkills.filter((n) => !readThisSeg.has(n));
					if (name === "draft_append" && unreadForced.length > 0 && !forcedNudgedForSeg) {
						forcedNudgedForSeg = true;
						r = {
							text: `本段未受理：先 \`skill_read\`${unreadForced.map((n) => `「${n}」`).join("")}构思这一段，再重交。`,
							activity: "交段暂缓——先读必定 skill",
							ok: false,
						};
					} else if (skillReadName && skillReadDone.has(skillReadName)) {
						// 重复读回执瘦身（8/11）：skill 文件在一拍内静态，第二次起的读不再重发全文
						// （首读回执仍在上文）——动作与停顿保留（脚手架本体），重复文本归零。
						// 只对 skill 合法：内容静态可预知，代答不丢信息；MCP 等实时应答永不代答。
						r = {
							text: `「${skillReadName}」本拍已读过，全文见上文回执。`,
							activity: `读 skill「${skillReadName}」· 已读过（省流）`,
							ok: true,
						};
					} else if (
						// 抢跑 seal 时序保证（PLAN-ASK §2.2）：判定是唯一 ask 裁决席位，模型直接封笔会整个
						// 跳过它（8/11 实弹）。首次抢跑不受理，回执即判定文案（同一席位提前送达）；下一轮再调
						// seal 照常受理。8/12 放宽：不再要求路标全勾——模型没勾完就封笔同样会跳过判定
						// （实弹：勾 2/3 直接封笔，判定整个消失），判定送达不该依赖模型自觉勾选。
						// 无计划的分段拍与 harness 内部兜底封笔不走此分支。
						name === "draft_seal" &&
						!verdictInjected &&
						!o.ws.sealed &&
						o.ws.plan.length > 0 &&
						draftBodyCharsOf(o.ws) > 0
					) {
						verdictInjected = true;
						r = {
							text: verdictInjection(o.ws, o.wsDeps.userName, o.wsDeps.rules.wordRange),
							activity: "封笔暂缓——先判定",
							ok: false,
						};
					} else {
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
						}
					// 8/13 定案：稿件只在**被受理后**才上屏（转发器已不再生成时抢跑）——
					// 被受理门拒掉的段落永远不流式，屏上正文 = 最终正文。
					// 模型已走 text_delta 直出过的（先写正文再交稿）不重复转发，避免双份。
					if ((name === "draft_append" || name === "draft_write") && r.ok !== false) {
						const content = name === "draft_append" ? call.arguments?.segment : call.arguments?.content;
						if (typeof content === "string" && content.trim()) {
							const curText = (last.content ?? [])
								.filter(
									(c): c is { type: "text"; text: string } =>
										c.type === "text" && typeof (c as { text?: unknown }).text === "string",
								)
								.map((c) => c.text)
								.join("");
							const shown = `${o.directText}${text}${curText}`;
							if (!shown.includes(content.trim())) {
								ev.onDelta?.("text", content, true, name === "draft_write");
							}
						}
					}
					// 媒体交付要落成 toolResult 条目（wire 只认树上的 toolResult 出媒体帧）——
					// 台上引擎默认剥离工具轨迹，故在此单独收集，谢幕后随正文一起落树。
					const mediaDetails = (r as MediaStageResult).details;
					if (MEDIA_TOOLS.has(name) && mediaDetails && (r as MediaStageResult).isError !== true) {
						o.ws.mediaDeliveries = o.ws.mediaDeliveries ?? [];
						o.ws.mediaDeliveries.push({ toolName: name, details: mediaDetails, text: r.text });
					}
					// 必定读取受理门：本段真交上了 → 清空已读、下一段重新计门
					if (name === "draft_append" && r.ok !== false) {
						readThisSeg.clear();
						forcedNudgedForSeg = false;
					}
					// 重复读瘦身：名单内 skill 首读成功后记名（未知名回落直写不记，避免把 miss 记成已读）
					if (skillReadName && o.skillNames.includes(skillReadName) && r.ok !== false) {
						skillReadDone.add(skillReadName);
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
					blog("tool_result", `${name}: ${r.text}`);
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

			// 稿外直出 = 未被代收的首轮直出 + 稿落地前流出的 text（尾巴与已消费部分除外）。
			// 每轮更新，seal 回执（runCheck）把它作为事实补认。
			if (o.ws.draft.trim()) {
				o.ws.strayText = `${directConsumed ? "" : o.directText}${text.slice(
					strayFrom,
					tailStart >= 0 ? Math.max(strayFrom, tailStart) : text.length,
				)}`.trim();
			}

			// 五注入日程（工具轮后半程）：seal 之后记账→谢幕；未封笔注进度/判定（§2.3）。
			// 停手轮的日程已在上方分支处理；这里只管模型还在干活的轮。
			if (calls.length > 0) {
				if (o.ws.sealed) {
					if (!ledgerDone) {
						if (!ledgerInjected) {
							// 本拍已有落账（结构信号：patch 队列/面板写入）→ 跳过记账注入
							if (o.ws.patches.length > 0 || o.ws.panelWrites > 0) ledgerDone = true;
							else {
								ledgerInjected = true;
								convo.push(inject(LEDGER_INJECTION));
							}
						} else if (!ledgerCallThisRound) {
							ledgerDone = true; // 记账轮结束（模型停止调用写账工具）
						}
					}
					if (ledgerDone && o.curtain && !curtainInjected) {
						curtainInjected = true;
						convo.push(inject(o.curtain));
					}
				} else if (o.ws.plan.length > 0 || o.ws.draft.trim()) {
					const allDone = o.ws.plan.length > 0 && o.ws.plan.every((s) => s.done);
					// 判定以稿非空为门（8/10 实弹：0 字连勾两条也触发了判定＝勾选表演）；
					// 勾完但没落笔 → 继续进度行，判定等正文真出现
					if (allDone && !verdictInjected && draftBodyCharsOf(o.ws) > 0) {
						verdictInjected = true;
						convo.push(inject(verdictInjection(o.ws, o.wsDeps.userName, o.wsDeps.rules.wordRange)));
					} else {
						replaceProgressLine(convo, progressLine(o.ws, o.wsDeps.rules.wordRange, o.skillNames, o.forcedSkills));
					}
				}
				// 工作区仍空（纯探索轮）：不注入——规划卡已随首轮末端注入送达
			}

			// 安全阀最后一轮撤掉工具：模型只能收笔（触阀后以现稿/直出定稿）
			const lastRound = round >= MAX_ROUNDS - 1;
			const ctx: Record<string, unknown> = { systemPrompt: o.systemPrompt, messages: convo };
			if (!lastRound) ctx.tools = o.tools;
			else {
				// 触阀收场（D16）：收场句保留；状态栏点名并入谢幕注入（未给过则在此并入）
				const close = "【收场】本拍轮次已达上限，工具已收起，就此收场。";
				convo.push(inject(o.curtain && !curtainInjected ? `${close}\n\n${o.curtain}` : close));
				curtainInjected = true;
			}

			const s = this.#deps.streamFn(o.model, ctx as never, o.options);
			let final: AssistantMsgLike | null = null;
			const fwd = this.#draftForwarder();
			// thinking_delta 入时间线（思考→工具→正文全链）
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
	 * skill_read 读的是写作方法论而非世界事实，不计入。
	 */
	async #runReadTool(
		o: { ws: TurnWorkspace; language: string },
		readDeps: StageToolDeps,
		name: string,
		args: Record<string, unknown>,
	): Promise<ToolRunResult> {
		if (name !== "skill_read") o.ws.lookups++;
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
		// 8/13 定案：稿件内容不再在生成时抢跑转发——被受理门拒掉的段落会提前上屏、
		// 造成「屏上正文 ≠ 最终正文」（实弹：被拒草稿重复可见）。稿件上屏改到
		// agentLoop 受理成功后统一转发（见 runWriteTool 调用点），这里恒为空操作。
		return () => {};
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
			getSkill: (name) => {
				const m = loadStageMaterials(cwd);
				const body = m.skillFiles.find((f) => f.name === name)?.body ?? m.skillPacks.get(name);
				// 动态表格：skill 正文里的 {{可用skill}} 占位符 → 当前启用 skill 表（名/介绍/必读或按需）
				if (body && body.includes("{{可用skill}}")) {
					const rows = m.skillFiles
						.filter((f) => f.name !== name && !f.resident)
						.map((f) => `| ${f.name} | ${f.description.replace(/\|/g, "\\|").replace(/\s+/g, " ")} | ${f.everyBeat ? "必读" : "按需"} |`);
					const table =
						rows.length > 0
							? ["| skill | 大致介绍 | 读取 |", "|---|---|---|", ...rows].join("\n")
							: "（暂无其他 skill）";
					return body.replace("{{可用skill}}", table);
				}
				return body;
			},
		};
	}

	/** 装配报告写盘（.liyuan/preset-assembly.json）——每块预设去向可查；内容不变不写 */
	#writeAssemblyReport(
		cwd: string,
		materials: StageMaterials,
		phReport: AssemblyReportItem[],
		phTail: ResidentPiece[],
	): void {
		try {
			// 常驻字数 = system 静态 + postHistory 每拍（两通道合计才是真常驻）；按拆层记账标签分列
			const residentChars = { A: 0, B: 0, C: 0 };
			for (const p of [...materials.presetResident, ...phTail]) residentChars[p.section] += p.text.length;
			const report = {
				preset: materials.preset?.name ?? null,
				splitTable: materials.splitTable?.key ?? null,
				residentChars,
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

	// M-A 起 #revise 精修旁路退役（8/10 验收整体退役，revise.ts 已删除）。

	/** 旁路文本调用（精修/场记用）：静默收集，不外发增量；失败返回 {error} */
	async #sideText(
		model: StageModelLike,
		systemPrompt: string,
		userText: string,
		auth: { apiKey?: string; headers?: Record<string, string> },
		maxTokens = 8192,
		reasoning: string | undefined = "off",
	): Promise<string | { error: string }> {
		const options: Record<string, unknown> = {
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens,
			signal: this.#abort?.signal,
			// 精修/场记/压缩是 harness 的机械窄题，默认强制关思考：zen go 对 low/high 无可靠节流
			//（8/02 实测），放开推理会把 maxTokens 整个烧在隐形思考里、正文零输出。
			// 合约声明是判断题（整卡+预设通读），由调用点透传会话思考档（undefined＝随供应商默认）。
			...(reasoning !== undefined ? { reasoning } : {}),
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
