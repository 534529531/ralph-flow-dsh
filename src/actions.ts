/**
 * Ralph Flow for dsh — 抽屉动作分发（POST 动作端点的心智，独立可单测）
 *
 * 页头抽屉的「通过 / 继续 / 打回 / 取消」按钮 → POST /ralphflow/instances →
 * 本模块按白名单动作执行对应工具并（需要时）followup 注入模型。与 index.ts
 * 的 HTTP 壳解耦：纯逻辑可用 e2e 单测覆盖（工具执行/超时/注入/日志四件事）。
 *
 * 语义：
 *  - approve：人工门/check_error/archive_failed 恢复——验证由后台 subagent 跑，
 *    模型无需介入，fire 后台推进（不阻塞 HTTP 响应）；
 *  - resume：暂停恢复——DO 提示需要模型接管，await 后 followup；
 *  - return：打回——意见必填，reset 带意见后 followup；
 *  - cancel：取消实例（先归档）——快路径，await 返回结果文本。
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { Engine } from "./engine.js";
import type { ToolHandlers } from "./tools.js";

export interface ActionRequest {
  action: string;
  sessionId?: string;
  runId?: string;
  reason?: string;
}

export interface ActionDeps {
  engine: Engine;
  handlers: ToolHandlers;
  getAgent: (sessionId: string) => Agent | undefined;
  deliverToModel: (agent: Agent | undefined, command: string, text: string, warn?: (m: string, e: unknown) => void) => void;
  warn?: (m: string, e: unknown) => void;
}

export interface ActionResult {
  ok: boolean;
  text: string;
  /** approve 的后台推进（调用方 void 掉并追加 catch，不阻塞响应） */
  fire?: Promise<string>;
}

export async function dispatchAction(deps: ActionDeps, req: ActionRequest): Promise<ActionResult> {
  const action = String(req?.action ?? "");
  const sessionId = String(req?.sessionId ?? "");
  const runId = typeof req?.runId === "string" && req.runId ? String(req.runId) : undefined;
  const reason = typeof req?.reason === "string" && req.reason.trim()
    ? String(req.reason).trim().slice(0, 4000)
    : undefined;
  const agent = sessionId ? deps.getAgent(sessionId) : undefined;
  if (!agent) return { ok: false, text: "会话 agent 不可用（sessionId 无效或会话已结束）。" };

  const run = (name: string, args: Record<string, unknown>): Promise<string> => {
    const h = deps.handlers.get(name);
    if (!h) return Promise.resolve(`工具 ${name} 未注册。`);
    return Promise.resolve(h(args, agent));
  };
  const withTimeout = (p: Promise<string>, ms: number): Promise<string> =>
    Promise.race([
      p,
      new Promise<string>((_, rej) => {
        const t = setTimeout(() => rej(new Error("处理超时（可能因实例互斥锁排队），请稍后查看状态。")), ms);
        void t.unref?.();
      }),
    ]);

  switch (action) {
    case "approve": {
      deps.engine.logEvent("", "info", "action_approve", { runId, sessionId });
      const fire = run("ralphflow_continue", runId ? { instance: runId } : {}).catch((e) => {
        deps.engine.logEvent("", "error", "action_approve_failed", { runId, error: e instanceof Error ? e.message : String(e) });
        return "";
      });
      return { ok: true, text: "已提交审批：验证即将在后台运行，进度在页头任务列表实时更新。", fire };
    }
    case "resume": {
      deps.engine.logEvent("", "info", "action_resume", { runId, sessionId });
      const text = await withTimeout(run("ralphflow_continue", runId ? { instance: runId } : {}), 10_000).catch((e) => String(e?.message ?? e));
      deps.deliverToModel(agent, "continue", text, deps.warn);
      return { ok: true, text: "已恢复并让模型继续执行。" };
    }
    case "return": {
      if (!reason) return { ok: false, text: "打回需要填写修改意见。" };
      deps.engine.logEvent("", "info", "action_return", { runId, sessionId });
      const text = await withTimeout(run("ralphflow_reset", { ...(runId ? { instance: runId } : {}), reason }), 10_000).catch((e) => String(e?.message ?? e));
      deps.deliverToModel(agent, "reset", text, deps.warn);
      return { ok: true, text: "已打回并让模型按意见返工。" };
    }
    case "cancel": {
      deps.engine.logEvent("", "info", "action_cancel", { runId, sessionId });
      const text = await withTimeout(run("ralphflow_cancel", runId ? { instance: runId } : {}), 10_000).catch((e) => String(e?.message ?? e));
      return { ok: true, text };
    }
    default:
      return { ok: false, text: `未知动作：${action}` };
  }
}