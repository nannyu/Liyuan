/**
 * 输出合约（PLAN-RECTIFY §4.B v0）——「本拍谢幕要输出哪些格式块」的数据形。
 *
 * 三分（P5）：时机归 harness（谢幕注入的日程），格式归本合约（数据），内容归模型（演出）。
 * v0 供数：由现有卡状态栏识别器（cardStatusBarFormats → materials.statusBarFormats）生成，
 * 识别器冻结、只降不升；v1 供数（M-R4 首件，见 contract-declare.ts）：装载期一次性模型声明，
 * 声明成功即替换识别器供数，失败回退 v0。
 *
 * 文件 `.liyuan/output-contract.json` 用户可改，改了以文件为准。判「改过没有」不做内容识别：
 * 旁边的 `output-contract.gen.json` 存上次自动生成的副本——两者一致＝没人改过，识别结果
 * 变化时跟着重生成；不一致（或副本缺失，无从自证）＝当作用户的文件，此后不再覆盖。
 * 错了错在一份看得见、改得动的数据上（铁律三）。
 *
 * 纯函数生成与渲染 + 独立的文件同步入口；零 pi 依赖，可单测。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { moduleTagsInHint } from "../draft.ts";

export interface OutputContractModule {
	tag: string;
	/** 署名来源：card/preset＝声明或识别的出处；其他值＝合约文件里用户自加 */
	source: string;
	/** pair＝成对标签（模型填内容）；placeholder＝自闭合占位（界面由卡渲染）；fence＝``` 围栏块（无标签，tag 存名称） */
	form: "pair" | "placeholder" | "fence";
	hint?: string;
}

/** 状态栏格式条目是否占位符型（自闭合 <Tag/>——界面由卡渲染，模型只留占位）。D4 迁入。 */
export function isPlaceholderStatusFormat(f: string): boolean {
	return /\/>\s*$/.test(f.trim().replace(/^`|`$/g, ""));
}

/** v0 生成：卡状态栏格式 → 合约模块（每个标签一条，同标签以先见的形态为准） */
export function contractFromCard(statusBarFormats: string[]): OutputContractModule[] {
	const out: OutputContractModule[] = [];
	for (const hint of statusBarFormats) {
		const form = isPlaceholderStatusFormat(hint) ? "placeholder" : "pair";
		for (const tag of moduleTagsInHint(hint)) {
			if (out.some((m) => m.tag === tag)) continue;
			out.push({
				tag,
				source: "card",
				form,
				hint: "状态栏",
			});
		}
	}
	return out;
}

const CONTRACT_FILE = "output-contract.json";
const GEN_FILE = "output-contract.gen.json";

/** 宽松解析合约文件；形状不对返回 null（调用方回退自动生成，不覆盖用户文件） */
export function parseContract(json: string): OutputContractModule[] | null {
	try {
		const raw = JSON.parse(json) as { modules?: unknown };
		if (!raw || typeof raw !== "object" || !Array.isArray(raw.modules)) return null;
		const out: OutputContractModule[] = [];
		for (const m of raw.modules) {
			if (!m || typeof m !== "object") continue;
			const r = m as Record<string, unknown>;
			const tag = String(r.tag ?? "").trim();
			if (!tag) continue;
			out.push({
				tag,
				source: typeof r.source === "string" && r.source ? r.source : "user",
				form: r.form === "placeholder" ? "placeholder" : r.form === "fence" ? "fence" : "pair",
				...(typeof r.hint === "string" && r.hint ? { hint: r.hint } : {}),
			});
		}
		return out;
	} catch {
		return null;
	}
}

/**
 * 合约文件同步：返回本拍生效的模块表。
 * 文件缺失→写入生成结果；文件＝上次生成→识别结果变化时重生成；
 * 文件被用户改过→以文件为准（解析失败才回退内存生成，但不动用户文件）。
 * 文件层任何故障都不影响开演（回退内存生成）。
 */
export function syncOutputContract(cwd: string, generated: OutputContractModule[]): OutputContractModule[] {
	const dir = join(cwd, ".liyuan");
	const file = join(dir, CONTRACT_FILE);
	const genFile = join(dir, GEN_FILE);
	const genJson = JSON.stringify({ modules: generated }, null, "\t");
	try {
		if (!existsSync(file)) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(file, genJson, "utf8");
			writeFileSync(genFile, genJson, "utf8");
			return generated;
		}
		const current = readFileSync(file, "utf8");
		const lastGen = existsSync(genFile) ? readFileSync(genFile, "utf8") : null;
		if (lastGen !== null && current === lastGen) {
			if (current !== genJson) {
				writeFileSync(file, genJson, "utf8");
				writeFileSync(genFile, genJson, "utf8");
			}
			return generated;
		}
		return parseContract(current) ?? generated;
	} catch {
		return generated;
	}
}

/**
 * 谢幕注入（PLAN-RECTIFY §2.3，文案即规格）。合约为空 → undefined：不注入，拍自然收束。
 * 这是全仓库唯一提到状态栏的送模文案。
 * 点名标签＝hint（署名数据，≤12 字；v1 声明步/用户文件供给）；无 hint 时沿用
 * v0 惯例（card 来源＝状态栏）。fence 块没有标签，以名称点名。
 */
export function curtainInjection(modules: OutputContractModule[]): string | undefined {
	if (modules.length === 0) return undefined;
	const list = modules
		.map((m) => {
			const label = m.hint ? ` ${m.hint.slice(0, 12)}` : m.source === "card" ? " 状态栏" : "";
			if (m.form === "fence") return `「${m.tag}」（\`\`\` 围栏块）`;
			return `\`<${m.tag}${m.form === "placeholder" ? "/" : ""}>\`${label}`;
		})
		.join("、");
	return `【谢幕】记账已毕。输出本拍格式块：${list}。输出完本拍结束。`;
}
