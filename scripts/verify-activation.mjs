/**
 * 激活冒烟：在最小 cordis Context 上挂载 ralphflow 插件，复现 apply() 激活路径。
 * 注入面用 stub 顶替，只为验证 apply() 不抛（工具 schema 校验/命令注册走真实 dsh-tools 运行时）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import * as plugin from "../lib/index.js";

// HOME 隔离（任务书 §4 工作协议）：测试绝不读写真实 ~/.dsh（索引/全局工作流目录都在这里）。
// 必须在 createEngine / apply 之前设置，因为引擎在创建时解析 os.homedir()。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });


const ctx = new Context();
const provided = new Map();

function provide(name, impl) {
  provided.set(name, impl);
  ctx.provide(name, impl);
}

provide("tools", {
  register() {},
  schemas() { return []; },
});
provide("commands", { register() {} });
provide("subagents", {
  list() { return ["spawn"]; },
  getProvider() { return { capabilities: { outputSchema: false, toolFilter: true } }; },
  start() { throw new Error("stub: no real subagent in smoke"); },
});
provide("agents", { get() { return undefined; } });
provide("sessions", { list() { return []; } });
provide("logger", { info() {}, warn() {}, error() {} });

try {
  const injectedOk = plugin.inject.every((svc) => provided.has(svc));
  if (!injectedOk) {
    console.error("MISSING INJECTED SERVICES:", plugin.inject.filter((s) => !provided.has(s)));
    process.exit(1);
  }
  plugin.apply(ctx);
  console.log("APPLY_OK");
  process.exit(0);
} catch (e) {
  console.error("APPLY_FAILED:", e && e.message ? e.message : String(e));
  if (e && e.stack) console.error(e.stack.split("\n").slice(0, 6).join("\n"));
  process.exit(2);
}