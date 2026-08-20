import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { scanSkillFiles } from "../src/stage/materials.ts";
import { deleteStageSkill, sanitizeSkillDir, saveStageSkill } from "../src/stage/skill-store.ts";

const mkcwd = () => mkdtempSync(join(tmpdir(), "liyuan-skillstore-"));

test("saveStageSkill：写出的 SKILL.md 正好是 scanSkillFiles 读的格式（编辑器产物=引擎消费物）", () => {
	const cwd = mkcwd();
	try {
		const { dir } = saveStageSkill(cwd, { name: "打斗", description: "近身缠斗/群战时用", resident: false, body: "## 写法\n镜头贴着动作走。" });
		assert.equal(dir, "打斗");
		assert.ok(existsSync(join(cwd, "skills", "打斗", "SKILL.md")));
		const scanned = scanSkillFiles(cwd);
		assert.equal(scanned.length, 1);
		assert.equal(scanned[0].name, "打斗");
		assert.equal(scanned[0].description, "近身缠斗/群战时用");
		assert.equal(scanned[0].resident, false);
		assert.ok(scanned[0].body.includes("镜头贴着动作走"));
		assert.equal(scanned[0].dir, "打斗");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("saveStageSkill：resident=true 落 frontmatter，scan 认作常驻", () => {
	const cwd = mkcwd();
	try {
		saveStageSkill(cwd, { name: "我的文风", description: "全程", resident: true, body: "冷硬白描。" });
		assert.equal(scanSkillFiles(cwd)[0].resident, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("saveStageSkill：编辑既有（传 dir）覆盖同目录，不新建", () => {
	const cwd = mkcwd();
	try {
		const { dir } = saveStageSkill(cwd, { name: "对峙", description: "旧说明", resident: false, body: "旧正文" });
		saveStageSkill(cwd, { dir, name: "对峙", description: "新说明", resident: true, body: "新正文" });
		const scanned = scanSkillFiles(cwd);
		assert.equal(scanned.length, 1, "覆盖不新增目录");
		assert.equal(scanned[0].description, "新说明");
		assert.equal(scanned[0].resident, true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("saveStageSkill：新建撞已有同名 skill 报错（不静默吞占）", () => {
	const cwd = mkcwd();
	try {
		saveStageSkill(cwd, { name: "静场", description: "x", resident: false, body: "y" });
		assert.throws(() => saveStageSkill(cwd, { name: "静场", description: "z", resident: false, body: "w" }), /已有同名/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("saveStageSkill：空名/空说明/空正文各自报错（说明为空点名理由）", () => {
	const cwd = mkcwd();
	try {
		assert.throws(() => saveStageSkill(cwd, { name: "  ", description: "d", resident: false, body: "b" }), /名称为空/);
		assert.throws(() => saveStageSkill(cwd, { name: "n", description: " ", resident: false, body: "b" }), /简要说明为空/);
		assert.throws(() => saveStageSkill(cwd, { name: "n", description: "d", resident: false, body: " " }), /正文为空/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("sanitizeSkillDir：拒绝路径穿越/隐藏/非法字符，放行中文", () => {
	assert.equal(sanitizeSkillDir("打斗"), "打斗");
	assert.equal(sanitizeSkillDir("a/b"), null);
	assert.equal(sanitizeSkillDir("..\\x"), null);
	assert.equal(sanitizeSkillDir(".hidden"), null);
	assert.equal(sanitizeSkillDir("na<me>"), null);
});

test("saveStageSkill：description 里的换行被压平（frontmatter 按行解析，换行会截断）", () => {
	const cwd = mkcwd();
	try {
		saveStageSkill(cwd, { name: "多行", description: "第一行\n第二行", resident: false, body: "正文" });
		const raw = readFileSync(join(cwd, "skills", "多行", "SKILL.md"), "utf8");
		const fm = raw.split("---")[1];
		assert.ok(!fm.includes("第二行\n") || fm.includes("第一行 第二行"), "description 单行化");
		assert.equal(scanSkillFiles(cwd)[0].description, "第一行 第二行");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("deleteStageSkill：删整目录；不存在报错；非 skill 目录不误删", () => {
	const cwd = mkcwd();
	try {
		saveStageSkill(cwd, { name: "删我", description: "d", resident: false, body: "b" });
		deleteStageSkill(cwd, "删我");
		assert.equal(scanSkillFiles(cwd).length, 0);
		assert.throws(() => deleteStageSkill(cwd, "删我"), /不存在/);
		mkdirSync(join(cwd, "skills", "非skill"), { recursive: true });
		writeFileSync(join(cwd, "skills", "非skill", "README.md"), "x");
		assert.throws(() => deleteStageSkill(cwd, "非skill"), /不存在/, "无 SKILL.md 的目录不认");
		assert.ok(existsSync(join(cwd, "skills", "非skill")), "非 skill 目录未被删");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
