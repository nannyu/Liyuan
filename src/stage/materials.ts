/**
 * 台上素材装载（PLAN-RP-HARNESS M1）。
 *
 * 每拍开演前从磁盘现读：配置 / 角色卡 / 世界书 / 预设（宏求值）。
 * 引擎每回合调用一次——改卡、改预设、挂书即时生效，没有热重载缝隙。
 * 顺带刷新显示层折叠标签注册表（server 侧单实例，与扩展无共享）。
 *
 * 本模块只读盘、不写盘、零 pi 依赖。
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { loadCardFile, readCardRawJson } from "../card.ts";
import { cardStatusBarFormats } from "../cardfront.ts";
import { stripAuditLines } from "../draft.ts";
import {
	applyDisabledLore,
	constantEntries,
	loadLorebookFile,
	mergeEntries,
	mountedLorebookPaths,
	overlayPathFor,
	setMountedLorebooks,
} from "../lorebook.ts";
import { addFoldTags, addHistoryStripTags, discoverFoldTagsFromTexts, resetDisplayTagExtras } from "../postprocess.ts";
import { createMacroEnv, evalPresetMacros } from "../preset-macro.ts";
import { stripProtocolEntries, type ProtocolDrop } from "../protocol-detect.ts";
import {
	findSplitTable,
	lookupBlockRule,
	reportItemFor,
	type AssemblyReportItem,
	type PresetSplitTable,
} from "../preset-split.ts";
import { enabledBlocks, normalizeRpPreset, type PresetBlock, type RpPreset } from "../preset.ts";
import { ensurePresetSkills, splitWithManifest, type PresetSkillManifest } from "../preset-skill.ts";
import { resolveConfigPath } from "../paths.ts";
import { DEFAULT_CONFIG, type CharacterCard, type LorebookEntry, type RpConfig } from "../types.ts";

/**
 * 预设格式栈的已知标签：**只在送模历史整块剥**（防往拍模仿），显示层照常渲染。
 * 这些是用户要看的产出（咪咪点评/选择框/变量面板），不是脚手架。
 */
const FORMAT_STACK_TAGS = ["w2g", "catsay", "UpdateVariable", "JSONPatch", "Analysis", "draft_notes", "wfeeling"];

/**
 * 预设常驻内容的一片（M-R1 原序化）：原文原序原通道，section 只作装配报告的记账标签，
 * 不再决定送模呈现（旧 A/B/C 三节归拢＋引导语已按 PLAN-RECTIFY §2.1-9 拆除）。
 */
export interface ResidentPiece {
	/** 出处块名（署名；变量/救出条目用「｛变量 X｝」「｛救出：源｝」形） */
	name: string;
	section: "A" | "B" | "C";
	text: string;
}

export interface StageMaterials {
	config: RpConfig;
	card: CharacterCard;
	/** 已挂载世界书 + 补充设定集 overlay，禁用项与外部插件协议条目已剔除 */
	entries: LorebookEntry[];
	preset: RpPreset | null;
	/** 拆层表（内置命中；null＝未知预设走四类兜底）——engine 对 postHistory 每拍复用 */
	splitTable: PresetSplitTable | null;
	/** 预设→skill 投影 manifest（PLAN-PRESET-SKILL；用户改判在 engine 每拍重拆时也生效） */
	presetSkillManifest: PresetSkillManifest | null;
	/** M-C 拆层产物（system 通道，静态）：常驻内容按预设原序（M-R1：零归拢零引导语） */
	presetResident: ResidentPiece[];
	/** skill 包（两通道 D/E 静态拼装）：topic → 文本；skill_read 工具的进口兜底 */
	skillPacks: Map<string, string>;
	/** skill 一等素材位（M-R2）：工作目录 skills/<name>/SKILL.md 扫描产物 */
	skillFiles: SkillFile[];
	/** 装配报告：每块性质/去向（PLAN §5.3 可视化；engine 落盘 .liyuan/preset-assembly.json） */
	presetAssembly: AssemblyReportItem[];
	/** system 渠道全部求值后内容——机械规则提取（extractDraftRules）用，扫全量含 H 类 */
	presetRuleTexts: string[];
	/** system 块求值后的变量表快照（postHistory 求值的初值） */
	presetVarSnapshot: Map<string, string>;
	/** 任一渠道有启用块——扮演规范让位给预设的判定依据 */
	presetActive: boolean;
	/** 卡作者状态栏格式（StatusBlock / state1…）；空=卡未设计，勿硬造 */
	statusBarFormats: string[];
	/** 宏求值遇到的清单外宏名（供引擎降级告警） */
	macroWarnings: string[];
	/** 句级过滤摘掉的验算/格式栈指令行数（可观测性） */
	auditLinesDropped: number;
	/** M-C2：被判死的外部插件协议条目（世界书通道 H 类退场，进装配报告） */
	protocolDrops: ProtocolDrop[];
}

const resolvePath = (cwd: string, p: string): string => (isAbsolute(p) ? p : join(cwd, p));

/** 读配置（含旧字段迁移）；文件缺失/损坏回落默认 */
export function loadStageConfig(cwd: string): RpConfig {
	const configPath = resolveConfigPath(cwd);
	let raw: RpConfig = { ...DEFAULT_CONFIG };
	if (existsSync(configPath)) {
		try {
			raw = { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(configPath, "utf8")) as Partial<RpConfig>) };
		} catch {
			raw = { ...DEFAULT_CONFIG };
		}
	}
	return setMountedLorebooks(raw, mountedLorebookPaths(raw));
}

/** skill 文件（agentskills.io 布局：skills/<name>/SKILL.md，frontmatter name+description 必填） */
export interface SkillFile {
	name: string;
	/** L1 触发面（只写 when）；进 system `# 可用 skill` 索引 */
	description: string;
	/** 常驻档：正文随 system 送达（每拍都用的流程骨架）；拉取档走 skill_read */
	resident: boolean;
	/** 必定读取（每轮）：落笔前受理门强制先 skill_read（制造停顿=死磕燃料）；与 resident 互斥 */
	everyBeat: boolean;
	body: string;
	/** 存储目录名（skills/<dir>/SKILL.md；编辑器按它定位文件，通常与 name 一致） */
	dir?: string;
}

/**
 * 扫描 skills/ 目录（M-R2 §4.C）。frontmatter 缺 name/description 的包跳过（不猜）；
 * 解析是死板的数据读取——内容全部署名归包作者，harness 零改写。
 */
export function scanSkillFiles(cwd: string): SkillFile[] {
	const root = join(cwd, "skills");
	if (!existsSync(root)) return [];
	const out: SkillFile[] = [];
	for (const dir of readdirSync(root, { withFileTypes: true })) {
		if (!dir.isDirectory()) continue;
		const file = join(root, dir.name, "SKILL.md");
		if (!existsSync(file)) continue;
		let raw = "";
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		// frontmatter: --- fence, key: value lines (no regex; line-based)
		const rawLines = raw.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
		if ((rawLines[0] ?? "").trim() !== "---") continue;
		const endIdx = rawLines.findIndex((l, i) => i > 0 && l.trim() === "---");
		if (endIdx < 0) continue;
		const meta = new Map<string, string>();
		for (const line of rawLines.slice(1, endIdx)) {
			const colon = line.indexOf(":");
			if (colon > 0) meta.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
		}
		const name = meta.get("name") ?? "";
		const description = meta.get("description") ?? "";
		if (!name || !description) continue;
		out.push({
			name,
			description: description.slice(0, 1024),
			resident: meta.get("resident") === "true",
			everyBeat: meta.get("每轮") === "true",
			body: rawLines.slice(endIdx + 1).join("\n").trim(),
			dir: dir.name,
		});
	}
	return out;
}

/** 装载一拍所需全部素材；卡缺失/损坏时抛错（引擎转告用户，不演） */
export function loadStageMaterials(cwd: string): StageMaterials {
	const config = loadStageConfig(cwd);

	const cardAbs = resolvePath(cwd, config.card);
	const card = loadCardFile(cardAbs);
	let statusBarFormats: string[] = [];
	try {
		statusBarFormats = cardStatusBarFormats(readCardRawJson(cardAbs).raw);
	} catch {
		statusBarFormats = [];
	}

	// 世界书：已挂载独立书（0..N）+ 补充设定集 overlay；卡内 character_book 不自动进上下文
	const fileGroups: LorebookEntry[][] = [];
	for (const rel of mountedLorebookPaths(config)) {
		const abs = resolvePath(cwd, rel);
		if (existsSync(abs)) fileGroups.push(loadLorebookFile(abs));
	}
	const fileEntries = mergeEntries(...fileGroups);
	const overlayFile = overlayPathFor(cwd, card.name);
	const overlayEntries = existsSync(overlayFile) ? loadLorebookFile(overlayFile) : [];
	// 用户级停用 → 外部插件协议判死（M-C2）。协议条目是 H 类「脑内 harness」：
	// 指望酒馆插件解析的输出格式强制令，梨园无解析器且原生 world_state_update 已覆盖其功能，
	// 留着只会与 draft_write「纯剧情文字」互斥（实测首拍 31% 思考 + 正文污染 + 双份记账）。
	const protocolFiltered = stripProtocolEntries(
		applyDisabledLore(mergeEntries(fileEntries, overlayEntries), config.disabledLore),
	);
	const entries = protocolFiltered.entries;
	const protocolDrops = protocolFiltered.dropped;

	// 预设：工作草稿（preset-override.json）优先，与预设页签热编辑一致
	let preset: RpPreset | null = null;
	if (config.preset) {
		const overridePath = join(cwd, ".liyuan", "preset-override.json");
		if (existsSync(overridePath)) {
			try {
				preset = normalizeRpPreset(JSON.parse(readFileSync(overridePath, "utf8")));
			} catch {
				preset = null;
			}
		}
		const presetPath = resolvePath(cwd, config.preset);
		if (!preset && existsSync(presetPath)) {
			try {
				preset = normalizeRpPreset(JSON.parse(readFileSync(presetPath, "utf8")));
			} catch {
				preset = null;
			}
		}
	} else {
		// §4.A 默认预设：文风兜底迁出源码，数据发行（presets/默认.json，用户可见可改可换）。
		// 只在没有用户预设时装；用户预设在场完全不装（不叠加）。
		const defPath = join(cwd, "presets", "默认.json");
		if (existsSync(defPath)) {
			try {
				preset = normalizeRpPreset(JSON.parse(readFileSync(defPath, "utf8")));
			} catch {
				preset = null;
			}
		}
	}

	// system 块按序宏求值：前块 setvar、后块 getvar；postHistory 用**共享** probe 环境
	// 按序预演（承接 system 快照）——变量级拆层要看到 postHistory setvar 的值
	// （防打断 hook 等在 postHistory 块里 set，放出点块被退场后值经 vars 表救出）。
	const macroEnv = createMacroEnv({ charName: card.name, userName: config.userName });
	const unsupported = new Set<string>();
	const evaledSystemBlocks: PresetBlock[] = [];
	let probedPhBlocks: PresetBlock[] = [];
	let probeVars = new Map<string, string>();
	if (preset) {
		for (const b of enabledBlocks(preset, "system")) {
			const r = evalPresetMacros(b.content, macroEnv);
			for (const u of r.unsupported) unsupported.add(u);
			evaledSystemBlocks.push({ ...b, content: r.text });
		}
		const probeEnv = { ...macroEnv, vars: new Map(macroEnv.vars) };
		probedPhBlocks = enabledBlocks(preset, "postHistory").map((b) => {
			const r = evalPresetMacros(b.content, probeEnv);
			for (const u of r.unsupported) unsupported.add(u);
			return { ...b, content: r.text };
		});
		probeVars = probeEnv.vars;
	}
	const presetActive =
		!!preset && (enabledBlocks(preset, "system").length > 0 || enabledBlocks(preset, "postHistory").length > 0);
	const presetRuleTexts = evaledSystemBlocks.map((b) => b.content).filter((t) => t.trim().length > 0);

	// ---- M-C 拆层（docs/PRESET-SPLIT-TAXONOMY.md）----
	const allEnabledNames = preset ? preset.blocks.filter((b) => b.enabled).map((b) => b.name) : [];
	const splitTable = preset ? findSplitTable(allEnabledNames) : null;
	// 预设→skill 投影（PLAN-PRESET-SKILL）：装载瞬间生成/更新 skills/预设-<名>/（无一蒸发，
	// manifest 可手改 fate）；生成失败不拦装配（投影是视图，不是装配依赖）
	let presetSkillManifest: PresetSkillManifest | null = null;
	try {
		presetSkillManifest = ensurePresetSkills(cwd, preset);
	} catch (err) {
		console.error(`[preset-skill] 投影生成失败：${err instanceof Error ? err.message : String(err)}`);
	}

	const presetResident: ResidentPiece[] = [];
	const skillPieces = new Map<string, string[]>();
	const presetAssembly: AssemblyReportItem[] = [];
	let auditLinesDropped = 0;

	/** resident B/C 产物统一过句级验算过滤（M4.5 行为延续，双保险）；A 原文不动 */
	const cleanResident = (text: string): string => {
		const r = stripAuditLines(text);
		auditLinesDropped += r.dropped;
		return r.text.trim();
	};
	const addSkillPiece = (topic: string, title: string, text: string): void => {
		const arr = skillPieces.get(topic) ?? [];
		arr.push(`## ${title}\n${text}`);
		skillPieces.set(topic, arr);
	};

	// system 通道：常驻按原序收集 + skill 收集；postHistory 通道：只收 skill（静态近似），
	// 常驻留给引擎每拍按真实求值内容重拆（支持 {{lastusermessage}}）。
	for (const b of evaledSystemBlocks) {
		if (!b.content.trim()) continue;
		const rule = lookupBlockRule(splitTable, b.name);
		const pieces = splitWithManifest(presetSkillManifest, b.id, rule, b.name ?? "", b.content);
		for (const r of pieces.resident) {
			const text = r.section === "A" ? r.text : cleanResident(r.text);
			if (text) presetResident.push({ name: b.name, section: r.section, text });
		}
		for (const s of pieces.skill) addSkillPiece(s.topic, b.name, s.text);
		presetAssembly.push(reportItemFor(pieces, b.name, "system", b.content.length));
	}
	for (const b of probedPhBlocks) {
		if (!b.content.trim()) continue;
		const rule = lookupBlockRule(splitTable, b.name);
		const pieces = splitWithManifest(presetSkillManifest, b.id, rule, b.name ?? "", b.content);
		for (const s of pieces.skill) addSkillPiece(s.topic, b.name, s.text);
		presetAssembly.push(reportItemFor(pieces, b.name, "postHistory", b.content.length));
	}

	// 变量级拆层：放出点被退场的内容（hook/push_rule/meta）与死变量救活（anti_verbose）
	for (const v of splitTable?.vars ?? []) {
		const raw = (probeVars.get(v.name) ?? "").trim();
		if (!raw) continue;
		const text = v.stripLines ? raw.split("\n").filter((l) => !v.stripLines!.some((p) => p.test(l))).join("\n").trim() : raw;
		if (!text) continue;
		if (v.fate === "resident") {
			const section = v.section ?? "C";
			const cleaned = cleanResident(text);
			if (cleaned) presetResident.push({ name: `｛变量 ${v.name}｝`, section, text: cleaned });
			presetAssembly.push({ name: `｛变量 ${v.name}｝`, channel: "postHistory", chars: text.length, nature: "C", fate: `常驻${section}` });
		} else if (v.fate === "skill") {
			addSkillPiece(v.topic ?? "general", `变量 ${v.name}`, text);
			presetAssembly.push({ name: `｛变量 ${v.name}｝`, channel: "postHistory", chars: text.length, nature: "D", fate: `skill:${v.topic ?? "general"}` });
		}
	}
	// 转述救出的规则句（手工校准，出处块进报告）
	for (const s of splitTable?.supplements ?? []) {
		presetResident.push({ name: `｛救出：${s.source}｝`, section: s.section, text: s.text });
		presetAssembly.push({ name: `｛救出：${s.source}｝`, channel: "postHistory", chars: s.text.length, nature: "C", fate: `常驻${s.section}` });
	}

	const skillPacks = new Map<string, string>();
	for (const [topic, arr] of skillPieces) skillPacks.set(topic, arr.join("\n\n"));

	// 显示层折叠标签：预设约定的思维链/草稿标签在 UI 折叠（server 侧注册表）；
	// 格式栈标签（catsay/w2g…）只注册到**历史剥**通道——它们是用户要看的产出，
	// 混进 extraFold 会让显示层连内容一起删（8/05：模型写了咪咪点评，屏上没有）。
	resetDisplayTagExtras();
	if (preset) {
		const discovered = discoverFoldTagsFromTexts(preset.blocks.filter((b) => b.enabled).map((b) => b.content));
		if (discovered.length) addFoldTags(discovered);
		addHistoryStripTags(FORMAT_STACK_TAGS);
	}

	return {
		config,
		card,
		entries,
		preset,
		splitTable,
		presetSkillManifest,
		presetResident,
		skillPacks,
		skillFiles: scanSkillFiles(cwd),
		presetAssembly,
		presetRuleTexts,
		presetVarSnapshot: macroEnv.vars,
		presetActive,
		statusBarFormats,
		macroWarnings: [...unsupported],
		auditLinesDropped,
		protocolDrops,
	};
}

/**
 * postHistory 块每拍求值：变量继承 system 块快照，{{lastusermessage}} 用本拍用户原文；
 * 全空块滤除。无预设或无块返回 undefined。
 *
 * 注：这里**不做**拆层——调用方（引擎）对每拍真实求值内容按 splitTable 分流
 * （A 原文/B/C 归拢进末端；D/E 已在装载期静态入 skillPacks，引擎侧跳过）。
 */
export function evalPostHistoryBlocks(m: StageMaterials, userText: string): PresetBlock[] | undefined {
	if (!m.preset) return undefined;
	const blocks = enabledBlocks(m.preset, "postHistory");
	if (blocks.length === 0) return undefined;
	const env = createMacroEnv({ charName: m.card.name, userName: m.config.userName, userText });
	env.vars = new Map(m.presetVarSnapshot);
	const out = blocks.map((b) => ({ ...b, content: evalPresetMacros(b.content, env).text }));
	const nonEmpty = out.filter((b) => b.content.trim().length > 0);
	return nonEmpty.length > 0 ? nonEmpty : undefined;
}

/** 常驻世界书条目（enabled+constant，按 order 排序）——system prompt 素材 */
export function constantLoreOf(m: StageMaterials): LorebookEntry[] {
	return constantEntries(m.entries);
}
