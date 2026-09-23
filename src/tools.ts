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

  const unimplHandler: ToolHandler = () => "本版本未实现（涉及上下文管理，暂缓）。已可用：`/ralphflow-start`、`/ralphflow-list`、`/ralphflow-status`、`/ralphflow-continue`、`/ralphflow-cancel`、`/ralphflow-create`、`/ralphflow-doctor`。";

  const toolDefs: Array<{ name: string; description: string; params: Record<string, any>; handler: ToolHandler }> = [
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
    // 声明不实现：reset/rewind 涉及上下文管理，本版本暂缓（返回明确解释）
    ...["reset", "rewind"].map((n) => ({
      name: `ralphflow_${n}`,
      description: `（本版本未实现，仅为命令面占位）与 opencode/claude 版同名的 ralphflow_${n} 工具。`,
      params: {},
      handler: unimplHandler,
    })),
  ];

  for (const def of toolDefs) {
    handlers.set(def.name, def.handler);
    tools.register(defineTool({
      name: def.name,
      description: def.description,
      parameters: def.params,
      output: { schema: { type: "string" }, render: (_args: unknown, value: string) => [{ type: "text", text: value }] },
      async execute(args: unknown, exec: { agent?: Agent }) {
        return def.handler(args ?? {}, exec?.agent);
      },
    }));
  }
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
          return { kind: "card", text: "用法：`/ralphflow-start <工作流> <任务描述>`\n\n示例：`/ralphflow-start loop 修复登录模块的空指针`" };
        }
        const workflow = parts[0]!;
        const task = parts.slice(1).join(" ");
        return {
          kind: "directive",
          text: `用户通过 /ralphflow-start 启动了 ralphflow 工作流。请调用 \`ralphflow_start\` 工具：workflow = \`${workflow}\`，task = \`${task}\`。\n\n工具返回后严格按其中的指示行动（工具文本里已包含本步任务与交卷协议）；若工具报错，如实向用户转达错误和用法。`,
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
          text: `用户执行了 /ralphflow-continue，要推进当前工作流（放行审查门 / 解除暂停 / 接管实例）。请调用 \`ralphflow_continue\` 工具${instance}。\n\n按工具返回结果行动：已推进就简短确认下一步；被拒绝（判定未通过/未交卷）就如实转达原因。`,
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
          text: `用户执行了 /ralphflow-status，想了解工作流进度。请调用 \`ralphflow_status\` 工具${instance}，然后向用户清晰说明当前实例的状态（进行到哪一步、有无判定、是否暂停等）。`,
        };
      },
    },
    {
      name: "ralphflow-list",
      description: "列出全部实例与可用工作流。示例：/ralphflow-list",
      shim: () => ({
        kind: "directive",
        text: "用户执行了 /ralphflow-list。请调用 `ralphflow_list` 工具获取数据，然后把「可用工作流」整理成**表格**（列：工作流 | 用途描述），把「工作流实例」按工具返回的字段简要列给用户（实例 id、工作流、任务、步骤、状态、属主）。数据以工具返回为准，不要编造；没有实例就直说。",
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
          text: `用户执行了 /ralphflow-cancel，要取消当前工作流实例${instance}${reason}。请调用 \`ralphflow_cancel\` 工具，然后向用户确认已取消（或转达错误）。`,
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
      shim: () => ({ kind: "card", text: "本版本未实现（涉及上下文管理，暂缓）。已可用：`/ralphflow-start`、`/ralphflow-list`、`/ralphflow-status`、`/ralphflow-continue`、`/ralphflow-cancel`、`/ralphflow-create`、`/ralphflow-doctor`。" }),
    },
    {
      name: "ralphflow-rewind",
      description: "（本版本未实现）回退到上游步骤。",
      shim: () => ({ kind: "card", text: "本版本未实现（涉及上下文管理，暂缓）。已可用：`/ralphflow-start`、`/ralphflow-list`、`/ralphflow-status`、`/ralphflow-continue`、`/ralphflow-cancel`、`/ralphflow-create`、`/ralphflow-doctor`。" }),
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
              if (sid) deps.deliver(sid, `[ralphflow] ${out.text}`);
              // 回复留给模型，这里不渲染命令卡文本（claude/opencode 语义）
              return { kind: "success" };
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
              if (!task) {
                return { kind: "error", text: `用法：/${slug} <任务描述>\n\n示例：/${slug} 修复登录模块的空指针` };
              }
              const sid = messageSessionId(inv.agent);
              if (sid) {
                deps.deliver(sid, `[ralphflow] 用户通过 /${slug} 启动了 \`${wf.name}\` 工作流。请调用 \`ralphflow_start\` 工具：workflow = \`${wf.name}\`，task = \`${task}\`。按工具返回结果行动（含 DO 任务与交卷协议）；若报错，如实转达。`);
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