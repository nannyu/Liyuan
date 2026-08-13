/**
 * 剧情生成任务协调器。
 *
 * 浏览器只负责提交与观察；任务、排队和实时快照由 Web 宿主持有。这样 WS
 * 断开不会取消生成，重连后也能从服务端快照恢复当前稿件。任务元数据原子
 * 落盘，后台重启时不会把半截任务误报成仍在运行。
 */

import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type TurnJobStatus =
	| "queued"
	| "running"
	| "waiting_input"
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export interface TurnJobActivity {
	kind: "tool_start" | "tool_end" | "note";
	name: string;
	detail?: string;
	isError?: boolean;
}

export type TurnJobSegment =
	| { kind: "thinking"; text: string }
	| { kind: "text"; text: string; draft?: boolean }
	| { kind: "tool"; activities: TurnJobActivity[] };

export interface TurnJobSnapshot {
	id: string;
	clientRequestId: string;
	sessionId: string;
	sessionFile?: string;
	input: string;
	status: TurnJobStatus;
	revision: number;
	createdAt: number;
	updatedAt: number;
	live: {
		segments: TurnJobSegment[];
	};
	resultEntryId?: string;
	error?: string;
}

export interface TurnJobRunResult {
	aborted: boolean;
	entryId?: string;
	error?: string;
}

export interface TurnJobManagerOptions {
	dir: string;
	run: (job: TurnJobSnapshot) => Promise<TurnJobRunResult>;
	canRun?: (job: TurnJobSnapshot) => boolean;
	onChange?: (job: TurnJobSnapshot) => void;
	now?: () => number;
	id?: () => string;
	persistDelayMs?: number;
}

const ACTIVE = new Set<TurnJobStatus>(["queued", "running", "waiting_input"]);
const TERMINAL = new Set<TurnJobStatus>(["completed", "failed", "cancelled", "interrupted"]);

const cloneActivity = (a: TurnJobActivity): TurnJobActivity => ({ ...a });
const cloneSegment = (s: TurnJobSegment): TurnJobSegment =>
	s.kind === "tool" ? { kind: "tool", activities: s.activities.map(cloneActivity) } : { ...s };

const publicSnapshot = (job: TurnJobSnapshot): TurnJobSnapshot => ({
	...job,
	live: { segments: job.live.segments.map(cloneSegment) },
});

const isSnapshot = (value: unknown): value is TurnJobSnapshot => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const v = value as Partial<TurnJobSnapshot>;
	return (
		typeof v.id === "string" &&
		typeof v.clientRequestId === "string" &&
		typeof v.sessionId === "string" &&
		typeof v.input === "string" &&
		typeof v.status === "string" &&
		(ACTIVE.has(v.status as TurnJobStatus) || TERMINAL.has(v.status as TurnJobStatus)) &&
		typeof v.revision === "number" &&
		typeof v.createdAt === "number" &&
		typeof v.updatedAt === "number" &&
		!!v.live &&
		Array.isArray(v.live.segments)
	);
};

/** 与 web/src/timeline.ts appendDelta 同语义的服务端快照版本。 */
function appendDelta(
	segments: TurnJobSegment[],
	kind: "text" | "thinking",
	delta: string,
	draft = false,
	reset = false,
): TurnJobSegment[] {
	if (!delta) return segments;
	if (kind === "text" && draft) {
		if (reset) {
			return [
				...segments.filter((s) => !(s.kind === "text" && s.draft === true)),
				{ kind: "text", text: delta, draft: true },
			];
		}
		const last = segments[segments.length - 1];
		if (last?.kind === "text" && last.draft === true) {
			return [...segments.slice(0, -1), { kind: "text", text: last.text + delta, draft: true }];
		}
		return [...segments, { kind: "text", text: delta, draft: true }];
	}
	const last = segments[segments.length - 1];
	if (last?.kind === kind && !(last.kind === "text" && last.draft === true)) {
		return [...segments.slice(0, -1), { kind, text: last.text + delta }];
	}
	return [...segments, { kind, text: delta }];
}

function resyncDraft(segments: TurnJobSegment[], parts: string[]): TurnJobSegment[] {
	const first = segments.findIndex((s) => s.kind === "text" && s.draft === true);
	const kept = segments.filter((s) => !(s.kind === "text" && s.draft === true));
	const drafts: TurnJobSegment[] = parts
		.filter((part) => part.trim())
		.map((text) => ({ kind: "text", text, draft: true }));
	if (first < 0) return [...kept, ...drafts];
	return [...kept.slice(0, first), ...drafts, ...kept.slice(first)];
}

export class TurnJobManager {
	readonly #dir: string;
	readonly #run: TurnJobManagerOptions["run"];
	readonly #canRun: NonNullable<TurnJobManagerOptions["canRun"]>;
	readonly #onChange?: TurnJobManagerOptions["onChange"];
	readonly #now: NonNullable<TurnJobManagerOptions["now"]>;
	readonly #id: NonNullable<TurnJobManagerOptions["id"]>;
	readonly #persistDelayMs: number;
	readonly #jobs = new Map<string, TurnJobSnapshot>();
	readonly #byRequest = new Map<string, string>();
	readonly #persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
	#runningId: string | null = null;
	#draining = false;

	constructor(options: TurnJobManagerOptions) {
		this.#dir = options.dir;
		this.#run = options.run;
		this.#canRun = options.canRun ?? (() => true);
		this.#onChange = options.onChange;
		this.#now = options.now ?? Date.now;
		this.#id = options.id ?? randomUUID;
		this.#persistDelayMs = Math.max(0, options.persistDelayMs ?? 250);
		mkdirSync(this.#dir, { recursive: true });
		this.#load();
		queueMicrotask(() => void this.#drain());
	}

	enqueue(input: {
		clientRequestId: string;
		sessionId: string;
		sessionFile?: string;
		text: string;
	}): TurnJobSnapshot {
		const requestId = input.clientRequestId.trim();
		const previousId = this.#byRequest.get(requestId);
		if (previousId) {
			const previous = this.#jobs.get(previousId);
			if (previous) return publicSnapshot(previous);
		}
		const now = this.#now();
		const job: TurnJobSnapshot = {
			id: this.#id(),
			clientRequestId: requestId,
			sessionId: input.sessionId,
			...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
			input: input.text,
			status: "queued",
			revision: 1,
			createdAt: now,
			updatedAt: now,
			live: { segments: [] },
		};
		this.#jobs.set(job.id, job);
		this.#byRequest.set(requestId, job.id);
		this.#persist(job);
		this.#onChange?.(publicSnapshot(job));
		queueMicrotask(() => void this.#drain());
		return publicSnapshot(job);
	}

	get(id: string): TurnJobSnapshot | null {
		const job = this.#jobs.get(id);
		return job ? publicSnapshot(job) : null;
	}

	getByRequest(clientRequestId: string): TurnJobSnapshot | null {
		const id = this.#byRequest.get(clientRequestId.trim());
		if (!id) return null;
		const job = this.#jobs.get(id);
		return job ? publicSnapshot(job) : null;
	}

	latestForSession(sessionId: string): TurnJobSnapshot | null {
		let running: TurnJobSnapshot | undefined;
		let queued: TurnJobSnapshot | undefined;
		let terminal: TurnJobSnapshot | undefined;
		for (const job of this.#jobs.values()) {
			if (job.sessionId !== sessionId) continue;
			if (job.status === "running" || job.status === "waiting_input") {
				if (!running || job.updatedAt >= running.updatedAt) running = job;
			} else if (job.status === "queued") {
				// 没有运行中任务时，页面应展示接下来真正会开演的最早一项。
				if (!queued || job.createdAt < queued.createdAt) queued = job;
			} else if (
				!terminal ||
				job.updatedAt > terminal.updatedAt ||
				(job.updatedAt === terminal.updatedAt && job.createdAt >= terminal.createdAt)
			) {
				terminal = job;
			}
		}
		const selected = running ?? queued ?? terminal;
		return selected ? publicSnapshot(selected) : null;
	}

	get hasPending(): boolean {
		for (const job of this.#jobs.values()) if (ACTIVE.has(job.status)) return true;
		return false;
	}

	get active(): TurnJobSnapshot | null {
		if (!this.#runningId) return null;
		const job = this.#jobs.get(this.#runningId);
		return job ? publicSnapshot(job) : null;
	}

	appendDelta(kind: "text" | "thinking", delta: string, draft?: boolean, reset?: boolean): void {
		this.#mutateLive((segments) => appendDelta(segments, kind, delta, draft, reset));
	}

	resyncDraft(segments: string[]): void {
		this.#mutateLive((current) => resyncDraft(current, segments));
	}

	clearStream(): void {
		this.#mutateLive((segments) => segments.filter((s) => !(s.kind === "text" && s.draft !== true)));
	}

	appendActivity(activity: TurnJobActivity): void {
		this.#mutateLive((segments) => {
			const last = segments[segments.length - 1];
			if (last?.kind === "tool") {
				return [
					...segments.slice(0, -1),
					{ kind: "tool", activities: [...last.activities, cloneActivity(activity)] },
				];
			}
			return [...segments, { kind: "tool", activities: [cloneActivity(activity)] }];
		});
	}

	waitingForInput(): void {
		const job = this.#activeJob();
		if (job && job.status === "running") this.#patch(job, { status: "waiting_input" });
	}

	resumeAfterInput(): void {
		const job = this.#activeJob();
		if (job && job.status === "waiting_input") this.#patch(job, { status: "running" });
	}

	cancel(id?: string): TurnJobSnapshot | null {
		const job = id ? this.#jobs.get(id) : this.#activeJob();
		if (!job || TERMINAL.has(job.status)) return job ? publicSnapshot(job) : null;
		// 只能取消尚未开演的队列项，或当前真正占用引擎的任务；不能越过当前拍
		// 把后面的任意任务改写成运行态。
		if (job.status !== "queued" && job.id !== this.#runningId) return publicSnapshot(job);
		this.#patch(job, { status: "cancelled", error: undefined });
		return publicSnapshot(job);
	}

	cancelActive(): TurnJobSnapshot | null {
		return this.cancel();
	}

	finishActive(result: TurnJobRunResult): TurnJobSnapshot | null {
		const job = this.#activeJob();
		if (!job) return null;
		if (TERMINAL.has(job.status)) return publicSnapshot(job);
		if (result.aborted) this.#patch(job, { status: "cancelled", error: undefined });
		else if (result.error) this.#patch(job, { status: "failed", error: result.error });
		else this.#patch(job, { status: "completed", resultEntryId: result.entryId, error: undefined });
		return publicSnapshot(job);
	}

	flush(): void {
		for (const id of [...this.#persistTimers.keys()]) {
			const timer = this.#persistTimers.get(id);
			if (timer) clearTimeout(timer);
			this.#persistTimers.delete(id);
			const job = this.#jobs.get(id);
			if (job) this.#persist(job);
		}
	}

	dispose(): void {
		this.flush();
	}

	#activeJob(): TurnJobSnapshot | undefined {
		return this.#runningId ? this.#jobs.get(this.#runningId) : undefined;
	}

	#mutateLive(update: (segments: TurnJobSegment[]) => TurnJobSegment[]): void {
		const job = this.#activeJob();
		if (!job || TERMINAL.has(job.status)) return;
		job.live = { segments: update(job.live.segments) };
		job.revision += 1;
		job.updatedAt = this.#now();
		this.#schedulePersist(job);
	}

	#patch(job: TurnJobSnapshot, patch: Partial<TurnJobSnapshot>): void {
		Object.assign(job, patch);
		job.revision += 1;
		job.updatedAt = this.#now();
		this.#persist(job);
		this.#onChange?.(publicSnapshot(job));
	}

	#schedulePersist(job: TurnJobSnapshot): void {
		if (this.#persistDelayMs === 0) {
			this.#persist(job);
			return;
		}
		if (this.#persistTimers.has(job.id)) return;
		const timer = setTimeout(() => {
			this.#persistTimers.delete(job.id);
			const current = this.#jobs.get(job.id);
			if (current) this.#persist(current);
		}, this.#persistDelayMs);
		timer.unref?.();
		this.#persistTimers.set(job.id, timer);
	}

	#persist(job: TurnJobSnapshot): void {
		const file = join(this.#dir, `${job.id}.json`);
		const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
		writeFileSync(temp, `${JSON.stringify(job, null, "\t")}\n`, "utf8");
		renameSync(temp, file);
	}

	#load(): void {
		if (!existsSync(this.#dir)) return;
		for (const name of readdirSync(this.#dir)) {
			if (!name.endsWith(".json")) continue;
			const file = join(this.#dir, name);
			try {
				const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
				if (!isSnapshot(parsed)) continue;
				const job = publicSnapshot(parsed);
				if (job.status === "running" || job.status === "waiting_input") {
					job.status = "interrupted";
					job.error = "梨园后台曾在生成过程中退出，可从原输入重新生成。";
					job.revision += 1;
					job.updatedAt = this.#now();
					this.#persist(job);
				} else if (job.status === "queued" && !this.#canRun(job)) {
					job.status = "interrupted";
					job.error = "后台重启后当前会话已变化，任务未自动重放。";
					job.revision += 1;
					job.updatedAt = this.#now();
					this.#persist(job);
				}
				this.#jobs.set(job.id, job);
				this.#byRequest.set(job.clientRequestId, job.id);
			} catch {
				// 损坏或写到一半的单个快照不影响其余任务；临时文件不会命中 .json。
			}
		}
	}

	async #drain(): Promise<void> {
		if (this.#draining) return;
		this.#draining = true;
		try {
			while (!this.#runningId) {
				const next = [...this.#jobs.values()]
					.filter((job) => job.status === "queued" && this.#canRun(job))
					.sort((a, b) => a.createdAt - b.createdAt)[0];
				if (!next) break;
				this.#runningId = next.id;
				this.#patch(next, { status: "running", error: undefined });
				try {
					const result = await this.#run(publicSnapshot(next));
					this.finishActive(result);
				} catch (error) {
					if (!TERMINAL.has(next.status)) {
						this.#patch(next, {
							status: "failed",
							error: error instanceof Error ? error.message : String(error),
						});
					}
				} finally {
					this.#runningId = null;
				}
			}
		} finally {
			this.#draining = false;
		}
	}
}
