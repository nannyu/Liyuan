import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { PresetBlock, RpPreset } from "../src/preset.ts";
import {
	batchBlocks,
	ensureSortResult,
	parseBatch,
	sortFingerprint,
	sortPreset,
	sortResultPath,
	writeSortResult,
	type SortDeps,
} from "../src/preset-sort.ts";

const blk = (id: string, name: string, content: string, enabled = true): PresetBlock => ({
	id,
	name,
	channel: "system",
	role: "system",
	content,
	enabled,
});

const makePreset = (blocks: PresetBlock[], name = "测试预设"): RpPreset => ({
	name,
	samplers: {},
	blocks,
});

test("batchBlocks：按字数切批，块序不乱、无遗漏", () => {
	const blocks = Array.from({ length: 10 }, (_, i) => blk(`b${i}`, `块${i}`, "x".repeat(3000)));
	const batches = batchBlocks(blocks, 9000);
	assert.ok(batches.length >= 3, "3000×10 / 9000 应切成 ≥3 批");
	const flat = batches.flat();
	assert.equal(flat.length, 10);
	assert.deepEqual(flat.map((b) => b.id), blocks.map((b) => b.id), "顺序必须保持");
});

test("batchBlocks：超大单块也自成一批（不丢）", () => {
	const batches = batchBlocks([blk("big", "巨块", "y".repeat(50000))], 9000);
	assert.equal(batches.length, 1);
	assert.equal(batches[0][0].id, "big");
});

test("parseBatch：白名单过滤 + 批外 id 丢弃 + 去重", () => {
	const ids = new Set(["a", "b", "c"]);
	const text = `废话 {"blocks":[
		{"id":"a","family":"文风","group":"文风"},
		{"id":"b","family":"乱写家族"},
		{"id":"z","family":"删"},
		{"id":"c","family":"删"},
		{"id":"a","family":"破限"}
	]} 尾巴`;
	const out = parseBatch(text, ids);
	assert.equal(out.get("a")?.family, "文风", "首次命中保留，重复丢弃");
	assert.equal(out.get("a")?.group, "文风");
	assert.equal(out.has("b"), false, "非白名单 family 丢弃");
	assert.equal(out.has("z"), false, "批外 id 丢弃");
	assert.equal(out.get("c")?.family, "删");
});

test("parseBatch：非 JSON / 无 blocks 返回空", () => {
	assert.equal(parseBatch("完全不是 json", new Set(["a"])).size, 0);
	assert.equal(parseBatch('{"foo":1}', new Set(["a"])).size, 0);
});

test("sortFingerprint：内容变则变，仅切开关不变", () => {
	const a = makePreset([blk("x", "块", "hello", true)]);
	const b = makePreset([blk("x", "块", "hello", false)]); // 只切 enabled
	const c = makePreset([blk("x", "块", "hello world", true)]); // 改内容
	assert.equal(sortFingerprint(a), sortFingerprint(b), "开关不进指纹");
	assert.notEqual(sortFingerprint(a), sortFingerprint(c), "内容进指纹");
});

test("sortPreset：聚合家族 + ≥2 成员成互斥组 + 漏判兜底方法论", async () => {
	const preset = makePreset([
		blk("p1", "人格", "你是作家"),
		blk("pov1", "第一人称", "用我"),
		blk("pov3", "第三人称", "用他"),
		blk("style", "恋爱文风", "写恋爱"),
		blk("miss", "没判到的块", "xxx"),
	]);
	const deps: SortDeps = {
		sideText: async (_sp, ut) => {
			// 按 userText 里出现的 id 回相应 family（miss 故意不回 → 触发兜底）
			const b: Array<Record<string, string>> = [];
			if (ut.includes("id=p1")) b.push({ id: "p1", family: "破限" });
			if (ut.includes("id=pov1")) b.push({ id: "pov1", family: "配置", group: "人称视角" });
			if (ut.includes("id=pov3")) b.push({ id: "pov3", family: "配置", group: "人称视角" });
			if (ut.includes("id=style")) b.push({ id: "style", family: "文风", group: "文风" });
			return JSON.stringify({ blocks: b });
		},
	};
	const r = await sortPreset(preset, deps);
	assert.ok(r);
	const fam = new Map(r!.entries.map((e) => [e.blockId, e.family]));
	assert.equal(fam.get("p1"), "破限");
	assert.equal(fam.get("pov1"), "配置");
	assert.equal(fam.get("style"), "文风");
	assert.equal(fam.get("miss"), "方法论", "漏判兜底方法论（不蒸发）");
	// 人称视角 2 成员成组；文风只 1 成员不成组、group 标记被清
	const grp = new Map(r!.groups.map((g) => [g.name, g.members.length]));
	assert.equal(grp.get("人称视角"), 2);
	assert.equal(grp.has("文风"), false, "单成员不立组");
	assert.equal(r!.entries.find((e) => e.blockId === "style")?.group, undefined, "单成员 group 标记清除");
});

test("sortPreset：整批解析失败即整体 null（不产半成品）", async () => {
	const preset = makePreset([blk("a", "块", "x")]);
	const deps: SortDeps = { sideText: async () => "模型抽风，非 json" };
	assert.equal(await sortPreset(preset, deps), null);
});

test("sortPreset：sideText 报错即 null", async () => {
	const preset = makePreset([blk("a", "块", "x")]);
	const deps: SortDeps = { sideText: async () => ({ error: "网络炸了" }) };
	assert.equal(await sortPreset(preset, deps), null);
});

test("sortPreset：onProgress 逐批推进", async () => {
	const preset = makePreset(Array.from({ length: 6 }, (_, i) => blk(`b${i}`, `块${i}`, "z".repeat(4000))));
	const seen: Array<[number, number]> = [];
	const deps: SortDeps = {
		sideText: async (_sp, ut) => {
			const ids = [...ut.matchAll(/id=(b\d+)/g)].map((m) => m[1]);
			return JSON.stringify({ blocks: ids.map((id) => ({ id, family: "方法论" })) });
		},
		onProgress: (done, total) => seen.push([done, total]),
	};
	const r = await sortPreset(preset, deps);
	assert.ok(r);
	assert.ok(seen.length >= 2, "多批应多次推进度");
	assert.ok(seen.every(([, total]) => total === seen[0][1]), "total 恒定");
});

test("ensureSortResult：手工基准（generatedBy!=ai）不被自动覆盖，force 才覆盖", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-sort-"));
	try {
		const preset = makePreset([blk("a", "块", "内容")], "夏瑾");
		// 预置手工基准
		writeSortResult(cwd, {
			preset: "夏瑾",
			schema: "sorting-v2",
			source: "手工",
			fingerprint: "manualfp",
			generatedBy: "ai", // writeSortResult 只接受 ai，改文件模拟 manual
			familySemantics: {},
			groups: [],
			entries: [{ idx: 0, blockId: "a", name: "块", chars: 2, family: "破限" }],
		});
		// 手动把落盘的 generatedBy 改成 manual-audit（模拟手工基准）
		const p = sortResultPath(cwd, "夏瑾");
		const obj = JSON.parse(readFileSync(p, "utf8"));
		obj.generatedBy = "manual-audit";
		writeSortResult(cwd, obj);

		let called = 0;
		const deps: SortDeps = {
			sideText: async (_sp, ut) => {
				called++;
				const ids = [...ut.matchAll(/id=(\w+)/g)].map((m) => m[1]);
				return JSON.stringify({ blocks: ids.map((id) => ({ id, family: "删" })) });
			},
		};
		const r1 = await ensureSortResult(cwd, preset, deps);
		assert.equal(r1, "manual", "手工基准被保护");
		assert.equal(called, 0, "未调模型");
		// force 覆盖
		const r2 = await ensureSortResult(cwd, preset, deps, { force: true });
		assert.equal(r2, "sorted");
		assert.ok(called > 0);
		const after = JSON.parse(readFileSync(p, "utf8"));
		assert.equal(after.generatedBy, "ai");
		assert.equal(after.entries[0].family, "删");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("ensureSortResult：AI 缓存指纹命中则跳过，内容变则重跑", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-sort-"));
	try {
		const preset = makePreset([blk("a", "块", "内容")], "测试卡");
		let called = 0;
		const deps: SortDeps = {
			sideText: async (_sp, ut) => {
				called++;
				const ids = [...ut.matchAll(/id=(\w+)/g)].map((m) => m[1]);
				return JSON.stringify({ blocks: ids.map((id) => ({ id, family: "方法论" })) });
			},
		};
		assert.equal(await ensureSortResult(cwd, preset, deps), "sorted");
		assert.ok(existsSync(sortResultPath(cwd, "测试卡")));
		const firstCalls = called;
		// 同预设再跑：指纹命中，跳过
		assert.equal(await ensureSortResult(cwd, preset, deps), "cached");
		assert.equal(called, firstCalls, "缓存命中不再调模型");
		// 改内容：指纹变，重跑
		const preset2 = makePreset([blk("a", "块", "内容改了")], "测试卡");
		assert.equal(await ensureSortResult(cwd, preset2, deps), "sorted");
		assert.ok(called > firstCalls);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
