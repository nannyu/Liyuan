import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	applyPendingBackupRestore,
	buildBackupZip,
	crc32,
	projectSessionDir,
	stageRestore,
	validateExtractedBackup,
} from "../src/backup.ts";
import { extractZipFile, listZipEntries } from "../src/ziplite.ts";

/** 搭一个最小项目（数据目录 + 素材 + .liyuan 数据文件 + 排除 extensions + 会话目录） */
function mkProject() {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-backup-"));
	const agentHome = mkdtempSync(join(tmpdir(), "liyuan-agent-"));
	writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "assets/cards/a.png" }));
	mkdirSync(join(cwd, ".liyuan-state"), { recursive: true });
	writeFileSync(join(cwd, ".liyuan-state", "sess.json"), '{"time":"night"}');
	mkdirSync(join(cwd, ".liyuan-memory", "scopes", "x"), { recursive: true });
	writeFileSync(join(cwd, ".liyuan-memory", "scopes", "x", "chunks.jsonl"), "hello\n");
	mkdirSync(join(cwd, "assets", "cards"), { recursive: true });
	writeFileSync(join(cwd, "assets", "cards", "a.png"), "PNGDATA");
	mkdirSync(join(cwd, ".liyuan"), { recursive: true });
	writeFileSync(join(cwd, ".liyuan", "access.json"), '{"salt":"s"}');
	// 产品源码：绝不进备份
	mkdirSync(join(cwd, ".liyuan", "extensions"), { recursive: true });
	writeFileSync(join(cwd, ".liyuan", "extensions", "roleplay.ts"), "CODE");
	// 缓存目录：也不进备份（避免把备份自身打进去）
	mkdirSync(join(cwd, ".liyuan-cache", "backup"), { recursive: true });
	writeFileSync(join(cwd, ".liyuan-cache", "backup", "x.zip"), "CACHE");
	// 剧情会话目录（项目专属）
	const sdir = projectSessionDir(cwd, agentHome);
	mkdirSync(sdir, { recursive: true });
	writeFileSync(join(sdir, "sess-1.jsonl"), '{"type":"session"}\n');
	return { cwd, agentHome };
}

test("crc32：标准校验值", () => {
	assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("buildBackupZip：作用域正确——含数据/素材/会话，排除 extensions 与缓存", () => {
	const { cwd, agentHome } = mkProject();
	try {
		const zip = join(cwd, "out.zip");
		const r = buildBackupZip(cwd, agentHome, zip);
		assert.ok(r.count >= 1);
		const names = listZipEntries(zip).map((e) => e.name);
		assert.ok(names.includes("manifest.json"));
		assert.ok(names.includes("project/liyuan.config.json"));
		assert.ok(names.includes("project/.liyuan-state/sess.json"));
		assert.ok(names.includes("project/.liyuan-memory/scopes/x/chunks.jsonl"));
		assert.ok(names.includes("project/assets/cards/a.png"));
		assert.ok(names.includes("project/.liyuan/access.json"));
		assert.ok(names.includes("sessions/sess-1.jsonl"));
		assert.ok(!names.some((n) => n.includes("extensions")), "源码不得进备份");
		assert.ok(!names.some((n) => n.includes(".liyuan-cache")), "缓存不得进备份");

		const ext = join(cwd, "extracted");
		extractZipFile(zip, ext);
		assert.equal((JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8")) as { format: string }).format, "liyuan-backup");
		assert.equal(readFileSync(join(ext, "project", "assets", "cards", "a.png"), "utf8"), "PNGDATA");
		assert.ok(!existsSync(join(ext, "project", ".liyuan", "extensions")));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentHome, { recursive: true, force: true });
	}
});

test("stageRestore + applyPendingBackupRestore：精确覆盖项目数据并先留快照", () => {
	const { cwd, agentHome } = mkProject();
	try {
		const zip = join(cwd, "out.zip");
		buildBackupZip(cwd, agentHome, zip);
		// 改掉当前数据，模拟「导入前的旧状态」
		writeFileSync(join(cwd, "liyuan.config.json"), JSON.stringify({ card: "changed" }));
		writeFileSync(join(cwd, ".liyuan-state", "sess.json"), '{"time":"day"}');

		const manifest = stageRestore(cwd, zip);
		assert.equal(manifest.format, "liyuan-backup");
		const log = applyPendingBackupRestore(cwd, agentHome);
		assert.ok(log.some((l) => l.includes("已恢复")), "应记录恢复成功");
		assert.ok(log.some((l) => l.includes("恢复前快照")), "应记录恢复前快照");

		assert.ok(JSON.parse(readFileSync(join(cwd, "liyuan.config.json"), "utf8")).card.includes("a.png"));
		assert.equal(readFileSync(join(cwd, ".liyuan-state", "sess.json"), "utf8"), '{"time":"night"}');
		assert.ok(existsSync(projectSessionDir(cwd, agentHome) + "/sess-1.jsonl"), "会话应被恢复");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentHome, { recursive: true, force: true });
	}
});

test("validateExtractedBackup：拒绝非梨园格式", () => {
	const d = mkdtempSync(join(tmpdir(), "liyuan-backup-bad-"));
	try {
		writeFileSync(join(d, "manifest.json"), JSON.stringify({ format: "other", version: 1 }));
		assert.throws(() => validateExtractedBackup(d), /格式不兼容|不是有效的梨园备份/);
	} finally {
		rmSync(d, { recursive: true, force: true });
	}
});
