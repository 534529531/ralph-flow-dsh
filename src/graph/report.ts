/**
 * Graph 报告（归档到 `reports/<instance>.md`）—— 与 Flow 同一个路径、同一份头部字段，
 * 这样 `ralphflow_list` 的历史与 `uiReport` 的定位不用维护第二套索引。
 *
 * 报告只指路，不复制执行日志原文（design §3.4）：验证者提示词/判定原文在 execution.log，
 * 这里只写判定结论、逐条证据摘要与产物引用。
 */
import path from "node:path";
import { formatDuration } from "../engine.js";
import { pauseLabel } from "../pause.js";
import { nodeNameOf, nodeStatusOf, NODE_STATUS_LABELS, projectionOf, type GraphInstanceState, type GraphAttempt } from "./state.js";

const STATUS_LABELS: Record<string, string> = {
  completed: "完成",
  failed: "失败",
  cancelled: "取消",
  paused: "暂停",
  interrupted: "中断",
  waiting: "等待",
  running: "运行中",
};

const code = (value: unknown): string => `\`${String(value ?? "").replaceAll("`", "\\`")}\``;
const oneLine = (value: unknown): string => String(value ?? "").replace(/\s+/g, " ").trim();

function artifactLine(attempt: GraphAttempt | undefined): string {
  return attempt?.artifact ? `${code(attempt.artifact.rel ?? attempt.artifact.path)}（sha256 ${code(attempt.artifact.sha256.slice(0, 12))}…）` : "未记录产物";
}

export interface GraphReportInput {
  instanceId: string;
  workspace: string;
  statePath: string;
  reportPath: string;
  artifactsRelDir: string;
}

export function buildGraphReport(state: GraphInstanceState, input: GraphReportInput): string {
  const asset = state.graph.asset;
  const projectionStatus = state.graph.status;
  const statusLabel = STATUS_LABELS[projectionStatus] ?? projectionStatus;
  const startedAt = state.started_at;
  const endedAt = state.updated_at;
  const duration = Math.max(0, new Date(endedAt).getTime() - new Date(startedAt).getTime());
  const lines: string[] = [
    `# ralphflow 报告 · ${oneLine(asset.name)}`,
    "",
    `- 实例：${code(input.instanceId)}`,
    `- 状态：**${statusLabel}**`,
    `- 类型：Graph`,
    `- 任务：${oneLine(state.user_task) || "（未提供）"}`,
    `- 开始：${startedAt}`,
    `- 结束：${endedAt}`,
    `- 总耗时：${formatDuration(duration)}`,
    `- 产出目录：${code(`${input.artifactsRelDir}/`)}`,
    `- 本报告：${code(`${path.relative(input.workspace, input.reportPath).split(path.sep).join("/")}`)}`,
    `- 执行日志：${code(`.dsh/ralph-flow/reports/${input.instanceId}-execution.log`)}`,
    "- 资产：",
    `  - id：${code(asset.id)}`,
    `  - 版本：${code(state.graph.asset_hash)}`,
    `  - 节点：${asset.nodes.length}`,
    "",
    "## 判定",
    "",
  ];

  const projection = projectionOf(state, input.instanceId);
  const completed = asset.nodes.filter((node) => nodeStatusOf(state, node) === "completed").length;
  const unfinished = asset.nodes.length - completed;
  const success = projectionStatus === "completed" && unfinished === 0;
  lines.push(
    `- 结果：${success ? "全部节点已完成" : "未完成全部节点"}`,
    `- 状态：${code(projectionStatus)}${state.graph.pause_reason ? `（${oneLine(pauseLabel(state.graph.pause_reason))}）` : ""}`,
    `- 完成：${completed}/${asset.nodes.length}`,
    `- 未完成：${unfinished}`,
    `- 交付分类：已交付 ${projection.delivery.delivered} · 未接纳 ${projection.delivery.unaccepted} · 未验证 ${projection.delivery.unverified} · 未完成 ${projection.delivery.unfinished}`,
    ...(state.graph.status === "paused" && state.graph.pause_reason ? [`- 暂停原因：${oneLine(pauseLabel(state.graph.pause_reason))}`] : []),
    "",
    "## 节点",
    "",
  );

  for (const node of asset.nodes) {
    const status = nodeStatusOf(state, node);
    const attempts = state.graph.attempts.filter((attempt) => attempt.node_id === node.id);
    const latest = attempts.at(-1);
    const verdict = latest ? state.graph.verdicts.filter((item) => item.attempt_id === latest.id).at(-1) : undefined;
    const acceptance = state.graph.acceptances.find((item) => item.node_id === node.id);
    const details = [
      `尝试 ${attempts.length}`,
      `产物 ${artifactLine(latest)}`,
      node.check ? `CHECK ${node.check.mode}${verdict ? `/${verdict.status}` : "（未判定）"}` : "CHECK 已关闭",
      ...(acceptance?.manual_approval ? ["人工批准"] : []),
      ...(acceptance?.integration ? [`合入 ${code(acceptance.integration.commit.slice(0, 12))}…`] : []),
    ];
    lines.push(`- ${code(node.id)} ${oneLine(nodeNameOf(state, node))} — ${status}（${NODE_STATUS_LABELS[status]}）；${details.join("；")}`);
    if (verdict) lines.push(`  - CHECK ${verdict.status}：${oneLine(verdict.reason)}`);
    if (latest?.failure) lines.push(`  - 失败：${oneLine(latest.failure.message)}`);
  }

  lines.push("", "## CHECK 判定", "");
  if (state.graph.verdicts.length === 0) {
    lines.push("- （无判定记录：所有节点都关闭了 CHECK，或尚未产生判定）");
  } else {
    for (const verdict of state.graph.verdicts) {
      lines.push(`- ${code(verdict.node_id)} · 尝试 ${code(verdict.attempt_id)} — ${verdict.status}（${verdict.check_mode}）；${oneLine(verdict.reason)}`);
      for (const evidence of verdict.evidence ?? []) {
        lines.push(`  - ${evidence.passed ? "✅" : "❌"} ${oneLine(evidence.criterion)}：${oneLine(evidence.evidence)}`);
      }
    }
  }

  lines.push("", "## 人工门与待办", "");
  if (state.graph.human_todos.length === 0) {
    lines.push("- （无）");
  } else {
    for (const todo of state.graph.human_todos) {
      lines.push(`- ${code(todo.id)} · ${code(todo.node_id)} · ${todo.status}${todo.feedback ? `：${oneLine(todo.feedback)}` : ""}`);
    }
  }

  lines.push("", "## 集成", "");
  {
    lines.push(
      `- 模式：git`,
      `- 集成分支：${code(state.graph.integration?.branch ?? "")}`,
      `- 基线：${code(state.graph.integration?.baseline ?? "")}`,
      `- 当前提交：${code(state.graph.integration?.current_commit ?? "")}`,
    );
    for (const acceptance of state.graph.acceptances) {
      if (acceptance.integration) {
        lines.push(`- 接纳 ${code(acceptance.node_id)} · ${code(acceptance.attempt_id)} · ${code(acceptance.integration.commit)}`);
      }
    }
  }

  lines.push("", "## 轨迹", "");
  if (state.history.length === 0) lines.push("- （无）");
  else for (const entry of state.history.slice(-60)) {
    lines.push(`- \`${entry.ts}\` **${entry.event}**${entry.step ? ` [${code(entry.step)}]` : ""}${entry.detail ? ` — ${oneLine(entry.detail)}` : ""}`);
  }

  lines.push("", "---", "由 RalphFlow 根据 Graph 持久化运行记录自动生成。报告与执行日志各自独立，不互相抄写。", "");
  return lines.join("\n");
}
