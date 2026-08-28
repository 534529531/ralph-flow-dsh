/**
 * Ralph Flow for dsh — slash 命令（/ralphflow-*，与 opencode 命名一致）
 *
 * 命令通过 ctx.commands 注册；处理逻辑直接复用 tools.ts 中的工具实现。
 * 为复用工具逻辑，这里通过调用已注册的 tool 定义来执行，避免双份实现。
 *
 * 与 opencode 的关键架构差异及对齐手段：opencode 的 slash 命令是 prompt 模板
 * （$ARGUMENTS 注入后整段发给当前会话模型），命令执行天然驱动模型开工；dsh 的
 * 命令系统是 handler 型且 Log-only（command/run 永不进入模型上下文，返回文本只
 * 渲染给用户）。若不补一步注入，/ralphflow-start 之后 DO 阶段无人执行——工作流
 * 卡死在第一步。这里对会产生「轮到模型」结果的命令（start/continue/rewind/reset）
 * 用 agent.followup 把指令排队进当前会话并唤醒驱动（官方先例：dsh-cordis-host-
 * runner / dsh-subagent 均以 createUserMessage + inbox 投递驱动会话），对齐
 * opencode 版「start 后当前会话立即执行工作流」的行为。
 *
 * 反馈通道（重要架构约束）：不再向会话 log 追加任何自定义事件帧——宿主持久化
 * 读路径（assertEventsSupported）只认识 KNOWN_SESSION_EVENT_TYPES，插件自定义
 * 类型落盘后整个会话会被 SessionFormatUnsupportedError 拒绝加载（会话变砖，无
 * ignorable 逃生门）。宿主对每条命令本身就会追加官方已知类型 command/run +
 * command/done（dsh-commands 的 execute 生命周期），client 端折叠这两个官方
 * 事件渲染命令结果卡，零持久化风险。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Engine } from "./engine.js";
import type { RalphJobManager } from "./jobs.js";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createUserGuideSummary } from "./create.js";

export interface CommandContext {
  ctx: Context;
  engine: Engine;
  jobs: RalphJobManager;
  getAgent: (sessionId: string) => Agent | undefined;
  /** 已注册工具的执行器：name → (args, agent) => string | Promise<string> */
  runTool: (name: string, args: Record<string, unknown>, agent: Agent | undefined) => Promise<string> | string;
}

const COMMAND_DEFS: { name: string; description: string; sample: string; tool: string; input?: string; map: (raw: string) => Record<string, unknown> }[] = [
  {
    name: "ralphflow-start",
    description: "启动工作流（工作流名 + 任务描述）",
    sample: "/ralphflow-start loop 实现用户认证",
    tool: "ralphflow_start",
    input: "<工作流名> <任务描述>",
    map: (raw) => {
      const [workflow, ...rest] = raw.trim().split(/\s+/);
      return { workflow, task: rest.join(" ") || undefined };
    },
  },
  {
    name: "ralphflow-continue",
    description: "批准手动审查 / 恢复暂停 / 接管实例",
    sample: "/ralphflow-continue [instance]",
    tool: "ralphflow_continue",
    input: "[instance]",
    map: (raw) => { const t = raw.trim(); return t ? { instance: t } : {}; },
  },
  {
    name: "ralphflow-status",
    description: "查看进度",
    sample: "/ralphflow-status [instance]",
    tool: "ralphflow_status",
    input: "[instance]",
    map: (raw) => { const t = raw.trim(); return t ? { instance: t } : {}; },
  },
  {
    name: "ralphflow-list",
    description: "列出工作流与活跃实例",
    sample: "/ralphflow-list",
    tool: "ralphflow_list",
    map: () => ({}),
  },
  {
    name: "ralphflow-cancel",
    description: "取消实例并归档报告",
    sample: "/ralphflow-cancel [instance]",
    tool: "ralphflow_cancel",
    input: "[instance]",
    map: (raw) => { const t = raw.trim(); return t ? { instance: t } : {}; },
  },
  {
    name: "ralphflow-rewind",
    description: "回退到已通过 CHECK 的上游步骤重做",
    sample: "/ralphflow-rewind <step> <reason> [instance]",
    tool: "ralphflow_rewind",
    input: "<step> <reason> [instance]",
    map: (raw) => {
      const parts = raw.trim().split(/\s+/);
      const step = parts[0];
      const reason = parts.slice(1).join(" ");
      return { step, reason };
    },
  },
  {
    name: "ralphflow-reset",
    description: "重置当前步上下文（当前会话内重新注入干净的 DO 提示重做当前步）",
    sample: "/ralphflow-reset [原因]",
    tool: "ralphflow_reset",
    input: "[reason]",
    map: (raw) => { const t = raw.trim(); return t ? { reason: t } : {}; },
  },
  {
    name: "ralphflow-doctor",
    description: "诊断工作流定义与实例状态",
    sample: "/ralphflow-doctor",
    tool: "ralphflow_doctor",
    map: () => ({}),
  },
  {
    name: "ralphflow-unbrick",
    description: "会话解砖（移除会话日志中的插件自定义事件帧，改前自动备份）",
    sample: "/ralphflow-unbrick",
    tool: "ralphflow_unbrick",
    map: () => ({}),
  },
];

const CREATE_COMMAND = {
  name: "ralphflow-create",
  description: "创建自定义工作流（给出如何让模型引导你设计的说明）· 示例：/ralphflow-create 每天代码评审流程",
  input: { hint: "[想法描述]" },
};

/**
 * 返回文本可能携带「轮到模型执行」指令的命令：start 产出首个 DO 提示，
 * continue 批准门/恢复暂停/接管后产出下一步指引，reset/rewind 重注入 DO。
 * 查询类（status/list/cancel/doctor/create）只产生给人看的信息，不注入——
 * 免得模型为一行查询结果空转一轮。
 */
const MODEL_FACING_COMMANDS = new Set(["ralphflow-start", "ralphflow-continue", "ralphflow-reset", "ralphflow-rewind"]);

/**
 * 把工具结果作为插件消息投递进当前会话并唤醒模型驱动。失败绝不影响命令
 * 本身：结果卡已渲染给用户，注入失败时用户仍可手动让模型继续。
 */
/** HTTP 动作端点（index.ts 审批/恢复/打回按钮直达通道）复用的同一注入桥 */
export function deliverToModel(agent: Agent | undefined, command: string, text: string, logWarn?: (msg: string, err: unknown) => void): void {
  if (!agent || typeof (agent as { followup?: unknown }).followup !== "function") return;
  try {
    agent.followup(createUserMessage({
      content: [{
        type: "text",
        text: `[ralphflow] 用户刚通过 /${command} 触发了工作流操作，以下是执行结果与给你的后续指令。请遵循其中的指示行动；若它包含当前步骤的任务提示，现在就开始执行，完成实际工作后在回复最后一行单独输出 <promise>done</promise>。若它只是状态告知（如「验证进行中」），简短确认即可，不要输出 done 标记。\n\n---\n\n${text}`,
      }],
      source: { kind: "plugin", plugin: "ralphflow" },
    }));
  } catch (err) {
    logWarn?.("[ralphflow] followup inject failed:", err);
  }
}

/**
 * 命令结果的可视反馈由宿主自动追加的 command/run + command/done 官方事件承载
 * （client 折叠器渲染为对话内嵌卡），这里不再需要任何自定义帧写入。
 */

/** 命令路径的空参校验（面向用户的用法提示；工具路径由工具自己校验） */
const COMMAND_USAGE: Record<string, (raw: string) => string | null> = {
  "ralphflow-start": (raw) => {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return `用法：/ralphflow-start <工作流名> <任务描述>\n\n示例：/ralphflow-start loop 用 JWT 实现用户认证模块\n\n用 /ralphflow-list 查看可用工作流。`;
    }
    return null;
  },
  "ralphflow-rewind": (raw) => {
    const parts = raw.trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return `用法：/ralphflow-rewind <步骤> <原因> [实例]\n\n示例：/ralphflow-rewind propose API 假设错了，改用 REST 轮询\n\n用 /ralphflow-status 查看可回退的步骤。`;
    }
    return null;
  },
};

export function registerCommands(deps: CommandContext): void {
  const commands = deps.ctx.commands as unknown as {
    register(def: {
      name: string;
      description: string;
      input?: { hint: string };
      handler: (invocation: { rawInput: string; agent: Agent; signal: AbortSignal }) => Promise<{ kind: "success"; text?: string } | { kind: "error"; text: string }> | { kind: "success"; text?: string } | { kind: "error"; text: string };
    }): void;
  };

  for (const def of COMMAND_DEFS) {
    commands.register({
      name: def.name,
      description: `${def.description}（ralphflow）· 示例：${def.sample}`,
      ...(def.input ? { input: { hint: def.input } } : {}),
      handler: async (invocation: { rawInput: string; agent: Agent; signal: AbortSignal }) => {
        const agent: Agent | undefined = invocation.agent;
        try {
          const usageError = COMMAND_USAGE[def.name]?.(invocation.rawInput);
          if (usageError) {
            return { kind: "error", text: usageError };
          }
          const args = def.map(invocation.rawInput);
          const text = await deps.runTool(def.tool, args, agent);
          if (MODEL_FACING_COMMANDS.has(def.name)) {
            deliverToModel(agent, def.name.replace(/^ralphflow-/, ""), text, (m, e) => deps.ctx.logger?.warn?.(m, e));
          }
          return { kind: "success", text };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { kind: "error", text: msg };
        }
      },
    });
  }

  // ─── /ralphflow-create：用户侧创建入口（指引卡；设计过程由模型侧工具承载）──
  try {
    commands.register({
      name: CREATE_COMMAND.name,
      description: CREATE_COMMAND.description,
      input: CREATE_COMMAND.input,
      handler: async (invocation: { rawInput: string; agent: Agent; signal: AbortSignal }) => {
        const agent: Agent | undefined = invocation.agent;
        const text = createUserGuideSummary(invocation.rawInput ?? "");
        return { kind: "success", text };
      },
    });
  } catch (err) {
    deps.ctx.logger?.warn?.("[ralphflow] create command registration skipped:", err);
  }

  // ─── 动态工作流快捷命令（/loop、/spec……）────────────────────────────────────
  // 每个可启动的工作流各得到一个快捷 slash 命令（同 opencode 版语义），
  // 省去 list → start 的两步旅程。冲突策略：绝不覆盖——静态管理命令先注册，
  // 撞名/规范化后重名的工作流静默跳过，仍可用 /ralphflow-start <name> 启动。
  // 定义无效（invalid）的工作流不注册：启动必然失败，留给 /ralphflow-doctor 暴露。
  const taken = new Set<string>(COMMAND_DEFS.map((d) => d.name));
  try {
    for (const wf of deps.engine.listWorkflows()) {
      if (wf.invalid) continue;
      const slug = String(wf.name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      if (!slug || taken.has(slug)) continue;
      taken.add(slug);
      const desc = wf.desc || `启动 ${wf.name} 工作流`;
      commands.register({
        name: slug,
        description: `(ralphflow) ${desc} · 示例：/${slug} <任务描述>`,
        input: { hint: "<任务描述>" },
        handler: async (invocation: { rawInput: string; agent: Agent; signal: AbortSignal }) => {
          const agent: Agent | undefined = invocation.agent;
          try {
            const task = invocation.rawInput.trim();
            if (!task) {
              const usage = `请给出任务描述：/${slug} <任务描述>`;
              return { kind: "error", text: usage };
            }
            const text = await deps.runTool("ralphflow_start", { workflow: wf.name, task }, agent);
            deliverToModel(agent, slug, text, (m, e) => deps.ctx.logger?.warn?.(m, e));
            return { kind: "success", text };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { kind: "error", text: msg };
          }
        },
      });
    }
  } catch (err) {
    // 同名命令已被注册（用户/其他插件）：静默跳过，符合 opencode 版"绝不覆盖"语义
    deps.ctx.logger?.warn?.("[ralphflow] workflow shortcut registration skipped:", err);
  }
}