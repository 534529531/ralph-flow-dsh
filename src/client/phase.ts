/**
 * 阶段投影（纯函数）：把状态面的事实翻译成查看器卡片上的芯片。
 *
 * 为什么单独一层：Flow 步骤卡过去不论 DO 还是 CHECK 都写「执行中」，光看工作图分不出
 * 当前在哪个阶段；Graph 节点的「执行中 / 验证中」又共用同一种颜色。这里把「哪个阶段、
 * 什么状态、什么语气」集中成一份映射，界面只负责画。
 *
 * 语气只有五种，语义固定：run = 在飞、done = 已通过、wait = 等你或等依赖、
 * fault = 失败、off = 未开始。在飞用业务色（有彩色），不是品牌色 —— 品牌色是黑白中性色，
 * 夜间模式下整张工作图会退化成纯黑白。
 *
 * 边界：不读实例状态、不碰时间、不产生副作用；没有运行状态时只说结构，不猜进度。
 */
import type { GraphStatusNode, ViewerAssetNode, WorkflowStatus } from "../status-contract.js";

export type PhaseTone = "run" | "done" | "wait" | "fault" | "off";
export interface PhaseChip { label: string; tone: PhaseTone }

const DO_RUNNING: PhaseChip = { label: "DO · 执行中", tone: "run" };
const DO_SUBMITTED: PhaseChip = { label: "DO · 已交卷", tone: "done" };
const CHECK_IDLE: PhaseChip = { label: "CHECK · 待验证", tone: "off" };
const CHECK_OFF: PhaseChip = { label: "CHECK · 关闭", tone: "off" };
const CHECK_CUSTOM: PhaseChip = { label: "CHECK · 自定义", tone: "off" };
const CHECK_RUNNING: PhaseChip = { label: "CHECK · 验证中", tone: "run" };
const CHECK_PASSED: PhaseChip = { label: "CHECK · 已通过", tone: "done" };
const CHECK_FAILED: PhaseChip = { label: "CHECK · 未通过", tone: "fault" };

/** 状态枚举 → 语气。未知状态按「未开始」处理，不猜。 */
export function statusToneOf(status: string): PhaseTone {
  if (status === "completed" || status === "done" || status === "passed") return "done";
  if (["running", "verifying", "reworking", "integrating", "accepting", "switching"].includes(status)) return "run";
  if (["waiting", "waiting_review", "gate", "paused"].includes(status)) return "wait";
  if (["failed", "cancelled", "interrupted", "infra"].includes(status)) return "fault";
  return "off";
}

/** Flow 当前步：先 DO 后 CHECK，一眼看出引擎在哪个阶段。 */
export function flowPhaseChips(flow: WorkflowStatus): PhaseChip[] {
  const total = flow.votes.length;
  const returned = flow.votes.filter((vote) => vote.status === "passed" || vote.status === "failed" || vote.status === "infra").length;
  switch (flow.stage) {
    case "executing":
      return total > 0 ? [DO_RUNNING, CHECK_IDLE] : [DO_RUNNING];
    case "verifying":
      return [DO_SUBMITTED, total > 1 ? { ...CHECK_RUNNING, label: `CHECK · 验证中 ${returned}/${total}` } : CHECK_RUNNING];
    case "gate":
      return total > 0 ? [DO_SUBMITTED, CHECK_PASSED, { label: "等待你放行", tone: "wait" }] : [DO_SUBMITTED, { label: "等待你放行", tone: "wait" }];
    // switching 既可能是「本步刚拿到 DO 投递」，也可能是「判定齐了正在推进」：
    // 只有票已存在才敢说 DO 已交卷，否则只说切换中。
    case "switching":
      return total > 0 ? [DO_SUBMITTED, CHECK_PASSED] : [{ label: "切换步骤中", tone: "run" }];
    case "paused":
      return [{ label: "已暂停", tone: "wait" }];
    case "done":
      return [{ label: "已完成", tone: "done" }];
    case "cancelled":
      return [{ label: "已取消", tone: "off" }];
    case "failed":
      return [{ label: "失败", tone: "fault" }];
    default:
      return [{ label: "状态不可用", tone: "off" }];
  }
}

/** Graph 节点：先 DO 后 CHECK；节点投影里的 label 是事实，原样带上。 */
export function graphPhaseChips(node: GraphStatusNode): PhaseChip[] {
  const check = node.check.mode === "disabled" ? CHECK_OFF : null;
  switch (node.status) {
    case "running":
      return [DO_RUNNING, check ?? CHECK_IDLE];
    case "verifying":
      return [DO_SUBMITTED, CHECK_RUNNING];
    case "reworking":
      return [DO_SUBMITTED, CHECK_FAILED, { label: node.label, tone: "wait" }];
    case "waiting_review":
      return [DO_SUBMITTED, CHECK_PASSED, { label: node.label, tone: "wait" }];
    case "integrating":
    case "accepting":
      return [CHECK_PASSED, { label: node.label, tone: "run" }];
    case "completed":
      return check ? [{ label: node.label, tone: "done" }] : [{ label: node.label, tone: "done" }, CHECK_PASSED];
    default:
      return [{ label: node.label, tone: statusToneOf(node.status) }];
  }
}

/** 没有运行状态时只描述结构：静态属性一律中性，别跟运行状态抢注意力。 */
export function graphAssetChips(node: ViewerAssetNode): PhaseChip[] {
  return [{ label: "待开始", tone: "off" }, node.checkMode === "disabled" ? CHECK_OFF : CHECK_CUSTOM];
}

/** 步骤详情顶部状态条：把 Flow 阶段翻成查看器的状态枚举，别让详情永远显示「在飞」。 */
export function flowPanelStatus(flow: WorkflowStatus | null, current: boolean): string {
  if (!current || !flow) return "pending";
  switch (flow.stage) {
    case "verifying": return "verifying";
    case "gate":
    case "paused": return "waiting";
    case "done": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    default: return "running";
  }
}
