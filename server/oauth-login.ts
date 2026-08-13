/**
 * Web OAuth 登录协调器。
 *
 * provider 自己负责 PKCE / device-code / token 交换；这里把原本的 TUI callbacks
 * 映射成「启动 -> 展示授权信息 -> 轮询 -> 提交手工回调/取消」，并仅在未取消时落盘。
 * 快照绝不包含 access/refresh token。
 */

import { randomUUID } from "node:crypto";
import type {
	OAuthCredentials,
	OAuthDeviceCodeInfo,
	OAuthProviderId,
	OAuthProviderInterface,
	OAuthSelectPrompt,
} from "@liyuan/ai/oauth";

export type OAuthLoginMethod = "browser" | "device_code";
export type OAuthLoginStatus = "starting" | "waiting" | "success" | "error" | "cancelled";

export interface OAuthLoginSnapshot {
	id: string;
	provider: string;
	status: OAuthLoginStatus;
	method?: string;
	authUrl?: string;
	instructions?: string;
	deviceCode?: {
		userCode: string;
		verificationUri: string;
		expiresInSeconds?: number;
	};
	prompt?: { message: string; placeholder?: string; allowEmpty?: boolean };
	progress?: string;
	error?: string;
	startedAt: number;
	updatedAt: number;
}

export interface OAuthAuthStorageLike {
	getOAuthProviders(): OAuthProviderInterface[];
	set(providerId: OAuthProviderId, credentials: { type: "oauth" } & OAuthCredentials): void;
}

type OAuthAuthStorageSource = OAuthAuthStorageLike | (() => OAuthAuthStorageLike);

type PendingInput = {
	resolve: (value: string) => void;
	reject: (error: Error) => void;
};

type OAuthJob = {
	snapshot: OAuthLoginSnapshot;
	storage: OAuthAuthStorageLike;
	providerImpl: OAuthProviderInterface;
	abort: AbortController;
	input?: PendingInput;
	ready: Promise<void>;
	markReady: () => void;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function publicSnapshot(job: OAuthJob): OAuthLoginSnapshot {
	return {
		...job.snapshot,
		...(job.snapshot.deviceCode ? { deviceCode: { ...job.snapshot.deviceCode } } : {}),
		...(job.snapshot.prompt ? { prompt: { ...job.snapshot.prompt } } : {}),
	};
}

function terminal(status: OAuthLoginStatus): boolean {
	return status === "success" || status === "error" || status === "cancelled";
}

export class OAuthLoginManager {
	readonly #getStorage: () => OAuthAuthStorageLike;
	readonly #onSuccess?: (provider: string) => void | Promise<void>;
	readonly #jobs = new Map<string, OAuthJob>();

	constructor(storage: OAuthAuthStorageSource, onSuccess?: (provider: string) => void | Promise<void>) {
		this.#getStorage = typeof storage === "function" ? storage : () => storage;
		this.#onSuccess = onSuccess;
	}

	providers(): Array<{ id: string; name: string; usesCallbackServer: boolean; methods: OAuthLoginMethod[] }> {
		return this.#getStorage().getOAuthProviders().map((provider) => ({
			id: provider.id,
			name: provider.name,
			usesCallbackServer: provider.usesCallbackServer === true,
			methods: provider.id === "openai-codex" ? ["browser", "device_code"] : ["browser"],
		}));
	}

	async start(provider: string, method?: string): Promise<OAuthLoginSnapshot> {
		const storage = this.#getStorage();
		const info = storage.getOAuthProviders().find((item) => item.id === provider);
		if (!info) throw new Error(`不支持 OAuth 的 provider：${provider}`);

		for (const job of this.#jobs.values()) {
			if (job.snapshot.provider === provider && !terminal(job.snapshot.status)) this.cancel(job.snapshot.id);
		}

		const allowed = provider === "openai-codex" ? new Set(["browser", "device_code"]) : null;
		if (method && allowed && !allowed.has(method)) throw new Error(`不支持的授权方式：${method}`);

		const now = Date.now();
		const ready = deferred();
		const job: OAuthJob = {
			snapshot: {
				id: randomUUID(),
				provider,
				status: "starting",
				...(method ? { method } : {}),
				startedAt: now,
				updatedAt: now,
			},
			storage,
			providerImpl: info,
			abort: new AbortController(),
			ready: ready.promise,
			markReady: ready.resolve,
		};
		this.#jobs.set(job.snapshot.id, job);
		this.#pruneJobs();

		void this.#run(job, method);
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, 10_000);
			void job.ready.then(() => {
				clearTimeout(timer);
				resolve();
			});
		});
		return publicSnapshot(job);
	}

	get(id: string): OAuthLoginSnapshot | null {
		const job = this.#jobs.get(id);
		return job ? publicSnapshot(job) : null;
	}

	submit(id: string, value: string): OAuthLoginSnapshot {
		const job = this.#requireJob(id);
		if (terminal(job.snapshot.status)) return publicSnapshot(job);
		if (!job.input) throw new Error("当前授权流程不需要手工输入");
		const input = value.trim();
		if (!input && !job.snapshot.prompt?.allowEmpty) throw new Error("授权码或回调地址不能为空");
		const pending = job.input;
		job.input = undefined;
		job.snapshot.prompt = undefined;
		this.#patch(job, { status: "waiting", progress: "已提交，正在完成授权…" });
		pending.resolve(input);
		return publicSnapshot(job);
	}

	cancel(id: string): OAuthLoginSnapshot {
		const job = this.#requireJob(id);
		if (terminal(job.snapshot.status)) return publicSnapshot(job);
		job.abort.abort();
		job.input?.reject(new Error("Login cancelled"));
		job.input = undefined;
		this.#patch(job, { status: "cancelled", progress: undefined, prompt: undefined, error: undefined });
		job.markReady();
		return publicSnapshot(job);
	}

	async #run(job: OAuthJob, method?: string): Promise<void> {
		try {
			const credentials = await job.providerImpl.login({
				onAuth: (info) => {
					if (!this.#active(job)) return;
					this.#patch(job, {
						status: "waiting",
						authUrl: info.url,
						instructions: info.instructions,
						progress: "等待浏览器授权…",
					});
					job.markReady();
				},
				onDeviceCode: (info: OAuthDeviceCodeInfo) => {
					if (!this.#active(job)) return;
					this.#patch(job, {
						status: "waiting",
						authUrl: info.verificationUri,
						deviceCode: {
							userCode: info.userCode,
							verificationUri: info.verificationUri,
							expiresInSeconds: info.expiresInSeconds,
						},
						progress: "等待设备授权…",
					});
					job.markReady();
				},
				onPrompt: (prompt) => this.#waitForInput(job, prompt.message, prompt.placeholder, prompt.allowEmpty),
				onProgress: (progress) => {
					if (this.#active(job)) this.#patch(job, { status: "waiting", progress });
				},
				onManualCodeInput: () =>
					this.#waitForInput(job, "粘贴授权后的完整回调地址或 authorization code", "http://localhost:1455/auth/callback?…"),
				onSelect: (prompt: OAuthSelectPrompt) => this.#selectMethod(prompt, method),
				signal: job.abort.signal,
			});

			if (!this.#active(job)) return;
			job.storage.set(job.snapshot.provider, { type: "oauth", ...credentials });
			this.#patch(job, { status: "success", progress: "授权完成", prompt: undefined, error: undefined });
			await this.#onSuccess?.(job.snapshot.provider);
		} catch (error) {
			if (job.snapshot.status === "cancelled" || job.abort.signal.aborted) {
				this.#patch(job, { status: "cancelled", progress: undefined, prompt: undefined, error: undefined });
			} else {
				this.#patch(job, {
					status: "error",
					progress: undefined,
					prompt: undefined,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		} finally {
			job.input = undefined;
			job.markReady();
		}
	}

	#waitForInput(job: OAuthJob, message: string, placeholder?: string, allowEmpty?: boolean): Promise<string> {
		if (job.abort.signal.aborted) return Promise.reject(new Error("Login cancelled"));
		return new Promise<string>((resolve, reject) => {
			job.input?.reject(new Error("Authorization prompt replaced"));
			job.input = { resolve, reject };
			this.#patch(job, {
				status: "waiting",
				prompt: { message, ...(placeholder ? { placeholder } : {}), ...(allowEmpty ? { allowEmpty: true } : {}) },
				progress: "等待授权信息…",
			});
			job.markReady();
		});
	}

	#selectMethod(prompt: OAuthSelectPrompt, preferred?: string): Promise<string | undefined> {
		if (preferred && prompt.options.some((option) => option.id === preferred)) return Promise.resolve(preferred);
		return Promise.resolve(prompt.options[0]?.id);
	}

	#active(job: OAuthJob): boolean {
		return !job.abort.signal.aborted && !terminal(job.snapshot.status);
	}

	#patch(job: OAuthJob, patch: Partial<OAuthLoginSnapshot>): void {
		job.snapshot = { ...job.snapshot, ...patch, updatedAt: Date.now() };
	}

	#requireJob(id: string): OAuthJob {
		const job = this.#jobs.get(id);
		if (!job) throw new Error("授权任务不存在或已过期");
		return job;
	}

	#pruneJobs(): void {
		const jobs = [...this.#jobs.values()].sort((a, b) => b.snapshot.updatedAt - a.snapshot.updatedAt);
		for (const stale of jobs.slice(20)) {
			if (!terminal(stale.snapshot.status)) continue;
			this.#jobs.delete(stale.snapshot.id);
		}
	}
}
