/**
 * 台上检索工具（PLAN-RP-HARNESS M3，R2 工作区 = 稿纸 + 世界）。
 *
 * 对标 Claude Code 的 Read/Grep：动笔前查资料，不靠脑补。
 * 世界书族（lorebook_*）与向量库族（memory_*）已迁入统一工具层
 * （`src/tools/`，PLAN-RP-TOOLING M-D1~M-D3）；本模块只剩 world_state_get
 * 与 skill_read，外加统一层的装配与派发入口。
 *
 * 封顶 MAX_LOOKUPS 次/拍：模型输出正文即视为动笔，工具循环自然结束。
 *
 * 工具 schema 与执行分离：schema 是纯数据（引擎装配进 Context.tools），
 * 执行依赖注入（检索函数），因此本模块可离线单测。
 */

import { runUnifiedStageTool, unifiedStageTools } from "../tools/adapters/stage.ts";
import type { LoreDeps, LoreHitLike } from "../tools/lore.ts";
import type { MemoryDeps, MemoryHitLike } from "../tools/memory.ts";
import type { CardDeps } from "../tools/card.ts";
import type { WorldlineDeps } from "../tools/worldline.ts";
import type { PanelDeps } from "../tools/panels.ts";
import type { WorldState } from "../types.ts";

/** 一拍内最多允许的检索次数（超出后撤掉工具，强制动笔） */
export const MAX_LOOKUPS = 3;

/** agent 循环安全阀（PLAN-RP-AGENT-EXEC §2.3）：开放式循环的轮数上限，触阀以现稿定稿 */
// 8/09 提额：ask 接回 + 续写出口后，正常一拍可达 12+ 轮（规划/3段/3勾/修/ask/重拟/续写…）——
// 12 轮在实弹中被正常演出耗尽（安全阀吞掉了第三段与状态栏）。20 = 正常上限 × 安全余量。
export const MAX_ROUNDS = 20;

/** @liyuan/ai Tool 的结构子集（parameters 用裸 JSON Schema，避免 src/ 依赖 typebox） */
export interface StageTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

/** 命中形（M-D1/M-D3 起由统一工具层定义，此处再导出保持既有引用不变） */
export type { LoreHitLike, MemoryHitLike };

/**
 * 台上工具执行依赖。五族（世界书 / 向量库 / 角色库 / 世界线 / 面板）由统一工具层
 * 定义，此处继承——一处增减、全链路同步。台上的可用工具按注入函数的存在性过滤。
 */
export interface StageToolDeps extends LoreDeps, MemoryDeps, CardDeps, WorldlineDeps, PanelDeps {
	/** 世界状态账本（getState 必在；formatState 用于展示） */
	getState: () => WorldState;
	formatState: (s: WorldState) => string;
	/** skill 内容解析（名称制）：skills/ 文件优先，拆层 D/E 进口包兜底；未注入＝无 skill_read 工具 */
	getSkill?: (name: string) => string | undefined;
}

const STR = { type: "string" } as const;

/**
 * 工具清单（纯数据）。language 用于把「用哪种语言查」写进描述。
 * deps 给出时按注入情况过滤统一层工具（依赖缺失的不上清单，见 adapters/stage.ts）。
 */
export function stageTools(language: string, deps?: StageToolDeps): StageTool[] {
	return [
		// 世界书族（M-D1/M-D2）与向量库族（M-D3）已迁入统一工具层：一份实现多面共用
		...unifiedStageTools(language, deps),
		{
			name: "world_state_get",
			description: "读取当前世界状态账本（时间/地点/人物好感与状态/物品归属/标记/剧情线）。拿不准既定事实时调用。",
			parameters: { type: "object", properties: {}, required: [] },
		},
	];
}

/**
 * skill 读取工具（M-R2 §4.C，writing_guide 名称制改造）：按名读取 skill 内容。
 * 来源两层：skills/ 文件（一等素材位）优先，拆层 D/E 进口包（topic 制遗产）兜底。
 * 关键性质：工具结果**不落历史**（rebuildHistory 只留定稿正文）——内容只活在当拍，
 * 谢幕即蒸发＝按需加载、用完即走。names 为空时不要注册本工具（不凭空点名）。
 */
export function skillReadTool(language: string, names: string[]): StageTool {
	return {
		name: "skill_read",
		description: `按名读取一个 skill 的全文（${language}）。可读：${names.join(" / ")}。`,
		parameters: {
			type: "object",
			properties: { name: { type: "string", enum: names, description: "要读取的 skill 名" } },
			required: ["name"],
		},
	};
}

/**
 * 写侧五件（M-A 三件 + M-B 的 draft_edit/read/search）。
 * schema 在此，执行在 workspace.ts（工作区状态归引擎单拍持有）。
 */
export function writeTools(language: string): StageTool[] {
	return [
		{
			name: "beat_plan",
			description:
				`列出这一拍要演的几步（${language}）——落笔前先在这里构思。` +
				`每条写**这一步发生什么**，一句话的**抽象路标**，` +
				`不写这一步怎么演（留给演到那个路标时再想），也不写字数。` +
				`2~8 条。列路标时按本拍总字数把篇幅分配到各步（几步分几份，每个路标心里有数）。` +
				`这是草图不是剧本：演到中途剧情走岔了，随时重调本工具改写剩下的步骤。`,
			parameters: {
				type: "object",
				properties: {
					steps: {
						type: "array",
						description: "本拍的步骤清单，每条一句话路标（不超过 60 字）",
						items: { ...STR, description: "一步：一个动作或一个转折" },
					},
				},
				required: ["steps"],
			},
		},
		{
			name: "beat_step_done",
			description:
				"勾掉计划里已经演完的一条（演完一个路标就勾一条；一段盖过几条就连着勾几条，不必分轮）。" +
				"返回更新后的清单与剩余条数。",
			parameters: {
				type: "object",
				properties: {
					step: { type: "number", description: "要勾掉的步骤序号（从 1 开始）" },
				},
				required: ["step"],
			},
		},
		{
			name: "draft_append",
			description:
				`往下演一个路标（${language}）——你落笔的方式。` +
				`在现稿末尾追加，不覆盖已写部分：交出去的就是已经发生的事，不会被打回。` +
				`落笔前先思考剧情、构思文字，再书写正文。随后判断：` +
				`接下来要不要 ask 用户、剩余路标是否需要重拟、戏是否到停点。` +
				`演完一个路标就交。全部演完调用 draft_seal 收笔。`,
			parameters: {
				type: "object",
				properties: {
					segment: {
						...STR,
						description: "这一个路标的正文（不含状态栏等格式区块）",
					},
				},
				required: ["segment"],
			},
		},
		{
			name: "draft_write",
			description:
				`一次交完整拍正文（${language}），全量替换语义（覆盖上一稿）。` +
				`只用于**这一拍没有戏**的时候：用户只是寒暄、确认、应一声，场面没有动。` +
				`有戏的一拍用 draft_append 一个路标一个路标演。` +
				`先落笔，再按验收报告改。` +
				`**已有稿之后的局部修改一律用 draft_edit 定点改，不要重交全文。**`,
			parameters: {
				type: "object",
				properties: { content: { ...STR, description: "完整正文（纯剧情文字，不含状态栏等格式区块）" } },
				required: ["content"],
			},
		},
		{
			name: "draft_seal",
			description:
				"封笔：声明正文已全部写完，返回完整稿的验收事实（字数/文面/主权）。" +
				"分路标续写（draft_append）结束后必须调用本工具，否则本拍没有最终正文。",
			parameters: { type: "object", properties: {}, required: [] },
		},
		{
			name: "draft_edit",
			description:
				"对现稿做定点替换（改稿的**首选方式**，不要为改几句话重交全文）。" +
				"edits 可一次给多处，一并套用后自动复验。" +
				"每处的 old 必须逐字引用现稿原文且在全文中唯一——不唯一就前后多带一句；" +
				"引不准可先用 draft_search 取回精确原文。" +
				"**任一处定位失败则整批不套用**，按返回的说明修正后重新提交整批。",
			parameters: {
				type: "object",
				properties: {
					edits: {
						type: "array",
						description: "定点替换列表（可多处）",
						items: {
							type: "object",
							properties: {
								old: { ...STR, description: "现稿中要被替换的原文（须唯一）" },
								new: { ...STR, description: "替换成的新文字（传空串即删除该片段）" },
							},
							required: ["old", "new"],
						},
					},
				},
				required: ["edits"],
			},
		},
		{
			name: "draft_read",
			description:
				"读回当前稿全文，附稿次与**验收口径字数**（与字数规则同一口径，不含标签模块）。" +
				"改了多轮后拿不准现稿长什么样、或要给 draft_edit 取原文时调用。",
			parameters: { type: "object", properties: {}, required: [] },
		},
		{
			name: "draft_search",
			description:
				"在**当前稿**中查找文字，返回命中处的上下文引用——供 draft_edit 取精确的 old。" +
				"（查历史剧情用 memory_search，两者不是一回事。）",
			parameters: {
				type: "object",
				properties: { query: { ...STR, description: "要查找的文字片段" } },
				required: ["query"],
			},
		},
		{
			name: "world_state_update",
			description:
				"提交世界状态账本补丁（合并语义）：time/location 字符串整体替换；characters 按角色名合并字段" +
				"（affinity 数值/status/notes，传 null 删除该角色）；flags 按键合并（null 删除）；" +
				"inventory/plot_threads 传**字符串数组**整体替换（如 [\"补气丹（已服用）\"]，元素不能是对象）。" +
				"本拍剧情改变了世界（时间流逝/移动/关系变化/" +
				"获得失去物品/剧情推进）就在定稿前提交——你是唯一知道现场发生了什么的人，不提交账本就会漂移。",
			parameters: {
				type: "object",
				properties: {
					patch: {
						type: "object",
						description: '合并补丁，如 {"time":"入夜","characters":{"林霜":{"affinity":35}}}',
					},
				},
				required: ["patch"],
			},
		},
		{
			name: "ask",
			description:
				"剧情共创决策（P7 接回）：把该由用户拍板的选择交给用户。三种触发：\n" +
				"① **主动触发**（随时，含第 1 轮）：用户输入本身在求方向/递笔（「接下来去找谁」「怎么办」" +
				"「给个选项」「让我选」）——这不需要上文支撑，直接问。\n" +
				"② **开局收集**（规划阶段、列路标之前）：用户这句输入引出的未定变量——取不同值这拍走向会" +
				"明显分岔（如：买下用户的人性格温和还是残暴，决定整拍怎么演）、且卡与世界书查不到——" +
				"先问用户定下来再规划。一次一问，多个变量只问最关键的。" +
				"判断是**动态的**：变量不因「新」而重要——新人物的性格/身份不是全都要问，洞府里不是每件资源" +
				"都值得问；不分岔的自己顺着演，不事事上报。禁止代写用户身份的完整档案、禁止替用户定重大变量。\n" +
				"③ **续写触发**（路标演完之后）：续写的自然下文涉及用户的行动或选择。\n" +
				`给出 2~4 个具体、可落地、彼此不同的选项（${language}），用户作答后按答案继续演。\n` +
				"用户点了停止 = 笔还给用户，本拍就此收束。\n" +
				"**选择框分流**：用户预设自带选择框格式（如 <w2g>）时，岔路与回合末选项**按预设格式写进正文**，" +
				"不要调本工具；只有预设没有选择框格式时才用 ask。",
			parameters: {
				type: "object",
				properties: {
					question: { ...STR, description: "要交给用户定夺的问题（一句话说清当前局面）" },
					options: {
						type: "array",
						description: "2~4 个具体选项（可落地、彼此不同）",
						items: { ...STR, description: "一个选项" },
					},
				},
				required: ["question", "options"],
			},
		},
	];
}

export interface ToolRunResult {
	/** 回给模型的 toolResult 文本 */
	text: string;
	/** 过程条短句（无则不出条） */
	activity?: string;
}

/**
 * 执行一次工具调用。未知工具名/参数缺失都返回可读文本（不抛，不打断本拍）。
 * language 供统一工具层装配上下文（M-D1）；省略时按中文。
 */
export async function runStageTool(
	deps: StageToolDeps,
	name: string,
	args: Record<string, unknown>,
	language = "中文",
): Promise<ToolRunResult> {
	// 统一工具层优先（PLAN-RP-TOOLING M-D1/M-D3）：世界书族与向量库族由那一份实现作答
	const unified = await runUnifiedStageTool(deps, name, args, language);
	if (unified) return { text: unified.text, ...(unified.activity ? { activity: unified.activity } : {}) };

	if (name === "skill_read") {
		const skillName = typeof args.name === "string" ? args.name.trim() : "";
		const text = skillName ? deps.getSkill?.(skillName) : undefined;
		if (!text) {
			return { text: `没有名为「${skillName}」的 skill。按已有理解直接动笔即可。` };
		}
		return {
			text: `【skill·${skillName}】\n\n${text}`,
			activity: `读 skill「${skillName}」`,
		};
	}

	if (name === "world_state_get") {
		const s = deps.getState();
		return { text: `${deps.formatState(s)}\n\nRAW:\n${JSON.stringify(s)}`, activity: "查账本" };
	}

	return { text: `未知工具 ${name}——本拍可用：lorebook_search / memory_search / world_state_get。` };
}
