/**
 * 统一资产发现：Flow（`workflows/`）与 Graph（`graphs/`）两类并列。
 *
 * 这个模块只做**只读枚举与合并**，不校验、不执行、不建目录。完整校验由各自的引擎负责
 * （Flow `listWorkflows()` / Graph `listGraphWorkflows()`），门面把它们合并给 `list`、
 * `doctor`、状态面与动态技能。跨类别同名在这里就能被发现：`ralphflow_start <name>`
 * 只能解析出一个资产，绝不能“先找到哪个算哪个”。
 */
import { listWorkflowsIn, type WorkflowEntry } from "./engine.js";
import { listGraphWorkflows, type GraphWorkflowEntry } from "./graph/assets.js";

export type AssetKind = "flow" | "graph";

export interface AssetSummary {
  name: string;
  desc: string;
  kind: AssetKind;
  /** 步骤数（Flow）或节点数（Graph） */
  count: number;
}

export interface UnifiedAssetEntry {
  name: string;
  kind: AssetKind;
  desc: string;
  invalid: boolean;
  problems: string[];
  warnings: string[];
  count: number;
  source: "workspace" | "global" | "builtin" | "flow";
  path?: string;
  /** 跨类别同名：Flow 与 Graph 同时存在。 */
  conflict?: boolean;
}

/** 只读清单（给动态技能用；不校验内容，避免会话创建时读整棵目录）。 */
export function discoverAssetsIn(workspace: string): AssetSummary[] {
  const out: AssetSummary[] = [];
  const seen = new Set<string>();
  for (const workflow of listWorkflowsIn(workspace)) {
    out.push({ name: workflow.name, desc: workflow.desc, kind: "flow", count: 0 });
    seen.add(workflow.name);
  }
  for (const graph of listGraphWorkflows(workspace)) {
    if (seen.has(graph.name)) continue;
    out.push({ name: graph.name, desc: graph.desc, kind: "graph", count: graph.nodes });
  }
  return out.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * 把 Flow 引擎的完整校验结果与 Graph 发现结果合并。
 * 跨类别同名时两条都标 `conflict`，`list`/`doctor` 必须报错，`start` 拒绝。
 */
export function mergeAssets(flowEntries: readonly WorkflowEntry[], graphEntries: readonly GraphWorkflowEntry[]): UnifiedAssetEntry[] {
  const flowNames = new Set(flowEntries.map((entry) => entry.name));
  const graphNames = new Set(graphEntries.map((entry) => entry.name));
  const merged: UnifiedAssetEntry[] = [
    ...flowEntries.map((entry): UnifiedAssetEntry => {
      const conflict = graphNames.has(entry.name);
      return {
        name: entry.name,
        kind: "flow",
        desc: entry.desc,
        invalid: entry.invalid || conflict,
        problems: conflict ? [`名字 \`${entry.name}\` 同时出现在 workflows/ 与 graphs/：跨类别同名是冲突，必须改名。`] : entry.problems,
        warnings: entry.warnings,
        count: entry.steps ?? 0,
        source: "flow",
        ...(conflict ? { conflict: true } : {}),
      };
    }),
    ...graphEntries.map((entry): UnifiedAssetEntry => {
      const conflict = flowNames.has(entry.name);
      return {
        name: entry.name,
        kind: "graph",
        desc: entry.desc,
        invalid: entry.invalid || conflict,
        problems: conflict ? [`名字 \`${entry.name}\` 同时出现在 workflows/ 与 graphs/：跨类别同名是冲突，必须改名。`] : entry.problems,
        warnings: entry.warnings,
        count: entry.nodes,
        source: entry.source,
        ...(entry.path ? { path: entry.path } : {}),
        ...(conflict ? { conflict: true } : {}),
      };
    }),
  ];
  return merged.sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
}

/** 名字 → 唯一条目；跨类别同名返回 conflict 而不是任选一个。 */
export function findAssetByName(entries: readonly UnifiedAssetEntry[], name: string): UnifiedAssetEntry | undefined {
  const matches = entries.filter((entry) => entry.name === name);
  if (matches.length > 1) {
    return {
      name,
      kind: matches[0]!.kind,
      desc: "",
      invalid: true,
      problems: [`名字 \`${name}\` 同时出现在 workflows/ 与 graphs/：跨类别同名是冲突，必须改名后才能启动。`],
      warnings: [],
      count: 0,
      source: "flow",
      conflict: true,
    };
  }
  return matches[0];
}

export function kindLabel(kind: AssetKind): string {
  return kind === "graph" ? "Graph" : "Flow";
}

export type { WorkflowEntry, GraphWorkflowEntry };
