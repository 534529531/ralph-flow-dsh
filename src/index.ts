/**
 * Ralph Flow for dsh — HOST 端入口（引擎适配 + jobs + 命令 + 工具 + 事件发射）
 *
 * 插件名 ralphflow，slash 命令与工具命名与 opencode 版完全一致。状态机逻辑
 * 复用移植自 ralph-flow 的 engine.ts（只改实例根目录：`<workspace>/ralph-flow/`），
 * 驱动外壳换为 dsh 的 jobs + session 事件流。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { createEngine } from "./engine.js";
import { createJobManager } from "./jobs.js";
import { registerTools, type ToolHandlers } from "./tools.js";
import { registerCommands, deliverToModel } from "./commands.js";
import { dispatchAction } from "./actions.js";
import { abortInstanceChecks } from "./check.js";

export const name = "ralphflow";
export const inject = ["tools", "jobs", "commands", "sessions", "subagents", "agents"];

/** 解析引擎工作区根：RALPHFLOW_WORKSPACE 环境变量 > 首个会话 cwd > 进程 cwd */
function resolveWorkspace(ctx: Context): string {
  const env = process.env.RALPHFLOW_WORKSPACE;
  if (env && env.trim()) return env.trim();
  try {
    const sessions = ctx.sessions as { list(): { header?: { cwd?: string } }[] } | undefined;
    if (sessions) {
      for (const s of sessions.list()) {
        if (s.header?.cwd) return s.header.cwd;
      }
    }
  } catch {}
  return process.cwd();
}

export function apply(ctx: Context): void {
  const workspace = resolveWorkspace(ctx);
  // platform seam 接线：destroyInstance（取消/完成）时真正中止该实例所有
  // 在飞的验证者子代理，不再白烧 token 到超时。
  const engine = createEngine(workspace, {
    abortActiveCheck: (instId: string) => abortInstanceChecks(instId),
  });

  // 启动初始化：项目/全局工作流目录就绪 + 旧版单工作流布局迁移到 instances/
  try { engine.ensureProjectWorkflows(); } catch {}
  try { engine.migrateLegacyInstance(); } catch {}

  const sessions = ctx.sessions as {
    get(id: string): { id: string } | undefined;
  } | undefined;

  const getAgent = (sessionId: string): Agent | undefined => {
    try {
      const session = sessions?.get(sessionId);
      if (!session) {
        // 影子恢复常见：实例属主会话来自旧进程/其它 profile，早已不存在。
        // 属正常降级（job 无 owner 仍可守护），记 info 不刷 warn。
        try { engine.logEvent("", "info", "get_agent_missing_session", { sessionId }); } catch {}
        return undefined;
      }
      const agents = ctx.agents as { get(id: string): Agent | undefined } | undefined;
      const a = agents?.get(sessionId);
      if (!a) {
        try { engine.logEvent("", "warn", "get_agent_missing_agent", { sessionId }); } catch {}
      }
      return a;
    } catch (e) {
      try { engine.logEvent("", "warn", "get_agent_error", { sessionId, error: e instanceof Error ? e.message : String(e) }); } catch {}
      return undefined;
    }
  };

  const jobs = createJobManager({ ctx, engine, getAgent });

  const handlers: ToolHandlers = registerTools({ ctx, engine, jobs, getAgent });

  registerCommands({
    ctx, engine, jobs, getAgent,
    runTool: (name, args, agent) => {
      const handler = handlers.get(name);
      if (!handler) return `工具 ${name} 未注册。`;
      return handler(args, agent);
    },
  });

  // 影子 registry：进程重启后为 active 实例重建 job
  jobs.restore();

  // HTTP 状态通道 + 动作端点：GET 轮询读全局实例富状态与工作流清单，
  // POST 承接抽屉按钮的动作（审批/恢复/打回）——替代「往输入框填命令 + 合成
  // Enter」的脆弱 hacks，是 dsh webServer 路由面上的原生交互通道。同源
  // loopback，浏览器 fetch 直读。注册面见 @deepseek-ai/dsh-host-webserver。
  try {
    // 服务名是 webServer（驼峰，见 @deepseek-ai/dsh-host-webserver 的 Service 注册）。
    // cordis 要求 inject 声明才能 ctx.webServer 属性访问，但 headless profile 没有
    // 该服务——声明会炸插件加载。改用 ctx.get(name, strict=false)：cordis 允许
    // 不声明注入而按名读取服务（strict=false 时服务 fiber 未完全激活也可取）。
    const get = (ctx as { get?: (name: string, strict?: boolean) => unknown }).get;
    const webserver = typeof get === "function"
      ? (get.call(ctx, "webServer", false) as { register(r: { kind: string; path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }): () => void } | undefined)
      : undefined;
    if (webserver && typeof webserver.register === "function") {
      const readBody = (req: any): Promise<Record<string, unknown>> =>
        new Promise((resolve, reject) => {
          const chunks: Buffer[] = [];
          let size = 0;
          req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > 64 * 1024) {
              reject(new Error("body too large"));
              try { req.destroy(); } catch {}
              return;
            }
            chunks.push(c);
          });
          req.on("end", () => {
            try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8"))); } catch (e) { reject(e); }
          });
          req.on("error", reject);
        });
      const respond = (res: any, status: number, obj: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(obj));
      };
      // POST 动作分发：白名单动作（approve/resume/return/cancel）+ 按 sessionId
      // 解析当前会话 agent（逻辑见 actions.ts，可单测）。只接受 loopback 同源
      // 页面请求（dsh web 本身绑定 127.0.0.1）；动作会驱动真实工作流推进，
      // sessionId 无法猜测（uuid 形态），可接受该风险面。
      const handleAction = async (req: any, res: any): Promise<void> => {
        try {
          const json = await readBody(req);
          const result = await dispatchAction(
            {
              engine,
              handlers,
              getAgent,
              deliverToModel,
              warn: (m, e) => ctx.logger?.warn?.(m, e),
            },
            {
              action: String(json?.action ?? ""),
              sessionId: String(json?.sessionId ?? ""),
              runId: typeof json?.runId === "string" ? json.runId : undefined,
              reason: typeof json?.reason === "string" ? json.reason : undefined,
            },
          );
          if (result.fire) {
            // approve 的后台推进：不阻塞 HTTP 响应，失败由 dispatchAction 内部
            // 兜底记录（catch 已挂在 fire 上）
            void result.fire;
          }
          respond(res, result.ok ? 200 : 400, { ok: result.ok, text: result.text });
        } catch (e) {
          respond(res, 400, { ok: false, text: e instanceof Error ? e.message : String(e) });
        }
      };

      webserver.register({
        kind: "prefix",
        path: "/ralphflow/instances",
        handler: (req: any, res: any) => {
          void (async () => {
            try {
              if (req?.method === "POST") {
                await handleAction(req, res);
                return;
              }
              const url = String(req?.url ?? "");
              const wantHistory = url.includes("history=1");
              respond(res, 200, wantHistory
                ? { history: engine.readHistory() }
                : {
                    instances: engine.snapshotAllInstances(),
                    workflows: engine.listWorkflows().map((w) => w.name),
                    // history 尾部条目：client 全局监视据此发「已完成」通知（带
                    // cursor 预填，切页/刷新不历史轰炸）
                    recentEnded: engine.readHistory(12),
                    ts: Date.now(),
                  });
            } catch (e) {
              respond(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
            }
          })();
        },
      });
      engine.logEvent("", "info", "http_channel_ready", { path: "/ralphflow/instances" });
    } else {
      engine.logEvent("", "warn", "http_channel_unavailable", {});
    }
  } catch (e) {
    engine.logEvent("", "warn", "http_channel_error", { error: e instanceof Error ? e.message : String(e) });
  }

  try {
    engine.logEvent("", "info", "plugin_loaded", { workspace, version: "0.1.0" });
  } catch {}
}