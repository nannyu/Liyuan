import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { SessionManager } from "@liyuan/agent-runtime";
import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "@liyuan/ai/providers/faux";
import { registerFauxProvider, streamSimple } from "@liyuan/ai/compat";

import { StageEngine, type StageStreamFn } from "../src/stage/engine.ts";

/** 临时舞台：配置+卡+独立会话目录 */
const makeStage = () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-eng-"));
	writeFileSync(
		join(cwd, "card.json"),
		JSON.stringify({ data: { name: "云澜", description: "{{user}}的师姐", first_mes: "你来了。" } }),
	);
	writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "沈舟" }));
	mkdirSync(join(cwd, ".liyuan"), { recursive: true });
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
	return { cwd, sm };
};

const makeEngine = (
	cwd: string,
	sm: InstanceType<typeof SessionManager>,
	model: unknown,
	events: ConstructorParameters<typeof StageEngine>[0]["events"] = {},
) =>
	new StageEngine({
		cwd,
		getSessionManager: () => sm as never,
		getModel: () => model as never,
		getAuth: async () => ({}),
		streamFn: streamSimple as unknown as StageStreamFn,
		events,
	});

/**
 * 场记那一发（M3 起「本拍零落账」的拍才会发起——M-R1 后记账注入把落账拉到台上，
 * 兜底触发率大降，但直出代收+模型不落账的测试路径仍会走到）。
 */
const fauxScribeEmpty = () => fauxAssistantMessage(JSON.stringify({ patch: {} }));

/**
 * 直出正文一拍的完整应答序列（M-R1 五注入日程）：
 * 正文 → 代收回执轮（空应答）→ 记账注入轮（空应答）→ 场记兜底。
 * 合约为空（卡无状态栏）时谢幕注入不发生，日程即收束。
 */
const directBeat = (text: string | ((ctx: unknown) => unknown)) => [
	typeof text === "string" ? fauxAssistantMessage(text) : text,
	fauxAssistantMessage(""),
	fauxAssistantMessage(""),
	fauxScribeEmpty(),
];

test("引擎：一拍全链路（user 落树 → 流式 → assistant 落树 → 谢幕）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses(directBeat("云澜垂眸受了半礼。「山门夜巡未归的人，是你？」") as never);
		let partials = 0;
		let end: { aborted: boolean; entryId?: string; error?: string } | null = null;
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onDelta: () => partials++,
			onTurnEnd: (info) => (end = info),
		});

		await engine.performTurn("我上前行礼。");

		const branch = sm.getBranch() as Array<{ type: string; message?: { role?: string; content?: unknown } }>;
		const roles = branch.filter((e) => e.type === "message").map((e) => e.message?.role);
		assert.deepEqual(roles, ["user", "assistant"]);
		assert.ok(partials > 0, "流式部分事件应外发");
		assert.ok(end && !end.aborted && !end.error && end.entryId, "谢幕信息应带落树条目 id");
		assert.ok(JSON.stringify(branch).includes("山门夜巡"), "正文在树上");
		assert.equal(engine.isStreaming, false);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：忙时排队（R9 回合互斥）——两拍依序完成", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([...directBeat("第一拍回应。"), ...directBeat("第二拍回应。")] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));

		const p1 = engine.performTurn("第一句。");
		const p2 = engine.performTurn("第二句。"); // 忙 → 入队
		await Promise.all([p1, p2]);

		const text = JSON.stringify(sm.getBranch());
		assert.ok(text.includes("第一拍回应"));
		assert.ok(text.includes("第二拍回应"));
		const idx1 = text.indexOf("第一拍回应");
		const idx2 = text.indexOf("第二拍回应");
		assert.ok(idx1 < idx2, "第二拍必须排在第一拍之后");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：regenerate 在钉回的 user 下挂 sibling（swipe 语义）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([...directBeat("第一版回复。"), ...directBeat("重演的第二版。")] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));

		await engine.performTurn("走进殿内。");
		const userId = (sm.getBranch() as Array<{ id: string; type: string; message?: { role?: string } }>).find(
			(e) => e.type === "message" && e.message?.role === "user",
		)?.id;
		assert.ok(userId);

		sm.branch(userId);
		await engine.regenerate();

		const branchText = JSON.stringify(sm.getBranch());
		assert.ok(branchText.includes("重演的第二版"), "当前分支是重演稿");
		assert.ok(!branchText.includes("第一版回复"), "旧变体不在当前分支");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：abort 半拍——已流出的正文落树、标记 aborted", async () => {
	const { cwd, sm } = makeStage();
	// 放慢出字速度，保证 abort 打在流中
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }], tokensPerSecond: 30 });
	try {
		reg.setResponses([
			fauxAssistantMessage("很长的一拍正文，慢慢地流出来，一句接一句，足够被中途打断的长度，再加一句压秤。"),
		]);
		let end: { aborted: boolean; entryId?: string } | null = null;
		let streamed = "";
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onDelta: (kind, delta) => {
				if (kind !== "text") return;
				streamed += delta;
				if (streamed.length >= 8 && engine.isStreaming) engine.abort();
			},
			onTurnEnd: (info) => (end = info),
		});
		await engine.performTurn("开演。");

		assert.ok(end, "谢幕必须发生");
		assert.equal((end as { aborted: boolean }).aborted, true, "应标记为中断");
		const asst = (sm.getBranch() as Array<{ type: string; message?: { role?: string; stopReason?: string } }>).find(
			(e) => e.type === "message" && e.message?.role === "assistant",
		);
		assert.ok(asst, "半拍正文仍应落树（用户看过的戏不消失）");
		assert.equal(asst?.message?.stopReason, "aborted");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎：无模型/无用户输入的失败路径走通知，不落错误正文", async () => {
	const { cwd, sm } = makeStage();
	const notices: string[] = [];
	const engine = new StageEngine({
		cwd,
		getSessionManager: () => sm as never,
		getModel: () => undefined,
		getAuth: async () => ({}),
		streamFn: streamSimple as unknown as StageStreamFn,
		events: { onNotify: (_l, t) => notices.push(t) },
	});
	await engine.performTurn("你好。");
	assert.ok(notices.some((t) => t.includes("剧情模型")), "无模型应有人话提示");
	const asst = (sm.getBranch() as Array<{ type: string; message?: { role?: string } }>).filter(
		(e) => e.type === "message" && e.message?.role === "assistant",
	);
	assert.equal(asst.length, 0, "不落任何 assistant 消息");
	rmSync(cwd, { recursive: true, force: true });
});

// ---------------- M-A：宽进严出 + 验收报告喂回（取代 M2 幕后精修） ----------------

import { writeFileSync as wf } from "node:fs";
import { rebuildHistory, type BranchEntryLike } from "../src/stage/assemble.ts";

/** 在临时舞台上加一个带纪律块（禁词表）的预设 */
const addBannedWordPreset = (cwd: string) => {
	wf(
		join(cwd, "preset.json"),
		JSON.stringify({
			blocks: [{ id: "pol", channel: "system", enabled: true, content: '词汇黑名单 = { "闪过" }' }],
			samplers: {},
		}),
	);
	wf(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "沈舟", preset: "preset.json" }));
};

test("引擎循环：直出→代收+回执（零验收零测量，8/10）→模型可重交→定稿", async () => {
	const { cwd, sm } = makeStage();
	addBannedWordPreset(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const contexts: Array<{ systemPrompt?: string; messages: unknown[] }> = [];
		reg.setResponses([
			(ctx) => {
				contexts.push(ctx);
				return fauxAssistantMessage("她眼中闪过一丝冷意，收剑入鞘。");
			},
			(ctx) => {
				contexts.push(ctx);
				// 模型看到代收回执里的禁词事实，自己判断重交（回执不含指令）
				return fauxAssistantMessage([fauxToolCall("draft_write", { content: "她沉下一层霜色，收剑入鞘。" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(""), // 记账注入轮：无变动直接停
			fauxScribeEmpty(),
		]);
		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
		});
		await engine.performTurn("拔剑指向她。");

		// 定稿 = 模型重交的稿（重交是模型自己的判断，回执没给它任何理由）
		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		const finalText = history[history.length - 1].text;
		assert.ok(finalText.includes("沉下一层霜色"), "定稿是模型重交的文本");

		// 代收回执：一句认收，零验收零测量（验收已整体退役）
		const fed = JSON.stringify(contexts[1].messages);
		assert.ok(fed.includes("正文已代收为 draft_write"), "代收回执在场");
		assert.ok(!fed.includes("禁词"), "回执无任何匹配统计（验收退役）");
		assert.ok(!/约 \d+ 字|验收/.test(fed), "回执无测量值无验收字样");

		// 过程条：代收 → 交稿；R7 仍守：写作阶段 system 不见禁词细则
		assert.ok(activities.some((a) => a.includes("代收")));
		assert.ok(activities.some((a) => a.includes("交稿")));
		assert.ok(!String(contexts[0].systemPrompt).includes("词汇黑名单"), "初稿阶段不见禁词表");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：代收回执后模型不改（只闲聊收笔）→ 保留现稿如实交付，闲聊不落树", async () => {
	const { cwd, sm } = makeStage();
	addBannedWordPreset(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage("她眼中闪过一丝冷意，收剑入鞘。"),
			fauxAssistantMessage("就这样吧。"), // 模型看过事实仍不改，闲聊收笔
			fauxAssistantMessage(""), // 记账注入轮：无变动直接停
			fauxScribeEmpty(),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("拔剑指向她。");

		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		const finalText = history[history.length - 1].text;
		assert.ok(finalText.includes("闪过"), "模型拒改 → 保留现稿（引擎不替模型做决定）");
		assert.ok(!finalText.includes("就这样吧"), "收笔闲聊不进正文");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：干净直出=代收后走完记账席位收束，过程条只有一条代收", async () => {
	const { cwd, sm } = makeStage(); // 无预设
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses(directBeat("干净的一拍正文。") as never);
		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
		});
		await engine.performTurn("走进殿内。");
		assert.equal(reg.getPendingResponseCount(), 0, "初稿+回执轮+记账轮+场记兜底，四发用尽");
		assert.deepEqual(activities, ["直出正文已代收为 draft_write"], "只有一条代收过程条");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------- M3：场记记账（R8 独占 + R4 账本=f(分支)） ----------------

import { stateFromBranch } from "../src/stage/assemble.ts";

const fauxScribe = (patch: Record<string, unknown>) => fauxAssistantMessage(JSON.stringify({ patch }));

test("引擎记账：定稿后场记落 rp-state 快照；账本 = f(分支)", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const scribeCtx: Array<{ messages: unknown[] }> = [];
		reg.setResponses([
			fauxAssistantMessage("云澜接过怀表，指尖顿了顿。"),
			fauxAssistantMessage(""), // 代收回执轮
			fauxAssistantMessage(""), // 记账注入轮：模型没落账 → 场记兜底
			(ctx) => {
				scribeCtx.push(ctx);
				return fauxScribe({ time: "戌时", location: "溪桥", inventory: ["黄铜怀表（云澜持有）"] });
			},
		]);
		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), { onActivity: (d) => activities.push(d) });
		await engine.performTurn("我把怀表递给她。");

		const state = stateFromBranch(sm.getBranch() as BranchEntryLike[]);
		assert.equal(state.time, "戌时");
		assert.equal(state.location, "溪桥");
		assert.deepEqual(state.inventory, ["黄铜怀表（云澜持有）"]);
		assert.ok(activities.some((a) => a.startsWith("记账")), "记账过程条");
		// 场记读到的是本拍定稿正文
		assert.ok(JSON.stringify(scribeCtx[0].messages).includes("指尖顿了顿"));
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎记账：swipe 重演后账本自动回滚（8/02 泄漏事故复测）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage("她收下了怀表。"),
			fauxAssistantMessage(""),
			fauxAssistantMessage(""),
			fauxScribe({ inventory: ["黄铜怀表（云澜持有）"], flags: { 赠礼: "已收下" } }),
			fauxAssistantMessage("她把怀表推了回来。"),
			fauxAssistantMessage(""),
			fauxAssistantMessage(""),
			fauxScribe({ inventory: ["黄铜怀表（沈舟持有）"], flags: { 赠礼: "被拒绝" } }),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("我把怀表递给她。");
		assert.deepEqual(stateFromBranch(sm.getBranch() as BranchEntryLike[]).inventory, ["黄铜怀表（云澜持有）"]);

		// swipe：叶钉回 user，重演一版
		const userId = (sm.getBranch() as Array<{ id: string; type: string; message?: { role?: string } }>).find(
			(e) => e.type === "message" && e.message?.role === "user",
		)?.id;
		assert.ok(userId);
		sm.branch(userId);
		await engine.regenerate();

		const after = stateFromBranch(sm.getBranch() as BranchEntryLike[]);
		assert.deepEqual(after.inventory, ["黄铜怀表（沈舟持有）"], "废弃分支的账本不得泄漏到新分支");
		assert.equal(after.flags["赠礼"], "被拒绝");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎记账：中断的半拍不记账（半截正文不进账本）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }], tokensPerSecond: 30 });
	try {
		reg.setResponses([
			fauxAssistantMessage("很长的一拍正文，慢慢地流出来，一句接一句，足够被中途打断的长度，再加一句压秤。"),
			fauxScribe({ time: "不该被记下的时间" }),
		]);
		let streamed = "";
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onDelta: (kind, delta) => {
				if (kind !== "text") return;
				streamed += delta;
				if (streamed.length >= 8 && engine.isStreaming) engine.abort();
			},
		});
		await engine.performTurn("开演。");

		const snaps = (sm.getBranch() as Array<{ type?: string; customType?: string }>).filter(
			(e) => e.type === "custom" && e.customType === "rp-state",
		);
		assert.equal(snaps.length, 0, "中断拍不落账本快照");
		assert.equal(reg.getPendingResponseCount(), 1, "场记那一发根本没发出");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------- M3：台上检索工具循环（R2 查资料 + R6 动笔即收敛） ----------------

/** 带一条可被检索命中的世界书的舞台 */
const addLorebook = (cwd: string) => {
	wf(
		join(cwd, "lore.json"),
		JSON.stringify({
			entries: {
				"0": {
					uid: 0,
					key: ["骨誓", "北境"],
					comment: "北境骨誓",
					content: "北境以骨为契：折骨立誓，背誓者终身不得入祠。",
					constant: false,
					enabled: true,
					order: 100,
				},
			},
		}),
	);
	wf(
		join(cwd, "liyuan.config.json"),
		JSON.stringify({ card: "card.json", userName: "沈舟", lorebooks: ["lore.json"] }),
	);
};

test("引擎工具：查设定 → 结果回喂 → 续演正文；工具装配进 Context", async () => {
	const { cwd, sm } = makeStage();
	addLorebook(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ tools?: Array<{ name: string }>; messages: unknown[] }> = [];
		reg.setResponses([
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage([fauxToolCall("lorebook_search", { query: "骨誓" })], {
					stopReason: "toolUse",
				});
			},
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage("她提起北境的规矩：折骨立誓，背誓不得入祠。");
			},
			fauxAssistantMessage(""), // 代收回执轮
			fauxAssistantMessage(""), // 记账注入轮
			fauxScribeEmpty(),
		]);
		const activities: string[] = [];
		let streamed = "";
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
			onDelta: (kind, d) => {
				if (kind === "text") streamed += d;
			},
		});
		await engine.performTurn("北境的骨誓是什么规矩？");

		// 读侧 + 写侧全清单装配进首轮。lorebook_toggle 不在其中：本用例未注入
		// setDisabledLore，统一层按依赖过滤（依赖缺失的工具不上清单，见 adapters/stage.ts）
		const names = (ctxs[0].tools ?? []).map((t) => t.name).sort();
		assert.deepEqual(names, [
			"beat_plan",
			"beat_step_done",
			"card_read",
			"draft_append",
			"draft_edit",
			"draft_read",
			"draft_seal",
			"draft_search",
			"draft_write",
			"lorebook_list",
			"lorebook_search",
			"lorebook_write",
			"memory_search",
			"world_state_get",
			"world_state_update",
		]);

		// 检索结果以 toolResult 回喂
		const fed = JSON.stringify(ctxs[1].messages);
		assert.ok(fed.includes("toolResult"), "工具结果以 toolResult 角色回喂");
		assert.ok(fed.includes("折骨立誓"), "命中的设定正文在场");

		// 续演正文流式上屏 + 落树
		//
		// 这一拍查过库（lookups=1），模型却直出正文由引擎代收为 draft_write——
		// 代收走 internal 旁路跳过门禁，否则这拍的正文会被拦下丢掉。
		assert.ok(streamed.includes("背誓不得入祠"), "工具轮后的正文照常流式");
		assert.ok(
			activities.some((a) => a.includes("直出正文已代收")),
			"查过库后的直出正文仍被代收（门禁不拦兜底路径）",
		);
		const branch = sm.getBranch() as Array<{ type: string; message?: { role?: string } }>;
		assert.deepEqual(
			branch.filter((e) => e.type === "message").map((e) => e.message?.role),
			["user", "assistant"],
			"工具过程不落树（R3：过程不进历史）",
		);
		assert.ok(JSON.stringify(branch).includes("背誓不得入祠"), "定稿在树上");
		assert.ok(activities.some((a) => a.includes("查设定「骨誓」")), "过程条报告检索");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：draft_write 工具交稿 → 收稿即验回喂 → 收笔定稿", async () => {
	const { cwd, sm } = makeStage();
	addLorebook(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ messages: unknown[] }> = [];
		reg.setResponses([
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage([fauxToolCall("draft_write", { content: "她点头应下此事。" })], {
					stopReason: "toolUse",
				});
			},
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage(""); // 记账注入轮：无变动直接停
			},
			fauxScribeEmpty(),
		]);
		const activities: string[] = [];
		let streamed = "";
		const draftFlags: boolean[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
			onDelta: (kind, d, draft) => {
				if (kind === "text") {
					streamed += d;
					if (draft) draftFlags.push(true);
				}
			},
		});
		await engine.performTurn("此事你应是不应？");

		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		assert.equal(history[history.length - 1].text, "她点头应下此事。", "定稿 = 工具提交的稿");
		assert.equal(streamed, "她点头应下此事。", "D1：draft_write 的 content 走 text 通道上屏");
		assert.ok(draftFlags.length > 0, "draft_write 转发带 draft 标记（前端替换语义）");
		assert.ok(JSON.stringify(ctxs[1].messages).includes("已收稿"), "收稿+验收报告以 toolResult 回喂");
		assert.ok(activities.some((a) => a.includes("交稿")), "过程条报告交稿");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：draft_append 分段续写 → 中途查证 → draft_seal 封笔 → 定稿为拼接全文（M-E）", async () => {
	const { cwd, sm } = makeStage();
	addLorebook(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			// 第一段：先写开头（首段前有第 1 轮构思，无需 thinking 块）
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "山门外的雪落了一夜。" })], {
				stopReason: "toolUse",
			}),
			// 写到需要查证的地方停下来查——这正是分段续写要换来的东西
			fauxAssistantMessage(
				[fauxThinking("写到骨誓的规矩，记不清细节，停下来查设定。"), fauxToolCall("lorebook_search", { query: "骨誓" })],
				{ stopReason: "toolUse" },
			),
			// 拿到设定后接着往下写（查证轮有思考，不触发零思考门禁）
			fauxAssistantMessage(
				[
					fauxThinking("承接路标：把查到的骨誓规矩落进这段，他记起北境的戒律。"),
					fauxToolCall("draft_append", { segment: "他记起北境的规矩：背誓不得入祠。" }),
				],
				{ stopReason: "toolUse" },
			),
			// 封笔
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(""), // 看到验收报告 → 收笔
			fauxScribeEmpty(),
		]);
		const activities: string[] = [];
		let streamed = "";
		let resets = 0;
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
			onDelta: (kind, d, draft, reset) => {
				if (kind !== "text") return;
				streamed += d;
				if (draft && reset) resets++;
			},
		});
		await engine.performTurn("我推门进屋。");

		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		const finalText = history[history.length - 1].text;
		assert.ok(finalText.includes("山门外的雪落了一夜。"), "第一段在定稿里");
		assert.ok(finalText.includes("背誓不得入祠"), "续写的第二段也在定稿里（追加不覆盖）");
		assert.ok(
			finalText.indexOf("山门外") < finalText.indexOf("背誓不得入祠"),
			"两段按写作顺序拼接",
		);
		// 关键体验：续写不得 reset——已上屏的段落是已经发生的事，不能被擦掉重排
		assert.equal(resets, 0, "draft_append 的流式转发不带 reset（不清屏重写）");
		assert.ok(streamed.includes("山门外的雪落了一夜。"), "第一段流式上屏");
		assert.ok(streamed.includes("背誓不得入祠"), "第二段流式上屏");
		assert.ok(
			activities.some((a) => a.includes("续写第 1 段")) && activities.some((a) => a.includes("续写第 2 段")),
			"过程条按段报告续写",
		);
		assert.ok(activities.some((a) => a.includes("封笔")), "过程条报告封笔");
		// 时间线持久化：两段独立记档（刷新后仍是「一段段长出来」的形态）
		const branch = JSON.stringify(sm.getBranch());
		assert.ok(branch.includes("rpTimeline"), "时间线随 details 持久化");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：draft_append 后忘了封笔 → 催告一轮 → 仍不封则兜底封笔，日程照走（M-E/M-R1）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ messages: unknown[] }> = [];
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "她把伞收在门外，抖了抖雪。" })], {
				stopReason: "toolUse",
			}),
			// 停手但没封笔 → 引擎催封笔一轮（§2.4 文案）
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage(""); // 催告后仍不封笔 → 引擎兜底封笔
			},
			fauxAssistantMessage(""), // 记账注入轮
			fauxScribeEmpty(),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {});
		await engine.performTurn("我抬头看她。");

		const nudge = JSON.stringify(ctxs[0]?.messages ?? []);
		assert.ok(nudge.includes("已续写 1 段未封笔。写完就 draft_seal，没写完接着写。"), "催封笔 = 契约文案（§2.4）");
		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		assert.equal(history[history.length - 1].text, "她把伞收在门外，抖了抖雪。", "兜底封笔，正文照常落树");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：格式尾巴（状态栏占位+catsay）走 text 通道 → 并入定稿正文与持久化时间线", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			// 8/05 实锤形态：draft_write 只交正文，思考里宣告还要写状态栏与点评
			fauxAssistantMessage(
				[
					fauxThinking("The user decides. Now the status bar and cat commentary."),
					fauxToolCall("draft_write", { content: "暮色四合，两人到了溪桥。" }),
				],
				{ stopReason: "toolUse" },
			),
			// 尾巴轮：状态栏占位 + 咪咪点评（预设格式栈，不走 draft_write）
			fauxAssistantMessage(
				"<StatusPlaceHolderImpl/>\n\n<catsay>\n<details><summary>😼咪咪点评</summary>\n选天赋磨叽半天喵呜。\n</details>\n</catsay>",
			),
			fauxScribeEmpty(),
		]);
		const activities: string[] = [];
		let streamed = "";
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onActivity: (d) => activities.push(d),
			onDelta: (kind, d) => {
				if (kind === "text") streamed += d;
			},
		});
		await engine.performTurn("往溪桥去。");

		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		// 树上正文 = 用户面定稿：正文 + 状态栏占位 + 咪咪点评都在
		const branch = sm.getBranch() as Array<{
			type: string;
			message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
		}>;
		const lastMsg = [...branch].reverse().find((e) => e.type === "message" && e.message?.role === "assistant");
		const treeText = (lastMsg?.message?.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		assert.ok(treeText.includes("暮色四合"), "正文在树上");
		assert.ok(treeText.includes("StatusPlaceHolderImpl"), "状态栏占位并入定稿——不再被过滤");
		assert.ok(treeText.includes("咪咪点评"), "咪咪点评并入定稿——不再被过滤");
		assert.ok(streamed.includes("咪咪点评"), "尾巴也流式上屏过");
		// 模型面历史仍整块剥 catsay（防往拍模仿）——「历史剥、树留」双语义各就位
		assert.ok(history[history.length - 1].text.includes("暮色四合"), "历史含正文");
		assert.ok(!history[history.length - 1].text.includes("咪咪点评"), "历史剥掉格式栈（往拍模仿源）");

		// 时间线随 details 持久化：resync/刷新后尾巴仍在
		const entry = branch.filter((e) => e.type === "message" && e.message?.content).pop();
		const timeline = entry?.message?.details?.rpTimeline as
			| Array<{ kind: string; text?: string; draft?: boolean }>
			| undefined;
		assert.ok(Array.isArray(timeline), "rpTimeline 落树持久化");
		const textSegs = (timeline ?? []).filter((s) => s.kind === "text");
		const tlText = textSegs.map((s) => s.text ?? "").join("\n\n");
		assert.ok(tlText.includes("咪咪点评"), "持久化时间线含尾巴");
		// 分段同构（8/09 输出形式）：稿段与尾巴段各自独立——稿段带 draft，尾巴段不带
		assert.equal(textSegs.length, 2, "稿段 + 尾巴段，互不吸收");
		assert.ok(textSegs[0].draft === true && (textSegs[0].text ?? "").includes("暮色四合"), "稿段在前且带 draft 标记");
		assert.ok(textSegs[1].draft !== true && (textSegs[1].text ?? "").includes("咪咪点评"), "尾巴独立末段（非稿段）");
		assert.ok(activities.some((a) => a.includes("交稿")), "过程条照常");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：world_state_update 记账——模型提交 patch，账本落树，场记旁路不再发出", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("world_state_update", { patch: { time: "戌时", location: "溪桥" } }),
					fauxToolCall("draft_write", { content: "暮色四合，两人到了溪桥。" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(""), // 收笔
			// 注意：没有场记那一发——模型已记账，旁路兜底不得发出
		]);
		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), { onActivity: (d) => activities.push(d) });
		await engine.performTurn("往溪桥去。");

		const state = stateFromBranch(sm.getBranch() as BranchEntryLike[]);
		assert.equal(state.time, "戌时");
		assert.equal(state.location, "溪桥");
		assert.equal(reg.getPendingResponseCount(), 0, "两发用尽——场记旁路没有发出（D5 兜底只在无 patch 时）");
		assert.ok(activities.some((a) => a.includes("记账")), "记账过程条");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：空手停笔（0 字病灶）→ 催稿一轮 → 补交定稿", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ messages: unknown[] }> = [];
		reg.setResponses([
			fauxAssistantMessage(""), // 思考完不写正文（实弹三拍 0 字的复现）
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage("补上的正文。");
			},
			fauxAssistantMessage(""), // 代收回执轮
			fauxAssistantMessage(""), // 记账注入轮
			fauxScribeEmpty(),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("开演。");

		const nudge = JSON.stringify(ctxs[0].messages);
		assert.ok(nudge.includes("你还没有落笔。用 draft_append 演出，或 draft_write 一次交完，否则本拍无产出。"), "逼稿 = 契约文案（§2.4）");
		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		assert.equal(history[history.length - 1].text, "补上的正文。", "补交的正文成为定稿——空拍被结构性消灭");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎循环：催稿后仍空手 → 认栽收拍并通知（不再静默丢拍）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("")]);
		const notices: string[] = [];
		let end: { error?: string } | null = null;
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onNotify: (_l, t) => notices.push(t),
			onTurnEnd: (info) => (end = info),
		});
		await engine.performTurn("开演。");

		assert.ok(notices.some((t) => t.includes("未交出任何正文")), "空拍必须有人话通知");
		assert.equal((end as { error?: string } | null)?.error, "no-draft");
		const asst = (sm.getBranch() as Array<{ type: string; message?: { role?: string } }>).filter(
			(e) => e.type === "message" && e.message?.role === "assistant",
		);
		assert.equal(asst.length, 0, "空拍不落树");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎工具：不查资料的一拍零额外调用（工具是可选的，不是必经的）", async () => {
	const { cwd, sm } = makeStage();
	addLorebook(cwd);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses(directBeat("她点了点头，没多问。") as never);
		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), { onActivity: (d) => activities.push(d) });
		await engine.performTurn("我说了声走吧。");

		assert.equal(reg.getPendingResponseCount(), 0, "直出四发（初稿/回执/记账/场记），无工具轮");
		assert.ok(!activities.some((a) => a.startsWith("查")), "没查就不出检索过程条");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------- M4 长局压缩（引擎自管） ----------------

/** 写配置：压缩周期可调 */
const setCompactEvery = (cwd: string, everyNTurns: number) =>
	writeFileSync(
		join(cwd, "liyuan.config.json"),
		JSON.stringify({ card: "card.json", userName: "沈舟", compactEveryNTurns: everyNTurns }),
	);

test("引擎压缩：攒够拍数后自管落 rp-summary，被覆盖的正文不再进上下文", async () => {
	const { cwd, sm } = makeStage();
	setCompactEvery(cwd, 2);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ messages: Array<{ content?: unknown }> }> = [];
		const long = (i: number) => `第 ${i} 拍的正文。${"云".repeat(1200)}`;
		// 8 拍：保留 6 + 周期 2 → 第 8 拍收尾时应触发一次压缩
		const responses: unknown[] = [];
		for (let i = 1; i <= 8; i++) {
			responses.push((ctx: unknown) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage(long(i));
			});
			responses.push(fauxAssistantMessage("")); // 代收回执轮
			responses.push(fauxAssistantMessage("")); // 记账注入轮
			responses.push(fauxScribeEmpty());
		}
		// 压缩那一发（第 8 拍尾）
		responses.push(fauxAssistantMessage("## 前情提要\n沈舟与云澜在山门相遇。\n## 当前场景\n第三天黄昏，后山。"));
		reg.setResponses(responses as never);

		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), { onActivity: (d) => activities.push(d) });
		for (let i = 1; i <= 8; i++) await engine.performTurn(`第 ${i} 拍我说的话。`);

		const branch = sm.getBranch() as Array<{ type: string; customType?: string; data?: unknown }>;
		const summaries = branch.filter((e) => e.type === "custom" && e.customType === "rp-summary");
		assert.equal(summaries.length, 1, "应恰好落一条 rp-summary");
		const data = summaries[0].data as { summary: string; coversThroughId: string; turns: number };
		assert.ok(data.summary.includes("前情提要"));
		assert.equal(data.turns, 2, "8 拍保留 6 → 覆盖前 2 拍");
		assert.ok(activities.some((a) => a.includes("前情已压缩")), "过程条报告压缩");

		// 树只追加：原文楼层照旧全在（重放/回看不受影响）
		assert.ok(JSON.stringify(branch).includes("第 1 拍的正文"), "被覆盖的正文仍在树上");
		assert.equal(reg.getPendingResponseCount(), 0, "八拍（各四发）+ 一次压缩");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎压缩：下一拍装配读回【前情提要】，被覆盖的往拍原文消失（长局提速的实质）", async () => {
	const { cwd, sm } = makeStage();
	setCompactEvery(cwd, 2);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ messages: Array<{ content?: unknown }> }> = [];
		const cap = (text: string) => (ctx: unknown) => {
			ctxs.push(ctx as never);
			return fauxAssistantMessage(text);
		};
		const responses: unknown[] = [];
		for (let i = 1; i <= 8; i++) {
			responses.push(cap(`第 ${i} 拍的正文。${"云".repeat(1200)}`));
			responses.push(fauxAssistantMessage(""));
			responses.push(fauxAssistantMessage(""));
			responses.push(fauxScribeEmpty());
		}
		responses.push(fauxAssistantMessage("## 前情提要\n沈舟与云澜在山门相遇，立了骨誓。"));
		// 压缩之后的第 9 拍
		responses.push(cap("第 9 拍的正文。"));
		responses.push(fauxAssistantMessage(""));
		responses.push(fauxAssistantMessage(""));
		responses.push(fauxScribeEmpty());
		reg.setResponses(responses as never);

		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		for (let i = 1; i <= 9; i++) await engine.performTurn(`第 ${i} 拍我说的话。`);

		const capturedBeat9 = ctxs[ctxs.length - 1];
		const flat = JSON.stringify(capturedBeat9.messages);
		assert.ok(flat.includes("【前情提要】"), "摘要以前情提要块回读进上下文");
		assert.ok(flat.includes("立了骨誓"), "摘要正文在场");
		assert.ok(!flat.includes("第 1 拍的正文"), "被覆盖的往拍原文不再进上下文");
		assert.ok(!flat.includes("第 2 拍的正文"), "被覆盖的往拍原文不再进上下文");
		assert.ok(flat.includes("第 7 拍的正文"), "保留区往拍逐字仍在");

		// 用户当拍的话仍是最后一句（8/03 教训不能被压缩打破）
		const lastMsg = capturedBeat9.messages[capturedBeat9.messages.length - 1] as { content: Array<{ text: string }> };
		assert.ok(lastMsg.content[0].text.trimEnd().endsWith("第 9 拍我说的话。"), "用户当拍的话必须是上下文最后一句");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎压缩：中断的半拍不触发压缩（脏拍不压）", async () => {
	const { cwd, sm } = makeStage();
	setCompactEvery(cwd, 1);
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const responses: unknown[] = [];
		for (let i = 1; i <= 8; i++) {
			responses.push(fauxAssistantMessage(`第 ${i} 拍的正文。${"云".repeat(1200)}`));
			responses.push(fauxAssistantMessage(""));
			responses.push(fauxAssistantMessage(""));
			responses.push(fauxScribeEmpty());
		}
		// 第 8 拍收尾时可裁正文（前 2 拍）才越过字数地板 → 恰好压一次
		responses.push(fauxAssistantMessage("## 前情提要\n前两拍的摘要。"));
		reg.setResponses(responses as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		for (let i = 1; i <= 8; i++) await engine.performTurn(`第 ${i} 拍我说的话。`);
		const before = (sm.getBranch() as Array<{ customType?: string }>).filter((e) => e.customType === "rp-summary");
		assert.equal(before.length, 1, "干净收笔的拍会压缩");

		// 中断的半拍：只出正文不出场记/压缩
		reg.setResponses([fauxAssistantMessage(`第 9 拍。${"云".repeat(1200)}`, { stopReason: "aborted" })]);
		await engine.performTurn("第 9 拍我说的话。");
		const after = (sm.getBranch() as Array<{ customType?: string }>).filter((e) => e.customType === "rp-summary");
		assert.equal(after.length, 1, "中断半拍不得触发新压缩");
		assert.equal(reg.getPendingResponseCount(), 0);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("引擎压缩：compactNow() 手动压缩不等周期；流式中拒绝", async () => {
	const { cwd, sm } = makeStage();
	setCompactEvery(cwd, 0); // 自动压缩关闭
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const responses: unknown[] = [];
		for (let i = 1; i <= 8; i++) {
			responses.push(fauxAssistantMessage(`第 ${i} 拍的正文。${"云".repeat(1200)}`));
			responses.push(fauxAssistantMessage(""));
			responses.push(fauxAssistantMessage(""));
			responses.push(fauxScribeEmpty());
		}
		reg.setResponses(responses as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		for (let i = 1; i <= 8; i++) await engine.performTurn(`第 ${i} 拍我说的话。`);

		assert.equal(
			(sm.getBranch() as Array<{ customType?: string }>).filter((e) => e.customType === "rp-summary").length,
			0,
			"everyNTurns=0 时不自动压缩",
		);

		reg.setResponses([fauxAssistantMessage("## 前情提要\n手动压缩产出的摘要。")]);
		const r = await engine.compactNow();
		assert.equal(r.kind, "compacted");
		assert.equal(
			(sm.getBranch() as Array<{ customType?: string }>).filter((e) => e.customType === "rp-summary").length,
			1,
			"手动压缩落一条摘要",
		);
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});


test("轮内自由（D10）：同一轮两个 draft_append 全部收下——停顿单位是剧情轮次，不是工具调用", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const responses: unknown[] = [
			// 一轮连发两个 append：都收（连发门禁已删）
			fauxAssistantMessage(
				[
					fauxToolCall("draft_append", { segment: "她推门进院。" }),
					fauxToolCall("draft_append", { segment: "院里空无一人。" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage(""), // 记账注入轮
			fauxScribeEmpty(),
		];
		reg.setResponses(responses as never);

		const activities: string[] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), { onActivity: (d) => activities.push(d) });
		await engine.performTurn("你先进去。");

		assert.ok(activities.some((a) => a.includes("续写第 1 段")) && activities.some((a) => a.includes("续写第 2 段")), "两段都收");
		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		const finalText = history[history.length - 1].text;
		assert.ok(finalText.indexOf("她推门进院。") < finalText.indexOf("院里空无一人。"), "两段按序拼接落树");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("五注入日程：进度行每轮替换、判定注入路标演完时一次（§2.3）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: string[] = [];
		const cap = (r: unknown) => (ctx: { messages?: unknown[] }) => {
			ctxs.push(JSON.stringify(ctx.messages ?? []));
			return r;
		};
		reg.setResponses([
			// 规划轮：首轮末端注入应带规划卡（契约文案）
			cap(fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["推门", "见人"] })], { stopReason: "toolUse" })),
			// 演第一段（此轮上下文应有【进度】路标 1/2）
			cap(fauxAssistantMessage([fauxToolCall("draft_append", { segment: "她推门进院。" }), fauxToolCall("beat_step_done", { step: 1 })], { stopReason: "toolUse" })),
			// 演第二段并勾掉（此轮上下文应有【进度】路标 2/2——旧的进度行被替换）
			cap(fauxAssistantMessage([fauxToolCall("draft_append", { segment: "院里的人抬起头。" }), fauxToolCall("beat_step_done", { step: 2 })], { stopReason: "toolUse" })),
			// 路标全部演完：此轮上下文应有【判定】
			cap(fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" })),
			cap(fauxAssistantMessage("")), // 记账注入轮
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("你先进去。");

		assert.ok(ctxs[0].includes("【第 1 步·规划】本拍还没有计划。"), "规划卡随首轮末端注入送达");
		assert.ok(ctxs[1].includes("【进度】路标 1/2「推门」；已演 0 段，正文约 0 字。"), "进度行 = 事实（字数是续写的触发燃料，8/10 复核保留）");
		assert.ok(ctxs[2].includes("【进度】路标 2/2「见人」；已演 1 段"), "进度行更新到当前路标");
		assert.equal((ctxs[2].match(/【进度】/g) ?? []).length, 1, "替换语义：上下文里只有一条进度行");
		assert.ok(ctxs[3].includes("【判定】正文约"), "判定注入在路标演完且稿非空时出现（字数事实随行）");
		assert.ok(ctxs[3].includes("的行动或选择，先 `ask` 再动笔"), "判定注入 = 契约文案（PLAN-ASK §2.1：ask 裁决句随行）");
		assert.ok(ctxs[4].includes("【记账】已封笔。"), "seal 之后第一件事是记账注入");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});


test("抢跑 seal 时序保证（PLAN-ASK §2.2）：路标演完同轮直接封笔被判定回执拦下，二次 seal 受理", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: string[] = [];
		const cap = (r: unknown) => (ctx: { messages?: unknown[] }) => {
			ctxs.push(JSON.stringify(ctx.messages ?? []));
			return r;
		};
		reg.setResponses([
			cap(fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["推门"] })], { stopReason: "toolUse" })),
			// 抢跑形态：同一轮里演完、勾完、直接 seal——判定席位从未送达
			cap(
				fauxAssistantMessage(
					[
						fauxToolCall("draft_append", { segment: "她推门进院。" }),
						fauxToolCall("beat_step_done", { step: 1 }),
						fauxToolCall("draft_seal", {}),
					],
					{ stopReason: "toolUse" },
				),
			),
			// 判定回执已达；模型再次 seal → 照常受理
			cap(fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" })),
			cap(fauxAssistantMessage("")), // 记账注入轮
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("你先进去。");

		assert.ok(ctxs[2].includes("【判定】正文约"), "首次 seal 不受理——回执即判定文案（同一席位提前送达）");
		assert.ok(ctxs[2].includes("先 `ask` 再动笔"), "判定回执带 ask 裁决句");
		assert.ok(!ctxs[2].includes("已封笔"), "首次 seal 未被受理");
		assert.ok(ctxs[3].includes("已封笔"), "二次 seal 照常受理（一次性保证，不成循环）");
		assert.ok(ctxs[3].includes("【记账】已封笔。"), "受理后日程继续：记账注入");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});


test("判定注入以稿非空为门（8/10）：0 字连勾不触发判定，正文落地后才判定", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: string[] = [];
		const cap = (r: unknown) => (ctx: { messages?: unknown[] }) => {
			ctxs.push(JSON.stringify(ctx.messages ?? []));
			return r;
		};
		reg.setResponses([
			cap(fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["推门", "见人"] })], { stopReason: "toolUse" })),
			// 稿纸 0 字连勾两条（实弹拍1 的勾选表演形态）
			cap(fauxAssistantMessage([fauxToolCall("beat_step_done", { step: 1 }), fauxToolCall("beat_step_done", { step: 2 })], { stopReason: "toolUse" })),
			// 此轮上下文不应有【判定】——正文还没落地
			cap(fauxAssistantMessage([fauxToolCall("draft_append", { segment: "她推门进院。" })], { stopReason: "toolUse" })),
			// 正文落地后：判定注入出现
			cap(fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" })),
			cap(fauxAssistantMessage("")),
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("你先进去。");

		assert.ok(!ctxs[2].includes("【判定】"), "0 字勾完不触发判定（勾选表演不推进日程）");
		assert.ok(ctxs[2].includes("【进度】"), "继续进度行");
		assert.ok(ctxs[3].includes("【判定】正文约"), "正文落地后判定出现");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("判定送达不依赖路标勾选（8/12 放宽）：没勾完路标就封笔被判定回执拦下，二次 seal 受理", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: string[] = [];
		const cap = (r: unknown) => (ctx: { messages?: unknown[] }) => {
			ctxs.push(JSON.stringify(ctx.messages ?? []));
			return r;
		};
		reg.setResponses([
			cap(fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["推门", "见人"] })], { stopReason: "toolUse" })),
			// 实弹形态：只勾了第 1 条路标（勾 1/2）就直接封笔——判定席位从未送达
			cap(
				fauxAssistantMessage(
					[
						fauxToolCall("draft_append", { segment: "她推门进院。" }),
						fauxToolCall("beat_step_done", { step: 1 }),
						fauxToolCall("draft_seal", {}),
					],
					{ stopReason: "toolUse" },
				),
			),
			// 判定回执已达；模型再次 seal → 照常受理（拦一次不拦第二次，防空转）
			cap(fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" })),
			cap(fauxAssistantMessage("")), // 记账注入轮
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("你先进去。");

		assert.ok(ctxs[2].includes("【判定】正文约"), "没勾完路标直接封笔也被拦——回执即判定文案");
		assert.ok(ctxs[2].includes("先 `ask` 再动笔"), "判定回执带 ask 裁决句");
		assert.ok(!ctxs[2].includes("已封笔"), "首次 seal 未被受理（判定优先于封笔）");
		assert.ok(ctxs[3].includes("已封笔"), "二次 seal 照常受理（一次性保证，不成循环）");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("判定送达不依赖工具轮（8/12 补洞）：勾不齐路标就停手，兜底封笔前补判定", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: string[] = [];
		const cap = (r: unknown) => (ctx: { messages?: unknown[] }) => {
			ctxs.push(JSON.stringify(ctx.messages ?? []));
			return r;
		};
		reg.setResponses([
			cap(fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["推门", "见人"] })], { stopReason: "toolUse" })),
			// 只勾了第 1 条（勾 1/2，allDone=false → 工具轮判定分支不触发），然后停手
			cap(
				fauxAssistantMessage(
					[fauxToolCall("draft_append", { segment: "她推门进院。" }), fauxToolCall("beat_step_done", { step: 1 })],
					{ stopReason: "toolUse" },
				),
			),
			// 停手1：催封笔（appends>0 未封笔）
			cap(fauxAssistantMessage("")),
			// 停手2：催过仍停手 → 兜底封笔前补判定（工具轮判定分支跑不到，停手分支补）
			cap(fauxAssistantMessage("")),
			// 停手3：判定已送达 → 兜底封笔 → 记账 → 谢幕 → 收束
			cap(fauxAssistantMessage("")),
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("你先进去。");

		assert.ok(ctxs[3].includes("已续写 1 段未封笔"), "停手1：催封笔");
		assert.ok(ctxs[4].includes("【判定】正文约"), "停手2：兜底封笔前补判定");
		assert.ok(ctxs[4].includes("先 `ask` 再动笔"), "补的判定带 ask 裁决句");
		assert.equal((ctxs[4].match(/【判定】/g) ?? []).length, 1, "判定只补一次，不成循环");
		const branch = sm.getBranch() as Array<{ type: string; message?: { role?: string; content?: unknown } }>;
		assert.ok(JSON.stringify(branch).includes("她推门进院"), "正文在树上（兜底封笔正常收束）");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});




test("每轮修复可见性：draft_edit 修改后分段重同步（8/09 输出形式）", async () => {
	const { cwd, sm } = makeStage();
	addBannedWordPreset(cwd); // 禁词表 { "闪过" }
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const responses: unknown[] = [];
		// 第一轮：beat_plan
		responses.push(fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["推门"] })], { stopReason: "toolUse" }));
		// 第二轮：append 带禁词的第一段
		responses.push(
			fauxAssistantMessage(
				[fauxThinking("承接路标：她推门进来，眼中闪过一道冷光。"), fauxToolCall("draft_append", { segment: "她推门进来，眼中闪过一道冷光。" })],
				{ stopReason: "toolUse" },
			),
		);
		// 第三轮：draft_edit 修掉禁词
		responses.push(
			fauxAssistantMessage(
				[fauxThinking("修掉禁词。"), fauxToolCall("draft_edit", { edits: [{ old: "眼中闪过一道冷光", new: "眼中亮起一道冷光" }] })],
				{ stopReason: "toolUse" },
			),
		);
		// 第四轮：封笔
		responses.push(fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }));
		responses.push(fauxAssistantMessage(""));
		responses.push(fauxScribeEmpty());
		reg.setResponses(responses as never);

		const resyncs: string[][] = [];
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onDraftResync: (segments) => resyncs.push(segments),
		});
		await engine.performTurn("你先进去。");

		// 编辑后收到分段重同步推送：修后分段原位替换，禁词已消失
		assert.ok(resyncs.length >= 1, "draft_edit 后应收到 draft_resync 推送");
		const last = resyncs[resyncs.length - 1];
		assert.ok(last.some((p) => p.includes("眼中亮起一道冷光")), "推送的是修后分段");
		assert.ok(last.every((p) => !p.includes("闪过")), "禁词已消失");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("谢幕注入（§4.B）：卡定义状态栏 → 记账轮后注入合约点名，状态栏落树", async () => {
	// 卡 first_mes 带 StatusBlock 示例 → 合约 v0 从卡状态栏识别生成
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-eng-"));
	writeFileSync(
		join(cwd, "card.json"),
		JSON.stringify({
			data: {
				name: "云澜",
				description: "{{user}}的师姐",
				first_mes: "你来了。\n<StatusBlock>\n地点：山门\n</StatusBlock>",
			},
		}),
	);
	writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "沈舟" }));
	mkdirSync(join(cwd, ".liyuan"), { recursive: true });
	const sm = SessionManager.create(cwd, join(cwd, "sessions"));
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		let curtainCtx = "";
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["推门"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxToolCall("draft_append", { segment: "他推门进屋，炉火将熄。" })],
				{ stopReason: "toolUse" },
			),
			// 首次 seal：路标没勾 → 判定回执拦下（8/12 放宽：判定送达不依赖路标勾选）
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			// 二次 seal：照常受理 → seal 后工具轮注入记账
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			// 记账轮：模型停手（没有变动）→ 日程推进到谢幕注入
			fauxAssistantMessage([fauxThinking("这拍演完了。")]),
			// 谢幕轮：按合约输出状态栏
			(ctx: { messages?: unknown[] }) => {
				curtainCtx = JSON.stringify(ctx.messages ?? []);
				return fauxAssistantMessage("<StatusBlock>\n地点：屋内\n</StatusBlock>");
			},
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("你先进去。");

		assert.ok(
			curtainCtx.includes("【谢幕】记账已毕。输出本拍格式块：`<StatusBlock>` 状态栏。输出完本拍结束。"),
			"谢幕注入 = 合约点名（文案即规格）",
		);
		const branch = sm.getBranch() as Array<{
			type: string;
			message?: { role?: string; content?: Array<{ type?: string; text?: string }>; details?: { rpTimeline?: unknown } };
		}>;
		const lastMsg = [...branch].reverse().find((e) => e.type === "message" && e.message?.role === "assistant");
		const treeText = (lastMsg?.message?.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		assert.ok(treeText.includes("他推门进屋"), "正文在树上");
		assert.ok(treeText.includes("StatusBlock"), "谢幕轮产出经 mergeFinalText 拼接落树");
		// 分段同构：状态栏是独立尾巴段（非稿段），排在最后
		const tl = (lastMsg?.message?.details?.rpTimeline ?? []) as Array<{ kind: string; text?: string; draft?: boolean }>;
		const textSegs = tl.filter((s) => s.kind === "text");
		assert.ok(textSegs.length >= 2, "稿段 + 尾巴段");
		const tail = textSegs[textSegs.length - 1];
		assert.ok((tail.text ?? "").includes("StatusBlock") && tail.draft !== true, "状态栏收成独立尾巴末段");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("记账注入（§2.3）：seal 后席位保证；本拍已有落账（结构信号）则跳过", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		let postSealCtx = "";
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["推门", "进屋叙话"] })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[fauxToolCall("draft_append", { segment: "他推门进屋，炉火将熄。" })],
				{ stopReason: "toolUse" },
			),
			// 首次 seal：路标没勾 → 判定回执拦下；二次 seal 照常受理 → 注入记账
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			// seal 之后第一件事：记账注入（捕获）；模型据此落账
			(ctx) => {
				postSealCtx = JSON.stringify((ctx as { messages?: unknown[] }).messages ?? []);
				return fauxAssistantMessage([fauxToolCall("world_state_update", { patch: { location: "屋内" } })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage(""), // 记账轮结束（停止调用写账工具）→ 无合约 → 收束
			// 模型已落账：场记兜底不发出
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("你先进去。");

		assert.ok(postSealCtx.includes("【记账】已封笔。核对本拍变动并落账"), "记账注入 = 契约文案");
		assert.ok(postSealCtx.includes("没有变动就直接停"), "记账注入完整送达");
		assert.ok(!postSealCtx.includes("【演段回看】") && !postSealCtx.includes("【谢幕】"), "封笔后不催演；谢幕在记账轮之后");
		assert.equal(stateFromBranch(sm.getBranch() as BranchEntryLike[]).location, "屋内", "台上落账生效");
		assert.equal(reg.getPendingResponseCount(), 0, "场记兜底未发出（本拍已有落账）");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("记账注入跳过：拍中已落账（patch 队列非空）→ seal 后不再注入记账，直接收束", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		let postSealCtx = "";
		reg.setResponses([
			// 演出中途就记了账（结构信号：ws.patches 非空）
			fauxAssistantMessage(
				[
					fauxToolCall("world_state_update", { patch: { time: "戌时" } }),
					fauxToolCall("draft_write", { content: "暮色四合，两人到了溪桥。" }),
				],
				{ stopReason: "toolUse" },
			),
			(ctx) => {
				postSealCtx = JSON.stringify((ctx as { messages?: unknown[] }).messages ?? []);
				return fauxAssistantMessage("");
			},
			// 无合约无兜底：两发结束
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("往溪桥去。");

		assert.ok(!postSealCtx.includes("【记账】"), "已有落账 → 记账注入跳过（判据是结构信号）");
		assert.equal(stateFromBranch(sm.getBranch() as BranchEntryLike[]).time, "戌时");
		assert.equal(reg.getPendingResponseCount(), 0, "场记兜底未发出");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("规划旁白不入正文：稿落地前工具轮的 text 产出被清理，不拼进定稿（8/09 实弹）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		reg.setResponses([
			// 规划轮：模型把读题/列路标走了 text 通道（实弹形态）——旁白，不是正文
			fauxAssistantMessage(
				[fauxText("先读题：用户要看炉火，我列一下路标。"), fauxToolCall("beat_plan", { steps: ["推门"] })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				[fauxThinking("演第一段。"), fauxToolCall("draft_append", { segment: "他推门进屋，炉火将熄。" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }),
			// 停手轮直接带尾巴（稿落地后的 text = 合法尾巴，保留）
			fauxAssistantMessage("<catsay>点评一句。</catsay>"),
			fauxScribeEmpty(),
		]);
		let clears = 0;
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"), {
			onStreamClear: () => clears++,
		});
		await engine.performTurn("你先进去。");

		const branch = sm.getBranch() as Array<{
			type: string;
			message?: { role?: string; content?: Array<{ type?: string; text?: string }>; details?: { rpTimeline?: unknown } };
		}>;
		const lastMsg = [...branch].reverse().find((e) => e.type === "message" && e.message?.role === "assistant");
		const treeText = (lastMsg?.message?.content ?? [])
			.filter((c) => c.type === "text")
			.map((c) => c.text ?? "")
			.join("");
		assert.ok(treeText.includes("他推门进屋"), "正文在树上");
		assert.ok(treeText.includes("点评一句"), "稿后尾巴保留");
		assert.ok(!treeText.includes("先读题"), "规划旁白不得拼进定稿正文");
		const tl = (lastMsg?.message?.details?.rpTimeline ?? []) as Array<{ kind: string; text?: string }>;
		const tlText = tl.filter((s) => s.kind === "text").map((s) => s.text ?? "").join("\n");
		assert.ok(!tlText.includes("先读题"), "落树时间线的正文段不含旁白");
		assert.ok(clears >= 1, "旁白轮触发 stream 清理（前端收进过程条）");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("轮次耗尽收场：安全阀撤工具时注入【收场】指令，最后一轮产出拼进定稿（8/09 实弹）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		let lastCtx = "";
		let lastCtxHadTools = true;
		const responses: unknown[] = [
			fauxAssistantMessage(
				[fauxToolCall("beat_plan", { steps: ["一", "二", "三", "四", "五", "六", "七", "八"] })],
				{ stopReason: "toolUse" },
			),
		];
		// 19 个 append，把轮次预算（20）耗到最后一轮
		for (let i = 1; i <= 19; i++) {
			responses.push(
				fauxAssistantMessage(
					[fauxThinking(`想第 ${i} 段。`), fauxToolCall("draft_append", { segment: `第 ${i} 段正文。` })],
					{ stopReason: "toolUse" },
				),
			);
		}
		// 最后一轮（lastRound，工具已收起）：捕获上下文，收场输出尾巴
		responses.push((ctx: { messages?: unknown[]; tools?: unknown }) => {
			lastCtx = JSON.stringify(ctx.messages ?? []);
			lastCtxHadTools = ctx.tools !== undefined;
			return fauxAssistantMessage("<catsay>收场点评。</catsay>");
		});
		responses.push(fauxScribeEmpty());
		reg.setResponses(responses as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("开演。");

		assert.ok(lastCtx.includes("【收场】"), "轮次耗尽时注入收场指令（不再让模型不明所以干想散场）");
		assert.equal(lastCtxHadTools, false, "最后一轮工具已收起");
		const branchText = JSON.stringify(sm.getBranch());
		assert.ok(branchText.includes("收场点评"), "最后一轮的产出拼进定稿");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("直出代收回执（§2.4）：事实+可用动作，格式块归属声明在场；正文不推倒", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		let nudgeCtx = "";
		reg.setResponses([
			fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["解衣", "磨墨", "奉砚"] })], { stopReason: "toolUse" }),
			// 列了路标却整拍直出（8/09 实弹形态）——代收，不推倒，去向归模型判断
			fauxAssistantMessage("她解衣取砚，磨墨奉上，一气呵成。"),
			(ctx: { messages?: unknown[] }) => {
				nudgeCtx = JSON.stringify(ctx.messages ?? []);
				return fauxAssistantMessage("");
			},
			fauxAssistantMessage(""), // 记账注入轮
			fauxScribeEmpty(),
		] as never);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("开始吧。");

		assert.ok(nudgeCtx.includes("正文已代收为 draft_write。需要改就重交，不需要就结束。"), "代收回执 = 一句认收（零验收，8/10）");
		assert.ok(!nudgeCtx.includes("验收"), "回执无验收字样");
		const branchText = JSON.stringify(sm.getBranch());
		assert.ok(branchText.includes("一气呵成"), "直出正文仍代收落树（不推倒）");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

// ---------------- P7：ask 工具（剧情共创决策） ----------------

test("ask：注入 askUser 才上清单；未注入则剔除（依赖缺失不上清单）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ tools?: Array<{ name: string }> }> = [];
		reg.setResponses([
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage("你好。");
			},
			fauxScribeEmpty(),
		]);
		const engine = makeEngine(cwd, sm, reg.getModel("faux-rp"));
		await engine.performTurn("开演。");
		const names = (ctxs[0].tools ?? []).map((t) => t.name);
		assert.ok(!names.includes("ask"), "未注入 askUser 时 ask 不上清单");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("ask：注入 askUser 时 ask 上清单", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: Array<{ tools?: Array<{ name: string }> }> = [];
		reg.setResponses([
			(ctx) => {
				ctxs.push(ctx as never);
				return fauxAssistantMessage("你好。");
			},
			fauxScribeEmpty(),
		]);
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => reg.getModel("faux-rp"),
			getAuth: async () => ({}),
			streamFn: streamSimple as unknown as StageStreamFn,
			askUser: async () => "好",
		});
		await engine.performTurn("开演。");
		const names = (ctxs[0].tools ?? []).map((t) => t.name);
		assert.ok(names.includes("ask"), "注入 askUser 后 ask 在清单");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("ask：作答回喂模型，计划据此重拟（P7 决策闭环；时机门禁已删，首轮直问即弹）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const asked: Array<{ q: string; opts: string[] }> = [];
		const responses: unknown[] = [];
		// 第 1 轮 ask（无稿）：D13 门禁已删——用户在求方向，模型直问，harness 不拦
		responses.push(
			fauxAssistantMessage([fauxToolCall("ask", { question: "你打算怎么处置这件事？", options: ["报官", "私了", "先按兵不动"] })], {
				stopReason: "toolUse",
			}),
		);
		responses.push(
			fauxAssistantMessage([fauxToolCall("beat_plan", { steps: ["先按兵不动", "暗中观察"] })], { stopReason: "toolUse" }),
		);
		responses.push(
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "我按住剑柄，退后半步。" })], { stopReason: "toolUse" }),
		);
		responses.push(fauxAssistantMessage([fauxToolCall("draft_seal", {})], { stopReason: "toolUse" }));
		responses.push(fauxAssistantMessage("")); // 记账注入轮
		responses.push(fauxScribeEmpty());
		reg.setResponses(responses as never);

		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => reg.getModel("faux-rp"),
			getAuth: async () => ({}),
			streamFn: streamSimple as unknown as StageStreamFn,
			askUser: async (q, opts) => {
				asked.push({ q, opts });
				return "先按兵不动";
			},
		});
		await engine.performTurn("她递来一封信。");

		assert.equal(asked.length, 1, "ask 首轮直达用户（无暂缓拦截）");
		assert.equal(asked[0]?.q, "你打算怎么处置这件事？");
		assert.deepEqual(asked[0]?.opts, ["报官", "私了", "先按兵不动"]);
		const { history } = rebuildHistory(sm.getBranch() as BranchEntryLike[]);
		assert.equal(history[history.length - 1].text, "我按住剑柄，退后半步。", "作答后按计划演出的正文定稿");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("ask：用户停止 → 本拍收束，已写正文不丢（引擎兜底封笔）", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const responses: unknown[] = [];
		responses.push(
			fauxAssistantMessage([fauxToolCall("draft_append", { segment: "第一段已经写好了。" })], { stopReason: "toolUse" }),
		);
		responses.push(
			fauxAssistantMessage([fauxToolCall("ask", { question: "接下来怎么办？", options: ["继续", "算了"] })], {
				stopReason: "toolUse",
			}),
		);
		reg.setResponses(responses as never);

		let ended: { aborted: boolean; entryId?: string; error?: string } | null = null;
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => reg.getModel("faux-rp"),
			getAuth: async () => ({}),
			streamFn: streamSimple as unknown as StageStreamFn,
			askUser: async () => undefined,
			events: { onTurnEnd: (info) => (ended = info) },
		});
		await engine.performTurn("你说话啊。");

		assert.ok(ended && !ended.aborted && ended.entryId, "有稿时仍落树定稿");
		const flat = JSON.stringify(sm.getBranch());
		assert.ok(flat.includes("第一段已经写好了"), "停止后已写的正文仍保留");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("进度行场面包投影（8/12 skill指导删除后）：包名投影按数据在场；无数据=纯事实", async () => {
	const { progressLine } = await import("../src/stage/engine.ts");
	const { createWorkspace } = await import("../src/stage/workspace.ts");
	const ws = createWorkspace();
	ws.draft = "她推门进院。";
	ws.appends = 1;
	const bare = progressLine(ws, { min: 500, max: 800 });
	assert.ok(bare.startsWith("【进度】"), "事实前缀");
	assert.ok(!bare.includes("skill指导") && !bare.includes("场面包"), "无数据零注入（零痕迹）");
	const withPacks = progressLine(ws, { min: 500, max: 800 }, ["情欲", "打斗"]);
	assert.ok(withPacks.includes("可读场面包：情欲 / 打斗"), "包名清单=数据投影");
	assert.ok(!withPacks.includes("skill_read"), "仅包名清单=被动投影，不含强制指令");
	assert.ok(withPacks.startsWith(bare.slice(0, bare.indexOf("。") + 1)), "事实前缀不因注入改变");
	// 必定读取（每轮）skill：进度行携带落笔前强制先读指令（复现 8/11「强制调用」，受理门配套）
	const withForced = progressLine(ws, { min: 500, max: 800 }, ["skill指导"], ["skill指导"]);
	assert.ok(withForced.includes("skill_read") && withForced.includes("skill指导"), "forcedSkills→落笔前强制先读指令");
});



test("引擎：输出合约 v1 声明步（M-R4 首件）——一次声明落数据、谢幕照单点名、指纹缓存零重复调用", async () => {
	const { cwd, sm } = makeStage();
	const reg = registerFauxProvider({ models: [{ id: "faux-rp" }] });
	try {
		const ctxs: string[] = [];
		const cap = (r: unknown) => (ctx: { messages?: unknown[] }) => {
			ctxs.push(JSON.stringify(ctx.messages ?? []));
			return r;
		};
		reg.setResponses([
			// 拍1 第一发＝装载声明（旁路窄上下文）：声明出识别器认不出的 options（此卡 v0 合约恒空）
			fauxAssistantMessage(
				'{"modules":[{"tag":"state1","source":"card","form":"pair","hint":"状态栏"},{"tag":"options","source":"card","form":"pair","hint":"行动选项"}]}',
			),
			cap(fauxAssistantMessage("云澜垂眸受了半礼。")),
			cap(fauxAssistantMessage("")), // 代收回执轮
			cap(fauxAssistantMessage("")), // 记账注入轮
			cap(fauxAssistantMessage("<state1>\n地点：山门\n</state1>\n<options>\n1. 上前\n</options>")), // 谢幕轮
			fauxScribeEmpty(),
			// 拍2：应答序列不含声明位——指纹命中缓存，引擎不得再发声明调用
			fauxAssistantMessage("第二拍正文。"),
			fauxAssistantMessage(""),
			fauxAssistantMessage(""),
			fauxAssistantMessage("<state1>\n地点：院内\n</state1>\n<options>\n1. 告辞\n</options>"),
			fauxScribeEmpty(),
		] as never);
		const engine = new StageEngine({
			cwd,
			getSessionManager: () => sm as never,
			getModel: () => reg.getModel("faux-rp") as never,
			getAuth: async () => ({}),
			streamFn: streamSimple as unknown as StageStreamFn,
			declareContract: true,
		});
		await engine.performTurn("我上前行礼。");

		// 声明落成数据：指纹缓存 + 用户可改合约文件（syncOutputContract 正常走）
		const declared = JSON.parse(readFileSync(join(cwd, ".liyuan", "output-contract.declared.json"), "utf8")) as {
			fingerprint: string;
			modules: Array<{ tag: string }>;
		};
		assert.deepEqual(declared.modules.map((m) => m.tag), ["state1", "options"]);
		const contract = JSON.parse(readFileSync(join(cwd, ".liyuan", "output-contract.json"), "utf8")) as {
			modules: Array<{ tag: string }>;
		};
		assert.deepEqual(contract.modules.map((m) => m.tag), ["state1", "options"]);

		// 谢幕注入照单点名（hint 是点名标签）
		const curtain = ctxs.map((t) => t).find((t) => t.includes("【谢幕】"));
		assert.ok(curtain, "谢幕注入在场（v0 时代此卡合约恒空、谢幕不发生）");
		assert.ok(curtain!.includes("`<state1>` 状态栏") && curtain!.includes("`<options>` 行动选项"), "照单点名");

		// 定稿含声明的两个块
		const tree1 = JSON.stringify(sm.getBranch());
		assert.ok(tree1.includes("<options>") && tree1.includes("上前"), "options 块入稿");

		await engine.performTurn("再走近一步。");
		const tree2 = JSON.stringify(sm.getBranch());
		assert.ok(tree2.includes("第二拍正文"), "拍2 走通＝没有多余的声明调用吃掉应答");
		assert.ok(tree2.includes("告辞"), "拍2 谢幕块照常");
	} finally {
		reg.unregister();
		rmSync(cwd, { recursive: true, force: true });
	}
});
