/**
 * 登场名录定拍刷新：每 N 个已完成叙事拍，旁路场记把已有条目的一句话更新为最近已知状态。
 *
 * 名称登记仍由 applyPatch 同步完成；本模块只在收尾阶段重写简介。刷新进度存进 rp-state，
 * 因而天然跟随 rewind / swipe / 世界线分叉。失败不推进进度，下一拍继续尝试。
 */

import { applyRosterRefresh, saveState } from "../state.ts";
import { buildRosterRefreshPrompt, parseRosterRefreshResult } from "../scribe.ts";
import type { WorldState } from "../types.ts";
import { rebuildHistory, type BranchEntryLike } from "./assemble.ts";

const textOf = (content: unknown): string => {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && (part as { type?: unknown }).type === "text"
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.join("");
};

/** 当前分支上已经完整落树的叙事回复数；开场白、工具结果、错误拍和中断半拍都不计。 */
export function completedNarrativeTurns(branch: BranchEntryLike[]): number {
	let count = 0;
	for (const entry of branch) {
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		if (entry.message.stopReason === "aborted" || entry.message.stopReason === "error") continue;
		if (!textOf(entry.message.content).trim()) continue;
		count++;
	}
	return count;
}

const rosterSize = (state: WorldState): number => {
	const roster = state.roster;
	if (!roster) return 0;
	return Object.keys(roster.characters).length + Object.keys(roster.items).length + Object.keys(roster.events).length;
};

export interface RosterRefreshPlan {
	completedTurns: number;
	turnsSinceRefresh: number;
	conversationText: string;
}

/** 刷新判定与最近剧情窗口（纯函数）。 */
export function planRosterRefresh(
	branch: BranchEntryLike[],
	state: WorldState,
	everyNTurns: number,
	userName: string,
	charName: string,
): RosterRefreshPlan | null {
	if (!Number.isFinite(everyNTurns) || everyNTurns <= 0 || rosterSize(state) === 0) return null;
	const completedTurns = completedNarrativeTurns(branch);
	const recorded = state.rosterRefresh?.lastTurn;
	// 异常/旧缓存里的未来拍数不能永久挡住刷新：退回 0，下一拍立即重建基线。
	const lastTurn =
		typeof recorded === "number" && Number.isFinite(recorded) && recorded >= 0 && recorded <= completedTurns
			? Math.floor(recorded)
			: 0;
	const turnsSinceRefresh = completedTurns - lastTurn;
	if (turnsSinceRefresh < everyNTurns) return null;

	// 失败重试时把上次成功之后的变化尽量都带上；旧长局首次接入封顶 20 拍，避免提示词失控。
	const recentTurns = Math.min(20, Math.max(Math.floor(everyNTurns), turnsSinceRefresh));
	const { history } = rebuildHistory(branch);
	const recent = history.slice(-recentTurns * 2);
	const conversationText = recent
		.map((message) => `${message.role === "user" ? userName : charName}：${message.text}`)
		.join("\n\n");
	return { completedTurns, turnsSinceRefresh, conversationText };
}

export interface RosterRefreshDeps {
	sideText: (systemPrompt: string, userText: string) => Promise<string | { error: string }>;
	appendStateEntry: (state: WorldState) => void;
	getLeafId: () => string | null;
	stateFile?: string;
	onActivity?: (detail: string) => void;
}

export interface RosterRefreshInput {
	branch: BranchEntryLike[];
	state: WorldState;
	everyNTurns: number;
	charName: string;
	userName: string;
}

export type RosterRefreshOutcome =
	| { kind: "skipped"; reason: string }
	| { kind: "stale" }
	| { kind: "failed"; error: string }
	| { kind: "refreshed"; state: WorldState; applied: string[]; warnings: string[]; completedTurns: number };

export async function runRosterRefresh(
	deps: RosterRefreshDeps,
	input: RosterRefreshInput,
): Promise<RosterRefreshOutcome> {
	const plan = planRosterRefresh(input.branch, input.state, input.everyNTurns, input.userName, input.charName);
	if (!plan) return { kind: "skipped", reason: "not-due" };

	const leafBefore = deps.getLeafId();
	deps.onActivity?.(`正在刷新登场名录（${plan.turnsSinceRefresh} 拍）…`);
	const prompt = buildRosterRefreshPrompt({
		state: input.state,
		conversationText: plan.conversationText,
		charName: input.charName,
		userName: input.userName,
	});
	const response = await deps.sideText(prompt.systemPrompt, prompt.userText);
	if (typeof response !== "string") return { kind: "failed", error: response.error };
	const patch = parseRosterRefreshResult(response);
	if (!patch) return { kind: "failed", error: "输出不可解析" };

	// 旁路调用期间导航过：当前 prompt 所依据的分支已经过期，整份结果丢弃。
	if (deps.getLeafId() !== leafBefore) {
		deps.onActivity?.("名录刷新已丢弃（本拍期间切换了分支）");
		return { kind: "stale" };
	}

	const result = applyRosterRefresh(input.state, patch, plan.completedTurns);
	deps.appendStateEntry(result.state);
	if (deps.stateFile) {
		try {
			saveState(deps.stateFile, result.state);
		} catch {
			// 磁盘只是展示缓存；树上 rp-state 快照仍是权威。
		}
	}
	deps.onActivity?.(
		result.applied.length > 0
			? `登场名录已刷新：${result.applied.length} 项`
			: "登场名录已检查：本轮无明确近况变化",
	);
	return {
		kind: "refreshed",
		state: result.state,
		applied: result.applied,
		warnings: result.warnings,
		completedTurns: plan.completedTurns,
	};
}
