/**
 * 「**另一个进程**里的会话碰 ralphflow」的探针。
 *
 * 为什么需要它：真实部署里每个 agent 进程跑在各自的 sandbox 里（独立 PID namespace、
 * 独立 /proc 视图），验证者就是这样一个进程 —— 它一装载插件就会 `engineFor(工作区)`
 * → `restore()`。这正是把在飞验证踩停的那条路径，而「同一个进程里两个插件实例」的
 * 测试**测不到它**（同进程时 pid 判活恰好成立，跨沙箱时才暴露）。
 *
 * 用法（由用例 spawn 出来，不做断言、只做动作，结果从 stdout 带回去）：
 *   node touch-probe.mjs <插件入口URL> <工作区> <会话id> [工具名]
 */
import { mkEnv, toolOf, execTool } from "./plugin-harness.mjs";

const [entry, ws, sid, toolName = "ralphflow_list"] = process.argv.slice(2);
if (!entry || !ws || !sid) {
  console.error("用法: node touch-probe.mjs <entry> <workspace> <sessionId> [tool]");
  process.exit(2);
}
process.env.RALPHFLOW_WORKSPACE = ws;

const plugin = await import(entry);
const env = mkEnv(ws, sid, {});
plugin.apply(env.ctx);
const out = await execTool(toolOf(env.registered, toolName), {}, sid);
process.stdout.write(String(out ?? "").slice(0, 400));
