/**
 * 只读查看器：右侧栏一个 tab，按工作流查看 Flow 步骤链或 Graph DAG。
 *
 * 边界（design §5）：没有启动、暂停、取消、审批、产物写入或运行选择控制；数据来自同一个
 * `ralphflowStatus` 只读流（与状态胶囊同源），不新开轮询、不碰运行状态。
 *
 * 视觉参考 RalphGraph 的只读工作图：一个工作流选择器 + 默认列表（Graph 可切依赖图画布）
 * + 节点/步骤 inspector；所有颜色、边框、状态色走 dsh 原生 token。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Menu, type MenuEntry } from "@deepseek-ai/dsh-client-ui-primitives";
import type { Context } from "@deepseek-ai/cordis";
import type { GraphStatusNode, ViewerAsset, ViewerAssetNode, ViewerAssetStep, WorkflowStatus } from "../status-contract.js";
import type { ClientStatus } from "./status-source.js";
import { flowPanelStatus, flowPhaseChips, graphAssetChips, graphPhaseChips, statusToneOf, type PhaseChip } from "./phase.js";
import { assetMenuLabel, pickAssetName } from "./selection.js";

export const VIEWER_TAB_ID = "ralphflow-viewer";
export const VIEWER_KIND = "ralphflow-viewer";

type Source = {
  getSnapshot(): ClientStatus;
  subscribe(listener: () => void): () => void;
  dispose(): void;
};

type Props = { sessionId: string; source: Source };
type ViewMode = "columns" | "outline";

const ASSET_STORAGE_KEY = "ralphflow:viewer:asset";
const VIEW_STORAGE_KEY = "ralphflow:viewer:view";

const COLUMN_GAP = 16;
const MIN_CARD_WIDTH = 190;
const MAX_CARD_WIDTH = 252;
const CARD_HEIGHT = 168;
const ROW_STEP = 184;
const CANVAS_TOP = 36;

const STAGE_LABELS: Record<WorkflowStatus["stage"], string> = {
  executing: "执行中",
  verifying: "独立验证中",
  gate: "等待你审查",
  paused: "已暂停",
  switching: "切换中",
  done: "已完成",
  cancelled: "已取消",
  failed: "失败",
  unavailable: "不可用",
};

const css = `
.ralphflow-viewer {
  --rv-ink: var(--dsw-alias-label-primary);
  --rv-muted: var(--dsw-alias-label-secondary);
  --rv-faint: var(--dsw-alias-label-tertiary);
  --rv-line: var(--dsw-alias-border-l1);
  --rv-line-strong: var(--dsw-alias-border-l2);
  /* 品牌色是黑白中性色：拿它当主色，整张工作图会退化成黑白线稿。焦点色用业务蓝。 */
  --rv-run: var(--dsw-alias-state-business-primary);
  --rv-wait: var(--dsw-alias-state-warn-primary);
  --rv-fault: var(--dsw-alias-state-error-primary);
  --rv-done: var(--dsw-alias-state-success-primary);
  --rv-accent: var(--rv-run);
  --rv-track: color-mix(in srgb, var(--rv-muted) 11%, transparent);
  --rv-panel: var(--dsw-alias-bg-layer-1);
  --rv-card: var(--dsw-alias-bg-layer-2);
  --rv-shadow: color-mix(in srgb, var(--rv-ink) 10%, transparent);
  /* 状态底色：和主题卡片混色，亮/暗两套主题各自成立，不写死黑白色值。 */
  --rv-run-wash: color-mix(in srgb, var(--rv-run) 15%, var(--rv-card));
  --rv-wait-wash: color-mix(in srgb, var(--rv-wait) 14%, var(--rv-card));
  --rv-done-wash: color-mix(in srgb, var(--rv-done) 11%, var(--rv-card));
  --rv-fault-wash: color-mix(in srgb, var(--rv-fault) 13%, var(--rv-card));
  --rv-mono: ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", monospace;
  box-sizing: border-box;
  display: grid;
  align-content: start;
  gap: 14px;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  min-height: 100%;
  padding: 16px 14px 28px;
  overflow-x: hidden;
  background: linear-gradient(180deg, color-mix(in srgb, var(--rv-run) 5%, transparent), transparent 240px);
  color: var(--rv-ink);
  font-size: var(--dsh-content-font-size-secondary, 12.5px);
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
.ralphflow-viewer * { box-sizing: border-box; }
.ralphflow-viewer .rv-mono { font-family: var(--rv-mono); }
.ralphflow-viewer .rv-head { display: grid; gap: 8px; min-width: 0; max-width: 100%; }
.ralphflow-viewer .rv-kicker { display: inline-flex; align-items: center; gap: 6px; color: var(--rv-muted); font: 9.5px/1.4 var(--rv-mono); letter-spacing: .09em; text-transform: uppercase; }
.ralphflow-viewer .rv-kicker::before { content: ""; width: 6px; height: 6px; border-radius: 2px; background: var(--rv-accent); }
.ralphflow-viewer .rv-title-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; padding-bottom: 7px; border-bottom: 1px solid color-mix(in srgb, var(--rv-run) 14%, var(--rv-line)); }
.ralphflow-viewer .rv-title { margin: 0; min-width: 0; font-size: 20px; line-height: 1.28; font-weight: 650; letter-spacing: -.014em; text-wrap: balance; overflow-wrap: anywhere; }
.ralphflow-viewer .rv-kind { flex: none; display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 999px; background: color-mix(in srgb, var(--rv-run) 10%, var(--rv-track)); color: color-mix(in srgb, var(--rv-run) 55%, var(--rv-ink)); font: 9.5px/1 var(--rv-mono); font-weight: 650; letter-spacing: .05em; text-transform: uppercase; }
.ralphflow-viewer .rv-meta { margin: 0; color: var(--rv-muted); font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
.ralphflow-viewer .rv-desc { margin: 0; color: var(--rv-muted); font-size: 11.5px; line-height: 1.6; text-wrap: pretty; overflow-wrap: anywhere; }
.ralphflow-viewer .rv-summary { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 1px; }
.ralphflow-viewer .rv-summary-item { display: inline-flex; align-items: baseline; gap: 4px; padding: 2px 8px; border-radius: 999px; background: var(--rv-track); color: var(--rv-muted); font-size: 10px; line-height: 1.6; white-space: nowrap; }
.ralphflow-viewer .rv-summary-item strong { color: var(--rv-ink); font-weight: 700; font-variant-numeric: tabular-nums; }
.ralphflow-viewer .rv-summary-item[data-tone="done"] { background: color-mix(in srgb, var(--rv-done) 14%, transparent); color: var(--rv-done); }
.ralphflow-viewer .rv-summary-item[data-tone="done"] strong { color: var(--rv-done); }
.ralphflow-viewer .rv-summary-item[data-tone="run"] { background: color-mix(in srgb, var(--rv-run) 13%, transparent); color: var(--rv-run); }
.ralphflow-viewer .rv-summary-item[data-tone="run"] strong { color: var(--rv-run); }
.ralphflow-viewer .rv-summary-item[data-tone="wait"] { background: color-mix(in srgb, var(--rv-wait) 15%, transparent); color: var(--rv-wait); }
.ralphflow-viewer .rv-summary-item[data-tone="wait"] strong { color: var(--rv-wait); }
.ralphflow-viewer .rv-summary-item[data-tone="fault"] { background: color-mix(in srgb, var(--rv-fault) 13%, transparent); color: var(--rv-fault); }
.ralphflow-viewer .rv-summary-item[data-tone="fault"] strong { color: var(--rv-fault); }
.ralphflow-viewer .rv-callout { padding: 8px 10px; border-radius: 10px; background: color-mix(in srgb, var(--rv-wait) 10%, var(--rv-panel)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rv-wait) 28%, var(--rv-line)); color: var(--rv-ink); font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
.ralphflow-viewer .rv-callout strong { color: var(--rv-wait); font-weight: 650; }
.ralphflow-viewer .rv-toolbar { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 4px 6px 4px 9px; border-radius: 11px; background: var(--rv-panel); box-shadow: inset 0 0 0 1px var(--rv-line); }
.ralphflow-viewer .rv-select-label { flex: none; color: var(--rv-faint); font: 9.5px/1.4 var(--rv-mono); letter-spacing: .07em; text-transform: uppercase; }
.ralphflow-viewer .rv-picker { display: flex; flex: 1; min-width: 0; }
.ralphflow-viewer .rv-picker-trigger { display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; min-width: 0; height: 30px; padding: 0 8px 0 4px; border: 0; border-radius: 7px; background: transparent; color: var(--rv-ink); font-family: inherit; font-size: 12px; line-height: 1.4; font-weight: 550; cursor: pointer; }
.ralphflow-viewer .rv-picker-trigger:hover { background: var(--rv-track); }
.ralphflow-viewer .rv-picker-trigger:focus-visible { outline: 2px solid var(--rv-accent); outline-offset: 1px; }
.ralphflow-viewer .rv-picker-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ralphflow-viewer .rv-picker-chevron { flex: none; color: var(--rv-muted); }
.ralphflow-viewer .rv-switch { flex: none; display: inline-flex; gap: 2px; padding: 2px; border-radius: 9px; background: var(--rv-panel); box-shadow: inset 0 0 0 1px var(--rv-line); }
.ralphflow-viewer .rv-switch button { display: inline-flex; align-items: center; justify-content: center; min-width: 38px; height: 28px; padding: 0 9px; border: 0; border-radius: 7px; background: transparent; color: var(--rv-muted); font-family: inherit; font-size: 11px; line-height: 1; font-weight: 550; cursor: pointer; transition: background-color .16s ease, color .16s ease, box-shadow .16s ease, transform .12s ease; }
.ralphflow-viewer .rv-switch button:hover { background: var(--rv-track); color: var(--rv-ink); }
.ralphflow-viewer .rv-switch button:active { transform: scale(.96); }
.ralphflow-viewer .rv-switch button[aria-pressed="true"] { background: color-mix(in srgb, var(--rv-run) 12%, var(--rv-card)); color: var(--rv-ink); box-shadow: 0 1px 2px var(--rv-shadow), inset 0 0 0 1px color-mix(in srgb, var(--rv-run) 24%, var(--rv-line-strong)); }
.ralphflow-viewer .rv-switch button:focus-visible { outline: 2px solid var(--rv-accent); outline-offset: 1px; }
.ralphflow-viewer .rv-banner { padding: 8px 10px; border-radius: 10px; background: var(--rv-panel); box-shadow: inset 0 0 0 1px var(--rv-line); color: var(--rv-muted); font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.ralphflow-viewer .rv-banner[data-kind="error"] { background: color-mix(in srgb, var(--rv-fault) 10%, var(--rv-panel)); color: var(--rv-ink); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--rv-fault) 32%, var(--rv-line)); }
.ralphflow-viewer .rv-empty { display: grid; gap: 7px; padding: 34px 18px; border-radius: 14px; background: var(--rv-panel); box-shadow: inset 0 0 0 1px var(--rv-line); color: var(--rv-muted); text-align: center; font-size: 11.5px; line-height: 1.65; text-wrap: pretty; }
.ralphflow-viewer .rv-empty strong { color: var(--rv-ink); font-size: 12.5px; font-weight: 650; }
.ralphflow-viewer .rv-canvas-wrap, .ralphflow-viewer .rv-toolbar, .ralphflow-viewer .rv-inspector, .ralphflow-viewer .rv-flow { min-width: 0; max-width: 100%; }
.ralphflow-viewer .rv-canvas-hint { padding: 7px 2px 0; color: var(--rv-faint); font: 9.5px/1.4 var(--rv-mono); letter-spacing: .04em; text-align: center; }
.ralphflow-viewer .rv-canvas-wrap { overflow: auto; scrollbar-width: thin; scrollbar-color: color-mix(in srgb, var(--rv-muted) 38%, transparent) transparent; overscroll-behavior-x: contain; border-radius: 14px; background: var(--rv-panel); box-shadow: inset 0 0 0 1px var(--rv-line); }
.ralphflow-viewer .rv-canvas { position: relative; background-color: var(--rv-panel); background-image: radial-gradient(900px 420px at 8% -12%, color-mix(in srgb, var(--rv-run) 16%, transparent), transparent 62%), radial-gradient(680px 340px at 100% -8%, color-mix(in srgb, var(--rv-wait) 10%, transparent), transparent 58%), radial-gradient(circle at 1px 1px, color-mix(in srgb, var(--rv-run) 22%, transparent) 1px, transparent 0); background-size: auto, auto, 20px 20px; }
.ralphflow-viewer .rv-edge { fill: none; stroke: color-mix(in srgb, var(--rv-run) 24%, var(--rv-line)); stroke-width: 1.5; stroke-linecap: round; transition: stroke .18s ease, stroke-width .18s ease; }
.ralphflow-viewer .rv-edge[data-tone="run"] { stroke: color-mix(in srgb, var(--rv-run) 58%, var(--rv-line)); stroke-width: 2; }
.ralphflow-viewer .rv-edge[data-tone="done"] { stroke: color-mix(in srgb, var(--rv-done) 48%, var(--rv-line)); }
.ralphflow-viewer .rv-edge[data-tone="wait"] { stroke: color-mix(in srgb, var(--rv-wait) 55%, var(--rv-line)); stroke-dasharray: 5 5; }
.ralphflow-viewer .rv-edge[data-tone="fault"] { stroke: color-mix(in srgb, var(--rv-fault) 55%, var(--rv-line)); }
.ralphflow-viewer .rv-column { position: absolute; top: 0; display: grid; align-content: start; gap: 14px; }
.ralphflow-viewer .rv-column-head { padding: 9px 9px 2px; color: color-mix(in srgb, var(--rv-run) 45%, var(--rv-faint)); font: 9px/1.4 var(--rv-mono); letter-spacing: .07em; text-transform: uppercase; }
.ralphflow-viewer .rv-node { position: absolute; display: grid; overflow: hidden; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto auto auto 1fr; gap: 7px; width: ${MAX_CARD_WIDTH}px; height: ${CARD_HEIGHT}px; padding: 13px; border: 0; border-left: 3px solid color-mix(in srgb, var(--rv-run) 30%, var(--rv-line)); border-radius: 12px; background: linear-gradient(150deg, color-mix(in srgb, var(--rv-run) 5%, var(--rv-card)), var(--rv-card) 58%, color-mix(in srgb, var(--rv-wait) 4%, var(--rv-card))); box-shadow: 0 1px 2px var(--rv-shadow), inset 0 0 0 1px var(--rv-line); color: inherit; text-align: left; font: inherit; cursor: pointer; transition: box-shadow .16s ease, transform .16s ease, border-color .16s ease; }
.ralphflow-viewer .rv-node:hover { transform: translateY(-1px); box-shadow: 0 8px 20px color-mix(in srgb, var(--rv-ink) 12%, transparent), inset 0 0 0 1px var(--rv-line-strong); }
.ralphflow-viewer .rv-node:focus-visible { outline: 2px solid var(--rv-accent); outline-offset: 2px; }
.ralphflow-viewer .rv-node[aria-pressed="true"] { box-shadow: 0 0 0 2px var(--rv-accent), 0 8px 20px var(--rv-shadow); }
.ralphflow-viewer .rv-node[data-status="running"], .ralphflow-viewer .rv-node[data-status="verifying"], .ralphflow-viewer .rv-node[data-status="reworking"], .ralphflow-viewer .rv-node[data-status="integrating"], .ralphflow-viewer .rv-node[data-status="accepting"] { border-left-color: var(--rv-run); background: linear-gradient(150deg, var(--rv-run-wash), var(--rv-card) 64%); }
.ralphflow-viewer .rv-node[data-status="waiting"], .ralphflow-viewer .rv-node[data-status="waiting_review"] { border-left-color: var(--rv-wait); background: linear-gradient(150deg, var(--rv-wait-wash), var(--rv-card) 64%); }
.ralphflow-viewer .rv-node[data-status="completed"] { border-left-color: var(--rv-done); background: linear-gradient(150deg, var(--rv-done-wash), var(--rv-card) 64%); }
.ralphflow-viewer .rv-node[data-status="failed"], .ralphflow-viewer .rv-node[data-status="cancelled"], .ralphflow-viewer .rv-node[data-status="interrupted"] { border-left-color: var(--rv-fault); background: linear-gradient(150deg, var(--rv-fault-wash), var(--rv-card) 64%); }
.ralphflow-viewer .rv-node-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; color: var(--rv-faint); font: 9.5px/1.4 var(--rv-mono); letter-spacing: .02em; }
.ralphflow-viewer .rv-node-top span:first-child { color: color-mix(in srgb, var(--rv-run) 55%, var(--rv-muted)); font-weight: 600; }
.ralphflow-viewer .rv-node-top span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ralphflow-viewer .rv-node > *, .ralphflow-viewer .rv-step > *, .ralphflow-viewer .rv-outline-row > * { min-width: 0; }
.ralphflow-viewer .rv-node h3 { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; max-height: 2.8em; overflow: hidden; margin: 0; font-size: 13.5px; line-height: 1.4; font-weight: 650; text-wrap: balance; overflow-wrap: anywhere; }
.ralphflow-viewer .rv-node-foot { align-self: end; display: flex; align-items: center; justify-content: space-between; gap: 8px; width: 100%; min-width: 0; color: var(--rv-faint); font-size: 10px; line-height: 1.5; white-space: nowrap; overflow: hidden; }
.ralphflow-viewer .rv-node-foot span:first-child { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ralphflow-viewer .rv-node-foot span:last-child { flex: none; white-space: nowrap; }
.ralphflow-viewer .rv-chip { display: inline-flex; align-items: center; gap: 5px; width: fit-content; padding: 2px 8px; border-radius: 999px; background: var(--rv-track); color: var(--rv-muted); font-size: 10px; font-weight: 550; line-height: 1.6; white-space: nowrap; }
.ralphflow-viewer .rv-chip::before { content: ""; width: 6px; height: 6px; border-radius: 999px; background: currentColor; opacity: .9; }
.ralphflow-viewer .rv-chip[data-tone="run"] { background: color-mix(in srgb, var(--rv-run) 13%, transparent); color: var(--rv-run); }
.ralphflow-viewer .rv-chip[data-tone="done"] { background: color-mix(in srgb, var(--rv-done) 14%, transparent); color: var(--rv-done); }
.ralphflow-viewer .rv-chip[data-tone="wait"] { background: color-mix(in srgb, var(--rv-wait) 15%, transparent); color: var(--rv-wait); }
.ralphflow-viewer .rv-chip[data-tone="fault"] { background: color-mix(in srgb, var(--rv-fault) 13%, transparent); color: var(--rv-fault); }
.ralphflow-viewer .rv-chip[data-tone="off"] { opacity: .65; }
.ralphflow-viewer .rv-card-badges { display: flex; flex-wrap: wrap; gap: 4px; align-content: start; }
.ralphflow-viewer .rv-flow { display: grid; gap: 10px; }
.ralphflow-viewer .rv-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 0 2px 2px; color: var(--rv-faint); font: 9.5px/1.4 var(--rv-mono); letter-spacing: .05em; }
.ralphflow-viewer .rv-section-head span:first-child::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 2px; background: var(--rv-run); vertical-align: 1px; }
.ralphflow-viewer .rv-section-head span:last-child { text-transform: none; letter-spacing: 0; font-family: inherit; font-size: 10px; }
.ralphflow-viewer .rv-flow-item { position: relative; padding-left: 22px; }
.ralphflow-viewer .rv-flow-item::before { content: ""; position: absolute; left: 7px; top: 18px; bottom: -10px; width: 1px; background: var(--rv-line); }
.ralphflow-viewer .rv-flow-item:last-child::before { bottom: auto; height: 20px; }
.ralphflow-viewer .rv-flow-dot { position: absolute; left: 3px; top: 20px; width: 9px; height: 9px; border-radius: 999px; background: color-mix(in srgb, var(--rv-run) 34%, var(--rv-line-strong)); box-shadow: 0 0 0 3px var(--rv-panel); }
.ralphflow-viewer .rv-flow-item[data-current="true"] .rv-flow-dot { background: var(--rv-run); }
.ralphflow-viewer .rv-flow-item[data-done="true"] .rv-flow-dot { background: var(--rv-done); }
.ralphflow-viewer .rv-step { display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px; width: 100%; padding: 13px; border: 0; border-left: 3px solid color-mix(in srgb, var(--rv-run) 26%, var(--rv-line)); border-radius: 12px; background: linear-gradient(150deg, color-mix(in srgb, var(--rv-run) 5%, var(--rv-card)), var(--rv-card) 58%, color-mix(in srgb, var(--rv-wait) 4%, var(--rv-card))); box-shadow: 0 1px 2px var(--rv-shadow), inset 0 0 0 1px var(--rv-line); color: inherit; text-align: left; font: inherit; cursor: pointer; transition: box-shadow .16s ease, transform .16s ease, border-color .16s ease; }
.ralphflow-viewer .rv-step:hover { transform: translateY(-1px); box-shadow: 0 8px 20px color-mix(in srgb, var(--rv-ink) 12%, transparent), inset 0 0 0 1px var(--rv-line-strong); }
.ralphflow-viewer .rv-step:focus-visible { outline: 2px solid var(--rv-accent); outline-offset: 2px; }
.ralphflow-viewer .rv-step[data-current="true"] { border-left-color: var(--rv-run); background: linear-gradient(150deg, var(--rv-run-wash), var(--rv-card) 64%); }
.ralphflow-viewer .rv-step[data-done="true"] { border-left-color: var(--rv-done); background: linear-gradient(150deg, var(--rv-done-wash), var(--rv-card) 64%); }
.ralphflow-viewer .rv-step[data-failed="true"] { border-left-color: var(--rv-fault); background: linear-gradient(150deg, var(--rv-fault-wash), var(--rv-card) 64%); }
.ralphflow-viewer .rv-step h3 { margin: 0; font-size: 13px; line-height: 1.4; font-weight: 650; overflow-wrap: anywhere; }
.ralphflow-viewer .rv-step p { margin: 0; color: var(--rv-muted); font-size: 11px; line-height: 1.55; overflow-wrap: anywhere; }
.ralphflow-viewer .rv-step .rv-step-preview { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; max-height: 3.2em; overflow: hidden; color: var(--rv-faint); font-size: 10.5px; }
.ralphflow-viewer .rv-outline { display: grid; gap: 8px; padding: 10px; }
.ralphflow-viewer .rv-outline-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; width: 100%; padding: 12px 13px; border: 0; border-left: 3px solid color-mix(in srgb, var(--rv-run) 26%, var(--rv-line)); border-radius: 12px; background: linear-gradient(150deg, color-mix(in srgb, var(--rv-run) 5%, var(--rv-card)), var(--rv-card) 58%, color-mix(in srgb, var(--rv-wait) 4%, var(--rv-card))); box-shadow: 0 1px 2px var(--rv-shadow), inset 0 0 0 1px var(--rv-line); color: inherit; text-align: left; font: inherit; cursor: pointer; transition: box-shadow .16s ease, transform .16s ease, border-color .16s ease; }
.ralphflow-viewer .rv-outline-row:hover { transform: translateY(-1px); box-shadow: 0 8px 20px color-mix(in srgb, var(--rv-ink) 12%, transparent), inset 0 0 0 1px var(--rv-line-strong); }
.ralphflow-viewer .rv-outline-row:focus-visible { outline: 2px solid var(--rv-accent); outline-offset: 2px; }
.ralphflow-viewer .rv-outline-row[data-status="running"], .ralphflow-viewer .rv-outline-row[data-status="verifying"], .ralphflow-viewer .rv-outline-row[data-status="reworking"], .ralphflow-viewer .rv-outline-row[data-status="integrating"], .ralphflow-viewer .rv-outline-row[data-status="accepting"] { border-left-color: var(--rv-run); background: linear-gradient(150deg, var(--rv-run-wash), var(--rv-card) 64%); }
.ralphflow-viewer .rv-outline-row[data-status="waiting"], .ralphflow-viewer .rv-outline-row[data-status="waiting_review"] { border-left-color: var(--rv-wait); background: linear-gradient(150deg, var(--rv-wait-wash), var(--rv-card) 64%); }
.ralphflow-viewer .rv-outline-row[data-status="completed"] { border-left-color: var(--rv-done); background: linear-gradient(150deg, var(--rv-done-wash), var(--rv-card) 64%); }
.ralphflow-viewer .rv-outline-row[data-status="failed"], .ralphflow-viewer .rv-outline-row[data-status="cancelled"], .ralphflow-viewer .rv-outline-row[data-status="interrupted"] { border-left-color: var(--rv-fault); background: linear-gradient(150deg, var(--rv-fault-wash), var(--rv-card) 64%); }
.ralphflow-viewer .rv-outline-name { font-size: 12.5px; font-weight: 650; line-height: 1.4; overflow-wrap: anywhere; }
.ralphflow-viewer .rv-outline-meta { color: var(--rv-faint); font: 9.5px/1.5 var(--rv-mono); overflow-wrap: anywhere; }
.ralphflow-viewer .rv-outline-deps { margin: 0; color: var(--rv-muted); font-size: 10.5px; line-height: 1.5; overflow-wrap: anywhere; }
.ralphflow-viewer .rv-inspector { overflow: clip; border-radius: 14px; background: var(--rv-panel); box-shadow: inset 0 0 0 1px var(--rv-line); }
.ralphflow-viewer .rv-inspector[data-status="running"], .ralphflow-viewer .rv-inspector[data-status="verifying"], .ralphflow-viewer .rv-inspector[data-status="reworking"], .ralphflow-viewer .rv-inspector[data-status="integrating"], .ralphflow-viewer .rv-inspector[data-status="accepting"] { box-shadow: inset 0 3px 0 var(--rv-run), inset 0 0 0 1px var(--rv-line); }
.ralphflow-viewer .rv-inspector[data-status="waiting"], .ralphflow-viewer .rv-inspector[data-status="waiting_review"] { box-shadow: inset 0 3px 0 var(--rv-wait), inset 0 0 0 1px var(--rv-line); }
.ralphflow-viewer .rv-inspector[data-status="completed"] { box-shadow: inset 0 3px 0 var(--rv-done), inset 0 0 0 1px var(--rv-line); }
.ralphflow-viewer .rv-inspector[data-status="failed"], .ralphflow-viewer .rv-inspector[data-status="cancelled"], .ralphflow-viewer .rv-inspector[data-status="interrupted"] { box-shadow: inset 0 3px 0 var(--rv-fault), inset 0 0 0 1px var(--rv-line); }
.ralphflow-viewer .rv-inspector-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 10px; padding: 14px; background: var(--rv-card); border-bottom: 1px solid var(--rv-line); }
.ralphflow-viewer .rv-eyebrow { color: var(--rv-faint); font: 9px/1.4 var(--rv-mono); letter-spacing: .07em; text-transform: uppercase; }
.ralphflow-viewer .rv-inspector-title { margin: 4px 0 0; font-size: 16px; line-height: 1.35; font-weight: 650; text-wrap: balance; overflow-wrap: anywhere; }
.ralphflow-viewer .rv-inspector-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin: 6px 0 0; color: var(--rv-muted); font-size: 10.5px; }
.ralphflow-viewer .rv-back { flex: none; height: 30px; padding: 0 10px; border: 0; border-radius: 8px; background: var(--rv-track); color: var(--rv-ink); font-family: inherit; font-size: 11px; line-height: 1; font-weight: 600; cursor: pointer; white-space: nowrap; transition: background-color .16s ease, transform .12s ease; }
.ralphflow-viewer .rv-back:hover { background: color-mix(in srgb, var(--rv-muted) 18%, transparent); }
.ralphflow-viewer .rv-back:active { transform: scale(.96); }
.ralphflow-viewer .rv-back:focus-visible { outline: 2px solid var(--rv-accent); outline-offset: 1px; }
.ralphflow-viewer .rv-section { display: grid; gap: 7px; padding: 13px 14px; border-top: 1px solid var(--rv-line); }
.ralphflow-viewer .rv-inspector-head + .rv-section { border-top: 0; }
.ralphflow-viewer .rv-label { color: var(--rv-faint); font-size: 9.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; }
.ralphflow-viewer .rv-pre { margin: 0; padding: 10px 11px; border-radius: 10px; background: var(--rv-card); box-shadow: inset 0 0 0 1px var(--rv-line); color: var(--rv-ink); font: 11.5px/1.7 var(--rv-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.ralphflow-viewer .rv-note { margin: 0; color: var(--rv-muted); font-size: 11.5px; line-height: 1.6; overflow-wrap: anywhere; }
.ralphflow-viewer .rv-meta-row { display: flex; flex-wrap: wrap; gap: 5px; }
.ralphflow-viewer .rv-check-list { display: grid; gap: 8px; }
.ralphflow-viewer .rv-check { display: grid; gap: 5px; }
.ralphflow-viewer .rv-code { display: inline-block; padding: 3px 7px; border-radius: 6px; background: var(--rv-card); box-shadow: inset 0 0 0 1px var(--rv-line); color: var(--rv-ink); font: 10.5px/1.6 var(--rv-mono); overflow-wrap: anywhere; }
.ralphflow-viewer .rv-list { margin: 0; padding-left: 18px; display: grid; gap: 4px; color: var(--rv-muted); font-size: 11.5px; line-height: 1.6; }
.ralphflow-viewer .rv-foot { padding-top: 2px; color: var(--rv-faint); font-size: 10px; line-height: 1.5; }
@media (max-width: 560px) {
  .ralphflow-viewer { padding: 12px 10px 22px; gap: 11px; }
  .ralphflow-viewer .rv-title { font-size: 18px; }
  .ralphflow-viewer .rv-toolbar { flex-wrap: wrap; }
  .ralphflow-viewer .rv-select { flex-basis: 150px; }
}
@media (prefers-reduced-motion: reduce) {
  .ralphflow-viewer .rv-node, .ralphflow-viewer .rv-step, .ralphflow-viewer .rv-outline-row, .ralphflow-viewer .rv-switch button, .ralphflow-viewer .rv-back { transition: none; }
  .ralphflow-viewer .rv-node:hover, .ralphflow-viewer .rv-step:hover, .ralphflow-viewer .rv-outline-row:hover { transform: none; }
}
`;

export function injectViewerCss(): void {
  if (typeof document === "undefined" || document.querySelector("style[data-ralphflow-viewer-css]") !== null) return;
  const style = document.createElement("style");
  style.dataset.ralphflowViewerCss = "";
  style.textContent = css;
  document.head.appendChild(style);
}

function readStored(key: string): string | null {
  try { return typeof window === "undefined" ? null : window.localStorage.getItem(key); } catch { return null; }
}
function storeStored(key: string, value: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {}
}

/** 状态投影里的英文枚举是事实，界面只说人话。 */
const CHECK_LABELS: Record<string, string> = { passed: "已通过", failed: "未通过", infra: "验证未跑成", pending: "待验证", skipped: "已跳过" };
const CHECK_TONES: Record<string, "run" | "done" | "wait" | "fault" | "off"> = { passed: "done", failed: "fault", infra: "fault", pending: "off", skipped: "off" };
const MANUAL_LABELS: Record<string, string> = { pending: "待处理", waiting: "等待你审核", approved: "已批准", revise: "要求改稿", stale: "已过期", cancelled: "已取消" };
const INTEGRATION_LABELS: Record<string, string> = { accepted: "已合入", pending: "待合入" };

function graphRuntimeOf(status: ClientStatus, asset: ViewerAsset) {
  if (!status.status || status.status.workflow !== asset.name || status.status.kind !== "graph" || !status.status.graph) return null;
  return status.status.graph;
}

function flowRuntimeOf(status: ClientStatus, asset: ViewerAsset) {
  if (!status.status || status.status.workflow !== asset.name || status.status.kind !== "flow") return null;
  return status.status;
}

function nodeRuntimeOf(graph: ReturnType<typeof graphRuntimeOf>, id: string): GraphStatusNode | null {
  return graph?.nodes.find((node) => node.id === id) ?? null;
}

type GraphLayout = {
  columns: Array<{ rank: number; ids: string[] }>;
  columnOf: Map<string, number>;
  rowOf: Map<string, number>;
  edges: Array<{ from: string; to: string }>;
  cardWidth: number;
  columnStep: number;
  width: number;
  height: number;
  scrollable: boolean;
};

function layoutGraph(nodes: ViewerAssetNode[], availableWidth: number): GraphLayout {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ranks = new Map<string, number>();
  const visiting = new Set<string>();
  const rankOf = (id: string): number => {
    const known = ranks.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const node = byId.get(id);
    let rank = 0;
    for (const dependency of node?.dependsOn ?? []) rank = Math.max(rank, rankOf(dependency) + 1);
    visiting.delete(id);
    ranks.set(id, rank);
    return rank;
  };
  for (const node of nodes) rankOf(node.id);
  const unique = [...new Set([...ranks.values()])].sort((a, b) => a - b);
  const columnIndex = new Map(unique.map((rank, index) => [rank, index]));
  const columns = unique.map((rank) => ({ rank, ids: [] as string[] }));
  for (const node of nodes) {
    const index = columnIndex.get(ranks.get(node.id) ?? 0) ?? 0;
    columns[index]?.ids.push(node.id);
  }
  const columnOf = new Map<string, number>();
  const rowOf = new Map<string, number>();
  for (const [index, column] of columns.entries()) {
    for (const [row, id] of column.ids.entries()) {
      columnOf.set(id, index);
      rowOf.set(id, row);
    }
  }
  const edges: Array<{ from: string; to: string }> = [];
  for (const node of nodes) for (const dependency of node.dependsOn) if (byId.has(dependency)) edges.push({ from: dependency, to: node.id });
  const maxRows = Math.max(1, ...columns.map((column) => column.ids.length));
  const room = availableWidth > 0 ? Math.floor((availableWidth - COLUMN_GAP * (columns.length - 1)) / columns.length) : MAX_CARD_WIDTH;
  const cardWidth = Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, room));
  const naturalWidth = columns.length * cardWidth + COLUMN_GAP * (columns.length - 1);
  const fits = availableWidth <= 0 || naturalWidth <= availableWidth;
  const width = fits && availableWidth > 0 ? availableWidth : naturalWidth;
  return {
    columns,
    columnOf,
    rowOf,
    edges,
    cardWidth,
    columnStep: cardWidth + COLUMN_GAP,
    width,
    height: CANVAS_TOP + maxRows * ROW_STEP,
    scrollable: !fits,
  };
}

function Chips({ chips, current }: { chips: PhaseChip[]; current?: boolean }) {
  return <>{chips.map((chip, index) => <span key={`${index}-${chip.label}`} className="rv-chip" data-tone={chip.tone}>{current && index === 0 ? "当前 · " : ""}{chip.label}</span>)}</>;
}

function Summary({ items }: { items: Array<{ key: string; label: string; value: number; tone: PhaseChip["tone"] }> }) {
  if (items.length === 0) return null;
  return <div className="rv-summary">{items.map((item) => (
    <span key={item.key} className="rv-summary-item" data-tone={item.tone}><strong>{item.value}</strong>{item.label}</span>
  ))}</div>;
}

function assetKey(asset: ViewerAsset): string {
  return `${asset.kind}:${asset.name}`;
}

function WorkflowPicker({ catalog, name, running, onChoose }: { catalog: ViewerAsset[]; name: string; running: string | null; onChoose: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const selected = catalog.find((asset) => asset.name === name);
  const items: MenuEntry[] = [];
  for (const kind of ["flow", "graph"] as const) {
    const assets = catalog.filter((asset) => asset.kind === kind);
    if (assets.length === 0) continue;
    items.push({ type: "label", id: `label-${kind}`, text: kind === "flow" ? "Flow" : "Graph" });
    for (const asset of assets) {
      items.push({
        id: assetKey(asset),
        label: assetMenuLabel(asset, running),
      });
    }
    if (kind === "flow" && catalog.some((asset) => asset.kind === "graph")) items.push({ type: "separator", id: "separator" });
  }
  return <Menu
    open={open}
    anchor={<button type="button" className="rv-picker-trigger" aria-haspopup="menu" aria-expanded={open} aria-label="选择工作流" onClick={() => setOpen((value) => !value)}>
      <span className="rv-picker-text">{selected ? `${selected.name} · ${selected.kind === "graph" ? `${selected.nodes.length} 节点` : `${selected.steps.length} 步`}` : "选择工作流"}</span>
      <svg className="rv-picker-chevron" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>}
    items={items}
    selectedId={selected ? assetKey(selected) : undefined}
    onSelect={(id) => {
      const next = catalog.find((asset) => assetKey(asset) === id);
      setOpen(false);
      if (next) onChoose(next.name);
    }}
    onClose={() => setOpen(false)}
    portal
    compact
    className="rv-picker"
    listClassName="rv-picker-menu"
  />;
}

function Header({
  asset, graph, flow, catalog, name, running, onChoose, mode, onMode,
}: {
  asset: ViewerAsset | null;
  graph: ReturnType<typeof graphRuntimeOf>;
  flow: WorkflowStatus | null;
  catalog: ViewerAsset[];
  name: string;
  running: string | null;
  onChoose: (name: string) => void;
  mode: ViewMode;
  onMode: (mode: ViewMode) => void;
}) {
  const summary = graph ? [
    graph.counts.completed > 0 ? { key: "completed", label: "完成", value: graph.counts.completed, tone: "done" as const } : null,
    graph.counts.running > 0 ? { key: "running", label: "执行", value: graph.counts.running, tone: "run" as const } : null,
    graph.counts.waiting > 0 ? { key: "waiting", label: "等待", value: graph.counts.waiting, tone: "wait" as const } : null,
    graph.counts.pending > 0 ? { key: "pending", label: "待开始", value: graph.counts.pending, tone: "off" as const } : null,
    graph.counts.blocked > 0 ? { key: "blocked", label: "阻塞", value: graph.counts.blocked, tone: "fault" as const } : null,
  ].filter((item): item is NonNullable<typeof item> => item !== null) : [];
  const flowIndex = flow && asset ? asset.steps.findIndex((step) => step.id === flow.step) : -1;
  const votesReturned = flow ? flow.votes.filter((vote) => vote.status === "passed" || vote.status === "failed" || vote.status === "infra").length : 0;
  const baseMeta = !asset
    ? "选择一个工作流查看只读结构"
    : asset.invalid
      ? `定义无效 · ${asset.problems[0] ?? "校验失败"}`
      : asset.kind === "graph"
        ? graph
          ? `${graph.phase} · ${graph.counts.completed}/${graph.counts.total} 节点完成 · 只读浏览`
          : `Graph · ${asset.nodes.length} 个节点 · 只读浏览`
        : flow
          ? `${STAGE_LABELS[flow.stage]}${flow.stage === "verifying" && flow.votes.length > 1 ? ` ${votesReturned}/${flow.votes.length} 票` : ""}${flowIndex >= 0 ? ` · 第 ${flowIndex + 1}/${asset.steps.length} 步` : ""} · 只读浏览`
          : `Flow · ${asset.steps.length} 个步骤 · 只读浏览`;
  // 正在跑的不是手上这个：明说一句，别让人以为看的就是运行中的。
  const meta = running && asset && asset.name !== running ? `${baseMeta} · 运行中：${running}` : baseMeta;
  return <header className="rv-head">
    <div className="rv-kicker">RalphFlow <span aria-hidden="true">/</span> 只读工作图</div>
    <div className="rv-title-row">
      <h1 className="rv-title">{asset?.name ?? "工作流浏览"}</h1>
      {asset ? <span className="rv-kind">{asset.kind === "graph" ? "Graph" : "Flow"}</span> : null}
    </div>
    <p className="rv-meta">{meta}</p>
    {asset?.description ? <p className="rv-desc">{asset.description}</p> : null}
    {summary.length > 0 ? <Summary items={summary} /> : null}
    {graph?.nextAction ? <div className="rv-callout"><strong>{graph.nextAction.label}</strong> · {graph.nextAction.message} <span className="rv-foot">在聊天里处理。</span></div> : null}
    {!graph && flow && (flow.stage === "gate" || flow.stage === "paused") ? <div className="rv-callout"><strong>{STAGE_LABELS[flow.stage]}</strong> · {flow.hint} <span className="rv-foot">在聊天里继续或审批。</span></div> : null}
    {catalog.length > 0 ? <div className="rv-toolbar">
      <label className="rv-select-label">工作流</label>
      <WorkflowPicker catalog={catalog} name={name} running={running} onChoose={onChoose} />
      {asset?.kind === "graph" && !asset.invalid ? <div className="rv-switch" role="group" aria-label="视图">
        <button type="button" aria-pressed={mode === "columns"} onClick={() => onMode("columns")} title="依赖图画布">图</button>
        <button type="button" aria-pressed={mode === "outline"} onClick={() => onMode("outline")} title="依赖列表">列表</button>
      </div> : null}
    </div> : null}
  </header>;
}

function GraphCard({ node, graph, index, width, onOpen }: { node: ViewerAssetNode; graph: ReturnType<typeof graphRuntimeOf>; index: number; width: number; onOpen: () => void }) {
  const runtime = nodeRuntimeOf(graph, node.id);
  const status = runtime?.status ?? "pending";
  return <button type="button" className="rv-node" data-ralphflow-node={node.id} data-status={status} aria-label={`查看节点 ${node.name}`} onClick={onOpen} style={{ width }}>
    <div className="rv-node-top"><span>节点 {String(index + 1).padStart(2, "0")}</span><span>{node.id}</span></div>
    <h3>{node.name}</h3>
    <div className="rv-card-badges">
      <Chips chips={runtime ? graphPhaseChips(runtime) : graphAssetChips(node)} current={runtime?.current} />
      {runtime?.check.reworks ? <span className="rv-chip" data-tone="fault">返工 {runtime.check.reworks} 次</span> : null}
      {node.manual ? <span className="rv-chip" data-tone="wait">人工门</span> : null}
      {node.execution === "main" ? <span className="rv-chip" data-tone="off">主会话</span> : null}
    </div>
    <div className="rv-node-foot"><span>依赖：{node.dependsOn.length ? node.dependsOn.join("、") : "起点节点"}</span><span>详情 →</span></div>
  </button>;
}

function GraphCanvas({ asset, graph, mode, width: availableWidth, onOpen }: { asset: ViewerAsset; graph: ReturnType<typeof graphRuntimeOf>; mode: ViewMode; width: number; onOpen: (id: string) => void }) {
  const layout = layoutGraph(asset.nodes, availableWidth);
  if (mode === "outline") {
    return <div className="rv-outline" data-ralphflow-outline>
      {layout.columns.flatMap((column) => column.ids).map((id, index) => {
        const node = asset.nodes.find((candidate) => candidate.id === id)!;
        const runtime = nodeRuntimeOf(graph, node.id);
        const status = runtime?.status ?? "pending";
        return <button key={id} type="button" className="rv-outline-row" data-ralphflow-node={id} data-status={status} aria-label={`查看节点 ${node.name}`} onClick={() => onOpen(id)}>
          <div className="rv-outline-name">{String(index + 1).padStart(2, "0")} · {node.name}</div>
          <div className="rv-outline-meta">id {id} · 依赖层 {String((layout.columnOf.get(id) ?? 0) + 1).padStart(2, "0")}</div>
          <div className="rv-card-badges">
            <Chips chips={runtime ? graphPhaseChips(runtime) : graphAssetChips(node)} current={runtime?.current} />
            {runtime?.check.reworks ? <span className="rv-chip" data-tone="fault">返工 {runtime.check.reworks} 次</span> : null}
            {node.manual ? <span className="rv-chip" data-tone="wait">人工门</span> : null}
            {node.execution === "main" ? <span className="rv-chip" data-tone="off">主会话</span> : null}
          </div>
          <p className="rv-outline-deps">{node.dependsOn.length ? `依赖：${node.dependsOn.map((dep) => asset.nodes.find((candidate) => candidate.id === dep)?.name ?? dep).join("、")}` : "起点节点"}</p>
        </button>;
      })}
    </div>;
  }
  return <div>
    <div className="rv-section-head"><span>依赖图</span><span>节点按依赖层从左到右；点节点查看 DO / CHECK</span></div>
    <div className="rv-canvas-wrap">
    <div className="rv-canvas" data-ralphflow-dag style={{ width: layout.width, height: layout.height }}>
      <svg width={layout.width} height={layout.height} aria-hidden="true">
        {layout.edges.map((edge) => {
          const fromColumn = layout.columnOf.get(edge.from) ?? 0;
          const toColumn = layout.columnOf.get(edge.to) ?? 0;
          const fromRow = layout.rowOf.get(edge.from) ?? 0;
          const toRow = layout.rowOf.get(edge.to) ?? 0;
          const x1 = fromColumn * layout.columnStep + layout.cardWidth;
          const x2 = toColumn * layout.columnStep;
          const y1 = CANVAS_TOP + fromRow * ROW_STEP + CARD_HEIGHT / 2;
          const y2 = CANVAS_TOP + toRow * ROW_STEP + CARD_HEIGHT / 2;
          const curve = Math.max(20, Math.min(56, (x2 - x1) * 0.45));
          const tone = statusToneOf(nodeRuntimeOf(graph, edge.to)?.status ?? "pending");
          return <path key={`${edge.from}->${edge.to}`} className="rv-edge" data-tone={tone} d={`M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`} />;
        })}
      </svg>
      {layout.columns.map((column, columnIndex) => <section key={column.rank} className="rv-column" style={{ left: columnIndex * layout.columnStep, width: layout.cardWidth }}>
        <div className="rv-column-head">依赖层 {String(columnIndex + 1).padStart(2, "0")}</div>
        {column.ids.map((id, row) => {
          const node = asset.nodes.find((candidate) => candidate.id === id)!;
          const index = asset.nodes.findIndex((candidate) => candidate.id === id);
          return <div key={id} style={{ position: "absolute", top: CANVAS_TOP + row * ROW_STEP }}>
            <GraphCard node={node} graph={graph} index={index} width={layout.cardWidth} onOpen={() => onOpen(id)} />
          </div>;
        })}
      </section>)}
    </div>
    </div>
    {layout.scrollable ? <div className="rv-canvas-hint">← 左右滚动查看完整依赖图 →</div> : null}
  </div>;
}

function FlowList({ asset, flow, onOpen }: { asset: ViewerAsset; flow: WorkflowStatus | null; onOpen: (id: string) => void }) {
  const currentIndex = flow ? asset.steps.findIndex((step) => step.id === flow.step) : -1;
  return <div>
    <div className="rv-section-head"><span>步骤链</span><span>on_pass 推进 · on_fail 回退</span></div>
    <div className="rv-flow">
    {asset.steps.map((step, index) => {
      const current = step.id === flow?.step;
      const passed = flow?.stage === "done" || (currentIndex >= 0 && index < currentIndex);
      const runtime = flow?.steps.find((candidate) => candidate.id === step.id);
      const failed = (runtime?.failures ?? 0) > 0;
      return <div key={step.id} className="rv-flow-item" data-current={current ? "true" : "false"} data-done={passed ? "true" : "false"}>
        <span className="rv-flow-dot" aria-hidden="true" />
        <button type="button" className="rv-step" data-ralphflow-step={step.id} data-current={current ? "true" : "false"} data-done={passed ? "true" : "false"} data-failed={failed ? "true" : "false"} aria-label={`查看步骤 ${step.description || step.id}`} onClick={() => onOpen(step.id)}>
          <div className="rv-node-top"><span>步骤 {String(index + 1).padStart(2, "0")} · {step.id}</span><span>{step.manual ? "人工门" : step.checks.length > 1 ? `${step.checks.length} 票 CHECK` : step.checks.length === 1 ? "有 CHECK" : "无 CHECK"}</span></div>
          <h3>{step.description || step.id}</h3>
          <p className="rv-step-preview">{step.checks.length ? `${step.checks[0]!.replace(/\s+/g, " ").trim()}${step.checks.length > 1 ? `　等 ${step.checks.length} 条` : ""}` : "跳过对抗性验证，完成即推进。"}</p>
          <div className="rv-card-badges">
            {flow && current ? <Chips chips={flowPhaseChips(flow)} />
              : <span className="rv-chip" data-tone={flow ? passed ? "done" : "off" : "off"}>{flow ? passed ? "已通过" : "未开始" : "静态浏览"}</span>}
            {failed ? <span className="rv-chip" data-tone="fault">返工 {runtime?.failures} 次</span> : null}
            {step.manual ? <span className="rv-chip" data-tone="wait">人工门</span> : null}
          </div>
          <div className="rv-node-foot"><span>通过 → {step.onPass === "done" ? "结束" : step.onPass || "下一步"}</span><span>详情 →</span></div>
        </button>
      </div>;
    })}
    </div>
  </div>;
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return <section className="rv-section"><div className="rv-label">{label}</div>{children}</section>;
}

function GraphInspector({ asset, graph, node, onClose }: { asset: ViewerAsset; graph: ReturnType<typeof graphRuntimeOf>; node: ViewerAssetNode; onClose: () => void }) {
  const runtime = nodeRuntimeOf(graph, node.id);
  const status = runtime?.status ?? "pending";
  const checkMode = runtime?.check.mode ?? node.checkMode;
  const dependencies = node.dependsOn.map((id) => asset.nodes.find((candidate) => candidate.id === id)?.name ?? id);
  return <aside className="rv-inspector" data-ralphflow-inspector={node.id} data-status={status} aria-label={`节点详情：${node.name}`}>
    <div className="rv-inspector-head">
      <div>
        <div className="rv-eyebrow">NODE · {node.id}</div>
        <h2 className="rv-inspector-title">{node.name}</h2>
        <div className="rv-inspector-sub">
          <Chips chips={runtime ? graphPhaseChips(runtime) : graphAssetChips(node)} current={runtime?.current} />
          <span>· {node.execution === "main" ? "主会话执行" : "后台执行"}{node.manual ? " · 人工门" : ""}</span>
        </div>
      </div>
      <button type="button" className="rv-back" onClick={onClose} aria-label="返回工作图">← 工作图</button>
    </div>
    <Section label="DO · 节点任务"><pre className="rv-pre" data-ralphflow-inspector-prompt>{node.do || "（未声明 DO）"}</pre></Section>
    <Section label="CHECK · 独立验收">
      <div className="rv-meta-row">
        <span className="rv-chip" data-tone={checkMode === "disabled" ? "off" : "run"}>{checkMode === "disabled" ? "CHECK 关闭" : "自定义 CHECK"}</span>
        {runtime?.check.status && runtime.check.status !== "skipped" ? <span className="rv-chip" data-tone={CHECK_TONES[runtime.check.status] ?? "off"}>{CHECK_LABELS[runtime.check.status] ?? runtime.check.status}</span> : null}
      </div>
      {checkMode === "disabled" ? <p className="rv-note">该节点跳过独立 CHECK；这表示未验收，不等于验收通过。</p> : <pre className="rv-pre" data-ralphflow-inspector-check>{node.check || "（未声明判据）"}</pre>}
    </Section>
    {runtime ? <Section label="运行状态">
      <p className="rv-note">执行 {runtime.attempts} 次{runtime.check.reworks ? ` · 返工 ${runtime.check.reworks} 次` : ""}{runtime.check.reason ? ` · ${runtime.check.reason}` : ""}</p>
      {runtime.artifact ? <p className="rv-note">产物：<code className="rv-code">{runtime.artifact.path}</code></p> : null}
      {runtime.manual !== "not_required" ? <p className="rv-note">人工门：{MANUAL_LABELS[runtime.manual] ?? runtime.manual}</p> : null}
      {runtime.integration !== "not_required" ? <p className="rv-note">合入：{INTEGRATION_LABELS[runtime.integration] ?? runtime.integration}{runtime.integrationCommit ? ` · ${runtime.integrationCommit.slice(0, 12)}…` : ""}</p> : null}
    </Section> : null}
    <Section label="依赖">
      {dependencies.length ? <ul className="rv-list">{dependencies.map((name) => <li key={name}>{name}</li>)}</ul> : <p className="rv-note">无依赖，起点节点。</p>}
    </Section>
    <Section label="输入与资料">
      {node.inputs.length ? <ul className="rv-list">{node.inputs.map((input) => <li key={`${input.fromNode}:${input.artifact}`}><code className="rv-code">{input.fromNode}/{input.artifact}</code></li>)}</ul> : <p className="rv-note">无上游产物输入。</p>}
    </Section>
    <Section label="交付物">
      <code className="rv-code">{node.artifact}</code>
      <p className="rv-foot">只读查看；启动、继续与审批都在聊天里完成。</p>
    </Section>
  </aside>;
}

function StepInspector({ asset, flow, step, onClose }: { asset: ViewerAsset; flow: WorkflowStatus | null; step: ViewerAssetStep; onClose: () => void }) {
  const runtime = flow?.steps.find((candidate) => candidate.id === step.id);
  const index = asset.steps.findIndex((candidate) => candidate.id === step.id);
  const current = flow?.step === step.id;
  return <aside className="rv-inspector" data-status={flowPanelStatus(flow, current)} data-ralphflow-step-inspector={step.id} aria-label={`步骤详情：${step.description || step.id}`}>
    <div className="rv-inspector-head">
      <div>
        <div className="rv-eyebrow">STEP · {String(index + 1).padStart(2, "0")} · {step.id}</div>
        <h2 className="rv-inspector-title">{step.description || step.id}</h2>
        <div className="rv-inspector-sub">
          {current && flow ? <Chips chips={flowPhaseChips(flow)} />
            : <span className="rv-chip" data-tone={current ? "run" : "off"}>{current ? "当前步骤" : "静态浏览"}</span>}
          <span>· {step.manual ? "人工审查门" : "自动推进"}</span>
        </div>
      </div>
      <button type="button" className="rv-back" onClick={onClose} aria-label="返回步骤链">← 步骤链</button>
    </div>
    <Section label="DO · 步骤任务"><pre className="rv-pre">{step.do || "（未声明 DO）"}</pre></Section>
    <Section label="CHECK · 独立验收">
      {step.checks.length === 0 ? <p className="rv-note">（跳过对抗性验证）</p>
        : step.checks.length === 1 ? <pre className="rv-pre">{step.checks[0]}</pre>
          : <div className="rv-check-list">{step.checks.map((criterion, index) => <div className="rv-check" key={index}>
            <div className="rv-label">验证者 {index + 1}/{step.checks.length}</div>
            <pre className="rv-pre">{criterion}</pre>
          </div>)}</div>}
    </Section>
    <Section label="流转">
      <p className="rv-note">通过 → {step.onPass === "done" ? "结束" : step.onPass || "下一步"}</p>
      <p className="rv-note">失败 → {step.onFail === "done" ? "结束" : step.onFail || "自身"}</p>
    </Section>
    <Section label="输入 / 交付物">
      <p className="rv-note">输入：{step.input || "（无）"}</p>
      <p className="rv-note">交付物：{step.output || "（无）"}</p>
      {runtime ? <p className="rv-note">本步返工次数：{runtime.failures}</p> : null}
    </Section>
  </aside>;
}

export function ViewerPage(props: Props) {
  injectViewerCss();
  const status = useSyncExternalStore(props.source.subscribe, props.source.getSnapshot, props.source.getSnapshot);
  const [chosenName, setChosenName] = useState<string | null>(null);
  const [pinnedName, setPinnedName] = useState<string | null>(() => readStored(ASSET_STORAGE_KEY));
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [preferredMode, setPreferredMode] = useState<ViewMode | null>(() => {
    const stored = readStored(VIEW_STORAGE_KEY);
    return stored === "columns" || stored === "outline" ? stored : null;
  });
  const [width, setWidth] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const catalog = status.catalog;
  const currentName = status.status?.workflow ?? null;
  const running = currentName && catalog.some((asset) => asset.name === currentName) ? currentName : null;
  // 跑着的那个优先于上次浏览偏好：打开工作图先看到正在跑的；手动切换在本次打开内仍然有效。
  const name = pickAssetName({ catalogNames: catalog.map((asset) => asset.name), running, chosen: chosenName, pinned: pinnedName });
  const asset = catalog.find((candidate) => candidate.name === name) ?? null;
  const graph = asset ? graphRuntimeOf(status, asset) : null;
  const flow = asset ? flowRuntimeOf(status, asset) : null;
  // 默认列表：DAG 画布在窄栏里要横向滚动，列表更适合「先看清楚有哪些节点」。用户主动选过图，就记住。
  const mode = preferredMode ?? "outline";

  // 运行中的工作流换了身份（新一轮 / 换成别的 / 状态消失）→ 作废手动选择，重新跟随运行。
  useEffect(() => { setChosenName(null); }, [running]);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 换资产 / 换视图 / 打开或关闭详情后回到顶部：滚动容器是查看器自己，
  // 上一个长详情留下的 scrollTop 会盖住新面板的标题。
  useEffect(() => {
    const element = rootRef.current;
    if (element) element.scrollTop = 0;
  }, [name, mode, selectedNode, selectedStep]);

  const choose = (next: string) => {
    setChosenName(next);
    setPinnedName(next);
    storeStored(ASSET_STORAGE_KEY, next);
    setSelectedNode(null);
    setSelectedStep(null);
  };
  const chooseMode = (next: ViewMode) => {
    setPreferredMode(next);
    storeStored(VIEW_STORAGE_KEY, next);
  };
  const selectedGraphNode = selectedNode && asset?.kind === "graph" ? asset.nodes.find((node) => node.id === selectedNode) ?? null : null;
  const selectedFlowStep = selectedStep && asset?.kind === "flow" ? asset.steps.find((step) => step.id === selectedStep) ?? null : null;

  return <div ref={rootRef} className="ralphflow-viewer" data-ralphflow-viewer>
    <Header asset={asset} graph={graph} flow={flow} catalog={catalog} name={name} running={running} onChoose={choose} mode={mode} onMode={chooseMode} />
    {status.connection !== "live" ? <div className="rv-banner" data-kind={status.error ? "error" : undefined}>{status.error ?? "正在重新同步，显示最后状态。"}</div> : null}
    {catalog.length === 0 ? <div className="rv-empty"><strong>还没有可显示的工作流</strong><span>在聊天里创建或启动一个 Flow / Graph 工作流后，这里会显示只读结构。</span></div> : null}
    {asset?.invalid ? <div className="rv-banner" data-kind="error">{asset.problems.join("\n")}</div> : null}
    {asset && !asset.invalid ? selectedGraphNode ? <GraphInspector asset={asset} graph={graph} node={selectedGraphNode} onClose={() => setSelectedNode(null)} />
      : selectedFlowStep ? <StepInspector asset={asset} flow={flow} step={selectedFlowStep} onClose={() => setSelectedStep(null)} />
        : asset.kind === "graph" ? <GraphCanvas asset={asset} graph={graph} mode={mode} width={Math.max(0, width - 28)} onOpen={setSelectedNode} />
          : <FlowList asset={asset} flow={flow} onOpen={setSelectedStep} /> : null}
  </div>;
}

/** 注册只读 tab：类型 + 右侧栏 seat；数据走调用方给的共享 status source。 */
export function registerViewerTab(ctx: Context, sourceOf: (sessionId: string) => Source): void {
  const face = ctx as unknown as {
    sidebarRightTabs?: { register(definition: unknown): () => void };
    slots?: { inject(name: string, factory: () => () => void): void; register(props: unknown, component: unknown): () => void };
    effect?: (callback: () => () => void, label?: string) => void;
  };
  const rightTabs = (ctx as unknown as { get?: (name: string) => unknown }).get?.("sidebarRightTabs") as
    | { register(definition: unknown): () => void }
    | undefined;
  if (!rightTabs || !face.slots) return;
  try {
    face.effect?.(() => rightTabs.register({
      id: VIEWER_TAB_ID,
      kind: VIEWER_KIND,
      title: () => "RalphFlow 工作图（只读）",
      guide: [{
        id: VIEWER_TAB_ID,
        order: 10,
        title: () => "RalphFlow 工作图（只读）",
        description: () => "查看 Flow 步骤链与 Graph DAG、节点 DO/CHECK 和当前状态；启动、继续与审批都在聊天里完成。",
      }],
    }), "ralphflow viewer tab type");
    face.slots.inject("sidebar.right.pane.tab", () => {
      try {
        return face.slots!.register({
          name: "sidebar.right.pane.tab",
          key: VIEWER_TAB_ID,
          inject: (sessionId: string) => ({ sessionId, source: sourceOf(sessionId) }),
        }, ViewerPage);
      } catch {
        return () => {};
      }
    });
  } catch {
    // 只读查看器是可降级能力：宿主右侧栏版本不匹配时不能拖垮整个客户端插件。
  }
}
