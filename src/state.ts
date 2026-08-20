/**
 * 结构化世界状态：读写、补丁合并、注入格式化。
 * 这是对 ST「模型忘状态」痛点的架构级解法（PLAN.md §3）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readJsonFile } from "./jsonio.ts";
import type { CharacterState, StateRoster, WorldState } from "./types.ts";

const TOP_KEYS = ["time", "location", "characters", "inventory", "flags", "plot_threads"] as const;

export function defaultState(): WorldState {
	return {
		time: "",
		location: "",
		characters: {},
		inventory: [],
		flags: {},
		plot_threads: [],
	};
}

export function loadState(file: string): WorldState {
	try {
		const raw = readJsonFile(file) as Partial<WorldState>;
		return { ...defaultState(), ...raw };
	} catch {
		return defaultState();
	}
}

export function saveState(file: string, state: WorldState): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(state, null, 2), "utf8");
}

export interface PatchResult {
	state: WorldState;
	/** 人类可读的变更摘要（用于工具返回，让模型确认写入了什么） */
	applied: string[];
	warnings: string[];
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

const normName = (s: string) => s.trim().toLowerCase();

/**
 * 把补丁中的角色键归一到已知的规范名（大小写/首尾空白不敏感），
 * 防止同一角色被记成多份（实测 flash 会写出 "Alice"/"alice " 变体）。
 * 中文译名与原名的等同（爱丽丝=Alice）无法机械判定，交给 Phase 2 scribe。
 */
export function canonicalizeCharacterKeys(
	patch: Record<string, unknown>,
	knownNames: string[],
): Record<string, unknown> {
	const chars = patch.characters;
	if (!chars || typeof chars !== "object" || Array.isArray(chars)) return patch;

	const canon = new Map<string, string>();
	for (const n of knownNames) {
		const k = normName(n);
		if (k && !canon.has(k)) canon.set(k, n.trim());
	}
	const out: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(chars as Record<string, unknown>)) {
		const key = canon.get(normName(name)) ?? name.trim();
		if (!canon.has(normName(name))) canon.set(normName(name), key);
		// 补丁内部撞到同一规范名：浅合并（后写的字段覆盖）
		if (out[key] && value && typeof value === "object" && typeof out[key] === "object") {
			out[key] = { ...(out[key] as object), ...(value as object) };
		} else {
			out[key] = value;
		}
	}
	return { ...patch, characters: out };
}

/**
 * 合并补丁。语义（工具描述中向模型说明）：
 * - time / location：字符串整体替换
 * - characters：按角色名合并字段；传 null 删除该角色
 * - flags：按键合并；传 null 删除该键
 * - inventory / plot_threads：数组整体替换（须传完整数组）
 * - 未知顶层键拒绝并告警（保持 schema 诚实）
 */
export function applyPatch(state: WorldState, patch: Record<string, unknown>): PatchResult {
	const next: WorldState = structuredClone(state);
	const applied: string[] = [];
	const warnings: string[] = [];

	for (const [key, value] of Object.entries(patch)) {
		switch (key) {
			case "time":
			case "location": {
				if (typeof value === "string") {
					next[key] = value;
					applied.push(`${key} → ${value}`);
				} else warnings.push(`${key} 需要字符串，已忽略`);
				break;
			}
			case "characters": {
				if (value && typeof value === "object" && !Array.isArray(value)) {
					for (const [name, cs] of Object.entries(value as Record<string, unknown>)) {
						if (cs === null) {
							delete next.characters[name];
							applied.push(`characters.${name} 已移除`);
							continue;
						}
						if (!cs || typeof cs !== "object") {
							warnings.push(`characters.${name} 需要对象或 null，已忽略`);
							continue;
						}
						const cur: CharacterState = next.characters[name] ?? { affinity: 0, status: "", notes: "" };
						const p = cs as Partial<Record<keyof CharacterState, unknown>>;
						if (typeof p.affinity === "number") cur.affinity = clamp(Math.round(p.affinity), -100, 100);
						if (typeof p.status === "string") cur.status = p.status;
						if (typeof p.notes === "string") cur.notes = p.notes;
						next.characters[name] = cur;
						applied.push(`characters.${name} 已更新`);
					}
				} else warnings.push("characters 需要对象，已忽略");
				break;
			}
			case "flags": {
				if (value && typeof value === "object" && !Array.isArray(value)) {
					for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
						if (v === null) {
							delete next.flags[k];
							applied.push(`flags.${k} 已移除`);
						} else if (typeof v === "string") {
							next.flags[k] = v;
							applied.push(`flags.${k} → ${v}`);
						} else {
							next.flags[k] = JSON.stringify(v);
							applied.push(`flags.${k} 已更新`);
						}
					}
				} else warnings.push("flags 需要对象，已忽略");
				break;
			}
			case "inventory":
			case "plot_threads": {
				if (Array.isArray(value)) {
					// 非字符串元素**不静默丢弃**：模型常传 [{name,数量}] 这类对象，
					// 旧实现 filter 掉后仍回报「成功」（applied 里是空数组），模型只能反复试错。
					const kept = value.filter((x): x is string => typeof x === "string");
					const dropped = value.filter((x) => typeof x !== "string");
					if (dropped.length > 0) {
						warnings.push(
							`${key} 有 ${dropped.length} 项不是字符串已丢弃（${dropped
								.slice(0, 2)
								.map((d) => JSON.stringify(d))
								.join("、")}${dropped.length > 2 ? "…" : ""}）——` +
								`本字段是字符串数组，请写成 ["补气丹（已服用）"] 这样的一句话条目。`,
						);
					}
					next[key] = kept;
					applied.push(`${key} → [${kept.join("、")}]`);
				} else warnings.push(`${key} 需要完整数组（整体替换语义），已忽略`);
				break;
			}
			case "roster": {
				// 登场名录编辑（用户主权，REST 侧用；模型工具 schema 不含此键）：
				// {characters/items/events: {名称: null(删除) | 字符串(改一句话)}}。
				// 注意：删除**活跃**条目会被本函数末尾的 registerRoster 立即重新登记——名录必须覆盖在场条目。
				if (value && typeof value === "object" && !Array.isArray(value)) {
					const roster: StateRoster = next.roster ?? { characters: {}, items: {}, events: {} };
					for (const table of ["characters", "items", "events"] as const) {
						const patchTable = (value as Record<string, unknown>)[table];
						if (patchTable === undefined) continue;
						if (!patchTable || typeof patchTable !== "object" || Array.isArray(patchTable)) {
							warnings.push(`roster.${table} 需要对象，已忽略`);
							continue;
						}
						for (const [name, v] of Object.entries(patchTable as Record<string, unknown>)) {
							if (v === null) {
								delete roster[table][name];
								applied.push(`roster.${table}.${name} 已移除`);
							} else if (typeof v === "string") {
								roster[table][name] = v.slice(0, 60);
								applied.push(`roster.${table}.${name} 已更新`);
							} else warnings.push(`roster.${table}.${name} 需要字符串或 null，已忽略`);
						}
					}
					next.roster = roster;
				} else warnings.push("roster 需要对象，已忽略");
				break;
			}
			default:
				warnings.push(`未知字段 ${key}，允许的顶层字段：${TOP_KEYS.join(", ")}`);
		}
	}
	registerRoster(next);
	return { state: next, applied, warnings };
}

/** 注入用的紧凑可读格式 */
export function formatState(state: WorldState): string {
	const lines: string[] = [];
	if (state.time) lines.push(`时间：${state.time}`);
	if (state.location) lines.push(`地点：${state.location}`);
	for (const [name, c] of Object.entries(state.characters)) {
		const parts = [`好感 ${c.affinity}`];
		if (c.status) parts.push(`状态：${c.status}`);
		if (c.notes) parts.push(`备注：${c.notes}`);
		lines.push(`${name}：${parts.join("；")}`);
	}
	if (state.inventory.length) lines.push(`物品：${state.inventory.join("、")}`);
	for (const [k, v] of Object.entries(state.flags)) lines.push(`${k}：${v}`);
	if (state.plot_threads.length) lines.push(`剧情线：${state.plot_threads.map((t) => `「${t}」`).join(" ")}`);
	return lines.length ? lines.join("\n") : "（尚无记录）";
}

// ---------- 登场名录（agent 索引表） ----------

/** 名录各表容量上限（超出丢最旧——Record 保持插入序）。防剧情线改写措辞导致的近重复无限累积。 */
const ROSTER_CAPS = { characters: 100, items: 100, events: 60 } as const;

/** 名录登记时给人物的一句话预算 */
const ROSTER_BLURB_MAX = 30;

function capRoster(reg: Record<string, string>, cap: number): Record<string, string> {
	const keys = Object.keys(reg);
	if (keys.length <= cap) return reg;
	const out: Record<string, string> = {};
	for (const k of keys.slice(keys.length - cap)) out[k] = reg[k]!;
	return out;
}

/**
 * 名录登记（applyPatch 咽喉点调用）：把当前活跃的人物/物品/剧情线并入名录。
 * 只增不改——已登记条目不追新鲜度（名录记「存在过」，细节靠 memory_search 召回）；
 * 活跃状态里删掉的条目名录保留。
 */
function registerRoster(next: WorldState): void {
	const r: StateRoster = next.roster ?? { characters: {}, items: {}, events: {} };
	for (const [name, c] of Object.entries(next.characters)) {
		if (!(name in r.characters)) r.characters[name] = (c.status || "").slice(0, ROSTER_BLURB_MAX);
	}
	for (const it of next.inventory) {
		if (it && !(it in r.items)) r.items[it] = "";
	}
	for (const t of next.plot_threads) {
		if (t && !(t in r.events)) r.events[t] = "";
	}
	next.roster = {
		characters: capRoster(r.characters, ROSTER_CAPS.characters),
		items: capRoster(r.items, ROSTER_CAPS.items),
		events: capRoster(r.events, ROSTER_CAPS.events),
	};
}

/** 名录索引单节的字符预算（超出按条目边界截断，补「等 N 项」） */
const ROSTER_SECTION_MAX_CHARS = 240;

function rosterSection(label: string, entries: Array<[string, string]>): string | undefined {
	if (entries.length === 0) return undefined;
	const titles = entries.map(([name, blurb]) => (blurb ? `${name}（${blurb}）` : name));
	const shown: string[] = [];
	let used = 0;
	for (const t of titles) {
		if (used + t.length + 1 > ROSTER_SECTION_MAX_CHARS) break;
		shown.push(t);
		used += t.length + 1;
	}
	const rest = titles.length - shown.length;
	return `${label}：${shown.join("、")}${rest > 0 ? `……等 ${titles.length} 项` : ""}`;
}

/**
 * 名录索引渲染：只列**已不在当前状态**的条目（离场人物/失去的物品/已了结或改写的剧情线）——
 * 活跃条目已在【世界状态】全量可见，索引只补「曾经存在」这一层。全空返回 undefined。
 */
export function formatRosterIndex(state: WorldState): string | undefined {
	const r = state.roster;
	if (!r) return undefined;
	const gone = (reg: Record<string, string>, active: Set<string>): Array<[string, string]> =>
		Object.entries(reg).filter(([k]) => !active.has(k));

	const sections = [
		rosterSection("已离场人物", gone(r.characters, new Set(Object.keys(state.characters)))),
		rosterSection("曾持有物品", gone(r.items, new Set(state.inventory))),
		rosterSection("旧剧情线", gone(r.events, new Set(state.plot_threads))),
	].filter((s): s is string => Boolean(s));
	return sections.length ? sections.join("；") : undefined;
}
