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

// ---------- ② 8/15 起：自定义标签一律 unwrap，渲染交作者正则（对齐酒馆，无标签名单） ----------

test("classifyTag：stateN 不再当 panel——未识别标签 unwrap，渲染归作者正则", () => {
	assert.equal(classifyTag("state1"), "unwrap");
	assert.equal(classifyTag("state_2"), "unwrap");
	assert.equal(classifyTag("StatusBlock"), "unwrap");
	assert.equal(classifyTag("状态栏"), "unwrap");
	assert.equal(classifyTag("thinking"), "fold", "思考类仍折叠（名称模式，非状态栏名单）");
});

// ---------- ③ 8/16：fold/strip 类标签不算「格式内容」，不进定稿 ----------

test("mergeFinalText：<thinking> 摆在格式块之前 → 整块不进定稿（8/16 实弹）", () => {
	// 实弹形态：模型封笔+记账之后，尾巴以 <thinking> 收笔自检开头，后面才是状态栏。
	// 旧口径「第一个标签就是格式起点」把整块思考收进定稿，再被作者 CoT 正则
	// （^([\s\S]*</thinking>) 锚在开头且贪婪）连正文一起卷走、复制两遍。
	const draft = "星辰厅的光白得晃眼。\n\n琴放在台侧。";
	const tail = [
		"<thinking>",
		"我已经完成了本拍的所有步骤：规划、ask、列路标、封笔、记账。",
		"检查一下所有要求：视角 ✓ 字数 ✓ state1 ✓ options 四项 ✓",
		"</thinking>",
		"",
		"### 正文",
		"",
		'<state1>\n🕰️时间: "21:15"\n</state1>',
		"<options>\n- 坐进车里\n</options>",
	].join("\n");
	const merged = mergeFinalText(draft, `${draft}\n\n${tail}`);

	assert.ok(merged.startsWith(draft), "正文以稿件为准");
	assert.ok(!merged.includes("<thinking>"), "思考块不进定稿");
	assert.ok(!merged.includes("检查一下所有要求"), "收笔自检不进定稿");
	assert.ok(!merged.includes("### 正文"), "思考块之前/之间的元话语一并丢弃");
	assert.ok(merged.includes("<state1>"), "状态栏保留");
	assert.ok(merged.includes("<options>"), "选项栏保留");
	assert.equal((merged.match(/星辰厅的光白得晃眼/g) ?? []).length, 1, "正文不重复");
});

test("mergeFinalText：<thinking> 夹在格式块之后也剔掉（起点跳过挡不住的那种）", () => {
	const draft = "正文。";
	const tail = "<state1>x</state1>\n<thinking>顺带自检一下。</thinking>\n<options>y</options>";
	const merged = mergeFinalText(draft, `${draft}\n\n${tail}`);
	assert.ok(!merged.includes("<thinking>"), "中段的思考块同样不进定稿");
	assert.ok(!merged.includes("顺带自检"), "思考内容不进定稿");
	assert.ok(merged.includes("<state1>") && merged.includes("<options>"), "两侧格式块都保留");
});

test("mergeFinalText：尾巴里裸重述整段正文 → 只留格式块，正文不重复（8/16 实弹）", () => {
	// 实弹形态：模型封笔后在 text 通道吐 <time_format> + 整段正文重述 + <options>。
	// 重述不带 <content> 包裹，trimContentBodyRepeat 管不到；它又在第一个格式块之后，
	// 起点切一刀也切不到 → 旧口径把它整段拼进定稿，正文出现两遍。
	const draft = "我抬起头，看向他。\n\n窗外的光斜进来，落在桌沿上。";
	const tail = [
		"<time_format>",
		"time: 星元历2001年7月5日·周五☆13:40-14:10",
		"scene: 便民街·雀语咖啡馆",
		"</time_format>",
		"",
		draft, // ← 裸重述
		"",
		"<options>\n下一步行动建议:\n - 【应下邀约】\n</options>",
	].join("\n");
	const merged = mergeFinalText(draft, tail);

	assert.ok(merged.startsWith(draft), "正文以稿件为准");
	assert.equal((merged.match(/我抬起头，看向他。/g) ?? []).length, 1, "正文不重复（旧口径是 2 遍）");
	assert.ok(merged.includes("<time_format>"), "时间栏保留");
	assert.ok(merged.includes("<options>"), "选项栏保留");
	assert.ok(merged.includes("雀语咖啡馆"), "格式块内容完整");
});

test("mergeFinalText：自闭合格式标签（占位符）仍保留", () => {
	const draft = "正文。";
	const merged = mergeFinalText(draft, "<StatusPlaceHolderImpl/>\n\n闲话一句。");
	assert.ok(merged.includes("<StatusPlaceHolderImpl/>"), "自闭合占位符是格式内容");
	assert.ok(!merged.includes("闲话一句"), "块外自由文本仍丢弃");
});

test("formatTailStart：fold/strip 类标签不算格式起点，围栏与真格式块仍算", () => {
	const t1 = "<thinking>想</thinking>\n<state1>x</state1>";
	assert.equal(formatTailStart(t1), t1.indexOf("<state1>"), "跳过 <thinking>，落在 <state1>");
	assert.equal(formatTailStart("<state1>x</state1>"), 0, "真格式块在开头就是 0");
	const t2 = "元话语。\n```\n时间\n```";
	assert.equal(formatTailStart(t2), t2.indexOf("```"), "围栏行仍是起点");
	assert.equal(formatTailStart("<thinking>只有思考</thinking>"), -1, "只有 fold 类 → 无格式内容");
	assert.equal(formatTailStart("就这样吧。"), -1, "纯自由文本 → -1");
});
