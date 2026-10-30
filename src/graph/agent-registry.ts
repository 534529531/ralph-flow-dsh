/**
 * Graph 节点 agent → 所属工作区。
 *
 * 节点 agent 的 cwd 是它的 worktree（Git 模式）或项目工作区；工具调用必须回到**发起实例
 * 所在的工作区**解析引擎，绝不能按子会话 cwd 新建第二个引擎（否则绑定、状态、报告全部分叉）。
 * 这是一个进程内路由表，不是状态、不落盘：agent 创建时登记，dispose 时摘除。
 */
const owners = new Map<string, string>();

export function registerGraphAgent(agentId: string, workspace: string): void {
  owners.set(agentId, workspace);
}

export function unregisterGraphAgent(agentId: string): void {
  owners.delete(agentId);
}

export function graphAgentWorkspace(agentId: string | undefined): string | undefined {
  return agentId ? owners.get(agentId) : undefined;
}

export function graphAgentWorkspaces(): string[] {
  return [...new Set(owners.values())];
}
