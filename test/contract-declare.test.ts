import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { RpPreset } from "../src/preset.ts";
import type { CharacterCard, LorebookEntry } from "../src/types.ts";
import {
	buildDeclarePrompt,
	declareFingerprint,
	ensureDeclaredContract,
	loadDeclaredContract,
	parseDeclared,
} from "../src/stage/contract-declare.ts";

const makeCard = (over: Partial<CharacterCard> = {}): CharacterCard => ({
	name: "云澜",
	description: "{{user}}的师姐。",
	personality: "",
	scenario: "",
	firstMes: "你来了。\n<state1>\n地点：山门\n</state1>",
	mesExample: "",
	systemPrompt: "",
	postHistoryInstructions: "",
	creatorNotes: "",
	alternateGreetings: [],
	tags: [],
	book: [],
	...over,
});

const makeEntry = (over: Partial<LorebookEntry> = {}): LorebookEntry => ({
	uid: 1,
	keys: [],
	secondaryKeys: [],
	comment: "极简状态栏【可选】",
	content: "```\n📍山门 🕐暮\n```",
	constant: false,
	enabled: false,
	selective: false,
	order: 0,
	...over,
});

const makePreset = (blocks: Array<{ id: string; name: string; content: string; enabled?: boolean }>): RpPreset => ({
	name: "测试预设",
	samplers: {},
	blocks: blocks.map((b) => ({
		id: b.id,
		name: b.name,
		channel: "postHistory" as const,
		role: "system" as const,
		content: b.content,
		enabled: b.enabled ?? true,
	})),
});

test("parseDeclared：宽松取 JSON（容忍围栏与闲话）；卫生检查死板执行", () => {
	// 正常应答（带围栏与前后闲话）
	const mods = parseDeclared(
		'好的。\n```json\n{"modules":[{"tag":"state1","source":"card","form":"pair","hint":"状态栏"},{"tag":"options","source":"card","form":"pair","hint":"行动选项"}]}\n```',
	);
	assert.ok(mods);
	assert.deepEqual(
		mods.map((m) => [m.tag, m.source, m.form]),
		[
			["state1", "card", "pair"],
			["options", "card", "pair"],
		],
	);

	// 空声明是合法结论（这套卡什么都不要）
	assert.deepEqual(parseDeclared('{"modules":[]}'), []);

	// 纯散文＝跑偏 → null（调用方回退 v0）
	assert.equal(parseDeclared("这张卡有一个状态栏。"), null);

	// 非法标签丢弃、fence 名称放行、同名去重、来源归一
	const dirty = parseDeclared(
		JSON.stringify({
			modules: [
				{ tag: "state 1", form: "pair" }, // 空格标签＝mergeFinalText 认不出 → 弃
				{ tag: "状态栏", form: "fence", source: "card" },
				{ tag: "catsay", form: "pair", source: "preset" },
				{ tag: "catsay", form: "pair", source: "preset" }, // 重复 → 弃
				{ tag: "w2g", form: "pair", source: "别处" }, // 未知来源 → card
			],
		}),
	);
	assert.ok(dirty);
	assert.deepEqual(
		dirty.map((m) => [m.tag, m.source, m.form]),
		[
			["状态栏", "card", "fence"],
			["catsay", "preset", "pair"],
			["w2g", "card", "pair"],
		],
	);

	// 上限 8 条防跑飞
	const many = parseDeclared(
		JSON.stringify({ modules: Array.from({ length: 20 }, (_, i) => ({ tag: `t${i}`, form: "pair" })) }),
	);
	assert.equal(many?.length, 8);
});

test("buildDeclarePrompt：供料含开场白/停用世界书条目/启用预设块；停用预设块不供；零识别器锚", () => {
	const card = makeCard({ book: [makeEntry()] });
	const preset = makePreset([
		{ id: "b1", name: "咪咪点评", content: "每次回复末尾加 <catsay>…</catsay>" },
		{ id: "b2", name: "已关闭的规则", content: "OFF_MARKER", enabled: false },
	]);
	const p = buildDeclarePrompt(card, preset);
	assert.ok(p.userText.includes("你来了。"), "开场白供料");
	assert.ok(p.userText.includes("极简状态栏【可选】（停用）"), "卡内世界书停用条目供料并标注（林悦然教训）");
	assert.ok(p.userText.includes("<catsay>"), "启用预设块供料");
	assert.ok(!p.userText.includes("OFF_MARKER"), "停用预设块不供");
	assert.ok(!p.userText.includes("识别器"), "识别器初判不供料（8/11 实弹：初判行成锚）");
	assert.ok(p.systemPrompt.includes("漏收无害"), "保守判据在场（8/02 教训）");

	// 无预设
	const p2 = buildDeclarePrompt(makeCard(), null);
	assert.ok(!p2.userText.includes("# 预设"));
});

test("declareFingerprint：卡内容/预设内容/预设开关都参与；稳定可复算", () => {
	const card = makeCard();
	const preset = makePreset([{ id: "b1", name: "n", content: "c" }]);
	const fp = declareFingerprint(card, preset);
	assert.equal(declareFingerprint(makeCard(), makePreset([{ id: "b1", name: "n", content: "c" }])), fp, "同料同指纹");
	assert.notEqual(declareFingerprint(makeCard({ firstMes: "改了" }), preset), fp, "卡变则变");
	assert.notEqual(declareFingerprint(card, makePreset([{ id: "b1", name: "n", content: "改" }])), fp, "预设内容变则变");
	assert.notEqual(
		declareFingerprint(card, makePreset([{ id: "b1", name: "n", content: "c", enabled: false }])),
		fp,
		"切开关也重声明（与 presetFingerprint 刻意不同）",
	);
	assert.notEqual(declareFingerprint(card, null), fp, "卸预设则变");
});

test("ensureDeclaredContract：一次声明落缓存；指纹命中零调用；失败不落缓存", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-declare-"));
	try {
		let calls = 0;
		const ok = async () => {
			calls++;
			return '{"modules":[{"tag":"state1","source":"card","form":"pair","hint":"状态栏"}]}';
		};

		const r1 = await ensureDeclaredContract(cwd, "fp-a", ok);
		assert.deepEqual(r1?.map((m) => m.tag), ["state1"]);
		assert.equal(calls, 1);
		assert.ok(existsSync(join(cwd, ".liyuan", "output-contract.declared.json")), "缓存落盘");

		const r2 = await ensureDeclaredContract(cwd, "fp-a", ok);
		assert.deepEqual(r2, r1, "指纹命中直接用缓存");
		assert.equal(calls, 1, "不再调用");

		// 指纹变化 → 重声明；空声明也是合法缓存
		const empty = async () => {
			calls++;
			return '{"modules":[]}';
		};
		const r3 = await ensureDeclaredContract(cwd, "fp-b", empty);
		assert.deepEqual(r3, []);
		assert.equal(calls, 2);
		assert.equal(loadDeclaredContract(cwd)?.fingerprint, "fp-b", "缓存跟随新指纹");
		assert.deepEqual(await ensureDeclaredContract(cwd, "fp-b", ok), [], "空声明命中缓存（不回退 v0）");
		assert.equal(calls, 2);

		// 调用失败 / 应答跑偏 → null，缓存不动
		const before = readFileSync(join(cwd, ".liyuan", "output-contract.declared.json"), "utf8");
		assert.equal(await ensureDeclaredContract(cwd, "fp-c", async () => ({ error: "网络" })), null);
		assert.equal(await ensureDeclaredContract(cwd, "fp-c", async () => "我觉得这卡不错。"), null);
		assert.equal(readFileSync(join(cwd, ".liyuan", "output-contract.declared.json"), "utf8"), before);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
