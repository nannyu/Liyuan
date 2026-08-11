import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	derivePresetSkillEntries,
	ensurePresetSkills,
	presetSkillDir,
	splitWithManifest,
} from "../src/preset-skill.ts";
import type { RpPreset } from "../src/preset.ts";

const preset = (blocks: Array<Partial<RpPreset["blocks"][number]> & { id: string }>): RpPreset =>
	({
		name: "测试预设",
		samplers: {},
		blocks: blocks.map((b) => ({
			name: "块",
			channel: "system",
			role: "system",
			enabled: true,
			content: "内容",
			...b,
		})),
	}) as RpPreset;

test("预设 skill 投影：全量块落文件（含关闭块），manifest 记去向，指纹跳过重生成", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-psk-"));
	try {
		const p = preset([
			{ id: "a", name: "文风块", content: "文笔要求：短句叙事，感官描写。文风与节奏。", enabled: true },
			{ id: "b", name: "关闭的块", content: "随便什么内容也要有文件。", enabled: false },
		]);
		const m1 = ensurePresetSkills(cwd, p);
		assert.ok(m1 && m1.entries.length === 2, "两块全入 manifest（关闭块不豁免）");
		const dir = presetSkillDir(cwd, "测试预设");
		for (const e of m1!.entries) {
			assert.ok(existsSync(join(dir, "blocks", e.file)), `${e.name} 有文件`);
		}
		assert.ok(existsSync(join(dir, "manifest.json")) && existsSync(join(dir, "README.md")), "manifest+README 在");
		const again = ensurePresetSkills(cwd, p);
		assert.equal(again!.fingerprint, m1!.fingerprint, "同预设指纹一致，直接返回");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("预设 skill 投影：用户改判 fate 在重生成时保留（gen 副本比对）", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-psk-"));
	try {
		const p1 = preset([{ id: "a", name: "某块", content: "一段内容。" }]);
		const m1 = ensurePresetSkills(cwd, p1)!;
		// 用户手改 fate
		const dir = presetSkillDir(cwd, "测试预设");
		m1.entries[0]!.fate = "常驻B";
		m1.entries[0]!.edited = true;
		writeFileSync(join(dir, "manifest.json"), JSON.stringify(m1, null, "\t"));
		// 预设内容变化 → 重生成，改判保留
		const p2 = preset([
			{ id: "a", name: "某块", content: "一段内容。" },
			{ id: "b", name: "新块", content: "新增内容。" },
		]);
		const m2 = ensurePresetSkills(cwd, p2)!;
		assert.equal(m2.entries.find((e) => e.blockId === "a")?.fate, "常驻B", "用户改判保留");
		assert.equal(m2.entries.find((e) => e.blockId === "a")?.edited, true);
		assert.ok(m2.entries.find((e) => e.blockId === "b"), "新块进 manifest");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("splitWithManifest：改判整块归位；未改判走原判定；复合 fate 回落", () => {
	const manifest = {
		preset: "x",
		fingerprint: "f",
		entries: [
			{ blockId: "a", name: "甲", channel: "system" as const, chars: 4, nature: "F", fate: "常驻B", file: "0.md", edited: true },
			{ blockId: "b", name: "乙", channel: "system" as const, chars: 4, nature: "B", fate: "skill:nsfw", file: "1.md", edited: true },
			{ blockId: "c", name: "丙", channel: "system" as const, chars: 4, nature: "B", fate: "常驻B+skill:nsfw", file: "2.md", edited: true },
		],
	};
	const r1 = splitWithManifest(manifest, "a", undefined, "甲", "禁八股原文");
	assert.deepEqual(r1.resident, [{ section: "B", text: "禁八股原文" }], "改判常驻B=整块留驻（蒸发块找回通道）");
	const r2 = splitWithManifest(manifest, "b", undefined, "乙", "语料");
	assert.deepEqual(r2.skill, [{ topic: "nsfw", text: "语料" }]);
	const r3 = splitWithManifest(manifest, "z", undefined, "未知", "文风与节奏的叙事文笔要求");
	assert.ok(r3.fallbackKind, "未改判块走四类兜底");
	const r4 = splitWithManifest(manifest, "c", undefined, "丙", "内容");
	assert.ok(r4.fallbackKind, "复合 fate 不支持整块改判，回落判定器");
});
