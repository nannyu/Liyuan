import assert from "node:assert/strict";
import test from "node:test";
import { expandSkinReplacement } from "../src/cardSkin.ts";
import {
	buildCardFrontSnapshot,
	displayRules,
	extractRegexScripts,
	isSkinEnabled,
	promptRules,
	setSkinEnabled,
} from "../src/cardfront.ts";

/** 淫宫美人录实卡形态(内联夹具,不读盘,测试自包含) */
const skinScript = {
	scriptName: "状态栏",
	findRegex: "/<StatusBlock>/gs",
	replaceString: '<div style="background-color: rgba(0, 0, 0, 0.5);"><status>',
	placement: [2],
	disabled: false,
	markdownOnly: true,
	promptOnly: false,
	trimStrings: [],
};
/** 大乾风华录:promptOnly 清理向,显示层必须排除 */
const promptOnlyScript = {
	scriptName: "删除描写分析",
	findRegex: "/<descriptive_analysis>[\\s\\S]*</descriptive_analysis>/gm",
	replaceString: "",
	placement: [2],
	disabled: false,
	markdownOnly: false,
	promptOnly: true,
	trimStrings: [],
};

test("extractRegexScripts: data.extensions 与顶层 extensions 都认,缺失返回空", () => {
	assert.equal(extractRegexScripts({ data: { extensions: { regex_scripts: [skinScript] } } }).length, 1);
	assert.equal(extractRegexScripts({ extensions: { regex_scripts: [skinScript] } }).length, 1);
	assert.deepEqual(extractRegexScripts({ name: "x" }), []);
	assert.deepEqual(extractRegexScripts({ data: { extensions: { regex_scripts: "bad" } } }), []);
});

test("displayRules: 显示向保留,promptOnly/disabled/非AI输出排除", () => {
	const rules = displayRules([
		skinScript,
		promptOnlyScript,
		{ ...skinScript, scriptName: "已停用", disabled: true },
		{ ...skinScript, scriptName: "只管用户输入", placement: [1] },
	]);
	assert.equal(rules.length, 1);
	assert.equal(rules[0].name, "状态栏");
	assert.equal(rules[0].source, "<StatusBlock>");
	assert.equal(rules[0].flags, "gs");
	assert.ok(rules[0].replace.startsWith("<div"));
});

test("promptRules: 送模侧收 promptOnly 与破坏性，排除 markdownOnly/disabled/非AI输出", () => {
	const pr = promptRules([
		skinScript, // markdownOnly → 送模侧不收
		promptOnlyScript, // promptOnly → 收
		{ ...skinScript, scriptName: "破坏性", markdownOnly: false, promptOnly: false, findRegex: "<w2g>([\\s\\S]*?)<\\/w2g>" }, // 两个only都没勾 → 收
		{ ...skinScript, scriptName: "已停用", disabled: true },
		{ ...skinScript, scriptName: "只管用户输入", placement: [1] },
	]);
	assert.deepEqual(
		pr.map((r) => r.name),
		["删除描写分析", "破坏性"],
		"markdownOnly/disabled/非AI输出排除，promptOnly 与破坏性收",
	);
	assert.equal(pr[0].replace, "", "替换串原样带下去");
});

test("displayRules: 裸模式串(无 /…/ 包裹)按字面正则源处理", () => {
	const rules = displayRules([{ ...skinScript, findRegex: "<StatusBlock>" }]);
	assert.equal(rules.length, 1);
	assert.equal(rules[0].source, "<StatusBlock>");
	assert.equal(rules[0].flags, "g"); // 无声明时默认 g,保证全文替换
});

test("displayRules: 非法正则跳过不抛", () => {
	const warnings: string[] = [];
	const oldWarn = console.warn;
	try {
		console.warn = (...args) => warnings.push(args.join(" "));
		const rules = displayRules([{ ...skinScript, findRegex: "/([unclosed/g" }, skinScript]);
		assert.equal(rules.length, 1);
		assert.ok(warnings.some((w) => w.includes("正则无法解析")));
	} finally {
		console.warn = oldWarn;
	}
});

test("displayRules: trimStrings 随规则带下去(不再整条丢),在替换时对捕获组生效", () => {
	const rules = displayRules([{ ...skinScript, trimStrings: ["x", ""] }]);
	assert.equal(rules.length, 1, "有 trimStrings 的规则必须收下——整条丢会让作者的渲染凭空消失");
	assert.deepEqual(rules[0].trim, ["x"], "空串滤掉，其余原样带下去");
	assert.equal(displayRules([{ ...skinScript, trimStrings: [] }])[0].trim, undefined, "空数组不带 trim 字段");
});

test("trimStrings 语义与 ST filterString 同义:只削代入的捕获组,不动模板字面", () => {
	// ST engine.js:457 —— 对代入替换串的那段文本逐条 replaceAll 删除
	assert.equal(expandSkinReplacement("[$1]", "整段", ["a删b删c"], ["删"]), "[abc]");
	assert.equal(expandSkinReplacement("{{match}}", "前删后", [], ["删"]), "前后");
	assert.equal(expandSkinReplacement("$&", "前删后", [], ["删"]), "前后");
	// 模板里的字面文本不受影响——只有代入的部分被削
	assert.equal(expandSkinReplacement("删[$1]删", "m", ["x"], ["删"]), "删[x]删");
	// 无 trim 时行为与改动前逐字一致
	assert.equal(expandSkinReplacement("[$1]", "m", ["a删b"]), "[a删b]");
});

test("buildCardFrontSnapshot: 预设自带 regex_scripts 一并收下,且排在卡规则之前", () => {
	// 酒馆三源顺序 GLOBAL → PRESET → SCOPED(engine.js:108-133);梨园无 GLOBAL
	const cardRaw = { data: { name: "卡", extensions: { regex_scripts: [{ ...skinScript, scriptName: "卡的" }] } } };
	const presetRaw = { prompts: [], extensions: { regex_scripts: [{ ...skinScript, scriptName: "预设的" }] } };

	const both = buildCardFrontSnapshot({ card: "c.png", userName: "u" }, cardRaw, "卡", presetRaw);
	assert.deepEqual(
		both.rules.map((r) => r.name),
		["预设的", "卡的"],
		"预设规则必须在前——后一条吃的是前一条的产物",
	);

	// 只有预设有正则:也算有皮肤(此前预设那份从未被读过,状态栏只能靠名字名单猜)
	const presetOnly = buildCardFrontSnapshot({ card: "c.png", userName: "u" }, null, "", presetRaw);
	assert.equal(presetOnly.hasSkin, true);
	assert.deepEqual(presetOnly.rules.map((r) => r.name), ["预设的"]);

	// 不传预设 = 改动前的行为,逐字不变
	const cardOnly = buildCardFrontSnapshot({ card: "c.png", userName: "u" }, cardRaw, "卡");
	assert.deepEqual(cardOnly.rules.map((r) => r.name), ["卡的"]);
});

test("skin 开关:默认开,cardSkinOff 关,setSkinEnabled 幂等往返", () => {
	const cfg = { card: "assets/cards/a.png" } as never;
	assert.equal(isSkinEnabled({ card: "assets/cards/a.png" }, "assets/cards/a.png"), true);
	const off = setSkinEnabled(cfg, "assets/cards/a.png", false);
	assert.equal(isSkinEnabled(off, "assets/cards/a.png"), false);
	const on = setSkinEnabled(off, "assets/cards/a.png", true);
	assert.equal(isSkinEnabled(on, "assets/cards/a.png"), true);
	assert.deepEqual(on.cardSkinOff, []);
});

test("displayRules: substituteRegex 非零的规则整条跳过,warn", () => {
	const warnings: string[] = [];
	const oldWarn = console.warn;
	try {
		console.warn = (...args) => warnings.push(args.join(" "));
		const rules = displayRules([{ ...skinScript, substituteRegex: 1 }]);
		assert.equal(rules.length, 0);
		assert.ok(warnings.some((w) => w.includes("substituteRegex")));
	} finally {
		console.warn = oldWarn;
	}
});

test("displayRules: minDepth/maxDepth 字段忽略但 warn,规则仍应用", () => {
	const warnings: string[] = [];
	const oldWarn = console.warn;
	try {
		console.warn = (...args) => warnings.push(args.join(" "));
		const rules = displayRules([{ ...skinScript, minDepth: 2 }]);
		assert.equal(rules.length, 1);
		assert.ok(warnings.some((w) => w.includes("深度限定")));
	} finally {
		console.warn = oldWarn;
	}
});

test("buildCardFrontSnapshot: hello/REST 同源载荷", () => {
	const raw = { data: { name: "美人录", extensions: { regex_scripts: [skinScript] } } };
	const snap = buildCardFrontSnapshot(
		{ card: "assets/cards/a.png", userName: "旅人" },
		raw,
		"美人录",
	);
	assert.equal(snap.enabled, true);
	assert.equal(snap.hasSkin, true);
	assert.equal(snap.rules.length, 1);
	assert.equal(snap.charName, "美人录");
	assert.equal(snap.userName, "旅人");

	const off = buildCardFrontSnapshot(
		{ card: "assets/cards/a.png", cardSkinOff: ["assets/cards/a.png"], userName: "旅人" },
		raw,
		"美人录",
	);
	assert.equal(off.enabled, false);
	assert.equal(off.hasSkin, true); // 卡上有皮;前端用 enabled 决定是否应用
	assert.equal(off.rules.length, 1);

	const empty = buildCardFrontSnapshot({ card: "x", userName: "u" }, null, "");
	assert.equal(empty.hasSkin, false);
	assert.deepEqual(empty.rules, []);
});
