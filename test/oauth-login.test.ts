import assert from "node:assert/strict";
import test from "node:test";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "@liyuan/ai/oauth";
import { OAuthLoginManager, type OAuthAuthStorageLike } from "../server/oauth-login.ts";

const credentials = (suffix: string): OAuthCredentials => ({
	access: `access-${suffix}`,
	refresh: `refresh-${suffix}`,
	expires: Date.now() + 60_000,
});

function provider(
	login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>,
	id = "openai-codex",
): OAuthProviderInterface {
	return {
		id,
		name: id,
		usesCallbackServer: id !== "github-copilot",
		login,
		async refreshToken(value) {
			return value;
		},
		getApiKey(value) {
			return value.access;
		},
	};
}

function storage(
	oauthProvider: OAuthProviderInterface,
	onSet?: (providerId: string, value: { type: "oauth" } & OAuthCredentials) => void,
): OAuthAuthStorageLike {
	return {
		getOAuthProviders: () => [oauthProvider],
		set: (providerId, value) => onSet?.(providerId, value),
	};
}

async function waitFor(done: () => boolean): Promise<void> {
	for (let i = 0; i < 50; i += 1) {
		if (done()) return;
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	throw new Error("等待 OAuth 状态超时");
}

test("OAuth manager：OpenAI 设备码启动、完成，快照不包含 token", async () => {
	let complete!: () => void;
	const gate = new Promise<void>((resolve) => {
		complete = resolve;
	});
	let stored = false;
	const manager = new OAuthLoginManager(
		storage(
			provider(async (callbacks) => {
				assert.equal(
					await callbacks.onSelect({
						message: "method",
						options: [
							{ id: "browser", label: "Browser" },
							{ id: "device_code", label: "Device" },
						],
					}),
					"device_code",
				);
				callbacks.onDeviceCode({ userCode: "ABCD-EFGH", verificationUri: "https://example.test/device" });
				await gate;
				return credentials("device");
			}),
			() => {
				stored = true;
			},
		),
	);

	const started = await manager.start("openai-codex", "device_code");
	assert.equal(started.status, "waiting");
	assert.equal(started.deviceCode?.userCode, "ABCD-EFGH");
	assert.equal(JSON.stringify(started).includes("access"), false);
	assert.equal(JSON.stringify(started).includes("refresh"), false);

	complete();
	await waitFor(() => manager.get(started.id)?.status === "success");
	assert.equal(stored, true);
});

test("OAuth manager：浏览器回调可由 Web 提交，且支持等待阶段取消", async () => {
	const manager = new OAuthLoginManager(
		storage(
			provider(async (callbacks) => {
				callbacks.onAuth({ url: "https://example.test/authorize" });
				const value = await callbacks.onManualCodeInput?.();
				assert.equal(value, "http://localhost:1455/auth/callback?code=demo");
				return credentials("browser");
			}),
		),
	);

	const started = await manager.start("openai-codex", "browser");
	assert.equal(started.authUrl, "https://example.test/authorize");
	assert.match(started.prompt?.message ?? "", /回调地址/);
	manager.submit(started.id, "http://localhost:1455/auth/callback?code=demo");
	await waitFor(() => manager.get(started.id)?.status === "success");

	const waitingManager = new OAuthLoginManager(
		storage(
			provider(async (callbacks) => {
				callbacks.onAuth({ url: "https://example.test/authorize" });
				await callbacks.onManualCodeInput?.();
				return credentials("should-not-store");
			}),
		),
	);
	const waiting = await waitingManager.start("openai-codex", "browser");
	assert.equal(waitingManager.cancel(waiting.id).status, "cancelled");
	await waitFor(() => waitingManager.get(waiting.id)?.status === "cancelled");
});

test("OAuth manager：GitHub Copilot 可提交空 enterprise domain", async () => {
	let storedProvider = "";
	const manager = new OAuthLoginManager(
		storage(
			provider(async (callbacks) => {
				const domain = await callbacks.onPrompt({
					message: "GitHub Enterprise URL/domain (blank for github.com)",
					placeholder: "company.ghe.com",
					allowEmpty: true,
				});
				assert.equal(domain, "");
				return credentials("copilot");
			}, "github-copilot"),
			(providerId) => {
				storedProvider = providerId;
			},
		),
	);

	const started = await manager.start("github-copilot");
	assert.equal(started.prompt?.allowEmpty, true);
	manager.submit(started.id, "");
	await waitFor(() => manager.get(started.id)?.status === "success");
	assert.equal(storedProvider, "github-copilot");
});

test("OAuth manager：取消 token exchange 后不落盘，晚到进度不覆盖 cancelled", async () => {
	let exchangeStarted!: () => void;
	const exchanging = new Promise<void>((resolve) => {
		exchangeStarted = resolve;
	});
	let completeExchange!: () => void;
	const exchangeGate = new Promise<void>((resolve) => {
		completeExchange = resolve;
	});
	let writes = 0;
	const manager = new OAuthLoginManager(
		storage(
			provider(async (callbacks) => {
				callbacks.onAuth({ url: "https://example.test/authorize" });
				await callbacks.onManualCodeInput?.();
				exchangeStarted();
				callbacks.onProgress?.("Exchanging authorization code for tokens...");
				await exchangeGate;
				callbacks.onProgress?.("late progress");
				return credentials("cancelled");
			}),
			() => {
				writes += 1;
			},
		),
	);

	const started = await manager.start("openai-codex", "browser");
	manager.submit(started.id, "http://localhost:1455/auth/callback?code=demo");
	await exchanging;
	assert.equal(manager.cancel(started.id).status, "cancelled");
	completeExchange();
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(manager.get(started.id)?.status, "cancelled");
	assert.equal(writes, 0);
});

test("OAuth manager：每次启动都解析当前会话的 AuthStorage", async () => {
	const loginProvider = provider(async () => credentials("rebind"));
	let firstWrites = 0;
	let secondWrites = 0;
	const first = storage(loginProvider, () => {
		firstWrites += 1;
	});
	const second = storage(loginProvider, () => {
		secondWrites += 1;
	});
	let current = first;
	const manager = new OAuthLoginManager(() => current);

	current = second;
	const started = await manager.start("openai-codex", "browser");
	await waitFor(() => manager.get(started.id)?.status === "success");
	assert.equal(firstWrites, 0);
	assert.equal(secondWrites, 1);
});
