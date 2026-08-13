/**
 * wire 协议：Web 前端与 server 之间的自有消息格式（PLAN-PHASE3 §3/§4）。
 *
 * 本模块与领域层同纪律（PLAN.md D3）：零 pi import，对 pi 的 AgentMessage
 * 只做鸭子类型的结构性访问——pi 0.x 漂移时前端零感知，翻译规则可独立单测。
 *
 * D10：narrative 通道的文本必须是主演模型原始输出，翻译只做通道分发与
 * 结构块（thinking/toolCall）的丢弃，绝不改写正文字符。
 */

import {
	extractScaffoldThinking,
	prepareDisplayText,
	type DisplaySkin,
} from "../src/postprocess.ts";
import { isBackstageText } from "../src/stance.ts";
import { applyDraftOps, type DraftMsgLike } from "../src/draft.ts";
import type { RpPanel } from "../src/panels.ts";
import type { WorldState } from "../src/types.ts";

export type { DisplaySkin };

export type { WorldState, RpPanel };
export { isBackstageText };

export type WireChannel =
	| "user"
	| "narrative"
	| "greeting"
	| "import"
	| "info"
	| "backstage"
	| "image"
	| "audio"
	| "video"
	| "choice"
	/** 对话流内嵌 HTML（show_html 工具 / 正文 ```html 块） */
	| "html";

/** ST 式回复变体：挂在 narrative 上；左右箭头切换，agent 只见当前选中 */
export interface WireSwipe {
	/** 0-based 当前变体序号 */
	index: number;
	/** 已有变体条数（0=尚无角色回复，仍可点右生成） */
	total: number;
}

/**
 * 时间线段（与 src/stage/workspace.ts 的 TurnSegment、web/src/timeline.ts 同构）。
 * 跨边界只走 JSON，故三处各自声明结构而不共享类型。
 */
export type WireSegment =
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string; draft?: boolean }
	| { kind: "tool"; activities: WireActivity[] };

export interface WireMsg {
	channel: WireChannel;
	/** 发言者显示名（narrative/greeting 为角色名，user 为用户名） */
	name?: string;
	text: string;
	/** 模型思维链（原始输出，UI 折叠呈现；无则缺省） */
	thinking?: string;
	/**
	 * 回合时间线：思考 / 工具 / 正文按**发生顺序**排列（引擎经 details.rpTimeline 落树）。
	 * 有此字段时前端按时序依次渲染，取代「思考恒在顶、正文恒在底」的三分区布局。
	 */
	timeline?: WireSegment[];
	/**
	 * 用户中断导致的未完成稿（stopReason=aborted）。
	 * 须上屏并进入 hello 重放，以便「停后可见 / 继续写」。
	 */
	unfinished?: boolean;
	/** user 消息专用：带场外标记（//、（）包裹），该轮助手回复走 backstage 通道 */
	backstage?: boolean;
	/** image / audio / video 通道：资源地址（http(s) 或本服务 /media/ · /audio/） */
	src?: string;
	/** choice 通道专用：选择卡内容（历史重放为已决状态） */
	choice?: WireChoice;
	/**
	 * html 通道专用：文档 HTML（可含完整 <html> 或片段）。
	 * 展示层 iframe 沙箱渲染；scripts=true 时允许脚本（仍隔离于父页面）。
	 */
	html?: string;
	/** html 通道：是否允许脚本（默认 false 更安全；show_html 可显式开启） */
	scripts?: boolean;
	/**
	 * 回复变体（ST swipe）：仅当前分支上最后一轮剧情角色回复携带。
	 * 右箭头在末条时 = 再生成一条（原回复保留在会话树旁支，不产生世界线）。
	 */
	swipe?: WireSwipe;
	/**
	 * 开场白序号（0-based index + 非空总数）。
	 * 挂在 greeting 消息上，避免只靠 /api/card 轮询导致「正文已是第 4 条、角标还是 2」。
	 */
	greetingPick?: { index: number; total: number };
}

/**
 * 剧情决策选择卡（Phase 4 柱 1）：模型经 ask_director 停笔询问，用户
 * 选选项 / 自由输入 / 停止本回合。选后卡片留痕（answer/stopped 已决态）。
 */
export interface WireChoice {
	/** 未决卡的应答关联 id（choice_reply 回传）；历史重放的已决卡缺省 */
	id?: string;
	question: string;
	/** 模型给的 2~4 个选项；input 对话框（无选项、纯自由输入）为空数组 */
	options: string[];
	/** 自由输入框占位文本（input 对话框用） */
	placeholder?: string;
	/** 已决：用户的回答（选项原文或自由输入） */
	answer?: string;
	/** 已决：用户停止了本回合（笔还给用户） */
	stopped?: boolean;
}

/** 会话列表条目（SessionManager.list 的裁剪投影，已按当前卡过滤） */
export interface WireSessionInfo {
	path: string;
	id: string;
	name?: string;
	firstMessage: string;
	/** 最后修改时间（epoch ms） */
	modified: number;
	messageCount: number;
	current: boolean;
	/** 末条 user/assistant 消息预览（≤80 字，借鉴 ST 过去聊天信息密度） */
	preview?: string;
	/** 会话所属卡名（rp-card 条目；与当前卡绑定） */
	cardName?: string;
	/** 会话绑定的角色卡路径（rp-card.data.card；用于前端兜底过滤） */
	card?: string;
}

/** 会话统计（getSessionStats 裁剪投影） */
export interface WireStats {
	userMessages: number;
	assistantMessages: number;
	totalTokens: number;
	cost: number;
	/** 上下文占用百分比（0-100），未知为 null */
	contextPercent: number | null;
	/** 当前估计已装入窗口的 token（与 percent 同源） */
	contextTokens?: number | null;
	/** 当前模型 contextWindow（连接配置可改；未配置时 registry 默认 128000） */
	contextWindow?: number | null;
}

/** 过程活动（过程条：工具调用 + 客户端留档的中间旁白） */
export interface WireActivity {
	/**
	 * tool_start / tool_end 由 server 事件产生；
	 * note = 前端捕获的中间旁白（模型在调工具前流式吐出的计划文字，
	 * 服务端把该中间轮从叙事流过滤时，客户端将其留档进过程清单——server 永不发送此类）。
	 */
	kind: "tool_start" | "tool_end" | "note";
	name: string;
	/** start=参数摘要；end=结果摘要（截断）；note=旁白正文（截断） */
	detail?: string;
	/** tool_end 专用：是否出错 */
	isError?: boolean;
}

/**
 * 服务端持有的剧情生成任务快照。浏览器断线重连时由 hello 一并恢复，
 * 因而 live.segments 是当前生成过程的权威显示态，不依赖旧页面内存。
 */
export type WireTurnStatus =
	| "queued"
	| "running"
	| "waiting_input"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export interface WireTurnSnapshot {
	id: string;
	clientRequestId: string;
	sessionId: string;
	sessionFile?: string;
	input: string;
	status: WireTurnStatus;
	revision: number;
	createdAt: number;
	updatedAt: number;
	live: { segments: WireSegment[] };
	resultEntryId?: string;
	error?: string;
}

/**
 * 右栏「助手」消息（独立会话，2026-07-14 职责拆分）。
 * 与剧情 WireMsg 分开：助手没有叙事通道语义，只有对话与过程。
 */
export interface AssistantMsg {
	role: "user" | "assistant";
	text: string;
	/** 模型思维链（折叠展示） */
	thinking?: string;
	/** 中间步骤（带工具调用的计划旁白）：面板折进「过程」，只露最终回复 */
	mid?: boolean;
	/** 本条消息期间的工具活动（live 时由前端积累；历史重放不带） */
	activities?: WireActivity[];
	/** 助手交付的媒体（show_media 工具）：在助手对话里内联展示，不进剧情流 */
	media?: { src: string; kind: "image" | "audio" | "video"; caption?: string };
}

/** 助手当前模型信息（模型选择器数据） */
export interface AssistantModelInfo {
	provider: string;
	id: string;
	name: string;
}

/**
 * 在线更新状态（主页 chip / 弹窗 / 进度气泡共用一份状态）。
 * phase 流转：none → available →(下载)→ downloading → ready；失败回 available 带 error。
 * ready 跨重启持久（暂存包在 .liyuan-cache/update/，启动脚本应用后自然回 none）。
 */
export interface UpdateWire {
	phase: "none" | "available" | "downloading" | "ready";
	currentVersion: string;
	latestVersion?: string;
	releaseName?: string;
	/** release 正文 markdown（弹窗展示） */
	releaseNotes?: string;
	releaseUrl?: string;
	publishedAt?: string;
	/** 资产字节数（弹窗体积展示） */
	assetSize?: number;
	/** downloading 专用：进度 */
	received?: number;
	total?: number;
	/** ready 专用：zip 校验方式（none=release 未附清单，UI 明示） */
	verified?: "sha256sums" | "none";
	/** 最近一次失败原因（available 态展示，供重试） */
	error?: string;
	/** 启动脚本监护下运行（true 才能「立即重启」；直跑 node 只能下次启动时升级） */
	supervised?: boolean;
}

/** Server → Client 帧 */
export type ServerFrame =
	| {
			type: "hello";
			sessionId: string;
			charName: string;
			userName: string;
			messages: WireMsg[];
			state: WorldState | null;
			stats: WireStats | null;
			/** 当前会话最近一项后台生成任务；活动任务携带断线期间的实时稿件快照。 */
			activeTurn?: WireTurnSnapshot;
			/** agent 自建面板（柱 2）：当前活跃面板全量（页签序） */
			panels: RpPanel[];
			/**
			 * 一档卡皮肤(与 GET /api/cardfront 同源)。
			 * 随 hello 同步下发,保证首屏消息与规则同帧到达——避免 REST 缓存/竞态导致 StatusBlock 回落统一面板。
			 */
			cardfront?: {
				enabled: boolean;
				hasSkin: boolean;
				rules: Array<{ name: string; source: string; flags: string; replace: string }>;
				charName: string;
				userName: string;
			};
	  }
	| { type: "message"; message: WireMsg }
	/** draft=true：该 text 增量是 draft_write 参数的转发（替换语义——重交原地更新，不叠加）；reset=true：本次调用的首个分片 */
	| { type: "delta"; kind: "text" | "thinking"; delta: string; draft?: boolean; reset?: boolean }
	/** 稿件分段重同步（修复/重交后）：前端把屏上全部稿段原位替换为 segments（按空行切段） */
	| { type: "draft_resync"; segments: string[] }
	/** 丢弃当前流式半成品（中间 tool 轮被过滤后，避免计划旁白叠进下一轮 / 误落本地气泡） */
	| { type: "stream"; state: "clear" }
	| { type: "agent"; state: "start" | "end" }
	/** 后台任务状态变化；流式正文仍走 delta，避免每个 token 广播全量快照。 */
	| { type: "turn"; turn: WireTurnSnapshot }
	| { type: "activity"; activity: WireActivity }
	| { type: "state"; state: WorldState }
	/** agent 自建面板变化（panel_write/close 落盘、rewind 回退）：活跃面板全量推送（同 state 的 fs.watch 机制） */
	| { type: "panels"; panels: RpPanel[] }
	| { type: "stats"; stats: WireStats }
	| { type: "notify"; level: "info" | "warning" | "error"; text: string }
	| { type: "compaction"; state: "start" | "end"; ok?: boolean }
	| { type: "sessions"; list: WireSessionInfo[] }
	/** 剧情决策询问（ask_director 停笔）：前端渲染选择卡，等用户应答 */
	| { type: "choice"; id: string; question: string; options: string[]; placeholder?: string }
	/** 询问已决（本端应答成功 / 他端先答 / 超时/中止）：前端把未决卡收敛成留痕态 */
	| { type: "choice_resolved"; id: string; answer?: string; stopped?: boolean }
	/** 助手（右栏独立会话）：全量对齐（连接、面板打开、新对话、换模型后） */
	| {
			type: "assistant_hello";
			messages: AssistantMsg[];
			busy: boolean;
			/** 当前助手模型（null=尚无可用模型） */
			model: AssistantModelInfo | null;
			/** true=未单独指定，跟随剧情模型 */
			follow: boolean;
			/** 当前助手会话路径（便于历史列表高亮） */
			sessionPath?: string;
	  }
	/** 助手历史列表（已按当前角色卡过滤） */
	| { type: "assistant_sessions"; list: AssistantSessionInfo[] }
	| { type: "assistant_message"; message: AssistantMsg }
	| { type: "assistant_delta"; kind: "text" | "thinking"; delta: string }
	| { type: "assistant_state"; state: "start" | "end" }
	| { type: "assistant_activity"; activity: WireActivity }
	/** 在线更新状态变化（发现新版/下载进度/就绪）：全量状态推送 */
	| { type: "update"; update: UpdateWire }
	| { type: "error"; text: string };

/** 助手会话列表条目（绑定角色卡，与剧情会话列表同构裁剪） */
export interface AssistantSessionInfo {
	path: string;
	id: string;
	name?: string;
	firstMessage: string;
	modified: number;
	messageCount: number;
	current: boolean;
	preview?: string;
	cardName?: string;
	card?: string;
}

/** Client → Server 帧 */
export type ClientFrame =
	| { type: "prompt"; text: string; requestId?: string }
	| { type: "abort"; turnId?: string }
	/**
	 * 重新生成最后一轮。
	 * - text 缺省：ST 式——同一条用户消息下新开 sibling 变体（原回复保留，不产生世界线）
	 * - text 给出：编辑用户输入后整轮重来（旧 user+回复进旁支）
	 */
	| { type: "reroll"; text?: string }
	/**
	 * ST 式变体导航 / 再生成（不写世界线）。
	 * prev|next：在同一 user 下的 sibling 间切换；在末条 next = 等同 reroll 无参。
	 * new：强制再生成一条变体。
	 */
	| { type: "swipe"; dir: "prev" | "next" | "new" }
	| { type: "compact" }
	| { type: "sessions" }
	| { type: "open"; path: string }
	/** 剧情决策应答：value=选项原文或自由输入；stop=停止本回合（笔还给用户） */
	| { type: "choice_reply"; id: string; value?: string; stop?: boolean }
	/** 助手（右栏独立会话）：发话 / 停止 / 新对话 / 请求全量 / 选模型（provider+id 均缺省 = 跟随剧情模型） */
	| { type: "assistant_prompt"; text: string }
	| { type: "assistant_abort" }
	| { type: "assistant_new" }
	| { type: "assistant_sync" }
	| { type: "assistant_model"; provider?: string; id?: string }
	/** 助手历史：拉列表 / 打开 / 删除（均按当前角色卡过滤） */
	| { type: "assistant_sessions" }
	| { type: "assistant_open"; path: string }
	| { type: "assistant_delete"; path: string }
	| { type: "new" };

/** 翻译时需要的显示名 */
export interface WireNames {
	charName: string;
	userName: string;
}

interface MsgLike {
	role?: unknown;
	content?: unknown;
	customType?: unknown;
	display?: unknown;
	details?: unknown;
	toolName?: unknown;
	isError?: unknown;
	/** assistant 停止原因：aborted = 用户中断，半截稿须可上屏 */
	stopReason?: unknown;
}

/** show_image 工具结果 → image 消息（图片通道 §6.5）；非该工具或出错返回 null */
function imageOfToolResult(msg: MsgLike): WireMsg | null {
	if (msg.toolName !== "show_image" || msg.isError === true) return null;
	const img =
		msg.details && typeof msg.details === "object"
			? (msg.details as { rpImage?: { src?: unknown; caption?: unknown } }).rpImage
			: undefined;
	if (!img || typeof img.src !== "string") return null;
	return { channel: "image", text: typeof img.caption === "string" ? img.caption : "", src: img.src };
}

/** show_audio / tts 工具结果 → audio 消息；非该工具或出错返回 null */
function audioOfToolResult(msg: MsgLike): WireMsg | null {
	if ((msg.toolName !== "show_audio" && msg.toolName !== "tts") || msg.isError === true) return null;
	const aud =
		msg.details && typeof msg.details === "object"
			? (msg.details as { rpAudio?: { src?: unknown; caption?: unknown } }).rpAudio
			: undefined;
	if (!aud || typeof aud.src !== "string") return null;
	return { channel: "audio", text: typeof aud.caption === "string" ? aud.caption : "", src: aud.src };
}

/** show_video 工具结果 → video 消息；非该工具或出错返回 null */
function videoOfToolResult(msg: MsgLike): WireMsg | null {
	if (msg.toolName !== "show_video" || msg.isError === true) return null;
	const vid =
		msg.details && typeof msg.details === "object"
			? (msg.details as { rpVideo?: { src?: unknown; caption?: unknown } }).rpVideo
			: undefined;
	if (!vid || typeof vid.src !== "string") return null;
	return { channel: "video", text: typeof vid.caption === "string" ? vid.caption : "", src: vid.src };
}

/** show_html 工具结果 → html 消息（对话流内嵌 UI 底座）；非该工具或出错返回 null */
function htmlOfToolResult(msg: MsgLike): WireMsg | null {
	if (msg.toolName !== "show_html" || msg.isError === true) return null;
	const h =
		msg.details && typeof msg.details === "object"
			? (msg.details as {
					rpHtml?: { html?: unknown; title?: unknown; scripts?: unknown; height?: unknown };
				}).rpHtml
			: undefined;
	if (!h || typeof h.html !== "string" || !h.html.trim()) return null;
	return {
		channel: "html",
		text: typeof h.title === "string" ? h.title : "",
		html: h.html,
		scripts: h.scripts === true,
		// 高度提示塞进 src 字段不合适；前端用 text 作标题，高度用默认
	};
}

/**
 * ask_director 工具结果 → choice 消息（决策门禁，Phase 4 柱 1）。工具执行完成
 * 时用户已应答，结果里带着已决的选择卡（details.rpChoice），重放即还原留痕态。
 * 非该工具或结构不符返回 null。
 */
function choiceOfToolResult(msg: MsgLike): WireMsg | null {
	if (msg.toolName !== "ask_director") return null;
	const c =
		msg.details && typeof msg.details === "object"
			? (msg.details as { rpChoice?: { question?: unknown; options?: unknown; answer?: unknown; stopped?: unknown } }).rpChoice
			: undefined;
	if (!c || typeof c.question !== "string") return null;
	const options = Array.isArray(c.options) ? c.options.filter((o): o is string => typeof o === "string") : [];
	const choice: WireChoice = { question: c.question, options };
	if (typeof c.answer === "string") choice.answer = c.answer;
	if (c.stopped === true) choice.stopped = true;
	return { channel: "choice", text: "", choice };
}

/** 从消息 content（字符串或内容块数组）提取纯文本，thinking/toolCall 块丢弃 */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof p === "object" && (p as { type?: unknown }).type === "text"
				? String((p as { text?: unknown }).text ?? "")
				: "",
		)
		.filter(Boolean)
		.join("\n");
}

/** 提取 thinking 块文本（主演思考过程，UI 折叠显示） */
function thinkingOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((p) =>
			p && typeof p === "object" && (p as { type?: unknown }).type === "thinking"
				? String((p as { thinking?: unknown }).thinking ?? "")
				: "",
		)
		.filter(Boolean)
		.join("\n");
}

/** content 是否含 toolCall 块（agent 中间轮会夹带计划旁白 + 工具调用） */
function hasToolCall(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some(
		(p) => p && typeof p === "object" && (p as { type?: unknown }).type === "toolCall",
	);
}

/**
 * 单条 AgentMessage → WireMsg。不属于叙事流的消息（rp-inject、toolResult、
 * 纯工具轮 / 带 toolCall 的中间 assistant、未知类型）返回 null，调用方跳过。
 * opts.backstage：该轮用户以 // 开头（幕后轮），助手回复走 backstage 通道
 * （PLAN-PHASE3 §6.1 显示通道——排版区隔，非上下文切割）。
 */
export type ToWireOpts = { backstage?: boolean; skin?: DisplaySkin | null };

export function toWireMsg(m: unknown, names: WireNames, opts?: ToWireOpts): WireMsg | null {
	if (!m || typeof m !== "object") return null;
	const msg = m as MsgLike;
	const text = textOf(msg.content).trim();
	const skin = opts?.skin ?? null;

	if (msg.role === "user") {
		if (!text) return null;
		return isBackstageText(text)
			? { channel: "user", name: names.userName, text, backstage: true }
			: { channel: "user", name: names.userName, text };
	}
	if (msg.role === "assistant") {
		const aborted = msg.stopReason === "aborted";
		const channel: WireChannel = opts?.backstage ? "backstage" : "narrative";
		const modelThinking = thinkingOf(msg.content).trim();
		// 正常中间 tool 轮：跳过（防叠泡）；**用户中断**的半截须上屏，即便夹着 toolCall
		if (!aborted && hasToolCall(msg.content)) return null;
		// 正常完成且无正文：跳过；中断时即使无 text 也可能有 thinking，后面单独处理
		if (!aborted && !text) return null;

		const scaffoldThinking = text ? extractScaffoldThinking(text) : "";
		const thinking = [modelThinking, scaffoldThinking].filter(Boolean).join("\n\n").trim();
		// narrative：先卡显示正则再策略；backstage 仍纯文本策略（不套角色卡皮肤）
		const display = text
			? channel === "narrative"
				? prepareDisplayText(text, skin)
				: prepareDisplayText(text, null)
			: "";

		if (!display && !thinking) {
			// 空中断：仍留一条锚点，避免 agent_end→resync 后像「什么都没发生」
			if (aborted) {
				return {
					channel,
					name: names.charName,
					text: "（已停止，本轮尚未生成可见内容）",
					unfinished: true,
				};
			}
			return null;
		}

		const body =
			display ||
			(aborted ? "（正文未流出，见思维链）" : "（脚手架已折叠，见思维链）");
		// 时间线：从 details.rpTimeline 取出持久化的段序列（引擎在定稿时写入）
		// text 段必须走 prepareDisplayText——与 msg.text 同管线——否则 <catsay> 等
		// unwrap 标签会以原文暴露在屏上（时间线优先渲染时绕过了 body 的处理结果）。
		const rpTimeline =
			msg.details && typeof msg.details === "object" && !Array.isArray(msg.details)
				? (msg.details as Record<string, unknown>).rpTimeline
				: undefined;
		const tlSkin = channel === "narrative" ? skin : null;
		const timeline =
			Array.isArray(rpTimeline) && rpTimeline.length > 0
				? (rpTimeline as WireSegment[]).map((seg) =>
						seg.kind === "text"
							? { ...seg, text: prepareDisplayText(seg.text, tlSkin) }
							: seg,
					)
				: undefined;
		return {
			channel,
			name: names.charName,
			text: body,
			...(thinking ? { thinking } : {}),
			...(timeline ? { timeline } : {}),
			...(aborted ? { unfinished: true } : {}),
		};
	}
	if (msg.role === "custom") {
		if (msg.display === false) return null; // rp-inject 等幕后注入
		if (msg.customType === "rp-greeting") {
			if (!text) return null;
			const pick =
				msg.details && typeof msg.details === "object"
					? (msg.details as { rpGreeting?: { index?: unknown; total?: unknown } }).rpGreeting
					: undefined;
			// index = 非空序位 0-based（角标用 index+1）；total = 非空条数
			const index = typeof pick?.index === "number" && Number.isFinite(pick.index) ? Math.max(0, pick.index) : undefined;
			const total = typeof pick?.total === "number" && Number.isFinite(pick.total) ? Math.max(0, pick.total) : undefined;
			// 先皮肤（开局占位→HTML）再策略；已是 HTML 载荷则不再 unwrap
			return {
				channel: "greeting",
				name: names.charName,
				text: prepareDisplayText(text, skin),
				...(index !== undefined && total !== undefined && total > 0
					? { greetingPick: { index, total } }
					: {}),
			};
		}
		/** 用户手改后的角色回复：显示同叙事通道 */
		if (msg.customType === "rp-edited-reply") {
			return text ? { channel: "narrative", name: names.charName, text: prepareDisplayText(text, skin) } : null;
		}
		if (msg.customType === "rp-import") {
			return text ? { channel: "import", text: prepareDisplayText(text, skin) } : null;
		}
		// 用户气泡「配音」写入的可展示音频（details.rpAudio；正文尽量不进 LLM 注意力，见 convert 侧仍可能带短标记）
		if (msg.customType === "rp-audio") {
			const aud =
				msg.details && typeof msg.details === "object"
					? (msg.details as { rpAudio?: { src?: unknown; caption?: unknown } }).rpAudio
					: undefined;
			if (aud && typeof aud.src === "string") {
				return {
					channel: "audio",
					text: typeof aud.caption === "string" ? aud.caption : text || "",
					src: aud.src,
				};
			}
		}
		// 其他可显示 custom（压缩摘要横幅等）走 info 通道
		return text ? { channel: "info", text } : null;
	}
	if (msg.role === "toolResult") {
		return (
			imageOfToolResult(msg) ??
			audioOfToolResult(msg) ??
			videoOfToolResult(msg) ??
			htmlOfToolResult(msg) ??
			choiceOfToolResult(msg)
		);
	}
	return null; // bash / 未知类型
}

/**
 * 同一用户输入下的多条 narrative/backstage 折叠进一个气泡。
 * agent 多步工具轮若仍漏出多段正文，重放时也应是一泡而非叠楼。
 * 插图/选择卡等其它通道插在中间不打断「本轮角色泡」归属。
 */
export function foldTurnNarratives(msgs: WireMsg[]): WireMsg[] {
	const out: WireMsg[] = [];
	/** out 内当前剧情轮（上一条非 backstage user 之后）的 narrative/backstage 下标 */
	let turnRoleIdx = -1;
	let turnChannel: "narrative" | "backstage" | null = null;

	const join = (a?: string, b?: string) => [a, b].map((s) => (s ?? "").trim()).filter(Boolean).join("\n\n");

	for (const m of msgs) {
		if (m.channel === "user" && !m.backstage) {
			turnRoleIdx = -1;
			turnChannel = null;
			out.push({ ...m });
			continue;
		}
		if (m.channel === "narrative" || m.channel === "backstage") {
			if (turnRoleIdx >= 0 && turnChannel === m.channel) {
				const prev = out[turnRoleIdx];
				const thinking = join(prev.thinking, m.thinking);
				const unfinished = prev.unfinished === true || m.unfinished === true;
				out[turnRoleIdx] = {
					...prev,
					text: join(prev.text, m.text),
					...(thinking ? { thinking } : {}),
					// 变体元数据以最后一段为准（annotateSwipes 挂在末条）
					...(m.swipe ? { swipe: m.swipe } : prev.swipe ? { swipe: prev.swipe } : {}),
					...(m.name ? { name: m.name } : {}),
					...(unfinished ? { unfinished: true } : {}),
				};
				if (!unfinished) delete out[turnRoleIdx].unfinished;
				continue;
			}
			turnRoleIdx = out.length;
			turnChannel = m.channel;
			out.push({ ...m });
			continue;
		}
		out.push({ ...m });
	}
	return out;
}

/** 全量历史 → wire 消息列表（hello 帧用）；先套稿纸补丁，沿途跟踪场外标记轮，助手回复分道 */
export function toWireHistory(
	messages: unknown[],
	names: WireNames,
	opts?: { skin?: DisplaySkin | null },
): WireMsg[] {
	const out: WireMsg[] = [];
	let backstage = false;
	const skin = opts?.skin ?? null;
	// 稿纸补丁（rp-draft-op）：显示层与送模层同一套函数（src/draft.ts），两侧看到同一份定稿
	const { messages: patched } = applyDraftOps(messages as DraftMsgLike[]);
	for (const m of patched) {
		const role = (m as MsgLike | null)?.role;
		if (role === "user") {
			backstage = isBackstageText(textOf((m as MsgLike).content));
		}
		const w = toWireMsg(m, names, { backstage, skin });
		if (w) out.push(w);
	}
	return foldTurnNarratives(out);
}

/**
 * 助手会话历史 → AssistantMsg 列表（assistant_hello 用）。
 * 只保留 user / assistant 对话面 + show_media 的媒体交付；注入 custom、空轮丢弃；
 * 带 toolCall 的中间轮标 mid（面板折进「过程」）。
 */
export function toAssistantHistory(messages: unknown[]): AssistantMsg[] {
	const out: AssistantMsg[] = [];
	for (const m of messages) {
		if (!m || typeof m !== "object") continue;
		const msg = m as MsgLike;
		const text = textOf(msg.content).trim();
		if (msg.role === "user") {
			if (text) out.push({ role: "user", text });
			continue;
		}
		if (msg.role === "assistant") {
			const thinking = thinkingOf(msg.content).trim();
			if (!text && !thinking) continue;
			out.push({
				role: "assistant",
				text: text || "（本轮只有思考与工具调用）",
				...(thinking ? { thinking } : {}),
				...(hasToolCall(msg.content) ? { mid: true } : {}),
			});
			continue;
		}
		if (msg.role === "toolResult") {
			const media = assistantMediaOfToolResult(msg);
			if (media) out.push(media);
		}
	}
	return out;
}

/** show_media 工具结果 → 助手媒体消息；非该工具或结构不符返回 null */
export function assistantMediaOfToolResult(msg: MsgLike): AssistantMsg | null {
	if (msg.toolName !== "show_media" || msg.isError === true) return null;
	const md =
		msg.details && typeof msg.details === "object"
			? (msg.details as { asstMedia?: { src?: unknown; kind?: unknown; caption?: unknown } }).asstMedia
			: undefined;
	if (!md || typeof md.src !== "string") return null;
	const kind = md.kind === "audio" || md.kind === "video" ? md.kind : "image";
	return {
		role: "assistant",
		text: typeof md.caption === "string" ? md.caption : "",
		media: { src: md.src, kind, ...(typeof md.caption === "string" ? { caption: md.caption } : {}) },
	};
}

/**
 * 从会话 JSONL 文本解析 rp-card 自描述条目（PLAN-PHASE3 §2.1）。
 * 取**最后一条**（换卡后会补写新标记；旧标记可能仍留在文件前部）。
 * 读前若干 KB 通常够；大会话若标记在尾部由调用方扩大窗口。
 */
export function parseCardFromSessionHead(
	headText: string,
): { card: string; name: string; storyId?: string } | null {
	let found: { card: string; name: string; storyId?: string } | null = null;
	for (const line of headText.split(/\r?\n/)) {
		if (!line.includes('"rp-card"')) continue; // 快速跳过
		try {
			const e = JSON.parse(line) as {
				type?: unknown;
				customType?: unknown;
				data?: { card?: unknown; name?: unknown; storyId?: unknown };
			};
			if (e.type === "custom" && e.customType === "rp-card" && e.data && typeof e.data.card === "string") {
				found = {
					card: e.data.card,
					name: typeof e.data.name === "string" ? e.data.name : "",
					...(typeof e.data.storyId === "string" && e.data.storyId.trim()
						? { storyId: e.data.storyId.trim() }
						: {}),
				};
			}
		} catch {
			// 半行/损坏行跳过
		}
	}
	return found;
}

/** 工具结果 → 过程条摘要文本（取首个 text 块，截断） */
export function summarizeToolResult(result: unknown, maxChars = 200): string {
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	for (const p of content) {
		if (p && typeof p === "object" && (p as { type?: unknown }).type === "text") {
			const t = String((p as { text?: unknown }).text ?? "").trim();
			if (t) return t.length > maxChars ? `${t.slice(0, maxChars)}…` : t;
		}
	}
	return "";
}
