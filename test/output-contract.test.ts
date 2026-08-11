import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	contractFromCard,
	curtainInjection,
	isPlaceholderStatusFormat,
	parseContract,
	syncOutputContract,
} from "../src/stage/output-contract.ts";

test("isPlaceholderStatusFormat：自闭合占位与成对形态分型（D4 迁入合约生成）", () => {
	assert.equal(isPlaceholderStatusFormat("`<StatusPlaceHolderImpl/>`"), true);
	assert.equal(isPlaceholderStatusFormat("`<state1>…</state1>`"), false);
	assert.equal(isPlaceholderStatusFormat("<Tag/>"), true);
});

test("contractFromCard：卡状态栏格式 → v0 模块（同标签去重、形态随格式条目）", () => {
	const mods = contractFromCard([
		"`<state1>…</state1>`（或卡约定的 state 序号）",
		"`<StatusBlock>…</StatusBlock>`",
		"`<StatusBlock>…</StatusBlock>`",
		"`<StatusPlaceHolderImpl/>`",
	]);
	assert.deepEqual(
		mods.map((m) => [m.tag, m.form, m.source]),
		[
			["state1", "pair", "card"],
			["StatusBlock", "pair", "card"],
			["StatusPlaceHolderImpl", "placeholder", "card"],
		],
	);
	assert.deepEqual(contractFromCard([]), [], "无状态栏卡 → 空合约");
	// 通用/指代性标签不成模块（与规则提取同一份判定，不另立名单）
	assert.deepEqual(contractFromCard(["`<details>…</details>`", "`<user/>`"]), []);
});

test("curtainInjection：谢幕注入文案即规格（§2.3）；空合约不注入", () => {
	const mods = contractFromCard(["`<state1>…</state1>`"]);
	assert.equal(
		curtainInjection(mods),
		"【谢幕】记账已毕。输出本拍格式块：`<state1>` 状态栏。输出完本拍结束。",
	);
	// hint 是点名标签（署名数据：声明步/用户文件供给）；无 hint 的非卡模块裸标签点名
	assert.equal(
		curtainInjection([...mods, { tag: "catsay", source: "preset", form: "pair", hint: "咪咪点评" }]),
		"【谢幕】记账已毕。输出本拍格式块：`<state1>` 状态栏、`<catsay>` 咪咪点评。输出完本拍结束。",
	);
	assert.equal(
		curtainInjection([{ tag: "options", source: "user", form: "pair" }]),
		"【谢幕】记账已毕。输出本拍格式块：`<options>`。输出完本拍结束。",
	);
	// fence 块没有标签，以名称点名（围栏式状态栏 8/10 直丢缺陷的机制解）
	assert.equal(
		curtainInjection([{ tag: "状态栏", source: "card", form: "fence", hint: "emoji 围栏状态栏" }]),
		"【谢幕】记账已毕。输出本拍格式块：「状态栏」（``` 围栏块）。输出完本拍结束。",
	);
	// 占位符形态以自闭合点名
	assert.equal(
		curtainInjection([{ tag: "StatusPlaceHolderImpl", source: "card", form: "placeholder" }]),
		"【谢幕】记账已毕。输出本拍格式块：`<StatusPlaceHolderImpl/>` 状态栏。输出完本拍结束。",
	);
	assert.equal(curtainInjection([]), undefined, "合约为空 → 不注入，拍自然收束");
});

test("syncOutputContract：生成落盘；识别结果变化时跟随重生成（未被用户改过）", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-contract-"));
	try {
		const gen1 = contractFromCard(["`<state1>…</state1>`"]);
		const r1 = syncOutputContract(cwd, gen1);
		assert.deepEqual(r1, gen1);
		const file = join(cwd, ".liyuan", "output-contract.json");
		assert.ok(existsSync(file), "合约文件落盘（用户可见可改）");
		assert.deepEqual(parseContract(readFileSync(file, "utf8")), gen1);

		// 换卡：识别结果变化 → 文件跟随重生成（没人改过）
		const gen2 = contractFromCard(["`<StatusBlock>…</StatusBlock>`"]);
		const r2 = syncOutputContract(cwd, gen2);
		assert.deepEqual(r2, gen2);
		assert.deepEqual(parseContract(readFileSync(file, "utf8")), gen2, "文件同步更新");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("syncOutputContract：用户改过 → 以文件为准且不再覆盖（改了以文件为准）", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-contract2-"));
	try {
		const gen = contractFromCard(["`<state1>…</state1>`"]);
		syncOutputContract(cwd, gen);
		const file = join(cwd, ".liyuan", "output-contract.json");
		// 用户手改：加了一个 catsay 模块
		const edited = JSON.stringify({
			modules: [
				{ tag: "state1", source: "card", form: "pair" },
				{ tag: "catsay", source: "preset", form: "pair", hint: "咪咪点评" },
			],
		});
		writeFileSync(file, edited, "utf8");

		const r = syncOutputContract(cwd, gen);
		assert.deepEqual(
			r.map((m) => m.tag),
			["state1", "catsay"],
			"用户文件生效",
		);
		assert.equal(readFileSync(file, "utf8"), edited, "用户文件不被覆盖");

		// 之后识别结果变化也不覆盖（用户主权持续）
		const r2 = syncOutputContract(cwd, contractFromCard(["`<StatusBlock>…</StatusBlock>`"]));
		assert.deepEqual(r2.map((m) => m.tag), ["state1", "catsay"], "仍以用户文件为准");
		assert.equal(readFileSync(file, "utf8"), edited);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("syncOutputContract：用户文件损坏 → 回退内存生成，但不动用户文件", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-contract3-"));
	try {
		const gen = contractFromCard(["`<state1>…</state1>`"]);
		syncOutputContract(cwd, gen);
		const file = join(cwd, ".liyuan", "output-contract.json");
		writeFileSync(file, "{broken json", "utf8");
		const r = syncOutputContract(cwd, gen);
		assert.deepEqual(r, gen, "解析失败回退生成结果");
		assert.equal(readFileSync(file, "utf8"), "{broken json", "不覆盖用户文件（改坏了也归用户）");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
