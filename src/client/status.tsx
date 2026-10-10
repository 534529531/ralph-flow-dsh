import { useId, useRef, useState } from "react";
import { StateDot, useDismissOnOutsidePointer } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import { statusRemote, type WorkflowStage, type WorkflowStatus } from "../status-contract.js";
import { createStatusSource, type ClientStatus } from "./status-source.js";

const labels: Record<WorkflowStage, string> = {
  executing: "待交卷", verifying: "独立验证中", gate: "等待你放行", paused: "已暂停",
  switching: "切换步骤中", done: "已完成", cancelled: "已取消", unavailable: "状态不可用",
};
const votes = { pending: "等待验证", running: "验证中", passed: "通过", failed: "未通过", infra: "验证者故障" };
/** The only stages that need the user to act. The input-area prompt appears for these and only these. */
const actionStages: ReadonlySet<WorkflowStage> = new Set(["gate", "paused"]);
const terminalStages: ReadonlySet<WorkflowStage> = new Set(["done", "cancelled"]);
const whole = (s: ClientStatus) => s;
type Props = { useWorkflowStatus: <T>(selector: (s: ClientStatus) => T) => T };

/**
 * Colors, radii, shadows, and typography use installed dsh theme tokens.
 * Geometry follows the native jobs trigger and goal dock. The opaque layer token
 * replaces dsh’s translucent menu material, as requested.
 */
const css = `
.ralphflow-status { position: relative; display: inline-flex; align-items: center; gap: 4px; max-width: min(320px, 38vw); min-height: 28px; padding: 3px 2px; border: 0; background: none; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: var(--dsw-font-xxs-12-font-size); line-height: var(--dsw-font-xxs-12-line-height); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
.ralphflow-status:hover, .ralphflow-status:focus-visible { color: var(--dsw-alias-label-secondary); }
.ralphflow-status-dot { flex: none; }
.ralphflow-status-popover { position: absolute; right: 0; top: calc(100% + 8px); width: min(380px, calc(100vw - 32px)); max-height: min(480px, 100vh - 140px); z-index: 100; box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 12px; overflow: auto; --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); border: 0; border-radius: var(--dsw-radius-lg); background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent); color: var(--dsw-alias-label-primary); font-size: var(--dsh-content-font-size-secondary); line-height: var(--dsw-font-xs-13-line-height); }
.ralphflow-status-popover-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.ralphflow-status-popover-title { min-width: 0; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ralphflow-status-popover-stage { flex: none; color: var(--dsw-alias-label-tertiary); white-space: nowrap; }
.ralphflow-status-banner { padding: 6px 8px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.ralphflow-status-banner[data-kind="error"] { background: var(--dsw-alias-state-error-secondary); color: var(--dsw-alias-label-primary); }
.ralphflow-status-hint { color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
.ralphflow-status-task { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
.ralphflow-status-label { color: var(--dsw-alias-label-tertiary); }
.ralphflow-status-steps { margin: 4px 0; padding-left: 20px; }
.ralphflow-status-steps li { overflow-wrap: anywhere; }
.ralphflow-status-votes { margin: 4px 0; padding-left: 20px; }
.ralphflow-status-votes li { overflow-wrap: anywhere; }
.ralphflow-status-recent { margin: 4px 0; padding-left: 20px; }
.ralphflow-status-recent li { overflow-wrap: anywhere; }
.ralphflow-status-report { margin: 0; overflow-wrap: anywhere; }
.ralphflow-status-report code { font-family: var(--dsw-font-mono, monospace); }
.ralphflow-status-action-dock { width: calc(100% - 2 * var(--dsh-composer-side-clearance) - 4 * var(--dsh-composer-dock-inset)); margin: 0 auto; }
.ralphflow-status-action { box-sizing: border-box; width: 100%; max-width: calc(var(--dsh-composer-card-max-width) - 4 * var(--dsh-composer-dock-inset)); margin: 0 auto; display: flex; align-items: center; gap: 8px; padding: 4px 12px; border: 0; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-panel); color: var(--dsw-alias-label-primary); font-size: var(--dsh-content-font-size-secondary); line-height: var(--dsw-font-xs-13-line-height); min-height: 36px; --dsw-elevation-stroke-color: var(--dsw-alias-border-l1); }
.ralphflow-status-action-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The timeline broadcast row keeps its record role; only its radius/font move to tokens. */
.ralphflow-notice { margin: 8px 0; padding: 8px 12px; border-radius: var(--dsw-radius-sm); background: var(--dsw-alias-bg-module-platform); color: inherit; font-size: var(--dsh-content-font-size-secondary); line-height: 1.6; overflow-wrap: anywhere; }
.ralphflow-notice > summary { cursor: pointer; }
.ralphflow-notice-text { padding-top: 8px; white-space: pre-wrap; }
`;
/** One shared, idempotent stylesheet; no timers or per-instance style nodes. */
export function injectStatusCss(): void {
  if (typeof document === "undefined" || document.querySelector("style[data-ralphflow-status-css]") !== null) return;
  const style = document.createElement("style");
  style.dataset.ralphflowStatusCss = "";
  style.textContent = css;
  document.head.appendChild(style);
}
injectStatusCss();

function StatusDot({ stage }: { stage: WorkflowStage }) {
  const state = stage === "done" ? "done" : stage === "gate" || stage === "paused" ? "warning"
    : stage === "unavailable" ? "error" : stage === "cancelled" ? "idle" : "ongoing";
  return <StateDot state={state} className="ralphflow-status-dot" />;
}

/** The single persistent location: bare text + dot, no container, dsh jobs-trigger style. */
function WorkflowStatusControl({ useWorkflowStatus }: Props) {
  const { status, connection } = useWorkflowStatus(whole);
  const [opened, setOpened] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useDismissOnOutsidePointer(root, opened, setOpened);
  if (!status) return null;
  const terminal = terminalStages.has(status.stage);
  const label = labels[status.stage];
  return <div ref={root} style={{ position: "relative" }} onKeyDown={(e) => { if (e.key === "Escape") { setOpened(false); trigger.current?.focus(); } }}>
    <button ref={trigger} type="button" className="ralphflow-status" data-ralphflow-status={status.id} data-stage={status.stage} data-connection={connection}
      aria-expanded={opened} aria-controls={opened ? id : undefined} aria-label="查看工作流状态" onClick={() => setOpened((v) => !v)}
      title={`${status.workflow} · ${status.step} · ${label}`}>
      <StatusDot stage={status.stage} />
      <span>{terminal ? `${label} · 报告` : `${status.step} · ${status.stage === "paused" ? `失败 ${status.failures} 次` : `第 ${status.failures + 1} 轮`} · ${label}`}{connection === "live" ? "" : " · 同步中"}</span>
    </button>
    {opened ? <WorkflowStatusPopover id={id} useWorkflowStatus={useWorkflowStatus} /> : null}
  </div>;
}

function WorkflowStatusPopover({ id, useWorkflowStatus }: { id: string } & Props) {
  const { status, connection, error } = useWorkflowStatus(whole);
  if (!status) return null;
  const terminal = terminalStages.has(status.stage);
  const returned = status.votes.filter((v) => v.status === "passed" || v.status === "failed" || v.status === "infra").length;
  // The internal failure budget is noise until it is nearly spent; only then surface n/m.
  const nearLimit = status.maxFailures > 0 && status.failures > 0 && status.failures >= status.maxFailures * 0.8;
  return <div id={id} className="ralphflow-status-popover" data-ralphflow-status-popover role="status">
    <div className="ralphflow-status-popover-head">
      <span className="ralphflow-status-popover-title">Ralph Flow · {status.workflow}</span>
      <span className="ralphflow-status-popover-stage">{labels[status.stage]}{connection === "live" ? "" : " · 同步中"}</span>
    </div>
    {error ? <div className="ralphflow-status-banner" data-kind="error" role="status">Ralph Flow · {error}</div> : null}
    {connection !== "live" && !error ? <div className="ralphflow-status-banner" role="status">正在重新同步，显示最后状态。</div> : null}
    {!terminal && nearLimit ? <div className="ralphflow-status-banner" role="status">本步失败接近上限 · {status.failures}/{status.maxFailures}</div> : null}
    {!terminal && status.hint ? <div className="ralphflow-status-hint">{status.hint}</div> : null}
    {!terminal ? <p className="ralphflow-status-task">{status.task}</p> : null}
    {!terminal ? <div className="ralphflow-status-label">本步失败 {status.failures} 次</div> : null}
    {!terminal && status.steps.length ? <div>
      <div className="ralphflow-status-label">步骤</div>
      <ol className="ralphflow-status-steps" aria-label="工作流步骤">
        {status.steps.map((step) => <li key={step.id} aria-current={step.current ? "step" : undefined}>
          {step.current ? "→ " : ""}<strong>{step.id}</strong> · {step.description}{step.failures ? ` · 失败 ${step.failures} 次` : ""}
        </li>)}
      </ol>
    </div> : null}
    {!terminal && status.votes.length ? <div>
      <div className="ralphflow-status-label">本轮验证 · {returned}/{status.votes.length} 已返回</div>
      <ul className="ralphflow-status-votes" aria-label={`本轮验证 · ${returned}/${status.votes.length} 已返回`}>
        {status.votes.map((vote) => <li key={vote.index}>验证者 {vote.index}/{status.votes.length} · {votes[vote.status]}
          {vote.reason ? <div>{vote.reason}</div> : null}</li>)}
      </ul>
    </div> : null}
    {!terminal && status.recent.length ? <details><summary className="ralphflow-status-label">最近轨迹</summary>
      <ul className="ralphflow-status-recent">{status.recent.map((event, index) => <li key={index}>{event.step} · {event.event}{event.detail ? `：${event.detail}` : ""}</li>)}</ul>
    </details> : null}
    {status.report ? <p className="ralphflow-status-report">报告：<code>{status.report}</code></p> : null}
  </div>;
}

/** Input-area prompt: present only while the user must act, and it removes itself once handled. */
function WorkflowStatusAction({ useWorkflowStatus }: Props) {
  const { status } = useWorkflowStatus(whole);
  if (!status || !actionStages.has(status.stage)) return null;
  const reason = status.stage === "gate" ? "等待你放行" : status.maxFailures > 0 && status.failures >= status.maxFailures ? "失败已到上限" : "已暂停";
  return <div className="ralphflow-status-action-dock"><div className="ralphflow-status-action" data-ralphflow-status-action={status.id} data-stage={status.stage} role="status">
    <StatusDot stage={status.stage} />
    <span className="ralphflow-status-action-text">{reason} · 输入 <code>/ralphflow-continue</code> 继续</span>
  </div></div>;
}

/** Additive entries, with a single reference-counted observable for each bound Session. */
export async function registerWorkflowStatus(ctx: Context): Promise<void> {
  await ctx.remote.$mount(statusRemote);
  await ctx.inject(["remote.ralphflowStatus"], registerUi);
}

function registerUi(ctx: Context): void {
  const sources = new Map<string, ReturnType<typeof createStatusSource>>();
  const sourceOf = (sessionId: string) => {
    let source = sources.get(sessionId);
    if (!source) { source = createStatusSource(ctx, sessionId); sources.set(sessionId, source); }
    return { hooks: { workflowStatus: source } };
  };
  ctx.effect(() => () => { for (const source of sources.values()) source.dispose(); sources.clear(); });
  ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
    name: "conversation.input.dock", id: "ralphflow-status", order: 5, inject: sourceOf,
  }, WorkflowStatusAction));
  ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
    name: "conversation.session.header.actions", id: "ralphflow-status", order: 15, inject: sourceOf,
  }, WorkflowStatusControl));
}
