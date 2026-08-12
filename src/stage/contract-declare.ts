/**
 * 输出合约 v1 供数：装载期一次性模型声明（PLAN-RECTIFY §4.B v1 / M-R4 首件，2026-08-11）。
 *
 * 形状（铁律三的正形）：让读得懂卡的模型声明一次 → 声明落成数据
 * （`.liyuan/output-contract.declared.json`，按指纹缓存）→ harness 死板执行
 * （谢幕注入照单点名）。识别器（cardStatusBarFormats）退出供数主链，
 * 降级为「声明失败/未开启」的保守回退——冻结、只降不升。
 *
 * 判据偏保守（兜底哲学 8/11）：漏收无害——合约管催不管拦，点不到名的块
 * 模型自行捡回、mergeFinalText 认块形不认名字照样入稿；错收有害——
 * 8/02 事故＝逼一张没有状态栏的卡交状态栏，模型当场发明标签塞正文。
 *
 * 指纹 = 卡内容 + 预设块内容 + 预设块开关（切开关改变送模面 → 必须重声明；
 * 与 presetFingerprint 不同——那边刻意排除 enabled，此处刻意包含）。
 * 声明产物仍经 syncOutputContract 落用户可改文件：用户改过，永远以文件为准。
 *
 * 纯函数 + 注入调用，零 pi 依赖，可单测。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RpPreset } from "../preset.ts";
import type { CharacterCard } from "../types.ts";
import { parseContract, type OutputContractModule } from "./output-contract.ts";

const DECLARED_FILE = "output-contract.declared.json";

/** 声明缓存指纹：卡全文 + 预设块内容 + 预设块开关位图 */
export function declareFingerprint(card: CharacterCard, preset: RpPreset | null | undefined): string {
	const h = createHash("sha1");
	h.update(JSON.stringify(card));
	for (const b of preset?.blocks ?? []) h.update(`${b.id} ${b.enabled ? 1 : 0} ${b.name ?? ""} ${b.content}`);
	return h.digest("hex").slice(0, 16);
}

/** 截断供料（一次性装载调用，供料求全但设上限；截断必须留痕，不做静默丢弃） */
const clip = (text: string, max: number): string =>
	text.length <= max ? text : `${text.slice(0, max)}\n……（此件超长，已截断 ${text.length - max} 字）`;

const SYSTEM_PROMPT = [
	"你是梨园的装载检查员。通读下面的角色卡与预设材料，一次性声明「输出合约」：",
	"这套卡+预设演出时，每拍正文结束后应输出哪些格式块（如状态栏、点评块、选项框）。",
	"声明落成数据后由程序逐拍照单执行，你只声明这一次。",
	"",
	"判据：",
	"- 只收录卡或预设明确要求每拍末尾输出、并给出了具体格式示范的块。",
	"- 拿不准的不收：漏收无害（演出模型读得懂卡，会自行补上）；错收有害（程序会逐拍点名，错收等于逼演出模型硬造这张卡没有的块）。",
	"- 正文本身、思考过程、变量/记账协议、只在开场出现一次的内容，都不是格式块。",
	"",
	"只输出一个 JSON 对象，不要任何其他文字：",
	'{"modules":[{"tag":"state1","source":"card","form":"pair","hint":"状态栏"},{"tag":"catsay","source":"preset","form":"pair","hint":"猫猫点评"}]}',
	"",
	"字段：",
	"- tag：标签名（不含尖括号）；``` 围栏式块没有标签，写它的名称（如：状态栏）。",
	"- source：这个块的格式定义出自哪里——card 或 preset。",
	"- form：pair＝成对标签 <tag>…</tag>；placeholder＝自闭合 <tag/>（界面由卡渲染，正文只留占位）；fence＝``` 围栏块。",
	"- hint：≤12 字，说明这个块是什么（如：状态栏／咪咪点评／行动选项）。",
	"- 这套卡+预设什么都不要求，就输出 {\"modules\":[]}。",
].join("\n");

/**
 * 声明调用的送料：卡的格式示范位（开场白/对话示例/作者指令/卡内世界书——
 * 8/10 教训：某卡的围栏状态栏正式定义在 character_book 停用条目里，
 * 识别器不扫世界书＝唯一活信号只剩开场白）＋预设启用块全文。
 * 识别器初判不供料（8/11 实弹：初判行成锚，声明模型确认锚就交卷、漏掉条目里
 * 明写的 options——识别器彻底退出供数链，声明只看署名原文）。
 */
export function buildDeclarePrompt(
	card: CharacterCard,
	preset: RpPreset | null | undefined,
): { systemPrompt: string; userText: string } {
	const parts: string[] = [`# 角色卡「${card.name}」`, "", "## 开场白", clip(card.firstMes, 8000)];
	if (card.mesExample.trim()) parts.push("", "## 对话示例", clip(card.mesExample, 6000));
	if (card.systemPrompt.trim()) parts.push("", "## 卡作者 system prompt", clip(card.systemPrompt, 4000));
	if (card.postHistoryInstructions.trim()) parts.push("", "## 卡作者末端指令", clip(card.postHistoryInstructions, 4000));
	if (card.book.length > 0) {
		parts.push("", "## 卡内世界书");
		let used = 0;
		let omitted = 0;
		for (const e of card.book) {
			const body = clip(e.content, 1500);
			if (used + body.length > 15000) {
				omitted++;
				continue;
			}
			used += body.length;
			parts.push("", `### ${e.comment || `条目 ${e.uid}`}${e.enabled ? "" : "（停用）"}`, body);
		}
		if (omitted > 0) parts.push("", `（另有 ${omitted} 条超出篇幅，略）`);
	}
	const enabledBlocks = (preset?.blocks ?? []).filter((b) => b.enabled && b.content.trim());
	if (enabledBlocks.length > 0) {
		parts.push("", `# 预设「${preset!.name}」启用块`);
		let used = 0;
		let omitted = 0;
		for (const b of enabledBlocks) {
			if (used + b.content.length > 60000) {
				omitted++;
				continue;
			}
			used += b.content.length;
			parts.push("", `### ${b.name || b.id}`, b.content);
		}
		if (omitted > 0) parts.push("", `（另有 ${omitted} 块超出篇幅，略）`);
	}
	return { systemPrompt: SYSTEM_PROMPT, userText: parts.join("\n") };
}

/** 标签合法形（与 mergeFinalText 的 FORMAT_TAIL_RE 同一字符集——声明的标签必须能被定稿合并认出） */
const TAG_RE = /^[A-Za-z_一-鿿][\w一-鿿.\-]*$/;

/**
 * 解析声明应答。宽松取第一个 `{`…最后一个 `}`（容忍围栏/前后闲话）；
 * 形状不对返回 null（调用方回退 v0）。空 modules 是合法声明（这套卡什么都不要）。
 * 死板卫生检查（不是内容判断）：非法标签丢弃、同名去重、上限 8 条防跑飞。
 */
export function parseDeclared(text: string): OutputContractModule[] | null {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start < 0 || end <= start) return null;
	const mods = parseContract(text.slice(start, end + 1));
	if (!mods) return null;
	const out: OutputContractModule[] = [];
	for (const m of mods) {
		const tag = m.tag.trim();
		if (m.form === "fence") {
			if (tag.length === 0 || tag.length > 24 || /[\n`<>]/.test(tag)) continue;
		} else if (!TAG_RE.test(tag)) continue;
		if (out.some((x) => x.tag === tag)) continue;
		out.push({
			tag,
			source: m.source === "preset" ? "preset" : "card",
			form: m.form,
			...(m.hint ? { hint: m.hint.slice(0, 60) } : {}),
		});
		if (out.length >= 8) break;
	}
	return out;
}

interface DeclaredCache {
	fingerprint: string;
	modules: OutputContractModule[];
}

/** 读声明缓存（宽松；坏文件当无缓存） */
export function loadDeclaredContract(cwd: string): DeclaredCache | null {
	const file = join(cwd, ".liyuan", DECLARED_FILE);
	if (!existsSync(file)) return null;
	try {
		const raw = JSON.parse(readFileSync(file, "utf8")) as { fingerprint?: unknown; modules?: unknown };
		if (typeof raw.fingerprint !== "string" || !raw.fingerprint) return null;
		const mods = parseContract(JSON.stringify({ modules: raw.modules }));
		if (!mods) return null;
		return { fingerprint: raw.fingerprint, modules: mods };
	} catch {
		return null;
	}
}

/**
 * 取本套卡+预设的声明合约：指纹命中缓存直接用；未命中做一次声明调用并落缓存。
 * 返回 null＝本次声明失败（网络/模型跑偏），调用方回退 v0 且本进程内不再重试同指纹
 * （失败不落缓存——重启/换卡后自然重试）。文件层任何故障不影响开演。
 */
export async function ensureDeclaredContract(
	cwd: string,
	fingerprint: string,
	run: () => Promise<string | { error: string }>,
): Promise<OutputContractModule[] | null> {
	const cached = loadDeclaredContract(cwd);
	if (cached && cached.fingerprint === fingerprint) return cached.modules;
	const resp = await run();
	// 原始应答落盘（成败都落）——声明是一次性采样，不留底就无法验尸（8/11 教训：
	// 首次实弹漏声明 options，无从判断是模型没说还是解析丢了）
	const logRaw = (status: string, body: string) => {
		try {
			const dir = join(cwd, ".liyuan");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "output-contract.declared.raw.txt"),
				`# ${new Date().toISOString()} fp=${fingerprint} ${status}\n\n${body}\n`,
				"utf8",
			);
		} catch {
			// 日志写失败不影响声明
		}
	};
	if (typeof resp !== "string") {
		logRaw("调用失败", resp.error);
		console.error(`[stage-contract] 输出合约声明失败：${resp.error}`);
		return null;
	}
	const modules = parseDeclared(resp);
	if (!modules) {
		logRaw("应答不可解析", resp);
		const flat = resp.trim().replace(/\s+/g, " ");
		console.error(`[stage-contract] 声明应答不可解析（${resp.length} 字）：${flat.slice(0, 200)}`);
		return null;
	}
	logRaw("成功", resp);
	try {
		const dir = join(cwd, ".liyuan");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, DECLARED_FILE), JSON.stringify({ fingerprint, modules }, null, "\t"), "utf8");
	} catch {
		// 缓存写失败不影响本拍（下拍会重声明）
	}
	return modules;
}
