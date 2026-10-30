/**
 * Graph 的分支命名。集成分支与节点分支共用一份定义：
 * 状态读取时补 `branch` 与 Git 工作区都必须写出同一串名字。
 */
export const INTEGRATION_BRANCH_PREFIX = "ralphflow";
/** 节点分支另起一个前缀：`refs/heads` 里一条分支不能同时是另一条分支的目录。 */
export const NODE_BRANCH_PREFIX = "ralphflow-node";

export function integrationBranchFor(instId: string): string {
  return `${INTEGRATION_BRANCH_PREFIX}/${instId}`;
}

export function nodeBranchFor(instId: string, nodeId: string): string {
  return `${NODE_BRANCH_PREFIX}/${instId}/${nodeId}`;
}
