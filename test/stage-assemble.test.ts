import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
	buildStageInjection,
	buildStageSystemPrompt,
	detectsLanguageMismatch,
	formatLoreIndex,
	rebuildHistory,
	stateFromBranch,
	codexNamesFromBranch,
	type BranchEntryLike,
} from "../src/stage/assemble.ts";
import type { DisplayRule } from "../src/cardfront.ts";
import { extractDraftRules } from "../src/draft.ts";
import { assemblePresetAfter, constantLoreOf, loadStageMaterials } from "../src/stage/materials.ts";
import { defaultState } from "../src/state.ts";
import { DEFAULT_CONFIG, type RpConfig } from "../src/types.ts";

// ---------------- 分支 → 历史 ----------------

const userE = (text: string): BranchEntryLike => ({
	type: "message",
	message: { role: "user", content: [{ type: "text", text }] },
});
const asstE = (text: string): BranchEntryLike => ({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text }] },
});

test("rebuildHistory：开场白→assistant、补丁套用、过程条目蒸发、同角色合并", () => {
	const branch: BranchEntryLike[] = [
		{ type: "custom_message", customType: "rp-greeting", content: "【开场】她回头。" },
		{ type: "custom", customType: "rp-state", data: { scene: "山门" } },
		userE("我上前行礼。"),
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "内心盘算……" },
					{ type: "text", text: "云澜受了半礼，袖口沾着晨露。" },
				],
			},
		},
		// 同拍第二条 assistant（旧会话工具轮之间的散文本）→ 应与上条合并
		asstE("「起来吧。」"),
		// 补丁：定点替换
		{ type: "custom_message", customType: "rp-draft-op", content: JSON.stringify({ old: "晨露", new: "夜霜" }) },
		// 工具回执（旧会话残留）→ 不进历史
		{ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "ok" }] } },
		userE("说明来意。"),
	];
	const { history, lastUserText, lastNarrativeText } = rebuildHistory(branch);

	assert.equal(history[0].role, "assistant");
	assert.ok(history[0].text.includes("【开场】"));
	assert.equal(history.length, 4); // 开场 / user / assistant(合并) / user
	assert.ok(history[2].text.includes("夜霜"), "补丁应套用");
	assert.ok(!history[2].text.includes("晨露"));
	assert.ok(history[2].text.includes("「起来吧。」"), "同角色相邻合并");
	assert.ok(!history[2].text.includes("内心盘算"), "thinking 不进历史");
	assert.equal(lastUserText, "说明来意。");
	assert.ok(lastNarrativeText.includes("夜霜"), "语言检测源=最后台上叙事（含补丁）");
});

test("rebuildHistory：送模侧作者正则（promptOnly/破坏性）剥「作者不想让模型看」的块", () => {
	const branch: BranchEntryLike[] = [
		userE("你先进去。"),
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "正文一句。\n\n<w2g>选项：1 走 2 停</w2g>\n\n<SexualScene>内容</SexualScene>" },
				],
			},
		},
	];
	const promptRulesFixture: DisplayRule[] = [
		// TG-ai看不见 同款：剥 VariableCheck/SexualScene/Disclaimer/w2g
		{
			name: "TG-ai看不见",
			source: "<(VariableCheck|SexualScene|Disclaimer|w2g)>([\\s\\S]*?)<\\/\\1>|<!--([\\s\\S]*?)-->",
			flags: "g",
			replace: "",
		},
	];
	const { history } = rebuildHistory(branch, promptRulesFixture);
	const sent = history[history.length - 1].text;
	assert.ok(sent.includes("正文一句"), "正文保留");
	assert.ok(!sent.includes("w2g"), "作者 promptOnly 规则剥掉不想让模型看的块");
	assert.ok(!sent.includes("SexualScene"), "同上");
	// 对照组：不传规则 → 块原样进历史（unwrapped 内容仍在）
	const { history: ctrl } = rebuildHistory(branch);
	assert.ok(ctrl[ctrl.length - 1].text.includes("SexualScene") || ctrl[ctrl.length - 1].text.includes("内容"), "无规则时不剥");
});

test("rebuildHistory：幕后轮的回复不作语言检测源；rp-import 记为 user 侧", () => {
	const branch: BranchEntryLike[] = [
		{ type: "custom_message", customType: "rp-import", content: "【前情提要】旧事一段。" },
		userE("我环顾四周。"),
		asstE("殿内烛影摇动。"),
		userE("//帮我看下配置"),
		asstE("Config check done, everything looks fine and here is a long english reply for you."),
	];
	const { history, lastNarrativeText } = rebuildHistory(branch);
	assert.equal(history[0].role, "user");
	assert.ok(history[0].text.includes("前情提要"));
	assert.ok(lastNarrativeText.includes("烛影"), "幕后轮回复跳过，检测源回溯到台上叙事");
});

test("stateFromBranch：最近快照生效；无快照=初始", () => {
	const branch: BranchEntryLike[] = [
		{ type: "custom", customType: "rp-state", data: { scene: "旧场景" } },
		userE("走。"),
		{ type: "custom", customType: "rp-state", data: { scene: "新场景" } },
	];
	assert.equal((stateFromBranch(branch) as { scene?: string }).scene, "新场景");
	assert.deepEqual(stateFromBranch([userE("嗨")]), defaultState());
});

test("codexNamesFromBranch：最近挂载快照生效；随 rewind/fork 走；无快照=空", () => {
	const branch: BranchEntryLike[] = [
		{ type: "custom", customType: "rp-codex", data: { mounted: ["旧库"] } },
		userE("走。"),
		{ type: "custom", customType: "rp-codex", data: { mounted: ["甲库", "乙库"] } },
	];
	assert.deepEqual(codexNamesFromBranch(branch), ["甲库", "乙库"]);
	assert.deepEqual(codexNamesFromBranch([userE("嗨")]), []);
	// 卸载记为空数组快照，不是「无快照」
	assert.deepEqual(codexNamesFromBranch([{ type: "custom", customType: "rp-codex", data: { mounted: [] } }]), []);
	// 脏数据不炸：非数组/非字符串元素一律滤掉
	assert.deepEqual(codexNamesFromBranch([{ type: "custom", customType: "rp-codex", data: { mounted: "x" } }]), []);
	assert.deepEqual(
		codexNamesFromBranch([{ type: "custom", customType: "rp-codex", data: { mounted: ["甲", 5, null] } }]),
		["甲"],
	);
});

// ---------------- 提示词装配 ----------------

const card = {
	name: "云澜",
	description: "{{user}}的同门师姐。",
	personality: "冷静自持",
	scenario: "山门月下",
	mesExample: "",
	firstMes: "你来了。",
	alternateGreetings: [],
	systemPrompt: "",
	postHistoryInstructions: "",
	creatorNotes: "",
	tags: [],
	book: [],
};
const config: RpConfig = { ...DEFAULT_CONFIG, userName: "沈舟" };

test("system prompt：字节稳定、宏替换；扮演话语零残留（P1——扮演的每个字都有署名主人）", () => {
	const opts = { card, config, constantLore: [] };
	const a = buildStageSystemPrompt(opts);
	const b = buildStageSystemPrompt(opts);
	assert.equal(a, b, "同素材两次装配必须逐字节一致");
	assert.ok(a.includes("沈舟的同门师姐"), "{{user}} 宏应替换");
	assert.ok(a.includes("一场长篇沉浸式角色扮演"), "舞台声明在场（数据）");
	// D1/D2/D3：harness 扮演文案全数退场
	assert.ok(!a.includes("# 叙事与文风"), "D1：叙事与文风段已删");
	assert.ok(!a.includes("# 输出结构"), "D2：输出结构段已删");
	assert.ok(!a.includes("状态栏"), "状态栏在 system 零提及（唯一席位是谢幕注入）");
	assert.ok(!a.includes("资深作家") && !a.includes("倾尽所有"), "D3：作家咏叹调已删");
	assert.ok(!a.includes("主权") && !a.includes("绝不替"), "主权兜底迁默认预设，harness 不再持有");
	assert.ok(!a.includes("800–1500") && !a.includes("800-1500"), "篇幅兜底迁默认预设");
});

test("system prompt：# 工作方式 = 纯协议（§2.1-5 逐字）；tools=false 时不出现", () => {
	const p = buildStageSystemPrompt({ card, config, constantLore: [] });
	assert.ok(p.includes("# 工作方式"), "工作方式节在场");
	assert.ok(
		p.includes(
			"每拍第 1 轮用 `beat_plan` 列路标（没有戏的拍可 `draft_write` 一次交完）；正文用 `draft_append` 逐段写在稿纸上，写完 `draft_seal` 收笔。剧情走向要用户拍板时随时 `ask`。每轮注入的【进度】【判定】【记账】【谢幕】是当前状态，以它为准。",
		),
		"文案即规格，逐字一致",
	);
	const noTools = buildStageSystemPrompt({ card, config, constantLore: [], tools: false });
	assert.ok(!noTools.includes("# 工作方式"), "无工具形态不声明工作方式");
	assert.ok(!noTools.includes("memory_search") && !noTools.includes("lorebook_search"), "语义表的工具指引随 tools=false 摘除");
});

test("system prompt：消息流约定补齐名录/面板/索引语义（每拍注入借此瘦成纯数据）", () => {
	const p = buildStageSystemPrompt({ card, config, constantLore: [] });
	assert.ok(p.includes("标注【登场名录】"), "名录语义入表");
	assert.ok(p.includes("标注【活跃面板】"), "面板语义入表");
	assert.ok(p.includes("标注【设定集索引】"), "索引语义入表");
	assert.ok(p.includes("`memory_search`") && p.includes("`lorebook_search`"), "检索通道指引在语义表（一次说清）");
});

test("system prompt：梨园架构段最前，预设装配段随后、原文原序，harness 骨架殿后", () => {
	const withPreset = buildStageSystemPrompt({
		card,
		config,
		constantLore: [],
		presetBefore: ["破限框架原文。", "文风块：要生动。", "不替用户做重大决定。"],
	});
	assert.ok(withPreset.startsWith("# 梨园运行架构"), "架构段最前：模型先读梨园怎么运转，再读预设");
	const at = (t: string) => withPreset.indexOf(t);
	assert.ok(at("# 梨园运行架构") < at("破限框架原文。"), "架构段先于预设装配段");
	assert.ok(!withPreset.includes("# 预设指令（用户自备，按原序）"), "梨园不再给预设加标题（铁律一）");
	assert.ok(at("破限框架原文。") < at("文风块：要生动。") && at("文风块：要生动。") < at("不替用户做重大决定。"), "原序保持");
	assert.ok(at("不替用户做重大决定。") < at("# 舞台"), "harness 骨架殿后");
	assert.ok(!withPreset.includes("# 文风与写法") && !withPreset.includes("# 行为边界"), "B/C 归拢节已拆（零归拢）");
	// 架构段只讲系统怎么运转：不定义角色、不教写作、不举写作细节（那些归预设/工具描述）
	const arch = withPreset.slice(0, withPreset.indexOf("破限框架原文。"));
	assert.ok(!arch.includes("你是") && !arch.includes("你的名字"), "架构段不定义角色身份（碰破限）");
	assert.ok(!arch.includes("神态") && !arch.includes("对白") && !arch.includes("环境"), "架构段不举写作细节");
});

test("system prompt：marker 归位——预设声明过的槽位，梨园不再按自己版式重出一遍", () => {
	const rich = { ...card, description: "云澜是师姐。", personality: "冷。", scenario: "山门外。" };
	const declared = buildStageSystemPrompt({
		card: rich,
		config,
		constantLore: [],
		presetBefore: ["【预设槽位里的卡描述】云澜是师姐。"],
		declaredMarkers: new Set(["charDescription", "charPersonality", "personaDescription"]),
	});
	assert.ok(!declared.includes("# 用户扮演："), "personaDescription 已归位，兜底不再出");
	assert.ok(!declared.includes("## 性格"), "charPersonality 已归位");
	assert.ok(declared.includes("## 当前场景"), "scenario 没被声明 → 梨园兜底补上，卡内容不丢");

	const none = buildStageSystemPrompt({ card: rich, config, constantLore: [], presetBefore: ["旧格式预设无 marker。"] });
	assert.ok(none.includes("# 你扮演的角色：云澜") && none.includes("云澜是师姐。"), "一个槽位都没声明时全走兜底版式");
	assert.ok(none.includes("# 用户扮演："), "人设兜底在场");
});

test("末端注入：事实块——数据带标注送达，语义归 system；导演备注容器解散（D5/D6/D7）", () => {
	const inj = buildStageInjection({
		state: defaultState(),
		activatedLore: [],
		card: { ...card, postHistoryInstructions: "卡作者的末端叮嘱。" },
		config,
		presetTail: ["末端破限原文", "末端文风要点", "末端行为边界"],
		languageMismatch: true,
	});
	assert.ok(inj.startsWith("【世界状态】\n"), "世界状态最前，纯数据无解说");
	assert.ok(!inj.includes("正文不得与之矛盾"), "语义解说不再逐拍复述（在 system 语义表）");
	assert.ok(inj.includes("【预设末端指令】"), "预设末端原文直通");
	const at = (t: string) => inj.indexOf(t);
	assert.ok(at("末端破限原文") < at("末端文风要点") && at("末端文风要点") < at("末端行为边界"), "原序保持");
	assert.ok(!inj.includes("【文风与写法】") && !inj.includes("【行为边界】"), "零归拢");
	assert.ok(inj.includes("【卡作者末端指令】\n卡作者的末端叮嘱。"), "卡末端指令独立成块（D5）");
	assert.ok(!inj.includes("【导演备注】"), "D5：导演备注容器解散");
	assert.ok(!inj.includes("【状态栏】"), "D6：状态栏注入块已删（谢幕注入替代）");
	assert.ok(!inj.includes("【思考的用法】"), "D7：rehearsalGuard 注入整体删除");
	assert.ok(inj.includes("【语言】以中文写叙事与对白（专有名词可保留原文）。"), "语言一行（config 事实）");
	assert.ok(!inj.includes("演完本拍即停"), "「演完即停」句删——时序由判定/谢幕日程表达");
	assert.ok(inj.includes("【语言纠正】"), "语言自愈事实保留");
	assert.ok(!inj.includes("【登场名录】"), "无名录不出块");
});

test("末端注入：字数一行纯事实（§2.2）；无目标不出行", () => {
	const inj = buildStageInjection({
		state: defaultState(),
		activatedLore: [],
		card,
		config,
		wordRange: { min: 500, max: 800 },
	});
	assert.ok(inj.includes("本拍约 500–800 字"), "字数事实在场");
	assert.ok(!inj.includes("心里有数") && !inj.includes("朝这个量落笔") && !inj.includes("不必核算"), "纯事实，无落笔指令");
	const none = buildStageInjection({ state: defaultState(), activatedLore: [], card, config });
	assert.ok(!none.includes("本拍约"), "无目标不出行");
	assert.ok(!none.includes("800–1500"), "无预设兜底数字随 D1 迁出（默认预设数据承接）");
});

test("detectsLanguageMismatch：中文目标才判、样本要够长", () => {
	const en = "The moon hangs over the courtyard while she waits in silence for a long time tonight.";
	assert.equal(detectsLanguageMismatch(en, "中文"), true);
	assert.equal(detectsLanguageMismatch("殿内烛影摇动，她伏案未眠，窗外霜色渐重，更漏声一声一声敲在瓦上，夜风穿堂而过带起纸页。", "中文"), false);
	assert.equal(detectsLanguageMismatch("short", "中文"), false);
	assert.equal(detectsLanguageMismatch(en, "English"), false);
});

test("formatLoreIndex：只出标题、超预算截断", () => {
	const entries = Array.from({ length: 80 }, (_, i) => ({
		comment: `条目${i}标题较长一些`,
		keys: [`k${i}`],
		enabled: true,
	}));
	const line = formatLoreIndex(entries) ?? "";
	assert.ok(line.startsWith("共 80 条："));
	assert.ok(line.includes("未列出"));
	assert.ok(line.length < 700);
	assert.equal(formatLoreIndex([]), undefined);
});

// ---------------- 素材装载 ----------------

test("loadStageMaterials：卡+预设宏求值+postHistory 每拍求值", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-mat-"));
	try {
		writeFileSync(
			join(cwd, "card.json"),
			JSON.stringify({ data: { name: "云澜", description: "{{user}}的师姐", first_mes: "你来了。" } }),
		);
		writeFileSync(
			join(cwd, "preset.json"),
			JSON.stringify({
				blocks: [
					{ id: "s1", channel: "system", enabled: true, content: "{{setvar::tone::清冷}}文风基调：{{getvar::tone}}。" },
					{ id: "s2", channel: "system", enabled: false, content: "不该出现" },
					{ id: "p1", channel: "postHistory", enabled: true, content: "回应「{{lastusermessage}}」，保持{{getvar::tone}}。" },
				],
				samplers: { temperature: 0.9 },
			}),
		);
		writeFileSync(
			join(cwd, "liyuan.config.json"),
			JSON.stringify({ card: "card.json", preset: "preset.json", userName: "沈舟" }),
		);
		mkdirSync(join(cwd, ".liyuan"), { recursive: true });

		const m = loadStageMaterials(cwd);
		assert.equal(m.card.name, "云澜");
		assert.equal(m.presetActive, true);
		assert.equal(m.presetDoc?.kind, "rp", "旧梨园格式仍能读");
		assert.equal(m.presetBefore.length, 1, "启用块全量进历史前段（不再拆层退场）");
		assert.ok(m.presetBefore[0].text.includes("文风基调：清冷"), "setvar/getvar 链跨块生效");
		assert.equal(m.macroWarnings.length, 0);
		assert.equal(constantLoreOf(m).length, 0);

		const ph = assemblePresetAfter(m, "我上前行礼。") ?? [];
		assert.equal(ph.length, 1);
		assert.ok(ph[0].text.includes("回应「我上前行礼。」"), "lastusermessage 宏用本拍原文");
		assert.ok(ph[0].text.includes("保持清冷"), "历史后段照样看得到前面块设的变量");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("loadStageMaterials：启用块全量进提示词——拆层退场后不再有块被偷偷扔掉", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-pol-"));
	try {
		writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "云澜", first_mes: "你来了。" } }));
		writeFileSync(
			join(cwd, "preset.json"),
			JSON.stringify({
				blocks: [
					{ id: "style", channel: "system", enabled: true, content: "文风：冷而克制，短句为主。" },
					{ id: "pol", channel: "system", enabled: true, content: '词汇黑名单 = { "闪过", "一丝" }' },
				],
				samplers: {},
			}),
		);
		writeFileSync(
			join(cwd, "liyuan.config.json"),
			JSON.stringify({ card: "card.json", preset: "preset.json", userName: "沈舟" }),
		);
		mkdirSync(join(cwd, ".liyuan"), { recursive: true });

		const m = loadStageMaterials(cwd);
		assert.equal(m.presetBefore.length, 2, "两块都在——用户开着的块一个不扔");
		assert.equal(m.presetRuleTexts.length, 2, "规则提取看全量");

		const sp = buildStageSystemPrompt({
			card: m.card,
			config: m.config,
			constantLore: [],
			presetBefore: m.presetBefore.map((p) => p.text),
			declaredMarkers: m.declaredMarkers,
		});
		assert.ok(sp.includes("文风：冷而克制"), "文风块在场");
		assert.ok(sp.includes("词汇黑名单"), "纪律块也在场——判死改判归用户，梨园不代劳");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("默认预设（§4.A）：config.preset 空 → 装 presets/默认.json；用户预设在场完全不装", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-def-"));
	try {
		writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "云澜", first_mes: "你来了。" } }));
		writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", userName: "沈舟" }));
		mkdirSync(join(cwd, "presets"), { recursive: true });
		// 用仓库真身（数据发行件）——验的是「随包发行的那份」能被装载
		const real = readFileSync(join(process.cwd(), "presets", "默认.json"), "utf8");
		writeFileSync(join(cwd, "presets", "默认.json"), real);

		const m = loadStageMaterials(cwd);
		assert.equal(m.presetDoc?.name, "默认", "默认预设装载");
		assert.equal(m.presetActive, true, "presetActive 恒真（§4.A）");
		const resident = m.presetBefore.map((p) => p.text).join("\n");
		assert.ok(resident.includes("绝不替 沈舟"), "主权兜底由默认预设承接（宏已求值）");
		assert.ok(resident.includes("斜体"), "视角/排版承接");
		assert.ok(resident.includes("感官细节"), "感官承接");
		assert.ok(resident.includes("忌 AI 腔"), "忌AI腔承接");
		// 篇幅兜底数据化：extractDraftRules 能从默认预设提出 wordRange
		const rules = extractDraftRules(m.presetRuleTexts);
		assert.deepEqual(rules.wordRange, { min: 800, max: 1500 }, "篇幅从默认预设提取");

		// 用户预设在场：默认预设完全不装（不叠加）
		writeFileSync(
			join(cwd, "preset.json"),
			JSON.stringify({ name: "用户预设", samplers: {}, blocks: [{ id: "u1", channel: "system", enabled: true, content: "用户自己的文风。" }] }),
		);
		writeFileSync(
			join(cwd, "liyuan.config.json"),
			JSON.stringify({ card: "card.json", preset: "preset.json", userName: "沈舟" }),
		);
		const m2 = loadStageMaterials(cwd);
		assert.equal(m2.presetDoc?.name, "preset", "预设名取文件名，不取文件里写的 name");
		assert.ok(!m2.presetBefore.map((p) => p.text).join("").includes("绝不替"), "默认预设零叠加");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("预设原文直通：句级过滤退场，验算行也照进提示词", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-audit-"));
	try {
		writeFileSync(join(cwd, "card.json"), JSON.stringify({ data: { name: "云澜", description: "师姐" } }));
		writeFileSync(
			join(cwd, "preset.json"),
			JSON.stringify({
				name: "p",
				samplers: {},
				blocks: [
					{
						id: "style",
						name: "文风",
						channel: "system",
						role: "system",
						enabled: true,
						// 文风块夹带验算指令：块级判定会整块留下（不是纪律块），句级要摘掉那一行
						content: "<style>\n- 以直接对白为主。\n- 每段写完后自检是否出现禁用句式。\n</style>",
					},
					{
						id: "wc",
						name: "字数",
						channel: "system",
						role: "system",
						enabled: true,
						content: "正文字数 800-1200 字。",
					},
				],
			}),
		);
		writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "card.json", preset: "preset.json" }));

		const m = loadStageMaterials(cwd);
		const writing = m.presetBefore.map((p) => p.text).join("\n");
		assert.ok(writing.includes("以直接对白为主"), "文风指令原文直通");
		assert.ok(writing.includes("自检"), "句级过滤已退场——预设作者写的每一行都照进提示词（铁律一）");

		// 规则提取看的是同一份原文（字数规则照旧提得出）
		assert.ok(m.presetRuleTexts.join("\n").includes("800-1200"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
