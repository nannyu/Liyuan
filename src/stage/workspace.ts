/**
 * 回合工作区（PLAN-RP-AGENT-EXEC M-A §2.2）——正文成为工件的落点。
 *
 * 一拍一个工作区：模型经稿纸工具写正文、world_state_update 记账，
 * harness 只执行与验证，不替模型生成任何内容（控制反转的落地处）。
 *
 * 三条铁律：
 * - draft_write 是唯一交稿入口（宽进严出：直出正文由引擎代为收稿，见 engine #agentLoop）；
 *   已有稿之后的局部修改归 draft_edit（定点补丁，批量原子：任一处定位失败则整批不改）；
 * - world_state_update 只验不改：patch 先在投影账本上干跑，合格才入队，定稿后统一套用；
 * - 工作区只活在引擎单拍内，不跨模块共享（jiti 二象性红线，不触 globalThis）。
 *
 * 纯函数 + 注入依赖，零 pi 依赖、可单测（执行器全部复用 draft.ts / state.ts 现成代码）。
 */

import {
	applyDraftEdits,
	searchDraft,
	type DraftEditItem,
	type DraftRules,
} from "../draft.ts";
import { applyPatch, canonicalizeCharacterKeys } from "../state.ts";
import type { WorldState } from "../types.ts";

/** 拍内计划的一条：一个动作/一个转折，不是正文 */
export interface BeatStep {
	text: string;
	done: boolean;
}

export interface TurnWorkspace {
	/** 当前稿（draft_write 全量替换语义；draft_append 追加语义） */
	draft: string;
	/**
	 * 本拍计划清单（beat_plan）——首轮构思的落点。
	 *
	 * 构思若只活在思考里，要么被逐轮回放固化成剧本，要么在切断回放后蒸发；
	 * 落成清单则是工件：模型每轮面对的是「现稿 + 剩余待办」而非旧思考。
	 * 条目粒度由 MAX_STEP_LEN 挡住——写得下路标，写不下正文，
	 * 于是「构思」与「脑内排练整拍初稿」在结构上被分开。
	 *
	 * 拍内临时：随工作区谢幕即弃，不跨拍（跨拍大纲＝长期剧本，是另一种病）。
	 */
	plan: BeatStep[];
	/** beat_plan 调用次数（KPI：构思是否真被推翻重拟过） */
	planWrites: number;
	/** 已封笔（M-E）：正文写完了（8/10 起封笔只是状态切换，不触发任何检验） */
	sealed: boolean;
	/** 交稿次数（含宽进严出代收） */
	writes: number;
	/** draft_append 追加段数（M-E KPI：分段续写是否真发生） */
	appends: number;
	/** draft_edit 成功套用的次数（M-B KPI：定点改稿是否真替代了全文重交） */
	edits: number;
	/**
	 * 本拍查过几次世界（lorebook / memory / world_state_get；不含 skill_read）。
	 *
	 * 用作「这一拍有没有戏」的外部事实：查过世界＝中途确实遇到了需要停下来处理的
	 * 事，那这一拍本该一段一段演。draft_write 的门禁据此判定（见 runWriteTool）。
	 */
	lookups: number;
	/** world_state_update 已验证入队的 patch（定稿后按序统一套用） */
	patches: Record<string, unknown>[];
	/**
	 * 本拍面板写入次数（panel_write / panel_close 调用计数，engine 维护）。
	 *
	 * 记账注入的跳过判据（PLAN-RECTIFY §2.3：本拍已有落账时可跳过）必须是结构信号，
	 * 禁止文本识别——patches 与本计数就是那个结构信号。
	 */
	panelWrites: number;
	/**
	 * 本拍时间线（思考/工具/正文按**发生顺序**）。
	 *
	 * 定稿只落最后一稿正文，中间轮的思考与工具轨迹本会丢失——但用户要看的
	 * 正是「思考→工具→正文→思考」这条链。故在此按序记档，落树时随 details
	 * 持久化，刷新与 resync 后仍在。
	 */
	timeline: TurnSegment[];
	/**
	 * 稿外直出文本（engine 每轮更新）：首轮直出＋稿落地前的 text 通道产出中，
	 * 未被代收进稿的部分。seal 回执把它作为事实补认——不回喂原文、不给指令，
	 * 处置（draft_edit 补进去 / 当旁白不理）归模型判断。
	 */
	strayText?: string;
	/**
	 * 本拍的媒体交付（show_image/audio/video/html、tts，8/06 重接）。
	 *
	 * wire 层只把树上的 `role:"toolResult"` 条目翻成媒体帧，而台上引擎落树时
	 * 剥离工具轨迹——故媒体结果在此收集，谢幕后随正文一起落成 toolResult 条目，
	 * 让 live 推送与刷新重放走同一条路径。
	 */
	mediaDeliveries?: Array<{ toolName: string; details: Record<string, unknown>; text: string }>;
}

/** 时间线段：与前端 web/src/timeline.ts 的 TurnSegment 同构（跨边界只走 JSON） */
export type TurnSegment =
	| { kind: "thinking"; text: string }
	/** draft=true 标记「这段是工作区稿件」，重交/改稿时原地替换而非叠加 */
	| { kind: "text"; text: string; draft?: boolean }
	| { kind: "tool"; activities: Array<{ kind: string; name: string; detail?: string; isError?: boolean }> };

export function createWorkspace(): TurnWorkspace {
	return {
		draft: "",
		plan: [],
		planWrites: 0,
		sealed: false,
		writes: 0,
		appends: 0,
		edits: 0,
		lookups: 0,
		patches: [],
		panelWrites: 0,
		timeline: [],
	};
}

/** 时间线追加：同类并入末段（连续工具聚成一组），异类开新段 */
export function recordSegment(
	ws: TurnWorkspace,
	seg:
		| { kind: "thinking"; text: string }
		| { kind: "text"; text: string }
		| { kind: "tool"; activity: { kind: string; name: string; detail?: string; isError?: boolean } },
): void {
	const last = ws.timeline[ws.timeline.length - 1];
	if (seg.kind === "tool") {
		if (last && last.kind === "tool") last.activities.push(seg.activity);
		else ws.timeline.push({ kind: "tool", activities: [seg.activity] });
		return;
	}
	if (!seg.text) return;
	// text 记档（尾巴流式等，无 draft 标记）不并入稿段——稿段是 draft_append/resync
	// 维护的作品分段，尾巴黏进去会让「稿段拼接 ≠ 现稿」，定稿分段同构随之失效。
	const mergeable = last && last.kind === seg.kind && !(last.kind === "text" && last.draft === true);
	if (mergeable) last.text += seg.text;
	else ws.timeline.push({ kind: seg.kind, text: seg.text });
}

/**
 * 定稿时间线（8/09 输出形式定案：分段同构——重放形态 = 流式形态）。
 *
 * 常态：稿段（draft=true，= 屏上一段段长出来的故事）原位保留；finalText 相对现稿
 * 多出的尾巴（状态栏 / catsay，text 通道直出）收成独立末段。落树正文 finalText 与
 * 时间线正文（稿段拼接 + 尾巴段）内容一致，且分段结构与用户流式所见相同。
 *
 * 兜底：无稿（直出正文路径）或稿段与现稿脱同步时，退回「全文单段放首个 text 位置」
 * 的塌段形态——内容正确优先于形态。
 */
export function finalTimeline(ws: TurnWorkspace, finalText: string): TurnSegment[] {
	// 分段同构（8/09 输出形式定案）：定稿保持稿段原位——重放形态 = 流式形态。
	// mergeFinalText 的产物必为「稿全文」或「稿全文 + 尾巴」，故 startsWith 成立时
	// 尾巴 = 稿之后的部分（状态栏等 text 通道产出），收成独立末段（不带 draft）。
	// 非稿 text 段（尾巴的流式记档）丢弃——内容已归并进尾巴段，避免重复。
	const draft = ws.draft.trim();
	const flat = (s: string) => s.replace(/\s+/g, "");
	const draftSegs = ws.timeline.filter(
		(s): s is Extract<TurnSegment, { kind: "text" }> => s.kind === "text" && s.draft === true,
	);
	const joined = draftSegs.map((s) => s.text).join("\n\n");
	if (draft && finalText.startsWith(draft) && flat(joined) === flat(draft)) {
		const tail = finalText.slice(draft.length).trim();
		const out: TurnSegment[] = [];
		for (const s of ws.timeline) {
			if (s.kind === "tool") {
				if (s.activities.length > 0) out.push(s);
				continue;
			}
			if (s.kind === "text") {
				if (s.draft === true && s.text.trim()) out.push(s);
				continue;
			}
			if (s.text.trim().length > 0) out.push(s);
		}
		if (tail) out.push({ kind: "text", text: tail });
		return out;
	}
	// 兜底（无稿 / 直出代收 / 稿段与现稿脱同步）：全文单段放首个 text 位置（旧行为）
	const out: TurnSegment[] = [];
	let textPlaced = false;
	for (const s of ws.timeline) {
		if (s.kind === "tool") {
			if (s.activities.length > 0) out.push(s);
			continue;
		}
		if (s.kind === "text") {
			if (!textPlaced) {
				textPlaced = true;
				out.push({ kind: "text", text: finalText, draft: true });
			}
			continue;
		}
		if (s.text.trim().length > 0) out.push(s);
	}
	if (!textPlaced && finalText.trim()) out.push({ kind: "text", text: finalText, draft: true });
	return out;
}

/**
 * 稿件入时间线：**替换**已记的稿，而不是再追加一段。
 *
 * 多稿重交（M-B 实弹的 882→849→838）与定点改稿都作用在同一份稿上，
 * 逐次追加会让同一段正文在屏上叠出几份（EXEC §4.5.4 记的重复上屏欠账）。
 * 故先摘掉此前记过的稿段，再把最新稿记在当前位置——位置随最后一次动笔走，
 * 前面的思考与工具轨迹不动。
 */
function replaceDraftSegment(ws: TurnWorkspace, content: string): void {
	ws.timeline = ws.timeline.filter((s) => !(s.kind === "text" && s.draft === true));
	ws.timeline.push({ kind: "text", text: content, draft: true });
}

/**
 * 稿件按空行切段——分段的**同源算法**：时间线重切（下方 resyncDraftSegments）、
 * 引擎的 draft_resync 帧（修复后前端原位替换稿段）都用它，保证前后端看到同一套分段。
 */
export function splitDraftSegments(draft: string): string[] {
	return draft.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
}

/**
 * 定点改稿后同步时间线（M-E）：分段续写时**保持分段**，只把整稿重新切回各段。
 *
 * 续写形态下屏上是「一段段长出来的故事」，若改一处就塌成一整块，
 * 已经上屏的部分会在用户眼前重排——那正是 draft_append 要消除的体验。
 * 故按段落边界重切：稿件以 `\n\n` 分段，逐段替换已记的稿段。
 */
function resyncDraftSegments(ws: TurnWorkspace): void {
	const firstIdx = ws.timeline.findIndex((s) => s.kind === "text" && s.draft === true);
	ws.timeline = ws.timeline.filter((s) => !(s.kind === "text" && s.draft === true));
	const segs: TurnSegment[] = splitDraftSegments(ws.draft).map((p) => ({ kind: "text" as const, text: p, draft: true }));
	if (firstIdx >= 0) ws.timeline.splice(Math.min(firstIdx, ws.timeline.length), 0, ...segs);
	else ws.timeline.push(...segs);
}

export interface WorkspaceDeps {
	rules: DraftRules;
	userName: string;
	charName: string;
	/** 本拍开演前的账本（= f(分支)）；patch 验证在其投影上干跑 */
	baseState: WorldState;
}

/** 已入队 patch 依序套在基准账本上的投影——后续 patch 的验证与定稿看到同一个世界 */
export function projectedState(ws: TurnWorkspace, base: WorldState): WorldState {
	let s = base;
	for (const p of ws.patches) s = applyPatch(s, p).state;
	return s;
}

export interface WriteToolResult {
	/** 回给模型的 toolResult 文本 */
	text: string;
	/** 过程条短句（无则不出条） */
	activity?: string;
	/** true = 本次调用是有效交稿/记账（引擎统计与流转用） */
	ok: boolean;
}

/** 单条计划的长度上限：路标写得下，正文写不下（构思／排练的结构性分界） */
export const MAX_STEP_LEN = 60;
/** 一拍的计划条数上限：够铺一拍，多了就是在写大纲 */
export const MAX_STEPS = 8;

/** 渲染清单：方框 + 待办，已完成的打勾划掉（□/☑ 与删除线同构于用户看到的任务列表） */
export function formatPlan(plan: BeatStep[]): string {
	if (plan.length === 0) return "（本拍还没有计划）";
	return plan
		.map((s, i) => (s.done ? `${i + 1}. ☑ ~~${s.text}~~` : `${i + 1}. □ ${s.text}`))
		.join("\n");
}

/** 剩余未完成条数 */
function pendingSteps(plan: BeatStep[]): number {
	return plan.filter((s) => !s.done).length;
}

/**
 * 封笔事实（8/10 验收整体退役后仅存的回执信息）：稿外直出补认一行。
 * 禁词/比喻/句式的匹配统计连同 checkDraft 已全部删除——落笔之后 harness
 * 不对稿件内容说任何话；质量投资全在落笔前（预设原文＋素材＋思考空间）。
 */
function sealFacts(ws: TurnWorkspace): string {
	const stray = (ws.strayText ?? "").trim();
	if (!stray) return "";
	const chars = stray.replace(/\s+/g, "").length;
	return `
另：text 通道有约 ${chars} 字直出不在稿内（起头「${stray.slice(0, 15)}…」）。`;
}

/**
 * 执行一次写侧工具调用。未知工具/参数缺失都返回可读文本（不抛，不打断本拍）。
 * 读侧三件（lorebook/memory/world_state_get）仍走 tools.ts runStageTool。
 */
export function runWriteTool(
	ws: TurnWorkspace,
	deps: WorkspaceDeps,
	name: string,
	args: Record<string, unknown>,
	/**
	 * 内部代收（宽进严出）：跳过 draft_write 门禁。
	 *
	 * 引擎把模型直出的正文代收为 draft_write 时，那不是模型的选择而是兜底——
	 * 若被门禁拦下，这拍的正文就凭空丢了。只有 engine #agentLoop 传 true。
	 */
	internal = false,
): WriteToolResult {
	if (name === "beat_plan") {
		const raw = args.steps;
		if (!Array.isArray(raw) || raw.length === 0) {
			return { text: 'steps 需为非空字符串数组，如 ["推门进院","被值守弟子拦下","亮出师门信物"]。', ok: false };
		}
		const texts = raw.map((s) => (typeof s === "string" ? s.trim() : "")).filter((s) => s.length > 0);
		if (texts.length === 0) return { text: "steps 里没有有效条目。", ok: false };
		if (texts.length > MAX_STEPS) {
			return {
				text: `未记计划：最多 ${MAX_STEPS} 条（收到 ${texts.length} 条）。合并后重新提交。`,
				ok: false,
			};
		}
		// 粒度门禁：条目是路标不是正文（通道形状约束，详见 beat_plan 工具描述）
		const tooLong = texts.filter((t) => t.length > MAX_STEP_LEN);
		if (tooLong.length > 0) {
			return {
				text: `未记计划：有 ${tooLong.length} 条超过 ${MAX_STEP_LEN} 字（路标上限）。压成一句话后重新提交。`,
				activity: "计划过细被拦下",
				ok: false,
			};
		}
		// 重拟保留已完成条目的勾选状态：文字一致者视为同一步，不因改写后半段而丢进度。
		const doneTexts = new Set(ws.plan.filter((s) => s.done).map((s) => s.text));
		ws.plan = texts.map((t) => ({ text: t, done: doneTexts.has(t) }));
		ws.planWrites++;
		const verb = ws.planWrites > 1 ? "计划已更新（重拟）" : "计划已接受";
		return {
			text: `计划已接受（${ws.plan.length} 条路标）。`,
			activity: `${verb} · ${ws.plan.length} 条`,
			ok: true,
		};
	}

	if (name === "beat_step_done") {
		if (ws.plan.length === 0) return { text: "本拍还没有计划。", ok: false };
		const idx = typeof args.step === "number" ? args.step : Number.NaN;
		if (!Number.isInteger(idx) || idx < 1 || idx > ws.plan.length) {
			return { text: `step 需为 1~${ws.plan.length} 的序号（当前计划 ${ws.plan.length} 条）。`, ok: false };
		}
		const target = ws.plan[idx - 1]!;
		if (target.done) {
			return { text: `第 ${idx} 条已经勾过了。`, ok: false };
		}
		target.done = true;
		const left = pendingSteps(ws.plan);
		return {
			text: `已勾掉第 ${idx} 条「${target.text}」，还剩 ${left} 条。`,
			activity: `勾掉「${target.text}」· 剩 ${left} 条`,
			ok: true,
		};
	}

	if (name === "draft_write") {
		const content = typeof args.content === "string" ? args.content : "";
		if (!content.trim()) return { text: "content 为空——请提交完整正文。", ok: false };
		// 门禁：draft_write 只留给「这一拍没有戏」。查过世界（设定/旧账/账本）
		// 说明中途确实遇到了要停下来处理的事——那这拍本该一段一段演。
		// 已经在续写中（appends>0）则不拦：那是分段写到一半改用全量重交。
		if (!internal && ws.lookups > 0 && ws.appends === 0 && ws.draft === "") {
			return {
				text: `未收稿：本拍已查过 ${ws.lookups} 次世界（有戏的拍）。用 draft_append 一段一段演。`,
				activity: "一次交完被拦下（这拍有戏）",
				ok: false,
			};
		}
		ws.draft = content;
		ws.writes++;
		ws.sealed = true; // 全量交稿即完整稿，天然封笔
		// 时间线：正文按交稿位置入档。重交是**替换**不是追加——
		// 末段若已是本工作区写过的正文，改写它，避免多稿在屏上叠成几份。
		replaceDraftSegment(ws, content);
		return {
			text: `已收稿（第 ${ws.writes} 稿）。${sealFacts(ws)}`,
			activity: `交稿 ${content.length} 字`,
			ok: true,
		};
	}

	if (name === "draft_append") {
		const seg = typeof args.segment === "string" ? args.segment : "";
		if (!seg.trim()) return { text: "segment 为空——请提交要续写的段落。", ok: false };
		const sep = ws.draft.trim().length > 0 ? "\n\n" : "";
		ws.draft += sep + seg;
		ws.appends++;
		// 续写的正文入时间线：追加一段（不是替换——已写的部分是已经发生的事，不推翻）
		ws.timeline.push({ kind: "text", text: seg, draft: true });
		// 回执只留事实（§2.4）：进度与判定由轮次注入承载
		return {
			text: `已续写（第 ${ws.appends} 段）。`,
			activity: `续写第 ${ws.appends} 段`,
			ok: true,
		};
	}

	if (name === "draft_seal") {
		if (!ws.draft.trim()) return { text: "工作区还没有稿件——先用 draft_write / draft_append 写正文。", ok: false };
		ws.sealed = true;
		return {
			text: `已封笔。${sealFacts(ws)}`,
			activity: "封笔",
			ok: true,
		};
	}

	if (name === "draft_edit") {
		if (!ws.draft.trim()) return { text: "尚无稿件——先写正文（draft_append 续写 / draft_write 全量交稿），再定点修改。", ok: false };
		const raw = args.edits;
		if (!Array.isArray(raw) || raw.length === 0) {
			return { text: 'edits 需为非空数组，如 [{"old":"原文","new":"新文"}]。', ok: false };
		}
		const edits = raw as DraftEditItem[];
		const r = applyDraftEdits(ws.draft, edits);
		if (!r.ok || r.text === undefined) {
			// 整批未套用：现稿一字未动，回报每处失败原因供模型修正
			return { text: `改稿未套用：\n${r.details.join("\n")}`, activity: "改稿未套用", ok: false };
		}
		ws.draft = r.text;
		ws.edits++;
		// 时间线：定点改稿后正文原地更新（改的是同一份稿，不新开一段）。
		// 续写形态下按段重切，保住「一段段长出来」的形态不塌成一整块。
		if (ws.appends > 0) resyncDraftSegments(ws);
		else replaceDraftSegment(ws, ws.draft);
		return {
			text: `已改 ${edits.length} 处：\n${r.details.join("\n")}`,
			activity: `定点改稿 ${edits.length} 处`,
			ok: true,
		};
	}

	if (name === "draft_read") {
		if (!ws.draft.trim()) return { text: "工作区还没有稿件——先用 draft_write 提交初稿。", ok: false };
		return {
			text: `当前稿（第 ${ws.writes} 稿，已定点改 ${ws.edits} 次）：\n\n${ws.draft}`,
			activity: "读回现稿",
			ok: true,
		};
	}

	if (name === "draft_search") {
		if (!ws.draft.trim()) return { text: "工作区还没有稿件——先用 draft_write 提交初稿。", ok: false };
		const query = typeof args.query === "string" ? args.query.trim() : "";
		if (!query) return { text: "缺少 query 参数。", ok: false };
		const { hits, total } = searchDraft(ws.draft, query);
		if (total === 0) {
			return { text: `现稿中找不到「${query}」。可用 draft_read 通读现稿确认。`, activity: `查现稿「${query}」· 无命中`, ok: true };
		}
		const more = total > hits.length ? `\n（共 ${total} 处，以上仅列前 ${hits.length}）` : "";
		const uniq =
			total > 1 ? `\n\n注意：命中 ${total} 处——draft_edit 的 old 必须唯一，请前后多带一句再引用。` : "";
		return {
			text: `命中 ${total} 处：\n${hits.map((h, i) => `${i + 1}. ${h}`).join("\n")}${more}${uniq}`,
			activity: `查现稿「${query}」· ${total} 处`,
			ok: true,
		};
	}

	if (name === "world_state_update") {
		const raw = args.patch;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
			return { text: "patch 需为对象（合并补丁语义），例如 {\"location\":\"藏经阁\"}。", ok: false };
		}
		const knownNames = [
			deps.charName,
			deps.userName,
			...Object.keys(projectedState(ws, deps.baseState).characters),
		];
		const patch = canonicalizeCharacterKeys(raw as Record<string, unknown>, knownNames);
		// 只验不改：投影上干跑，合格才入队；真正落账在定稿后（叶守卫下统一套用）
		const dry = applyPatch(projectedState(ws, deps.baseState), patch);
		if (dry.applied.length === 0) {
			const why = dry.warnings.length > 0 ? dry.warnings.join("；") : "补丁未产生任何变更";
			return { text: `记账被拒：${why}。核对字段语义后重试。`, ok: false };
		}
		ws.patches.push(patch);
		const warn = dry.warnings.length > 0 ? `\n警告（相应字段已忽略）：${dry.warnings.join("；")}` : "";
		return {
			text: `已记账（定稿后生效）：\n${dry.applied.map((a) => `- ${a}`).join("\n")}${warn}`,
			activity: `记账 ${dry.applied.length} 项`,
			ok: true,
		};
	}

	return { text: `未知写侧工具 ${name}。`, ok: false };}
