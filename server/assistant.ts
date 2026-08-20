/**
 * 助手会话托管（2026-07-14 职责拆分）：同进程内的第二个 pi 会话。
 *
 * 与剧情会话的关系（会话托管面纪律与 main.ts 同源，PLAN.md D3 的宿主侧延伸）：
 * - 独立会话树：.liyuan-assistant/ 专用目录，绝不进剧情会话列表 / 世界线 / swipe。
 * - 独立扩展集：noExtensions（不吃 .liyuan/extensions/roleplay.ts 的剧情工具），
 *   只挂本文件的内联工厂（system prompt 覆盖 + 每轮剧情快照注入）。
 * - 独立模型：config.assistantModel 显式指定；缺省跟随剧情模型（每次发话前对齐）。
 *   模型应用走手动路径（不用 session.setModel——那会把共享的默认模型设置一并改写）。
 * - 超集视野：经 StoryBridge 只读剧情会话（转写/统计/账本），写操作走白名单
 *   （命令排队、配置增量、预设草稿、账本补丁），与 REST 面同一套领域函数。
 * - D10：工具面不存在任何「写剧情正文」的通道；红线另在 src/stagehand.ts 提示词层钉死。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, openSync, readSync, closeSync, statSync, unlinkSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionFactory,
	type ToolDefinition,
} from "@liyuan/agent-runtime";
import { Type } from "typebox";

import { loreTools, type LoreDeps } from "../src/tools/lore.ts";
import { memoryTools, type MemoryDeps } from "../src/tools/memory.ts";
import { memoryDeleteChunk, memoryListChunks, memoryManualAdd, memorySearch } from "../src/memory/index.ts";
import { cardTools, type CardDeps } from "../src/tools/card.ts";
import { worldlineTools, type WorldlineDeps, type WorldlineViewLite } from "../src/tools/worldline.ts";
import { panelTools, type PanelDeps } from "../src/tools/panels.ts";
import type { PanelWriteOutput } from "../src/tools/panels.ts";
import { assistantToolDefs } from "./tool-adapter.ts";
import { loadCardFile } from "../src/card.ts";
import {
	appendCodexEntry,
	createCodex,
	findCodex,
	listCodexes,
	validateCodexName,
} from "../src/codex.ts";
import { appendOverlayEntry, loreFingerprint, overlayPathFor, searchEntries, toggleDisabledLore } from "../src/lorebook.ts";
import { PANEL_KINDS } from "../src/panels.ts";
import { dir, sameCardPath } from "../src/paths.ts";
import { listSkills, saveSkill } from "../src/skills.ts";
import {
	buildStagehandInjection,
	buildStagehandPrompt,
	formatStoryRead,
	formatStorySearch,
	STORY_COMMANDS,
	type StorySnapshot,
} from "../src/stagehand.ts";
import { isAssistantDelegateActive } from "../src/assistant-gateway.ts";
import { harvestLocalMediaPaths } from "../src/media-paths.ts";
import { formatState } from "../src/state.ts";
import type { RpConfig, WorldState } from "../src/types.ts";
import {
	applyConfigPatch,
	configPath,
	loadConfig,
	loadEffectivePreset,
	loadMergedLore,
	mergePresetPatches,
	presetOverridePath,
	writeJsonWithBackup,
} from "./rest.ts";
import { parseCardFromSessionHead } from "./wire.ts";

/** 剧情会话桥：main.ts 提供，助手工具经此只读剧情面 / 提交白名单写操作 */
export interface StoryBridge {
	/** 剧情会话消息（当前分支，内存态；toWireHistory 同源输入） */
	storyMessages(): unknown[];
	/** 剧情快照（助手每轮末端注入；不含助手自身字段） */
	snapshot(): Omit<StorySnapshot, "assistantModel" | "assistantFollows">;
	/** 剧情命令（流式中自动排队到本轮结束）；返回是否排队 */
	queueStoryCommand(text: string): boolean;
	/** 世界状态（当前剧情会话的账本） */
	worldState(): WorldState;
	/** 账本补丁（落盘 + await statesync） */
	applyStatePatch(patch: Record<string, unknown>): Promise<{ applied: string[]; warnings: string[] }>;
	/** 配置/预设变更后热载剧情会话（流式中自动排队） */
	softRefreshConfig(): Promise<void>;
	/** 可用模型清单 + 当前剧情模型（/api/models 同源） */
	listModels(): {
		current: { provider: string; id: string; name: string } | null;
		models: Array<{ provider: string; providerName: string; id: string; name: string; contextWindow: number }>;
	};
	// ---- 作者权限：写文件 + 收编进剧情会话（内存/树/前端）——与剧情 agent 落点一致 ----
	/** 当前角色卡名（补充设定集按卡分文件、卡库落点用） */
	cardName(): string;
	/**
	 * 向量记忆作用域（M-D3）：当前剧情会话 + 当前卡**路径**。
	 * 助手的记忆工具查的是**剧情那边**的库——用户问「你记得什么」问的不是助手自己的会话。
	 * 必须给路径而非卡名：scopeId 按路径 hash（src/memory/config.ts:36）。
	 */
	memoryScope(): { sessionId: string; card?: string };
		/** 世界线视图（M-D5）：从当前剧情会话树抽存档点并组装视图 */
		worldlineView(): unknown;
		/** 面板读写（M-D5）：当前剧情会话的面板，读/写/关经盘 sync 与前端双工 */
		storyPanels(): { load(): Record<string, { name: string; kind: "markdown" | "svg" | "html"; content: string; archived?: boolean }>; write(input: { name: string; kind: string; content: string }): { ok: true; created: boolean; reopened: boolean; activeCount: number; overLimit: boolean } | { ok: false; error: string }; close(name: string): { ok: boolean; error?: string }; };
	/** 写面板（落盘 + await panelsync 收编剧情扩展内存） */
	writePanels(list: Array<{ name: string; kind: string; content: string }>): Promise<{
		imported: number;
		names: string[];
		errors: string[];
	}>;
	/** 把本机图片/音频/视频交付到助手自己的对话（复制进 .liyuan-media，返回可访问 src） */
	deliverMedia(absPath: string): { ok: true; src: string; kind: "image" | "audio" | "video" } | { ok: false; error: string };
	/**
	 * 委托模式：把媒体同时推到剧情对话流（与 show_image 同源通道）。
	 * 仅当剧情 agent 的 assistant_run 活跃时由 show_media 调用。
	 */
	emitStoryMedia?(media: { src: string; kind: "image" | "audio" | "video"; caption?: string }): void;
	/** 收编世界书补充设定集改动进剧情会话（写文件后调，触发 /rprefresh 重载 lore） */
	refreshStoryMaterials(): Promise<void>;
	/** 收编知识库挂载变化（写文件后调，/codexmount 命令桥） */
	mountCodex(name: string, on: boolean): void;
}

export interface AssistantModelSel {
	provider: string;
	id: string;
}

/** 委托交回载荷（return_answer / 放弃 / 兜底） */
export interface AssistantReturnPayload {
	summary: string;
	ok?: boolean;
	abandoned?: boolean;
	viaReturnTool?: boolean;
}

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
	/** 绑定的剧情会话 id（一对一，避免跨剧情聊天污染助手上下文） */
	storyId?: string;
}

export interface AssistantHost {
	/** 发话（剧情/助手各自独立排队） */
	prompt(text: string): Promise<void>;
	/**
	 * 剧情侧委托：跑到助手调用 return_answer（或放弃/兜底）为止。
	 * 调用方负责 UI 上的 user 回显。
	 */
	runTask(text: string): Promise<AssistantReturnPayload>;
	abort(): Promise<void>;
	/** 开新对话（旧会话文件保留在 .liyuan-assistant/，不再续接；绑定当前角色卡） */
	newConversation(): Promise<void>;
	/** 按当前角色卡列出助手历史 */
	listSessions(): Promise<AssistantSessionInfo[]>;
	/** 打开助手会话文件（须属当前卡） */
	openSession(path: string): Promise<void>;
	/** 删除助手会话（不能删当前打开的） */
	deleteSession(path: string): Promise<void>;
	/** 换剧情卡后：切到该卡最近助手会话，没有则新建 */
	switchToCard(): Promise<"switched" | "created">;
	/**
	 * 对齐当前剧情会话：有绑定该 storyId 的助手历史则打开，否则新建。
	 * 新剧情聊天 / 切换剧情会话时调用，避免接着旧助手上下文。
	 */
	switchToStory(storyId: string): Promise<"switched" | "created" | "same">;
	/** 当前会话文件路径 */
	sessionPath(): string | undefined;
	/** 选模型：null=回到跟随剧情模型；写入 config.assistantModel */
	setModel(sel: AssistantModelSel | null): Promise<void>;
	modelInfo(): { provider: string; id: string; name: string } | null;
	/** true=未单独指定模型（跟随剧情模型） */
	follows(): boolean;
	/** 会话历史（wire 层转 AssistantMsg） */
	messages(): unknown[];
	isStreaming(): boolean;
	dispose(): Promise<void>;
}

export interface CreateAssistantHostOptions {
	cwd: string;
	bridge: StoryBridge;
	/** 会话事件透传（main.ts 翻成 assistant_* wire 帧）；换新对话后自动续接 */
	onEvent(event: unknown): void;
	/** 扩展错误上报 */
	onError(text: string): void;
	/** headless UI 上下文（与剧情会话共用 main.ts 的实现即可） */
	uiContext: unknown;
}

/** 文本工具结果 */
const text = (t: string, isError = false) => ({
	content: [{ type: "text" as const, text: t }],
	...(isError ? { isError: true } : {}),
});

/** 宽容解析 JSON 对象参数（模型传字符串最稳，不吃 provider 的嵌套 schema 兼容性） */
const parseJsonObject = (raw: string): Record<string, unknown> | null => {
	try {
		const v = JSON.parse(raw) as unknown;
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
};

// ---------- 助手工具面（白名单写 + 只读剧情面） ----------

type AssistantUiSelect = (
	title: string,
	options: string[],
	opts?: { signal?: AbortSignal },
) => Promise<string | undefined>;

interface StagehandToolHooks {
	/** 是否处于剧情委托（assistant_run） */
	isDelegating: () => boolean;
	/** 交回剧情侧；返回 false 表示当前没有挂起的委托 */
	settleReturn: (payload: AssistantReturnPayload) => boolean;
	/** 选择卡（与剧情 ask 同源 UI） */
	select: AssistantUiSelect;
	/** 本委托回合已交付的媒体内容指纹（防 show_media + 自动捞路径重复） */
	noteMediaDelivered: (contentKey: string) => void;
	wasMediaDelivered: (contentKey: string) => boolean;
	/** 文件内容指纹（与 /media/{key} 命名一致） */
	mediaContentKey: (absPath: string) => string | null;
}

const ABANDON_OPTION = "放弃并返回";

function ensureAbandonOption(options: string[]): string[] {
	const list = options.map((o) => String(o ?? "").trim()).filter(Boolean);
	const has = list.some((o) => /放弃|返回剧情|取消委托|abort|cancel/i.test(o));
	if (!has) list.push(ABANDON_OPTION);
	return list.slice(0, 6);
}

function isAbandonChoice(answer: string | undefined): boolean {
	if (!answer) return true; // 用户点停止卡 = 放弃
	return /放弃|返回剧情|取消委托|^取消$|abort|cancel/i.test(answer.trim());
}

function createStagehandTools(cwd: string, bridge: StoryBridge, hooks: StagehandToolHooks): ToolDefinition[] {
	const tools: ToolDefinition[] = [];

	// ---- 委托交回 / 卡住问人（先于其它工具注册，提示词与完成协议挂钩） ----
	tools.push(
		defineTool({
			name: "return_answer",
			label: "交回结果",
			description:
				"Hand the final result back to the story agent (or end a delegated task). Call when the task is done, failed with a clear reason, or the user chose to abandon. During a story-delegated turn this is REQUIRED—do not only write a chat reply. answer = concise summary for the story model (what was done, paths, errors).",
			parameters: Type.Object({
				answer: Type.String({ description: "交给剧情侧的结论摘要（成功结果 / 失败原因 / 已交付物说明）" }),
				abandoned: Type.Optional(Type.Boolean({ description: "true = 用户放弃或主动收束，未完成目标" })),
				ok: Type.Optional(Type.Boolean({ description: "false = 任务失败（默认 true，除非 abandoned）" })),
			}),
			async execute(_id, params) {
				const abandoned = params.abandoned === true;
				const ok = abandoned ? false : params.ok !== false;
				const settled = hooks.settleReturn({
					summary: params.answer.trim() || (abandoned ? "（已放弃）" : "（无摘要）"),
					ok,
					abandoned,
					viaReturnTool: true,
				});
				if (!settled && !hooks.isDelegating()) {
					// 右栏直聊：无挂起委托，把结论留在对话即可
					return text(`已记录结论（当前非剧情委托）：${params.answer.trim()}`);
				}
				if (!settled) {
					return text("交回信号已发出，但未找到挂起的委托（可能已超时收束）。", true);
				}
				return {
					content: [
						{
							type: "text" as const,
							text: abandoned ? "已放弃并交回剧情侧。" : "已将结果交回剧情侧。",
						},
					],
					// 交回后本轮助手 loop 可结束，不必再生成长文
					terminate: true,
				};
			},
		}),
		defineTool({
			name: "ask_user",
			label: "询问用户",
			description:
				"When stuck, missing info, or need a decision—show a choice card. Provide 2–4 concrete options; the system always ensures an abandon option exists. Do NOT silently stop on hard problems. If the user picks abandon, call return_answer with abandoned=true.",
			parameters: Type.Object({
				question: Type.String({ description: "要问用户的问题（说明卡点）" }),
				options: Type.Array(Type.String(), {
					description: "2～4 个选项；可含你建议的路径。系统会补上「放弃并返回」若你未写",
				}),
			}),
			async execute(_id, params, signal) {
				const options = ensureAbandonOption(Array.isArray(params.options) ? params.options : []);
				if (options.length < 2) {
					return text("至少需要 2 个选项（含放弃）。", true);
				}
				const answer = await hooks.select(params.question.trim() || "请选择", options, { signal });
				if (isAbandonChoice(answer)) {
					hooks.settleReturn({
						summary: `用户选择放弃：${answer ?? "停止"}`,
						ok: false,
						abandoned: true,
						viaReturnTool: true,
					});
					return {
						content: [{ type: "text" as const, text: "用户选择放弃并返回。请再调 return_answer 确认交回（若尚未交回）。" }],
						// 已 settle；仍提示模型可再 return_answer，但 terminate 避免空转
						terminate: true,
					};
				}
				return text(`用户选择：${answer}\n请据此继续；完成后调用 return_answer。`);
			},
		}),
	);

	tools.push(
		defineTool({
			name: "story_info",
			label: "剧情档案",
			description:
				"Read the full dossier of the current roleplay: character card, story model, config, preset block list, world state ledger, context stats. Call this before diagnosing or changing anything.",
			parameters: Type.Object({}),
			async execute() {
				const config = loadConfig(cwd);
				const snap = bridge.snapshot();
				const models = bridge.listModels();
				const preset = loadEffectivePreset(cwd);
				const lines: string[] = [];
				lines.push(
					`剧情会话 ${snap.sessionId}｜角色卡「${snap.cardName}」｜消息 ${snap.messageCount} 条｜${snap.streaming ? "正在生成" : "空闲"}`,
				);
				lines.push(
					`剧情模型：${models.current ? `${models.current.provider}/${models.current.id}` : "（未就绪）"}${snap.thinkingLevel ? `（思考档 ${snap.thinkingLevel}）` : ""}｜上下文已用 ${snap.contextPercent !== null ? `${Math.round(snap.contextPercent)}%` : "未知"}`,
				);
				const { assistantModel: _am, ...rest } = config;
				lines.push(`\n【配置 liyuan.config.json】\n${JSON.stringify(rest, null, 2)}`);
				if (preset.preset) {
					const p = preset.preset;
					const blocks = p.blocks
						.map(
							(b) =>
								`- [${b.enabled ? "开" : "关"}] ${b.id}「${b.name}」 ${b.channel} · ${b.content.length} 字`,
						)
						.join("\n");
					lines.push(
						`\n【预设「${p.name}」${preset.fromOverride ? "（含未保存草稿）" : ""}】采样参数 ${JSON.stringify(p.samplers)}\n${blocks}`,
					);
				} else {
					lines.push(`\n【预设】未配置${preset.path ? `（文件缺失：${preset.path}）` : ""}`);
				}
				lines.push(`\n【世界状态】\n${formatState(bridge.worldState())}`);
				return text(lines.join("\n"));
			},
		}),
		defineTool({
			name: "story_read",
			label: "读剧情记录",
			description:
				"Read the story transcript by floor number (same numbering the user sees in the UI). Default: last 8 floors, user-visible text. Use view='raw' to inspect the model's raw output (scaffolding, status blocks, thinking) when diagnosing format problems.",
			parameters: Type.Object({
				last: Type.Optional(Type.Number({ description: "取最近 N 层（默认 8，上限 60）" })),
				from: Type.Optional(Type.Number({ description: "起始楼层（含）" })),
				to: Type.Optional(Type.Number({ description: "结束楼层（含）" })),
				view: Type.Optional(Type.String({ description: "display（默认，用户可见正文）| raw（原始输出含思维链）" })),
				max_chars: Type.Optional(Type.Number({ description: "单层截断上限（默认 4000）" })),
			}),
			async execute(_id, params) {
				return text(
					formatStoryRead(bridge.storyMessages(), {
						last: params.last,
						from: params.from,
						to: params.to,
						view: params.view === "raw" ? "raw" : "display",
						maxChars: params.max_chars,
					}),
				);
			},
		}),
		defineTool({
			name: "story_search",
			label: "搜剧情记录",
			description: "Keyword-search the story transcript; returns matching floors with excerpts.",
			parameters: Type.Object({
				query: Type.String({ description: "检索词" }),
				limit: Type.Optional(Type.Number({ description: "命中上限（默认 8）" })),
			}),
			async execute(_id, params) {
				return text(formatStorySearch(bridge.storyMessages(), params.query, params.limit ?? 8));
			},
		}),
		defineTool({
			name: "story_command",
			label: "剧情命令",
			description: `Run a whitelisted command against the story session: ${STORY_COMMANDS.map((c) => `/${c}`).join(" ")}. E.g. "/reroll" to regenerate the last reply, "/rewind 2" to step back 2 turns, "/compact" to compress context. Queued automatically if the story is streaming. Confirm with the user before destructive ones.`,
			parameters: Type.Object({
				command: Type.String({ description: "完整命令，如 /rewind 2" }),
			}),
			async execute(_id, params) {
				const cmd = params.command.trim();
				const name = cmd.replace(/^\//, "").split(/\s+/)[0]?.toLowerCase() ?? "";
				if (!(STORY_COMMANDS as readonly string[]).includes(name)) {
					return text(`命令不在白名单内：${cmd}（可用：${STORY_COMMANDS.map((c) => `/${c}`).join(" ")}）`, true);
				}
				const queued = bridge.queueStoryCommand(cmd.startsWith("/") ? cmd : `/${cmd}`);
				return text(queued ? `已提交 ${cmd}：剧情正在生成，将在本轮结束后执行。` : `已提交 ${cmd}。`);
			},
		}),
		defineTool({
			name: "config_read",
			label: "读配置",
			description: "Read the project config (liyuan.config.json, normalized).",
			parameters: Type.Object({}),
			async execute() {
				return text(JSON.stringify(loadConfig(cwd), null, 2));
			},
		}),
		defineTool({
			name: "config_write",
			label: "改配置",
			description:
				'Patch the project config (whitelisted fields only: userName/userPersona/displayName/language/scanDepth/maxLoreInjections/greeting/greetingIndex/lorebooks/preset/disabledLore/creationMode/compactEveryNTurns/rosterRefreshEveryNTurns…). Pass a JSON object string, e.g. {"scanDepth":6}. Takes effect from the next story turn. Confirm with the user first.',
			parameters: Type.Object({
				patch: Type.String({ description: 'JSON 对象字符串，如 {"language":"中文"}' }),
			}),
			async execute(_id, params) {
				const patch = parseJsonObject(params.patch);
				if (!patch) return text("patch 不是合法的 JSON 对象", true);
				const before = loadConfig(cwd);
				const next = applyConfigPatch(before, patch);
				writeJsonWithBackup(configPath(cwd), next);
				await bridge.softRefreshConfig();
				const changed = Object.keys(patch).filter(
					(k) =>
						JSON.stringify((next as unknown as Record<string, unknown>)[k]) !==
						JSON.stringify((before as unknown as Record<string, unknown>)[k]),
				);
				return text(
					changed.length
						? `配置已写入并热载。变更字段：${changed.join("、")}`
						: "配置已写入，但没有字段实际变化（不在白名单、值相同、或非法值被丢弃）。",
				);
			},
		}),
		defineTool({
			name: "preset_read",
			label: "读预设",
			description:
				"Read the active preset: block list (id/name/channel/enabled/size) and samplers. Pass id to get one block's full content.",
			parameters: Type.Object({
				id: Type.Optional(Type.String({ description: "块 id（给出则返回该块全文）" })),
			}),
			async execute(_id, params) {
				const { preset, path, fromOverride } = loadEffectivePreset(cwd);
				if (!preset) return text(path ? `预设文件不存在：${path}` : "当前未配置预设文件", true);
				if (params.id) {
					const b = preset.blocks.find((x) => x.id === params.id);
					if (!b) return text(`找不到预设块：${params.id}`, true);
					return text(
						`「${b.name}」（id=${b.id}，${b.channel}，${b.enabled ? "启用" : "停用"}，role=${b.role}）\n\n${b.content}`,
					);
				}
				const blocks = preset.blocks
					.map((b) => `- [${b.enabled ? "开" : "关"}] ${b.id}「${b.name}」 ${b.channel} · ${b.content.length} 字`)
					.join("\n");
				return text(
					`预设「${preset.name}」${fromOverride ? "（含未保存草稿）" : ""}\n采样参数：${JSON.stringify(preset.samplers)}\n${blocks}`,
				);
			},
		}),
		defineTool({
			name: "preset_toggle",
			label: "开关预设块",
			description:
				"Enable/disable one preset block (writes the runtime draft, effective from the next story turn; the user can persist it later in the preset panel). Confirm with the user first.",
			parameters: Type.Object({
				id: Type.String({ description: "块 id" }),
				enabled: Type.Boolean({ description: "true=启用 false=停用" }),
			}),
			async execute(_id, params) {
				const { preset, path } = loadEffectivePreset(cwd);
				if (!preset) return text(path ? `预设文件不存在：${path}` : "当前未配置预设文件", true);
				if (!preset.blocks.some((b) => b.id === params.id)) return text(`找不到预设块：${params.id}`, true);
				const next = mergePresetPatches(preset, { blocks: [{ id: params.id, enabled: params.enabled }] });
				const ovr = presetOverridePath(cwd);
				mkdirSync(join(cwd, ".liyuan"), { recursive: true });
				writeFileSync(ovr, `${JSON.stringify(next, null, "\t")}\n`, "utf8");
				await bridge.softRefreshConfig();
				return text(
					`预设块 ${params.id} 已${params.enabled ? "启用" : "停用"}（运行时草稿，下一轮生效；持久保存需在预设面板点「保存」）。`,
				);
			},
		}),
		defineTool({
			name: "world_read",
			label: "读世界状态",
			description: "Read the structured world state ledger (time, location, characters, inventory, flags, plot threads).",
			parameters: Type.Object({}),
			async execute() {
				const state = bridge.worldState();
				return text(`${formatState(state)}\n\nRAW:\n${JSON.stringify(state)}`);
			},
		}),
		defineTool({
			name: "world_write",
			label: "修世界状态",
			description:
				'Patch the world state ledger (applyPatch semantics: time/location replace, characters merge by name, inventory/plot_threads replace whole list, flags merge). Pass a JSON object string, e.g. {"time":"次日清晨"}. Confirm with the user first.',
			parameters: Type.Object({
				patch: Type.String({ description: "JSON 对象字符串（applyPatch 语义）" }),
			}),
			async execute(_id, params) {
				const patch = parseJsonObject(params.patch);
				if (!patch) return text("patch 不是合法的 JSON 对象", true);
				const r = await bridge.applyStatePatch(patch);
				return text(
					`账本已更新：${r.applied.join("；") || "（无变更）"}${r.warnings.length ? `\n警告：${r.warnings.join("；")}` : ""}`,
				);
			},
		}),
		defineTool({
			name: "models_list",
			label: "列可用模型",
			description: "List available models and the current story model. Useful when diagnosing model-specific quirks or advising a model switch.",
			parameters: Type.Object({}),
			async execute() {
				const { current, models } = bridge.listModels();
				const lines = models.map(
					(m) => `- ${m.provider}/${m.id}（${m.providerName}${m.contextWindow ? `，窗口 ${m.contextWindow}` : ""}）`,
				);
				return text(
					`当前剧情模型：${current ? `${current.provider}/${current.id}` : "（未就绪）"}\n可用（${models.length}）：\n${lines.join("\n")}`,
				);
			},
		}),
		defineTool({
			name: "skill_save",
			label: "沉淀技能",
			description:
				"Save a service how-to note into the shared skill library (.liyuan-skills/) after you have verified it works: endpoint, auth, request format, one tested example, gotchas. Same name overwrites.",
			parameters: Type.Object({
				name: Type.String({ description: "技能名（如 comfyui-生图）" }),
				description: Type.String({ description: "一句话描述（进技能索引）" }),
				content: Type.String({ description: "Markdown 正文：endpoint、认证、请求格式、验证过的示例、注意事项" }),
			}),
			async execute(_id, params) {
				const r = saveSkill(cwd, {
					name: params.name,
					description: params.description,
					content: params.content,
				});
				return text(`${r.updated ? "已更新" : "已保存"}技能：${r.file}（你和剧情模型下次都能照笔记直接用）`);
			},
		}),
	);

	// ---- 作者权限（2026-07-14 定调「助手是超集，唯一不能做的是替剧情模型在剧情流里演戏」）----
	// 面板/世界书/知识库/卡都是剧情资产（文件），不是「剧情正文」，助手可写。
	// 落点与剧情 agent 完全一致，写完经 bridge 收编进剧情会话（内存/树/前端 fs.watch）。
	tools.push(
		defineTool({
			name: "show_media",
			label: "展示素材",
			description:
				"REQUIRED after you generate or download any image/audio/video to a local path. Copies into project media store (/media/…), shows it in the assistant panel, and when this turn is a story-delegated assistant_run ALSO pushes the same media into the main story chat. Never only write the file path in text or return_answer—users cannot see the file until you call this tool. source = absolute or project-relative local path (not http).",
			parameters: Type.Object({
				source: Type.String({ description: "本机媒体文件路径（.png/.jpg/.webp/.gif 或 .mp3/.wav 或 .mp4/.webm 等）" }),
				caption: Type.Optional(Type.String({ description: "简短说明" })),
			}),
			async execute(_id, params) {
				if (/^https?:\/\//i.test(params.source)) {
					return text("show_media 只接本机文件路径；http(s) 链接直接在回复里给出即可。", true);
				}
				const abs = isAbsolute(params.source) ? params.source : join(cwd, params.source);
				const contentKey = hooks.mediaContentKey(abs);
				// 同内容已交付过（本回合）：不重复入库/推送，只回报已有结果
				if (contentKey && hooks.wasMediaDelivered(contentKey)) {
					return text(`该媒体本回合已交付过（/media/${contentKey}…），无需重复 show_media。`);
				}
				const r = bridge.deliverMedia(abs);
				if (!r.ok) return text(r.error, true);
				if (contentKey) hooks.noteMediaDelivered(contentKey);
				// 剧情委托中：同时推到中间对话流，避免「只在右栏、中间空白」
				if (isAssistantDelegateActive() && bridge.emitStoryMedia) {
					bridge.emitStoryMedia({
						src: r.src,
						kind: r.kind,
						...(params.caption ? { caption: params.caption } : {}),
					});
				}
				const dual = isAssistantDelegateActive() ? "；已同步到剧情对话与本地图片库" : "；已写入本地图片库（上传区可刷新查看）";
				return {
					content: [
						{
							type: "text" as const,
							text: `已交付（${r.kind}）：${r.src}${params.caption ? ` — ${params.caption}` : ""}${dual}`,
						},
					],
					details: { asstMedia: { src: r.src, kind: r.kind, ...(params.caption ? { caption: params.caption } : {}) } },
				};
			},
		}),
		defineTool({
			name: "codex_create",
			label: "建知识库",
			description:
				"Create a new named knowledge codex (a lore database independent of the character card, mountable to any conversation). Then use codex_write to add entries and codex_mount to attach it to the story.",
			parameters: Type.Object({
				name: Type.String({ description: "库名（≤40 字）" }),
				description: Type.Optional(Type.String({ description: "一句话说明这个库收集什么" })),
			}),
			async execute(_id, params) {
				const err = validateCodexName(params.name);
				if (err) return text(err, true);
				const r = createCodex(cwd, params.name, params.description ?? "");
				if (!r.ok) return text(r.error, true);
				return text(`知识库「${r.meta.name}」已创建。可用 codex_write 写条目、codex_mount 挂到剧情。`);
			},
		}),
		defineTool({
			name: "codex_write",
			label: "写知识库",
			description:
				"Add an entry to a named knowledge codex (dedup by content). The codex must already exist (codex_create). Entries become searchable once the codex is mounted to the story.",
			parameters: Type.Object({
				codex: Type.String({ description: "目标库名" }),
				title: Type.String({ description: "条目标题" }),
				keys: Type.Optional(Type.Array(Type.String(), { description: "检索关键词（省略则从标题派生）" })),
				content: Type.String({ description: "条目正文" }),
			}),
			async execute(_id, params) {
				if (!findCodex(cwd, params.codex)) {
					const all = listCodexes(cwd).map((c) => c.name).join("、");
					return text(`没有名为「${params.codex}」的知识库${all ? `（现有：${all}）` : "，先用 codex_create 建库"}。`, true);
				}
				const r = appendCodexEntry(cwd, params.codex, {
					title: params.title,
					keys: params.keys ?? [],
					content: params.content,
				});
				if (!r.ok) return text(r.error, true);
				if (r.entry === null) return text("内容与库中已有条目重复，未写入。");
				return text(`已写入知识库「${params.codex}」：【${params.title}】。挂载到剧情后即可被检索命中。`);
			},
		}),
		defineTool({
			name: "codex_mount",
			label: "挂/卸知识库",
			description:
				"Mount or unmount a knowledge codex onto the story conversation (mounted codex entries join the story's lorebook search). Call with on=false to unmount.",
			parameters: Type.Object({
				name: Type.String({ description: "库名" }),
				on: Type.Optional(Type.Boolean({ description: "true=挂载（默认）false=卸载" })),
			}),
			async execute(_id, params) {
				const meta = findCodex(cwd, params.name);
				if (!meta) return text(`没有名为「${params.name}」的知识库。`, true);
				const on = params.on !== false;
				bridge.mountCodex(meta.name, on);
				return text(`知识库「${meta.name}」已${on ? "挂载到" : "从"}剧情对话${on ? "" : "卸载"}（${meta.entryCount} 条）。`);
			},
		}),
	);

	// 统一工具层（PLAN-RP-TOOLING M-D1/M-D2）：与台上共用同一份实现，语料与能力按面注入。
	// 助手是**诊断面**——注入原始世界书，不做外部插件协议剥离（台上剥离是为了生成时
	// 不与 draft_write 互斥；用户问「我的卡为什么带 UpdateVariable」时助手必须看得见）。
	// 助手无写入门禁（gate 不注入）：助手侧本就是「改前与用户确认」的工作模式，
	// 且它的每次调用都由用户当面驱动，不存在台上那种「模型演着演着自作主张写」的场景。
	tools.push(
		...assistantToolDefs<LoreDeps>(
			loreTools,
			{
				searchLore: (query, limit) => searchEntries(loadMergedLore(cwd, loadConfig(cwd)), query, limit),
				loreSize: () => loadMergedLore(cwd, loadConfig(cwd)).length,
				writeLore: (input) => {
					const entry = appendOverlayEntry(overlayPathFor(cwd, bridge.cardName()), input);
					if (entry) void bridge.refreshStoryMaterials();
					return entry;
				},
				listLore: () => loadMergedLore(cwd, loadConfig(cwd)),
				fingerprint: loreFingerprint,
				toggleLore: (fps, enabled) => {
					const config = loadConfig(cwd);
					const next = toggleDisabledLore(config.disabledLore, fps, enabled);
					const disk = { ...config, disabledLore: next } as Record<string, unknown>;
					if (next.length === 0) delete disk.disabledLore;
					writeJsonWithBackup(configPath(cwd), disk);
					void bridge.softRefreshConfig(); // constant 条目影响 system prompt，须重装
					return fps.length;
				},
			},
			loadConfig(cwd).language,
		),
	);

	// 向量库族（M-D3）。作用域取**当前剧情会话**（bridge.snapshot().sessionId + 当前卡）——
	// 助手是诊断面，用户问「你记得什么/把那条记忆删了」时，问的是剧情那边的库，不是助手自己的会话。
	// 与世界书族同样不挂门禁（助手每次调用都由用户当面驱动）。
	const memoryScopeOf = (): { sessionId: string; card?: string } => bridge.memoryScope();
	tools.push(
		...assistantToolDefs<MemoryDeps>(
			memoryTools,
			{
				searchMemory: async (query) => {
					const sc = memoryScopeOf();
					const [narrative, external] = await Promise.all([
						memorySearch(cwd, sc, "narrative", query).catch(() => []),
						memorySearch(cwd, sc, "external", query).catch(() => []),
					]);
					return [...narrative, ...external].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 6);
				},
				addMemory: (input) =>
					memoryManualAdd(cwd, memoryScopeOf(), input.text, { ...(input.title ? { title: input.title } : {}) }),
				listMemory: (storeId) => memoryListChunks(cwd, memoryScopeOf(), storeId),
				deleteMemory: (storeId, id) => memoryDeleteChunk(cwd, memoryScopeOf(), storeId, id),
			},
			loadConfig(cwd).language,
		),
	);

// 角色库族（M-D4）：创卡/读卡
tools.push(
	...assistantToolDefs<CardDeps>(
		cardTools,
		{
			readCard: () => {
				const { path } = currentCard();
				if (!path) return null;
				const c = loadCardFile(path);
				return {
					name: c.name, description: c.description, personality: c.personality,
					scenario: c.scenario, firstMes: c.firstMes, mesExample: c.mesExample,
					systemPrompt: c.systemPrompt, creatorNotes: c.creatorNotes,
					tags: c.tags, alternateGreetings: c.alternateGreetings,
				};
			},
			createCard: (input) => {
				const safe = input.name.replace(/[\\/<>:"|?*]/g, "_").slice(0, 120).trim();
				if (!safe) throw new Error("卡名无效");
				const dest = join(cwd, "assets/cards", `${safe}.json`);
				if (existsSync(dest)) return null;
				const card: Record<string, unknown> = {
					spec: "chara_card_v3",
					spec_version: "3.0",
					data: {
						name: safe,
						description: input.description ?? "",
						personality: input.personality ?? "",
						scenario: input.scenario ?? "",
						first_mes: input.firstMes,
						mes_example: input.mesExample ?? "",
						alternate_greetings: input.alternateGreetings ?? [],
						tags: [],
						creator: "",
						character_version: "",
					},
				};
				mkdirSync(dirname(dest), { recursive: true });
				writeFileSync(dest, JSON.stringify(card, null, 2), "utf8");
				const c = loadCardFile(dest);
				if (!c.name) {
					try { unlinkSync(dest); } catch { /* best-effort */ }
					throw new Error("角色卡解析失败，已回滚");
				}
				return { name: safe, path: dest };
			},
		},
		loadConfig(cwd).language,
	),
);

// 世界线族（M-D5）：agent 可操控存档点
tools.push(
	...assistantToolDefs<WorldlineDeps>(
		worldlineTools,
		{
			loadWorldline: () => {
				const raw = bridge.worldlineView() as Record<string, unknown>;
				const saves = Array.isArray(raw.saves) ? raw.saves as Array<Record<string, unknown>> : [];
				return {
					saves: saves.map((s) => ({
						id: String(s.id ?? ""),
						name: String(s.name ?? ""),
						worldlineId: String(s.worldlineId ?? ""),
						worldlineName: String(s.worldlineName ?? ""),
						createdAt: typeof s.createdAt === "number" ? s.createdAt : 0,
						onCurrentBranch: s.onCurrentBranch === true,
						entryId: String(s.entryId ?? ""),
					})),
					currentSaveId: typeof raw.currentSaveId === "string" ? raw.currentSaveId : null,
				} satisfies WorldlineViewLite;
			},
			storeSave: (name) => {
				const cmd = name.trim() ? `/store ${name.trim()}` : "/store";
				const queued = bridge.queueStoryCommand(cmd);
				return queued ? { id: "", name: name.trim() || "自动命名", worldlineName: "当前线" } : null;
			},
			navigateToSave: (saveId) => {
				const queued = bridge.queueStoryCommand(`/back ${saveId}`);
				if (!queued) return { ok: false, error: "无法排队命令" };
				return { ok: true };
			},
		},
		loadConfig(cwd).language,
	),
);

// 面板族（M-D5）：三件合一
tools.push(
	...assistantToolDefs<PanelDeps>(
		panelTools,
		{
			loadPanels: () => bridge.storyPanels().load(),
			writePanel: (input) => bridge.storyPanels().write(input) as PanelWriteOutput,
			closePanel: (name) => bridge.storyPanels().close(name),
		},
		loadConfig(cwd).language,
	),
);

	return tools;
}

// ---------- 内联扩展工厂（角色库/世界线/面板族工具注入在上方 createStagehandTools 内） ----------

function stagehandExtension(
	cwd: string,
	bridge: StoryBridge,
	getSelf: () => { model: { provider: string; id: string } | null; follow: boolean },
	isDelegating: () => boolean,
): ExtensionFactory {
	return (pi) => {
		let cache = "";
		const rebuild = () => {
			cache = buildStagehandPrompt({ config: loadConfig(cwd), skills: listSkills(cwd) });
		};
		pi.on("session_start", async () => {
			rebuild();
		});
		pi.on("before_agent_start", async () => {
			if (!cache) rebuild();
			return { systemPrompt: cache };
		});
		// 每轮末端注入剧情快照（动态内容不进 system prompt，D8 字节稳定同款纪律）
		pi.on("context", async (event) => {
			const self = getSelf();
			const messages = [...(event.messages as unknown[])];
			messages.push({
				role: "custom",
				customType: "stagehand-inject",
				content: buildStagehandInjection({
					...bridge.snapshot(),
					assistantModel: self.model,
					assistantFollows: self.follow,
					delegateActive: isDelegating(),
				}),
				display: false,
				timestamp: Date.now(),
			});
			return { messages: messages as never };
		});
	};
}

// ---------- 会话托管 ----------

export async function createAssistantHost(opts: CreateAssistantHostOptions): Promise<AssistantHost> {
	const { cwd, bridge, onEvent, onError, uiContext } = opts;
	const sessionDir = dir(cwd, "assistant");
	mkdirSync(sessionDir, { recursive: true });

	let session: AgentSession;
	let unsubscribe: (() => void) | undefined;

	/** 剧情委托挂起：等 return_answer / 放弃 / 兜底 */
	let pendingReturn: {
		resolve: (p: AssistantReturnPayload) => void;
		settled: boolean;
	} | null = null;

	const isDelegating = () => isAssistantDelegateActive();

	/** 本委托回合已交付媒体内容指纹（show_media / 自动捞路径共用，防三连） */
	let mediaDeliveredKeys = new Set<string>();

	const mediaContentKey = (absPath: string): string | null => {
		try {
			if (!existsSync(absPath)) return null;
			return createHash("md5").update(readFileSync(absPath)).digest("hex").slice(0, 16);
		} catch {
			return null;
		}
	};

	/**
	 * 模型常 curl 落盘后只写路径、忘调 show_media。
	 * 交回时从摘要抓路径；**已 show_media 过的同内容跳过**（只补漏，不连推三次）。
	 */
	const autoDeliverHarvestedMedia = (blob: string): string[] => {
		const delivered: string[] = [];
		for (const p of harvestLocalMediaPaths(blob)) {
			const abs = isAbsolute(p) ? p : join(cwd, p);
			if (!existsSync(abs)) continue;
			const key = mediaContentKey(abs);
			if (key && mediaDeliveredKeys.has(key)) continue; // 本回合已交付
			// 摘要里已有 /media/{key} 也视为已交付（模型写了路径）
			if (key && new RegExp(`/media/${key}`, "i").test(blob)) {
				mediaDeliveredKeys.add(key);
				continue;
			}
			const r = bridge.deliverMedia(abs);
			if (!r.ok) continue;
			if (key) mediaDeliveredKeys.add(key);
			const media = {
				src: r.src,
				kind: r.kind,
				caption: `（自动交付）${p}`,
			};
			onEvent({
				type: "message_end",
				message: {
					role: "toolResult",
					toolName: "show_media",
					isError: false,
					details: { asstMedia: media },
					content: [{ type: "text", text: `已自动交付：${r.src}` }],
				},
			} as never);
			if (isDelegating() && bridge.emitStoryMedia) {
				bridge.emitStoryMedia({
					src: r.src,
					kind: r.kind,
					caption: media.caption,
				});
			}
			delivered.push(r.src);
		}
		return delivered;
	};

	const settleReturn = (payload: AssistantReturnPayload): boolean => {
		if (!pendingReturn || pendingReturn.settled) return false;
		const harvestBlob = `${payload.summary}\n${extractLastAssistantText()}`;
		const autoSrcs = autoDeliverHarvestedMedia(harvestBlob);
		let summary = payload.summary;
		if (autoSrcs.length) {
			summary = `${summary}\n（系统已自动补交付漏掉的媒体：${autoSrcs.join("、")}）`;
		}
		pendingReturn.settled = true;
		const resolve = pendingReturn.resolve;
		pendingReturn = null;
		resolve({ ...payload, summary });
		return true;
	};

	const uiSelect: AssistantUiSelect = async (title, options, selectOpts) => {
		const ui = uiContext as {
			select?: (t: string, o: string[], opt?: { signal?: AbortSignal }) => Promise<string | undefined>;
		};
		if (typeof ui.select !== "function") return undefined;
		return ui.select(title, options, selectOpts);
	};

	const toolHooks: StagehandToolHooks = {
		isDelegating,
		settleReturn,
		select: uiSelect,
		noteMediaDelivered: (k) => {
			mediaDeliveredKeys.add(k);
		},
		wasMediaDelivered: (k) => mediaDeliveredKeys.has(k),
		mediaContentKey,
	};

	const selfInfo = () => ({ model: modelInfo(), follow: follows() });

	const currentCard = (): { path: string; name: string } => {
		const config = loadConfig(cwd);
		const path = (config.card ?? "").trim();
		let name = bridge.cardName() || "角色";
		if (path) {
			try {
				name = loadCardFile(isAbsolute(path) ? path : join(cwd, path)).name || name;
			} catch {
				// 坏卡路径：仍用 bridge 名
			}
		}
		return { path, name };
	};

	/** 当前助手会话绑定的剧情 sessionId（来自最后一条 rp-card） */
	const readCurrentStoryId = (s: AgentSession): string | undefined => {
		try {
			const entries = s.sessionManager.getEntries() as Array<{
				type?: string;
				customType?: string;
				data?: { storyId?: string };
			}>;
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (e.type === "custom" && e.customType === "rp-card" && typeof e.data?.storyId === "string") {
					const id = e.data.storyId.trim();
					if (id) return id;
				}
			}
		} catch {
			// ignore
		}
		return undefined;
	};

	/**
	 * 写入/刷新卡+剧情会话绑定。
	 * - 无 rp-card：补写
	 * - 有卡无 storyId 或 storyId 变了：再写一条最新绑定（parse 取最后一条）
	 */
	const ensureBind = (s: AgentSession, storyId?: string) => {
		const { path: card, name } = currentCard();
		if (!card) return;
		try {
			const entries = s.sessionManager.getEntries() as Array<{
				type?: string;
				customType?: string;
				data?: { card?: string; storyId?: string };
			}>;
			const last = [...entries].reverse().find((e) => e.type === "custom" && e.customType === "rp-card");
			const sid = (storyId ?? "").trim();
			const need =
				!last?.data?.card ||
				(sid && last.data.storyId !== sid) ||
				(card && last.data.card !== card);
			if (need) {
				s.sessionManager.appendCustomEntry("rp-card", {
					card,
					name,
					...(sid ? { storyId: sid } : {}),
				});
			}
		} catch {
			// 极早期不可写：跳过
		}
	};

	/** @deprecated 名称保留：无 story 时只钉卡 */
	const ensureCardTag = (s: AgentSession) => ensureBind(s);

	const readAsstCard = (
		filePath: string,
	): { card: string; name: string; storyId?: string } | null => {
		try {
			const size = statSync(filePath).size;
			const fd = openSync(filePath, "r");
			try {
				const headLen = Math.min(size, 65536);
				const headBuf = Buffer.alloc(headLen);
				readSync(fd, headBuf, 0, headLen, 0);
				let text = headBuf.toString("utf8");
				if (size > 65536) {
					const tailLen = Math.min(size - headLen, 65536);
					const tailBuf = Buffer.alloc(tailLen);
					readSync(fd, tailBuf, 0, tailLen, size - tailLen);
					text += `\n${tailBuf.toString("utf8")}`;
				}
				return parseCardFromSessionHead(text);
			} finally {
				closeSync(fd);
			}
		} catch {
			return null;
		}
	};

	const readAsstPreview = (filePath: string): string => {
		try {
			const size = statSync(filePath).size;
			const bytes = Math.min(size, 48_000);
			const fd = openSync(filePath, "r");
			try {
				const buf = Buffer.alloc(bytes);
				readSync(fd, buf, 0, bytes, Math.max(0, size - bytes));
				const lines = buf.toString("utf8").split(/\r?\n/);
				for (let i = lines.length - 1; i >= 0; i--) {
					const line = lines[i].trim();
					if (!line) continue;
					try {
						const e = JSON.parse(line) as {
							type?: string;
							message?: { role?: string; content?: unknown };
							content?: unknown;
							role?: string;
						};
						if (e.type === "message" && e.message?.role === "user") {
							const c = e.message.content;
							const t =
								typeof c === "string"
									? c
									: Array.isArray(c)
										? c
												.map((p) =>
													p && typeof p === "object" && (p as { type?: string }).type === "text"
														? String((p as { text?: string }).text ?? "")
														: "",
												)
												.join("")
										: "";
							const flat = t.replace(/\s+/g, " ").trim();
							if (flat) return flat.slice(0, 80);
						}
					} catch {
						// skip
					}
				}
			} finally {
				closeSync(fd);
			}
		} catch {
			// ignore
		}
		return "";
	};

	const assertInSessionDir = (filePath: string) => {
		const abs = resolve(filePath);
		const root = resolve(sessionDir);
		const n = (p: string) => normalize(p).replace(/\\/g, "/").toLowerCase().replace(/\/$/, "");
		const na = n(abs);
		const nr = n(root);
		if (na !== nr && !na.startsWith(`${nr}/`)) throw new Error("非法助手会话路径");
	};

	type BuildMode = { kind: "new" } | { kind: "continue" } | { kind: "open"; path: string };

	const build = async (mode: BuildMode): Promise<AgentSession> => {
		const agentDir = getAgentDir();
		const settingsManager = SettingsManager.create(cwd, agentDir);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			// 不吃 roleplay.ts（剧情工具）也不吃 coding 语境（AGENTS.md/主题/模板）；
			// 梨园技能库走自家提示词索引，pi skills 机制关闭。
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [stagehandExtension(cwd, bridge, selfInfo, isDelegating)],
		});
		await loader.reload();

		const config = loadConfig(cwd);
		const sm =
			mode.kind === "new"
				? SessionManager.create(cwd, sessionDir)
				: mode.kind === "open"
					? SessionManager.open(mode.path, sessionDir, cwd)
					: SessionManager.continueRecent(cwd, sessionDir);

		const { session: s } = await createAgentSession({
			cwd,
			agentDir,
			customTools: createStagehandTools(cwd, bridge, toolHooks),
			// backendControl 关 = 分发模式：助手也不给本机工具（read/bash/edit/write），只留领域工具
			...(config.backendControl === false ? { noTools: "builtin" as const } : {}),
			resourceLoader: loader,
			settingsManager,
			sessionManager: sm,
		});

		await s.bindExtensions({
			uiContext: uiContext as never,
			mode: "rpc",
			onError: (err: { extensionPath: string; event: string; error: string }) => {
				onError(`助手扩展错误（${err.event}）：${err.error}`);
			},
		} as never);

		// 显式助手模型：创建后手动应用（避免 setModel 改写共享默认模型设置）
		if (config.assistantModel) {
			applyModelTo(s, config.assistantModel, true);
		}
		try {
			ensureBind(s, bridge.snapshot().sessionId);
		} catch {
			ensureCardTag(s);
		}
		return s;
	};

	/** 手动应用模型：auth 校验 + 状态 + 会话树记录 + 思考档重夹（绕开 settings 副作用） */
	const applyModelTo = (s: AgentSession, sel: AssistantModelSel, quiet = false): boolean => {
		const m = s.modelRegistry.find(sel.provider, sel.id);
		if (!m) {
			if (!quiet) throw new Error(`模型不存在：${sel.provider}/${sel.id}`);
			onError(`助手模型 ${sel.provider}/${sel.id} 不在可用清单，暂用默认模型`);
			return false;
		}
		if (!s.modelRegistry.hasConfiguredAuth(m)) {
			if (!quiet) throw new Error(`模型 ${sel.provider}/${sel.id} 没有可用的 API key`);
			onError(`助手模型 ${sel.provider}/${sel.id} 缺少 API key，暂用默认模型`);
			return false;
		}
		const cur = s.model;
		if (cur && cur.provider === m.provider && cur.id === m.id) return true;
		s.agent.state.model = m;
		try {
			s.sessionManager.appendModelChange(m.provider, m.id);
		} catch {
			// 会话极早期不可写：状态已生效，记录缺一条无碍
		}
		try {
			s.setThinkingLevel(s.thinkingLevel as never);
		} catch {
			// 档位不适配新模型时保持默认
		}
		return true;
	};

	const subscribe = () => {
		unsubscribe?.();
		unsubscribe = session.subscribe((event) => onEvent(event));
	};

	const follows = () => !loadConfig(cwd).assistantModel;

	const modelInfo = () => {
		const m = session?.model;
		return m ? { provider: m.provider, id: m.id, name: m.name || m.id } : null;
	};

	/** 跟随模式：发话前把助手模型对齐到剧情模型（provider+id 相同则空转） */
	const syncFollowModel = () => {
		if (!follows()) return;
		const story = bridge.snapshot().model;
		if (!story) return;
		const cur = session.model;
		if (cur && cur.provider === story.provider && cur.id === story.id) return;
		applyModelTo(session, story, true);
	};

	session = await build({ kind: "continue" });
	subscribe();

	const extractLastAssistantText = (): string => {
		const msgs = session.messages as Array<{ role?: string; content?: unknown }>;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i];
			if (m.role !== "assistant") continue;
			const c = m.content;
			if (typeof c === "string") return c.trim();
			if (Array.isArray(c)) {
				const text = c
					.filter((b): b is { type: string; text?: string } => !!b && typeof b === "object" && (b as { type?: string }).type === "text")
					.map((b) => b.text ?? "")
					.join("")
					.trim();
				if (text) return text;
			}
		}
		return "";
	};

	return {
		async prompt(t: string) {
			syncFollowModel();
			await session.prompt(t, session.isStreaming ? { streamingBehavior: "followUp" } : undefined);
		},
		async runTask(t: string) {
			syncFollowModel();
			// 已有挂起委托：不应重入
			if (pendingReturn && !pendingReturn.settled) {
				return {
					summary: "上一次委托尚未交回，请先停止或等待。",
					ok: false,
					viaReturnTool: false,
				};
			}
			// 委托前对齐剧情会话：新聊天不接着旧助手上下文
			const storyId = bridge.snapshot().sessionId;
			if (storyId) {
				await this.switchToStory(storyId);
			}
			// 每轮委托清空媒体去重表
			mediaDeliveredKeys = new Set();
			const resultPromise = new Promise<AssistantReturnPayload>((resolve) => {
				pendingReturn = { resolve, settled: false };
			});
			const softSettle = () => {
				if (!pendingReturn || pendingReturn.settled) return;
				const reply = extractLastAssistantText();
				settleReturn({
					summary: reply
						? `${reply}\n（注：助手未调用 return_answer，以上为最后回复摘录。）`
						: "助手结束但未调用 return_answer。",
					ok: !!reply,
					viaReturnTool: false,
				});
			};
			try {
				await session.prompt(t, session.isStreaming ? { streamingBehavior: "followUp" } : undefined);
			} catch (err) {
				if (!pendingReturn?.settled) {
					settleReturn({
						summary: `助手执行异常：${err instanceof Error ? err.message : String(err)}`,
						ok: false,
						viaReturnTool: false,
					});
				}
				throw err;
			} finally {
				// agent loop 结束仍未 return_answer → 兜底交回，避免剧情侧永久等待
				softSettle();
			}
			return resultPromise;
		},
		async abort() {
			if (pendingReturn && !pendingReturn.settled) {
				settleReturn({
					summary: "用户停止了助手任务。",
					ok: false,
					abandoned: true,
					viaReturnTool: false,
				});
			}
			await session.abort();
		},
		async newConversation() {
			try {
				await session.abort();
			} catch {
				// 空闲时 abort 无事发生
			}
			unsubscribe?.();
			session.dispose();
			session = await build({ kind: "new" });
			subscribe();
			// 尽量钉上当前剧情会话（若 bridge 有快照）
			try {
				const sid = bridge.snapshot().sessionId;
				if (sid) ensureBind(session, sid);
			} catch {
				ensureCardTag(session);
			}
		},
		async listSessions() {
			const { path: cardPath, name: cardName } = currentCard();
			const all = await SessionManager.list(cwd, sessionDir);
			const curFile = session.sessionFile;
			const curId = session.sessionId;
			const isSame = (a?: string, b?: string) => {
				if (!a || !b) return false;
				const n = (p: string) => normalize(p).replace(/\\/g, "/").toLowerCase();
				return n(a) === n(b);
			};
			const out: AssistantSessionInfo[] = [];
			for (const s of all) {
				const mtime = s.modified instanceof Date ? s.modified.getTime() : Number(s.modified) || 0;
				const info = readAsstCard(s.path);
				const isCurrent = s.id === curId || isSame(s.path, curFile);
				// 无卡标记：仅当前会话可显示（随后 ensureCardTag 会补）
				if (!info) {
					if (!isCurrent || !cardPath) continue;
				} else if (!cardPath || !sameCardPath(info.card, cardPath, cwd)) {
					continue;
				}
				const preview = readAsstPreview(s.path);
				out.push({
					path: s.path,
					id: s.id,
					...(s.name ? { name: s.name } : {}),
					firstMessage: s.firstMessage,
					modified: mtime,
					messageCount: s.messageCount,
					current: isCurrent,
					...(preview ? { preview } : {}),
					cardName: info?.name || cardName,
					card: info?.card || cardPath,
					...(info?.storyId ? { storyId: info.storyId } : {}),
				});
			}
			// 当前会话未落盘时补一条
			if (curId && !out.some((x) => x.current) && cardPath) {
				out.unshift({
					path: curFile || "",
					id: curId,
					firstMessage: "",
					modified: Date.now(),
					messageCount: (session.messages as unknown[]).length,
					current: true,
					cardName,
					card: cardPath,
					...(readCurrentStoryId(session) ? { storyId: readCurrentStoryId(session) } : {}),
				});
			}
			out.sort((a, b) => b.modified - a.modified);
			return out;
		},
		async openSession(path) {
			if (session.isStreaming) throw new Error("请等助手当前回复完成（或先停止），再切换历史");
			assertInSessionDir(path);
			const { path: cardPath } = currentCard();
			const info = readAsstCard(path);
			if (info && cardPath && !sameCardPath(info.card, cardPath, cwd)) {
				throw new Error("该助手会话属于其他角色卡");
			}
			const abs = resolve(path);
			if (session.sessionFile && resolve(session.sessionFile) === abs) return;
			try {
				await session.abort();
			} catch {
				// ignore
			}
			unsubscribe?.();
			session.dispose();
			session = await build({ kind: "open", path: abs });
			subscribe();
		},
		async deleteSession(path) {
			if (session.isStreaming) throw new Error("请等助手当前回复完成（或先停止），再删除");
			assertInSessionDir(path);
			const abs = resolve(path);
			if (session.sessionFile && resolve(session.sessionFile) === abs) {
				throw new Error("不能删除当前打开的助手会话（先切到其他历史或新建）");
			}
			const { path: cardPath } = currentCard();
			const info = readAsstCard(abs);
			if (info && cardPath && !sameCardPath(info.card, cardPath, cwd)) {
				throw new Error("该助手会话属于其他角色卡");
			}
			unlinkSync(abs);
		},
		async switchToCard() {
			if (session.isStreaming) {
				try {
					await session.abort();
				} catch {
					// ignore
				}
			}
			// 换卡后默认新开助手（不再误接同卡其它剧情的旧助手上下文）
			await this.newConversation();
			return "created";
		},
		async switchToStory(storyId) {
			const sid = (storyId ?? "").trim();
			if (!sid) {
				await this.newConversation();
				return "created";
			}
			if (session.isStreaming) {
				try {
					await session.abort();
				} catch {
					// ignore
				}
			}
			// 已绑当前剧情会话 → 不动
			if (readCurrentStoryId(session) === sid) {
				ensureBind(session, sid);
				return "same";
			}
			// 在同卡助手历史里找绑定该 storyId 的会话
			const { path: cardPath } = currentCard();
			const all = await SessionManager.list(cwd, sessionDir);
			for (const s of all) {
				const info = readAsstCard(s.path);
				if (!info) continue;
				if (cardPath && !sameCardPath(info.card, cardPath, cwd)) continue;
				if (info.storyId === sid) {
					await this.openSession(s.path);
					ensureBind(session, sid);
					return "switched";
				}
			}
			// 没有 → 新建并钉绑定
			await this.newConversation();
			ensureBind(session, sid);
			return "created";
		},
		sessionPath: () => session.sessionFile,
		async setModel(sel) {
			const config = loadConfig(cwd);
			if (!sel) {
				if (config.assistantModel) {
					const { assistantModel: _drop, ...rest } = config;
					writeJsonWithBackup(configPath(cwd), rest);
				}
				syncFollowModel();
				return;
			}
			applyModelTo(session, sel); // 非法则抛错，不写配置
			writeJsonWithBackup(configPath(cwd), { ...loadConfig(cwd), assistantModel: { ...sel } });
		},
		modelInfo,
		follows,
		messages: () => session.messages as unknown[],
		isStreaming: () => session.isStreaming,
		async dispose() {
			unsubscribe?.();
			try {
				await session.abort();
			} catch {
				// ignore
			}
			session.dispose();
		},
	};
}
