import assert from "node:assert/strict";
import { test } from "node:test";

import {
	applyDraftOps,
	DRAFT_DOC_TYPE,
	DRAFT_OP_TYPE,
	draftTurnText,
	emptyDraftRules,
	extractDraftBody,
	extractDraftRules,
	isAuditLine,
	isPoliceBlock,
	lastSubstantiveRole,
	parseDraftOp,
	resolveDraftEdit,
	stripAuditLines,
} from "../src/draft.ts";

const user = (text: string) => ({ role: "user", content: text });
const asst = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const op = (oldStr: string, newStr: string) => ({
	role: "custom",
	customType: DRAFT_OP_TYPE,
	content: JSON.stringify({ old: oldStr, new: newStr }),
});
const doc = (text: string) => ({ role: "custom", customType: DRAFT_DOC_TYPE, content: text });

test("applyDraftOps：补丁应用到前方最近的含 old 消息，补丁条目从流中移除", () => {
	const msgs = [user("开始"), asst("他像是在掂量这两个字的分量。"), op("像是在掂量", "慢慢咂摸")];
	const { messages: out, applied } = applyDraftOps(msgs);
	assert.equal(applied, 1);
	assert.equal(out.length, 2, "补丁条目应被移除");
	assert.ok(JSON.stringify(out[1]).includes("慢慢咂摸"));
	assert.ok(!JSON.stringify(out[1]).includes("像是在掂量"));
});

test("applyDraftOps：多补丁按序生效；找不到 old 的补丁静默跳过；原数组不被改", () => {
	const msgs = [user("开始"), asst("第一句。第二句。"), op("第一句", "头一句"), op("不存在的", "X"), op("第二句", "次一句")];
	const before = JSON.stringify(msgs[1]);
	const { messages: out, applied } = applyDraftOps(msgs);
	assert.equal(applied, 2);
	const text = JSON.stringify(out[1]);
	assert.ok(text.includes("头一句") && text.includes("次一句"));
	assert.equal(JSON.stringify(msgs[1]), before, "非破坏：原消息不被改");
});

test("applyDraftOps：string content 形态与跨消息定位（改最近一条，而非更早的）", () => {
	const msgs = [
		user("开始"),
		{ role: "assistant", content: "同一句话出现。" },
		asst("同一句话出现。后写的这条。"),
		op("同一句话出现。", "被替换了。"),
	];
	const { messages: out } = applyDraftOps(msgs);
	assert.equal((out[1] as { content: string }).content, "同一句话出现。", "更早的消息不动");
	assert.ok(JSON.stringify(out[2]).includes("被替换了。后写的这条。"), "改的是最近一条");
});

test("draftTurnText：只取最后一条 user 之后的 assistant 文本，且已套补丁", () => {
	const msgs = [
		user("第一轮"),
		asst("旧轮正文。"),
		user("第二轮"),
		asst("旁白一句。"),
		asst("正文主体。"),
		op("正文主体", "正文定稿"),
	];
	const t = draftTurnText(msgs);
	assert.ok(!t.includes("旧轮正文"));
	assert.ok(t.includes("旁白一句。"));
	assert.ok(t.includes("正文定稿。"));
});

test("resolveDraftEdit：空稿/找不到/多处/唯一 四态", () => {
	assert.equal(resolveDraftEdit([user("x")], "abc").ok, false);
	const msgs = [user("x"), asst("春风又绿江南岸。春风又绿江南岸。明月何时照我还。")];
	assert.equal(resolveDraftEdit(msgs, "不存在").ok, false);
	assert.equal(resolveDraftEdit(msgs, "春风又绿江南岸").ok, false, "出现两处应拒绝");
	assert.equal(resolveDraftEdit(msgs, "明月何时照我还").ok, true);
});

test("parseDraftOp：合法 JSON 才认；old 必须非空", () => {
	assert.deepEqual(parseDraftOp(JSON.stringify({ old: "a", new: "b" })), { old: "a", new: "b" });
	assert.equal(parseDraftOp(JSON.stringify({ old: "", new: "b" })), null);
	assert.equal(parseDraftOp("not json"), null);
	assert.equal(parseDraftOp(42), null);
});

test("稿纸工件（v2）：补丁作用于 rp-draft；draftTurnText 以最后一份稿纸为准", () => {
	const msgs = [
		user("开始"),
		{ role: "assistant", content: [{ type: "text", text: "台侧旁白：先落稿。" }] },
		doc("正文第一版。他像是很紧张。\n\n<state1>x</state1>"),
		op("像是很紧张", "手心沁着汗"),
	];
	const { messages: out } = applyDraftOps(msgs);
	const draftMsg = out.find((m) => (m as { customType?: string }).customType === DRAFT_DOC_TYPE);
	assert.ok(String((draftMsg as { content: string }).content).includes("手心沁着汗"), "补丁应作用于稿纸工件");
	const turn = draftTurnText(msgs);
	assert.ok(turn.includes("手心沁着汗"), "有效草稿=补丁后的稿纸");
	assert.ok(!turn.includes("台侧旁白"), "旁白不算草稿内容");
	// draft_write 重写：最后一份稿纸为准
	const rewritten = [...msgs, doc("正文第二版，整体重写。\n\n<state1>y</state1>")];
	assert.ok(draftTurnText(rewritten).includes("第二版"));
	assert.ok(!draftTurnText(rewritten).includes("第一版"));
	// 无稿纸时回落 assistant 文本（v1 兼容）
	const v1 = [user("x"), asst("直接流式写的正文。")];
	assert.ok(draftTurnText(v1).includes("直接流式写的正文"));
	// resolveDraftEdit 也以稿纸为准
	assert.equal(resolveDraftEdit(msgs, "手心沁着汗").ok, true);
	assert.equal(resolveDraftEdit(msgs, "台侧旁白").ok, false, "旁白不可作为修订目标");
});

test("extractDraftRules：只提取字数目标（8/10 验收退役——禁词/比喻/句式不再提取）", () => {
	const blocks = [
		"### 字数限制\n<response_length>\n注意：正文的字数控制在500-800字之间。\n</response_length>",
		"摘要 rule：以紧凑事件链回顾，200~300字。", // 不含"正文"，不得当字数规则
		'## 禁八股\n<anti_clich>\n词汇黑名单 = { "像是", "一秒" }\n</anti_cliche>',
	];
	const rules = extractDraftRules(blocks);
	assert.deepEqual(rules.wordRange, { min: 500, max: 800 }, "取正文字数而非摘要字数");
	assert.deepEqual(Object.keys(rules), ["wordRange"], "除字数目标外不提取任何检测规则");
	assert.deepEqual(extractDraftRules(["纯文风描述，无机械约束。"]), {}, "无字数块→空规则");
});

test("isPoliceBlock：纪律块（禁词/八股/比喻/句式）判真；文风/字数/格式块判假", () => {
	// 纪律块——精修专用，不进写作上下文（四阶段供料）
	assert.equal(isPoliceBlock('## 禁八股\n<anti_clich>\n词汇黑名单 = { "像是", "一秒" }\n</anti_cliche>'), true);
	assert.equal(isPoliceBlock("## 铁律自检：若发现任何先否定再肯定的句子，立即改写。"), true);
	assert.equal(isPoliceBlock("## 比喻使用原则：频率：5个段落内只允许使用1次比喻。宁缺毋滥。"), true);
	assert.equal(isPoliceBlock("<用户厌恶的词汇>用户无法理解且厌恶下列词汇：“喉结”</用户厌恶的词汇>"), true);
	// 非纪律块——写作阶段的正当材料
	assert.equal(isPoliceBlock("### 字数限制：正文的字数控制在500-800字之间。"), false, "字数块写作时必须在场");
	assert.equal(isPoliceBlock("<pov>采用第三人称有限视角。</pov>"), false, "人称/文风留在写作上下文");
	assert.equal(isPoliceBlock("格式要求: 严格按顺序输出各模块，不得调换顺序或遗漏。"), false, "格式模板写作时必须在场");
	assert.equal(isPoliceBlock("活人感：角色是活人，不是人设标签的复读机。"), false);
	assert.equal(
		isPoliceBlock("### 语料库使用指南\n本语料库提供同一事物的多种表达方式。\n#### 禁用词汇\n轮廓、花园\n#### 某部位\n称呼：A/B/C"),
		false,
		"语料/词库类块即便夹带禁用词小节也留在写作台上（供给特征优先）",
	);
});

test("extractDraftBody：剥标签模块与注释，只剩正文", () => {
	const turn = [
		"<draft_notes>检查表内容</draft_notes>",
		"正文第一段。",
		"<!-- 注释 -->正文第二段。",
		"<state1>🕰️时间: x</state1>",
		"<w2g>A：选项一 B：选项二</w2g>",
	].join("\n");
	const body = extractDraftBody(turn);
	assert.ok(body.includes("正文第一段。") && body.includes("正文第二段。"));
	assert.ok(!body.includes("检查表") && !body.includes("选项一") && !body.includes("🕰️"));
});







test("lastSubstantiveRole：跳过稿纸工件条目——末条=工件不得误判续轮（2026-08-02 事故回归）", () => {
	// 直落树后 doc/op 常贴在 toolResult 前后：判定必须穿透它们看到 toolResult
	const toolTurn = [
		user("开始"),
		{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "draft_edit" }] },
		op("旧句", "新句"),
		{ role: "toolResult", content: [{ type: "text", text: "已替换。" }] },
	];
	assert.equal(lastSubstantiveRole(toolTurn), "toolResult");
	// 工件在末尾（steer 时代残留 / 异步迟到落树的会话回放）：同样判为续轮
	assert.equal(lastSubstantiveRole([...toolTurn, op("a", "b"), doc("正文")]), "toolResult");
	// 新回合（末端实质消息是 user）不受影响
	assert.equal(lastSubstantiveRole([user("下一步")]), "user");
	assert.equal(lastSubstantiveRole([user("下一步"), op("a", "b")]), "user");
	// 全是工件 / 空流：无实质消息
	assert.equal(lastSubstantiveRole([op("a", "b"), doc("正文")]), undefined);
	assert.equal(lastSubstantiveRole([]), undefined);
});

// ---------------- M2：append 补丁形态 ----------------

test("append 补丁：parseDraftOp 认 {append}；applyDraftOps 补到最近目标消息末尾", () => {
	assert.deepEqual(parseDraftOp(JSON.stringify({ append: "<state1>状态栏</state1>" })), {
		append: "<state1>状态栏</state1>",
	});
	assert.equal(parseDraftOp(JSON.stringify({ append: "   " })), null, "空白 append 不认");

	const appendOp = { role: "custom", customType: DRAFT_OP_TYPE, content: JSON.stringify({ append: "<state1>补上的状态栏</state1>" }) };
	const { messages, applied } = applyDraftOps([user("开演"), asst("正文一段。"), appendOp]);
	assert.equal(applied, 1);
	assert.equal(messages.length, 2, "补丁条目出流");
	const text = (messages[1].content as Array<{ text: string }>)[0].text;
	assert.ok(text.endsWith("<state1>补上的状态栏</state1>"));
	assert.ok(text.startsWith("正文一段。"), "原文保留在前");

	// string content 形态同样可追加
	const r2 = applyDraftOps([{ role: "assistant", content: "散文本。" }, appendOp]);
	assert.equal(r2.messages[0].content, "散文本。\n\n<state1>补上的状态栏</state1>");
});

// ---------------- M4.5 句级过滤（慢因 B 残余） ----------------

test("isAuditLine：摘「写完回头查」，留「怎么写」", () => {
	// 摘：审查动作 + **事后/逐句**时机 同时命中
	assert.ok(isAuditLine("- 每段写完后自检是否出现禁用句式"));
	assert.ok(isAuditLine("写完检查一遍有没有用到禁用词"));
	assert.ok(isAuditLine("完成后回头看每一段是否符合文风"));
	assert.ok(isAuditLine("每一句都要先自检再输出"));

	// 留：只有写法，没有事后核查
	assert.ok(!isAuditLine("- 以直接对白为主，而不是用旁白概括角色说了什么"));
	assert.ok(!isAuditLine("用具体的感官细节落实场景"));
	assert.ok(!isAuditLine("每段聚焦一个角色的动作"), "只有时机词不算验算");
	assert.ok(!isAuditLine("检查设定集里是否有相关条目"), "只有动词不算验算（属剧情理解）");

	// 结构行不参与
	assert.ok(!isAuditLine("<style>"));
	assert.ok(!isAuditLine("━━━━ 文风 ━━━━"));
	assert.ok(!isAuditLine(""));
});

test("stripAuditLines：只摘命中行，其余原文与结构不动", () => {
	const src = [
		"<style>",
		"# 核心文风",
		"- 以直接对白为主，少用旁白概括。",
		"- 每段写完后自检是否出现禁用句式。",
		"- 用具体的感官细节落实场景。",
		"每一段都必须先自检再输出。",
		"</style>",
	].join("\n");
	const { text, dropped } = stripAuditLines(src);

	assert.equal(dropped, 2, "两行验算指令被摘");
	assert.ok(text.includes("<style>") && text.includes("</style>"), "标签结构不动");
	assert.ok(text.includes("以直接对白为主"), "文风指令留下");
	assert.ok(text.includes("感官细节"), "文风指令留下");
	assert.ok(!text.includes("自检"), "验算指令已摘");
});

test("stripAuditLines：无命中则原文照旧（同一引用）", () => {
	const src = "- 以直接对白为主\n- 用具体的感官细节";
	const { text, dropped } = stripAuditLines(src);
	assert.equal(dropped, 0);
	assert.equal(text, src);
});

test("isAuditLine：动笔前一次性读题/规划不摘——只摘逐句逐段与事后返工", () => {
	// 保留：预设自己的规划区（一轮一次，正是 harness 要的形态；摘掉等于砸预设结构）
	assert.ok(
		!isAuditLine("每次回复前，你必须参考`<draft>`里的每个要点进行深度梳理，结果输出在 <draft_notes> 中"),
		"draft_notes 规划行必须保留（2026-08-03 语料实测）",
	);
	// 保留：读题遵循式声明（摘掉等于把预设要求本身撕了）
	assert.ok(!isAuditLine("- $(检查并遵循<user_def>内的要求)"));
	assert.ok(!isAuditLine("- 确保遵循<cot>标签内的核心要求"));
	assert.ok(!isAuditLine("🛑 抢话提醒：如果出现抢话，请先检查是不是开启了冲突的条目。"));

	// 摘：逐句/逐段自检——一轮里反复起草-复查，是墙钟时间的大头
	assert.ok(isAuditLine("**正文所有的段落句子，必须经过此规则排雷检查，才能输出。**"));
	assert.ok(isAuditLine("进入正文后，每一段文字，你都必须先输出html注释符进行“草稿自检”，然后再动手写这一段。"));
	assert.ok(isAuditLine("写完后检查：这段反应是否只是在表演人设标签？"));
});


