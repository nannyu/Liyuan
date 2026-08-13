import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { probeModelsEndpoint } from "../server/model-probe.ts";

async function withServer(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
	run: (baseUrl: string) => Promise<void>,
): Promise<void> {
	const server = createServer(handler);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("测试服务器地址异常");
		await run(`http://127.0.0.1:${address.port}`);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}

test("模型探测：OpenAI 兼容渠道使用 Bearer 与 /models", async () => {
	await withServer(
		(req, res) => {
			assert.equal(req.url, "/v1/models");
			assert.equal(req.headers.authorization, "Bearer openai-key");
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "gpt-test" }] }));
		},
		async (baseUrl) => {
			const result = await probeModelsEndpoint(`${baseUrl}/v1`, "openai-key", "openai-responses");
			assert.equal(result.ok, true);
			assert.deepEqual(result.ids, ["gpt-test"]);
		},
	);
});

test("模型探测：Anthropic 补 /v1 并使用 x-api-key", async () => {
	await withServer(
		(req, res) => {
			assert.equal(req.url, "/v1/models?limit=1000");
			assert.equal(req.headers["x-api-key"], "anthropic-key");
			assert.equal(req.headers["anthropic-version"], "2023-06-01");
			assert.equal(req.headers.authorization, undefined);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ id: "claude-test" }] }));
		},
		async (baseUrl) => {
			const result = await probeModelsEndpoint(baseUrl, "anthropic-key", "anthropic-messages");
			assert.equal(result.ok, true);
			assert.deepEqual(result.ids, ["claude-test"]);
		},
	);
});

test("模型探测：Google 使用 x-goog-api-key 并规范化 models/ 前缀", async () => {
	await withServer(
		(req, res) => {
			assert.equal(req.url, "/v1beta/models?pageSize=1000");
			assert.equal(req.headers["x-goog-api-key"], "google-key");
			assert.equal(req.headers.authorization, undefined);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					models: [
						{ name: "models/gemini-test", displayName: "Gemini Test", supportedGenerationMethods: ["generateContent"] },
						{ name: "models/embedding-test", supportedGenerationMethods: ["embedContent"] },
					],
				}),
			);
		},
		async (baseUrl) => {
			const result = await probeModelsEndpoint(`${baseUrl}/v1beta`, "google-key", "google-generative-ai");
			assert.equal(result.ok, true);
			assert.deepEqual(result.ids, ["gemini-test"]);
			assert.equal(result.models[0]?.name, "Gemini Test");
		},
	);
});

test("模型探测：OpenAI Codex OAuth 使用 manifest 端点并提取最新可见模型", async () => {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-test" } }),
	).toString("base64url");
	const accessToken = `header.${payload}.signature`;

	await withServer(
		(req, res) => {
			const url = new URL(req.url ?? "", "http://localhost");
			assert.equal(url.pathname, "/backend-api/codex/models");
			assert.ok(url.searchParams.get("client_version"));
			assert.equal(req.headers.authorization, `Bearer ${accessToken}`);
			assert.equal(req.headers["chatgpt-account-id"], "account-test");
			assert.equal(req.headers.originator, "codex_cli_rs");
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					models: [
						{
							slug: "gpt-5.6-sol",
							display_name: "GPT-5.6-Sol",
							visibility: "list",
							supported_in_api: true,
							supported_reasoning_efforts: [{ reasoning_effort: "high" }],
							input_modalities: ["text", "image"],
							context_window: 400_000,
							max_output_tokens: 128_000,
						},
						{ slug: "hidden-model", visibility: "hide", supported_in_api: true },
						{ slug: "unsupported-model", visibility: "list", supported_in_api: false },
					],
				}),
			);
		},
		async (baseUrl) => {
			const result = await probeModelsEndpoint(`${baseUrl}/backend-api`, accessToken, "openai-codex-responses");
			assert.equal(result.ok, true);
			assert.deepEqual(result.ids, ["gpt-5.6-sol"]);
			assert.deepEqual(result.models[0], {
				id: "gpt-5.6-sol",
				name: "GPT-5.6-Sol",
				reasoning: true,
				contextWindow: 400_000,
				maxTokens: 128_000,
				input: ["text", "image"],
			});
		},
	);
});
