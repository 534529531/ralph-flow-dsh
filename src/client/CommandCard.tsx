/**
 * Ralph Flow for dsh — 命令结果卡（/ralphflow-* 输出的 opencode 式呈现）
 *
 * 注册进 conversation.chat.node（keyed kind 'ralphflow-command'）。数据来自
 * 折叠官方 command/run + command/done 事件（宿主自动为每条命令追加，属于官方
 * 词汇表，持久化安全）——取代旧版 plugin 自定义帧 append（那会砖掉会话）。
 * command/run 到达即建卡（执行中），command/done 到达补结果文本。
 * 全部消费 dsh 官方主题 token。
 */
import * as React from "react";

export interface RalphCommandCardProps {
  /** chat.node 槽组件签名：数据在 node.data（与官方 ChatNodeView 一致） */
  node?: { data?: { command?: string; text?: string; running?: boolean; error?: boolean } };
  /** locale 翻译函数（slot locale 注入；可能缺省，缺省用内置中文兜底） */
  t?: (key: string, params?: Record<string, unknown>) => string;
}

const STYLE: Record<string, React.CSSProperties> = {
  root: {
    border: "1px solid var(--dsw-alias-border-l2)",
    borderRadius: "10px",
    background: "var(--dsw-alias-bg-layer-1)",
    padding: "12px 14px",
    margin: "6px 0",
    fontSize: "13.5px",
    lineHeight: 1.6,
  },
  head: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "8px",
  },
  commandName: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    fontSize: "12.5px",
    color: "var(--dsw-alias-label-secondary)",
  },
  body: {
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    maxHeight: "320px",
    overflowY: "auto" as const,
    fontSize: "13px",
    color: "var(--dsw-alias-label-primary)",
  },
};

const badgeStyle = (error: boolean, running: boolean): React.CSSProperties => ({
  fontSize: "11px",
  padding: "2px 8px",
  borderRadius: "999px",
  background: error
    ? "var(--dsw-alias-state-error-secondary)"
    : running
      ? "var(--dsw-alias-state-warn-tertiary)"
      : "var(--dsw-alias-state-business-tertiary)",
  color: error
    ? "var(--dsw-alias-state-error-primary)"
    : running
      ? "var(--dsw-alias-state-warn-primary)"
      : "var(--dsw-alias-state-business-primary)",
  fontWeight: 600,
  flexShrink: 0,
  whiteSpace: "nowrap" as const,
});

function tr(t: RalphCommandCardProps["t"], key: string, fallback: string): string {
  try {
    const v = t?.(key);
    return typeof v === "string" && v ? v : fallback;
  } catch {
    return fallback;
  }
}

export function RalphCommandCard({ node, t }: RalphCommandCardProps) {
  const data = node?.data;
  if (!data || (!data.command && !data.text)) return null;
  const isError = !!data.error;
  const isRunning = !!data.running;
  // 显示名去 ralphflow- 前缀（/list、/start…），与 opencode 版 TUI 一致；
  // 快捷命令（/loop /spec）原名显示。
  const disp = String(data.command ?? "").replace(/^ralphflow-/, "");
  return (
    <div style={isError ? { ...STYLE.root, borderColor: "var(--dsw-alias-state-error-secondary)" } : STYLE.root}>
      <div style={STYLE.head}>
        <span style={badgeStyle(isError, isRunning)}>Ralph Flow</span>
        <span style={{ ...STYLE.commandName, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{`/${disp}`}</span>
        {isError ? <span style={{ marginLeft: "auto", fontSize: "11px", color: "var(--dsw-alias-state-error-primary)", flexShrink: 0 }}>⚠ {tr(t, "command.error", "出错")}</span> : null}
        {isRunning ? <span style={{ marginLeft: "auto", fontSize: "11px", color: "var(--dsw-alias-state-warn-primary)", flexShrink: 0 }}>⏳ {tr(t, "command.running", "执行中…")}</span> : null}
      </div>
      <div style={STYLE.body}>{data.text ?? ""}</div>
    </div>
  );
}