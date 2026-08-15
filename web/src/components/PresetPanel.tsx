/**
 * 预设面板：
 * - 开关 / 改字 → 立即进运行时（下一轮生效），**不写盘**
 * - 「保存」→ 写入预设文件
 * - 切换预设再切回 → 磁盘已保存版（未保存改动丢弃）
 * - 点条目展开可改名称 / 正文（通道是 chatHistory 派生的位置，只读）
 *
 * 磁盘上存的是**酒馆原文**：这里发的是补丁（开关落 prompt_order、改字落 prompts），
 * 梨园不认识的键原样留在文件里（见 src/preset-doc.ts）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	apiDelete,
	apiGet,
	apiPost,
	apiPut,
	downloadJson,
	type PresetBlockPatch,
	type PresetBlockView,
	type PresetResponse,
	type PresetsResponse,
} from "../api.ts";
import { ConfirmButton, PanelStatus, SliderField, Toggle, useAction, usePanelData } from "./kit.tsx";

const CHANNEL_LABEL: Record<string, string> = {
	system: "历史前",
	postHistory: "历史后",
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
			marker: b.marker === true,
			...(typeof b.depth === "number" ? { depth: b.depth } : {}),
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
						位置
					</label>
					<div className="field-hint">
						{CHANNEL_LABEL[block.channel] ?? block.channel}
						{block.depth !== undefined ? ` · 深度注入 depth=${block.depth}` : ""}
						——由本块在预设里相对 Chat History 槽位的位置决定，改顺序请在酒馆里改。
					</div>
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
	/** 防 apply 风暴：合并短时间多次改动 */
	const applyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingRef = useRef<PresetBlockPatch[]>([]);
	const pendingSamplersRef = useRef<Record<string, number> | null>(null);
	const draftRef = useRef(draft);
	draftRef.current = draft;
	const activeFile = files.data?.active ?? null;

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

	/**
	 * 发补丁而不是发全量：磁盘上存的是酒馆原文，开关只动 `prompt_order[].enabled`，
	 * 改字只动 `prompts[].content`，梨园不认识的键原样留在文件里。
	 */
	const applyRuntime = useCallback(
		(patches: PresetBlockPatch[], samplers?: Record<string, number>) => {
			pendingRef.current.push(...patches);
			if (samplers) pendingSamplersRef.current = samplers;
			if (applyTimer.current) clearTimeout(applyTimer.current);
			applyTimer.current = setTimeout(() => {
				// 同一块的多次改动按后写优先合并成一条
				const merged = new Map<string, PresetBlockPatch>();
				for (const p of pendingRef.current) merged.set(p.id, { ...merged.get(p.id), ...p });
				const body: { blocks: PresetBlockPatch[]; samplers?: Record<string, number> } = {
					blocks: [...merged.values()],
				};
				if (pendingSamplersRef.current) body.samplers = pendingSamplersRef.current;
				pendingRef.current = [];
				pendingSamplersRef.current = null;
				void (async () => {
					try {
						await apiPut("/api/preset", body);
					} catch (e) {
						toast("error", e instanceof Error ? e.message : String(e));
					}
				})();
			}, 280);
		},
		[toast],
	);

	/** 本地视图改动 + 同步一条补丁到运行时草稿 */
	const patchDraft = useCallback(
		(mutator: (d: DraftPreset) => DraftPreset, patches: PresetBlockPatch[], samplers?: Record<string, number>) => {
			setDraft((prev) => {
				if (!prev) return prev;
				const next = mutator(prev);
				setDirty(true);
				applyRuntime(patches, samplers);
				return next;
			});
		},
		[applyRuntime],
	);

	const patchBlock = (id: string, patch: Partial<DraftBlock>) => {
		patchDraft(
			(d) => ({
				...d,
				blocks: d.blocks.map((b) => {
					if (b.id !== id) return b;
					const merged = { ...b, ...patch };
					if (typeof patch.content === "string") merged.chars = patch.content.length;
					return merged;
				}),
			}),
			[
				{
					id,
					...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
					...(typeof patch.name === "string" ? { name: patch.name } : {}),
					...(typeof patch.content === "string" ? { content: patch.content } : {}),
				},
			],
		);
	};

	const patchSamplers = (key: string, value: number) => {
		setDraft((prev) => {
			if (!prev) return prev;
			const samplers = { ...prev.samplers, [key]: value };
			setDirty(true);
			applyRuntime([], samplers);
			return { ...prev, samplers };
		});
	};

	/** 删块：从预设整块移除（立即进运行时，dirty，保存后写盘）。8/12 用户点名：提示词/状态栏都要能删。 */
	const removeBlock = (id: string) => {
		patchDraft((d) => ({ ...d, blocks: d.blocks.filter((b) => b.id !== id) }), [{ id, remove: true }]);
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

	/** 页签：参数 | 提示词（装配进提示词的全部块） */
	const [tab, setTab] = useState<"samplers" | "prompt">("samplers");

	/** 酒馆内置槽位（Chat History / Char Description…）单列——它们没有正文，只声明位置 */
	const blocksByKind = useMemo(() => {
		const map = { blocks: [] as DraftBlock[], markers: [] as DraftBlock[] };
		for (const b of draft?.blocks ?? []) (b.marker ? map.markers : map.blocks).push(b);
		return map;
	}, [draft]);

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
			// 草稿已在运行时文件里（原文＋补丁），保存＝把它落到预设文件
			await apiPost("/api/preset/save", {});
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
		const name = prompt("新名字（＝新文件名）：", draft.name);
		if (!name?.trim()) return;
		void run(async () => {
			await apiPost("/api/presets/rename", { file: activeFile, name: name.trim() });
			files.reload();
		}, "已重命名（预设名就是文件名）");
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
			// 导出原文：酒馆能直接吃回去（未保存草稿请先点保存）
			const r = await apiGet<{ name: string; json: unknown }>(`/api/presets/export?file=${encodeURIComponent(activeFile)}`);
			downloadJson(`${r.name}.json`, r.json);
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		}
	};

	const doImport = async (file: File) => {
		try {
			const json = JSON.parse(await file.text()) as Record<string, unknown>;
			const r = await apiPost<{ kind: "st" | "rp"; blockCount: number; enabledCount: number }>("/api/presets/import", {
				name: file.name.replace(/\.json$/i, ""),
				json,
			});
			toast(
				"info",
				`已导入并启用（${r.kind === "st" ? "酒馆原文原样存档" : "旧梨园格式"}：${r.blockCount} 条 · 启用 ${r.enabledCount}）`,
			);
			setDirty(false);
			files.reload();
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		}
	};

	const toggleChannel = (blocks: DraftBlock[], enabled: boolean) => {
		const ids = new Set(blocks.map((b) => b.id));
		patchDraft(
			(d) => ({ ...d, blocks: d.blocks.map((b) => (ids.has(b.id) ? { ...b, enabled } : b)) }),
			blocks.map((b) => ({ id: b.id, enabled })),
		);
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
					</section>

					<PanelStatus loading={loadingDetail} error={loadError} hasData={!!draft || !!missing} />
					{missing && <div className="panel-error">配置指向的预设文件不存在：{missing}</div>}

					{draft && (
						<>
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
									const blocks = blocksByKind.blocks;
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
										onChange={(nv) => patchSamplers(m.key, nv)}
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
												if (Number.isFinite(n)) patchSamplers(key, n);
											}}
										/>
									</div>
								))}
							</section>
							)}

							{tab === "prompt" &&
								(() => {
									const blocks = blocksByKind.blocks;
									const markers = blocksByKind.markers;
									const onChars = blocks.reduce((n, b) => n + (b.enabled ? b.content.length : 0), 0);
									const allOn = blocks.length > 0 && blocks.every((b) => b.enabled);
									return (
										<section className="sp-section">
											<div className="preset-chan-head">
												<span className="lore-meta">
													{`启用块原文按 prompt_order 原序装配进提示词：${blocks.length} 块 · 启用 ${onChars.toLocaleString()} 字`}
												</span>
												{blocks.length > 0 && (
													<button className="act" disabled={busy} onClick={() => toggleChannel(blocks, !allOn)}>
														{allOn ? "全关" : "全开"}
													</button>
												)}
											</div>
											{blocks.length === 0 && <div className="sp-empty">该预设没有内容块。</div>}
											{blocks.map((b) => (
												<PresetBlockEditor
													key={b.id}
													block={b}
													busy={busy}
													onChange={(patch) => patchBlock(b.id, patch)}
													onDelete={() => removeBlock(b.id)}
												/>
											))}
											{markers.length > 0 && (
												<>
													<div className="preset-chan-head" style={{ marginTop: 12 }}>
														<span className="lore-meta">
															<b>酒馆内置槽位</b> — 决定角色卡 / 世界书 / 对话历史插在哪一段，本身没有正文
														</span>
													</div>
													{markers.map((b) => (
														<div key={b.id} className="kv">
															<span className="kv-k" style={{ opacity: b.enabled ? 1 : 0.5 }}>
																{b.enabled ? "●" : "○"} {b.name || b.id}
															</span>
															<span className="kv-v">
																{CHANNEL_LABEL[b.channel] ?? b.channel}
																<Toggle
																	checked={b.enabled}
																	disabled={busy}
																	onChange={(v) => patchBlock(b.id, { enabled: v })}
																	
																/>
															</span>
														</div>
													))}
												</>
											)}
										</section>
									);
								})()}
						</>
					)}
					{!draft && !missing && !loadingDetail && (
						<div className="sp-empty">当前未使用预设。可从上方「导入」一份酒馆预设（原文原样存档，不做任何转换）。</div>
					)}
				</>
			)}
		</div>
	);
}
