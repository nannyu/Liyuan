/**
 * skill 库写入/删除（skill 编辑器后端，8/12 收缩定案）。
 *
 * 写的就是 scanSkillFiles 读的 `skills/<目录>/SKILL.md`——编辑器产物=引擎消费物，
 * 同一份文件：保存后下一拍装载（loadStageMaterials 每拍现读）即进 L1 索引/skill_read
 * 货架，常驻档全文随 system。不存在第二套"面板专用"存储。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** frontmatter 值与目录名都压成单行（解析器按行读，换行会截断语义） */
const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();

/** 目录名卫生：拒绝路径穿越/隐藏目录/Windows 非法字符。名称可中文。 */
export function sanitizeSkillDir(name: string): string | null {
	const d = oneLine(name);
	if (!d || d.includes("/") || d.includes("\\") || d.includes("..") || d.startsWith(".")) return null;
	if (/[<>:"|?*]/.test(d)) return null;
	return d;
}

export interface StageSkillInput {
	/** 已有 skill 的存储目录（编辑）；缺省=新建，目录取名称 */
	dir?: string;
	name: string;
	description: string;
	resident: boolean;
	/** 必定读取（每轮）：落笔前受理门强制先读；与 resident 互斥（前端三选一） */
	everyBeat: boolean;
	body: string;
}

/** 保存（新建或覆盖已有目录）。返回实际存储目录名。 */
export function saveStageSkill(cwd: string, input: StageSkillInput): { dir: string } {
	const name = oneLine(input.name);
	const description = oneLine(input.description);
	if (!name) throw new Error("skill 名称为空");
	if (!description) throw new Error("简要说明为空（模型靠它决定何时读这个 skill）");
	if (!input.body.trim()) throw new Error("正文为空");
	const dir = sanitizeSkillDir(input.dir ?? name);
	if (!dir) throw new Error("名称/目录含路径字符，无法作为存储目录");
	const folder = join(cwd, "skills", dir);
	const file = join(folder, "SKILL.md");
	if (!input.dir) {
		// 新建流：不吞占已有目录（同名 skill 或非 skill 目录都拒绝，改判去编辑流）
		if (existsSync(file)) throw new Error(`已有同名 skill「${dir}」，请换名或编辑原条目`);
		if (existsSync(folder)) throw new Error(`目录 skills/${dir} 已被占用（不是 skill）`);
	}
	mkdirSync(folder, { recursive: true });
	const text = ["---", `name: ${name}`, `description: ${description}`, `resident: ${input.resident ? "true" : "false"}`, `每轮: ${input.everyBeat ? "true" : "false"}`, "---", "", input.body.trim(), ""].join("\n");
	writeFileSync(file, text, "utf8");
	return { dir };
}

/** 删除整个 skill 目录（含 references/ 等附件）。只认有 SKILL.md 的目录。 */
export function deleteStageSkill(cwd: string, dirName: string): void {
	const dir = sanitizeSkillDir(dirName);
	if (!dir) throw new Error("非法目录名");
	const folder = join(cwd, "skills", dir);
	if (!existsSync(join(folder, "SKILL.md"))) throw new Error(`skill「${dir}」不存在`);
	rmSync(folder, { recursive: true, force: true });
}
