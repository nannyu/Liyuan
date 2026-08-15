import assert from "node:assert/strict";
import { test } from "node:test";

import {
	buildImportBlock,
	cleanChat,
	cleanChatText,
	parseStChat,
	serializeForImportSummary,
} from "../src/chatlog.ts";

const header = JSON.stringify({ user_name: "阿远", character_name: "青梧", create_date: "2025-1-1@00h00m00s" });
const line = (o: object) => JSON.stringify(o);

test("解析：首行元数据、角色分配、comment 旁注跳过、swipe 回退", () => {
	const jsonl = [
		header,
		line({ name: "青梧", is_user: false, mes: "*她看着你醒来。*" }),
		line({ name: "阿远", is_user: true, mes: "这里是哪里？" }),
		line({ name: "阿远", is_system: true, mes: "备忘：回头查一下设定", extra: { type: "comment" } }),
		line({ name: "青梧", is_user: false, mes: "", swipes: ["第一版", "选中的第二版"], swipe_id: 1 }),
		"这一行是损坏的 JSON {{{",
		line({ name: "阿远", is_user: true, mes: "   " }),
	].join("\n");
	const { meta, messages } = parseStChat(jsonl);
	assert.equal(meta.userName, "阿远");
	assert.equal(meta.charName, "青梧");
	assert.equal(messages.length, 3, "comment 旁注/损坏行/空白行都应跳过");
	assert.equal(messages[0].role, "assistant");
	assert.equal(messages[1].role, "user");
	assert.equal(messages[2].text, "选中的第二版", "mes 为空时回退到选中 swipe");
});

test("解析：/hide 隐藏楼层（is_system）纳入导入——程序卡整段隐藏历史不得只剩最后一条", () => {
	// 程序卡（状态栏 HTML 卡）常把除最后一层外全部 /hide：is_system=true 但剧情仍在
	const jsonl = [
		header,
		line({ name: "青梧", is_user: false, is_system: true, mes: "第一幕开场。" }),
		line({ name: "阿远", is_user: true, is_system: true, mes: "我推门进去。" }),
		line({ name: "青梧", is_user: false, is_system: true, mes: "*门轴吱呀作响。*" }),
		line({ name: "青梧", is_user: false, mes: "「你终于来了。」（唯一未隐藏层）" }),
	].join("\n");
	const { messages, hiddenCount } = parseStChat(jsonl);
	assert.equal(messages.length, 4, "隐藏楼层是剧情本体，必须全部纳入");
	assert.equal(hiddenCount, 3);
	assert.equal(messages[0].hidden, true);
	assert.equal(messages[0].role, "assistant", "隐藏层保留 is_user 角色判定");
	assert.equal(messages[1].role, "user");
	assert.equal(messages[3].hidden, undefined, "未隐藏层不带标记");
});

test("解析：非 ST 文件报错", () => {
	assert.throws(() => parseStChat(""), /空文件/);
	assert.throws(() => parseStChat('{"foo": 1}'), /user_name/);
});

test("清洗：提取模式——只保留正文标签内内容，多段拼接，无命中回退剥离", () => {
	const mixed = "<thinking>先想想剧情走向</thinking>\n<content>*她转身。*</content>\n【状态栏】HP:100\n<content>「你醒了。」</content>";
	const out = cleanChatText(mixed, { extractTag: "content" });
	assert.equal(out, "*她转身。*\n\n「你醒了。」");

	const noTag = "<thinking>只想没写正文标签</thinking>\n*她犹豫了一下。*";
	assert.equal(cleanChatText(noTag, { extractTag: "content" }), "*她犹豫了一下。*", "无标签命中的轮次回退为剥离模式");
});

test("清洗：思维链 fold 整块删、悬挂开标签剥到末尾、HTML 注释去除", () => {
	const raw = "<!-- 预设注释 -->\n*正文开始。*\n<think>推理过程</think>\n\n\n「对白。」\n<status>HP:5";
	const out = cleanChatText(raw);
	// <think> fold：整块删。<status> 不再是 panel（状态栏渲染归作者正则，非名单）：
	// unwrap 剥标签留内容——悬挂开标签吃到末尾，HP:5 作为正文保留。
	// 送模侧本应由作者的 promptOnly 正则剥除，那条通道尚未接（已知遗留）。
	assert.ok(!out.includes("推理过程"), "思维链整块删");
	assert.ok(!out.includes("<status>"), "标签剥掉");
	assert.ok(out.includes("*正文开始。*") && out.includes("「对白。」"), "正文保留");
	assert.ok(out.includes("HP:5"), "状态栏内容 unwrap 留正文（待接 promptOnly 通道）");
});

test("清洗：三段式卡输出（analysis fold 删 / status 与 plot unwrap 留内容）", () => {
	const raw = "<descriptive_analysis>1. 意图…</descriptive_analysis>\n<normal_status>```yaml\n时间: 清晨\n```</normal_status>\n<plot>\n*正文在此。*\n</plot>";
	const out = cleanChatText(raw);
	assert.ok(!out.includes("意图"), "analysis fold：整块删");
	assert.ok(!out.includes("<normal_status>") && !out.includes("<plot>"), "标签剥掉");
	assert.ok(out.includes("*正文在此。*"), "plot 正文保留");
	assert.ok(out.includes("时间: 清晨"), "状态栏内容 unwrap 留（待接 promptOnly 通道）");
});

test("清洗批量：清空的消息被丢弃", () => {
	const msgs = [
		{ role: "assistant" as const, name: "S", text: "<think>纯思考无正文</think>" },
		{ role: "user" as const, name: "U", text: "还在。" },
	];
	const out = cleanChat(msgs);
	assert.equal(out.length, 1);
	assert.equal(out[0].text, "还在。");
});

test("前情块：接管声明、摘要与实录分节、发言人标注", () => {
	const block = buildImportBlock({
		summary: "第一天：相遇。",
		recentTurns: [
			{ role: "user", name: "阿远", text: "走吧。" },
			{ role: "assistant", name: "青梧", text: "*她点头。*" },
		],
		charName: "青梧",
		userName: "阿远",
	});
	assert.ok(block.includes("【前情导入】"));
	assert.ok(block.includes("忽略更早的开场白"));
	assert.ok(block.includes("── 前情提要 ──"));
	assert.ok(block.includes("── 最近对白实录（原文） ──"));
	assert.ok(block.includes("阿远：走吧。"));
	assert.ok(block.includes("青梧：*她点头。*"));

	const noSummary = buildImportBlock({ summary: "", recentTurns: [], charName: "S", userName: "U" });
	assert.ok(!noSummary.includes("前情提要"), "无摘要时不应有空节");
});

test("摘要输入：超长历史从尾部截取并标注", () => {
	const msgs = Array.from({ length: 50 }, (_, i) => ({
		role: "assistant" as const,
		name: "S",
		text: `第${i}轮`.padEnd(50, "字"),
	}));
	const text = serializeForImportSummary(msgs, "U", 500);
	assert.ok(text.length < 700);
	assert.ok(text.startsWith("（更早的剧情因长度上限未纳入摘要）"));
	assert.ok(text.includes("第49轮"), "必须保住最新内容");
});
