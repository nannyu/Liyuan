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

import { loadCardFile, readCardRawJson, applyMacros } from "../card.ts";
import { cardStatusBarFormats } from "../cardfront.ts";
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
import { stripProtocolEntries, type ProtocolDrop } from "../protocol-detect.ts";
import {
	assemble,
	type AssembledPiece,
	type AssembleReportItem,
	type DepthPiece,
	type MarkerMaterials,
} from "../preset-assemble.ts";
import { loadPresetDoc, type PresetDoc } from "../preset-doc.ts";
import { resolveConfigPath } from "../paths.ts";
import { DEFAULT_CONFIG, type CharacterCard, type LorebookEntry, type RpConfig } from "../types.ts";

/**
 * 预设格式栈的已知标签：**只在送模历史整块剥**（防往拍模仿），显示层照常渲染。
 * 这些是用户要看的产出（咪咪点评/选择框/变量面板），不是脚手架。
 */
const FORMAT_STACK_TAGS = ["w2g", "catsay", "UpdateVariable", "JSONPatch", "Analysis", "draft_notes", "wfeeling"];

/**
 * 预设装配产物的一片。marker 槽位填的是梨园材料（卡/世界书/人设的原文），
 * 预设块填的是宏求值后的原文——两者都不加 harness 引导语。
 */
export type { AssembledPiece } from "../preset-assemble.ts";

export interface StageMaterials {
	config: RpConfig;
	card: CharacterCard;
	/** 已挂载世界书 + 补充设定集 overlay，禁用项与外部插件协议条目已剔除 */
	entries: LorebookEntry[];
	/** 预设文档（原文 + 归一条目）；null＝未配置且无默认预设 */
	presetDoc: PresetDoc | null;
	/** 装配产物：chatHistory 槽位之前的片段（含已归位的 marker 材料），按预设作者原序 */
	presetBefore: AssembledPiece[];
	/** injection_position=1 的深度注入片段（数据层保真；消费待后续里程碑接入） */
	presetDepth: DepthPiece[];
	/** 预设声明过的 marker 槽位 id——没声明的槽位由梨园按兜底版式补，避免卡内容丢失 */
	declaredMarkers: Set<string>;
	/** skill 一等素材位（M-R2）：工作目录 skills/<name>/SKILL.md 扫描产物 */
	skillFiles: SkillFile[];
	/** 装配报告：每块去向（engine 落盘 .liyuan/preset-assembly.json） */
	presetAssembly: AssembleReportItem[];
	/** 历史前段全部求值后内容——机械规则提取（extractDraftRules）用 */
	presetRuleTexts: string[];
	/** marker 槽位材料（卡/世界书/人设）——引擎每拍重装历史后段时复用同一份 */
	markerMaterials: MarkerMaterials;
	/** 任一渠道有启用块——扮演规范让位给预设的判定依据 */
	presetActive: boolean;
	/** 卡作者状态栏格式（StatusBlock / state1…）；空=卡未设计，勿硬造 */
	statusBarFormats: string[];
	/** 宏求值遇到的清单外宏名（供引擎降级告警） */
	macroWarnings: string[];
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

	// 预设：工作草稿（preset-override.json）优先，与预设页签热编辑一致。落盘即原文，这里只读不转换。
	const readDoc = (abs: string, name: string): PresetDoc | null => {
		if (!existsSync(abs)) return null;
		try {
			return loadPresetDoc(JSON.parse(readFileSync(abs, "utf8")), name);
		} catch {
			return null;
		}
	};
	let presetDoc: PresetDoc | null = null;
	if (config.preset) {
		const name = (config.preset.split(/[\\/]/).pop() ?? config.preset).replace(/\.json$/i, "");
		presetDoc =
			readDoc(join(cwd, ".liyuan", "preset-override.json"), name) ?? readDoc(resolvePath(cwd, config.preset), name);
	} else {
		// §4.A 默认预设：文风兜底迁出源码，数据发行（presets/默认.json，用户可见可改可换）。
		// 只在没有用户预设时装；用户预设在场完全不装（不叠加）。
		presetDoc = readDoc(join(cwd, "presets", "默认.json"), "默认");
	}

	// marker 材料：梨园按酒馆的槽位交货，**位置由预设作者的 prompt_order 决定**。
	// 填的是原文——包装（标题/小节名）归预设作者，梨园不替他们加话（铁律一）。
	const macroCtx = { charName: card.name, userName: config.userName };
	const markerMaterials: MarkerMaterials = {};
	const putSlot = (slot: keyof MarkerMaterials, text: string | undefined): void => {
		if (text && text.trim()) markerMaterials[slot] = applyMacros(text, macroCtx);
	};
	putSlot("charDescription", card.description);
	putSlot("charPersonality", card.personality);
	putSlot("scenario", card.scenario);
	putSlot("dialogueExamples", card.mesExample);
	putSlot("personaDescription", config.userPersona);
	// 梨园的 LorebookEntry 没有 ST 的 before/after position，常驻条目整份交 worldInfoBefore
	const constantLore = constantEntries(entries);
	if (constantLore.length > 0) {
		putSlot(
			"worldInfoBefore",
			constantLore.map((e) => `- ${e.comment ? `【${e.comment}】` : ""}${e.content}`).join("\n"),
		);
	}

	// 装配：模拟酒馆引擎按开关拼一次。历史后段每拍重装（{{lastusermessage}}），此处只取静态面。
	const assembled = presetDoc
		? assemble(presetDoc.entries, { materials: markerMaterials, charName: card.name, userName: config.userName })
		: null;
	const presetBefore = assembled?.before ?? [];
	const presetDepth = assembled?.depth ?? [];
	const declaredMarkers = new Set((assembled?.markers ?? []).map((mk) => mk.id));
	const presetAssembly = assembled?.report ?? [];
	const presetRuleTexts = presetBefore.filter((p) => p.source === "block").map((p) => p.text);
	const presetActive = !!assembled && assembled.before.length + assembled.after.length + assembled.depth.length > 0;
	const unsupported = new Set(assembled?.unsupported ?? []);

	// 显示层折叠标签：预设约定的思维链/草稿标签在 UI 折叠（server 侧注册表）；
	// 格式栈标签（catsay/w2g…）只注册到**历史剥**通道——它们是用户要看的产出，
	// 混进 extraFold 会让显示层连内容一起删（8/05：模型写了咪咪点评，屏上没有）。
	resetDisplayTagExtras();
	if (presetDoc) {
		const discovered = discoverFoldTagsFromTexts(
			presetDoc.entries.filter((e) => e.enabled && !e.marker).map((e) => e.content),
		);
		if (discovered.length) addFoldTags(discovered);
		addHistoryStripTags(FORMAT_STACK_TAGS);
	}

	return {
		config,
		card,
		entries,
		presetDoc,
		presetBefore,
		presetDepth,
		declaredMarkers,
		skillFiles: scanSkillFiles(cwd),
		presetAssembly,
		presetRuleTexts,
		markerMaterials,
		presetActive,
		statusBarFormats,
		macroWarnings: [...unsupported],
		protocolDrops,
	};
}

/**
 * 历史后段每拍重装（{{lastusermessage}} 在此生效）。
 *
 * 整份重跑而不是"接着历史前段的变量表往下算"——酒馆每轮就是整份重拼，
 * 只重算后半段会让 `getvar` 看到的值与酒馆不一致。前半段字节稳定（除非块里用了
 * `{{lastusermessage}}`），前缀缓存不受影响。无预设或后段为空返回 undefined。
 */
export function assemblePresetAfter(m: StageMaterials, userText: string): AssembledPiece[] | undefined {
	if (!m.presetDoc) return undefined;
	const r = assemble(m.presetDoc.entries, {
		materials: m.markerMaterials,
		charName: m.card.name,
		userName: m.config.userName,
		userText,
	});
	return r.after.length > 0 ? r.after : undefined;
}

/** 常驻世界书条目（enabled+constant，按 order 排序）——system prompt 素材 */
export function constantLoreOf(m: StageMaterials): LorebookEntry[] {
	return constantEntries(m.entries);
}
