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
 * 工作流机制说明（`/ralphflow-start` 与 `/ralphflow-<工作流>` 的技能正文共享，opencode 版
 * SHARED_MECHANISM 的 v0 裁剪版）。
 *
 * 让模型知道：两阶段协议、自动验证、手动审查的放行语义、暂停恢复、以及通知与执行边界
 * （AI 交互友好的来源）。它随技能正文注入 —— 人敲时由宿主注入，模型自然触发时由
 * `skill` 工具返回。
 */
export const SHARED_MECHANISM = `## 工作流机制

1. 启动成功后，按工具返回的当前步 DO 执行；后续步骤由引擎投递。
2. 本步交付物满足要求、自查有依据后，调用 \`ralphflow_submit\` 交卷。工具调用是交卷事实，回复里的完成声明不推进工作流；该工具会结束当前回合。
3. 交卷后等待：有 \`check\` 时委派独立验证者，有 \`check_voting\` 时 N 票并行、全过才放行；没有 \`check\` / \`check_voting\` 时跳过独立验证。
4. 通过则自动推进；工作成果不通过则收到失败依据并返工，达到失败上限才暂停。基础设施故障自动重验一次，仍故障则暂停，不消耗工作失败次数。
5. 审查门在交卷并通过验证后等用户放行；免验证的门交卷即停。用户要求修改时，改好产出再交卷；用户明确放行时才调用 \`ralphflow_continue\`。暂停恢复与实例接管也以用户指令为准，按工具实际返回的阶段行动。

验证者看不到本对话或交卷 summary；把需要它验收的产出与证据留在工具指定的文件位置。步骤重置会移除此前对话，跨步需要的需求、决定与证据应写入已有过程文档。
阶段通知与状态入口由插件直接向用户展示，无需逐条回应。说明进度以工具结果为准；独立验证没有可承诺的完成时长。`;

/**
 * `ralphflow-start` 的技能正文。**参数从用户那条消息里取**，所以正文是静态的：
 * 敲字与自然语言两条路都从这里出发，按用户输入补足缺项，不猜任务内容。
 */
const START_SKILL_CONTENT = `启动用户要求的 Ralph Flow 工作流。请调用 \`ralphflow_start\` 工具启动它。

- \`workflow\` 与 \`task\` 都从**用户那条消息**里取：\`/ralphflow-start <工作流> <任务描述>\` 的第一段是工作流名，其余整段是任务描述。
- 有任务而未指定工作流：先用 \`ralphflow_list\` 列出可选项，匹配明确时选择并说明，无法判断时问用户。缺任务：请用户补充任务后再启动。保留用户原始约束，不替用户扩充任务范围。
- 工具报错就如实转达；成功就按它返回的指示执行，并遵循下面的机制。

${SHARED_MECHANISM}`;

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
  return `用户用 \`/${skillName}\` 启动了 \`${workflowName}\` 工作流。请调用 \`ralphflow_start\` 工具：workflow = \`${workflowName}\`，task = **用户那条消息**里 \`/${skillName}\` 之后的整段任务描述。

用户没带任务描述时**不要调用任何工具**，先用自然语言说明用法 \`/${skillName} <任务描述>\` 并请用户补上要完成的任务。
工具报错就如实转达；成功就按它返回的指示执行，并遵循下面的机制。

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
  return `工作流 \`${workflowName}\` 没能注册成快捷技能：技能名必须是小写 kebab（\`[a-z0-9]+(-[a-z0-9]+)*\`），而 \`${skillName}\` 不满足（只允许小写字母、数字与单个连字符）。把工作流文件重命名成小写 kebab（例如 \`my-flow.yaml\`）就能拿到 \`/ralphflow-my-flow\` 这个快捷入口；在那之前它仍可用 \`/ralphflow-start ${workflowName} <任务>\` 启动。`;
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
