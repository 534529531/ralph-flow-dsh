/**
 * 为真实 `AgentLoop` 装配加载原生工具执行器。
 *
 * dsh 0.2.2-rc.3 的 `dsh-tools` 只提供 `setExecutor`；原生执行器是独立插件
 * （`dsh-tool-executor-native`）。缺少它时回合在 pre-step 就报
 * "The selected tool executor is unavailable"，模型 stream 一次都不会被调用
 * —— 这正是 rc.3 上 round-turn / real-loop-wake 的假失败根因。
 *
 * 解析顺序：
 *   1. 本仓依赖（正常的 `node_modules/@deepseek-ai/dsh-tool-executor-native`）；
 *   2. 宿主 `dsh-agent-loop` 的同级依赖（系统树/发行版把执行器装在该包旁边时）。
 * 都找不到返回 null：老版本宿主可能把执行器内置在 `dsh-tools` 里，装配方按
 * 「宿主提供该包才加载」处理；真实缺执行器时，回合会用宿主的报错自己说出来。
 */
import { createRequire } from "node:module";

export async function loadToolExecutor() {
  try {
    return await import("@deepseek-ai/dsh-tool-executor-native");
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  }
  try {
    // 从宿主 agent-loop 的真实安装位置解析它的同级依赖；不依赖其 package.json 是否在 exports 里。
    const requireFromRepo = createRequire(import.meta.url);
    const hostEntry = requireFromRepo.resolve("@deepseek-ai/dsh-agent-loop");
    const requireFromHost = createRequire(hostEntry);
    return await import(requireFromHost.resolve("@deepseek-ai/dsh-tool-executor-native"));
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND") return null;
    throw error;
  }
}
