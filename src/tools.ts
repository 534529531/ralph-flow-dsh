/**
 * Ralph Flow for dsh — 工具（ralphflow_*，命名与参数与 opencode 完全一致）
 *
 * 移植自 opencode 版 tools.ts。差异：
 *  - opencode 用 client.tool() 注册；dsh 用 @deepseek-ai/dsh-tools 的 defineTool。
 *  - opencode 用 context.sessionID 定位会话；dsh 用 exec.agent.session（Agent 的
 *    session 即工具调用方的会话）。
 *  - 新增 job 注册/事件发射：start 注册守护 job，事件由 driver/check 内部发射。
 *  - reset/rewind 的"换新会话"语义在 dsh 中由工具返回完整过渡文本承载（当前会话
 *    继续；跨会话接管走 /ralphflow-continue），与 dsh 的会话心智对齐。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Engine, NormalStepDef, SubWorkflowStepDef, RalphFlowState } from "./engine.js";
import { isSubWorkflowStep, MANUAL_GATE_MARKER, DONE_TAG_MARKER } from "./engine.js";
import { statusText, runCheckAndAdvance, type DriveContext } from "./driver.js";
import { createEmitter } from "./events.js";
import type { RalphJobManager } from "./jobs.js";
import { createCheckDeps } from "./deps.js";
import { deleteVotingProgress, readVotingProgress } from "./voting-progress.js";
import { withInstanceLock } from "./mutex.js";
import { liveVerifierCount } from "./check.js";
import { scanSessionLogs, unbrickSessions } from "./session-hygiene.js";
import { CREATE_GUIDE } from "./create.js";
import fs from "fs";
import path from "path";
import os from "os";

export interface ToolContext {
  ctx: Context;
  engine: Engine;
  jobs: RalphJobManager;
  getAgent: (sessionId: string) => Agent | undefined;
}

export type ToolHandler = (args: any, agent: Agent | undefined) => Promise<string> | string;
export type ToolHandlers = Map<string, ToolHandler>;

/** 首次启动时附在返回文本后的引导块：告诉用户接下来的节奏与观察点 */
const ONBOARDING = `\n\n---\n\n## 🧭 接下来会发生什么\n\n1. 模型在本对话执行当前步骤的任务，完成后输出 \`<promise>done</promise>\`。\n2. 完成后自动进入独立验证（多验证者投票），页面顶部 **Ralph Flow** 入口实时显示每一票与当前步骤。\n3. 验证失败会把原因自动发回给模型重做；标记了人工审查的步骤会停下等你批准（届时页头徽标变黄并弹通知）。多数时间你只需等待——随时 \`/ralphflow-status\` 看进度，或点页头入口展开任务列表。`;

export function registerTools(deps: ToolContext): ToolHandlers {
  const { ctx, engine, jobs } = deps;
  const tools = ctx.tools as { register(def: unknown): void };
  const emit = createEmitter({ ctx, engine });
  const handlers: ToolHandlers = new Map();

  const sessionIdOf = (agent: Agent | undefined): string | null => agent?.session?.id ?? null;

  /**
   * 把实例的 UI 事件帧从执行日志重放到当前属主会话（接管场景专用）。
   * 返回是否发生了重放。失败绝不阻断接管流程本身。
   * 注：重放只落审计日志（宿主持久化不接受插件自定义会话帧）；新会话的
   * 可视化档案由页头任务列表（HTTP 状态通道）承载。
   */
  function replayInstanceHistory(instId: string, emitter: ReturnType<typeof createEmitter>, eng: typeof engine): boolean {
    try {
      const frames = eng.readUiEventFrames(instId);
      if (frames.length === 0) return false;
      for (const f of frames) {
        try { emitter.emit(instId, f.type, f.data); } catch {}
      }
      eng.logEvent(instId, "info", "history_replayed", { frames: frames.length });
      return true;
    } catch {
      return false;
    }
  }

  function makeDrive(agent: Agent | undefined, instId: string): DriveContext {
    return {
      engine,
      deps: createCheckDeps({ ctx, engine, emit, getAgent: deps.getAgent, instId }),
      emit,
      parent: agent,
    };
  }

  // ─── ralphflow_start ────────────────────────────────────────────────────────
  const startHandler: ToolHandler = async (args, agent) => {
    const { workflow, task, extra_dirs } = args ?? {};
    if (!workflow || !String(workflow).trim()) {
      return `缺少工作流名称。用法：\`ralphflow_start(workflow, task)\`，或 slash 命令 \`/ralphflow-start <工作流名> <任务描述>\`。可用工作流用 /ralphflow-list 查看。`;
    }
    if (task === undefined || task === null || !String(task).trim()) {
      return `缺少任务描述——请说明要完成什么。\n\n用法示例：\`/ralphflow-start loop 用 JWT 实现用户认证模块\`。`;
    }
    const sessionId = sessionIdOf(agent);
    const instances = engine.listInstances();
    const mine = sessionId != null ? instances.find((i) => i.owner === sessionId) : undefined;
    if (mine) {
      return `当前会话已有活跃工作流实例 \`${mine.id}\`（工作流: ${mine.state.workflow_name}，步骤: ${mine.state.current_step}）。\n\n使用 /ralphflow-continue 继续，或先用 /ralphflow-cancel 取消。`;
    }

    const problems: string[] = [];
    const workflowDef = engine.loadWorkflow(workflow, problems);
    if (!workflowDef) {
      if (problems.length > 0) return `工作流 "${workflow}" 定义无效，无法启动：\n${problems.map((p) => `- ${p}`).join("\n")}\n\n请修复工作流 YAML 后重试（可用 /ralphflow-doctor 看完整诊断）。`;
      const available = engine.listWorkflows();
      return available.length > 0
        ? `工作流 "${workflow}" 未找到。可用工作流：\n${available.map((w) => `- **${w.name}**: ${w.desc}`).join("\n")}`
        : "没有找到工作流。请在 <workspace>/ralph-flow/workflows/ 目录创建工作流定义文件。";
    }
    const firstStep = workflowDef.steps[0];
    if (!firstStep) return "工作流没有步骤。";

    const home = os.homedir() || "";
    const resolvedExtraDirs: string[] = [];
    for (const d of (extra_dirs || [])) {
      let p = String(d).trim();
      if (!p) continue;
      if (p === "~" || p.startsWith("~/")) p = path.join(home, p.slice(1));
      if (!path.isAbsolute(p)) p = path.resolve(engine.projectDir, p);
      let st: fs.Stats | null = null;
      try { st = fs.statSync(p); } catch {}
      if (!st || !st.isDirectory()) return `extra_dirs 校验失败：\`${d}\`（解析为 \`${p}\`）不存在或不是目录。请修正后重新启动。`;
      resolvedExtraDirs.push(p);
    }

    const instId = engine.generateInstanceId(workflow);
    fs.mkdirSync(engine.getInstanceDir(instId), { recursive: true });
    engine.writeArtifactsDirName(instId, String(task));
    engine.writeExtraDirs(instId, resolvedExtraDirs);

    const othersNote = instances.length > 0 ? `\n\n> ℹ️ 本工作区下另有 ${instances.length} 个工作流实例，使用 /ralphflow-status 查看。` : "";
    const extraDirsNote = resolvedExtraDirs.length > 0 ? `\n\n验证器额外可读目录：${resolvedExtraDirs.map((d) => `\`${d}\``).join("、")}` : "";
    const baseState: RalphFlowState = { active: true, workflow_name: String(workflow), current_step: firstStep.id, current_phase: "do", fail_count: 0, user_task: String(task), paused: false, session_id: sessionId ?? undefined };

    const stepsOverview = () => workflowDef.steps.map((s, i) => `  ${i + 1}. **${s.id}**: ${s.desc}${isSubWorkflowStep(s) ? ` (子工作流: ${s.workflow})` : ""}${!isSubWorkflowStep(s) && (s as NormalStepDef).no_check ? " （无独立验证）" : ""}${workflowDef.manual_step?.includes(s.id) ? " 📋人工审查" : ""}`).join("\n");

    if (isSubWorkflowStep(firstStep)) {
      engine.recordStepStart(instId, firstStep.id, "do");
      engine.logEvent(instId, "info", "step_start", { step: firstStep.id, phase: "do" });
      engine.writeState(baseState, instId);
      engine.pushState(baseState, instId);
      const subResult = engine.resolveSubWorkflowEntry(instId, firstStep.workflow, task, firstStep);
      if (subResult.error) {
        try { fs.rmSync(engine.getInstanceDir(instId), { recursive: true, force: true }); } catch {}
        return subResult.text;
      }
      engine.markPromptDelivered(engine.readState(instId)?.current_step || firstStep.id, instId);
      engine.logEvent(instId, "info", "workflow_start", { workflow, instance: instId });
      emit.emit(instId, "tool-ralphflow/run-start", {
        runId: instId, workflow, task,
        steps: workflowDef.steps.map((s) => ({ id: s.id, desc: s.desc })),
      });
      jobs.ensure(instId);
      return `工作流 "${workflow}" 已启动（实例 \`${instId}\`）。\n\n任务：${task}\n\n## 步骤概览\n${stepsOverview()}\n\n启动子工作流：**${firstStep.id}** → ${firstStep.workflow}${extraDirsNote}${othersNote}\n\n---\n\n${subResult.text}${ONBOARDING}`;
    }

    engine.writeState(baseState, instId);
    engine.logEvent(instId, "info", "workflow_start", { workflow, instance: instId });
    engine.recordStepStart(instId, firstStep.id, "do");
    engine.logEvent(instId, "info", "step_start", { step: firstStep.id, phase: "do" });
    if (workflowDef.manual_step && workflowDef.manual_step.includes(firstStep.id)) {
      engine.writeManualStepMarker(instId);
    }
    engine.markPromptDelivered(firstStep.id, instId);
    emit.emit(instId, "tool-ralphflow/run-start", {
      runId: instId, workflow, task,
      steps: workflowDef.steps.map((s) => ({ id: s.id, desc: s.desc })),
    });
    jobs.ensure(instId);
    return `工作流 "${workflow}" 已启动（实例 \`${instId}\`）。\n\n任务：${task}\n\n## 步骤概览\n${stepsOverview()}\n\n开始：**${firstStep.id}** - ${firstStep.desc}${extraDirsNote}${othersNote}\n\n${engine.buildDoPrompt(instId, firstStep as NormalStepDef, String(task))}${ONBOARDING}`;
  };
  handlers.set("ralphflow_start", startHandler);

  // ─── ralphflow_continue ─────────────────────────────────────────────────────
  const continueHandler: ToolHandler = async (args, agent) => {
    const instance = args?.instance;
    const sessionId = sessionIdOf(agent);

    // 预解析仅为取得锁 key（纯读）；接管与全部推进在锁内完成
    const pre = engine.resolveInstance(instance, sessionId);
    if (!pre.ok) return pre.text;

    // 以下分支可能触发异步推进——整段放入实例互斥锁，双会话并发 continue 时串行化
    return withInstanceLock(pre.id, async (): Promise<string> => {
      // 锁内重新解析 + 接管：排队期间实例可能已被取消/易主
      const resolution = engine.resolveInstance(instance, sessionId);
      if (!resolution.ok) return resolution.text;
      const instId = resolution.id;
      const attached = resolution.attached;

      if (attached) {
        const other = engine.listInstances().find((i) => i.id !== instId && i.owner === sessionId);
        if (other) return `当前会话已有活跃工作流实例 \`${other.id}\`。先 /ralphflow-cancel 它，或为该实例指定 \`instance\` 参数接管。`;
        // 转交通知：接管后终态帧只会发给新会话，旧会话那张卡若不显式释放
        // 会永远停在「运行中」变成僵尸（用户看到的「明明跑完了还在转」）。
        const previousOwner = engine.readState(instId)?.session_id ?? null;
        engine.claimOwnership(instId, sessionId);
        if (previousOwner && previousOwner !== sessionId) {
          try {
            emit.emitFinal(instId, previousOwner, "tool-ralphflow/run-detach", {
              runId: instId, workflow: engine.readState(instId)?.workflow_name ?? "",
              reason: "已在另一个会话继续",
            });
          } catch {}
        }
        // 接管即历史重放：本实例的事件帧全发到了旧会话，新会话的对话里没有
        // 任何可导航的卡片。从执行日志回放 UI 帧（client 折叠器幂等），用户
        // 接手的是一本有目录的档案——哪几步过了、谁投的票、为何中断一目了然。
        replayInstanceHistory(instId, emit, engine);
      }

      let state = engine.readState(instId);
      if (!state) return `实例 ${instId} 不存在。`;
      // 工作流定义在锁内加载：排队期间用户可能编辑过 YAML
      const workflow = engine.loadWorkflow(state.workflow_name);
      if (!workflow) return `工作流 "${state.workflow_name}" 未找到。`;

      // 0. archive_failed pause → 上轮完成时报告归档失败（destroyInstance 拒绝
      //    销毁、现场完整保留）：这里只重试归档+销毁并补发终态帧——所有步骤
      //    均已通过，绝不能走重跑验证路径白烧 token。
      if (state.paused && state.pause_reason === "archive_failed") {
        const reportPath = engine.destroyInstance(instId, "completed");
        if (!reportPath) {
          engine.logEvent(instId, "error", "complete_archive_retry_failed", { workflow: state.workflow_name });
          return `## ⚠️ 报告归档仍失败\n\n实例 \`${instId}\` 的最终报告依然写入失败（磁盘满或权限不足）。实例与执行记录继续原样保留。\n\n👉 再次排查磁盘/权限后重试 \`/ralphflow-continue\`；或 \`/ralphflow-cancel\` 放弃归档直接结束。`;
        }
        // 实例已销毁：与 finishTransition 正常完成一致，用锁内快照的属主会话
        // emitFinal 补发 report + run-end done，UI 卡片从「⏸ 已暂停」翻转为完成态。
        const owner = state.session_id ?? null;
        let reportText = "";
        try { reportText = fs.readFileSync(reportPath, "utf-8"); } catch {}
        if (reportText) {
          emit.emitFinal(instId, owner, "tool-ralphflow/report", { runId: instId, text: reportText, reportPath });
        }
        emit.emitFinal(instId, owner, "tool-ralphflow/run-end", { runId: instId, stopReason: "done", reportId: instId });
        jobs.kill(instId);
        engine.logEvent(instId, "info", "workflow_end", { workflow: state.workflow_name, via: "archive_retry" });
        return `## 🎉 工作流完成！\n\n报告归档已重试成功，无需再操作。\n\n执行报告：${path.relative(engine.projectDir, reportPath)}`;
      }

      // 1. check_error pause → 恢复并重跑验证
      if (state.paused && state.pause_reason === "check_error" && state.current_phase === "check") {
        const step = engine.getStep(workflow, state.current_step);
        if (step && !isSubWorkflowStep(step)) {
          engine.writeState({ ...state, paused: false, pause_reason: undefined }, instId);
          engine.logEvent(instId, "info", "check_retry_after_infra_error", { workflow: state.workflow_name, step: step.id });
          jobs.reobserve(instId);
          const result = await runCheckAndAdvance(makeDrive(agent, instId), instId, workflow, step as NormalStepDef, engine.readState(instId)!);
          return result.text || "验证基础设施故障已清除，工作流恢复。";
        }
      }

      // 2. manual gate → 批准后立即跑验证
      if (engine.markerExists(MANUAL_GATE_MARKER, instId)) {
        engine.clearManualStepMarker(instId);
        engine.clearManualGate(instId);
        engine.logEvent(instId, "info", "manual_gate_approved", { step: state.current_step });
        jobs.reobserve(instId);
        const step = engine.getStep(workflow, state.current_step);
        if (step && !isSubWorkflowStep(step)) {
          const result = await runCheckAndAdvance(makeDrive(agent, instId), instId, workflow, step as NormalStepDef, engine.readState(instId)!);
          return result.text || `## ✅ 审查通过\n\n步骤 \`${state.current_step}\` 已批准，验证已自动运行。`;
        }
        if (step && isSubWorkflowStep(step)) {
          // 子工作流的人工门（标在其内部最后一步上）：批准后重新进入该子工作流的推进
          const subResult = engine.resolveSubWorkflowEntry(instId, step.workflow, state.user_task, step as SubWorkflowStepDef);
          if (subResult.error) {
            engine.writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text }, instId);
            return subResult.text;
          }
          engine.markPromptDelivered(engine.readState(instId)?.current_step || step.id, instId);
          return `## ✅ 审查通过\n\n---\n\n${subResult.text}`;
        }
        return `## ✅ 审查通过\n\n步骤 \`${state.current_step}\` 已批准。验证会自动运行。`;
      }

      // 3. paused → 恢复并重发 DO（复合步骤则重新进入子工作流）
      if (state.paused) {
        const previousFailCount = state.fail_count;
        const previousReason = state.last_failure_reason;
        engine.clearReinjectCounter(instId);
        engine.clearDoneTagDetected(instId);
        engine.clearManualGate(instId);
        engine.writeState({ ...state, current_phase: "do", paused: false, pause_reason: undefined, fail_count: 0 }, instId);
        engine.logEvent(instId, "info", "workflow_resumed", { workflow: state.workflow_name, step: state.current_step });
        const step = engine.getStep(workflow, state.current_step);
        if (!step) return `已恢复。当前步骤：${state.current_step}`;
        jobs.reobserve(instId);
        if (isSubWorkflowStep(step)) {
          const subResult = engine.resolveSubWorkflowEntry(instId, step.workflow, state.user_task, step as SubWorkflowStepDef, undefined, previousReason, previousFailCount);
          if (subResult.error) {
            engine.writeState({ ...engine.readState(instId)!, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text }, instId);
            return subResult.text;
          }
          engine.markPromptDelivered(engine.readState(instId)?.current_step || step.id, instId);
          return `## 工作流已恢复\n\n---\n\n${subResult.text}`;
        }
        if (workflow.manual_step && workflow.manual_step.includes(step.id)) engine.writeManualStepMarker(instId);
        const doPrompt = engine.buildDoPrompt(instId, step as NormalStepDef, state.user_task, previousReason, previousFailCount);
        engine.markPromptDelivered(step.id, instId);
        return `## 工作流已恢复\n\n---\n\n${doPrompt}`;
      }

      // 4. crash recovery：卡在 check 无活跃验证
      if (state.current_phase !== "do") {
        if (state.current_phase === "check") {
          // 先清理孤儿登记（进程 kill -9 后 finally 不执行残留的 live 文件），
          // 否则这里会永远认为「验证进行中」而死等。
          if (liveVerifierCount(engine, instId) > 0) {
            return `## ⏳ 验证进行中\n\n步骤 **${state.current_step}** 的独立验证仍在运行。\n\n请等待完成（进度见对话卡与 /ralphflow-status），或使用 /ralphflow-cancel 取消工作流。`;
          }
          // 有本步的投票进度文件（进程曾在验证期间重启）→ 不回退 DO，
          // 直接恢复验证：已投出的票保留，只补跑未完成的票。
          const progress = readVotingProgress(engine, instId);
          const step = engine.getStep(workflow, state.current_step);
          if (progress && progress.stepId === state.current_step && step && !isSubWorkflowStep(step)) {
            engine.logEvent(instId, "warn", "check_resume_after_restart", { step: state.current_step, kept_votes: progress.entries.filter((e) => e.status === "passed").length });
            jobs.reobserve(instId);
            const result = await runCheckAndAdvance(makeDrive(agent, instId), instId, workflow, step as NormalStepDef, { ...engine.readState(instId)!, current_phase: "check" });
            return result.text || "验证已从上次中断处恢复。";
          }
          // 单 check 路径的中断无法续跑 → 回 DO 重做
          const orphans = engine.readAdversarialSessions(instId);
          engine.clearAdversarialSession(instId);
          deleteVotingProgress(engine, instId);
          engine.logEvent(instId, "warn", "crash_recovery", { step: state.current_step, orphan_sessions: orphans.length });
          state = { ...state, current_phase: "do" };
          engine.writeState(state, instId);
          engine.clearReinjectCounter(instId);
          engine.clearManualStepMarker(instId);
          engine.clearManualGate(instId);
          engine.clearDoneTagDetected(instId);
          if (!step) return `崩溃恢复：步骤 "${state.current_step}" 在工作流中未找到。`;
          jobs.reobserve(instId);
          if (isSubWorkflowStep(step)) {
            const subResult = engine.resolveSubWorkflowEntry(instId, step.workflow, state.user_task, step as SubWorkflowStepDef, undefined, "之前的验证被中断（进程崩溃）。请重新执行任务。", state.fail_count || 0);
            if (subResult.error) {
              engine.writeState({ ...engine.readState(instId)!, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text }, instId);
              return subResult.text;
            }
            engine.markPromptDelivered(engine.readState(instId)?.current_step || step.id, instId);
            return `## ⚠️ 崩溃恢复\n\n进程在验证期间崩溃。DO 阶段已重置。\n\n---\n\n${subResult.text}`;
          }
          if (workflow.manual_step && workflow.manual_step.includes(step.id)) engine.writeManualStepMarker(instId);
          const prompt = engine.buildDoPrompt(instId, step as NormalStepDef, state.user_task, "之前的验证被中断（进程崩溃）。请重新执行任务。", state.fail_count || 0);
          engine.markPromptDelivered(step.id, instId);
          return `## ⚠️ 崩溃恢复\n\n进程在验证期间崩溃。DO 阶段已重置。\n\n---\n\n${prompt}`;
        }
        return `当前阶段是 "${state.current_phase}"，不是 "do"。工作流已在处理中。`;
      }

      const step = engine.getStep(workflow, state.current_step);
      if (!step) return `步骤 "${state.current_step}" 未找到。`;

      // 5. attach 接管中断的 DO → 重发 DO（复合步骤重新进入子工作流）
      if (attached && !engine.markerExists(DONE_TAG_MARKER, instId) && !engine.markerExists(MANUAL_GATE_MARKER, instId)) {
        jobs.reobserve(instId);
        if (isSubWorkflowStep(step)) {
          const subResult = engine.resolveSubWorkflowEntry(instId, step.workflow, state.user_task, step as SubWorkflowStepDef, undefined, state.last_failure_reason, state.fail_count || 0);
          if (subResult.error) {
            engine.writeState({ ...state, paused: true, pause_reason: "config_error", last_failure_reason: subResult.text }, instId);
            return subResult.text;
          }
          engine.markPromptDelivered(engine.readState(instId)?.current_step || step.id, instId);
          engine.logEvent(instId, "info", "instance_attached_resume_do", { instance: instId, step: step.id });
          return `## 已接管工作流实例 \`${instId}\`\n\n该实例中断于 DO 阶段，继续执行当前步骤。\n\n---\n\n${subResult.text}`;
        }
        if (workflow.manual_step && workflow.manual_step.includes(step.id)) engine.writeManualStepMarker(instId);
        const prompt = engine.buildDoPrompt(instId, step as NormalStepDef, state.user_task, state.last_failure_reason, state.fail_count || 0);
        engine.markPromptDelivered(step.id, instId);
        engine.logEvent(instId, "info", "instance_attached_resume_do", { instance: instId, step: step.id });
        return `## 已接管工作流实例 \`${instId}\`\n\n该实例中断于 DO 阶段，继续执行当前步骤。\n\n---\n\n${prompt}`;
      }

      // 6. do 阶段无门无暂停 → 无操作
      engine.markPromptDelivered(step.id, instId);
      if (isSubWorkflowStep(step)) {
        return `步骤 \`${state.current_step}\` 是子工作流（复合）步骤，仍在进行中。验证只在内部步骤完成后才开始。`;
      }
      return `步骤 \`${state.current_step}\` 仍在 **DO 阶段**（没有待批准的审查、没有暂停、没有中断的实例），本工具无需操作。验证只在 DO 阶段结束后才开始。\n\n${engine.buildDoNudge(instId, state.current_step)}`;
    });
  };
  handlers.set("ralphflow_continue", continueHandler);

  // ─── ralphflow_status ───────────────────────────────────────────────────────
  const statusHandler: ToolHandler = (args, agent) => {
    const instance = args?.instance;
    const sessionId = sessionIdOf(agent);
    if (instance) {
      const resolution = engine.resolveInstance(instance, sessionId);
      if (!resolution.ok) return resolution.text;
      return statusText(engine, resolution.id, sessionId);
    }
    const instances = engine.listInstances();
    if (instances.length === 0) return "当前没有活跃的工作流实例。";
    // 单实例优先详情（与 opencode 版一致）；多实例逐个详情
    return instances.map((i) => statusText(engine, i.id, sessionId)).join("\n\n");
  };
  handlers.set("ralphflow_status", statusHandler);

  // ─── ralphflow_list ─────────────────────────────────────────────────────────
  const listHandler: ToolHandler = () => {
    const workflows = engine.listWorkflows();
    const instances = engine.listInstances();
    const sections: string[] = [];
    if (workflows.length > 0) {
      sections.push("## 可用工作流");
      sections.push(workflows.map((w) => `- **${w.name}**: ${w.desc}`).join("\n"));
      sections.push(`> 启动：\`/ralphflow-start <工作流名> <任务描述>\`；自定义工作流放到 \`<workspace>/ralph-flow/workflows/<名字>.yaml\`（模板可复制内置定义）。`);
    } else {
      sections.push("## 可用工作流\n（无）\n\n把工作流 YAML 放到 `<workspace>/ralph-flow/workflows/`（或全局 `~/.dsh/ralph-flow/workflows/`）即可被识别；内置 loop/spec 应始终可用——若缺失请运行 /ralphflow-doctor 诊断。");
    }
    if (instances.length > 0) {
      sections.push("## 活跃实例");
      sections.push(instances.map((i) => `- **${i.id}** · ${i.state.workflow_name} · ${i.state.current_step} · ${i.state.paused ? "暂停" : i.state.current_phase === "check" ? "验证中" : "进行中"}`).join("\n"));
    }
    return sections.join("\n\n");
  };
  handlers.set("ralphflow_list", listHandler);

  // ─── ralphflow_cancel ───────────────────────────────────────────────────────
  const cancelHandler: ToolHandler = (args, agent) => {
    const instance = args?.instance;
    const sessionId = sessionIdOf(agent);
    const resolution = engine.resolveInstance(instance, sessionId);
    if (!resolution.ok) return resolution.text;
    // 与锁内推进互斥：取消不能插在 do→check 写入中间（否则状态与已发射帧脱节）
    return withInstanceLock(resolution.id, async (): Promise<string> => {
      // 锁内重新解析：排队期间实例可能已被取消/完成
      const re = engine.resolveInstance(instance, sessionId);
      if (!re.ok) return re.text;
      const instId = re.id;
      const state = engine.readState(instId);
      const ownerNote = re.attached && state?.session_id
        ? `\n\n> ⚠️ 该实例原属另一个会话（\`${state.session_id.slice(0, 8)}\`），你已将其取消。`
        : "";
      engine.logEvent(instId, "warn", "workflow_cancelled", { by_session: sessionId ?? undefined });
      const owner = state?.session_id ?? null;
      // 取消者会话：终态帧必须同时到达实例属主与执行取消的会话——两者经常
      // 不是同一个（接管场景 owner=B、人在 A 取消），只发 owner 会让取消者
      // 自己的对话里那张卡永远收不到收尾。
      const cancellerSession = sessionId ?? null;
      const reportPath = engine.destroyInstance(instId, "cancelled");
      if (!reportPath) {
        // 归档失败 → destroyInstance 已拒绝销毁，现场（含执行记录）完整保留。
        // 但绝不能就此 return：job 不 kill 会悬挂、UI 无帧会永久滞留。让实例
        // 停下来（暂停 + 杀守护 job，kill 内部会中止在飞验证者），并如实发射
        // run-end failed 帧——client 将其折叠为可恢复的「⏸ 已暂停」态。
        if (state) {
          engine.writeState({ ...state, paused: true, pause_reason: "cancel_archive_failed", last_failure_reason: "最终报告归档失败（磁盘满/权限不足？），取消已中止。" }, instId);
        }
        jobs.kill(instId);
        emit.emit(instId, "tool-ralphflow/run-end", { runId: instId, stopReason: "failed" });
        if (cancellerSession && cancellerSession !== engine.readState(instId)?.session_id) {
          emit.emitFinal(instId, cancellerSession, "tool-ralphflow/run-end", { runId: instId, stopReason: "failed" });
        }
        engine.logEvent(instId, "error", "cancel_archive_failed", { workflow: state?.workflow_name });
        return `## ⚠️ 取消未完成\n\n实例 \`${instId}\` 的最终报告归档失败（磁盘满或权限不足），实例与执行记录已原样保留，本次未取消。工作流已暂停。\n\n👉 排查磁盘/权限后重试 \`/ralphflow-cancel\` 彻底删除；改变主意可用 \`/ralphflow-continue\` 放弃取消、恢复运行。`;
      }
      emit.emitFinal(instId, owner, "tool-ralphflow/run-end", { runId: instId, stopReason: "cancelled" });
      if (cancellerSession && cancellerSession !== owner) {
        // 取消者不在属主会话：给取消者也补一帧收尾（去重由 events 层保证）
        emit.emitFinal(instId, cancellerSession, "tool-ralphflow/run-end", { runId: instId, stopReason: "cancelled" });
      }
      jobs.kill(instId);
      return `## 已取消\n\n实例 \`${instId}\` 已取消并归档报告：${path.relative(engine.projectDir, reportPath)}。${ownerNote}`;
    });
  };
  handlers.set("ralphflow_cancel", cancelHandler);

  // ─── ralphflow_rewind ───────────────────────────────────────────────────────
  const rewindHandler: ToolHandler = (args, agent) => {
    const { step: targetStep, reason, keep_session, instance } = args ?? {};
    const sessionId = sessionIdOf(agent);
    if (!reason || !String(reason).trim()) {
      return `回退需要一个原因：为什么回退、重做时要注意什么。\n\n用法：\`/ralphflow-rewind <步骤> <原因>\`，例如 \`/ralphflow-rewind propose API 假设错了，改用 REST 轮询\`。`;
    }
    const reasonStr = String(reason).trim();
    if (!targetStep || !String(targetStep).trim()) {
      return "请指定要回退到的目标步骤 `step`。可用 `/ralphflow-status` 查看当前进度。";
    }
    const targetStepId = String(targetStep).trim();

    const resolution = engine.resolveInstance(instance, sessionId);
    if (!resolution.ok) return resolution.text;

    // 与锁内推进互斥：回退的「读快照→校验→写回 do」绝不能与在飞验证/推进交错
    return withInstanceLock(resolution.id, async (): Promise<string> => {
      // 锁内重新解析 + 重读：排队期间实例可能已被取消/易主/推进
      const re = engine.resolveInstance(instance, sessionId);
      if (!re.ok) return re.text;
      const instId = re.id;
      const attached = re.attached;

      const state = engine.readState(instId);
      if (!state || !state.active) return "没有活跃的工作流。使用 `/ralphflow-start` 启动一个。";

      if (attached) return "该实例的属主是另一个会话。只有属主会话可以回退。先运行 `/ralphflow-continue` 接管该实例，再操作。";

      if (engine.readStateStack(instId).length > 0) {
        return `当前实例在子工作流内运行（工作流 \`${state.workflow_name}\`，步骤 \`${state.current_step}\`）。本版本不支持跨子工作流栈帧回退——请先完成或取消该子工作流（\`/ralphflow-continue\` 或 \`/ralphflow-cancel\`），再回退到父工作流的步骤。`;
      }
      if (!state.paused && state.current_phase !== "do") {
        return `当前阶段是 \`${state.current_phase}\`（独立 CHECK 进行中）。回退只能在 DO 阶段或暂停时操作——请稍候验证完成，或运行 \`/ralphflow-cancel\` 放弃。`;
      }
      if (state.paused && state.current_phase === "check") {
        if (liveVerifierCount(engine, instId) > 0) {
          return `步骤 \`${state.current_step}\` 的独立验证仍在运行。请稍候完成，或运行 \`/ralphflow-cancel\` 放弃后再回退。`;
        }
      }

      const workflow = engine.loadWorkflow(state.workflow_name);
      if (!workflow) return `工作流 "${state.workflow_name}" 未找到。`;

      const target = engine.getStep(workflow, targetStepId);
      if (!target) return `步骤 \`${targetStepId}\` 不在工作流 "${state.workflow_name}" 中。`;
      if (isSubWorkflowStep(target)) return `步骤 \`${targetStepId}\` 是子工作流（复合）步骤，没有 DO/CHECK 阶段，不能回退到它。`;
      if (targetStepId === state.current_step) return `\`${targetStepId}\` 就是当前步骤——重做当前步用 \`/ralphflow-reset\`；rewind 是回退到**上游**已通过步骤。`;
      const passed = engine.passedStepIds(instId, state.workflow_name);
      if (!passed.includes(targetStepId)) {
        const list = passed.length > 0 ? passed.map((s) => `\`${s}\``).join("、") : "（暂无——本工作流还没有步骤通过独立验证）";
        return `只能回退到**本工作流里已通过独立验证**的步骤，\`${targetStepId}\` 不在此列。\n\n本工作流已通过验证的步骤：${list}\n\n可用 \`/ralphflow-status\` 查看当前进度。`;
      }

      const fromStep = state.current_step;
      const wasPaused = state.paused;
      const newState: RalphFlowState = {
        ...state,
        current_step: targetStepId,
        current_phase: "do",
        fail_count: 0,
        paused: false,
        pause_reason: undefined,
        last_failure_reason: undefined,
      };
      engine.writeState(newState, instId);
      engine.clearManualGate(instId);
      engine.clearManualStepMarker(instId);
      engine.clearDoneTagDetected(instId);
      engine.clearReinjectCounter(instId);
      deleteVotingProgress(engine, instId);
      engine.recordStepStart(instId, targetStepId, "do");
      engine.logEvent(instId, "info", "step_start", { step: targetStepId, phase: "do" });
      engine.logEvent(instId, "info", "rewind", { from: fromStep, to: targetStepId, keep_session: !!keep_session, was_paused: !!wasPaused });
      if (workflow.manual_step && workflow.manual_step.includes(targetStepId)) engine.writeManualStepMarker(instId);
      emit.emit(instId, "tool-ralphflow/rewind", { runId: instId, fromStep, toStep: targetStepId, reason: reasonStr });
      const header = wasPaused
        ? `## 已从暂停恢复并回退到步骤 \`${targetStepId}\`\n\n**原因：** ${reasonStr}`
        : `## 已回退到步骤 \`${targetStepId}\`\n\n**原因：** ${reasonStr}`;
      const prompt = engine.buildDoPrompt(instId, target as NormalStepDef, state.user_task, reasonStr, 0);
      engine.markPromptDelivered(targetStepId, instId);
      jobs.reobserve(instId);
      return `${header}\n\n---\n\n${prompt}`;
    });
  };
  handlers.set("ralphflow_rewind", rewindHandler);

  // ─── ralphflow_reset ────────────────────────────────────────────────────────
  const resetHandler: ToolHandler = (args, agent) => {
    const { reason, instance } = args ?? {};
    const sessionId = sessionIdOf(agent);
    const resolution = engine.resolveInstance(instance, sessionId);
    if (!resolution.ok) return resolution.text;
    // 与锁内推进互斥：重置的清标记/发帧不能插在推进中间
    return withInstanceLock(resolution.id, async (): Promise<string> => {
      const re = engine.resolveInstance(instance, sessionId);
      if (!re.ok) return re.text;
      const instId = re.id;
      if (re.attached) return "该实例的属主是另一个会话。只有属主会话可以重置。先运行 `/ralphflow-continue` 接管该实例，再操作。";
      const state = engine.readState(instId);
      if (!state) return `实例 ${instId} 不存在。`;

      if (state.paused) {
        return `实例当前处于暂停状态（${state.pause_reason || "未知原因"}）。重置不会解除暂停。\n\n请先运行 /ralphflow-continue 恢复；恢复后若仍想重做当前步，再运行 /ralphflow-reset。想回退到上游已通过步骤改方向，用 /ralphflow-rewind（它会解除暂停）。`;
      }
      if (state.current_phase !== "do") {
        return `当前处于 ${state.current_phase} 阶段，不能重置（只有 DO 阶段可重置）。等验证结束后再试。`;
      }
      const workflow = engine.loadWorkflow(state.workflow_name);
      if (!workflow) return `工作流 "${state.workflow_name}" 未找到。`;
      const step = engine.getStep(workflow, state.current_step);
      if (!step || isSubWorkflowStep(step)) return `步骤 "${state.current_step}" 无法重置。`;
      engine.clearDoneTagDetected(instId);
      engine.clearReinjectCounter(instId);
      engine.clearManualGate(instId);
      deleteVotingProgress(engine, instId);
      const transitionText = `## 🔄 当前步将重新执行\n\n步骤 \`${state.current_step}\` 会带着下方干净的任务提示重新执行（会话上下文不变，失败计数不清零）${reason ? `\n\n**原因：** ${reason}` : ""}`;
      const prompt = engine.buildDoPrompt(instId, step as NormalStepDef, state.user_task, reason, state.fail_count || 0);
      engine.markPromptDelivered(step.id, instId);
      emit.emit(instId, "tool-ralphflow/reset", { runId: instId, step: state.current_step, reason });
      jobs.reobserve(instId);
      return `${transitionText}\n\n---\n\n${prompt}`;
    });
  };
  handlers.set("ralphflow_reset", resetHandler);

  // ─── ralphflow_doctor ───────────────────────────────────────────────────────
  const doctorHandler: ToolHandler = () => {
    const report = engine.buildDoctorReport();
    // 资源占用（只读提醒）：reports/artifacts/instances/logs/history 都是
    // 只增不减的增长面，长期使用需要人知道积了多大。
    let resourceSection = "";
    try {
      const rfDir = path.join(engine.projectDir, "ralph-flow");
      const walkCount = (d: string): { files: number; bytes: number } => {
        let files = 0, bytes = 0;
        const walk = (dir: string): void => {
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            files++;
            try { bytes += fs.statSync(p).size; } catch {}
          }
        };
        walk(d);
        return { files, bytes };
      };
      const fmtBytes = (b: number): string => (b >= 1 << 20 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
      const reports = walkCount(path.join(rfDir, "reports"));
      const artifacts = walkCount(path.join(rfDir, "artifacts"));
      const instances = walkCount(path.join(rfDir, "instances"));
      let historyLines = 0;
      try { historyLines = fs.readFileSync(path.join(rfDir, "history.jsonl"), "utf-8").split("\n").filter(Boolean).length; } catch {}
      let logBytes = 0;
      try { logBytes = fs.statSync(path.join(rfDir, "logs", "execution.log")).size; } catch {}
      resourceSection = `\n\n## 资源占用\n\n- 报告归档：${reports.files} 个文件（${fmtBytes(reports.bytes)}）\n- 任务产物：${artifacts.files} 个文件（${fmtBytes(artifacts.bytes)}）\n- 活跃实例：${instances.files} 个文件\n- 历史索引：${historyLines} 条 · 运行日志：${fmtBytes(logBytes)}\n\n> reports/artifacts 只增不减，完成后不再被引用——需要时手工归档或删除旧目录。`;
    } catch {}
    // 会话卫生：历史版本 session.append 的自定义帧会砖会话——扫描当前全部
    // 会话存储，把待砖清单并入诊断（防止「会话突然打不开」时才后知后觉）。
    let hygieneSection = "";
    try {
      const infected = scanSessionLogs();
      hygieneSection = infected.length === 0
        ? "\n\n## 会话卫生\n\n✅ 所有会话日志干净（无插件自定义事件帧，无砖化风险）。"
        : `\n\n## 会话卫生\n\n⚠️ 以下 ${infected.length} 个会话日志含插件自定义事件帧，重启 dsh 后可能无法打开：\n${infected.map((e) => `- \`${path.relative(path.join(os.homedir(), ".dsh"), e.file)}\`：${e.count} 帧（${e.types.join("、")}）`).join("\n")}\n\n→ 运行 \`/ralphflow-unbrick\` 一键备份并移除（风险：改前自动备份）。`;
    } catch (e) {
      hygieneSection = `\n\n> 会话卫生检查失败：${e instanceof Error ? e.message : String(e)}`;
    }
    return `${report}${resourceSection}${hygieneSection}`;
  };
  handlers.set("ralphflow_doctor", doctorHandler);

  // ─── ralphflow_unbrick ──────────────────────────────────────────────────────
  // 会话解砖：备份并移除会话日志中的插件自定义事件帧（历史版本 session.append
  // 的遗留；继续留存的帧会在下次重启 dsh 时让整个会话无法加载）。
  const unbrickHandler: ToolHandler = () => {
    try {
      const infected = scanSessionLogs();
      if (infected.length === 0) {
        return "✅ 所有会话日志干净，无需解砖。";
      }
      const result = unbrickSessions();
      const head = result.fixed > 0
        ? `已修复 ${result.fixed} 个会话（备份在 \`${result.backupRoot}\`）：\n${result.fixedFiles.map((f) => `- ${f}`).join("\n")}`
        : "没有可修复的会话（检查失败的见下）。";
      const errors = result.errors.length > 0
        ? `\n\n⚠️ 注意：\n${result.errors.map((e) => `- ${e}`).join("\n")}`
        : "";
      const note = "重启 dsh 后这些会话应可正常打开。若仍有问题，用备份目录还原。";
      return `${head}${errors}\n\n${note}`;
    } catch (e) {
      return `解砖失败：${e instanceof Error ? e.message : String(e)}`;
    }
  };
  handlers.set("ralphflow_unbrick", unbrickHandler);

  // ─── ralphflow_create ───────────────────────────────────────────────────────
  // 模型侧入口：返回完整设计指引（dsh 命令通道 log-only，指引只能经工具到达模型）
  const createHandler: ToolHandler = () => CREATE_GUIDE;
  handlers.set("ralphflow_create", createHandler);

  // ─── 注册为 dsh 工具 ────────────────────────────────────────────────────────
  const register = (name: string, description: string, parameters: Record<string, any>, handler: ToolHandler) => {
    tools.register(defineTool({
      name,
      description,
      parameters,
      output: {
        schema: { type: "string" },
        render: (args: Record<string, unknown>, value: string) => [{ type: "text", text: value }],
      },
      async execute(args: any, exec: any) {
        return handler(args ?? {}, exec?.agent);
      },
    }));
  };

  register("ralphflow_start", "启动一个工作流实例。需提供工作流名称和任务描述。同一工作区下多个会话可各自运行自己的实例。", {
    workflow: { type: "string", required: true, description: "工作流名称（用 ralphflow_list 查看可用工作流）" },
    task: { type: "string", required: true, description: "任务描述——需要完成什么" },
    extra_dirs: { type: "array", items: { type: "string" }, description: "任务源材料所在的、项目目录之外的目录（绝对路径或 ~/...）。验证者会获得只读访问；每个目录必须存在，否则拒绝启动。" },
  }, startHandler);
  register("ralphflow_continue", "批准手动审查 / 恢复暂停的工作流 / 接管中断的实例。验证由后台 job 自动进行。（可选实例 id，支持唯一前缀。）", {
    instance: { type: "string", description: "实例 id（支持唯一前缀）。仅在从新会话接管特定实例时需要。" },
  }, continueHandler);
  register("ralphflow_status", "查看本会话的实例、指定实例，或全部实例。", {
    instance: { type: "string", description: "实例 id（支持唯一前缀）。不传时显示全部活跃实例。" },
  }, statusHandler);
  register("ralphflow_list", "列出可用工作流与活跃实例。", {}, listHandler);
  register("ralphflow_cancel", "取消实例（先归档报告）。", {
    instance: { type: "string", description: "实例 id（支持唯一前缀）。" },
  }, cancelHandler);
  register("ralphflow_rewind", "回退到一个在本工作流里已通过独立 CHECK 的上游步骤，重做该步及后续。状态机倒退、fail_count 归零、清除暂停；下游已落盘产物保留（不删除）。reason 必填。", {
    step: { type: "string", required: true, description: "目标步骤 id——必须是本工作流里已通过独立 CHECK 的上游步骤（用 /ralphflow-status 查看）" },
    reason: { type: "string", required: true, description: "回退原因（必填）：为什么回退、重做时要注意什么。会拼到新会话首条 DO 提示前。" },
    keep_session: { type: "boolean", description: "可选，默认 false；dsh 版始终在当前会话继续，此参数保留兼容。仅倒退状态机。" },
    instance: { type: "string", description: "实例 id（支持唯一前缀）。" },
  }, rewindHandler);
  register("ralphflow_reset", "当前会话上下文脏了/跑偏时，只重置当前步的上下文——重新注入干净的 DO 提示重做当前步（状态机不动，失败计数不赦免）。", {
    reason: { type: "string", description: "可选的重置原因——来自用户，说明为什么重置、重做时要注意什么。会拼到新会话首条 DO 提示前。" },
    instance: { type: "string", description: "实例 id（支持唯一前缀）。" },
  }, resetHandler);
  register("ralphflow_doctor", "诊断所有工作流定义和实例状态：完整的校验错误列表、被静默跳过的步骤、不可达步骤、无法解析的模板记号、损坏的子工作流引用与环、项目/插件遮蔽、被忽略的非工作流 YAML，以及损坏的实例状态。另含会话卫生检查：扫描会话日志中的插件自定义事件帧（重启后可能打不开会话的隐患）。只读。", {}, doctorHandler);
  register("ralphflow_create", "交互式创建一个自定义工作流：返回完整的设计指引（YAML 结构、硬规则、最佳实践）。当用户想新建工作流时调用，然后按指引与用户逐步确认设计、写入 YAML 并用 ralphflow_doctor 校验到可启动。", {}, createHandler);
  register("ralphflow_unbrick", "会话解砖：备份并移除会话日志中的插件自定义事件帧（历史版本 session.append 的遗留——继续留存会在下次重启 dsh 时让整个会话无法加载）。改前自动备份到 sessions/ralphflow-unbrick-backup-<ts>/。", {}, unbrickHandler);

  return handlers;
}
