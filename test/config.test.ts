import assert from "node:assert/strict";
import { test } from "node:test";

import { applyConfigPatch } from "../server/rest.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

test("配置：名录刷新周期可写并限制在 0..100", () => {
	assert.equal(applyConfigPatch(DEFAULT_CONFIG, { rosterRefreshEveryNTurns: 7 }).rosterRefreshEveryNTurns, 7);
	assert.equal(applyConfigPatch(DEFAULT_CONFIG, { rosterRefreshEveryNTurns: -3 }).rosterRefreshEveryNTurns, 0);
	assert.equal(applyConfigPatch(DEFAULT_CONFIG, { rosterRefreshEveryNTurns: 500 }).rosterRefreshEveryNTurns, 100);
});

test("配置：固定楼层压缩周期通过既有设置面板白名单", () => {
	assert.equal(applyConfigPatch(DEFAULT_CONFIG, { compactEveryNTurns: 12 }).compactEveryNTurns, 12);
});
