import assert from "node:assert/strict";
import test from "node:test";
import { splitMarkdownParts, splitRpInline, splitTextRuns } from "../web/src/markdown.ts";

test("splitMarkdownParts: 无围栏整段 text", () => {
	const p = splitMarkdownParts("你好\n\n世界");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
	if (p[0].kind === "text") assert.equal(p[0].text, "你好\n\n世界");
});

test("splitMarkdownParts: Options 形态无 lang 围栏 → code 段", () => {
	const text = "洛清霜说完。\n\n```\n选择1: 【留下】\n选择2: 【下山】\n```\n";
	const p = splitMarkdownParts(text);
	assert.equal(p.length, 2);
	assert.equal(p[0].kind, "text");
	if (p[0].kind === "text") assert.ok(p[0].text.includes("洛清霜说完"));
	assert.equal(p[1].kind, "code");
	if (p[1].kind === "code") {
		assert.equal(p[1].lang, "");
		assert.ok(p[1].code.includes("选择1: 【留下】"));
		assert.ok(p[1].code.includes("选择2: 【下山】"));
		assert.ok(!p[1].code.includes("```"));
	}
});

test("splitMarkdownParts: 带 lang 的围栏", () => {
	const p = splitMarkdownParts("前\n```yaml\n时间: 晨\n```\n后");
	assert.equal(p.length, 3);
	assert.equal(p[0].kind, "text");
	assert.equal(p[1].kind, "code");
	if (p[1].kind === "code") {
		assert.equal(p[1].lang, "yaml");
		assert.equal(p[1].code, "时间: 晨");
	}
	assert.equal(p[2].kind, "text");
	if (p[2].kind === "text") assert.ok(p[2].text.includes("后"));
});

test("splitMarkdownParts: 行中 ``` 不切（非行首）", () => {
	const p = splitMarkdownParts("他说 ```不是围栏");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("splitMarkdownParts: 未闭合围栏当文本", () => {
	const p = splitMarkdownParts("```\n只有开头");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

/* ── GFM 管道表格（纯预设「角色表」等） ── */

test("表格: 素材截图形态——多列角色表切成 table 段", () => {
	const text = [
		"角色表",
		"",
		"| 名字 | 社会身份 | MBTI | 依恋人格 | 实力 |",
		"|------|----------|------|----------|------|",
		"| 青梧 | 听雨轩掌柜 | ISTJ | 疏离型 | 精明掌柜 |",
		"",
		"serial:No.001",
	].join("\n");
	const p = splitMarkdownParts(text);
	assert.equal(p.length, 3);
	assert.equal(p[0].kind, "text");
	if (p[0].kind === "text") assert.ok(p[0].text.includes("角色表"));
	assert.equal(p[1].kind, "table");
	if (p[1].kind === "table") {
		assert.deepEqual(p[1].header, ["名字", "社会身份", "MBTI", "依恋人格", "实力"]);
		assert.equal(p[1].rows.length, 1);
		assert.deepEqual(p[1].rows[0], ["青梧", "听雨轩掌柜", "ISTJ", "疏离型", "精明掌柜"]);
	}
	assert.equal(p[2].kind, "text");
	if (p[2].kind === "text") assert.ok(p[2].text.includes("serial:No.001"));
});

test("表格: 行列数不齐——截断/补空对齐表头", () => {
	const text = "| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 | 4 |\n| 5 |";
	const p = splitMarkdownParts(text);
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "table");
	if (p[0].kind === "table") {
		assert.deepEqual(p[0].rows[0], ["1", "2", "3"]);
		assert.deepEqual(p[0].rows[1], ["5", "", ""]);
	}
});

test("表格: 单列不算表（竖线装饰防误伤）", () => {
	const text = "| 只有一格 |\n|---|\n| x |";
	const p = splitMarkdownParts(text);
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("表格: 表头与分隔行列数不一致 → 不认", () => {
	const text = "| A | B |\n|---|---|---|\n| 1 | 2 |";
	const p = splitMarkdownParts(text);
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("表格: 对齐冒号分隔行照认", () => {
	const text = "| 左 | 中 | 右 |\n|:---|:---:|---:|\n| a | b | c |";
	const p = splitMarkdownParts(text);
	assert.equal(p[0].kind, "table");
});

test("表格: 围栏代码块里的管道行不切表", () => {
	const text = "```\n| A | B |\n|---|---|\n| 1 | 2 |\n```";
	const p = splitMarkdownParts(text);
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "code");
});

/* ── 字母选项列表（纯预设「他人推动」等） ── */

test("选项: A–D 升序 ≥3 项切成 options 段", () => {
	const text = "他人推动\n\nA.快进至次日清晨\nB.快进至三日后\nC.快进至第七日傍晚\nD.快进至深夜\n\n尾注";
	const p = splitMarkdownParts(text);
	assert.equal(p.length, 3);
	assert.equal(p[1].kind, "options");
	if (p[1].kind === "options") {
		assert.deepEqual(
			p[1].items.map((it) => it.key),
			["A", "B", "C", "D"],
		);
		assert.equal(p[1].items[0].text, "快进至次日清晨");
	}
});

test("选项: 素材截图形态——项间单空行分组不断链（D|E、H|I 之间空行）", () => {
	const lines = [];
	for (let i = 0; i < 12; i++) {
		const key = String.fromCharCode(65 + i);
		lines.push(`${key}.*时间*选项内容${key}`);
		if (key === "D" || key === "H") lines.push("");
	}
	const p = splitMarkdownParts(lines.join("\n"));
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "options");
	if (p[0].kind === "options") {
		assert.equal(p[0].items.length, 12);
		assert.equal(p[0].items[11].key, "L");
		assert.equal(p[0].items[0].text, "*时间*选项内容A");
	}
});

test("选项: 只有 2 项不认（防误伤正文）", () => {
	const p = splitMarkdownParts("A.第一项\nB.第二项");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("选项: 不从 A 起不认", () => {
	const p = splitMarkdownParts("B.第一项\nC.第二项\nD.第三项");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("选项: 乱序断链后不足 3 项 → 整段留文本", () => {
	const p = splitMarkdownParts("A.第一项\nC.跳字母\nD.第三项");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "text");
});

test("选项: 顿号/全角句点变体照认", () => {
	const p = splitMarkdownParts("A、留下\nB、下山\nC．回望");
	assert.equal(p.length, 1);
	assert.equal(p[0].kind, "options");
	if (p[0].kind === "options") assert.deepEqual(p[0].items.map((it) => it.text), ["留下", "下山", "回望"]);
});

test("splitTextRuns: 表格与选项混排各归各段", () => {
	const text = "| A | B |\n|---|---|\n| 1 | 2 |\n\n过场\n\nA.选一\nB.选二\nC.选三";
	const runs = splitTextRuns(text);
	assert.deepEqual(
		runs.map((r) => r.kind),
		["table", "text", "options"],
	);
});

/* ── 行内 RP/markdown 标记 ── */

test("splitRpInline: **粗体** 吃星号", () => {
	const t = splitRpInline("这是**关键**一句");
	assert.deepEqual(t, [
		{ kind: "plain", text: "这是" },
		{ kind: "strong", text: "关键" },
		{ kind: "plain", text: "一句" },
	]);
});

test("splitRpInline: *动作* 斜体、引号对白着色保留引号", () => {
	const t = splitRpInline('*抬眼* "客官怎么称呼？" 「雨停了」');
	assert.deepEqual(t, [
		{ kind: "em", text: "抬眼" },
		{ kind: "plain", text: " " },
		{ kind: "quote", text: '"客官怎么称呼？"' },
		{ kind: "plain", text: " " },
		{ kind: "quote", text: "「雨停了」" },
	]);
});

test("splitRpInline: 粗体与斜体同行共存互不吞", () => {
	const t = splitRpInline("**重点**与*轻描*并行");
	assert.deepEqual(
		t.map((x) => x.kind),
		["strong", "plain", "em", "plain"],
	);
});

test("splitRpInline: 全角引号“对白”着色", () => {
	const t = splitRpInline("她说“雨停了再走不迟”便转身");
	assert.equal(t[1].kind, "quote");
	assert.equal(t[1].text, "“雨停了再走不迟”");
});

test("splitRpInline: 无标记整行 plain", () => {
	assert.deepEqual(splitRpInline("平平无奇的一行"), [{ kind: "plain", text: "平平无奇的一行" }]);
});

test("splitTextRuns: 连续行首 > 切成引用块，> 不再当字面文本", () => {
	// 卡作者用 markdown 引用块写「导演附录」这类旁注（v1.4.1 实锤：梨园把 > 原样印出、每行各成一段）
	const src = "上一段。\n\n> **导演附录**\n> 当前节点：失窃当夜。\n> 人物状态：睡熟。\n\n收尾。";
	const parts = splitTextRuns(src);
	const kinds = parts.map((p) => p.kind);
	assert.deepEqual(kinds, ["text", "blockquote", "text"]);
	const bq = parts[1];
	assert.ok(bq.kind === "blockquote");
	assert.deepEqual(bq.kind === "blockquote" ? bq.lines : [], ["**导演附录**", "当前节点：失窃当夜。", "人物状态：睡熟。"]);
	assert.ok(!JSON.stringify(bq).includes(">"), "引用标记已剥掉");
});

test("splitTextRuns: 表格与选项列表的既有行为不被引用块判据抢走", () => {
	const table = splitTextRuns("| 名 | 值 |\n| --- | --- |\n| a | 1 |");
	assert.equal(table[0].kind, "table");
	const options = splitTextRuns("A. 一\nB. 二\nC. 三");
	assert.equal(options[0].kind, "options");
	// 正文里句中出现的 > 不触发（判据只认行首）
	assert.equal(splitTextRuns("他说 a > b 成立。")[0].kind, "text");
});
