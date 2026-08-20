import assert from "node:assert/strict";
import { test } from "node:test";

import { applyPatch, defaultState } from "../src/state.ts";
import {
	completedNarrativeTurns,
	planRosterRefresh,
	runRosterRefresh,
} from "../src/stage/roster-refresh.ts";
import type { BranchEntryLike } from "../src/stage/assemble.ts";

const user = (id: string, text: string): BranchEntryLike => ({
	id,
	type: "message",
	message: { role: "user", content: [{ type: "text", text }] },
});
const assistant = (id: string, text: string, stopReason = "stop"): BranchEntryLike => ({
	id,
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }], stopReason },
});

const branchOf = (turns: number): BranchEntryLike[] => {
	const branch: BranchEntryLike[] = [
		{ id: "g", type: "custom_message", customType: "rp-greeting", content: "开场白" },
	];
	for (let i = 1; i <= turns; i++) branch.push(user(`u${i}`, `用户第 ${i} 拍`), assistant(`a${i}`, `正文第 ${i} 拍`));
	return branch;
};

test("名录刷新计数：只数完整叙事回复，不数开场白、错误拍和中断半拍", () => {
	const branch = branchOf(2);
	branch.push(user("u3", "第三拍"), assistant("a3", "未完成", "aborted"));
	branch.push(user("u4", "第四拍"), assistant("a4", "报错", "error"));
	assert.equal(completedNarrativeTurns(branch), 2);
});

test("名录刷新计划：满五拍触发；成功拍数随世界状态分支保存", () => {
	const state = applyPatch(defaultState(), { characters: { 苏茜: { status: "初登场" } } }).state;
	assert.equal(planRosterRefresh(branchOf(20), state, 0, "沈舟", "云澜"), null, "0 应关闭定拍刷新");
	assert.equal(planRosterRefresh(branchOf(4), state, 5, "沈舟", "云澜"), null);
	const due = planRosterRefresh(branchOf(5), state, 5, "沈舟", "云澜");
	assert.ok(due);
	assert.equal(due.completedTurns, 5);
	assert.equal(due.turnsSinceRefresh, 5);
	assert.ok(due.conversationText.includes("沈舟：用户第 5 拍"));

	state.rosterRefresh = { lastTurn: 5 };
	assert.equal(planRosterRefresh(branchOf(9), state, 5, "沈舟", "云澜"), null);
	assert.ok(planRosterRefresh(branchOf(10), state, 5, "沈舟", "云澜"));

	state.rosterRefresh = { lastTurn: 99 };
	assert.ok(planRosterRefresh(branchOf(5), state, 5, "沈舟", "云澜"), "未来拍数异常时应重建刷新基线");
});

test("名录刷新执行：更新已有简介、落分支快照并推进周期", async () => {
	const state = applyPatch(defaultState(), { characters: { 苏茜: { status: "初登场" } } }).state;
	const entries: typeof state[] = [];
	const activities: string[] = [];
	const result = await runRosterRefresh(
		{
			sideText: async () => '{"roster":{"characters":{"苏茜":"与沈舟结盟，负伤留守山门","陌生人":"不得新增"}}}',
			appendStateEntry: (next) => entries.push(next),
			getLeafId: () => "leaf-5",
			onActivity: (detail) => activities.push(detail),
		},
		{ branch: branchOf(5), state, everyNTurns: 5, charName: "云澜", userName: "沈舟" },
	);
	assert.equal(result.kind, "refreshed");
	assert.equal(entries.length, 1);
	assert.equal(entries[0].roster?.characters["苏茜"], "与沈舟结盟，负伤留守山门");
	assert.ok(!("陌生人" in (entries[0].roster?.characters ?? {})));
	assert.deepEqual(entries[0].rosterRefresh, { lastTurn: 5 });
	assert.ok(activities.some((line) => line.includes("已刷新")));
});

test("名录刷新执行：失败不推进周期，下一拍仍然到期", async () => {
	const state = applyPatch(defaultState(), { characters: { 苏茜: { status: "初登场" } } }).state;
	const result = await runRosterRefresh(
		{
			sideText: async () => "不是 JSON",
			appendStateEntry: () => assert.fail("失败不得落快照"),
			getLeafId: () => "leaf-5",
		},
		{ branch: branchOf(5), state, everyNTurns: 5, charName: "云澜", userName: "沈舟" },
	);
	assert.equal(result.kind, "failed");
	assert.equal(state.rosterRefresh, undefined);
	assert.ok(planRosterRefresh(branchOf(6), state, 5, "沈舟", "云澜"), "第六拍应继续尝试");
});

test("名录刷新执行：旁路期间切分支则丢弃", async () => {
	const state = applyPatch(defaultState(), { characters: { 苏茜: { status: "初登场" } } }).state;
	let reads = 0;
	const result = await runRosterRefresh(
		{
			sideText: async () => '{"roster":{}}',
			appendStateEntry: () => assert.fail("过期结果不得落树"),
			getLeafId: () => (++reads === 1 ? "old" : "new"),
		},
		{ branch: branchOf(5), state, everyNTurns: 5, charName: "云澜", userName: "沈舟" },
	);
	assert.equal(result.kind, "stale");
});
