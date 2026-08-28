/**
 * Ralph Flow for dsh — CLIENT 端入口
 *
 * 注册：conversationEvents 折叠器（kind 'ralphflow-run'）+ conversation.chat.node
 * keyed 渲染器 + conversation.session.header.actions 页头入口 + locale 词典。
 * 全程只加不换，不碰外壳/侧栏/输入区。
 */
import { RALPHFLOW_RUN_KIND, RALPHFLOW_COMMAND_KIND, createDefinition, createCommandDefinition } from "./definition.js";
import { RalphRunCard } from "./RunCard.js";
import { RalphCommandCard } from "./CommandCard.js";
import { HeaderAction } from "./HeaderAction.js";
import { primeNotifications } from "./notify.js";
import { startHttpPolling } from "./http-state.js";
import { startNotifyWatch } from "./notify-watch.js";

export const name = "ralphflow-client";
export const inject = ["conversationEvents", "slots", "sessions", "locale"];

const NS = "ralphflow";

const zh = {
  "run.running": "进行中",
  "run.check": "验证中",
  "run.gate": "待审查",
  "run.done": "已完成",
  "run.failed": "已失败",
  "run.cancelled": "已取消",
  "run.paused": "⏸ 已暂停",
  "run.paused.hint": "工作流已暂停（验证未通过或达到失败上限）——这不是终点：修复问题后即可继续，已完成的工作全部保留。",
  "run.paused.hint.checkfailed": "这一步的验证没有通过，工作流停在这里等你。已完成的工作全部保留：点「继续」让模型带着失败原因重做，或用 /ralphflow-rewind 回退到更早的步骤。",
  "run.resume": "继续",
  "run.approve": "通过",
  "run.return": "打回",
  "run.return.opinion": "打回意见（会随命令发给模型）",
  "run.return.placeholder": "例如：边界情况没覆盖，测试全挂了，请先修 CI 再交付…",
  "run.return.send": "发送打回",
  "run.cancel.action": "取消",
  "run.chip.tests": "测试没过，请先修复",
  "run.chip.scope": "偏离需求范围，请对照原始任务",
  "run.chip.quality": "质量不达标，请自查后重新提交",
  "run.hint.approve": "已把 /ralphflow-continue 填入输入框并尝试发送——若未发出，按回车即批准进入验证。",
  "run.hint.return": "已在输入框填入 /ralphflow-reset——在后面补上你的修改意见再回车，模型会据此返工（不会自动发送）。",
  "run.hint.returned": "打回意见已发送，模型会按你的意见返工本步骤。",
  "run.gate.requirement": "本步要求（审批材料）",
  "run.verifier": "验证者 {v}/{count}",
  "run.voter.queued": "排队中",
  "run.voter.running": "运行中",
  "run.voter.retrying": "重试中",
  "run.votes": "独立验证 · 已收 {done}/{total} 票",
  "run.timeout.left": "超时上限 {min} 分钟",
  "run.timeout.near": "接近超时上限——超时后自动暂停，已投出的票保留",
  "run.waiting.start": "正在等待模型开始执行…{step}",
  "run.pass": "通过",
  "run.fail": "未通过",
  "run.infra": "环境故障",
  "run.check.passed": "验证通过",
  "run.check.failed": "验证未通过",
  "run.rewind": "↩ 回退 {from} → {to}",
  "run.report": "最终报告",
  "run.elapsed.title": "当前步骤已运行时长",
  "status.done": "已完成",
  "status.cancelled": "已取消",
  "status.failed": "已暂停",
  "status.gate": "待审查",
  "status.check": "验证中",
  "status.do": "进行中",
  "status.detached": "已转交",
  "run.hide": "关闭这张卡片",
  "run.detached": "此工作流已在另一个会话继续——本卡仅保留历史，不再更新。",
  "drawer.ended.more": "…以及更早的 {n} 条",
  "drawer.cancel.confirm": "确认取消？",
  "drawer.cancel.back": "返回",
  "drawer.report": "报告",
  "drawer.timeleft": "剩余 {t}",
  "drawer.timeout": "已超时，等待自动暂停",
  "header.aria": "Ralph Flow：{live} 运行中，{gate} 待审查，{fail} 已暂停",
  "header.list": "Ralph Flow 任务列表",
  "drawer.live": "进行中",
  "drawer.todo": "待处理",
  "drawer.owner": "属主",
  "drawer.owner.me": "本会话",
  "drawer.gate.todo": "审查要求",
  "voter.status.pending": "排队中",
  "voter.status.running": "运行中",
  "voter.status.passed": "通过",
  "voter.status.failed": "未通过",
  "voter.status.infra_pending": "环境重试",
  "voter.status.infra_failed": "环境故障",
  "voter.status.cancelled": "已取消",
  "drawer.ended": "已结束",
  "drawer.step.prefix": "▸",
  "drawer.locate": "定位到对话",
  "drawer.detail": "状态详情",
  "command.error": "出错",
  "command.running": "执行中…",
  "run.hint.approved": "已提交，进度将实时更新。",
  "drawer.collapse": "收起详情",
  "drawer.task": "任务",
  "drawer.pausereason": "暂停原因",
  "drawer.failreason": "失败原因",
  "drawer.voters": "验证者",
  "coldstart.aria": "Ralph Flow：工作流引擎（点击查看上手引导）",
  "coldstart.title": "开始使用 Ralph Flow",
  "coldstart.desc": "DO→CHECK 状态机工作流：模型执行任务，独立验证者对抗检查，失败自动返工，关键步骤停下等你审查。",
  "coldstart.try.loop": "/loop <任务描述> — 迭代执行直到验证通过",
  "coldstart.try.list": "/ralphflow-list — 查看可用工作流",
};

const en = {
  "run.running": "Running",
  "run.check": "Verifying",
  "run.gate": "Pending review",
  "run.done": "Completed",
  "run.failed": "Failed",
  "run.cancelled": "Cancelled",
  "run.paused": "⏸ Paused",
  "run.paused.hint": "The workflow is paused (a check failed or the retry limit was reached) — this is not the end: fix the issue and continue; all completed work is preserved.",
  "run.paused.hint.checkfailed": "The check for this step did not pass and the workflow is waiting for you. All finished work is preserved: click Resume to let the model redo it with the failure reasons, or use /ralphflow-rewind to go back to an earlier step.",
  "run.resume": "Resume",
  "run.approve": "Approve",
  "run.return": "Send back",
  "run.return.opinion": "Change request (sent to the model with the command)",
  "run.return.placeholder": "e.g. edge cases not covered, tests are broken — fix CI first…",
  "run.return.send": "Send back",
  "run.cancel.action": "Cancel",
  "run.chip.tests": "Tests failing — fix them first",
  "run.chip.scope": "Drifted off-scope — recheck the original task",
  "run.chip.quality": "Quality below bar — self-review and resubmit",
  "run.hint.approve": "/ralphflow-continue filled into the composer and submit attempted — press Enter if it was not sent to approve verification.",
  "run.hint.return": "/ralphflow-reset filled into the composer — append your change request, then press Enter yourself (it is never auto-sent).",
  "run.hint.returned": "Change request sent — the model will redo this step accordingly.",
  "run.gate.requirement": "Step requirement (review material)",
  "run.verifier": "Verifier {v}/{count}",
  "run.voter.queued": "Queued",
  "run.voter.running": "Running",
  "run.voter.retrying": "Retrying",
  "run.votes": "Independent check · {done}/{total} votes in",
  "run.timeout.left": "Timeout cap {min} min",
  "run.timeout.near": "Near the timeout cap — it will auto-pause; votes already cast are kept",
  "run.waiting.start": "Waiting for the model to start…{step}",
  "run.pass": "PASS",
  "run.fail": "FAIL",
  "run.infra": "Infra error",
  "run.check.passed": "Check passed",
  "run.check.failed": "Check failed",
  "run.rewind": "↩ Rewound {from} → {to}",
  "run.report": "Final report",
  "run.elapsed.title": "Time elapsed on current step",
  "status.done": "Done",
  "status.cancelled": "Cancelled",
  "status.failed": "Paused",
  "status.gate": "Pending review",
  "status.check": "Verifying",
  "status.do": "Running",
  "status.detached": "Handed off",
  "run.hide": "Dismiss this card",
  "run.detached": "This workflow continues in another session — this card keeps history only and will not update.",
  "drawer.ended.more": "…and {n} earlier entries",
  "drawer.cancel.confirm": "Confirm cancel?",
  "drawer.cancel.back": "Back",
  "drawer.report": "Report",
  "drawer.timeleft": "{t} left",
  "drawer.timeout": "Timed out — auto-pausing",
  "header.aria": "Ralph Flow: {live} running, {gate} pending review, {fail} paused",
  "header.list": "Ralph Flow task list",
  "drawer.live": "In progress",
  "drawer.todo": "Needs attention",
  "drawer.owner": "Owner",
  "drawer.owner.me": "This session",
  "drawer.gate.todo": "Review requirement",
  "voter.status.pending": "Queued",
  "voter.status.running": "Running",
  "voter.status.passed": "Passed",
  "voter.status.failed": "Failed",
  "voter.status.infra_pending": "Infra retry",
  "voter.status.infra_failed": "Infra error",
  "voter.status.cancelled": "Cancelled",
  "drawer.ended": "Ended",
  "drawer.step.prefix": "▸",
  "drawer.locate": "Locate in chat",
  "drawer.detail": "Status detail",
  "command.error": "Error",
  "command.running": "Running…",
  "run.hint.approved": "Submitted — progress updates live.",
  "drawer.collapse": "Collapse details",
  "drawer.task": "Task",
  "drawer.pausereason": "Pause reason",
  "drawer.failreason": "Failure reason",
  "drawer.voters": "Verifiers",
  "coldstart.aria": "Ralph Flow: workflow engine (click for onboarding)",
  "coldstart.title": "Get started with Ralph Flow",
  "coldstart.desc": "DO→CHECK state-machine workflows: the model does the work, independent verifiers adversarially check it, failures loop back automatically, and key steps pause for your review.",
  "coldstart.try.loop": "/loop <task> — iterate until verification passes",
  "coldstart.try.list": "/ralphflow-list — list available workflows",
};

export function apply(ctx: any): void {
  // 0. HTTP 状态轮询（UI 主数据源：替代已废弃的会话帧通道）+ 全局通知/快照
  //    监视（不依赖任何组件挂载：空态页/其它会话时审查门也能提醒）+ 权限预热
  try { startHttpPolling(); } catch {}
  try { startNotifyWatch(); } catch {}
  try { primeNotifications(); } catch {}

  // 1. 事件折叠器（host 的 tool-ralphflow/* 帧 → 持久对话节点）
  ctx.conversationEvents.register(createDefinition());
  // 1b. 命令结果折叠器（/ral 的 opencode 式反馈 → 独立可见结果卡）
  ctx.conversationEvents.register(createCommandDefinition());

  // 2. locale 词典
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ralphflow:dictionaries");

  // 3. 对话内嵌卡（keyed chat node）
  ctx.slots.inject("conversation.chat.node", () =>
    ctx.slots.register({
      name: "conversation.chat.node",
      key: RALPHFLOW_RUN_KIND,
      locale: NS,
      inject: () => ({
        openFile: (path: string) => {
          try { window.open(path, "_blank"); } catch {}
        },
      }),
    }, RalphRunCard),
  );

  // 3b. 命令结果卡（独立 keyed 节点）
  ctx.slots.inject("conversation.chat.node", () =>
    ctx.slots.register({
      name: "conversation.chat.node",
      key: RALPHFLOW_COMMAND_KIND,
      locale: NS,
    }, RalphCommandCard),
  );

  // 4. 页头入口（无任务时不渲染）
  ctx.slots.inject("conversation.session.header.actions", () =>
    ctx.slots.register({
      name: "conversation.session.header.actions",
      id: "ralphflow-header",
      locale: NS,
      order: 100,
    }, HeaderAction),
  );

  // 5. 页面级命令转发：卡片/弹层发出的 ralphflow:command 事件 → 注入输入框。
  // dsh composer 有内部 claim 机制，插件无法安全代提交；这里填入命令后尝试
  // 触发一次 Enter keydown（composer 若监听该键即直接发出），失败时输入框里
  // 保留命令文本，用户回车即可——绝不静默丢弃。
  try {
    const findComposer = (): HTMLTextAreaElement | undefined =>
      (document.querySelector<HTMLTextAreaElement>("textarea[data-dsh-composer]")
        ?? document.querySelector<HTMLTextAreaElement>(".composer textarea")
        ?? document.querySelector<HTMLTextAreaElement>("textarea")) as HTMLTextAreaElement | undefined;
    const onCommand = (e: Event) => {
      const detail = (e as CustomEvent).detail as { command?: string; autoSubmit?: boolean } | undefined;
      if (!detail?.command) return;
      const input = findComposer();
      if (!input) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) setter.call(input, detail.command);
      else input.value = detail.command;
      input.focus();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      // autoSubmit=false（「打回」按钮）只填充绝不代提交：用户必须先补上修改
      // 意见再自己回车，防止空意见的 reset 被抢发导致盲目返工。
      if (detail.autoSubmit === false) return;
      // 尝试代提交：React 在 root 上监听原生 keydown，合成 Enter 通常可触发
      const opts = { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true } as KeyboardEventInit & { keyCode?: number };
      input.dispatchEvent(new KeyboardEvent("keydown", opts));
      input.dispatchEvent(new KeyboardEvent("keyup", opts));
    };
    window.addEventListener("ralphflow:command", onCommand);
    ctx.effect(() => () => window.removeEventListener("ralphflow:command", onCommand), "ralphflow:command-bridge");
  } catch {}
}