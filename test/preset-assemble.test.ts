import assert from "node:assert/strict";
import { test } from "node:test";

import {
	assemble,
	assembleRpPreset,
	assembleStPreset,
	rpEntries,
	stEntries,
} from "../src/preset-assemble.ts";
import type { RpPreset } from "../src/preset.ts";

/** 一份最小酒馆预设：覆盖 marker 归位、开关权威源、跨块变量、深度注入、缺失定义 */
const stPreset: Record<string, unknown> = {
	prompts: [
		{ identifier: "vars", name: "变量组", role: "system", content: "{{setvar::风格::白描}}{{setvar::关掉的::不该出现}}" },
		{ identifier: "note", name: "纯注释", role: "system", content: "{{// 这块只有注释}}" },
		{ identifier: "style", name: "文风", role: "system", content: "文风：{{getvar::风格}}；主角 {{char}}。" },
		{ identifier: "worldInfoBefore", name: "World Info (before)", marker: true },
		{ identifier: "charDescription", name: "Char Description", marker: true },
		{ identifier: "scenario", name: "Scenario", marker: true },
		{ identifier: "chatHistory", name: "Chat History", marker: true },
		{ identifier: "tail", name: "末端块", role: "system", content: "末端：保持节奏。" },
		{ identifier: "echo", name: "复述", role: "user", content: "用户刚说：{{lastusermessage}}" },
		{
			identifier: "deepA",
			name: "深注A",
			role: "system",
			content: "深度提醒 A",
			injection_position: 1,
			injection_depth: 4,
			injection_order: 100,
		},
		{
			identifier: "deepB",
			name: "深注B",
			role: "system",
			content: "深度提醒 B",
			injection_position: 1,
			injection_depth: 1,
			injection_order: 100,
		},
		// prompts[].enabled=true 但 order 里关着：权威源是 order
		{ identifier: "offBlock", name: "被关块", role: "system", enabled: true, content: "{{setvar::关掉的::泄漏了}}关闭块正文" },
		// 压根不在 order 里：不参与
		{ identifier: "orphan", name: "游离块", role: "system", content: "游离正文" },
	],
	prompt_order: [
		{ character_id: 999, order: [{ identifier: "style", enabled: true }] },
		{
			character_id: 100001,
			order: [
				{ identifier: "vars", enabled: true },
				{ identifier: "note", enabled: true },
				{ identifier: "offBlock", enabled: false },
				{ identifier: "worldInfoBefore", enabled: true },
				{ identifier: "charDescription", enabled: true },
				{ identifier: "scenario", enabled: true },
				{ identifier: "style", enabled: true },
				{ identifier: "deepA", enabled: true },
				{ identifier: "deepB", enabled: true },
				{ identifier: "chatHistory", enabled: true },
				{ identifier: "tail", enabled: true },
				{ identifier: "echo", enabled: true },
				{ identifier: "ghost", enabled: true },
			],
		},
	],
};

const run = () =>
	assembleStPreset(stPreset, {
		charName: "青云",
		userName: "旅人",
		userText: "我推门进去。",
		materials: {
			worldInfoBefore: "【世界书·前】宗门林立。",
			charDescription: "【角色卡】青云，剑修。",
			// scenario 故意不给料
		},
	});

test("装配：marker 归位——材料按预设作者的位置入列，chatHistory 只切前后", () => {
	const r = run();
	const beforeIds = r.before.map((p) => p.id);
	const afterIds = r.after.map((p) => p.id);

	assert.deepEqual(beforeIds, ["worldInfoBefore", "charDescription", "style"]);
	assert.deepEqual(afterIds, ["tail", "echo"]);

	const wi = r.before.find((p) => p.id === "worldInfoBefore");
	assert.equal(wi?.source, "marker");
	assert.equal(wi?.text, "【世界书·前】宗门林立。");
	assert.ok(!r.before.some((p) => p.id === "chatHistory"), "chatHistory 只标位置，不产生片段");
});

test("装配：marker 无料不入列，但记进报告与 markers", () => {
	const r = run();
	assert.ok(!r.before.some((p) => p.id === "scenario"), "没给料的槽位不产出空片段");
	assert.deepEqual(
		r.markers.map((m) => [m.id, m.filled]),
		[
			["worldInfoBefore", true],
			["charDescription", true],
			["scenario", false],
			["chatHistory", true],
		],
	);
	assert.equal(r.report.find((i) => i.identifier === "scenario")?.action, "marker 无料");
});

test("装配：权威开关是 prompt_order，关闭块不求值（setvar 副作用不发生）", () => {
	const r = run();
	assert.ok(!r.report.some((i) => i.identifier === "orphan"), "不在 order 里的块根本不参与");
	assert.equal(r.report.find((i) => i.identifier === "offBlock")?.action, "关闭");
	assert.equal(r.vars.get("关掉的"), "不该出现", "关闭块的 setvar 不许覆盖启用块设的值");
});

test("装配：setvar 块自己零字被丢，值由后面的 getvar 在别处吐出来", () => {
	const r = run();
	assert.equal(r.report.find((i) => i.identifier === "vars")?.action, "零字");
	assert.equal(r.report.find((i) => i.identifier === "note")?.action, "零字");
	assert.equal(r.before.find((p) => p.id === "style")?.text, "文风：白描；主角 青云。");
});

test("装配：深度注入单列不入前后段，按 depth 再 order 稳定排序", () => {
	const r = run();
	assert.deepEqual(
		r.depth.map((p) => [p.id, p.depth]),
		[
			["deepB", 1],
			["deepA", 4],
		],
	);
	assert.ok(!r.before.some((p) => p.id === "deepA"), "深度注入不占相对定位");
	assert.ok(!r.after.some((p) => p.id === "deepA"));
});

test("装配：role 保真、缺失定义记账、lastusermessage 破口点名", () => {
	const r = run();
	assert.equal(r.after.find((p) => p.id === "echo")?.role, "user");
	assert.equal(r.report.find((i) => i.identifier === "ghost")?.action, "缺失定义");
	assert.deepEqual(r.usesLastUserMessage, ["echo"]);
	assert.equal(r.after.find((p) => p.id === "echo")?.text, "用户刚说：我推门进去。");
});

test("装配：无 prompt_order 时退回 prompts 原序", () => {
	const r = assembleStPreset({
		prompts: [
			{ identifier: "a", name: "A", role: "system", content: "甲" },
			{ identifier: "b", name: "B", role: "system", content: "乙", enabled: false },
		],
	});
	assert.deepEqual(r.before.map((p) => p.id), ["a"]);
	assert.equal(r.report.find((i) => i.identifier === "b")?.action, "关闭");
});

test("旧梨园格式：channel 二分补合成 chatHistory，marker 归位不可用", () => {
	const preset: RpPreset = {
		name: "旧格式",
		samplers: {},
		blocks: [
			{ id: "s1", name: "系统块", channel: "system", role: "system", content: "{{setvar::k::V}}系统正文", enabled: true },
			{ id: "s2", name: "关块", channel: "system", role: "system", content: "不该出现", enabled: false },
			{ id: "p1", name: "末端块", channel: "postHistory", role: "system", content: "末端 {{getvar::k}}", enabled: true },
			{ id: "p2", name: "深注", channel: "postHistory", role: "user", content: "深度", enabled: true, depth: 2 },
		],
	};
	const entries = rpEntries(preset);
	assert.ok(entries.some((e) => e.identifier === "chatHistory" && e.marker), "补一个合成 chatHistory 标位置");

	const r = assembleRpPreset(preset);
	assert.deepEqual(r.before.map((p) => p.id), ["s1"]);
	assert.deepEqual(r.after.map((p) => p.id), ["p1"]);
	assert.equal(r.after[0]?.text, "末端 V", "跨块变量表照样贯通");
	assert.deepEqual(r.depth.map((p) => [p.id, p.depth]), [["p2", 2]]);
	assert.ok(!r.markers.some((m) => m.id === "charDescription"), "旧格式没有真 marker 可归位");
});

test("旧梨园格式：全 system 通道也补末尾 chatHistory，after 为空", () => {
	const r = assembleRpPreset({
		name: "全前",
		samplers: {},
		blocks: [{ id: "s1", name: "块", channel: "system", role: "system", content: "正文", enabled: true }],
	});
	assert.deepEqual(r.before.map((p) => p.id), ["s1"]);
	assert.deepEqual(r.after, []);
});

test("装配：清单外宏剥除并上报，不发字面量", () => {
	const r = assemble(
		stEntries({
			prompts: [{ identifier: "a", name: "A", role: "system", content: "前{{noSuchMacro::x}}后" }],
		}),
	);
	assert.equal(r.before[0]?.text, "前后");
	assert.deepEqual(r.unsupported, ["nosuchmacro"]);
});
