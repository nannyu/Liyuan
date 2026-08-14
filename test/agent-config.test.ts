import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	enableProfile,
	type LiyuanAgentConfig,
	mergeModelsById,
	normalizeAgentConfig,
	saveAgentConfig,
	seedProviderFromRuntime,
	loadAgentConfig,
	saveProfile,
} from "../src/agent-config.ts";

function makeTmpDir(): string {
	const d = mkdtempSync(join(tmpdir(), "agent-cfg-"));
	return d;
}

function writeConfig(cwd: string, config: LiyuanAgentConfig): void {
	writeFileSync(join(cwd, "liyuan.agent.json"), JSON.stringify(config, null, "\t"), "utf8");
}

test("mergeModelsById：保留旧条目的 compat 等额外字段", () => {
	const old = [
		{ id: "deepseek/deepseek-v4-flash", reasoning: true, compat: { supportsDeveloperRole: false, thinkingFormat: "deepseek" } },
	];
	const incoming = [
		{ id: "deepseek/deepseek-v4-flash", reasoning: true, contextWindow: 1000000 },
	];
	const merged = mergeModelsById(old, incoming);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].id, "deepseek/deepseek-v4-flash");
	assert.equal(merged[0].contextWindow, 1000000); // 新值生效
	assert.deepEqual(merged[0].compat, { supportsDeveloperRole: false, thinkingFormat: "deepseek" }); // 旧值保留
});

test("mergeModelsById：incoming 的显式值覆盖旧值", () => {
	const old = [{ id: "m1", contextWindow: 8000, compat: { foo: true } }];
	const incoming = [{ id: "m1", contextWindow: 128000, compat: { foo: false } }];
	const merged = mergeModelsById(old, incoming);
	assert.equal(merged[0].contextWindow, 128000);
	assert.deepEqual(merged[0].compat, { foo: false });
});

test("seedProviderFromRuntime：传入的额外字段不丢失", () => {
	const provider = seedProviderFromRuntime({
		provider: "deepseek",
		baseUrl: "https://api.deepseek.com/v1",
		api: "openai-completions",
		models: [
			{
				id: "deepseek/deepseek-v4-flash",
				reasoning: true,
				contextWindow: 1000000,
				maxTokens: 384000,
				compat: { supportsDeveloperRole: false, thinkingFormat: "deepseek" },
				cost: { input: 0.14, output: 0.28 },
				thinkingLevelMap: { off: null, max: "max" },
			} as any,
		],
	});
	const m = provider.models![0];
	assert.equal(m.id, "deepseek/deepseek-v4-flash");
	assert.deepEqual(m.compat, { supportsDeveloperRole: false, thinkingFormat: "deepseek" });
	assert.deepEqual(m.cost, { input: 0.14, output: 0.28 });
	assert.deepEqual(m.thinkingLevelMap, { off: null, max: "max" });
});

test("enableProfile：磁盘上的 model compat 在启用 profile 后保留", () => {
	const cwd = makeTmpDir();
	try {
		// 磁盘上已有含 compat 的配置
		writeConfig(cwd, {
			version: 1,
			defaultProvider: "deepseek",
			defaultModel: "deepseek/deepseek-v4-flash",
			providers: {
				deepseek: {
					baseUrl: "https://api.deepseek.com/v1",
					api: "openai-completions",
					apiKey: "sk-test",
					models: [{ id: "deepseek/deepseek-v4-flash", reasoning: true, compat: { supportsDeveloperRole: false } }],
				},
			},
		});
		// 仓库里的 profile 没有 compat（保存时还没加）
		saveProfile(cwd, "deepseek", "deepseek", {
			version: 1,
			defaultProvider: "deepseek",
			defaultModel: "deepseek/deepseek-v4-flash",
			providers: {
				deepseek: {
					baseUrl: "https://api.deepseek.com/v1",
					api: "openai-completions",
					apiKey: "sk-test",
					models: [{ id: "deepseek/deepseek-v4-flash", reasoning: true }],
				},
			},
		});
		// 用一个 dummy agentDir（enableProfile 不需要真实 agentDir，syncAgentConfigToRuntime 只写文件）
		const agentDir = join(cwd, ".liyuan", "agent");
		mkdirSync(agentDir, { recursive: true });
		enableProfile(cwd, agentDir, "deepseek");
		// 重读磁盘上的 liyuan.agent.json
		const after = loadAgentConfig(cwd).config;
		const m = after.providers.deepseek?.models?.[0];
		assert.ok(m, "model entry should exist");
		assert.deepEqual(m.compat, { supportsDeveloperRole: false }, "compat should survive enableProfile");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("normalizeAgentConfig：model 上的 compat 原样保留", () => {
	const raw = {
		version: 1,
		providers: {
			test: {
				baseUrl: "https://example.com",
				models: [
					{ id: "m1", compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" } },
				],
			},
		},
	};
	const cfg = normalizeAgentConfig(raw);
	assert.deepEqual(cfg.providers.test.models![0].compat, { supportsDeveloperRole: false, maxTokensField: "max_tokens" });
});

test("saveAgentConfig → loadAgentConfig 往返保留 model compat", () => {
	const cwd = makeTmpDir();
	try {
		const config: LiyuanAgentConfig = {
			version: 1,
			defaultProvider: "ds",
			providers: {
				ds: {
					baseUrl: "https://api.deepseek.com/v1",
					apiKey: "sk-test",
					models: [{ id: "m1", compat: { supportsDeveloperRole: false }, thinkingLevelMap: { off: null } }],
				},
			},
		};
		saveAgentConfig(cwd, config);
		const loaded = loadAgentConfig(cwd).config;
		assert.deepEqual(loaded.providers.ds.models![0].compat, { supportsDeveloperRole: false });
		assert.deepEqual(loaded.providers.ds.models![0].thinkingLevelMap, { off: null });
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
