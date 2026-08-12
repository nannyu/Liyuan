/**
 * skill 库编辑器（8/12 定案：预设不再产 skill，预设面板 skill 页签让位给真 skill 库）。
 *
 * 读写 /api/stage-skills —— 与引擎 scanSkillFiles 是同一份 `skills/<目录>/SKILL.md`：
 * 保存后下一拍装载即生效（引擎每拍现读）；常驻=全文每拍随 system，拉取=进 L1 索引由模型
 * 按需 skill_read。没有第二套「面板专用」存储。
 */

import { useCallback, useEffect, useState } from "react";
import { apiDelete, apiGet, apiPost } from "../api.ts";
import { ConfirmButton } from "./kit.tsx";

type StageSkill = { dir: string; name: string; description: string; resident: boolean; everyBeat: boolean; chars: number; body: string };
type EditState = { dir: string | null; name: string; description: string; resident: boolean; everyBeat: boolean; body: string };

export function SkillLibrary({ toast }: { toast: (level: "info" | "warning" | "error", text: string) => void }) {
	const [skills, setSkills] = useState<StageSkill[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [edit, setEdit] = useState<EditState | null>(null);
	const [busy, setBusy] = useState(false);

	const reload = useCallback(async () => {
		try {
			const r = await apiGet<{ skills: StageSkill[] }>("/api/stage-skills");
			setSkills(r.skills);
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}, []);
	useEffect(() => {
		void reload();
	}, [reload]);

	const save = async () => {
		if (!edit) return;
		setBusy(true);
		try {
			await apiPost("/api/stage-skills", {
				dir: edit.dir ?? undefined,
				name: edit.name,
				description: edit.description,
				resident: edit.resident,
				everyBeat: edit.everyBeat,
				body: edit.body,
			});
			toast("info", "已保存，下一拍装载即生效");
			setEdit(null);
			await reload();
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const remove = async (dir: string) => {
		setBusy(true);
		try {
			await apiDelete(`/api/stage-skills?dir=${encodeURIComponent(dir)}`);
			toast("info", `已删除「${dir}」`);
			if (edit?.dir === dir) setEdit(null);
			await reload();
		} catch (e) {
			toast("error", e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	};

	const renderForm = () => {
		if (!edit) return null;
		const builtin = edit.dir === "写作" || edit.dir === "skill指导";
		return (
			<div className="skill-edit-form">
				<label className="field-label">名称（模型用它点名 skill_read）</label>
				<input
					className="panel-search"
					value={edit.name}
					disabled={busy}
					placeholder="如：打斗、我的文风"
					onChange={(e) => setEdit({ ...edit, name: e.target.value })}
				/>
				<label className="field-label" style={{ marginTop: 8 }}>
					简要说明（检索触发面）
				</label>
				<input
					className="panel-search"
					value={edit.description}
					disabled={busy}
					placeholder="只写什么时候用（触发场面）；别写做法摘要——模型会照摘要走捷径不读正文"
					onChange={(e) => setEdit({ ...edit, description: e.target.value })}
				/>
				<label className="field-label" style={{ marginTop: 8 }}>
					送达方式
				</label>
				{builtin ? (
					<div className="panel-row">
						<span className="lore-meta">内置骨架·固定{edit.resident ? "常驻（全文每拍随 system）" : "每轮必读（每段落笔前强制先读，动态菜单）"}——不可改</span>
					</div>
				) : (
					<div className="seg-row">
						<button className={`seg ${edit.everyBeat ? "active" : ""}`} disabled={busy} onClick={() => setEdit({ ...edit, resident: false, everyBeat: true })} title="每段落笔前强制先 skill_read（制造停顿逼死磕；每多一个多一次往返）">
							必定读取
						</button>
						<button className={`seg ${!edit.everyBeat ? "active" : ""}`} disabled={busy} onClick={() => setEdit({ ...edit, resident: false, everyBeat: false })} title="进可用清单，模型按本段需要自取；省上下文但触发不保证">
							按需读取
						</button>
					</div>
				)}
				<label className="field-label" style={{ marginTop: 8 }}>
					正文
				</label>
				<textarea
					className="panel-search ta preset-block-ta"
					rows={14}
					spellCheck={false}
					value={edit.body}
					disabled={busy}
					placeholder="写给模型看的正文：何时用/怎么写/一两段示范。Markdown。"
					onChange={(e) => setEdit({ ...edit, body: e.target.value })}
				/>
				<div className="panel-row list-toolbar skill-edit-acts">
					<button className="drawer-btn save-btn" disabled={busy} onClick={() => void save()}>
						保存
					</button>
					<button className="drawer-btn" disabled={busy} onClick={() => setEdit(null)}>
						取消
					</button>
				</div>
			</div>
		);
	};

	return (
		<section className="sp-section">
			<div className="new-skill">
				<button
					className="drawer-btn"
					disabled={busy || !!edit}
					onClick={() => setEdit({ dir: null, name: "", description: "", resident: false, everyBeat: false, body: "" })}
				>
					＋ 新建 skill
				</button>
			</div>
			{error && <div className="panel-error">{error}</div>}
			{skills && skills.length === 0 && !edit && (
				<div className="sp-empty">还没有 skill。点「新建」写第一个（写作方法/场面写法/文风示范都可以）。</div>
			)}
			{/* 新建表单在顶部；编辑既有项时表单内联到那一行的位置（不用翻回顶部） */}
			{edit && edit.dir === null && renderForm()}
			{skills?.map((s) =>
				edit && edit.dir === s.dir ? (
					<div key={s.dir}>{renderForm()}</div>
				) : (
					<div key={s.dir} className="skill-lib-row">
						<div className="skill-lib-main">
							<span className="lore-title">
								{s.name}
								<span className={`skill-badge${s.resident ? " resident" : s.everyBeat ? " forced" : ""}`}>{s.resident ? "常驻" : s.everyBeat ? "必定" : "按需"}</span>
							</span>
							<span className="lore-meta">
								{s.description} · {s.chars.toLocaleString()} 字
							</span>
						</div>
						<div className="preset-block-acts">
							<button
								className="act"
								disabled={busy || !!edit}
								onClick={() => setEdit({ dir: s.dir, name: s.name, description: s.description, resident: s.resident, everyBeat: s.everyBeat, body: s.body })}
							>
								编辑
							</button>
							<ConfirmButton className="act" disabled={busy || !!edit} confirmText="确认删除" onConfirm={() => void remove(s.dir)}>
								删除
							</ConfirmButton>
						</div>
					</div>
				),
			)}
		</section>
	);
}
