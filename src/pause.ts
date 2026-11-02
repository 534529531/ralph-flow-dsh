/**
 * 暂停原因：Flow 与 Graph **共用一套词表与中文标签**。
 *
 * 为什么单独一层：两个引擎把暂停原因写进各自的状态，但**用户看到的必须是同一句话**。
 * 过去 Flow 显示 `暂停(max_failures)`、Graph 只显示「已暂停」，同一个动作两种说法。
 *
 * 边界：纯映射，不读写状态、不产生副作用。`host_restarted` 之类不是"暂停"而是"中断"，
 * 由状态层的 `interrupted` 表达，不放进这张表。
 */
export type PauseReason =
  | "user_stop"
  | "host_restarted"
  | "max_failures"
  | "no_submit"
  | "check_infra"
  | "rework_limit"
  | "node_failure"
  | "no_schedulable_node"
  | "integration_failed";

const PAUSE_LABELS: Record<PauseReason, string> = {
  // 唯一的"用户主动"暂停：点发送键旁边的方块停止当前回合。
  user_stop: "你停止了运行",
  // 属主运行时不在了（崩溃/重启）。不是用户主动暂停，但恢复路径相同。
  host_restarted: "属主运行时失联",
  max_failures: "返工达到上限",
  rework_limit: "返工达到上限",
  no_submit: "连续没有动作",
  check_infra: "验证或定义故障",
  node_failure: "节点执行失败",
  no_schedulable_node: "没有可调度的节点",
  integration_failed: "合入失败",
};

/** 把暂停原因翻成用户能读懂的一行；未知原因原样透出，不吞事实。 */
export function pauseLabel(reason: string | undefined): string {
  if (!reason) return "原因未知";
  return PAUSE_LABELS[reason as PauseReason] ?? reason;
}
