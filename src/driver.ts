/**
 * Ralph Flow for dsh — 状态机推进器（CHECK 编排 + 事件发射）
 *
 * 移植自 opencode 版 driver.ts 的 runCheckAndAdvance：opencode 通过 session.idle
 * 钩子 + injectPrompt 驱动；dsh 版由 job 内循环/工具调用触发本模块，把
 * "注入可见消息"替换为"发射 tool-ralphflow/* 事件帧"（client 端折叠成卡片），
 * 把"过渡文本"作为工具/命令的返回值返回给调用者（模型可见）。
 */
import type { Engine, WorkflowDef, NormalStepDef, RalphFlowState, CheckResult } from "./engine.js";
import { isSubWorkflowStep, MANUAL_GATE_MARKER, DEFAULT_ADVERSARIAL_TIMEOUT_MS } from "./engine.js";
import { readFileSync } from "fs";
import { adversarialCheck, liveVerifierCount, type CheckDeps } from "./check.js";
import { runVotingCheck } from "./check-voting.js";
import { readVotingProgress, deleteVotingProgress } from "./voting-progress.js";
import { voterStatusLabel } from "./check-voting.js";
import type { EventEmitter } from "./events.js";
import type { Agent } from "@deepseek-ai/dsh-agent";

export interface DriveContext {
  engine: Engine;
  deps: CheckDeps;
  emit: EventEmitter;
  /** 当前工作会话的 agent（验证者子代理的 parent）；可能为 undefined（影子恢复） */
  parent: Agent | undefined;
}

export interface DriveResult {
  text: string;
  completed: boolean;
  paused: boolean;
}

function fmtVotingOverview(step: NormalStepDef): string {
  if (!Array.isArray(step.check_voting) || step.check_voting.length === 0) return "";
  const n = step.check_voting.length;
  const rows = step.check_voting
    .map((e, i) => `  ${i + 1}/${n} ${String(e.check).split("\n")[0].trim().substring(0, 50)} · 模型:${typeof e.model === "string" ? e.model : e.model ? `${e.model.providerID}/${e.model.modelID}` : "默认"}`)
    .join("\n");
  return `[各验证者检查依据]\n${rows}`;
}

/**
 * 对 DO 刚完成的步骤运行独立验证并推进状态机（do→check→on_pass/on_fail/暂停）。
 * 调用前置条件：实例状态为 do 阶段（done 已达成，或人工门已批准）。
 * 返回过渡文本（供工具/命令返回给模型），并发射全部 UI 事件帧。
 */
export async function runCheckAndAdvance(
  ctx: DriveContext,
  instId: string,
  workflow: WorkflowDef,
  step: NormalStepDef,
  state: RalphFlowState,
): Promise<DriveResult> {
  try {
    return await driveInner(ctx, instId, workflow, step, state);
  } finally {
    // 释放实例级 abort 注册（cancel 之后到达的本段信号不再保留）
    try { ctx.deps.dispose?.(); } catch {}
  }
}

async function driveInner(
  ctx: DriveContext,
  instId: string,
  workflow: WorkflowDef,
  step: NormalStepDef,
  state: RalphFlowState,
): Promise<DriveResult> {
  const { engine, emit } = ctx;
  const sessionId = state.session_id ?? null;

  // do→check 转换（与 opencode 版一致：仅在真实边界记录 DO 完成）
  if (state.current_phase === "do") {
    engine.logEvent(instId, "info", "done_detected", { step: state.current_step });
    engine.addStepRecord(instId, state.current_step, "do", "passed", state.fail_count || 0, undefined, state.workflow_name);
  }
  engine.clearManualStepMarker(instId);
  engine.clearManualGate(instId);
  engine.clearReinjectCounter(instId);
  engine.clearDoPromptCache(instId);
  engine.clearDoneTagDetected(instId);
  engine.writeState({ ...state, current_phase: "check" }, instId);
  engine.recordStepStart(instId, state.current_step, "check");

  // ── no-check 步骤：未配置独立验证 → DO 完成即直通 on_pass ───────────────────
  if (step.no_check) {
    const noCheckReason = "本步骤未配置独立验证（no-check），完成即通过。";
    engine.addStepRecord(instId, step.id, "check", "passed", state.fail_count || 0, noCheckReason, state.workflow_name);
    emit.emit(instId, "tool-ralphflow/check-result", { runId: instId, step: step.id, passed: true, reason: noCheckReason });
    const result = engine.handleCheckPassed(instId, engine.readState(instId) ?? { ...state, current_phase: "check" }, workflow, step, { reason: noCheckReason }, true);
    return finishTransition(ctx, instId, workflow, state, result);
  }

  const isVoting = Array.isArray(step.check_voting) && step.check_voting.length > 0;
  const adversarialConfig = engine.getEffectiveAdversarialCheck(instId, workflow);
  engine.logEvent(instId, "info", "step_start", { step: state.current_step, phase: "check" });
  // 超时上限透传：UI 据此画「剩余时间」进度条，等待有了终点感
  const effectiveTimeoutMs = (isVoting && Array.isArray(step.check_voting)
    ? Math.max(...step.check_voting.map((v) => v.timeout_ms ?? adversarialConfig?.timeout_ms ?? 0), adversarialConfig?.timeout_ms ?? 0)
    : adversarialConfig?.timeout_ms) || DEFAULT_ADVERSARIAL_TIMEOUT_MS;
  emit.emit(instId, "tool-ralphflow/step-start", {
    runId: instId, step: state.current_step, phase: "check", failCount: state.fail_count || 0,
    ts: Date.now(),
    // 验证者总数：投票期首票落地前 UI 就能显示「已收 M/N 票」，不再静默
    voters: isVoting ? step.check_voting!.length : 1,
    timeoutMs: effectiveTimeoutMs,
  });

  const checkPrompt = isVoting ? "" : engine.buildCheckPrompt(instId, step, state.user_task);

  let checkResult: CheckResult;
  try {
    if (isVoting && step.check_voting) {
      if (state.current_phase === "do") {
        deleteVotingProgress(engine, instId);
      }
      const progress = readVotingProgress(engine, instId);
      const outcome = await runVotingCheck(
        ctx.deps, engine, instId, sessionId, ctx.parent, step, state.user_task,
        step.check_voting, adversarialConfig,
        {
          phase: state.current_phase,
          workflowName: state.workflow_name,
          progress,
          // 投票进度通过 runSingleVoter 发射的 check-verdict 事件逐票推送，无需额外回调
        },
      );
      if (outcome.kind === "cancelled") {
        engine.logEvent(instId, "warn", "voting_cancelled", { step: step.id });
        return { text: "工作流实例已被取消。", completed: false, paused: false };
      }
      if (outcome.kind === "infra_pause") {
        checkResult = { passed: false, infra: true, reason: outcome.reason };
      } else {
        checkResult = { passed: outcome.kind === "passed", reason: outcome.reason };
      }
    } else {
      const singleCheckConfig = step.check_model
        ? { ...(adversarialConfig || {}), model: step.check_model }
        : adversarialConfig;
      checkResult = await adversarialCheck(ctx.deps, sessionId, ctx.parent, instId, step, checkPrompt, state.user_task, singleCheckConfig);
    }
  } catch (err: any) {
    engine.logEvent(instId, "error", "adversarial_check_uncaught", { stepId: step.id, error: err.message });
    const st = engine.readState(instId);
    if (st && st.active && st.current_phase === "check" && st.current_step === state.current_step && st.workflow_name === state.workflow_name) {
      engine.writeState({ ...st, paused: true, pause_reason: "check_error", last_failure_reason: `对抗性检查崩溃：${err.message}` }, instId);
    }
    emit.emit(instId, "tool-ralphflow/check-result", { runId: instId, step: step.id, passed: false, reason: `对抗性检查崩溃：${err.message}`, infra: true });
    // 同 infra 暂停分支：绕过 finishTransition 的直接 return，补发暂停帧
    emit.emit(instId, "tool-ralphflow/run-end", { runId: instId, stopReason: "failed" });
    return {
      text: `⚠️ 验证未能运行 · 🙋 轮到你了\n\n对抗性检查崩溃:${err.message}\n\n这是验证程序自身的问题,不是你工作成果的问题——本次不计入失败次数,已完成的工作保持原样。\n\n👉 处理后运行 /ralphflow-continue 即可重新验证(无需重做任务),或 /ralphflow-cancel 放弃。`,
      completed: false, paused: true,
    };
  }

  // 状态竞争防御：验证期间实例被取消/接管/暂停则丢弃判定
  const cur = engine.readState(instId);
  if (!cur || !cur.active || cur.paused || cur.current_phase !== "check"
      || cur.workflow_name !== state.workflow_name || cur.current_step !== state.current_step) {
    engine.logEvent(instId, "warn", "check_result_discarded", { reason: cur?.paused ? "instance paused during check" : "state changed during check" });
    return { text: "", completed: false, paused: false };
  }

  if (checkResult.infra) {
    engine.writeState({ ...cur, paused: true, pause_reason: "check_error", last_failure_reason: checkResult.reason }, instId);
    engine.logEvent(instId, "warn", "workflow_paused", { workflow: cur.workflow_name, step: cur.current_step, reason: "check_infra_error" });
    emit.emit(instId, "tool-ralphflow/check-result", { runId: instId, step: step.id, passed: false, infra: true, reason: checkResult.reason });
    // 此分支直接 return 不经过 finishTransition——run-end failed 帧必须在这里
    // 补发，否则 client 卡片永远停在「验证中」、活体面板一直转（暂停语义在
    // UI 上不可见）。
    emit.emit(instId, "tool-ralphflow/run-end", { runId: instId, stopReason: "failed" });
    return {
      text: `⚠️ 验证未能运行 · 🙋 轮到你了\n\n${checkResult.reason}\n\n这是验证进程自身的问题(额度/API/超时),不是你工作成果的问题:本次不计入失败次数,已完成的工作无需重做。\n\n👉 问题解决后运行 /ralphflow-continue 直接重新验证,或 /ralphflow-cancel 放弃。`,
      completed: false, paused: true,
    };
  }

  emit.emit(instId, "tool-ralphflow/check-result", {
    runId: instId, step: step.id, passed: checkResult.passed, reason: checkResult.reason,
    aggregatedFails: checkResult.passed ? [] : [checkResult.reason],
  });

  engine.addStepRecord(instId, cur.current_step, "check", checkResult.passed ? "passed" : "failed", cur.fail_count || 0, checkResult.reason, cur.workflow_name);
  const result = checkResult.passed
    ? engine.handleCheckPassed(instId, cur, workflow, step, checkResult)
    : engine.handleCheckFailed(instId, cur, workflow, step, checkResult);

  return finishTransition(ctx, instId, workflow, state, result);
}

/**
 * 验证判定后的公共收尾：完成→报告+run-end；暂停→run-end failed；
 * 推进→step-start 事件 +（人工审查步骤只预告，真正停门发生在其 DO 完成时）。
 */
function finishTransition(
  ctx: DriveContext,
  instId: string,
  workflow: WorkflowDef,
  state: RalphFlowState,
  result: ReturnType<Engine["handleCheckPassed"]>,
): DriveResult {
  const { engine, emit } = ctx;

  if (result.completed) {
    // 工作流结束：报告已由 handleCheckPassed 归档，读取并发射报告/结束事件。
    // 实例此刻已被 destroyInstance 删除——用进入本段前锁定的属主会话发送，
    // 否则终态帧读不到 state.json 会被静默丢弃。
    const owner = state.session_id ?? null;
    const reportPath = engine.getReportPath(instId);
    let reportText = "";
    try {
      reportText = readFileSync(reportPath, "utf-8");
    } catch {}
    if (reportText) {
      emit.emitFinal(instId, owner, "tool-ralphflow/report", { runId: instId, text: reportText, reportPath });
    }
    emit.emitFinal(instId, owner, "tool-ralphflow/run-end", { runId: instId, stopReason: "done", reportId: instId });
    return { text: result.text, completed: true, paused: false };
  }

  if (result.paused) {
    emit.emit(instId, "tool-ralphflow/run-end", { runId: instId, stopReason: "failed" });
    return { text: result.text, completed: false, paused: true };
  }

  // 推进到下一步（do 阶段）——发射事件；人工审查步骤不发"已完成待审查"卡，
  // 审查门在其 DO 完成时由 job 触发（gate 帧此刻才真实）。
  const next = engine.readState(instId);
  if (next && next.active && next.current_phase === "do") {
    engine.clearDoneTagDetected(instId);
    engine.clearManualGate(instId);
    const nextWf = next.workflow_name === workflow.name ? workflow : engine.loadWorkflow(next.workflow_name);
    if (nextWf?.manual_step?.includes(next.current_step)) engine.writeManualStepMarker(instId);
    engine.markPromptDelivered(next.current_step, instId);
    emit.emit(instId, "tool-ralphflow/step-start", {
      runId: instId, step: next.current_step, phase: "do", failCount: next.fail_count ?? 0,
      ts: Date.now(),
    });
    if (nextWf?.manual_step?.includes(next.current_step)) {
      return {
        text: `${result.text}\n\n---\n\n> 📋 下一步 **${next.current_step}** 是人工审查步骤：模型完成后会停下等你审查批准，届时对话里会出现审查卡片。`,
        completed: false,
        paused: false,
      };
    }
  }
  return { text: result.text, completed: false, paused: false };
}

/** 供 tools/commands 复用的辅助：读单实例的状态快照文本（对齐 opencode 版信息量） */
export function statusText(engine: Engine, instId: string, sessionId?: string | null): string {
  const st = engine.readState(instId);
  if (!st) return `实例 ${instId} 不存在。`;
  const info = engine.listInstances().find((i) => i.id === instId);
  const line: string[] = [`实例 \`${instId}\`（工作流: ${st.workflow_name}）`];
  line.push(`- 状态: ${info ? engine.instanceStatusLabel(info) : st.active ? (st.paused ? "⏸ 已暂停" : "🔨 执行中") : "已结束"}`);
  if (sessionId != null) {
    line.push(`- 属主会话: ${st.session_id === sessionId ? "🟢 本会话" : st.session_id ? `\`${st.session_id.slice(0, 8)}\`` : "无"}`);
  } else if (st.session_id) {
    line.push(`- 属主会话: \`${st.session_id.slice(0, 8)}\``);
  }
  line.push(`- 步骤: ${st.current_step} · 阶段: ${st.current_phase === "do" ? "DO 执行" : "CHECK 验证"} · 失败次数: ${st.fail_count ?? 0}`);
  if (info?.lastActivity) line.push(`- 最后活动: ${engine.formatLastActivity(info.lastActivity)}`);
  // 当前步骤详情
  const wf = engine.loadWorkflow(st.workflow_name);
  const step = wf ? engine.getStep(wf, st.current_step) : null;
  if (wf && step && !isSubWorkflowStep(step)) {
    const s = step as NormalStepDef;
    const detail: string[] = [];
    detail.push(`- 任务: ${(s.do || "").split("\n")[0].trim().slice(0, 80)}`);
    if ((st.fail_count ?? 0) >= s.max_fail_count) detail.push(`  ⚠️ 已达最大失败次数 ${s.max_fail_count}`);
    line.push(...detail);
  }
  if (st.last_failure_reason) {
    const reason = st.last_failure_reason.length > 2000 ? st.last_failure_reason.slice(0, 2000) + "…" : st.last_failure_reason;
    line.push(`- 上次失败原因:\n\n  ${reason.split("\n").join("\n  ")}`);
  }
  // 人工门待审提示
  if (engine.markerExists(MANUAL_GATE_MARKER, instId)) {
    line.push(`\n> 📋 该实例停在人工审查门（步骤 \`${st.current_step}\`）：确认无误后运行 \`/ralphflow-continue\` 批准进入验证；需返工则 \`/ralphflow-reset <意见>\` 打回重做。`);
  }
  // 验证中断检测：phase=check 且无任何登记中的验证者会话 → 进程曾在验证期间重启
  // （先清孤儿登记：kill -9 残留的 live 文件不能让这里永远报「验证进行中」）
  if (!st.paused && st.current_phase === "check" && liveVerifierCount(engine, instId) === 0) {
    line.push(`\n> ⏸ 验证似乎已中断（例如进程重启）。运行 \`/ralphflow-continue\` 恢复验证（已投出的票会保留）。`);
  }
  // 多验证者投票进度
  const progress = readVotingProgress(engine, instId);
  if (progress && progress.stepId === st.current_step && progress.entries.length > 0) {
    line.push(`\n**投票进度**（${progress.stepId}）:`);
    for (const e of progress.entries) {
      const summary = (e.check || "").split("\n")[0].trim().slice(0, 40);
      line.push(`  ${voterStatusLabel(e.status)} 验证者 ${e.index + 1}/${progress.entries.length}${e.model ? ` · ${e.model}` : ""} — ${summary}${e.reason ? `\n      ${e.reason.split("\n")[0].slice(0, 120)}` : ""}`);
    }
  }
  return line.join("\n");
}
