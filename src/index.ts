/**
 * Ralph Flow for dsh v2 — 插件入口
 *
 * 装配：引擎（native Service） + ralph-check 验证者委派（T1） + 工具/命令 + 会话事件监听。
 * 无客户端、无 HTTP、无 jobs——v0 是对话内完整闭环。
 */
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { createEngine } from "./engine.js";
import { runVerifier } from "./verify.js";
import { registerTools, registerCommands } from "./tools.js";

export const name = "ralphflow";
export const inject = ["tools", "commands", "subagents", "agents", "sessions"];

/** 工作区根：RALPHFLOW_WORKSPACE 环境变量 > 首个会话 cwd > 进程 cwd */
function resolveWorkspace(ctx: Context): string {
  const env = process.env.RALPHFLOW_WORKSPACE;
  if (env && env.trim()) return env.trim();
  try {
    const sessions = ctx.sessions as unknown as { list(): { header?: { cwd?: string } }[] } | undefined;
    for (const s of sessions?.list() ?? []) {
      if (s.header?.cwd) return s.header.cwd;
    }
  } catch {}
  return process.cwd();
}

function lastAssistantText(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const msg = (data as { message?: unknown }).message;
  if (!msg || typeof msg !== "object") return undefined;
  const m = msg as { text?: unknown; content?: unknown };
  if (typeof m.text === "string") return m.text;
  if (Array.isArray(m.content)) {
    const parts = m.content
      .map((c) => (c && typeof c === "object" && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : ""))
      .filter(Boolean);
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
}

export function apply(ctx: Context): void {
  const workspace = resolveWorkspace(ctx);
  const log = (level: "info" | "warn" | "error", event: string, data?: unknown) => {
    try {
      const l = ctx.logger as unknown as { info?: (...a: unknown[]) => void; warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void } | undefined;
      l?.[level]?.(`[ralphflow] ${event}`, data ?? "");
    } catch {}
  };

  const agentOf = (sessionId: string) => {
    try { return (ctx.agents as unknown as { get(id: string): unknown }).get(sessionId) as unknown; } catch { return undefined; }
  };

  const deliver = (sessionId: string, text: string): boolean => {
    try {
      const agent = agentOf(sessionId) as { steer?: (m: unknown) => unknown; followup?: (m: unknown) => unknown } | undefined;
      if (!agent) return false;
      const msg = createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "plugin", plugin: "ralphflow" },
      });
      // steer：提交给最近一步，空闲驱动器会开新一轮（0.1.x 官方机制）；
      // followup：旧版本兼容兜底。
      if (typeof agent.steer === "function") { agent.steer(msg); return true; }
      if (typeof agent.followup === "function") { agent.followup(msg); return true; }
      return false;
    } catch (e) {
      log("warn", "deliver_failed", { sessionId, error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  };

  const engine = createEngine(workspace, {
    deliver,
    verify: (req) => runVerifier({ ctx }, req),
    log,
  });

  try { engine.ensureLayout(); } catch (e) { log("warn", "ensure_layout_failed", { error: String(e) }); }

  // 全局会话事件流 → 引擎（只观测交卷事实；判定永远不会从这里产生）
  try {
    const on = (ctx as unknown as { on?: (name: string, listener: (...args: unknown[]) => void) => (() => void) | void }).on;
    if (typeof on === "function") {
      on("session/event", (s?: unknown, e?: unknown) => {
        const sid = (s as { id?: string } | undefined)?.id;
        if (!sid || !e || typeof e !== "object") return;
        const ev = e as { type?: unknown; data?: unknown };
        if (ev.type !== "assistant/message") return;
        const text = lastAssistantText(ev.data);
        if (text) engine.onAssistantMessage(sid, text);
      });
    } else {
      log("warn", "session_event_listener_unavailable", {});
    }
  } catch (e) {
    log("warn", "session_event_listener_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  const handlers = registerTools({ ctx, engine, deliver });
  registerCommands({ ctx, engine, deliver, handlers });

  // 崩溃/重载恢复：孤儿委派 fail-safe（暂停等用户，不隐式继续）
  try { engine.restore(); } catch (e) { log("warn", "restore_failed", { error: String(e) }); }

  log("info", "plugin_loaded", { workspace, version: "0.1.0" });
}