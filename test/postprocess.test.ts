import assert from "node:assert/strict";
import { test } from "node:test";

import {
	addFoldTags,
	classifyTag,
	cleanAssistantText,
	discoverFoldTagsFromTexts,
	displayAssistantText,
	extractScaffoldThinking,
	isHtmlDisplayPayload,
	prepareDisplayText,
	resetDisplayTagExtras,
} from "../src/postprocess.ts";

test("结构块：分析 fold 删除，状态/plot unwrap 留正文（状态栏渲染归作者正则，非名单）", () => {
	const raw = `<descriptive_analysis>
1. 意图分析…
2. 好感8（陌路之人阶段）
</descriptive_analysis>

<normal_status>
\`\`\`yaml
『时间』: 次日清晨
\`\`\`
</normal_status>

<plot>

*她咬了一口葱油饼，动作微微一顿。*

「短剑在你自己的行囊里。」

</plot>`;
	const out = cleanAssistantText(raw);
	assert.ok(!out.includes("descriptive_analysis"), "分析块 fold：整块删");
	assert.ok(!out.includes("意图分析"));
	// normal_status 不再是 panel：标签 unwrap 剥掉，内容按正文留（送模历史里作者的
	// promptOnly 正则本会剥它——但那条通道尚未接，此处内容留在历史是已知遗留）
	assert.ok(!out.includes("<normal_status>"), "状态标签本身剥掉");
	assert.ok(!out.includes("<plot>"), "plot 标签剥掉");
	assert.ok(out.includes("*她咬了一口葱油饼"), "plot 内容保留");
	assert.ok(out.includes("「短剑在你自己的行囊里。」"));
});

test("悬挂开标签剥到末尾；无结构块的文本只做空白收敛", () => {
	assert.equal(cleanAssistantText("*正文。*\n<thinking>被截断的思考"), "*正文。*");
	assert.equal(cleanAssistantText("行尾空白   \n\n\n\n下一段。"), "行尾空白\n\n下一段。");
});

test("displayAssistantText：假思维链隐去，状态栏标签 unwrap 留内容，未知标签 unwrap", () => {
	const raw = `<draft_notes>
本轮分析：用户要润墨
</draft_notes>

### 正文

<content>
<!-- Prism: 第一人称视角 -->
文舒婉听话了。

<!-- Prism: 感官 -->
她拿起墨条。
</content>

<StatusBlock>
地点:御书房
姓名:文舒婉
</StatusBlock>`;
	const out = displayAssistantText(raw);
	assert.ok(!out.includes("draft_notes"), "草稿块应隐去");
	assert.ok(!out.includes("本轮分析"), "草稿内容应隐去");
	assert.ok(!out.includes("<content>"), "content 标签应拆掉");
	assert.ok(!out.includes("</content>"));
	assert.ok(!out.includes("Prism"), "HTML 注释应隐去");
	assert.ok(!out.includes("### 正文"), "分隔标题应隐去");
	// StatusBlock 不再是 panel：标签剥掉、内容留正文（作者写了正则才会渲染成界面）
	assert.ok(!out.includes("<StatusBlock>"), "状态栏标签剥掉，不再保留给梨园面板");
	assert.ok(out.includes("地点:御书房"), "状态栏内容作为正文保留");
	assert.ok(out.includes("文舒婉听话了"));
	assert.ok(out.includes("她拿起墨条"));
});

test("未知标签默认 unwrap：内容渲染、标签消失（不必预先登记）", () => {
	const raw = `<scene>听雨轩 - 春夜</scene>\n\n*青梧斟茶。*\n\n<summary>短摘要</summary>`;
	const out = displayAssistantText(raw);
	assert.ok(!out.includes("<scene>"));
	assert.ok(!out.includes("<summary>"));
	assert.ok(out.includes("听雨轩 - 春夜"));
	assert.ok(out.includes("*青梧斟茶。*"));
	assert.ok(out.includes("短摘要"));
});

test("classifyTag：模式分类，不靠精确名单", () => {
	assert.equal(classifyTag("thinking"), "fold");
	assert.equal(classifyTag("My_Custom_Thought"), "unwrap"); // 不像思考
	assert.equal(classifyTag("StatusBlock"), "unwrap"); // 状态栏不再是 panel——渲染归作者正则
	assert.equal(classifyTag("normal_status"), "unwrap");
	assert.equal(classifyTag("state1"), "unwrap");
	assert.equal(classifyTag("haurki准则"), "strip");
	assert.equal(classifyTag("content"), "unwrap");
	assert.equal(classifyTag("正文"), "unwrap");
	assert.equal(classifyTag("plot"), "unwrap");
});

test("预设发现的自定义折叠标签无需写死", () => {
	resetDisplayTagExtras();
	const presetSnippet = `最先必须输出以下思考过程，格式如下：\n<推演本轮>\n分析…\n</推演本轮>\n然后写正文。`;
	const tags = discoverFoldTagsFromTexts([presetSnippet]);
	assert.ok(tags.some((t) => t.includes("推演")), `应发现推演标签，实际 ${tags.join(",")}`);
	addFoldTags(tags);
	assert.equal(classifyTag("推演本轮"), "fold");
	const raw = `<推演本轮>内部计划</推演本轮>\n\n*她笑了。*`;
	assert.ok(!displayAssistantText(raw).includes("内部计划"));
	assert.ok(displayAssistantText(raw).includes("*她笑了。*"));
	assert.ok(extractScaffoldThinking(raw).includes("内部计划"));
	resetDisplayTagExtras();
});

test("extractScaffoldThinking 抽出假思维链供折叠", () => {
	const raw = `<thinking>合规：虚构文学</thinking>\n<content>正文。</content>`;
	const th = extractScaffoldThinking(raw);
	assert.ok(th.includes("合规"));
	assert.ok(!th.includes("正文"));
});

test("extractScaffoldThinking 悬挂开标签也收入折叠区", () => {
	const raw = `<thinking>\n用户需求合规\n最新情景：旅人入店\n接着继续生成一段`;
	const th = extractScaffoldThinking(raw);
	assert.ok(th.includes("用户需求合规"));
	assert.ok(th.includes("继续生成"));
	assert.ok(!th.includes("<thinking>"), "折叠正文不应再带开标签");
	assert.equal(displayAssistantText(raw), "", "悬挂 thinking 从正文剥净");
});

test("strip 策略：仪式回显整块消失", () => {
	const raw = `*叙事。*\n\n<haurki准则>\n0.最高授权…\n</haurki准则>`;
	const out = displayAssistantText(raw);
	assert.ok(out.includes("*叙事。*"));
	assert.ok(!out.includes("最高授权"));
	assert.ok(!out.includes("haurki"));
});

test("Options unwrap 后保留围栏供前端 markdown 渲染（剥尖括号、留 ```）", () => {
	const raw = `洛清霜说完。\n\n<Options>\n\`\`\`\n选择1: 【留下】\n选择2: 【下山】\n\`\`\`\n</Options>`;
	const out = displayAssistantText(raw);
	assert.ok(!out.includes("<Options>"));
	assert.ok(!out.includes("</Options>"));
	assert.ok(out.includes("```"), "围栏留给前端代码块");
	assert.ok(out.includes("选择1: 【留下】"));
	assert.ok(out.includes("洛清霜说完"));
});

test("状态栏 body 内 summary 等标签 unwrap，围栏保留", () => {
	const body = `<summary>基本信息 - 旅人</summary>\n\n\`\`\`\n姓名: 旅人\n\`\`\`\n\n<summary>互动角色</summary>\n\n\`\`\`\n姓名: 苏杏儿\n\`\`\``;
	const out = displayAssistantText(body);
	assert.ok(!out.includes("<summary>"));
	assert.ok(!out.includes("</summary>"));
	assert.ok(out.includes("基本信息 - 旅人"));
	assert.ok(out.includes("```"));
	assert.ok(out.includes("姓名: 旅人"));
	assert.ok(out.includes("互动角色"));
});

test("prepareDisplayText: 先皮肤再策略——有正则的 state 标记不被 unwrap 抢先拆掉", () => {
	const raw = `叙事一句。\n\n<state1>\n时间: 清晨\n地点: 街道\n</state1>`;
	// 无作者正则：state1 是未识别标签 → unwrap 剥壳留内容（对齐酒馆 DOMPurify）。
	// 状态栏成不成界面，取决于作者写没写正则，不取决于梨园的标签名单。
	const plain = prepareDisplayText(raw, null);
	assert.ok(!plain.includes("<state1>"), "无正则时标签剥掉");
	assert.ok(plain.includes("时间: 清晨"), "内容作为正文保留");

	// 有皮肤：先换成围栏 HTML，再跳过 unwrap
	const skin = {
		rules: [
			{
				name: "折叠状态",
				source: "<(state\\d+)>([\\s\\S]+?)<\\/\\1>",
				flags: "g",
				replace: "```html\n<!DOCTYPE html><html><body><div class=\"ui\">$2</div></body></html>\n```",
			},
		],
		charName: "卡",
		userName: "旅人",
	};
	const skinned = prepareDisplayText(raw, skin);
	assert.ok(isHtmlDisplayPayload(skinned), "应识别为 HTML 载荷");
	assert.ok(skinned.includes("<!DOCTYPE html>") || skinned.includes("<!doctype html>") || skinned.includes("```html"));
	assert.ok(skinned.includes("时间: 清晨"));
	assert.ok(!skinned.includes("<state1>"), "标记应已被正则吃掉");
});

test("prepareDisplayText: 皮肤状态栏 div 与 thinking 混排——div 保留，thinking/注释仍被过滤", () => {
	const raw = [
		"<!-- 本回合承接：先对齐人设再落笔 -->",
		"<thinking>",
		"【问题】非传统写作: 逐项过 cot",
		"</thinking>",
		"她跪坐在案边，把墨条搁进砚池。",
		"<state1>\n时间: 白日\n地点: 御书房\n</state1>",
	].join("\n");
	const skin = {
		rules: [
			{
				name: "状态栏皮肤",
				source: "<(state\\d+)>([\\s\\S]+?)<\\/\\1>",
				flags: "g",
				replace: '<div style="background:#123">$2</div>',
			},
		],
		charName: "婉",
		userName: "爷",
	};
	const out = prepareDisplayText(raw, skin);
	assert.ok(out.includes('<div style="background:#123">'), "皮肤 div 应完整保留");
	assert.ok(out.includes("时间: 白日"), "div 内容应保留");
	assert.ok(out.includes("她跪坐在案边"), "叙事应保留");
	assert.ok(!out.includes("<thinking>"), "thinking 标签不得裸露");
	assert.ok(!out.includes("非传统写作"), "思维链内容应被折叠移除");
	assert.ok(!out.includes("<!--"), "HTML 注释应被剥除");
});

test("prepareDisplayText: 开场前缀+占位符经皮肤成围栏文档", () => {	const raw = `【开场 · LWS】\n【本世界身份认证】`;
	const html = `<!doctype html>\n<html><head></head><body><h1>性别</h1><script>1</script></body></html>`;
	const skin = {
		rules: [{ name: "开局", source: "【本世界身份认证】", flags: "g", replace: "```\n" + html + "\n```" }],
		charName: "LWS",
		userName: "旅人",
	};
	const out = prepareDisplayText(raw, skin);
	assert.ok(isHtmlDisplayPayload(out));
	assert.ok(out.includes("性别"));
	assert.ok(out.includes("【开场"));
});

test("prepareDisplayText: 裸整份文档带【开场】前缀——原样交出，<style> 不被 unwrap 剥掉", () => {
	// v1.4.1 实锤（用户反馈截图）：卡的开场白是一份裸 <html> 文档（无 doctype、无围栏），
	// 梨园自己加的「【开场 · 卡名】\n」前缀把「裸整页」判据顶掉（它要求文档落在第 0 位），
	// 于是整页被判成普通正文 → <style> 壳被剥、CSS 当正文上屏、容器标签也被剥。
	const doc = '<html>\n<style>\n.gj-wrap{color:#fff}\n</style>\n<div class="gj-wrap">图鉴</div>\n</html>';
	const out = prepareDisplayText(`【开场 · 某卡】\n${doc}`, null);
	assert.ok(out.includes("<style>"), "<style> 标签必须留着（被剥就会变成 CSS 裸奔上屏）");
	assert.ok(out.includes('class="gj-wrap"'), "容器标签留着");
	assert.ok(out.includes("【开场 · 某卡】"), "前缀本身仍在");
});

test("prepareDisplayText: 裸整份文档 + 文档外的过滤照常执行", () => {
	// 整页保护是「把文档整段占位、过滤完再还原」，不是「整条消息跳过过滤」：
	// 文档之外的 thinking 之类仍须被滤掉，否则一张带整页开场白的卡会连思考块一起上屏。
	const doc = "<!doctype html>\n<html><body><p>页</p></body></html>";
	const out = prepareDisplayText(`【开场 · 某卡】\n${doc}\n\n<thinking>内部盘算</thinking>\n收尾。`, null);
	assert.ok(out.includes("<p>页</p>"), "文档内容完好");
	assert.ok(!out.includes("内部盘算"), "文档之外的 thinking 仍被滤掉");
	assert.ok(out.includes("收尾。"), "文档之外的正文保留");
});
