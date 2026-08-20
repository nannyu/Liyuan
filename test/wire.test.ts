import assert from "node:assert/strict";
import { test } from "node:test";

import {
	foldSlots,
	foldTurnNarratives,
	parseCardFromSessionHead,
	summarizeToolResult,
	toWireHistory,
	toWireMsg,
} from "../server/wire.ts";

const names = { charName: "青梧", userName: "旅人" };

test("user 消息 → user 通道，带用户名", () => {
	assert.deepEqual(toWireMsg({ role: "user", content: "你好" }, names), {
		channel: "user",
		name: "旅人",
		text: "你好",
	});
});

test("assistant 正文 → narrative 通道；thinking 提取为折叠字段", () => {
	const msg = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "内心活动" },
			{ type: "text", text: "*她抬头。*\n\n\"你醒了。\"" },
		],
	};
	assert.deepEqual(toWireMsg(msg, names), {
		channel: "narrative",
		name: "青梧",
		text: '*她抬头。*\n\n"你醒了。"',
		thinking: "内心活动",
	});
	// 无 thinking 块时不带该字段
	const plain = toWireMsg({ role: "assistant", content: [{ type: "text", text: "正文" }] }, names);
	assert.equal(plain && "thinking" in plain, false);
});

test("含 toolCall 的中间 assistant（含计划旁白）跳过，避免叠多条角色气泡", () => {
	const mid = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "先查状态" },
			{ type: "text", text: "开场要生成身份，我先核对世界状态，再落笔。" },
			{ type: "toolCall", id: "t1", name: "world_state_get", arguments: {} },
		],
	};
	assert.equal(toWireMsg(mid, names), null);
	// 最终定稿（无 toolCall）仍进 narrative
	const final = {
		role: "assistant",
		content: [{ type: "text", text: "*她推门进来。*" }],
	};
	assert.deepEqual(toWireMsg(final, names), {
		channel: "narrative",
		name: "青梧",
		text: "*她推门进来。*",
	});
});

test("用户中断 aborted：半截正文上屏并标 unfinished", () => {
	const half = {
		role: "assistant",
		stopReason: "aborted",
		content: [{ type: "text", text: "*他抬眼*「你来了——」" }],
	};
	assert.deepEqual(toWireMsg(half, names), {
		channel: "narrative",
		name: "青梧",
		text: "*他抬眼*「你来了——」",
		unfinished: true,
	});
});

test("用户中断 aborted：仅 thinking 也上屏（不因无 text 整条 null）", () => {
	const thinkOnly = {
		role: "assistant",
		stopReason: "aborted",
		content: [{ type: "thinking", thinking: "先设计世家近侍再落笔…" }],
	};
	const w = toWireMsg(thinkOnly, names);
	assert.ok(w);
	assert.equal(w?.unfinished, true);
	assert.ok(w?.thinking?.includes("世家近侍"));
	assert.match(w?.text ?? "", /正文未流出|思维链/);
});

test("用户中断 aborted：正文+toolCall 仍上屏（半截不被中间轮规则吃掉）", () => {
	const midAbort = {
		role: "assistant",
		stopReason: "aborted",
		content: [
			{ type: "text", text: "新角色定为近侍，先写入设定。" },
			{ type: "toolCall", id: "t1", name: "lorebook_write", arguments: {} },
		],
	};
	const w = toWireMsg(midAbort, names);
	assert.ok(w);
	assert.equal(w?.unfinished, true);
	assert.ok(w?.text.includes("近侍"));
});

test("toWireHistory：aborted 半截在 resync/hello 后仍在", () => {
	const history = [
		{ role: "user", content: "继续" },
		{
			role: "assistant",
			stopReason: "aborted",
			content: [{ type: "thinking", thinking: "长思考中" }],
		},
	];
	const wire = toWireHistory(history, names);
	assert.equal(wire.length, 2);
	assert.equal(wire[1].channel, "narrative");
	assert.equal(wire[1].unfinished, true);
});

test("显示层剥预设脚手架：draft_notes/content/HTML 注释；假思维链进 thinking 折叠", () => {
	const msg = {
		role: "assistant",
		content: [
			{
				type: "text",
				text: `<draft_notes>\n分析要点\n</draft_notes>\n\n### 正文\n\n<content>\n<!-- Prism: x -->\n*她笑了。*\n</content>\n\n<StatusBlock>\n地点:御书房\n</StatusBlock>`,
			},
		],
	};
	const w = toWireMsg(msg, names);
	assert.equal(w?.channel, "narrative");
	assert.ok(w?.text.includes("*她笑了。*"));
	assert.ok(!w?.text.includes("draft_notes"));
	assert.ok(!w?.text.includes("分析要点"));
	assert.ok(!w?.text.includes("<content>"));
	assert.ok(!w?.text.includes("Prism"));
	assert.ok(w?.text.includes("<StatusBlock>") || w?.text.includes("地点:御书房"), "状态栏保留显示");
	assert.ok(w?.thinking?.includes("分析要点"), "草稿进折叠思维链");
});

test("纯工具轮 assistant（无正文）跳过", () => {
	const msg = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "x", arguments: {} }] };
	assert.equal(toWireMsg(msg, names), null);
});

test("toWireHistory：多步 tool 中间旁白过滤，只留最终正文", () => {
	const history = [
		{ role: "user", content: "开始生成身份" },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "先核对世界状态。" },
				{ type: "toolCall", id: "t1", name: "world_state_get", arguments: {} },
			],
		},
		{ role: "toolResult", content: [{ type: "text", text: "（尚无记录）" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "再看上传截图。" },
				{ type: "toolCall", id: "t2", name: "read", arguments: {} },
			],
		},
		{ role: "toolResult", content: [{ type: "text", text: "…" }] },
		{ role: "assistant", content: [{ type: "text", text: "*门铃响了第二声。*" }] },
	];
	const wired = toWireHistory(history, names);
	assert.deepEqual(
		wired.map((m) => m.channel),
		["user", "narrative"],
	);
	assert.equal(wired[1]?.text, "*门铃响了第二声。*");
});

test("foldTurnNarratives：同一用户输入下多段 narrative 并成一泡", () => {
	const folded = foldTurnNarratives([
		{ channel: "user", name: "旅人", text: "开始" },
		{ channel: "narrative", name: "青梧", text: "第一段", thinking: "想1" },
		{ channel: "image", text: "图", src: "/media/x.png" },
		{ channel: "narrative", name: "青梧", text: "第二段", thinking: "想2" },
		{ channel: "user", name: "旅人", text: "下一轮" },
		{ channel: "narrative", name: "青梧", text: "新轮正文" },
	]);
	assert.deepEqual(
		folded.map((m) => m.channel),
		["user", "narrative", "image", "user", "narrative"],
	);
	assert.equal(folded[1]?.text, "第一段\n\n第二段");
	assert.equal(folded[1]?.thinking, "想1\n\n想2");
	assert.equal(folded[4]?.text, "新轮正文");
});

test("show_image 工具结果 → image 通道；其他/出错的工具结果跳过", () => {
	const ok = {
		role: "toolResult",
		toolName: "show_image",
		content: [{ type: "text", text: "图片已在对话中展示给用户。" }],
		details: { rpImage: { src: "/media/abc123.png", caption: "月白裙" } },
	};
	assert.deepEqual(toWireMsg(ok, names), { channel: "image", text: "月白裙", src: "/media/abc123.png" });
	// 无 caption：text 为空串
	const noCap = { ...ok, details: { rpImage: { src: "https://x/y.png" } } };
	assert.deepEqual(toWireMsg(noCap, names), { channel: "image", text: "", src: "https://x/y.png" });
	// 出错的 show_image 与其他工具结果不进叙事流
	assert.equal(toWireMsg({ ...ok, isError: true }, names), null);
	assert.equal(toWireMsg({ role: "toolResult", toolName: "bash", content: [] }, names), null);
});

test("show_video 工具结果 → video 通道", () => {
	const ok = {
		role: "toolResult",
		toolName: "show_video",
		content: "ok",
		details: { rpVideo: { src: "/media/clip.mp4", caption: "过场" } },
	};
	assert.deepEqual(toWireMsg(ok, names), { channel: "video", text: "过场", src: "/media/clip.mp4" });
	const noCap = { ...ok, details: { rpVideo: { src: "https://cdn/x.webm" } } };
	assert.deepEqual(toWireMsg(noCap, names), { channel: "video", text: "", src: "https://cdn/x.webm" });
	assert.equal(toWireMsg({ ...ok, isError: true }, names), null);
});

test("show_audio / tts 工具结果 → audio 通道；rp-audio custom 同理", () => {
	const ok = {
		role: "toolResult",
		toolName: "show_audio",
		content: [{ type: "text", text: "音频已展示" }],
		details: { rpAudio: { src: "/audio/abc.mp3", caption: "对白" } },
	};
	assert.deepEqual(toWireMsg(ok, names), { channel: "audio", text: "对白", src: "/audio/abc.mp3" });
	const tts = {
		role: "toolResult",
		toolName: "tts",
		content: [{ type: "text", text: "ok" }],
		details: { rpAudio: { src: "/audio/x.mp3" } },
	};
	assert.deepEqual(toWireMsg(tts, names), { channel: "audio", text: "", src: "/audio/x.mp3" });
	const custom = {
		role: "custom",
		customType: "rp-audio",
		content: "",
		display: true,
		details: { rpAudio: { src: "/audio/y.mp3", caption: "旁白" } },
	};
	assert.deepEqual(toWireMsg(custom, names), { channel: "audio", text: "旁白", src: "/audio/y.mp3" });
});

test("ask_director 工具结果 → choice 通道（留痕态）；非该工具/结构不符跳过", () => {
	const answered = {
		role: "toolResult",
		toolName: "ask_director",
		content: [{ type: "text", text: "用户选择：温婉隐忍型" }],
		details: { rpChoice: { question: "她该是什么性格？", options: ["温婉隐忍型", "泼辣爽利型"], answer: "温婉隐忍型" } },
	};
	assert.deepEqual(toWireMsg(answered, names), {
		channel: "choice",
		text: "",
		choice: { question: "她该是什么性格？", options: ["温婉隐忍型", "泼辣爽利型"], answer: "温婉隐忍型" },
	});
	const stopped = {
		role: "toolResult",
		toolName: "ask_director",
		content: [{ type: "text", text: "用户停止了本回合。" }],
		details: { rpChoice: { question: "接下来走哪条线？", options: ["A", "B"], stopped: true } },
	};
	assert.deepEqual(toWireMsg(stopped, names), {
		channel: "choice",
		text: "",
		choice: { question: "接下来走哪条线？", options: ["A", "B"], stopped: true },
	});
	assert.equal(toWireMsg({ role: "toolResult", toolName: "ask_director", content: [], details: {} }, names), null);
	assert.equal(toWireMsg({ role: "toolResult", toolName: "bash", content: [], details: { rpChoice: { question: "x" } } }, names), null);
});

test("custom 通道分发：greeting / import / display:false 跳过 / 其他走 info", () => {
	assert.equal(toWireMsg({ role: "custom", customType: "rp-greeting", content: "【开场】…" }, names)?.channel, "greeting");
	assert.equal(toWireMsg({ role: "custom", customType: "rp-import", content: "前情…" }, names)?.channel, "import");
	assert.equal(toWireMsg({ role: "custom", customType: "rp-inject", content: "【世界状态】…", display: false }, names), null);
	assert.equal(toWireMsg({ role: "custom", customType: "whatever", content: "横幅" }, names)?.channel, "info");
});

test("开场白/导入也走 prepareDisplayText：未知标签 unwrap，围栏留给前端 markdown", () => {
	const raw = `洛清霜说完。\n\n<Options>\n\`\`\`\n选择1: 【留下】\n选择2: 【下山】\n\`\`\`\n</Options>`;
	const g = toWireMsg({ role: "custom", customType: "rp-greeting", content: raw }, names);
	assert.ok(g);
	assert.equal(g!.channel, "greeting");
	assert.ok(!g!.text.includes("<Options>"), "开场白不得漏 Options 开标签");
	assert.ok(!g!.text.includes("</Options>"), "开场白不得漏 Options 闭标签");
	assert.ok(g!.text.includes("```"), "围栏留给前端代码块");
	assert.ok(g!.text.includes("选择1"), "选项正文保留");
	assert.ok(g!.text.includes("洛清霜说完"), "叙事保留");

	const imp = toWireMsg({ role: "custom", customType: "rp-import", content: raw }, names);
	assert.ok(imp);
	assert.ok(!imp!.text.includes("<Options>"));
	assert.ok(imp!.text.includes("```"));
	assert.ok(imp!.text.includes("选择1"));
});

test("wire + skin: narrative 先正则后策略，state 变成 HTML 载荷", () => {
	const skin = {
		rules: [
			{
				name: "state",
				source: "<(state\\d+)>([\\s\\S]+?)<\\/\\1>",
				flags: "g",
				replace: "```html\n<!DOCTYPE html><html><body><article>$2</article></body></html>\n```",
			},
		],
		charName: "LWS",
		userName: "旅人",
	};
	const raw = `她走了过来。\n\n<state1>\n姓名: 白荷\n好感: 60\n</state1>`;
	const w = toWireMsg(
		{ role: "assistant", content: [{ type: "text", text: raw }] },
		names,
		{ skin },
	);
	assert.ok(w);
	assert.equal(w!.channel, "narrative");
	assert.ok(!w!.text.includes("<state1>"), "标记须被皮肤吃掉");
	assert.ok(w!.text.includes("白荷"));
	assert.ok(w!.text.includes("```html") || w!.text.includes("<!DOCTYPE html>"));
});

test("toolResult 与未知类型跳过；字符串与内容块数组两种 content 都可读", () => {
	assert.equal(toWireMsg({ role: "toolResult", content: [{ type: "text", text: "lore" }] }, names), null);
	assert.equal(toWireMsg({ role: "bashExecution", content: "ls" }, names), null);
	assert.equal(toWireMsg(null, names), null);
	assert.equal(toWireMsg({ role: "user", content: [{ type: "text", text: "块数组" }] }, names)?.text, "块数组");
});

test("toWireHistory：显示侧深度限定——只有最新气泡渲染面板，旧的自动摘除", () => {
	// Living With Slaves 实卡形态：`折叠通用多状态栏` maxDepth:2 只管最新几条，
	// 否则每条消息都挂一个 11KB 面板，聊天记录会被面板淹没。
	const skin = {
		rules: [
			{ name: "折叠状态栏", source: "<state1>([\\s\\S]*?)</state1>", flags: "g", replace: "【面板】$1", maxDepth: 0 },
		],
		charName: "青梧",
		userName: "旅人",
	};
	const history = [
		{ role: "user", content: "u1" },
		{ role: "assistant", content: [{ type: "text", text: "老段。\n<state1>老栏</state1>" }] },
		{ role: "user", content: "u2" },
		{ role: "assistant", content: [{ type: "text", text: "新段。\n<state1>新栏</state1>" }] },
	];
	// 气泡 4 个：u1 depth3 / 老段 depth2 / u2 depth1 / 新段 depth0
	const wire = toWireHistory(history, names, { skin });
	assert.equal(wire.length, 4);
	assert.ok(wire[3].text.includes("【面板】新栏"), "最新气泡渲染面板");
	assert.ok(!wire[1].text.includes("【面板】"), "depth 2 超出 maxDepth:0 → 不渲染");
	assert.ok(wire[1].text.includes("老栏"), "不渲染≠删掉：标签剥壳后内容仍在（对齐酒馆）");

	// 对照：没有深度限定时逐条都渲染（改动前的行为，也是绝大多数卡的行为）
	const flat = toWireHistory(history, names, {
		skin: { ...skin, rules: skin.rules.map(({ maxDepth: _drop, ...r }) => r) },
	});
	assert.ok(flat[1].text.includes("【面板】老栏") && flat[3].text.includes("【面板】新栏"));
});

test("toWireHistory：深度按折叠后的气泡数，一拍多条 message 只算一个气泡", () => {
	// 按原始 message 数算，本拍第一段会落到 depth 1，maxDepth:0 就渲染不出来。
	const skin = {
		rules: [
			{ name: "折叠状态栏", source: "<state1>([\\s\\S]*?)</state1>", flags: "g", replace: "【面板】$1", maxDepth: 0 },
		],
		charName: "青梧",
		userName: "旅人",
	};
	const history = [
		{ role: "user", content: "u1" },
		{ role: "assistant", content: [{ type: "text", text: "第一段。\n<state1>本拍栏</state1>" }] },
		{ role: "assistant", content: [{ type: "text", text: "第二段。" }] },
	];
	const wire = toWireHistory(history, names, { skin });
	assert.equal(wire.length, 2, "两条 assistant 折叠进一个气泡");
	assert.ok(wire[1].text.includes("【面板】本拍栏"), "本拍整体 depth 0，面板必须渲染");
	assert.ok(wire[1].text.includes("第二段"), "折叠没丢内容");
});

test("foldSlots：折叠归属与深度计数共用一份答案", () => {
	const msgs = [
		{ channel: "user" as const, text: "u1" },
		{ channel: "narrative" as const, text: "a" },
		{ channel: "image" as const, text: "", src: "/x.png" },
		{ channel: "narrative" as const, text: "b" },
		{ channel: "user" as const, text: "u2" },
		{ channel: "narrative" as const, text: "c" },
	];
	// 插图插在中间不打断本轮角色泡归属：两条 narrative 同格
	assert.deepEqual(foldSlots(msgs), [0, 1, 2, 1, 3, 4]);
	assert.equal(foldTurnNarratives(msgs).length, 5, "折叠结果与归属格数一致");
});

test("toWireHistory 保序过滤", () => {
	const history = [
		{ role: "custom", customType: "rp-greeting", content: "开场" },
		{ role: "user", content: "第一轮" },
		{ role: "assistant", content: [{ type: "toolCall", id: "t", name: "x", arguments: {} }] },
		{ role: "toolResult", content: [{ type: "text", text: "…" }] },
		{ role: "assistant", content: [{ type: "text", text: "正文" }] },
		{ role: "custom", customType: "rp-inject", content: "注入", display: false },
	];
	assert.deepEqual(
		toWireHistory(history, names).map((m) => m.channel),
		["greeting", "user", "narrative"],
	);
});

test("parseCardFromSessionHead：命中 rp-card 条目、容忍杂行与半行；取最后一条", () => {
	const head = [
		'{"type":"header","version":3,"cwd":"e:/x"}',
		'{"type":"custom","customType":"rp-state","data":{"time":"night"}}',
		'{"type":"custom","customType":"rp-card","data":{"card":"assets/cards/sample-card.json","name":"Sample Card v1"},"id":"a1"}',
		'{"type":"message","message":{"role":"user"',
	].join("\n");
	assert.deepEqual(parseCardFromSessionHead(head), {
		card: "assets/cards/sample-card.json",
		name: "Sample Card v1",
	});
	// 换卡后补写：后写的为准
	const rebind = [
		'{"type":"custom","customType":"rp-card","data":{"card":"assets/cards/sample-card.json","name":"Sample"},"id":"a1"}',
		'{"type":"custom","customType":"rp-card","data":{"card":"assets/cards/other.png","name":"Other Card"},"id":"a2"}',
	].join("\n");
	assert.deepEqual(parseCardFromSessionHead(rebind), {
		card: "assets/cards/other.png",
		name: "Other Card",
	});
	assert.equal(parseCardFromSessionHead('{"type":"header"}\n{"type":"message"}'), null);
	// 引用了字符串 "rp-card" 但不是条目：不误判
	assert.equal(parseCardFromSessionHead('{"type":"message","text":"聊到 rp-card 这个词"}'), null);
});

test("summarizeToolResult：取首个 text 块并截断", () => {
	assert.equal(summarizeToolResult({ content: [{ type: "text", text: "  设定内容  " }] }), "设定内容");
	assert.equal(summarizeToolResult({ content: [{ type: "image" }, { type: "text", text: "x".repeat(300) }] }).length, 201);
	assert.equal(summarizeToolResult({ content: [] }), "");
	assert.equal(summarizeToolResult(null), "");
});
