import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildStageSystemPrompt } from "../src/stage/assemble.ts";
import { scanSkillFiles } from "../src/stage/materials.ts";
import { runStageTool, skillReadTool, type StageToolDeps } from "../src/stage/tools.ts";
import { defaultState } from "../src/state.ts";

const makeSkillDir = (name: string, content: string) => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-skill-"));
	mkdirSync(join(cwd, "skills", name), { recursive: true });
	writeFileSync(join(cwd, "skills", name, "SKILL.md"), content);
	return cwd;
};

const card = { name: "云澜", description: "山门大师姐" } as never;
const config = { userName: "沈舟", language: "中文" } as never;

test("scanSkillFiles：frontmatter 解析——name/description 必填，resident 识别，缺项跳过", () => {
	const cwd = makeSkillDir(
		"写作",
		"---\nname: 写作\ndescription: 每拍写作流程\nresident: true\n---\n\n## 开拍\n先想三件事。",
	);
	try {
		mkdirSync(join(cwd, "skills", "坏包"), { recursive: true });
		writeFileSync(join(cwd, "skills", "坏包", "SKILL.md"), "---\nname: 坏包\n---\n没有 description。");
		const files = scanSkillFiles(cwd);
		assert.equal(files.length, 1, "缺 description 的包不猜、直接跳过");
		assert.equal(files[0].name, "写作");
		assert.equal(files[0].resident, true);
		assert.ok(files[0].body.includes("先想三件事"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("scanSkillFiles：无 skills 目录 → 空数组（零痕迹的前提）", () => {
	const cwd = mkdtempSync(join(tmpdir(), "liyuan-noskill-"));
	try {
		assert.deepEqual(scanSkillFiles(cwd), []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("system 渲染：常驻包全文入 system（署名），拉取包不进 system（清单由skill指导动态生成）；无包零痕迹", () => {
	const skills = [
		{ name: "写作", description: "每拍写作流程", resident: true, body: "## 开拍\n先想三件事。" },
		{ name: "打斗", description: "打斗场面写法与示范", resident: false, body: "示范段……" },
	];
	const p = buildStageSystemPrompt({ card, config, constantLore: [], skills });
	assert.ok(p.includes("# skill：写作（常驻）"), "常驻包有署名标题");
	assert.ok(p.includes("先想三件事"), "常驻包正文全文在场");
	assert.ok(!p.includes("打斗"), "拉取包不进 system（索引已删，清单归skill指导动态表格）");
	assert.ok(!p.includes("示范段"), "拉取包正文不进 system");

	const empty = buildStageSystemPrompt({ card, config, constantLore: [], skills: [] });
	assert.ok(!empty.includes("skill"), "无包零痕迹（不凭空点名）");
});

test("skill_read：按名读取，名单进工具描述；未知名回落直写", async () => {
	const tool = skillReadTool("中文", ["打斗", "nsfw"]);
	assert.equal(tool.name, "skill_read");
	assert.match(tool.description, /打斗 \/ nsfw/);

	const deps = {
		getState: () => defaultState(),
		formatState: () => "",
		getSkill: (n: string) => (n === "打斗" ? "近身时镜头贴着动作走。" : undefined),
	} as unknown as StageToolDeps;
	const hit = await runStageTool(deps, "skill_read", { name: "打斗" });
	assert.ok(hit.text.includes("【skill·打斗】"));
	assert.ok(hit.text.includes("近身时镜头贴着动作走"));
	assert.doesNotMatch(hit.text, /验收|纪律/, "回执无验收残留");
	const miss = await runStageTool(deps, "skill_read", { name: "群像" });
	assert.match(miss.text, /没有名为「群像」/);
});

test("默认库完整性（skill指导复现后）：写作常驻、skill指导每轮、ask判断在场，frontmatter 合格、无乱码", () => {
	const repo = join(import.meta.dirname, "..");
	const files = scanSkillFiles(repo);
	const byName = new Map(files.map((f) => [f.name, f]));
	assert.equal(byName.get("写作")?.resident, true, "写作 常驻");
	// 8/12 复现：skill指导=每轮（必定读取，受理门强制先读）；ask判断 取回（按需）
	assert.equal(byName.get("skill指导")?.everyBeat, true, "skill指导 每轮");
	assert.equal(byName.get("ask判断")?.everyBeat, true, "ask判断 每轮");
	// 未复现的场面包仍不在
	for (const n of ["情欲", "打斗", "对峙", "静场", "去八股"]) {
		assert.ok(!byName.has(n), `${n} 未复现`);
	}
	for (const f of files) assert.ok(!f.body.includes("�"), `${f.name} 无乱码`);
});

