/**
 * Ralph Flow for dsh v2 — 技能注册（启动类快捷入口的**人面**与**模型面**）
 *
 * 为什么启动类入口是技能而不是命令：dsh 的会话标题只认一种输入 ——
 * `user/message` 且 `source.kind === "user"`（`dsh-session-title/lib/index.js` 的
 * `sessionTitleUserMessageOf`：`if (event.type !== "user/message" || event.data.source.kind !== "user") return void 0;`），
 * 而**斜杠命令**落成 `command/run` + `command/done`，永远不被那条式子看中。用户在新会话里
 * 第一句就敲 `/ralphflow-start …` 时，这个会话因此连兜底标题都拿不到（侧栏「未命名」）。
 *
 * 技能走的是另一条路：`/name` 由 `dsh-tool-skill` 在 `agent/pre-step` 用
 * `SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g` 从**普通用户消息**里扫出来
 * （只扫 `source.kind === "user"` 的消息），再由宿主把技能正文注入为 `skill-invocation` 消息。
 * 于是「敲技能」= 一条普通用户消息（标题口径成立）+ 一次宿主注入（不多花模型回合）。
 *
 * 两条触发路径（同一份正文，两面共用）：
 *   · 人敲 `/ralphflow-start <工作流> <任务>` → 普通 `user/message` → 宿主注入正文；
 *   · 模型按**描述**自然触发 → 调 `skill` 工具读正文（模型目录只渲染 `name` + `description`，
 *     所以触发词必须写在 `description` 里，`whenToUse` 不进目录）。
 *
 * 边界（任务书 §边界）：只有**启动类**入口是技能。`/ralphflow-reset`、`/ralphflow-rewind`
 * （机械执行、无对应工具）、`/ralphflow-cancel`、`/ralphflow-continue`（人的权限）、
 * `/ralphflow-status`、`/ralphflow-list`、`/ralphflow-doctor`（纯读）、`/ralphflow-create`
 * 保持命令 —— 详见 `docs/v2/skills-vs-commands.md` 的逐条归类。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { Context } from "@deepseek-ai/cordis";
import type { SkillRegistration } from "@deepseek-ai/dsh-skill";

/**
 * 技能名语法（与 dsh 的 `SKILL_NAME` 逐字一致：小写 kebab）。
 * `dsh-skill/lib/index.js`：`const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;`
 */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 启动类快捷入口共用的前缀：`ralphflow-start` 与 `ralphflow-<工作流>`。 */
export const SKILL_PREFIX = "ralphflow-";

/** 通用启动技能名（`/ralphflow-start`）。 */
export const START_SKILL_NAME = `${SKILL_PREFIX}start`;

/**
 * `ralphflow-start` 的**触发词**（技能描述）—— **逐字**使用，且是全仓唯一一处。
 *
 * 模型目录只渲染 `name` + `description`（`dsh-tool-skill` 的 `renderCatalogEntries`：
 * `` `- \`${entry.name}\`: ${escapeText(entry.description)}` ``），目录消息自带路由指令
 * （*"If the user names a skill, or the task clearly matches a skill's description, call the
 * `skill` tool with the exact skill name before taking task actions."*）—— 描述就是触发器，
 * 所以触发词只写这一处：不写进 `ralphflow_start` 的工具描述，也不另加系统提示词段落。
 */
export const START_SKILL_DESCRIPTION = "Ralph Flow：用户点名 ralphflow，或要求执行后由独立会话的验证者验收时，用它启动工作流。";

/**
 * 工作流机制说明（`/ralphflow-start` 与 `/ralphflow-<工作流>` 的技能正文共享）。
 *
 * 只保留**技能层独有**的信息：执行者只负责当前步、验证者独立取证、用户决定的入口、
 * Graph 的调度边界。DO 已经写明的操作细节不在这里复述。
 */
export const SHARED_MECHANISM = `## 工作流机制

你只负责当前步：按工具返回的 DO 执行，交卷后由引擎投递下一步。
独立验证者看不到本对话，它按本步判据自己取证；没过就返工，把反馈当定位线索。
需要用户决定时调用 \`ask_user_question\`；用户点停止即暂停，等用户明确要求再继续。
Graph 的节点由引擎并行调度，不需要催促或汇报进度。`;

/**
 * `ralphflow-start` 的技能正文。**参数从用户那条消息里取**，所以正文是静态的：
 * 敲字与自然语言两条路都从这里出发，按用户输入补足缺项，不猜任务内容。
 */
const START_SKILL_CONTENT = `启动用户要求的 Ralph Flow 工作流。请调用 \`ralphflow_start\` 工具。

- \`workflow\` 与 \`task\` 从**用户那条消息**里取：\`/ralphflow-start <工作流> <任务描述>\` 的第一段是工作流名，其余整段是任务描述。
- 有任务而未指定工作流：用 \`ralphflow_list\` 列出可选项，匹配明确时选择并说明，无法判断时问用户。缺任务：请用户补充任务后再启动。保留用户原始约束与任务范围。

${SHARED_MECHANISM}`;

/**
 * `ralphflow-create` 的技能目录：正文（`SKILL.md`）与创建期参考（YAML 方言、Graph 写法、
 * Matt 原文）在同一处，资源按这个目录解析 —— 与 dsh 的文件技能同构
 * （`<name>/SKILL.md` 的根就是这个目录）。
 *
 * 与运行期资产分开：资产目录放资产自己引用的材料，创建期参考跟着 skill 走、由 `skill` 工具
 * 的资源根注入。
 */
export const CREATE_SKILL_RESOURCES = fileURLToPath(new URL("../skills/ralphflow-create", import.meta.url));

/**
 * 读一个**文件技能**的 `SKILL.md`：frontmatter 给 `name` / `description`，其后是正文。
 *
 * 格式与 `dsh-skill-filesystem` 的 `parseSkillFile` 同一条（`---` 包一段 YAML，正文取
 * `body.trim()`）；只认这两项，`invocation` 由注册方给出 —— 内置技能的两面行为是固定的。
 *
 * **单一真相源**：名字、描述、正文只写在这个文件里，代码不留副本，否则改一处生效、改另一处
 * 静默失效。缺文件或 frontmatter 坏了是**打包错误**，直接抛出，不静默回落。
 */
function readSkillFile(dir: string): { name: string; description: string; content: string } {
  const file = path.join(dir, "SKILL.md");
  const raw = fs.readFileSync(file, "utf-8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  if (!match) throw new Error(`${file} 缺少 YAML frontmatter（\`---\` 包一段 name/description）`);
  const meta = yaml.load(match[1]!) as { name?: unknown; description?: unknown } | null;
  const name = typeof meta?.name === "string" ? meta.name.trim() : "";
  const description = typeof meta?.description === "string" ? meta.description.trim() : "";
  const content = (match[2] ?? "").trim();
  if (!name || !description || !content) {
    throw new Error(`${file} 的 frontmatter 必须有 name 与 description，且正文不能为空`);
  }
  return { name, description, content };
}

/** `ralphflow-create` 的技能定义：正文与元数据都在 `skills/ralphflow-create/SKILL.md`。 */
const CREATE_SKILL = readSkillFile(CREATE_SKILL_RESOURCES);

/**
 * 某个工作流的快捷技能描述：**直接用该工作流 YAML 里的 `description`**（它本来就是面向人的
 * 一句话）；没有时回落 `用 <工作流名> 工作流跑一个任务。`。
 *
 * 这个描述**不是触发词**（技能只给人看，`modelInvocable: false`）—— 进模型目录只会让模型在
 * N 条同义描述里挑（writing-for-agents：一段一个触发分支，同义重复就是一个分支写了两遍）。
 */
export function workflowSkillDescription(workflowName: string, desc: unknown): string {
  const text = typeof desc === "string" ? desc.trim() : "";
  return text || `用 ${workflowName} 工作流跑一个任务。`;
}

/** 某个工作流的快捷技能正文：正文里点名这个工作流与它的人敲形态，任务仍从用户那条消息里取。 */
export function workflowSkillContent(skillName: string, workflowName: string): string {
  return `用户用 \`/${skillName}\` 启动了 \`${workflowName}\` 工作流。请调用 \`ralphflow_start\` 工具：workflow = \`${workflowName}\`，task 取**用户那条消息**里 \`/${skillName}\` 之后的整段任务描述。

用户没带任务描述时，先用自然语言说明用法 \`/${skillName} <任务描述>\`，请用户补上要完成的任务。

${SHARED_MECHANISM}`;
}

/**
 * 工作流名不合语法时的**拒绝理由**（说清「为什么」与「怎么办」，绝不静默跳过）。
 *
 * 硬约束：技能名必须是小写 kebab（`[a-z0-9]+(-[a-z0-9]+)*`）。工作流名直接拼进技能名，
 * 所以名字里有大写/下划线/空格等字符时无法注册快捷技能 —— 但**工具面照旧**：
 * `ralphflow_start` 按名字加载工作流，`/ralphflow-start <工作流> <任务>` 仍能启动它。
 */
export function workflowSkillNameRejection(workflowName: string, skillName: string): string {
  return `工作流 \`${workflowName}\` 没能注册成快捷技能：技能名必须是小写 kebab（\`[a-z0-9]+(-[a-z0-9]+)*\`），而 \`${skillName}\` 不满足（只允许小写字母、数字与单个连字符）。把工作流改成小写 kebab 名（目录 \`my-flow/workflow.yaml\`，单文件形态 \`my-flow.yaml\` 同理）就能拿到 \`/ralphflow-my-flow\` 这个快捷入口；在那之前它仍可用 \`/ralphflow-start ${workflowName} <任务>\` 启动。`;
}

/** 注册技能所需的宿主能力（`skills` 由 `inject` 保证；`deliverNotice` 用于把拒绝理由说给人听）。 */
export interface SkillContext {
  ctx: Context;
  /** 播报载体（不唤醒）：拒绝理由要让人看见，所以走 notice 而不是指令。 */
  deliverNotice: (sessionId: string, text: string, summary?: string) => boolean;
}

/** 一个工作流的清单项（`listWorkflowsIn` 的形状：名字 + YAML 里的 description）。 */
export interface WorkflowSummary {
  name: string;
  desc: string;
  /** 资产类别：Flow / Graph。清单与快捷技能共用同一份发现结果。 */
  kind?: "flow" | "graph";
  /** 步骤数或节点数（供状态面/列表展示，技能正文不依赖它）。 */
  count?: number;
}

/** 技能注册器：把某工作区的工作流补登记成快捷技能（可重复调用，同名先到先得）。 */
export interface WorkflowSkillRegistrar {
  (workflows: WorkflowSummary[], opts?: { sessionId?: string }): void;
}

/**
 * 注册器句柄：登记 + 「把已经发现的拒绝理由说给某个会话听」。
 *
 * 为什么拒绝理由要单独一个方法：引擎**按工作区惰性创建**，而工作流的枚举（`listWorkflowsIn`，
 * 会读目录 + 解析 YAML）不该挂在每次工具调用上。所以：
 *   · `register` 只在**引擎创建**与**新会话创建**时跑（那时才真的读目录）；
 *   · `reportRejections` 是**纯内存**操作（只重放已经记下的拒绝理由），可以随便调。
 */
export interface SkillRegistrar {
  /** 登记该工作区的快捷技能（同名先到先得；重复调用是幂等的） */
  register: WorkflowSkillRegistrar;
  /** 把**已经发现**的「名字不合语法」如实告知这个会话（无 IO；同一会话同一名字只报一次） */
  reportRejections: (sessionId: string) => void;
}

/**
 * 注册 ralphflow 的技能面。
 *
 * `ralphflow-start` 一次注册（省略 `invocation` = **两面都有**，`SkillRegistration` 原文：
 * *omission permits both model and user surfaces*）；`ralphflow-<工作流>` 按工作区惰性登记
 * （引擎按工作区惰性创建，所以这里返回一个登记器）。
 *
 * 名字不合语法的自定义工作流：**如实拒绝并说清原因** —— 写 warn 日志，并在能定位到会话时
 * 投一条可见播报（同一个会话 + 同一个工作流只报一次），绝不静默 `continue`。
 */
export function registerSkills(deps: SkillContext): SkillRegistrar {
  const { ctx } = deps;
  const skills = ctx.skills;
  /** 已注册的技能名（同名先到先得，与「绝不覆盖」语义一致；也避免 dsh 侧重复注册的告警） */
  const taken = new Set<string>();
  /** 已经写过日志的坏名字（每个插件实例一次，日志不刷屏） */
  const logged = new Set<string>();
  /** 已经**成功告知**过的 (会话, 技能名)：告知失败（会话还没有 agent）就不记账，下次再试 */
  const told = new Set<string>();
  /** 已发现但没注册的技能名 → 拒绝理由（供 `reportRejections` 重放，不重复读目录） */
  const rejected = new Map<string, { workflow: string; reason: string }>();

  const warn = (event: string, data?: unknown): void => {
    try { ctx.logger?.warn?.(`[ralphflow] ${event}`, data ?? ""); } catch {}
  };

  const registerOne = (def: SkillRegistration): boolean => {
    try {
      skills.register(def);
      return true;
    } catch (err) {
      warn("skill_registration_skipped", { name: def.name, error: err instanceof Error ? err.message : String(err) });
      return false;
    }
  };

  /** 如实告知一个会话（投可见播报；失败不记账，下次再试） */
  const tell = (sessionId: string, skillName: string, reason: string): void => {
    const key = `${sessionId}:${skillName}`;
    if (told.has(key)) return;
    if (deps.deliverNotice(sessionId, `[ralphflow] ${reason}`, "⚠️ ralphflow：有工作流没能做成快捷技能")) told.add(key);
  };

  // ── 创建技能（`/ralphflow-create`）：正文与元数据读 `skills/ralphflow-create/SKILL.md` ──
  taken.add(CREATE_SKILL.name);
  registerOne({
    name: CREATE_SKILL.name,
    description: CREATE_SKILL.description,
    content: CREATE_SKILL.content,
    resourceBase: { kind: "directory", path: CREATE_SKILL_RESOURCES },
    source: "custom",
  });

  // ── 通用启动技能（`/ralphflow-start`）：省略 invocation = 模型面与人面都有 ──
  taken.add(START_SKILL_NAME);
  registerOne({
    name: START_SKILL_NAME,
    description: START_SKILL_DESCRIPTION,
    content: START_SKILL_CONTENT,
    source: "custom",
  });

  const register: WorkflowSkillRegistrar = (workflows, opts) => {
    try {
      for (const wf of workflows ?? []) {
        const workflowName = String(wf?.name ?? "");
        if (!workflowName) continue;
        const skillName = `${SKILL_PREFIX}${workflowName}`;
        if (taken.has(skillName)) continue; // 同名先到先得（工作区/全局/内置的解析顺序由 listWorkflowsIn 决定）
        if (!SKILL_NAME.test(skillName)) {
          // 不合语法：**拒绝注册**，但把原因说清楚（任务书 完成判据 4：不许静默跳过）。
          const reason = workflowSkillNameRejection(workflowName, skillName);
          if (!rejected.has(skillName)) rejected.set(skillName, { workflow: workflowName, reason });
          if (!logged.has(skillName)) {
            logged.add(skillName);
            warn("workflow_skill_rejected", { workflow: workflowName, reason });
          }
          if (opts?.sessionId) tell(opts.sessionId, skillName, reason);
          continue;
        }
        taken.add(skillName);
        // 只给人看：`modelInvocable: false` —— 模型目录里与 ralphflow 相关的条目只有 `ralphflow-start` 一条。
        registerOne({
          name: skillName,
          description: workflowSkillDescription(workflowName, wf?.desc),
          content: workflowSkillContent(skillName, workflowName),
          invocation: { userInvocable: true, modelInvocable: false },
          source: "custom",
        });
      }
    } catch (err) {
      warn("workflow_skill_registration_skipped", { error: err instanceof Error ? err.message : String(err) });
    }
  };

  return {
    register,
    reportRejections: (sessionId: string) => {
      for (const [skillName, entry] of rejected) tell(sessionId, skillName, entry.reason);
    },
  };
}
