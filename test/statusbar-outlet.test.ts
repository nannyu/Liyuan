/**
 * 8/10 实弹修复的回归测试（范围=用户点名的两个 bug）：
 *
 * ① mergeFinalText 尾巴口径：旧逻辑整串检验、整串拼接——元话语（收笔自检、
 *    ask 开场白）挂在格式块前面时跟着进定稿（HK 11 拍：7 个裸尾巴段 3 个带元话语）。
 * ② stateN 标签渲染两端漏认：后端 unwrap 剥壳、前端不抽面板 → 状态栏内容
 *    摊平进正文（「吐源码」实弹症状）。
 *
 * 围栏式状态栏的「直丢」问题**不在此修**（8/10 用户定案）：那属于机制问题，
 * 走谢幕清单工件化方向，不加启发式检测。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyTag } from "../src/postprocess.ts";
import { dedupeIdenticalBlocks, formatTailStart, mergeFinalText } from "../src/stage/engine.ts";
import { splitStatusParts } from "../web/src/statusBlocks.ts";

// ---------- ① mergeFinalText：尾巴只取格式块 ----------

test("mergeFinalText：元话语挂在标签状态栏前 → 只拼格式块（实弹：收笔自检 + <state1>）", () => {
	const draft = "正文第一段。\n\n正文第二段。";
	const text = `${draft}\n\n戏停在了她说完之后——收笔。<state1>\n🕰️时间: "23:10"\n</state1>`;
	const merged = mergeFinalText(draft, text);
	assert.ok(merged.startsWith(draft));
	assert.ok(merged.includes("<state1>"));
	assert.ok(!merged.includes("收笔"), "元话语不进定稿");
});

test("mergeFinalText：元话语 + ``` 围栏状态栏 → 从围栏行起切", () => {
	const draft = "正文。";
	const text = "正文。\n\n戲已演到停点，交回给用户接。\n\n```\n⏰ 时间：23:20\n```";
	const merged = mergeFinalText(draft, text);
	assert.ok(merged.includes("⏰ 时间：23:20"));
	assert.ok(!merged.includes("停点"), "元话语不进定稿");
});

test("mergeFinalText：旧行为不回归——纯元话语整段丢、纯格式块原样拼、无稿直出全保留", () => {
	const draft = "正文。";
	assert.equal(mergeFinalText(draft, "正文。\n\n就这样吧，本拍结束。"), draft);
	assert.ok(mergeFinalText(draft, "正文。\n\n<catsay>喵</catsay>").endsWith("<catsay>喵</catsay>"));
	assert.equal(mergeFinalText("", "直出正文原样保留"), "直出正文原样保留");
});

test("mergeFinalText：<content> 整段重述正文 → 状态栏保留、正文不重复（8/13 实弹 B2）", () => {
	const draft = "鎏金大厅的穹顶垂下一盏水晶吊灯。\n\n明月垂着眼。";
	const text = `<state1>\n🕰️时间: "星元历2001年7月5日 夜"\n📝姓名: "怀瑾"\n</state1>\n<options>\n- 顺从回应\n</options>\n<thinking>\n开局按设定推进。\n</thinking>\n<content>\n${draft}\n</content>`;
	const merged = mergeFinalText(draft, text);
	assert.ok(merged.startsWith(draft), "正文以稿件为准");
	assert.ok(merged.includes("<state1>"), "状态栏保留（此前 indexOf 把它切掉）");
	assert.ok(merged.includes("<options>"), "options 保留");
	assert.equal((merged.match(/鎏金大厅/g) ?? []).length, 1, "正文不重复");
	assert.equal((merged.match(/<content>/g) ?? []).length, 0, "重述正文的空 <content> 块丢弃");
});

test("mergeFinalText：<content> 以正文末段开头续写 → 裁掉重复前缀（8/13 实弹 B1）", () => {
	const draft = "第一段。\n\n她站在侧厅，月光从高窗斜斜落进来。";
	const text = `<state1>x</state1>\n<content>\n${draft}\n\n怀瑾走近，说：「今晚跳得很好。」\n</content>`;
	const merged = mergeFinalText(draft, text);
	assert.ok(merged.includes("<state1>"));
	assert.equal((merged.match(/她站在侧厅/g) ?? []).length, 1, "末段不重复");
	assert.ok(merged.includes("「今晚跳得很好。」"), "content 里的新内容保留");
});

test("mergeFinalText：正文在前、格式块在后的旧形态不回归", () => {
	const draft = "正文。";
	const text = `${draft}\n\n<state1>x</state1>`;
	const merged = mergeFinalText(draft, text);
	assert.equal(merged, "正文。\n\n<state1>x</state1>");
});

test("formatTailStart：标签/围栏取更早者；都没有 → -1", () => {
	assert.equal(formatTailStart("啰嗦两句<state1>x</state1>"), "啰嗦两句".length);
	assert.equal(formatTailStart("```\nx\n```"), 0);
	assert.equal(formatTailStart("没有任何格式内容"), -1);
});

// ---------- ①b 逐字相同格式块去重（8/10 实弹：双指令源下状态栏输出两遍） ----------

test("dedupeIdenticalBlocks：完全相同的重复块删除，内容有差异的块保留", () => {
	const sb = "<StatusBlock>\n地点:御书房\n姓名:文舒婉\n</StatusBlock>";
	const cat = "<catsay>喵</catsay>";
	// 实弹形态：SB + catsay + SB（第二份逐字相同，直贴在 </catsay> 后）
	const out = dedupeIdenticalBlocks(`${sb}\n\n${cat}${sb}`);
	assert.equal((out.match(/<StatusBlock>/g) ?? []).length, 1, "相同状态栏只留一份");
	assert.ok(out.includes("<catsay>喵</catsay>"), "catsay 不受影响");
	// 内容不同的两个同名块都保留（不做识别、不做归并）
	const twoDiff = dedupeIdenticalBlocks("<state1>甲</state1>\n\n<state1>乙</state1>");
	assert.equal((twoDiff.match(/<state1>/g) ?? []).length, 2);
});

test("mergeFinalText：尾巴里的重复状态栏在定稿中只留一份", () => {
	const draft = "正文。";
	const sb = "<StatusBlock>\n地点:御书房\n</StatusBlock>";
	const merged = mergeFinalText(draft, `${sb}\n<catsay>喵</catsay>${sb}`);
	assert.ok(merged.startsWith(draft));
	assert.equal((merged.match(/<StatusBlock>/g) ?? []).length, 1);
});

// ---------- ② stateN 渲染两端对齐（吐源码的渲染半截） ----------

test("classifyTag：stateN → panel（不再 unwrap 剥壳当正文）", () => {
	assert.equal(classifyTag("state1"), "panel");
	assert.equal(classifyTag("state_2"), "panel");
	assert.equal(classifyTag("stateless"), "unwrap", "非序号形不误伤");
});

test("splitStatusParts：<state1> 抽成状态面板，正文不残留标签", () => {
	const parts = splitStatusParts('正文一句。\n\n<state1>\n🕰️时间: "23:10"\n📍地点: 展演会\n</state1>');
	const status = parts.find((p) => p.kind === "status");
	assert.ok(status);
	if (status.kind === "status") {
		assert.equal(status.tag, "state1");
		assert.ok(status.body.includes("23:10"));
	}
	const text = parts.find((p) => p.kind === "text");
	assert.ok(text);
	if (text.kind === "text") {
		assert.ok(!text.text.includes("state1"));
	}
});
