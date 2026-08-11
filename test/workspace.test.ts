import assert from "node:assert/strict";
import { test } from "node:test";

import { emptyDraftRules } from "../src/draft.ts";
import { defaultState } from "../src/state.ts";
import {
	createWorkspace,
	finalTimeline,
	formatPlan,
	MAX_STEPS,
	MAX_STEP_LEN,
	projectedState,
	recordSegment,
	runWriteTool,
	type WorkspaceDeps,
} from "../src/stage/workspace.ts";
import { writeTools } from "../src/stage/tools.ts";

const deps = (): WorkspaceDeps => ({
	rules: emptyDraftRules(),
	userName: "凌云",
	charName: "林霜",
	baseState: defaultState(),
});

test("writeTools：写侧十件在清单里，beat_plan 列首为落笔前构思、draft_edit 声明批量原子", () => {
	const names = writeTools("中文").map((t) => t.name);
	// 顺序本身就是导流：先构思成清单（beat_plan），再一段一段演（append 在 write 之前）
	assert.deepEqual(names, [
		"beat_plan",
		"beat_step_done",
		"draft_append",
		"draft_write",
		"draft_seal",
		"draft_edit",
		"draft_read",
		"draft_search",
		"world_state_update",
		"ask",
	]);
	const byName = new Map(writeTools("中文").map((t) => [t.name, t.description]));
	assert.match(byName.get("draft_write") ?? "", /全量/);
	// draft_write 收窄为「这一拍没有戏」，描述须自证其适用面
	assert.match(byName.get("draft_write") ?? "", /没有戏|寒暄/);
	assert.match(byName.get("draft_append") ?? "", /追加|续写/);
	assert.match(byName.get("draft_seal") ?? "", /封笔/);
	assert.match(byName.get("draft_edit") ?? "", /整批不套用/);
	// beat_plan 的描述必须自证「路标是抽象层，怎么演留给各段」——粒度是这个工具的全部价值
	assert.match(byName.get("beat_plan") ?? "", /路标/);
	assert.match(byName.get("beat_plan") ?? "", /抽象/);
	assert.match(byName.get("beat_plan") ?? "", /怎么演.*再想|留给演到/);
	// 计划是草图：描述须声明可改写，否则模型会把它当成必须演完的剧本
	assert.match(byName.get("beat_plan") ?? "", /草图|改写/);
});

test("beat_plan：受理回执一句事实（§2.4）；重拟保留已勾条目的进度", () => {
	const ws = createWorkspace();
	const d = deps();
	const r = runWriteTool(ws, d, "beat_plan", {
		steps: ["推门进院", "被值守弟子拦下", "亮出师门信物"],
	});
	assert.equal(r.ok, true);
	assert.equal(ws.plan.length, 3);
	assert.equal(ws.planWrites, 1);
	assert.ok(ws.plan.every((s) => !s.done), "新计划默认全未完成");
	assert.equal(r.text, "计划已接受（3 条路标）。", "受理回执 = 契约文案，无清单回显无教学");

	runWriteTool(ws, d, "beat_step_done", { step: 1 });
	// 重拟：走岔了改写后两条，但已经演过的第一条不该因此丢掉进度
	const again = runWriteTool(ws, d, "beat_plan", {
		steps: ["推门进院", "院里空无一人", "听见后堂有响动"],
	});
	assert.equal(again.ok, true);
	assert.equal(ws.planWrites, 2);
	assert.equal(ws.plan[0]?.done, true, "文字未变的已完成步保留勾选");
	assert.equal(ws.plan[1]?.done, false, "改写出来的新步未完成");
	assert.match(again.activity ?? "", /重拟/, "重拟只进过程条，回执不变");
});

test("beat_plan 粒度门禁：条目写成正文即拒收（构思与排练的结构性分界）", () => {
	const ws = createWorkspace();
	const d = deps();
	const prose = "她推开院门，晨雾还没散尽，青石板上凝着一层薄薄的水汽，脚步踩上去几乎没有声音，" +
		"远处传来隐约的诵经声，像是从很久以前的时光里飘过来的。";
	assert.ok(prose.length > MAX_STEP_LEN, "用例前提：这条确实超长");
	const r = runWriteTool(ws, d, "beat_plan", { steps: ["推门进院", prose] });
	assert.equal(r.ok, false, "计划里写正文必须走不通");
	assert.equal(ws.plan.length, 0, "拒收即一条不记");
	assert.match(r.text, new RegExp(`${MAX_STEP_LEN}`), "回喂说明粒度上限");
	assert.doesNotMatch(r.text, /发生什么|留给/, "拒收回执只留事实＋动作，通道契约在工具描述里（P4）");

	// 条数上限：一拍是一小段戏，不是整章大纲
	const many = Array.from({ length: MAX_STEPS + 1 }, (_, i) => `第${i + 1}步`);
	const tooMany = runWriteTool(ws, d, "beat_plan", { steps: many });
	assert.equal(tooMany.ok, false);
	assert.match(tooMany.text, new RegExp(`最多 ${MAX_STEPS} 条`));

	// 非数组 / 空数组都拒收，且不抛
	assert.equal(runWriteTool(ws, d, "beat_plan", { steps: [] }).ok, false);
	assert.equal(runWriteTool(ws, d, "beat_plan", {}).ok, false);
});

test("beat_step_done：按序号勾掉并回报剩余；越界/重复勾/无计划都拒收", () => {
	const ws = createWorkspace();
	const d = deps();
	assert.equal(runWriteTool(ws, d, "beat_step_done", { step: 1 }).ok, false, "没有计划时无从勾起");

	runWriteTool(ws, d, "beat_plan", { steps: ["推门进院", "被弟子拦下"] });
	const ok = runWriteTool(ws, d, "beat_step_done", { step: 1 });
	assert.equal(ok.ok, true);
	assert.equal(ws.plan[0]?.done, true);
	assert.match(ok.text, /还剩 1 条/);

	assert.equal(runWriteTool(ws, d, "beat_step_done", { step: 1 }).ok, false, "重复勾拒收");
	assert.equal(runWriteTool(ws, d, "beat_step_done", { step: 9 }).ok, false, "越界拒收");
	assert.equal(runWriteTool(ws, d, "beat_step_done", {}).ok, false, "缺参数拒收");

	// 全部勾完：回执仍只报事实（进度/判定由轮次注入承载，回执不抢注入的活）
	const last = runWriteTool(ws, d, "beat_step_done", { step: 2 });
	assert.equal(last.ok, true);
	assert.match(last.text, /还剩 0 条/);
	assert.doesNotMatch(last.text, /接着演|draft_append/, "勾完不催段");
	assert.doesNotMatch(last.text, /ask|收笔前/, "回执不带评估导向");
});

test("draft_append 回执一句事实（§2.4 瘦身）：无字数读数、无评估导向、无验收报告", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "beat_plan", { steps: ["推门进院", "被弟子拦下"] });
	const r = runWriteTool(ws, d, "draft_append", { segment: "她推开院门，晨雾还没散尽。" });
	assert.equal(r.ok, true);
	assert.equal(r.text, "已续写（第 1 段）。", "回执 = 一句事实");
	assert.ok(!/\d+ 字/.test(r.activity ?? ""), "过程条也不报字数");

	// 定点改稿回执同样只留事实（改动明细），不附验收报告
	const e = runWriteTool(ws, d, "draft_edit", { edits: [{ old: "晨雾", new: "薄雾" }] });
	assert.equal(e.ok, true);
	assert.match(e.text, /已改 1 处/);
	assert.doesNotMatch(e.text, /验收/, "改稿回执不再附验收报告——事实在 seal 回执可见");

	// 封笔是验收场合：事实报告在此给出
	const sealed = runWriteTool(ws, d, "draft_seal", {});
	assert.equal(sealed.ok, true);
	assert.equal(ws.sealed, true);
	assert.doesNotMatch(sealed.text, /\d+ 字|目标/, "封笔回执零测量值（8/10 去数字化）");
});

test("formatPlan：空计划有可读兜底，混合状态各按其形渲染", () => {
	assert.match(formatPlan([]), /还没有计划/);
	const rendered = formatPlan([
		{ text: "推门进院", done: true },
		{ text: "被弟子拦下", done: false },
	]);
	assert.match(rendered, /1\. ☑ ~~推门进院~~/);
	assert.match(rendered, /2\. □ 被弟子拦下/);
});

test("draft_write：收稿落工作区（验收已退役，回执只认收）；空 content 拒收", () => {
	const ws = createWorkspace();
	const d = deps();
	const bad = runWriteTool(ws, d, "draft_write", { content: "  " });
	assert.equal(bad.ok, false);
	assert.equal(ws.writes, 0);

	const r = runWriteTool(ws, d, "draft_write", { content: "山门外的雪落了一夜。" });
	assert.equal(r.ok, true);
	assert.equal(ws.draft, "山门外的雪落了一夜。");
	assert.equal(ws.writes, 1);
	assert.match(r.text, /已收稿（第 1 稿/);
});

test("draft_write 门禁：查过世界＝这拍有戏，一次交完被拒收并导向 draft_append", () => {
	const ws = createWorkspace();
	const d = deps();
	ws.lookups = 2; // 引擎在读侧工具执行后打点（lorebook / memory / world_state_get）

	const r = runWriteTool(ws, d, "draft_write", { content: "山门外的雪落了一夜。" });
	assert.equal(r.ok, false, "拒收而不是放行后再劝");
	assert.equal(ws.draft, "", "拒收不留痕：稿子没被写进去");
	assert.equal(ws.writes, 0);
	assert.match(r.text, /draft_append/, "把正确的路回喂给模型");
	assert.match(r.text, /查过 2 次世界/, "回喂里带上判据本身");
});

test("draft_write 门禁：没查过世界（寒暄拍）照常收稿", () => {
	const ws = createWorkspace();
	const r = runWriteTool(ws, deps(), "draft_write", { content: "山门外的雪落了一夜。" });
	assert.equal(r.ok, true);
	assert.equal(ws.writes, 1);
});

test("draft_write 门禁：writing_guide 不计入 lookups，故读过方法论仍可一次交完", () => {
	// lookups 只认「查世界」；读写作方法论不是遇到了要处理的事
	const ws = createWorkspace();
	assert.equal(ws.lookups, 0, "新工作区从 0 起");
	const r = runWriteTool(ws, deps(), "draft_write", { content: "山门外的雪落了一夜。" });
	assert.equal(r.ok, true);
});

test("draft_write 门禁：续写到一半改用全量重交不拦（另有 draft_edit 的劝导）", () => {
	const ws = createWorkspace();
	const d = deps();
	ws.lookups = 1;
	runWriteTool(ws, d, "draft_append", { segment: "第一段。" });
	const r = runWriteTool(ws, d, "draft_write", { content: "整篇重写过的正文。" });
	assert.equal(r.ok, true, "appends>0 时门禁让路");
	assert.equal(ws.draft, "整篇重写过的正文。");
});

test("draft_write 门禁：internal 代收绕过门禁——兜底路径不能把正文丢掉", () => {
	// 宽进严出：模型直出正文由引擎代收为 draft_write。被门禁拦下就等于这拍白演。
	const ws = createWorkspace();
	ws.lookups = 3;
	const r = runWriteTool(ws, deps(), "draft_write", { content: "直出的正文。" }, true);
	assert.equal(r.ok, true);
	assert.equal(ws.draft, "直出的正文。");
});

// ---------------- M-E：draft_append / draft_seal（分段续写） ----------------

const minRules = (): WorkspaceDeps => ({
	...deps(),
	rules: { ...emptyDraftRules(), wordRange: { min: 800, max: 2000 } },
});

test("draft_append：追加不覆盖；封笔前无验收报告，封笔后事实可见（M-R1 事实化）", () => {
	const ws = createWorkspace();
	const d = minRules();
	// 第一段只有几十字——字数目标 800 起，但回执不做任何评价
	const r1 = runWriteTool(ws, d, "draft_append", { segment: "山门外雪落了一夜。他推门进屋，炉火将熄。" });
	assert.equal(r1.ok, true);
	assert.equal(ws.draft, "山门外雪落了一夜。他推门进屋，炉火将熄。");
	assert.equal(ws.appends, 1);
	assert.equal(ws.sealed, false);
	assert.equal(r1.text, "已续写（第 1 段）。");
	// 追加第二段：不覆盖，续在末尾
	runWriteTool(ws, d, "draft_append", { segment: "她还在窗边坐着，像在等什么。" });
	assert.ok(ws.draft.includes("山门外雪落了一夜。"));
	assert.ok(ws.draft.includes("她还在窗边坐着"));
	assert.equal(ws.appends, 2);
	// 封笔：零测量值（去数字化）——字数与目标都不回传，验收只留发现事实
	const r3 = runWriteTool(ws, d, "draft_seal", {});
	assert.equal(ws.sealed, true);
	assert.match(r3.text, /已封笔/);
	assert.doesNotMatch(r3.text, /\d+ 字|目标 800/, "字数与目标不回传（8/10 去数字化）");
	assert.doesNotMatch(r3.text, /待修|违规|修正/, "验收恒为事实陈述（P2）");
});

test("draft_append：追加进时间线是追加段（draft=true），不塌成替换", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_append", { segment: "第一段。" });
	runWriteTool(ws, d, "draft_append", { segment: "第二段。" });
	const draftSegs = ws.timeline.filter((s) => s.kind === "text" && s.draft === true);
	assert.equal(draftSegs.length, 2, "两段续写应为两个独立稿段");
	assert.equal((draftSegs[0] as { text: string }).text, "第一段。");
	assert.equal((draftSegs[1] as { text: string }).text, "第二段。");
});

test("draft_append：续写后 draft_edit 改一处，时间线保持分段不塌成一整块", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_append", { segment: "山门外的雪落了一夜。" });
	runWriteTool(ws, d, "draft_append", { segment: "他推门进屋，炉火将熄。" });
	const r = runWriteTool(ws, d, "draft_edit", { edits: [{ old: "推门进屋", new: "推门进了屋" }] });
	assert.equal(r.ok, true);
	assert.equal(ws.edits, 1);
	const segs = ws.timeline.filter((s) => s.kind === "text" && s.draft === true);
	assert.equal(segs.length, 2, "改稿后仍是两个稿段（分段形态不塌）");
});

test("finalTimeline：分段同构——稿段原位保留，尾巴收独立末段（8/09 输出形式）", () => {
	const ws = createWorkspace();
	const d = deps();
	recordSegment(ws, { kind: "thinking", text: "构思第一段。" });
	runWriteTool(ws, d, "draft_append", { segment: "第一段。" });
	recordSegment(ws, { kind: "thinking", text: "构思第二段。" });
	runWriteTool(ws, d, "draft_append", { segment: "第二段。" });
	// 尾巴（状态栏）流式记档：非稿 text，不得黏进稿段
	recordSegment(ws, { kind: "text", text: "<StatusBlock>地点：山门</StatusBlock>" });
	const finalText = `${ws.draft}\n\n<StatusBlock>地点：山门</StatusBlock>`;
	const tl = finalTimeline(ws, finalText);
	const textSegs = tl.filter((s): s is Extract<(typeof tl)[number], { kind: "text" }> => s.kind === "text");
	assert.equal(textSegs.length, 3, "两个稿段 + 一个尾巴段");
	assert.equal(textSegs[0].text, "第一段。");
	assert.equal(textSegs[0].draft, true);
	assert.equal(textSegs[1].text, "第二段。");
	assert.equal(textSegs[1].draft, true);
	assert.ok(textSegs[2].text.includes("StatusBlock"), "尾巴独立末段");
	assert.notEqual(textSegs[2].draft, true, "尾巴段不带 draft 标记");
	// 内容一致：稿段拼接 + 尾巴 = finalText
	assert.equal([textSegs[0].text, textSegs[1].text].join("\n\n") + "\n\n" + textSegs[2].text, finalText);
});

test("finalTimeline：无稿（直出路径）回退单段全文", () => {
	const ws = createWorkspace();
	recordSegment(ws, { kind: "thinking", text: "直接说。" });
	recordSegment(ws, { kind: "text", text: "你好。" });
	const tl = finalTimeline(ws, "你好。");
	const textSegs = tl.filter((s) => s.kind === "text");
	assert.equal(textSegs.length, 1, "直出路径仍是单段");
	assert.equal((textSegs[0] as { text: string }).text, "你好。");
});

test("draft_seal：回执不点名状态栏——格式块点名唯一归谢幕注入（M-R1 §2.3）", () => {
	const ws = createWorkspace();
	const d = deps();
	d.rules.statusBarTagGroup = ["StatusBlock"];
	runWriteTool(ws, d, "draft_append", { segment: "他推门进屋，炉火将熄。" });
	const r = runWriteTool(ws, d, "draft_seal", {});
	assert.match(r.text, /已封笔/);
	assert.doesNotMatch(r.text, /状态栏|StatusBlock|最后一步/, "状态栏点名从 seal 回执退场（七处催告之一）");
	assert.doesNotMatch(r.text, /\d+ 字/, "回执零测量值");
});


test("seal 回执补认稿外直出（8/10）：ws.strayText 非空时以事实一行出现，空则不提", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_append", { segment: "出租车在酒店门口停下。" });
	ws.strayText = "收到定位，她只回了两个字。然后起身换衣。";
	const sealed = runWriteTool(ws, d, "draft_seal", {});
	assert.match(sealed.text, /直出不在稿内/, "稿外直出是事实");
	assert.match(sealed.text, /起头「收到定位/, "带起头引文供模型辨认");
	assert.doesNotMatch(sealed.text, /补进|draft_edit|必须/, "只报事实，处置归模型");

	const ws2 = createWorkspace();
	runWriteTool(ws2, d, "draft_append", { segment: "正文一段。" });
	const sealed2 = runWriteTool(ws2, d, "draft_seal", {});
	assert.doesNotMatch(sealed2.text, /直出/, "无稿外直出则只字不提");
});

test("draft_seal：空工作区封笔被拒", () => {
	const ws = createWorkspace();
	const r = runWriteTool(ws, deps(), "draft_seal", {});
	assert.equal(r.ok, false);
	assert.match(r.text, /draft_write|draft_append/);
});

test("draft_seal：封笔后 draft_edit 仍可改（封笔≠锁稿，改完再验）", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_append", { segment: "山门外的雪落了一夜。" });
	runWriteTool(ws, d, "draft_append", { segment: "她还在窗边。" });
	runWriteTool(ws, d, "draft_seal", {});
	assert.equal(ws.sealed, true);
	const r = runWriteTool(ws, d, "draft_edit", { edits: [{ old: "窗边", new: "廊下" }] });
	assert.equal(r.ok, true);
	assert.ok(ws.draft.includes("廊下"));
});

test("draft_write：全量替换语义——第二稿覆盖第一稿", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "第一稿。" });
	runWriteTool(ws, d, "draft_write", { content: "第二稿。" });
	assert.equal(ws.draft, "第二稿。");
	assert.equal(ws.writes, 2);
});


test("world_state_update：只验不改——合格入队，定稿前基准账本不动", () => {
	const ws = createWorkspace();
	const d = deps();
	const r = runWriteTool(ws, d, "world_state_update", {
		patch: { location: "藏经阁", characters: { 林霜: { affinity: 35 } } },
	});
	assert.equal(r.ok, true);
	assert.match(r.text, /已记账（定稿后生效）/);
	assert.equal(ws.patches.length, 1);
	assert.equal(d.baseState.location, ""); // 基准未被改动
	const proj = projectedState(ws, d.baseState);
	assert.equal(proj.location, "藏经阁");
	assert.equal(proj.characters["林霜"].affinity, 35);
});

test("world_state_update：非法 patch 拒收（非对象 / 全字段无效）", () => {
	const ws = createWorkspace();
	const d = deps();
	assert.equal(runWriteTool(ws, d, "world_state_update", { patch: "藏经阁" }).ok, false);
	assert.equal(runWriteTool(ws, d, "world_state_update", { patch: [1] }).ok, false);
	const r = runWriteTool(ws, d, "world_state_update", { patch: { time: 42 } });
	assert.equal(r.ok, false);
	assert.match(r.text, /记账被拒/);
	assert.equal(ws.patches.length, 0);
});

test("world_state_update：角色键在投影上归一（大小写变体不裂成两人）", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "world_state_update", { patch: { characters: { Alice: { affinity: 10 } } } });
	runWriteTool(ws, d, "world_state_update", { patch: { characters: { "alice ": { status: "警惕" } } } });
	const proj = projectedState(ws, d.baseState);
	assert.deepEqual(Object.keys(proj.characters), ["Alice"]);
	assert.equal(proj.characters.Alice.affinity, 10);
	assert.equal(proj.characters.Alice.status, "警惕");
});

test("未知写侧工具名：可读文本，不抛", () => {
	const ws = createWorkspace();
	const r = runWriteTool(ws, deps(), "draft_fly", {});
	assert.equal(r.ok, false);
	assert.match(r.text, /未知写侧工具/);
});

// ---------------- M-B：draft_edit / draft_read / draft_search ----------------

test("draft_edit：无稿时拒绝——改稿之前必须先落笔（两种写法都指路）", () => {
	const ws = createWorkspace();
	const r = runWriteTool(ws, deps(), "draft_edit", { edits: [{ old: "甲", new: "乙" }] });
	assert.equal(r.ok, false);
	assert.equal(ws.edits, 0);
	assert.match(r.text, /draft_append/);
	assert.match(r.text, /draft_write/);
});

test("draft_edit：多处定点替换一次套用，稿次不增而 edits 增；回执只留改动明细", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "他推开门。屋里很暗。她抬起头。" });
	const r = runWriteTool(ws, d, "draft_edit", {
		edits: [
			{ old: "他推开门。", new: "他一把推开门。" },
			{ old: "她抬起头。", new: "她缓缓抬起头。" },
		],
	});
	assert.equal(r.ok, true);
	assert.equal(ws.draft, "他一把推开门。屋里很暗。她缓缓抬起头。");
	assert.equal(ws.edits, 1);
	assert.equal(ws.writes, 1, "定点改稿不算新稿次");
	assert.match(r.text, /已改 2 处/);
});

test("draft_edit：批量原子——任一处定位失败则整批不改", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "他推开门。屋里很暗。" });
	const before = ws.draft;
	const r = runWriteTool(ws, d, "draft_edit", {
		edits: [
			{ old: "他推开门。", new: "他一把推开门。" },
			{ old: "根本不存在的句子", new: "X" },
		],
	});
	assert.equal(r.ok, false);
	assert.equal(ws.draft, before, "第一处也不能落笔");
	assert.equal(ws.edits, 0);
	assert.match(r.text, /整批未套用/);
	assert.match(r.text, /根本不存在的句子/, "回显模型自己声称的 old");
});

test("draft_edit：old 不唯一时拒绝并要求扩大引用范围", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "她笑了。他也笑了。" });
	const r = runWriteTool(ws, d, "draft_edit", { edits: [{ old: "笑了", new: "哭了" }] });
	assert.equal(r.ok, false);
	assert.match(r.text, /2 处/);
	assert.match(r.text, /唯一/);
});

test("draft_edit：中文标点变体按归一命中，并回报命中级别", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "他说：“走吧。”然后转身。" });
	// 模型用直角引号引用——归一后应命中
	const r = runWriteTool(ws, d, "draft_edit", { edits: [{ old: "「走吧。」", new: "「再等等。」" }] });
	assert.equal(r.ok, true);
	assert.equal(ws.draft, "他说：「再等等。」然后转身。", "下标映射回原文必须精确");
	assert.match(r.text, /标点归一/, "非精确命中要告知模型");
});

test("draft_search：命中给上下文引用；多处命中提示 old 需唯一", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "她笑了。风很大。他也笑了。" });
	const one = runWriteTool(ws, d, "draft_search", { query: "风很大" });
	assert.equal(one.ok, true);
	assert.match(one.text, /命中 1 处/);

	const many = runWriteTool(ws, d, "draft_search", { query: "笑了" });
	assert.match(many.text, /命中 2 处/);
	assert.match(many.text, /必须唯一/);

	const none = runWriteTool(ws, d, "draft_search", { query: "不存在" });
	assert.match(none.text, /找不到/);
});

test("draft_read：回现稿全文，零测量值（8/10 验收退役）", () => {
	const ws = createWorkspace();
	const d = deps();
	runWriteTool(ws, d, "draft_write", { content: "山门外落了一夜雪。<StatusBlock>地点：山门</StatusBlock>" });
	const r = runWriteTool(ws, d, "draft_read", {});
	assert.equal(r.ok, true);
	assert.match(r.text, /山门外落了一夜雪/);
	assert.doesNotMatch(r.text, /\d+ 字/, "回执不带任何字数");
});
