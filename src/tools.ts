/**
 * Ralph Flow for dsh v2 — 工具 + 命令（命名与 opencode/claude 版一致）
 *
 * 命令语义 = 触发词：/ralphflow-* 注入指令给模型，由模型调用同名工具并自然回复。
 * 已实现：start / list / status / continue / cancel / create / doctor + 工作流快捷命令（/ralphflow-<工作流名>）；
 * reset / rewind 只声明（涉及上下文管理，暂缓）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Engine } from "./engine.js";
import { CREATE_GUIDE } from "./create.js";

/**
 * 工作流机制说明（/ralphflow-start 与 /ralphflow-loop、/ralphflow-spec 等快捷命令共享，opencode 版 SHARED_MECHANISM 的 v0 裁剪版）。
 * 让模型知道：两阶段协议、自动验证、手动审查的放行语义、暂停恢复、以及**阶段播报**（AI 交互友好的来源）。
 */
const SHARED_MECHANISM = `## 工作流机制（每次启动都会生效）

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

export interface ToolContext {
  ctx: Context;
  /** 按工作区取引擎（**一个工作区一个引擎**，见 index.ts 的 engineFor）；缺省用进程工作区 */
  engineFor: (workspace?: string) => Engine;
  deliver: (sessionId: string, text: string) => boolean;
  /** 解析发起会话的工作区（实例资产落点） */
  workspaceOfSession?: (sessionId: string) => string;
}

export type ToolHandler = (args: any, agent: Agent | undefined) => Promise<string> | string;

/** 可用命令清单 —— 单一事实源：未实现命令的说明与兜底回执共用同一份，避免两处各写一遍后走样。 */
const AVAILABLE_COMMANDS = "`/ralphflow-start`、`/ralphflow-list`、`/ralphflow-status`、`/ralphflow-continue`、`/ralphflow-cancel`、`/ralphflow-create`、`/ralphflow-doctor`";

function sessionIdOf(agent: Agent | undefined): string | null {
  return (agent as { session?: { id?: string } } | undefined)?.session?.id ?? null;
}

// ─── 工具注册 ────────────────────────────────────────────────────────────────

export function registerTools(deps: ToolContext): Map<string, ToolHandler> {
  const { ctx } = deps;
  const handlers = new Map<string, ToolHandler>();
  const tools = ctx.tools as { register(def: unknown): void };

  /**
   * 会话 → 它所在工作区的引擎。**这是所有「发现面」的唯一入口。**
   *
   * 引擎的根就是会话工作区，所以列表、历史、doctor、自定义工作流查找天然落在对的地方。
   * 以前这里是「一个引擎 + 全局索引」：引擎根是 dsh 进程的 cwd，而实例资产落在会话
   * 工作区——真实 GUI 里两者必然不同（`dsh web` cwd = /home/yj，会话工作区 = 仓库），
   * 于是自定义工作流加载不到、历史列表永远空、doctor 看不见残留。
   */
  const engineOf = (agent: Agent | undefined): Engine => {
    const sid = sessionIdOf(agent);
    return deps.engineFor(sid ? deps.workspaceOfSession?.(sid) : undefined);
  };

  const startHandler: ToolHandler = (args, agent) => {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return "找不到当前会话，无法启动工作流。";
    return engineOf(agent).start(String(args?.workflow ?? ""), String(args?.task ?? ""), sessionId).text;
  };

  const continueHandler: ToolHandler = (args, agent) => {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return "找不到当前会话。";
    return engineOf(agent).continueInstance(sessionId, args?.instance ? String(args.instance) : undefined).text;
  };

  const statusHandler: ToolHandler = (args, agent) => {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return "找不到当前会话。";
    return engineOf(agent).statusOf(sessionId, args?.instance ? String(args.instance) : undefined).text;
  };

  const listHandler: ToolHandler = (_args, agent) => engineOf(agent).listAll().text;

  const cancelHandler: ToolHandler = (args, agent) => {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return "找不到当前会话。";
    return engineOf(agent).cancelInstance(sessionId, args?.instance ? String(args.instance) : undefined, args?.reason ? String(args.reason) : undefined).text;
  };

  const createHandler: ToolHandler = (args, agent) => {
    const idea = args?.idea ? String(args.idea).trim() : "";
    // 写意图：把工作流目录建好，模型随后才写得进 <workspace>/.dsh/ralph-flow/workflows/
    try { engineOf(agent).ensureLayout(); } catch {}
    return idea ? `你要创建的工作流：**${idea}**\n\n---\n\n${CREATE_GUIDE}` : CREATE_GUIDE;
  };

  const doctorHandler: ToolHandler = (_args, agent) => engineOf(agent).diagnose().text;

  /**
   * DO 阶段交卷（dsh 原生方式：工具调用即事实，不靠正则扫自由文本）。
   * `concludeTurn` 由注册处调用，让本次工具结果结束当前回合。
   */
  const submitHandler: ToolHandler = (args, agent) => {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return "找不到当前会话，无法交卷。";
    const summary = args?.summary !== undefined ? String(args.summary) : undefined;
    return engineOf(agent).onSubmit(sessionId, summary).text;
  };

  const unimplHandler: ToolHandler = () => `本版本未实现（涉及上下文管理，暂缓）。已可用：${AVAILABLE_COMMANDS}。`;

  const toolDefs: Array<{ name: string; description: string; params: Record<string, any>; handler: ToolHandler; concludeTurn?: boolean }> = [
    {
      name: "ralphflow_start",
      description: "启动一个 Ralph Flow 工作流：模型执行当前步骤；有 `check` / `check_voting` 的步骤交卷后由独立验证者取证判定（投票步 N 票并行、全过才放行），失败自动返工；没有 `check` / `check_voting` 的步骤跳过对抗性验证。启动结果会给出本步的 DO 提示与交卷方式。",
      params: {
        workflow: { type: "string", required: true, description: "工作流名（loop / spec，或自定义 YAML 名）。" },
        task: { type: "string", required: true, description: "要完成的任务描述。" },
      },
      handler: startHandler,
    },
    {
      name: "ralphflow_submit",
      description: "【DO 阶段交卷】本步工作完成后调用。有 `check` / `check_voting` 的步骤：独立验证者随即取证判定（投票步 N 票并行、全过才放行）；没有 `check` / `check_voting` 的步骤：跳过对抗性验证直接继续（`manual_step` 则停在审查门等放行）。不交卷则工作流不会推进。",
      params: {
        summary: { type: "string", description: "可选：简述本步做了什么。**验证者看不到它**（T1：验证请求不含执行者自述），它只留在实例状态里；验证者只独立取证。" },
      },
      handler: submitHandler,
      concludeTurn: true,
    },
    {
      name: "ralphflow_continue",
      description: "推进工作流：放行审查门 / 解除暂停 / 接管无属主的活跃实例。判定未通过时拒绝推进。",
      params: {
        instance: { type: "string", description: "接管其它会话的实例 ID（可前缀）。" },
      },
      handler: continueHandler,
    },
    {
      name: "ralphflow_status",
      description: "查看当前会话（或指定实例）的工作流状态、本轮判定、多验证者投票的每票进度与最近轨迹；实例已结束并销毁时指向它的历史报告。",
      params: {
        instance: { type: "string", description: "实例 ID（可前缀）；缺省看当前会话实例。" },
      },
      handler: statusHandler,
    },
    {
      name: "ralphflow_list",
      description: "列出可用工作流、活跃实例与已归档的历史运行。",
      params: {},
      handler: listHandler,
    },
    {
      name: "ralphflow_cancel",
      description: "取消当前会话（或指定）的活跃实例：中止在飞验证者、归档报告到精确路径并销毁实例目录（报告归档失败时保留不销毁）。",
      params: {
        instance: { type: "string", description: "实例 ID（可前缀）。" },
        reason: { type: "string", description: "取消原因（可选）。" },
      },
      handler: cancelHandler,
    },
    {
      name: "ralphflow_create",
      description: "获取自定义工作流的交互式设计指引（模型与用户一轮问清流程 → 呈现步骤图 → 写 YAML → doctor 校验到全部 ✅ 且无告警）。",
      params: {
        idea: { type: "string", description: "用户想自动化的流程想法（可选，有则附在指引前）。" },
      },
      handler: createHandler,
    },
    {
      name: "ralphflow_doctor",
      description: "诊断工作流定义与实例状态：坏文件说人话、列出阻塞项，修完重跑直到全部 ✅。",
      params: {},
      handler: doctorHandler,
    },
  ];

  for (const def of toolDefs) {
    handlers.set(def.name, def.handler);
    tools.register(defineTool({
      name: def.name,
      description: def.description,
      parameters: def.params,
      output: { schema: { type: "string" }, render: (_args: unknown, value: string) => [{ type: "text", text: value }] },
      async execute(args: unknown, exec: { agent?: Agent; concludeTurn?: () => void }) {
        const out = await def.handler(args ?? {}, exec?.agent);
        // 交卷工具用宿主原生的 concludeTurn 结束本回合
        // （与 dsh-subagent-in-process-driver 的 structured_output 同款机制）。
        if (def.concludeTurn && typeof exec?.concludeTurn === "function") {
          try { exec.concludeTurn(); } catch {}
        }
        return out;
      },
    }));
  }

  // reset / rewind：只声明不实现（design §8 / 宪法 §10.10）。
  // 它们**不注册为工具** —— 注册了就等于给模型一个可调用、会返回内容的实现，
  // 与「命令面固定 + 只声明不实现」的边界冲突。命令处理面（/ralphflow-reset、
  // /ralphflow-rewind）仍然把指令交给模型，由模型自然语言解释暂缓原因。
  for (const n of ["reset", "rewind"]) handlers.set(`ralphflow_${n}`, unimplHandler);

  return handlers;
}

// ─── 命令注册 ────────────────────────────────────────────────────────────────

export function registerCommands(deps: ToolContext & { handlers: Map<string, ToolHandler> }): (workflows: Array<{ name: string; desc: string }>) => void {
  const { ctx } = deps;
  const commands = (ctx as unknown as {
    commands: {
      register(def: {
        name: string;
        description: string;
        input?: { hint: string };
        handler: (inv: { rawInput: string; agent: Agent; signal: AbortSignal }) => Promise<{ kind: "success"; text?: string } | { kind: "error"; text: string }> | { kind: "success"; text?: string } | { kind: "error"; text: string };
      }): void;
    };
  }).commands;

  /** 每条命令 = 触发词：不直接渲染工具返回值，而是给模型一条指令，由模型调用工具并自然回复（claude/opencode 语义）。 */
  const defs: Array<{
    name: string;
    description: string;
    input?: { hint: string };
    /** 参数合法时返回给模型的指令；否则返回渲染给用户的卡片（用法错误/未实现） */
    shim(inv: { rawInput: string; agent: Agent; signal: AbortSignal }):
      | { kind: "directive"; text: string }
      | { kind: "card"; text: string };
  }> = [
    {
      name: "ralphflow-start",
      description: "启动工作流：模型执行 → 有 `check` / `check_voting` 的步骤交独立验证（投票步 N 票并行、全过才放行），失败自动返工；没有 `check` / `check_voting` 的步骤跳过对抗性验证。示例：/ralphflow-start loop 修复登录模块的空指针",
      input: { hint: "<工作流> <任务描述>" },
      shim: (inv) => {
        const parts = inv.rawInput.trim().split(/\s+/).filter(Boolean);
        if (parts.length < 2) {
          // 用法错误也交回 AI：像 opencode 一样由模型说明用法并追问缺失信息
          return {
            kind: "directive",
            text: "用户执行了 /ralphflow-start 但参数不完整（需要工作流名 + 任务描述）。**不要调用任何工具**，先用自然语言向用户说明用法并询问缺少的信息：只有任务没有工作流 → 问用哪个工作流；只有工作流没有任务 → 问要做什么；都没有 → 两者都问。必要时用 ralphflow_list 查看可用工作流供用户选择。",
          };
        }
        const workflow = parts[0]!;
        const task = parts.slice(1).join(" ");
        return {
          kind: "directive",
          text: `用户通过 /ralphflow-start 启动了 ralphflow 工作流。请调用 \`ralphflow_start\` 工具：workflow = \`${workflow}\`，task = \`${task}\`。若工具报错，如实转达；若成功，按它返回的指示执行并遵循下面的机制。\n\n${SHARED_MECHANISM}`,
        };
      },
    },
    {
      name: "ralphflow-continue",
      description: "推进工作流：放行审查门 / 解除暂停 / 接管实例。示例：/ralphflow-continue <实例ID>",
      input: { hint: "[实例ID]" },
      shim: (inv) => {
        const parts = inv.rawInput.trim().split(/\s+/).filter(Boolean);
        const instance = parts[0] ? `，instance = \`${parts[0]}\`` : "";
        return {
          kind: "directive",
          text: `用户执行了 /ralphflow-continue。\`ralphflow_continue\` 只用于三种情况：**批准手动审查**（🙋 步骤停下等你放行：有 \`check\` / \`check_voting\` 的是已通过独立验证，没有 \`check\` / \`check_voting\` 的是已跳过对抗性验证的纯人工审查——两者都直接放行进入下一步，不重复验证）、**恢复暂停**（先看 \`/ralphflow-status\` 的失败原因，修复后调用，重置失败计数并重试；投票步的基础设施故障恢复只重跑未通过的票，已通过的保留）、**接管中断/他人实例**。有 \`check\` / \`check_voting\` 的普通步骤推进是自动的，不要调用它。

请调用 \`ralphflow_continue\` 工具${instance}。若不带实例 id 且本会话没有活跃实例，工具会列出可选实例：把它展示给用户并询问接管哪个，再带 \`instance\` 调用。按工具结果行动：进入 DO 就执行该步任务；验证中就简短说明；完成就说「工作流结束」；暂停就说明原因与下一步。`,
        };
      },
    },
    {
      name: "ralphflow-status",
      description: "查看实例状态与判定。示例：/ralphflow-status",
      input: { hint: "[实例ID]" },
      shim: (inv) => {
        const parts = inv.rawInput.trim().split(/\s+/).filter(Boolean);
        const instance = parts[0] ? `，instance = \`${parts[0]}\`` : "";
        return {
          kind: "directive",
          text: `用户执行了 /ralphflow-status，想了解工作流进度。请调用 \`ralphflow_status\` 工具${instance}（不带参数时若本会话无实例，应显示项目里所有活跃实例的概览）。然后向用户清晰说明：工作流与当前步骤、状态（执行中/验证中/待放行/暂停及原因）、失败次数，以及**属主会话**——属于其他或已关闭会话的实例可通过 \`/ralphflow-continue <实例ID>\` 接管。若工具说该实例**已结束并销毁**，就把报告路径给用户（历史在报告里，不要在列表里找）。`,
        };
      },
    },
    {
      name: "ralphflow-list",
      description: "列出可用工作流、活跃实例与历史运行。示例：/ralphflow-list",
      shim: () => ({
        kind: "directive",
        text: "用户执行了 /ralphflow-list。请调用 `ralphflow_list` 工具获取数据，然后把「可用工作流」整理成**表格**（列：工作流 | 用途描述），把「活跃实例」按工具返回的字段简要列给用户（实例 id、工作流、任务、步骤、状态、属主），把「历史运行（已归档）」按工具返回的字段列出（实例 id、状态、任务、结束时间、报告路径），并告诉用户历史报告目录的路径。数据以工具返回为准，不要编造；没有就直说。工作流解析顺序：工作区自定义 `.dsh/ralph-flow/workflows/` > 全局 `~/.dsh/ralph-flow/workflows/` > 插件内置。",
      }),
    },
    {
      name: "ralphflow-cancel",
      description: "取消活跃实例：归档报告并销毁实例目录。示例：/ralphflow-cancel",
      input: { hint: "[实例ID] [原因]" },
      shim: (inv) => {
        const parts = inv.rawInput.trim().split(/\s+/).filter(Boolean);
        const instance = parts[0] ? `，instance = \`${parts[0]}\`` : "";
        const reason = parts.length > 1 ? `，reason = \`${parts.slice(1).join(" ")}\`` : "";
        return {
          kind: "directive",
          text: `用户执行了 /ralphflow-cancel，要取消工作流实例${instance}。请调用 \`ralphflow_cancel\` 工具${reason}——它会中止任何在飞的独立验证会话、把最终报告归档到精确路径（\`.dsh/ralph-flow/reports/<实例ID>.md\`）并销毁实例目录；产出目录保留。若报告归档失败，它会保留实例目录不销毁并告警，请如实转达。然后向用户简短确认已取消（或转达错误），并把报告路径给用户。`,
        };
      },
    },
    {
      name: "ralphflow-create",
      description: "交互式创建自定义工作流（模型引导设计 → 写 YAML → doctor 校验）。示例：/ralphflow-create 把 C 代码迁移到 Rust",
      input: { hint: "[流程想法]" },
      shim: (inv) => ({
        kind: "directive",
        text: `用户想${inv.rawInput.trim() ? `创建一个工作流：${inv.rawInput.trim()}` : "创建自定义 Ralph Flow 工作流"}。请调用 \`ralphflow_create\` 工具获取完整设计指引，然后按指引与用户交互：一轮问清流程阶段与审查门位置（用户没说清楚才问）→ 呈现步骤图 → 写 YAML 到 \`.dsh/ralph-flow/workflows/\` → 调用 \`ralphflow_doctor\` 校验到全部 ✅ 且无告警 → 交接运行方式。`,
      }),
    },
    {
      name: "ralphflow-doctor",
      description: "诊断工作流定义与实例状态。示例：/ralphflow-doctor",
      shim: () => ({
        kind: "directive",
        text: "用户执行了 /ralphflow-doctor，想诊断工作流与实例。请调用 `ralphflow_doctor` 工具，然后把诊断为 ❌ 的每一项用通俗语言向用户说明原因与修复建议；全部 ✅ 就简短说「一切正常」。",
      }),
    },
    {
      name: "ralphflow-reset",
      description: "（本版本未实现）重做当前步。",
      shim: () => ({
        kind: "directive",
        text: `用户执行了 /ralphflow-reset（重做当前步，涉及上下文管理，本版本暂缓实现）。**不要调用任何工具**，用自然语言说明：该命令本版本未实现、暂缓原因（涉及上下文管理），以及当前可用命令 ${AVAILABLE_COMMANDS}；如用户确实想重做，可建议重新交卷触发自动返工，或取消后重启。`,
      }),
    },
    {
      name: "ralphflow-rewind",
      description: "（本版本未实现）回退到上游步骤。",
      shim: () => ({
        kind: "directive",
        text: `用户执行了 /ralphflow-rewind（回退到上游步骤，涉及上下文管理，本版本暂缓实现）。**不要调用任何工具**，用自然语言说明：该命令本版本未实现、暂缓原因（涉及上下文管理），以及当前可用命令 ${AVAILABLE_COMMANDS}。`,
      }),
    },
  ];

  for (const def of defs) {
    try {
      commands.register({
        name: def.name,
        description: def.description,
        ...(def.input ? { input: { hint: def.input.hint } } : {}),
        handler: async (inv: { rawInput: string; agent: Agent; signal: AbortSignal }) => {
          try {
            const out = def.shim({ rawInput: inv.rawInput, agent: inv.agent, signal: inv.signal });
            if (out.kind === "directive") {
              const sid = messageSessionId(inv.agent);
              if (sid) {
                deps.deliver(sid, `[ralphflow] ${out.text}`);
                // 回复留给模型（claude/opencode 语义），命令卡不渲染任何程序文本
                return { kind: "success" };
              }
              // 找不到会话（罕见兜底）：卡片展示，避免用户什么反馈都没有
              return { kind: "error", text: "当前会话已离线，无法交给模型处理。请刷新后重试。" };
            }
            return { kind: "success", text: out.text };
          } catch (err) {
            return { kind: "error", text: err instanceof Error ? err.message : String(err) };
          }
        },
      });
    } catch (err) {
      ctx.logger?.warn?.("[ralphflow] command registration skipped:", err);
    }
  }

  // ─── 动态工作流快捷命令：/ralphflow-<工作流名>（与 claude code 版看齐）────────
  // claude 版：cmdName = SLASH_COMMAND_PREFIX("ralphflow-") + wf.name，且只对
  // 名字安全（^[a-zA-Z0-9_-]+$）的工作流注册。这里同款，另加 dsh 命令名约束
  // （小写、^[a-z][a-z0-9_-]*$）与静态命令撞名保护（如工作流叫 start → ralphflow-start 已占用则跳过）。
  //
  // **引擎按工作区惰性创建**，所以这里返回一个登记器而不是一次性注册：每新建一个引擎，
  // 就把该工作区新出现的工作流补登记成快捷命令（同名先到先得，与「绝不覆盖」语义一致）。
  const taken = new Set<string>(defs.map((d) => d.name));
  return function registerWorkflowShortcuts(workflows: Array<{ name: string; desc: string }>): void {
  try {
    for (const wf of workflows) {
      const rawName = String(wf.name);
      if (!/^[a-zA-Z0-9_-]+$/.test(rawName)) continue;
      const cmd = `ralphflow-${rawName.toLowerCase()}`;
      if (!/^[a-z][a-z0-9_-]*$/.test(cmd)) continue;
      if (taken.has(cmd)) continue;
      taken.add(cmd);
      const desc = wf.desc || `启动 ${wf.name} 工作流`;
      try {
        commands.register({
          name: cmd,
          description: `(ralphflow) ${desc} · 示例：/${cmd} <任务描述>`,
          input: { hint: "<任务描述>" },
          handler: async (inv: { rawInput: string; agent: Agent; signal: AbortSignal }) => {
            try {
              const task = inv.rawInput.trim();
              const sid = messageSessionId(inv.agent);
              if (!task) {
                // 缺任务也交回 AI：先说明用法再等任务（claude 版同款：先问要完成什么）
                if (sid) {
                  deps.deliver(sid, `[ralphflow] 用户执行了 /${cmd}（\`${wf.name}\` 工作流）但没有附带任务描述。**不要调用任何工具**，先用自然语言说明用法：\`/${cmd} <任务描述>\`，并请用户补上要完成的任务。`);
                }
                return { kind: "success" };
              }
              if (sid) {
                deps.deliver(sid, `[ralphflow] 用户通过 /${cmd} 启动了 \`${wf.name}\` 工作流。请调用 \`ralphflow_start\` 工具：workflow = \`${wf.name}\`，task = \`${task}\`。若工具报错，如实转达；若成功，按它返回的指示执行并遵循下面的机制。\n\n${SHARED_MECHANISM}`);
              }
              return { kind: "success" };
            } catch (err) {
              return { kind: "error", text: err instanceof Error ? err.message : String(err) };
            }
          },
        });
      } catch {
        // 与其它插件撞名：静默跳过，与 claude/opencode 版"绝不覆盖"语义一致
      }
    }
  } catch (err) {
    ctx.logger?.warn?.("[ralphflow] workflow shortcut registration skipped:", err);
  }
  };
}

function messageSessionId(agent: Agent | undefined): string {
  return (agent as { session?: { id?: string } } | undefined)?.session?.id ?? "";
}