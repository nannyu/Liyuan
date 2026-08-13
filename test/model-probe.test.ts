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
			res.end(JSON.stringify({ models: [{ name: "models/gemini-test" }] }));
		},
		async (baseUrl) => {
			const result = await probeModelsEndpoint(`${baseUrl}/v1beta`, "google-key", "google-generative-ai");
			assert.equal(result.ok, true);
			assert.deepEqual(result.ids, ["gemini-test"]);
		},
	);
});
