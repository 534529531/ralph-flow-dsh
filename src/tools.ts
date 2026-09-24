/**
 * Ralph Flow for dsh v2 — 工具 + 命令（命名与 opencode/claude 版一致）
 *
 * 命令语义 = 触发词：/ralphflow-* 注入指令给模型，由模型调用同名工具并自然回复。
 * 已实现：start / list / status / continue / cancel / create / doctor + 工作流快捷命令（/loop /spec …）；
 * reset / rewind 只声明（涉及上下文管理，暂缓）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Engine } from "./engine.js";
import { CREATE_GUIDE } from "./create.js";

/**
 * 工作流机制说明（/ralphflow-start 与 /loop、/spec 等快捷命令共享，opencode 版 SHARED_MECHANISM 的 v0 裁剪版）。
 * 让模型知道：两阶段协议、自动验证、手动审查的放行语义、暂停恢复、以及**阶段播报**（AI 交互友好的来源）。
 */
const SHARED_MECHANISM = `## 工作流机制（每次启动都会生效）

每个工作流步骤有两个阶段：

**DO 阶段（执行）**：
- 按收到的提示执行当前步骤的任务，完成实际工作（写代码、创建文件、运行命令）。
- 所有任务要求满足后，**调用 \`ralphflow_submit\` 工具交卷**（可在 \`summary\` 参数里简述做了什么）。
- 只在回复里说「完成了」**不会**触发验证——必须调用工具。
- 普通步骤到此为止——你空闲时系统会**自动**运行独立 CHECK，**不需要**调用其它工具。

**CHECK 阶段（自动进行）**：
- 交卷后，一个**独立验证者会话**（全新上下文，看不到本对话）依据该步骤的检查依据取证判定。你会收到「🔍 验证中」与验证结果消息。
- 验证是**异步**的：通常需要 1–5 分钟，期间不需要你做任何操作，跑完会自动唤醒本会话。
- **通过** → 工作流自动推进到下一步并注入下一条 DO 提示。
- **未通过** → 你收到失败原因并重做该步（自动重试，不会反复打扰用户）。

**手动步骤**（工作流 \`manual_step\` 列出的步骤）：CHECK **通过后**系统停下等**用户**审查（会收到 🙋 消息）。用户的 \`/ralphflow-continue\` 是**放行**——直接进入下一步，不重复验证。用户要求修改时，你改完再次调用 \`ralphflow_submit\`，会再次自动验证，通过后再停下。

**暂停与恢复**：某步验证失败达到 \`max_fail_count\` 时工作流暂停。用 \`/ralphflow-status\` 看失败原因，修复后 \`/ralphflow-continue\` 恢复（重置失败计数并重试）。

**重要**：\`ralphflow_continue\` 只用于 ① 批准手动审查 ② 恢复暂停 ③ 接管中断实例。普通步骤**不要**调用它——验证是自动的。

**阶段播报**：收到系统阶段通知时，简短地确认一下，让用户随时了解进度（这是良好体验的一部分）：
- DO 阶段：「已启动步骤 [X]，正在处理 [任务]」
- CHECK 阶段：「🔍 已交卷，独立验证者正在取证判定」
- 完成：「✅ 所有步骤完成，工作流结束」`;

export interface ToolContext {
  ctx: Context;
  engine: Engine;
  deliver: (sessionId: string, text: string) => boolean;
  /** 解析发起会话的工作区（实例资产落点） */
  workspaceOfSession?: (sessionId: string) => string;
}

export type ToolHandler = (args: any, agent: Agent | undefined) => Promise<string> | string;

function sessionIdOf(agent: Agent | undefined): string | null {
  return (agent as { session?: { id?: string } } | undefined)?.session?.id ?? null;
}

// ─── 工具注册 ────────────────────────────────────────────────────────────────

export function registerTools(deps: ToolContext): Map<string, ToolHandler> {
  const { ctx, engine } = deps;
  const handlers = new Map<string, ToolHandler>();
  const tools = ctx.tools as { register(def: unknown): void };

  const startHandler: ToolHandler = (args, agent) => {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return "找不到当前会话，无法启动工作流。";
    const workspace = deps.workspaceOfSession?.(sessionId) ?? engine.projectDir;
    return engine.start(String(args?.workflow ?? ""), String(args?.task ?? ""), sessionId, workspace).text;
  };

  const continueHandler: ToolHandler = (args, agent) => {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return "找不到当前会话。";
    return engine.continueInstance(sessionId, args?.instance ? String(args.instance) : undefined).text;
  };

  const statusHandler: ToolHandler = (args, agent) => {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return "找不到当前会话。";
    return engine.statusOf(sessionId, args?.instance ? String(args.instance) : undefined).text;
  };

  const listHandler: ToolHandler = () => engine.listAll().text;

  const cancelHandler: ToolHandler = (args, agent) => {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return "找不到当前会话。";
    return engine.cancelInstance(sessionId, args?.instance ? String(args.instance) : undefined, args?.reason ? String(args.reason) : undefined).text;
  };

  const createHandler: ToolHandler = (args) => {
    const idea = args?.idea ? String(args.idea).trim() : "";
    return idea ? `你要创建的工作流：**${idea}**\n\n---\n\n${CREATE_GUIDE}` : CREATE_GUIDE;
  };

  const doctorHandler: ToolHandler = () => engine.diagnose().text;

  /**
   * DO 阶段交卷（dsh 原生方式：工具调用即事实，不靠正则扫自由文本）。
   * `concludeTurn` 由注册处调用，让本次工具结果结束当前回合。
   */
  const submitHandler: ToolHandler = (args, agent) => {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return "找不到当前会话，无法交卷。";
    const summary = args?.summary !== undefined ? String(args.summary) : undefined;
    return engine.onSubmit(sessionId, summary).text;
  };

  const unimplHandler: ToolHandler = () => "本版本未实现（涉及上下文管理，暂缓）。已可用：`/ralphflow-start`、`/ralphflow-list`、`/ralphflow-status`、`/ralphflow-continue`、`/ralphflow-cancel`、`/ralphflow-create`、`/ralphflow-doctor`。";

  const toolDefs: Array<{ name: string; description: string; params: Record<string, any>; handler: ToolHandler; concludeTurn?: boolean }> = [
    {
      name: "ralphflow_start",
      description: "启动一个 Ralph Flow 工作流：模型执行当前步骤，完成后由独立验证者（独立会话）取证判定，失败自动返工。",
      params: {
        workflow: { type: "string", required: true, description: "工作流名（loop / spec，或自定义 YAML 名）。" },
        task: { type: "string", required: true, description: "要完成的任务描述。" },
      },
      handler: startHandler,
    },
    {
      name: "ralphflow_submit",
      description: "【DO 阶段交卷】本步实际工作完成后调用本工具交卷；独立验证者随后取证判定。不交卷则验证不会开始。",
      params: {
        summary: { type: "string", description: "可选：简述本步做了什么（供验证者参考；验证者仍会独立取证，不会采信自我评价）。" },
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
      description: "查看当前会话（或指定实例）的工作流状态、本轮判定与最近轨迹。",
      params: {
        instance: { type: "string", description: "实例 ID（可前缀）；缺省看当前会话实例。" },
      },
      handler: statusHandler,
    },
    {
      name: "ralphflow_list",
      description: "列出全部实例（活跃/暂停/已结束）与可用工作流。",
      params: {},
      handler: listHandler,
    },
    {
      name: "ralphflow_cancel",
      description: "取消当前会话（或指定）的活跃实例：中止在飞验证者并归档报告。",
      params: {
        instance: { type: "string", description: "实例 ID（可前缀）。" },
        reason: { type: "string", description: "取消原因（可选）。" },
      },
      handler: cancelHandler,
    },
    {
      name: "ralphflow_create",
      description: "获取自定义工作流的交互式设计指引（模型与用户一轮问清流程 → 呈现步骤图 → 写 YAML → doctor 校验到可启动）。",
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

export function registerCommands(deps: ToolContext & { handlers: Map<string, ToolHandler> }): void {
  const { ctx, engine } = deps;
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
      description: "启动工作流：模型执行 → 独立验证 → 失败自动返工。示例：/ralphflow-start loop 修复登录模块的空指针",
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
          text: `用户执行了 /ralphflow-continue。\`ralphflow_continue\` 只用于三种情况：**批准手动审查**（🙋 步骤已通过自动验证，放行进入下一步，不重复验证）、**恢复暂停**（先看 \`/ralphflow-status\` 的失败原因，修复后调用，重置失败计数并重试）、**接管中断/他人实例**。普通步骤的推进是自动的，不要调用它。

请调用 \`ralphflow_continue\` 工具${instance}。若不带实例 id 且本会话没有活跃实例，工具会列出可选实例：把它展示给用户并询问接管哪个，再带 \`instance\` 调用。按工具结果行动：进入 DO 就执行该步任务；验证中就简短说明；完成就说「工作流结束」；暂停就说明原因与下一步。`,
        };
      },
    },
    {
      name: "ralphflow-status",
      description: "查看实例状态与判定的命令。示例：/ralphflow-status",
      input: { hint: "[实例ID]" },
      shim: (inv) => {
        const parts = inv.rawInput.trim().split(/\s+/).filter(Boolean);
        const instance = parts[0] ? `，instance = \`${parts[0]}\`` : "";
        return {
          kind: "directive",
          text: `用户执行了 /ralphflow-status，想了解工作流进度。请调用 \`ralphflow_status\` 工具${instance}（不带参数时若本会话无实例，应显示项目里所有活跃实例的概览）。然后向用户清晰说明：工作流与当前步骤、状态（执行中/验证中/待放行/暂停及原因）、失败次数，以及**属主会话**——属于其他或已关闭会话的实例可通过 \`/ralphflow-continue <实例ID>\` 接管。`,
        };
      },
    },
    {
      name: "ralphflow-list",
      description: "列出全部实例与可用工作流。示例：/ralphflow-list",
      shim: () => ({
        kind: "directive",
        text: "用户执行了 /ralphflow-list。请调用 `ralphflow_list` 工具获取数据，然后把「可用工作流」整理成**表格**（列：工作流 | 用途描述），把「工作流实例」按工具返回的字段简要列给用户（实例 id、工作流、任务、步骤、状态、属主）。数据以工具返回为准，不要编造；没有实例就直说。工作流解析顺序：项目/工作区自定义 > 全局 `~/.dsh/ralph-flow/workflows` > 插件内置。",
      }),
    },
    {
      name: "ralphflow-cancel",
      description: "取消活跃实例并归档报告。示例：/ralphflow-cancel",
      input: { hint: "[实例ID] [原因]" },
      shim: (inv) => {
        const parts = inv.rawInput.trim().split(/\s+/).filter(Boolean);
        const instance = parts[0] ? `，instance = \`${parts[0]}\`` : "";
        const reason = parts.length > 1 ? `，reason = \`${parts.slice(1).join(" ")}\`` : "";
        return {
          kind: "directive",
          text: `用户执行了 /ralphflow-cancel，要取消工作流实例${instance}。请调用 \`ralphflow_cancel\` 工具${reason}——它会中止任何在飞的独立验证会话、把最终报告归档到 \`ralph-flow/reports/\`。然后向用户简短确认已取消（或转达错误）。`,
        };
      },
    },
    {
      name: "ralphflow-create",
      description: "交互式创建自定义工作流（模型引导设计 → 写 YAML → doctor 校验）。示例：/ralphflow-create 把 C 代码迁移到 Rust",
      input: { hint: "[流程想法]" },
      shim: (inv) => ({
        kind: "directive",
        text: `用户想${inv.rawInput.trim() ? `创建一个工作流：${inv.rawInput.trim()}` : "创建自定义 Ralph Flow 工作流"}。请调用 \`ralphflow_create\` 工具获取完整设计指引，然后按指引与用户交互：一轮问清流程阶段与审查门位置（用户没说清楚才问）→ 呈现步骤图 → 写 YAML 到 \`ralph-flow/workflows/\` → 调用 \`ralphflow_doctor\` 校验到「可启动」且无警告 → 交接运行方式。`,
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
        text: "用户执行了 /ralphflow-reset（重做当前步，涉及上下文管理，本版本暂缓实现）。**不要调用任何工具**，用自然语言说明：该命令本版本未实现、暂缓原因（涉及上下文管理），以及当前可用命令：`/ralphflow-start`、`/ralphflow-list`、`/ralphflow-status`、`/ralphflow-continue`、`/ralphflow-cancel`、`/ralphflow-create`、`/ralphflow-doctor`；如用户确实想重做，可建议重新交卷触发自动返工，或取消后重启。",
      }),
    },
    {
      name: "ralphflow-rewind",
      description: "（本版本未实现）回退到上游步骤。",
      shim: () => ({
        kind: "directive",
        text: "用户执行了 /ralphflow-rewind（回退到上游步骤，涉及上下文管理，本版本暂缓实现）。**不要调用任何工具**，用自然语言说明：该命令本版本未实现、暂缓原因（涉及上下文管理），以及当前可用命令：`/ralphflow-start`、`/ralphflow-list`、`/ralphflow-status`、`/ralphflow-continue`、`/ralphflow-cancel`、`/ralphflow-create`、`/ralphflow-doctor`。",
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

  // ─── 动态工作流快捷命令（/loop、/spec、自定义名）——与 opencode/claude 语义一致 ──
  const taken = new Set<string>(defs.map((d) => d.name));
  try {
    for (const wf of engine.listWorkflows()) {
      if (wf.invalid) continue;
      const slug = String(wf.name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      if (!slug || taken.has(slug)) continue;
      taken.add(slug);
      const desc = wf.desc || `启动 ${wf.name} 工作流`;
      try {
        commands.register({
          name: slug,
          description: `(ralphflow) ${desc} · 示例：/${slug} <任务描述>`,
          input: { hint: "<任务描述>" },
          handler: async (inv: { rawInput: string; agent: Agent; signal: AbortSignal }) => {
            try {
              const task = inv.rawInput.trim();
              const sid = messageSessionId(inv.agent);
              if (!task) {
                // 缺任务也交回 AI：先说明用法再等任务
                if (sid) {
                  deps.deliver(sid, `[ralphflow] 用户执行了 /${slug}（\`${wf.name}\` 工作流）但没有附带任务描述。**不要调用任何工具**，先用自然语言说明用法：\`/${slug} <任务描述>\`，并请用户补上要完成的任务。`);
                }
                return { kind: "success" };
              }
              if (sid) {
                deps.deliver(sid, `[ralphflow] 用户通过 /${slug} 启动了 \`${wf.name}\` 工作流。请调用 \`ralphflow_start\` 工具：workflow = \`${wf.name}\`，task = \`${task}\`。若工具报错，如实转达；若成功，按它返回的指示执行并遵循下面的机制。\n\n${SHARED_MECHANISM}`);
              }
              return { kind: "success" };
            } catch (err) {
              return { kind: "error", text: err instanceof Error ? err.message : String(err) };
            }
          },
        });
      } catch {
        // 与其它插件撞名：静默跳过，与 opencode 版"绝不覆盖"语义一致
      }
    }
  } catch (err) {
    ctx.logger?.warn?.("[ralphflow] workflow shortcut registration skipped:", err);
  }
}

function messageSessionId(agent: Agent | undefined): string {
  return (agent as { session?: { id?: string } } | undefined)?.session?.id ?? "";
}