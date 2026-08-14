import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeRpPreset } from "../src/preset.ts";

test("normalizeRpPreset：宽容解析（旧梨园格式兼容读）", () => {
	const p = normalizeRpPreset({
		blocks: [{ id: "a", content: "x", channel: "system", enabled: true }, null, { bad: true }],
		samplers: { temperature: 1, bogus: "x" },
	});
	assert.equal(p.blocks.length, 1, "非法块滤掉");
	assert.deepEqual(p.samplers, { temperature: 1 }, "非数值采样键滤掉");
	assert.deepEqual(normalizeRpPreset(null).blocks, []);
	assert.equal(normalizeRpPreset({}).name, "preset");
});
