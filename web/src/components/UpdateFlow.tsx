/**
 * 在线更新 UI（spec：scratch/update-ui-mockup.html，用户确认稿）：
 * - UpdateChip：主页 GitHub 徽标右侧的提示胶囊（有新版/就绪才出现，检查失败零打扰）
 * - UpdateModal：点 chip 弹小窗——更新了什么 + 立即更新；点下载后立即关窗
 * - UpdateToast：下载进度/就绪/失败走顶部气泡（挂在 .toasts 容器里，不占页面）
 */

import { useState } from "react";
import { apiPost } from "../api.ts";
import type { UpdateWire } from "../wire.ts";

const fmtMB = (n?: number) => (n && n > 0 ? `${(n / 1024 / 1024).toFixed(1)} MB` : "");

export function UpdateChip({ update, onClick }: { update: UpdateWire | null; onClick: () => void }) {
	if (!update || update.phase === "none") return null;
	const label =
		update.phase === "ready"
			? `v${update.latestVersion} 已就绪`
			: update.phase === "downloading"
				? "更新下载中…"
				: `新版本 v${update.latestVersion}`;
	return (
		<button type="button" className="upd-chip" onClick={onClick} title="查看更新">
			<span className="upd-chip-dot" aria-hidden="true" />
			{label}
		</button>
	);
}

/** release 正文的极简展示：按行拆，`- ` 行成列表，`#` 行成小标题，其余为段落 */
function NotesLite({ text }: { text: string }) {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	const out: React.ReactNode[] = [];
	let list: string[] = [];
	const flush = () => {
		if (list.length) {
			out.push(
				<ul key={`ul-${out.length}`}>
					{list.map((li, i) => (
						<li key={i}>{li}</li>
					))}
				</ul>,
			);
			list = [];
		}
	};
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) {
			flush();
			continue;
		}
		const m = line.match(/^[-*]\s+(.*)$/);
		if (m) {
			// 去掉常见行内 markdown 记号（**…**、`…`），保持纯文本
			list.push(m[1].replace(/\*\*(.+?)\*\*/g, "$1").replace(/`(.+?)`/g, "$1"));
			continue;
		}
		flush();
		if (/^#{1,6}\s/.test(line)) {
			out.push(<h4 key={`h-${out.length}`}>{line.replace(/^#{1,6}\s*/, "")}</h4>);
		} else if (!/^\|/.test(line)) {
			// 表格行不硬渲染（发布说明的安装包表格在弹窗里没意义）
			out.push(<p key={`p-${out.length}`}>{line.replace(/\*\*(.+?)\*\*/g, "$1")}</p>);
		}
	}
	flush();
	return <>{out}</>;
}

export function UpdateModal({
	update,
	onClose,
	onToast,
}: {
	update: UpdateWire;
	onClose: () => void;
	onToast: (level: "info" | "warning" | "error", text: string) => void;
}) {
	const [mirror, setMirror] = useState(() => {
		try {
			return localStorage.getItem("liyuan.update.mirror") ?? "";
		} catch {
			return "";
		}
	});
	const failed = !!update.error;

	const startDownload = async () => {
		try {
			localStorage.setItem("liyuan.update.mirror", mirror.trim());
		} catch {
			/* ignore */
		}
		try {
			await apiPost("/api/update/download", { mirror: mirror.trim() });
			onClose(); // 弹窗即关，后续进度交给气泡
		} catch (e) {
			onToast("error", e instanceof Error ? e.message : String(e));
		}
	};

	return (
		<div className="card-lore-modal" onClick={onClose}>
			<div className="card-lore-dialog upd-dialog" onClick={(e) => e.stopPropagation()}>
				<button type="button" className="icon-btn upd-x" onClick={onClose} aria-label="关闭">
					✕
				</button>
				<h3>
					发现新版本{" "}
					<span className="upd-ver-jump">
						v{update.currentVersion} → <b>v{update.latestVersion}</b>
						{update.publishedAt ? ` · ${update.publishedAt.slice(0, 10)}` : ""}
					</span>
				</h3>
				{update.releaseNotes ? (
					<div className="upd-notes">
						<NotesLite text={update.releaseNotes} />
					</div>
				) : (
					<div className="upd-notes">
						<p>{update.releaseName ?? `v${update.latestVersion}`}</p>
					</div>
				)}
				{failed && (
					<div className="panel-error" style={{ marginBottom: 10 }}>
						{update.error}
					</div>
				)}
				{failed && !update.dockerDeploy && (
					<label className="upd-mirror-row">
						<span>下载镜像</span>
						<input
							className="panel-search"
							placeholder="如 https://ghproxy.net/（留空直连）"
							value={mirror}
							onChange={(e) => setMirror(e.target.value)}
						/>
					</label>
				)}
				<div className="upd-foot">
					<span className="upd-meta">
						{update.dockerDeploy ? (
							<>
								这是 Docker 部署，容器内无法自动升级。请在宿主机执行：
								<br />
								<code>git pull &amp;&amp; docker compose up -d --build</code>
								<br />
								角色卡 / 会话 / 配置在卷挂载里，重建不丢
							</>
						) : (
							<>
								{fmtMB(update.assetSize)}
								{update.assetSize ? " · " : ""}下载后 SHA256 校验
								<br />
								你的角色卡 / 会话 / 配置全部保留
							</>
						)}
					</span>
					<div className="upd-actions">
						{update.releaseUrl && (
							<a className="act-link" href={update.releaseUrl} target="_blank" rel="noopener noreferrer">
								查看发布页
							</a>
						)}
						{update.dockerDeploy ? (
							<button type="button" className="drawer-btn upd-primary" onClick={onClose}>
								知道了
							</button>
						) : (
							<button type="button" className="drawer-btn upd-primary" onClick={() => void startDownload()}>
								{failed ? "重试下载" : "立即更新"}
							</button>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}

/**
 * 更新进度/就绪气泡：渲染在 .toasts 容器内（普通 toast 上方），由 update 状态驱动、
 * 不进 transient 队列（下载可能几分钟，不能被 TTL 收走）。
 */
export function UpdateToast({
	update,
	dismissed,
	onDismiss,
	onToast,
}: {
	update: UpdateWire | null;
	dismissed: boolean;
	onDismiss: () => void;
	onToast: (level: "info" | "warning" | "error", text: string) => void;
}) {
	const [restarting, setRestarting] = useState(false);
	if (!update || dismissed) return null;

	if (update.phase === "downloading") {
		const pct = update.total ? Math.min(100, Math.round(((update.received ?? 0) / update.total) * 100)) : 0;
		return (
			<div className="toast toast-upd" role="status">
				<div className="upd-toast-row">
					<span className="upd-toast-title">正在下载 v{update.latestVersion}…</span>
					<span className="upd-toast-pct">
						{update.total ? `${pct}% · ${fmtMB(update.received)} / ${fmtMB(update.total)}` : fmtMB(update.received)}
					</span>
				</div>
				<div className="upd-tprog">
					<div className="upd-tprog-fill" style={{ width: `${pct}%` }} />
				</div>
			</div>
		);
	}

	if (update.phase === "ready") {
		const restart = async () => {
			setRestarting(true);
			try {
				await apiPost("/api/update/restart", {});
				onToast("info", "正在重启升级，连接恢复后即是新版本…");
			} catch (e) {
				setRestarting(false);
				onToast("error", e instanceof Error ? e.message : String(e));
			}
		};
		return (
			<div className="toast toast-upd-ok" role="status">
				<div className="upd-toast-title">✓ v{update.latestVersion} 已就绪</div>
				<div className="upd-toast-sub">
					{update.verified === "none" ? "（该版本未提供校验清单，未做 SHA256 比对）" : ""}
					{update.supervised
						? "重启梨园即完成升级；旧版本自动备份，数据全部保留。"
						: "下次启动梨园时自动完成升级；旧版本自动备份，数据全部保留。"}
				</div>
				<div className="upd-toast-acts">
					{update.supervised && (
						<button type="button" className="upd-tbtn upd-tbtn-primary" disabled={restarting} onClick={() => void restart()}>
							{restarting ? "重启中…" : "立即重启"}
						</button>
					)}
					<button type="button" className="upd-tbtn" onClick={onDismiss}>
						{update.supervised ? "下次启动时升级" : "知道了"}
					</button>
				</div>
			</div>
		);
	}

	return null;
}
