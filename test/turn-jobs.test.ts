import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TurnJobManager, type TurnJobRunResult, type TurnJobSnapshot } from "../server/turn-jobs.ts";

const waitFor = async (done: () => boolean): Promise<void> => {
	for (let i = 0; i < 100; i += 1) {
		if (done()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("等待剧情任务状态超时");
};

test("TurnJobManager：提交立即返回、同 requestId 幂等、完成后持久化", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-turn-jobs-"));
	let release!: (result: TurnJobRunResult) => void;
	const gate = new Promise<TurnJobRunResult>((resolve) => {
		release = resolve;
	});
	const changes: TurnJobSnapshot[] = [];
	const manager = new TurnJobManager({
		dir,
		persistDelayMs: 0,
		id: () => "job-1",
		run: async () => gate,
		onChange: (job) => changes.push(job),
	});
	try {
		const first = manager.enqueue({
			clientRequestId: "req-1",
			sessionId: "session-1",
			text: "继续演。",
		});
		const duplicate = manager.enqueue({
			clientRequestId: "req-1",
			sessionId: "session-1",
			text: "不会重复。",
		});
		assert.equal(duplicate.id, first.id);
		await waitFor(() => manager.get(first.id)?.status === "running");
		assert.equal(manager.hasPending, true);

		release({ aborted: false, entryId: "entry-1" });
		await waitFor(() => manager.get(first.id)?.status === "completed");
		assert.equal(manager.get(first.id)?.resultEntryId, "entry-1");
		assert.deepEqual(
			changes.map((job) => job.status),
			["queued", "running", "completed"],
		);
		const disk = JSON.parse(readFileSync(join(dir, "job-1.json"), "utf8")) as TurnJobSnapshot;
		assert.equal(disk.status, "completed");
	} finally {
		manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("TurnJobManager：实时稿件可重同步，清场只丢过程旁白", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-turn-live-"));
	let release!: (result: TurnJobRunResult) => void;
	const gate = new Promise<TurnJobRunResult>((resolve) => {
		release = resolve;
	});
	const manager = new TurnJobManager({
		dir,
		persistDelayMs: 0,
		id: () => "job-live",
		run: async () => gate,
	});
	try {
		manager.enqueue({ clientRequestId: "req-live", sessionId: "session-1", text: "开演。" });
		await waitFor(() => manager.active?.status === "running");
		manager.appendDelta("thinking", "先判断局势。");
		manager.appendDelta("text", "过程旁白");
		manager.clearStream();
		manager.appendActivity({ kind: "note", name: "stage", detail: "已列计划" });
		manager.appendDelta("text", "第一段", true, false);
		manager.appendDelta("text", "续写", true, false);
		manager.resyncDraft(["修好的第一段", "第二段"]);

		assert.deepEqual(manager.active?.live.segments, [
			{ kind: "thinking", text: "先判断局势。" },
			{ kind: "tool", activities: [{ kind: "note", name: "stage", detail: "已列计划" }] },
			{ kind: "text", text: "修好的第一段", draft: true },
			{ kind: "text", text: "第二段", draft: true },
		]);
		release({ aborted: true });
		await waitFor(() => manager.get("job-live")?.status === "cancelled");
	} finally {
		manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("TurnJobManager：后台重启把运行中任务标为 interrupted，不自动重复执行", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-turn-recover-"));
	const now = Date.now();
	const snapshot: TurnJobSnapshot = {
		id: "job-old",
		clientRequestId: "req-old",
		sessionId: "session-1",
		input: "不要重复执行",
		status: "running",
		revision: 4,
		createdAt: now - 1000,
		updatedAt: now - 500,
		live: { segments: [{ kind: "text", text: "已生成一半", draft: true }] },
	};
	writeFileSync(join(dir, "job-old.json"), JSON.stringify(snapshot), "utf8");
	let runs = 0;
	const manager = new TurnJobManager({
		dir,
		persistDelayMs: 0,
		run: async () => {
			runs += 1;
			return { aborted: false };
		},
	});
	try {
		assert.equal(manager.get("job-old")?.status, "interrupted");
		assert.match(manager.get("job-old")?.error ?? "", /重新生成/);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(runs, 0);
	} finally {
		manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("TurnJobManager：后台重启可继续尚未开演且仍绑定当前会话的排队任务", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-turn-queued-"));
	const now = Date.now();
	const snapshot: TurnJobSnapshot = {
		id: "job-queued",
		clientRequestId: "req-queued",
		sessionId: "session-1",
		input: "排队后继续",
		status: "queued",
		revision: 1,
		createdAt: now,
		updatedAt: now,
		live: { segments: [] },
	};
	writeFileSync(join(dir, "job-queued.json"), JSON.stringify(snapshot), "utf8");
	let input = "";
	const manager = new TurnJobManager({
		dir,
		persistDelayMs: 0,
		canRun: (job) => job.sessionId === "session-1",
		run: async (job) => {
			input = job.input;
			return { aborted: false, entryId: "entry-queued" };
		},
	});
	try {
		await waitFor(() => manager.get("job-queued")?.status === "completed");
		assert.equal(input, "排队后继续");
		assert.equal(manager.get("job-queued")?.resultEntryId, "entry-queued");
	} finally {
		manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("TurnJobManager：等待选择可恢复 running，取消后晚到完成结果不会覆盖 cancelled", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-turn-choice-"));
	let release!: (result: TurnJobRunResult) => void;
	const gate = new Promise<TurnJobRunResult>((resolve) => {
		release = resolve;
	});
	const manager = new TurnJobManager({
		dir,
		persistDelayMs: 0,
		id: () => "job-choice",
		run: async () => gate,
	});
	try {
		manager.enqueue({ clientRequestId: "req-choice", sessionId: "session-1", text: "走哪边？" });
		await waitFor(() => manager.active?.status === "running");
		manager.waitingForInput();
		assert.equal(manager.active?.status, "waiting_input");
		manager.resumeAfterInput();
		assert.equal(manager.active?.status, "running");
		manager.cancelActive();
		release({ aborted: false, entryId: "late-entry" });
		await waitFor(() => manager.active === null);
		assert.equal(manager.get("job-choice")?.status, "cancelled");
		assert.equal(manager.get("job-choice")?.resultEntryId, undefined);
	} finally {
		manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("TurnJobManager：会话恢复优先展示运行中任务，不被后到排队项遮住", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-turn-latest-"));
	let release!: (result: TurnJobRunResult) => void;
	const gate = new Promise<TurnJobRunResult>((resolve) => {
		release = resolve;
	});
	let seq = 0;
	const manager = new TurnJobManager({
		dir,
		persistDelayMs: 0,
		id: () => `job-${++seq}`,
		run: async () => gate,
	});
	try {
		const first = manager.enqueue({ clientRequestId: "req-1", sessionId: "session-1", text: "第一拍" });
		await waitFor(() => manager.active?.id === first.id);
		const second = manager.enqueue({ clientRequestId: "req-2", sessionId: "session-1", text: "第二拍" });
		assert.equal(manager.get(second.id)?.status, "queued");
		assert.equal(manager.latestForSession("session-1")?.id, first.id);
		manager.cancelActive();
		release({ aborted: true });
		await waitFor(() => !manager.hasPending);
	} finally {
		manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("TurnJobManager：尚未开演的 queued 任务可按 id 取消，永不进入 runner", async () => {
	const dir = mkdtempSync(join(tmpdir(), "liyuan-turn-cancel-queued-"));
	let runs = 0;
	const manager = new TurnJobManager({
		dir,
		persistDelayMs: 0,
		id: () => "job-queued-cancel",
		canRun: () => false,
		run: async () => {
			runs += 1;
			return { aborted: false };
		},
	});
	try {
		const job = manager.enqueue({ clientRequestId: "req-cancel", sessionId: "session-1", text: "别开演" });
		assert.equal(manager.cancel(job.id)?.status, "cancelled");
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(runs, 0);
		assert.equal(manager.hasPending, false);
	} finally {
		manager.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});
