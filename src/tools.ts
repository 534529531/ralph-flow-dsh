/**
 * Ralph Flow for dsh v2 — 工具 + 命令（命名与 opencode/claude 版一致）
 *
 * v0 命令面：start / list / status / continue / cancel 五个实现；
 * create / doctor / reset / rewind 只注册声明（返回"本版本未实现"），保持迁移无落差。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Engine } from "./engine.js";

export interface ToolContext {
  ctx: Context;
  engine: Engine;
  deliver: (sessionId: string, text: string) => boolean;
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
    return engine.start(String(args?.workflow ?? ""), String(args?.task ?? ""), sessionId).text;
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

  const unimplHandler: ToolHandler = (_, __) => "本版本（v0）尚未实现该命令。已实现：`/ralphflow-start`、`/ralphflow-list`、`/ralphflow-status`、`/ralphflow-continue`、`/ralphflow-cancel`。";

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
    // 声明不实现：与其它版本同名，防止迁移落差（返回明确解释）
    ...["create", "doctor", "reset", "rewind"].map((n) => ({
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
        text: "用户执行了 /ralphflow-list。请调用 `ralphflow_list` 工具，然后用一句话向用户概述有哪些实例（含状态）和可用工作流。工具返回空则说明还没有任何实例。",
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
      description: "（本版本未实现）交互式创建自定义工作流。",
      shim: () => ({ kind: "card", text: "本版本（v0）尚未实现该命令。已实现：`/ralphflow-start`、`/ralphflow-list`、`/ralphflow-status`、`/ralphflow-continue`、`/ralphflow-cancel`。" }),
    },
    {
      name: "ralphflow-doctor",
      description: "（本版本未实现）诊断工作流/实例/状态。",
      shim: () => ({ kind: "card", text: "本版本（v0）尚未实现该命令。已实现：`/ralphflow-start`、`/ralphflow-list`、`/ralphflow-status`、`/ralphflow-continue`、`/ralphflow-cancel`。" }),
    },
    {
      name: "ralphflow-reset",
      description: "（本版本未实现）重做当前步。",
      shim: () => ({ kind: "card", text: "本版本（v0）尚未实现该命令。已实现：`/ralphflow-start`、`/ralphflow-list`、`/ralphflow-status`、`/ralphflow-continue`、`/ralphflow-cancel`。" }),
    },
    {
      name: "ralphflow-rewind",
      description: "（本版本未实现）回退到上游步骤。",
      shim: () => ({ kind: "card", text: "本版本（v0）尚未实现该命令。已实现：`/ralphflow-start`、`/ralphflow-list`、`/ralphflow-status`、`/ralphflow-continue`、`/ralphflow-cancel`。" }),
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
}

function messageSessionId(agent: Agent | undefined): string {
  return (agent as { session?: { id?: string } } | undefined)?.session?.id ?? "";
}