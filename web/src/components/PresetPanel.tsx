/**
 * 预设面板：
 * - 开关 / 改字 → 立即进运行时（下一轮生效），**不写盘**
 * - 「保存」→ 写入预设文件
 * - 切换预设再切回 → 磁盘已保存版（未保存改动丢弃）
 * - 点条目展开可改名称 / 通道 / 正文
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	apiDelete,
	apiGet,
	apiPost,
	apiPut,
	downloadJson,
	type ConvertReportItem,
	type PresetBlockView,
	type PresetResponse,
	type PresetsResponse,
} from "../api.ts";
import { ConfirmButton, PanelStatus, SliderField, Toggle, useAction, usePanelData } from "./kit.tsx";
import { SkillLibrary } from "./SkillLibrary.tsx";

const CHANNEL_LABEL: Record<string, string> = {
	system: "系统区",
	postHistory: "末端注入",
};

/** v2 分拣投影（模型通读产物 manifest.v2.json，经 /api/preset-skills 下发；仅展示层，引擎送达仍走 v1） */
type SortingV2 = {
	preset?: string;
	familySemantics?: Record<string, string>;
	groups?: Array<{ name: string; rule: string; members: number[]; note?: string }>;
	entries?: Array<{ idx: number; blockId: string; family: string; group?: string; note?: string }>;
};

/** v2 家族 → 页签归属（8/12 用户定案：skill 与提示词合并——凡送模的散文都是提示词，skill 页签让位给真 skill 库） */
const V2_FAMILY_DEST: Record<string, "prompt" | "contract" | "param" | "del" | "archive"> = {
	破限: "prompt",
	配置: "prompt",
	文风: "prompt",
	NSFW: "prompt",
	方法论: "prompt",
	输出合约: "contract",
	参数: "param",
	删: "del",
	留档: "archive",
};

const SAMPLER_META: Array<{ key: string; min: number; max: number; step: number; hint: string }> = [
	{ key: "temperature", min: 0, max: 2, step: 0.01, hint: "越高越随机发散，越低越确定" },
	{ key: "top_p", min: 0, max: 1, step: 0.01, hint: "核采样：只从累计概率 top_p 的词里选" },
	{ key: "top_k", min: 0, max: 200, step: 1, hint: "只从概率最高的 k 个词里选（0=不限）" },
	{ key: "frequency_penalty", min: -2, max: 2, step: 0.01, hint: "惩罚高频词，抑制复读" },
	{ key: "presence_penalty", min: -2, max: 2, step: 0.01, hint: "惩罚已出现词，鼓励换话题" },
	{ key: "repetition_penalty", min: 1, max: 2, step: 0.01, hint: "重复惩罚（1=不惩罚）" },
	{ key: "min_p", min: 0, max: 1, step: 0.01, hint: "过滤概率低于峰值 min_p 倍的词" },
];

type DraftBlock = PresetBlockView & { content: string };

type DraftPreset = {
	name: string;
	samplers: Record<string, number>;
	blocks: DraftBlock[];
};

type FullPresetResponse = PresetResponse & {
	dirty?: boolean;
	preset: {
		name: string;
		samplers: Record<string, number>;
		blocks: Array<PresetBlockView & { content?: string }>;
	} | null;
};

function toDraft(p: NonNullable<FullPresetResponse["preset"]>): DraftPreset {
	return {
		name: p.name,
		samplers: { ...p.samplers },
		blocks: p.blocks.map((b) => ({
			id: b.id,
			name: b.name,
			channel: b.channel,
			role: b.role,
			enabled: b.enabled,
			chars: b.content?.length ?? b.chars,
			content: b.content ?? "",
		})),
	};
}

function PresetBlockEditor({
	block,
	busy,
	note,
	onChange,
	onDelete,
}: {
	block: DraftBlock;
	busy: boolean;
	note?: string;
	onChange: (patch: Partial<DraftBlock>) => void;
	onDelete?: () => void;
}) {
	const [open, setOpen] = useState(false);

	return (
		<div className={`lore-item preset-block ${block.enabled ? "" : "off"} ${open ? "open" : ""}`}>
			<div className="lore-head">
				<button
					type="button"
					className="preset-block-toggle"
					onClick={() => setOpen((v) => !v)}
					aria-expanded={open}
					title={open ? "收起" : "展开修改"}
				>
					<span className={`group-caret ${open ? "open" : ""}`}>▸</span>
					<div className="block-info">
						<span className="lore-title">{block.name || block.id}</span>
						<span className="lore-meta">
							{(block.content?.length ?? block.chars).toLocaleString()} 字 ·{" "}
							{CHANNEL_LABEL[block.channel] ?? block.channel}
						</span>
						{note && <span className="lore-meta preset-v2-note">{note}</span>}
					</div>
				</button>
				<div className="preset-block-acts">
					<button
						type="button"
						className="act preset-edit-btn"
						disabled={busy}
						onClick={() => setOpen(true)}
					>
						修改
					</button>
					{onDelete && (
						<ConfirmButton className="act preset-del-btn" disabled={busy} confirmText="确认删除" onConfirm={onDelete}>
							删除
						</ConfirmButton>
					)}
					<Toggle
						checked={block.enabled}
						disabled={busy}
						onChange={(v) => onChange({ enabled: v })}
					/>
				</div>
			</div>
			{open && (
				<div className="preset-block-body">
					<label className="field-label">名称</label>
					<input
						className="panel-search"
						value={block.name}
						disabled={busy}
						onChange={(e) => onChange({ name: e.target.value })}
					/>
					<label className="field-label" style={{ marginTop: 8 }}>
						通道
					</label>
					<select
						className="panel-search"
						value={block.channel}
						disabled={busy}
						onChange={(e) => onChange({ channel: e.target.value as DraftBlock["channel"] })}
					>
						<option value="system">系统区（进 system prompt）</option>
						<option value="postHistory">末端注入（每轮导演备注）</option>
					</select>
					<label className="field-label" style={{ marginTop: 8 }}>
						正文
					</label>
					<textarea
						className="panel-search ta preset-block-ta"
						rows={14}
						spellCheck={false}
						value={block.content}
						disabled={busy}
						placeholder="提示词正文…"
						onChange={(e) =>
							onChange({
								content: e.target.value,
								chars: e.target.value.length,
							})
						}
					/>
					<div className="field-hint">
						{block.content.length.toLocaleString()} 字 · 改动立即生效（未点保存则切换预设后会丢）
					</div>
					<div className="panel-row" style={{ marginTop: 6 }}>
						<button type="button" className="act" onClick={() => setOpen(false)}>
							收起
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

export function PresetPanel({ toast }: { toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const files = usePanelData(() => apiGet<PresetsResponse>("/api/presets"), { cacheKey: "/api/presets" });
	const { busy, run } = useAction(toast);

	const [draft, setDraft] = useState<DraftPreset | null>(null);
	const [dirty, setDirty] = useState(false);
	const [missing, setMissing] = useState<string | undefined>();
	const [loadingDetail, setLoadingDetail] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [report, setReport] = useState<ConvertReportItem[] | null>(null);
	/** 防 apply 风暴：合并短时间多次改动 */
	const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const activeFile = files.data?.active ?? null;

	// 有效性视图（8/11 用户定向）：条目按去向分组，不再按通道——判定来自预设 skill manifest
	const fates = usePanelData(
		() =>
			apiGet<{
				entries: Array<{ blockId: string; nature: string; fate: string }>;
				sorting?: SortingV2 | null;
			}>("/api/preset-skills"),
		{ watchAgent: true, cacheKey: "/api/preset-skills" },
	);
	const contract = usePanelData(
		() => apiGet<{ modules: Array<{ tag: string; source: string; form: string; hint?: string }>; declared: boolean; file: string }>("/api/output-contract"),
		{ watchAgent: true, cacheKey: "/api/output-contract" },
	);
	const fateOf = useMemo(
		() => new Map((fates.data?.entries ?? []).map((e) => [e.blockId, { nature: e.nature, fate: e.fate }])),
		[fates.data],
	);
	// v2 分拣（有则按家族渲染，无则回落两分法）；preset 名对不上=数据陈旧，同样回落
	const sorting = fates.data?.sorting ?? null;
	const v2Of = useMemo(
		() => new Map((sorting?.entries ?? []).map((e) => [e.blockId, e])),
		[sorting],
	);

	const loadFromDisk = useCallback(async () => {
		setLoadingDetail(true);
		setLoadError(null);
		try {
			// full=1：一次拉齐正文，方便编辑；默认磁盘已保存版
			const r = await apiGet<FullPresetResponse>("/api/preset?full=1");
			setMissing(r.missing);
			if (r.preset) {
				setDraft(toDraft(r.preset));
				setDirty(false);
			} else {
				setDraft(null);
				setDirty(false);
			}
		} catch (e) {
			setLoadError(e instanceof Error ? e.message : String(e));
			setDraft(null);
		} finally {
			setLoadingDetail(false);
		}
	}, []);

	// 当前启用预设变化时从磁盘重载
	useEffect(() => {
		if (files.data === null) return;
		void loadFromDisk();
	}, [activeFile, files.data, loadFromDisk]);

	const applyRuntime = useCallback(
		(next: DraftPreset) => {
			if (applyTimer.current) clearTimeout(applyTimer.current);
			applyTimer.current = setTimeout(() => {
				void (async () => {
					try {
						await apiPut("/api/preset", {
							preset: {
								name: next.name,
								samplers: next.samplers,
								blocks: next.blocks.map((b) => ({
									id: b.id,
									name: b.name,
									channel: b.channel,
									role: b.role,
									enabled: b.enabled,
									content: b.content,
								})),
							},
						});
					} catch (e) {
						toast("error", e instanceof Error ? e.message : String(e));
					}
				})();
			}, 280);
		},
		[toast],
	);

	const patchDraft = useCallback(
		(mutator: (d: DraftPreset) => DraftPreset) => {
			setDraft((prev) => {
				if (!prev) return prev;
				const next = mutator(prev);
				setDirty(true);
				applyRuntime(next);
				return next;
			});
		},
		[applyRuntime],
	);

	const patchBlock = (id: string, patch: Partial<DraftBlock>) => {
		patchDraft((d) => ({
			...d,
			blocks: d.blocks.map((b) => {
				if (b.id !== id) return b;
				const merged = { ...b, ...patch };
				if (typeof patch.content === "string") merged.chars = patch.content.length;
				return merged;
			}),
		}));
	};

	/** 删块：从预设移除（立即进运行时，dirty，保存后写盘）。8/12 用户点名：提示词/状态栏都要能删。 */
	const removeBlock = (id: string) => {
		patchDraft((d) => ({ ...d, blocks: d.blocks.filter((b) => b.id !== id) }));
	};

	const orderedSamplers = useMemo(() => {
		if (!draft) return { known: [] as ((typeof SAMPLER_META)[number] & { value: number })[], unknown: [] as { key: string; value: number }[] };
		const samplers = draft.samplers;
		const known = SAMPLER_META.filter((m) => m.key in samplers).map((m) => ({ ...m, value: samplers[m.key] }));
		const unknown = Object.entries(samplers)
			.filter(([k]) => !SAMPLER_META.some((m) => m.key === k))
			.map(([key, value]) => ({ key, value }));
		return { known, unknown };
	}, [draft]);

	/** 页签：参数 | 提示词（送模散文全量） | skill（真 skill 库编辑器） | 状态栏（输出合约） | 删（v2 判删审阅） */
	const [tab, setTab] = useState<"samplers" | "prompt" | "skill" | "contract" | "del">("samplers");

	// 归并法（8/12 用户定案：skill 与提示词合并）——
	// 存活看 fate（退场/仅规则提取＝失效，不送模不显示）；活着的一律归系统提示词。
	const destOf = useCallback(
		(blockId: string): "prompt" | "dead" => {
			const info = fateOf.get(blockId);
			if (!info) return "prompt"; // 无判定信息不隐藏（宁多显不误删）
			if (!info.fate.includes("常驻") && !info.fate.includes("skill:")) return "dead";
			return "prompt";
		},
		[fateOf],
	);
	const byDest = useMemo(() => {
		const map = { prompt: [] as DraftBlock[], dead: [] as DraftBlock[] };
		for (const b of draft?.blocks ?? []) map[destOf(b.id)].push(b);
		return map;
	}, [draft, destOf]);

	// v2 家族视图：模型通读分拣在场且对得上当前预设时，页签内容按家族+互斥组渲染
	const hasV2 = !!draft && !!sorting && v2Of.size > 0 && (sorting.preset ?? draft.name) === draft.name;
	const v2Dest = useMemo(() => {
		const map = {
			prompt: [] as DraftBlock[],
			contract: [] as DraftBlock[],
			param: [] as DraftBlock[],
			del: [] as DraftBlock[],
			archive: [] as DraftBlock[],
		};
		if (!hasV2) return map;
		for (const b of draft?.blocks ?? []) {
			const fam = v2Of.get(b.id)?.family ?? "";
			map[V2_FAMILY_DEST[fam] ?? "prompt"].push(b);
		}
		return map;
	}, [draft, v2Of, hasV2]);
	// 无 v2 时不该停在「删」页签
	useEffect(() => {
		if (tab === "del" && !hasV2) setTab("samplers");
	}, [tab, hasV2]);

	// AI 分拣进度（PLAN-PRESET-SORT）：导入/打开时拉一次，running 时轮询到收敛
	type SortStatus = { status: "idle" | "running" | "done" | "failed" | "manual"; done?: number; total?: number; phase?: string; error?: string };
	const [sortStatus, setSortStatus] = useState<SortStatus | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const fetchSort = useCallback(async () => {
		try {
			const s = await apiGet<SortStatus>("/api/preset-sort/status");
			setSortStatus(s);
			if (s.status !== "running") {
				if (pollRef.current) {
					clearInterval(pollRef.current);
					pollRef.current = null;
				}
				if (s.status === "done") fates.reload();
			}
		} catch {
			// 端点不存在（server 未重启）等：静默，UI 回落无分拣条
		}
	}, [fates]);
	useEffect(() => {
		void fetchSort();
	}, [activeFile, fetchSort]);
	useEffect(() => {
		if (sortStatus?.status === "running" && !pollRef.current) {
			pollRef.current = setInterval(() => void fetchSort(), 1500);
		}
		return () => {
			if (pollRef.current) {
				clearInterval(pollRef.current);
				pollRef.current = null;
			}
		};
	}, [sortStatus?.status, fetchSort]);
	const rerunSort = () =>
		run(async () => {
			await apiPost("/api/preset-sort/run", { force: true });
			setSortStatus({ status: "running", done: 0, total: 0, phase: "启动" });
			await fetchSort();
		}, "已开始 AI 分拣");

	const selectPreset = (file: string | null) =>
		run(async () => {
			if (dirty) {
				// 切换即丢弃未保存——与需求一致；给一句提示
				toast("info", "未保存的修改已丢弃");
			}
			await apiPost("/api/presets/select", { file });
			files.reload();
			// loadFromDisk 由 activeFile 变化触发
		});

	const saveToDisk = () =>
		run(async () => {
			const d = draftRef.current;
			if (!d) throw new Error("无预设可保存");
			await apiPost("/api/preset/save", {
				preset: {
					name: d.name,
					samplers: d.samplers,
					blocks: d.blocks.map((b) => ({
						id: b.id,
						name: b.name,
						channel: b.channel,
						role: b.role,
						enabled: b.enabled,
						content: b.content,
					})),
				},
			});
			setDirty(false);
			files.reload();
		}, "预设已保存到文件");

	const revertDraft = () =>
		run(async () => {
			await apiPost("/api/preset/revert", {});
			await loadFromDisk();
		}, "已恢复为文件中的版本");

	const rename = () => {
		if (!activeFile || !draft) return;
		const name = prompt("新名字：", draft.name);
		if (!name?.trim()) return;
		void run(async () => {
			await apiPost("/api/presets/rename", { file: activeFile, name: name.trim() });
			// 重命名只改展示名：同步草稿名并 apply+提示保存
			patchDraft((d) => ({ ...d, name: name.trim() }));
			files.reload();
		}, "显示名已改（记得点保存写入文件）");
	};

	const removeActive = () => {
		if (!activeFile) return;
		void run(async () => {
			await apiDelete(`/api/presets?file=${encodeURIComponent(activeFile)}`);
			setDraft(null);
			setDirty(false);
			files.reload();
		}, "已删除（当前不使用预设）");
	};

	const doExport = async () => {
		if (!activeFile) return;
		try {
			// 导出当前草稿（含未保存）
			const d = draftRef.current;
			if (d) {
				downloadJson(`${d.name || "preset"}.json`, {
					name: d.name,
					samplers: d.samplers,
					blocks: d.blocks.map(({ id, name, channel, role, enabled, content }) => ({
						id,
						name,
						channel,
						role,
						enabled,
						content,
					})),
				});
				return;
			}
			const r = await apiGet<{ name: string; json: unknown }>(`/api/presets/export?file=${encodeURIComponent(activeFile)}`);
			downloadJson(`${r.name}.json`, r.json);
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		}
	};

	const doImport = async (file: File) => {
		setReport(null);
		try {
			const json = JSON.parse(await file.text()) as Record<string, unknown>;
			const r = await apiPost<{ report: ConvertReportItem[]; blockCount: number; converted: boolean }>("/api/presets/import", {
				name: file.name.replace(/\.json$/i, ""),
				json,
			});
			if (r.converted) setReport(r.report);
			toast("info", `已导入并启用（${r.blockCount} 个内容块${r.converted ? "，ST 预设已转换" : ""}）`);
			setDirty(false);
			files.reload();
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		}
	};

	const toggleChannel = (blocks: DraftBlock[], enabled: boolean) => {
		const ids = new Set(blocks.map((b) => b.id));
		patchDraft((d) => ({
			...d,
			blocks: d.blocks.map((b) => (ids.has(b.id) ? { ...b, enabled } : b)),
		}));
	};

	return (
		<div className="panel-body">
			<PanelStatus loading={files.loading} error={files.error} hasData={!!files.data} />
			{files.data && (
				<>
					<section className="sp-section">
						<h4>预设</h4>
						<select
							className="panel-search"
							value={files.data.active ?? ""}
							disabled={busy}
							onChange={(e) => void selectPreset(e.target.value || null)}
							aria-label="选择预设"
						>
							<option value="">（不使用预设）</option>
							{files.data.presets.map((p) => (
								<option key={p.file} value={p.file}>
									{p.name}（{p.file}）
								</option>
							))}
						</select>
						<div className="panel-row list-toolbar preset-actions">
							<button
								className="drawer-btn save-btn"
								disabled={busy || !draft || !dirty}
								onClick={() => void saveToDisk()}
								title="写入预设文件；未保存时切换预设会丢失修改"
							>
								{dirty ? "保存 *" : "保存"}
							</button>
							<button className="drawer-btn" disabled={busy || !dirty} onClick={() => void revertDraft()} title="丢弃未保存修改，从文件重载">
								还原
							</button>
							<button className="drawer-btn" disabled={busy || !activeFile} onClick={rename}>
								重命名
							</button>
							<label className="drawer-btn" title="导入预设 JSON（ST 预设自动转换）">
								导入
								<input
									type="file"
									accept=".json,application/json"
									hidden
									onChange={(e) => {
										const f = e.target.files?.[0];
										if (f) void doImport(f);
										e.target.value = "";
									}}
								/>
							</label>
							<button className="drawer-btn" disabled={busy || !activeFile} onClick={() => void doExport()}>
								导出
							</button>
							<ConfirmButton className="drawer-btn" disabled={busy || !activeFile} confirmText="确认删除" onConfirm={removeActive}>
								删除
							</ConfirmButton>
						</div>
						{dirty && (
							<div className="field-hint preset-dirty-hint">
								有未保存修改：已立即用于对话；切换预设会丢弃。点「保存」写入文件。
							</div>
						)}
						{report && (
							<details className="legacy-group" open>
								<summary>转换分诊报告（{report.length} 项）</summary>
								{report.map((r, i) => (
									<div key={i} className="kv">
										<span className="kv-k">{r.name || r.identifier}</span>
										<span className="kv-v">
											{r.action}
											{r.contentChars > 0 ? ` · ${r.contentChars} 字` : ""}
										</span>
									</div>
								))}
							</details>
						)}
					</section>

					<PanelStatus loading={loadingDetail} error={loadError} hasData={!!draft || !!missing} />
					{missing && <div className="panel-error">配置指向的预设文件不存在：{missing}</div>}

					{draft && (
						<>
							{sortStatus && sortStatus.status !== "idle" && (
								<div className={`preset-sort-bar sort-${sortStatus.status}`}>
									{sortStatus.status === "running" && (
										<span>
											⏳ AI 分拣中…{sortStatus.phase ? ` ${sortStatus.phase}` : ""}
											{sortStatus.total ? `（${sortStatus.done}/${sortStatus.total}）` : ""}
										</span>
									)}
									{sortStatus.status === "done" && (
										<>
											<span>✓ AI 已分拣（模型逐块归类）</span>
											<button className="act" disabled={busy} onClick={rerunSort} title="丢弃当前分类，让 AI 重新逐块判定">
												重新分拣
											</button>
										</>
									)}
									{sortStatus.status === "manual" && (
										<>
											<span>✎ 手工基准分拣（人工通读校准）</span>
											<button className="act" disabled={busy} onClick={rerunSort} title="用 AI 覆盖手工基准（会丢失人工校准）">
												改用 AI 分拣
											</button>
										</>
									)}
									{sortStatus.status === "failed" && (
										<>
											<span title={sortStatus.error}>⚠ AI 分拣失败，已回落两分法</span>
											<button className="act" disabled={busy} onClick={rerunSort}>
												重试
											</button>
										</>
									)}
								</div>
							)}
							{sortStatus?.status === "idle" && (
								<div className="preset-sort-bar sort-idle">
									<span>{sortStatus.phase || "未分拣"}</span>
									<button className="act" disabled={busy} onClick={rerunSort} title="让 AI 逐块把预设块归类到家族">
										AI 分拣
									</button>
								</div>
							)}
							<div className="preset-tabs" role="tablist">
								<button
									type="button"
									role="tab"
									aria-selected={tab === "samplers"}
									className={`preset-tab ${tab === "samplers" ? "active" : ""}`}
									onClick={() => setTab("samplers")}
								>
									参数
								</button>
								{(() => {
									const blocks = hasV2 ? v2Dest.prompt : byDest.prompt;
									const on = blocks.filter((b) => b.enabled).length;
									return (
										<button
											type="button"
											role="tab"
											aria-selected={tab === "prompt"}
											className={`preset-tab ${tab === "prompt" ? "active" : ""}`}
											onClick={() => setTab("prompt")}
										>
											提示词
											<span className="preset-tab-count">{on}/{blocks.length}</span>
										</button>
									);
								})()}
								<button
									type="button"
									role="tab"
									aria-selected={tab === "skill"}
									className={`preset-tab ${tab === "skill" ? "active" : ""}`}
									onClick={() => setTab("skill")}
								>
									skill
								</button>
								<button
									type="button"
									role="tab"
									aria-selected={tab === "contract"}
									className={`preset-tab ${tab === "contract" ? "active" : ""}`}
									onClick={() => setTab("contract")}
								>
									状态栏
									<span className="preset-tab-count">
										{(contract.data?.modules ?? []).length + (hasV2 ? v2Dest.contract.length : 0)}
									</span>
								</button>
								{hasV2 && (
									<button
										type="button"
										role="tab"
										aria-selected={tab === "del"}
										className={`preset-tab ${tab === "del" ? "active" : ""}`}
										onClick={() => setTab("del")}
									>
										删
										<span className="preset-tab-count">
											{v2Dest.del.filter((b) => b.enabled).length}/{v2Dest.del.length + v2Dest.archive.length}
										</span>
									</button>
								)}
							</div>

							{tab === "samplers" && (
							<section className="sp-section">
								{Object.keys(draft.samplers).length === 0 && <div className="sp-empty">该预设未带采样参数。</div>}
								{orderedSamplers.known.map((m) => (
									<SliderField
										key={m.key}
										label={m.key}
										hint={m.hint}
										value={m.value}
										min={m.min}
										max={m.max}
										step={m.step}
										onChange={(nv) =>
											patchDraft((d) => ({
												...d,
												samplers: { ...d.samplers, [m.key]: nv },
											}))
										}
									/>
								))}
								{orderedSamplers.unknown.map(({ key, value }) => (
									<div key={key} className="kv sampler-row">
										<span className="kv-k">{key}</span>
										<input
											className="panel-search num"
											type="number"
											step="0.01"
											value={value}
											onChange={(e) => {
												const n = Number(e.target.value);
												if (Number.isFinite(n)) {
													patchDraft((d) => ({
														...d,
														samplers: { ...d.samplers, [key]: n },
													}));
												}
											}}
										/>
									</div>
								))}
								{hasV2 && v2Dest.param.length > 0 && (
									<>
										<div className="preset-chan-head" style={{ marginTop: 10 }}>
											<span className="lore-meta">字数（二选一，规则提取进引擎目标）</span>
										</div>
										{v2Dest.param.map((b) => (
											<PresetBlockEditor
												key={b.id}
												block={b}
												busy={busy}
												note={v2Of.get(b.id)?.note}
												onChange={(patch) => patchBlock(b.id, patch)}
												onDelete={() => removeBlock(b.id)}
											/>
										))}
									</>
								)}
							</section>
							)}

							{tab === "skill" && <SkillLibrary toast={toast} />}

							{tab === "prompt" && !hasV2 &&
								(() => {
									const blocks = byDest.prompt;
									const totalChars = blocks.reduce((n, b) => n + (b.enabled ? b.content.length : 0), 0);
									const allOn = blocks.length > 0 && blocks.every((b) => b.enabled);
									const deadChars = byDest.dead.reduce((n, b) => n + b.content.length, 0);
									return (
										<section className="sp-section">
											<div className="preset-chan-head">
												<span className="lore-meta">
													{`系统提示词（原文直通，含破限/边界/文风/方法论）：${blocks.length} 块 · 启用 ${totalChars.toLocaleString()} 字`}
												</span>
												{blocks.length > 0 && (
													<button className="act" disabled={busy} onClick={() => toggleChannel(blocks, !allOn)}>
														{allOn ? "全关" : "全开"}
													</button>
												)}
											</div>
											{blocks.length === 0 && <div className="sp-empty">无此去向的块。</div>}
											{blocks.map((b) => (
												<PresetBlockEditor
													key={b.id}
													block={b}
													busy={busy}
													onChange={(patch) => patchBlock(b.id, patch)}
													onDelete={() => removeBlock(b.id)}
												/>
											))}
											{byDest.dead.length > 0 && (
												<div className="field-hint">
													另有 {byDest.dead.length} 块 / {deadChars.toLocaleString()} 字已失效不再送模（旧环境的
													COT/验算/包装类程序内容，机制已覆盖）。文件仍在 skills/预设-*/blocks/，改 manifest 去向可复活。
												</div>
											)}
										</section>
									);
								})()}

							{tab === "prompt" && hasV2 &&
								(() => {
									// v2 家族渲染（8/12 合并定案：送模散文全在提示词页）；家族内按互斥组分节
									const fams = ["破限", "配置", "文风", "NSFW", "方法论"];
									const bucket = v2Dest.prompt;
									return (
										<section className="sp-section">
											{fams.map((fam) => {
												const blocks = bucket.filter((b) => v2Of.get(b.id)?.family === fam);
												if (blocks.length === 0) return null;
												const nOn = blocks.filter((b) => b.enabled).length;
												const onChars = blocks.reduce((n, b) => n + (b.enabled ? b.content.length : 0), 0);
												const grouped = new Map<string, DraftBlock[]>();
												const loose: DraftBlock[] = [];
												for (const b of blocks) {
													const g = v2Of.get(b.id)?.group;
													if (g) {
														if (!grouped.has(g)) grouped.set(g, []);
														grouped.get(g)!.push(b);
													} else loose.push(b);
												}
												const groupOrder = (sorting?.groups ?? []).filter((g) => grouped.has(g.name));
												return (
													<div key={fam} className="preset-v2-family" style={{ marginBottom: 14 }}>
														<div className="preset-chan-head">
															<span className="lore-meta">
																<b>{fam}</b> · {blocks.length} 块 · 启用 {nOn}（{onChars.toLocaleString()} 字）
															</span>
														</div>
														{groupOrder.map((g) => (
															<div key={g.name}>
																<div className="lore-meta" style={{ margin: "8px 0 3px", opacity: 0.8 }}>
																	〔{g.name} · {g.rule}〕{g.note ? ` ${g.note}` : ""}
																</div>
																{grouped.get(g.name)!.map((b) => (
																	<PresetBlockEditor
																		key={b.id}
																		block={b}
																		busy={busy}
																		note={v2Of.get(b.id)?.note}
																		onChange={(patch) => patchBlock(b.id, patch)}
																		onDelete={() => removeBlock(b.id)}
																	/>
																))}
															</div>
														))}
														{loose.length > 0 && groupOrder.length > 0 && (
															<div className="lore-meta" style={{ margin: "8px 0 3px", opacity: 0.8 }}>〔开关 · 可多开〕</div>
														)}
														{loose.map((b) => (
															<PresetBlockEditor
																key={b.id}
																block={b}
																busy={busy}
																note={v2Of.get(b.id)?.note}
																onChange={(patch) => patchBlock(b.id, patch)}
																onDelete={() => removeBlock(b.id)}
															/>
														))}
													</div>
												);
											})}
										</section>
									);
								})()}

							{tab === "del" && hasV2 && (
								<section className="sp-section">
									{v2Dest.del.map((b) => (
										<div
											key={b.id}
											style={{ display: "flex", flexDirection: "column", padding: "4px 0", borderBottom: "1px solid rgba(128,128,128,.15)" }}
										>
											<span className="lore-title" style={{ opacity: b.enabled ? 1 : 0.55 }}>
												{b.enabled ? "●" : "○"} {b.name || b.id}
											</span>
											<span className="lore-meta">
												{b.content.length.toLocaleString()} 字
												{v2Of.get(b.id)?.note ? ` — ${v2Of.get(b.id)?.note}` : ""}
											</span>
										</div>
									))}
									{v2Dest.archive.length > 0 && (
										<>
											<div className="preset-chan-head" style={{ marginTop: 12 }}>
												<span className="lore-meta"><b>留档</b> — 不送模，作为转换/分组的数据源</span>
											</div>
											{v2Dest.archive.map((b) => (
												<div
													key={b.id}
													style={{ display: "flex", flexDirection: "column", padding: "4px 0" }}
												>
													<span className="lore-title" style={{ opacity: b.enabled ? 1 : 0.55 }}>
														{b.enabled ? "●" : "○"} {b.name || b.id}
													</span>
													<span className="lore-meta">
														{b.content.length.toLocaleString()} 字
														{v2Of.get(b.id)?.note ? ` — ${v2Of.get(b.id)?.note}` : ""}
													</span>
												</div>
											))}
										</>
									)}
								</section>
							)}

							{tab === "contract" && (
								<section className="sp-section">
									{(contract.data?.modules ?? []).length === 0 && (
										<div className="sp-empty">本套卡+预设无格式块要求（谢幕不注入，拍自然收束）。</div>
									)}
									{(contract.data?.modules ?? []).map((m) => (
										<div key={m.tag} className="kv">
											<span className="kv-k">
												{m.form === "fence" ? `「${m.tag}」（\`\`\` 围栏块）` : `<${m.tag}${m.form === "placeholder" ? "/" : ""}>`}
											</span>
											<span className="kv-v">
												{m.hint ? `${m.hint} · ` : ""}
												{m.source}
											</span>
										</div>
									))}
									{hasV2 && v2Dest.contract.length > 0 && (
										<>
											<div className="preset-chan-head" style={{ marginTop: 12 }}>
												<span className="lore-meta">
													<b>状态栏 / 输出模块块</b>（分拣判为末尾格式块：状态栏/选项/点评等，可查看改字、开关、删除）：{v2Dest.contract.length} 块
												</span>
											</div>
											{v2Dest.contract.map((b) => (
												<PresetBlockEditor
													key={b.id}
													block={b}
													busy={busy}
													note={v2Of.get(b.id)?.note}
													onChange={(patch) => patchBlock(b.id, patch)}
													onDelete={() => removeBlock(b.id)}
												/>
											))}
										</>
									)}
								</section>
							)}
						</>
					)}
					{!draft && !missing && !loadingDetail && (
						<div className="sp-empty">当前未使用预设。可从上方「导入」一份 ST 预设（自动转换）。</div>
					)}
				</>
			)}
		</div>
	);
}
