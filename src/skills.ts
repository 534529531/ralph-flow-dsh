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
export const START_SKILL_DESCRIPTION = "每步都由独立会话的验证者验收的工作流。用户点名 ralphflow，或要求做完由独立验证者验收才算完成时用它。";

/**
 * 工作流机制说明（`/ralphflow-start` 与 `/ralphflow-<工作流>` 的技能正文共享，opencode 版
 * SHARED_MECHANISM 的 v0 裁剪版）。
 *
 * 让模型知道：两阶段协议、自动验证、手动审查的放行语义、暂停恢复、以及**阶段播报**
 * （AI 交互友好的来源）。它随技能正文注入 —— 人敲时由宿主注入，模型自然触发时由
 * `skill` 工具返回。
 */
export const SHARED_MECHANISM = `## 工作流机制（每次启动都会生效）

每个工作流步骤有两个阶段：

**DO 阶段（执行）**：
- 按收到的提示执行当前步骤的任务，完成实际工作（写代码、创建文件、运行命令）。
- 所有任务要求满足后，**调用 \`ralphflow_submit\` 工具交卷**（可在 \`summary\` 参数里简述做了什么）。
- 只在回复里说「完成了」**不会**触发验证——必须调用工具。
- 有 \`check\` / \`check_voting\` 的普通步骤到此为止——你空闲时系统会**自动**运行独立 CHECK，**不需要**调用其它工具。

**CHECK 阶段（仅本步有 \`check\` / \`check_voting\` 时）**：
- 交卷后，一个**独立验证者会话**（全新上下文，看不到本对话）依据该步骤的检查依据取证判定。你会收到「🔍 验证中」与验证结果消息。**没有 \`check\` / \`check_voting\` 的步骤不走这一阶段**（见下方「未配置 \`check\` / \`check_voting\` 的步骤」）。
- 步骤写的是 \`check_voting\`（多验证者投票）时：**N 个验证者并行**、各查一条检查依据、**全过才放行**；每票完成会各推一行进度。
- 验证是**异步**的：验证者（独立会话）会真的去读文件、跑命令取证，它在做什么你在会话里看得到；期间不需要你做任何操作，跑完会自动唤醒本会话。**不要给时长预估**——委派没有超时上界，任何时间承诺都是编的。
- **通过** → 工作流自动推进到下一步并注入下一条 DO 提示。
- **未通过** → 你收到失败原因并重做该步（自动重试，不会反复打扰用户）。

**手动步骤**（工作流 \`manual_step\` 列出的步骤，**且本步有 \`check\` / \`check_voting\`**）：CHECK **通过后**系统停下等**用户**审查（会收到 🙋 消息）。用户的 \`/ralphflow-continue\` 是**放行**——直接进入下一步，不重复验证。用户要求修改时，你改完再次调用 \`ralphflow_submit\`，会再次自动验证，通过后再停下。

**未配置 \`check\` / \`check_voting\` 的步骤**（工作流定义声明本步免验证）：**不做独立验证**——交卷后**跳过对抗性验证**，直接进入下一步；\`manual_step\` 的这类步骤则是**纯人工审查**（交卷后停在审查门，等用户 \`/ralphflow-continue\` 放行）。这类步骤务必自查产出是否满足任务要求。

**暂停与恢复**：某步验证失败达到 \`max_fail_count\` 时工作流暂停。用 \`/ralphflow-status\` 看失败原因，修复后 \`/ralphflow-continue\` 恢复（重置失败计数并重试）。

**重要**：\`ralphflow_continue\` 只用于 ① 批准手动审查 ② 恢复暂停 ③ 接管中断实例。**有 \`check\` / \`check_voting\` 的普通步骤不要调用它**——验证是自动的；没有检查依据的**普通步骤**交卷后也会自动继续，审查门步骤则按 ① 等你放行。

**阶段播报**：收到系统阶段通知时，简短地确认一下，让用户随时了解进度：
- DO 阶段：「已启动步骤 [X]，正在处理 [任务]」
- CHECK 阶段（仅本步有 \`check\` / \`check_voting\` 时）：「🔍 已交卷，独立验证者正在取证判定」（投票步：N 个验证者并行，全过才放行）
- 完成：「✅ 所有步骤完成，工作流结束」`;

/**
 * `ralphflow-start` 的技能正文。**参数从用户那条消息里取**，所以正文是静态的：
 * 敲字与自然语言两条路都从这里出发，缺参数就问，不猜。
 */
const START_SKILL_CONTENT = `用户用 \`/ralphflow-start\` 发起了一条要由独立验证者验收的工作流。请调用 \`ralphflow_start\` 工具启动它。

- \`workflow\` 与 \`task\` 都从**用户那条消息**里取：\`/ralphflow-start <工作流> <任务描述>\` 的第一段是工作流名，其余整段是任务描述。
- 用户没有点名工作流时（自然语言触发的情形），先用 \`ralphflow_list\` 看有哪些可选，再按任务性质选一个或问他用哪个。
- 参数不全就**不要调用任何工具**：只有任务没有工作流 → 问用哪个工作流；只有工作流没有任务 → 问要做什么；两者都缺 → 两者都问。
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
