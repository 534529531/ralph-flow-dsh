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

/** 工作区根：RALPHFLOW_WORKSPACE 环境变量 > 进程 cwd（实例按会话工作区放置，见 workspaceOfSession） */
function resolveWorkspace(ctx: Context): string {
  const env = process.env.RALPHFLOW_WORKSPACE;
  if (env && env.trim()) return env.trim();
  return process.cwd();
}

/** 发起会话的工作区（实例资产沉淀的位置）；查不到回落到全局根 */
function workspaceOfSession(ctx: Context, sessionId: string, fallback: string): string {
  try {
    const sessions = ctx.sessions as unknown as { get(id: string): { header?: { cwd?: string } } | undefined };
    const cwd = sessions.get(sessionId)?.header?.cwd;
    if (cwd && cwd.trim()) return cwd;
  } catch {}
  return resolveWorkspace(ctx) || fallback;
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

  /** 同一段文本的重复投递护栏：命令被连按/重试时只处理一次（窗口内去重） */
  const recentDeliveries = new Map<string, number>();
  const DEDUPE_WINDOW_MS = 5000;

  const deliver = (sessionId: string, text: string): boolean => {
    try {
      const agent = agentOf(sessionId) as { steer?: (m: unknown) => unknown; followup?: (m: unknown) => unknown } | undefined;
      if (!agent) return false;
      // 去重：同会话 + 同文本，5 秒内只投一次（避免用户连按命令造成指令堆叠）
      const key = `${sessionId}:${text.length}:${text.slice(0, 120)}`;
      const now = Date.now();
      const last = recentDeliveries.get(key);
      if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return true;
      recentDeliveries.set(key, now);
      if (recentDeliveries.size > 200) {
        for (const [k, ts] of recentDeliveries) {
          if (now - ts > DEDUPE_WINDOW_MS) recentDeliveries.delete(k);
        }
      }
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
  // recentlyOwned：会话 → 最近一次"拥有活跃实例"的时刻（交卷丢失告警用）
  const recentlyOwned = new Map<string, number>();
  try {
    const on = (ctx as unknown as { on?: (name: string, listener: (...args: unknown[]) => void) => (() => void) | void }).on;
    if (typeof on === "function") {
      on("session/event", (s?: unknown, e?: unknown) => {
        const sid = (s as { id?: string } | undefined)?.id;
        if (!sid || !e || typeof e !== "object") return;
        const ev = e as { type?: unknown; data?: unknown };
        if (ev.type !== "assistant/message") return;
        const text = lastAssistantText(ev.data);
        if (!text) return;

        // 「曾拥有实例」记录：只要该会话在实例存活期间产生过助手消息就记一笔。
        // 用于交卷丢失告警（缺陷 A）：实例状态被外部删除时，交卷不能静默消失。
        const owned = engine.activeInstanceOfSession(sid);
        if (owned) recentlyOwned.set(sid, Date.now());

        if (!owned && /<promise>\s*done\s*<\/promise>/i.test(text)) {
          const seen = recentlyOwned.get(sid);
          const OWNED_TTL_MS = 24 * 3600 * 1000;
          if (seen !== undefined && Date.now() - seen < OWNED_TTL_MS) {
            recentlyOwned.delete(sid); // 只告警一次，避免刷屏
            log("warn", "submit_without_instance", { sessionId: sid });
            deliver(sid, "[ralphflow] ⚠️ 检测到交卷标记 `<promise>done</promise>`，但本会话当前**没有活跃工作流实例**，这次交卷没有被处理。\n\n常见原因：实例状态文件被删除 / 工作区被清理 / 实例已取消。\n\n请用 `/ralphflow-list` 查看现有实例；必要时重新 `/ralphflow-start <工作流> <任务>` 启动。若你正在复现或调试，请改用临时工作区，不要删真实工作区的 `ralph-flow/`。");
            return;
          }
        }

        engine.onAssistantMessage(sid, text);
      });
    } else {
      log("warn", "session_event_listener_unavailable", {});
    }
  } catch (e) {
    log("warn", "session_event_listener_failed", { error: e instanceof Error ? e.message : String(e) });
  }

  const handlers = registerTools({ ctx, engine, deliver, workspaceOfSession: (sid) => workspaceOfSession(ctx, sid, workspace) });
  registerCommands({ ctx, engine, deliver, handlers });

  // 崩溃/重载恢复：孤儿委派 fail-safe（暂停等用户，不隐式继续）
  try { engine.restore(); } catch (e) { log("warn", "restore_failed", { error: String(e) }); }

  log("info", "plugin_loaded", { workspace, version: "0.1.0" });
}