/**
 * Graph 资产的发现与加载（`graphs/` 目录 + 内置）。
 *
 * 与 Flow 的关系：**目录先分派、再看 kind**（design §2.3）。`workflows/` 只按 Flow 校验，
 * `graphs/` 只按 Graph 校验；`kind` 与目录不一致、或同一名字跨类别出现，都是加载期硬错误，
 * 不做“先找到哪个算哪个”的隐式解析。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { RALPH_FLOW_DIR } from "../engine.js";
import { userRalphFlowDir } from "../paths.js";
import { validateGraphAsset, type GraphAsset } from "./asset.js";

export const GRAPH_DIRNAME = "graphs";
export const BUILTIN_GRAPHS = ["codewiki"] as const;

export interface GraphWorkflowEntry {
  name: string;
  desc: string;
  invalid: boolean;
  problems: string[];
  warnings: string[];
  path?: string;
  source: "workspace" | "global" | "builtin";
  nodes: number;
  id?: string;
}

export interface GraphLoadResult {
  def: GraphAsset | null;
  problems: string[];
  warnings: string[];
  path?: string;
}

export interface DiscoveredYaml {
  kind: "flow" | "graph" | "conflict" | "unknown";
  problems: string[];
  nodes: number;
}

/** 项目级 Graph 资产目录：`<项目根>/.dsh/ralph-flow/graphs/` */
export function graphWorkspaceDir(workspace: string): string {
  return path.join(workspace, RALPH_FLOW_DIR, GRAPH_DIRNAME);
}

/** 用户级 Graph 资产目录：`<DSH_HOME|~/.dsh>/ralph-flow/graphs/` */
export function graphGlobalDir(): string {
  return userRalphFlowDir(GRAPH_DIRNAME);
}

/** 内置 Graph 资产路径（不落盘，随包发布；`lib/graph/assets.js` → `<pkg>/graphs/<name>.yaml`）。 */
export function builtinGraphPath(name: string): string | undefined {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "..", GRAPH_DIRNAME, `${name}.yaml`),
    path.resolve(here, "..", "..", "..", GRAPH_DIRNAME, `${name}.yaml`),
  ];
  return candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
}

/**
 * 只看顶层结构，判断一份 YAML 属于哪类资产。**不替代完整校验**：它只负责在把文件交给
 * Flow 或 Graph 校验器之前，先发现“无 kind 的 nodes”“kind 与结构冲突”“两类结构同写”。
 */
export function classifyYamlDocument(doc: unknown): DiscoveredYaml {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { kind: "unknown", problems: ["内容不是一个 YAML 映射。"], nodes: 0 };
  }
  const record = doc as Record<string, unknown>;
  const problems: string[] = [];
  const hasSteps = Object.prototype.hasOwnProperty.call(record, "steps");
  const hasNodes = Object.prototype.hasOwnProperty.call(record, "nodes");
  const kind = record.kind;
  if (kind !== undefined && kind !== "flow" && kind !== "graph") problems.push("`kind` 只能是 `flow` 或 `graph`。");
  if (hasSteps && hasNodes) problems.push("资产同时写了 `steps` 和 `nodes`：Flow 与 Graph 字段不混用。");
  // 新格式：Graph 也用 Flow 风格的 steps；只有「两类结构同写」才是冲突。
  if (kind === "flow" && hasNodes) problems.push("声明了 `kind: flow` 却写了 `nodes`：Flow 资产必须是 `steps`。");
  if (kind === undefined && hasNodes) problems.push("Graph 资产（`nodes`）必须显式声明 `kind: graph`；无 kind 的 nodes 资产不会被猜测成 Graph。");
  if (problems.length > 0) {
    return { kind: "conflict", problems, nodes: Array.isArray(record.nodes) ? record.nodes.length : 0 };
  }
  if (kind === "graph" || (kind === undefined && hasSteps)) {
    return {
      kind: kind === "graph" ? "graph" : "flow",
      problems: [],
      nodes: Array.isArray(record.nodes) ? record.nodes.length : Array.isArray(record.steps) ? record.steps.length : 0,
    };
  }
  if (hasSteps) return { kind: "flow", problems: [], nodes: 0 };
  return { kind: "unknown", problems: ["没有 `steps` 或 `nodes`：无法判断工作流类别。"], nodes: 0 };
}

function readYamlFile(file: string): { doc?: unknown; problem?: string } {
  let raw: string;
  try { raw = fs.readFileSync(file, "utf-8"); } catch (error) {
    return { problem: `${file} 读取失败：${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    return { doc: yaml.load(raw.replace(/^\uFEFF/, "")) };
  } catch (error) {
    return { problem: `${file} YAML 解析失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

function withGraphIdentity(doc: unknown, name: string): unknown {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return doc;
  const record = doc as Record<string, unknown>;
  return { ...record, id: record.id ?? name, name: record.name ?? name };
}

function graphCandidatePaths(workspace: string, name: string): Array<{ file: string; source: GraphWorkflowEntry["source"] }> {
  const out: Array<{ file: string; source: GraphWorkflowEntry["source"] }> = [];
  for (const [dir, source] of [
    [graphWorkspaceDir(workspace), "workspace"],
    [graphGlobalDir(), "global"],
  ] as const) {
    out.push({ file: path.join(dir, `${name}.yaml`), source });
    out.push({ file: path.join(dir, `${name}.yml`), source });
  }
  const builtin = builtinGraphPath(name);
  if (builtin) out.push({ file: builtin, source: "builtin" });
  return out;
}

/** 某工作区里所有 Graph 资产的发现结果（工作区遮蔽全局/内置；不建目录）。 */
export function listGraphWorkflows(workspace: string): GraphWorkflowEntry[] {
  const found = new Map<string, { file: string; source: GraphWorkflowEntry["source"] }>();
  const addDir = (dir: string, source: GraphWorkflowEntry["source"]): void => {
    let files: string[] = [];
    try { files = fs.readdirSync(dir); } catch { return; }
    for (const file of files) {
      if (!/\.ya?ml$/i.test(file)) continue;
      const name = file.replace(/\.ya?ml$/i, "");
      if (found.has(name)) continue;
      found.set(name, { file: path.join(dir, file), source });
    }
  };
  addDir(graphWorkspaceDir(workspace), "workspace");
  addDir(graphGlobalDir(), "global");
  for (const name of BUILTIN_GRAPHS) {
    if (found.has(name)) continue;
    const file = builtinGraphPath(name);
    if (file) found.set(name, { file, source: "builtin" });
  }
  return [...found.entries()].map(([name, { file, source }]) => {
    const { doc, problem } = readYamlFile(file);
    if (problem) return { name, desc: "", invalid: true, problems: [problem], warnings: [], path: file, source, nodes: 0 };
    const classified = classifyYamlDocument(doc);
    if (classified.kind === "flow") {
      return {
        name, desc: "", invalid: true,
        problems: [`${file} 是 Flow 资产（steps），却放在 graphs/ 目录：Flow 资产只放 workflows/。`],
        warnings: [], path: file, source, nodes: 0,
      };
    }
    if (classified.kind !== "graph") {
      return { name, desc: "", invalid: true, problems: classified.problems, warnings: [], path: file, source, nodes: classified.nodes };
    }
    const validation = validateGraphAsset(withGraphIdentity(doc, name));
    return {
      name,
      desc: validation.asset?.description ?? "",
      invalid: validation.asset === null,
      problems: validation.errors.map((error) => `${error.path || "/"}：${error.message}`),
      warnings: validation.warnings,
      path: file,
      source,
      nodes: validation.asset?.nodes.length ?? classified.nodes,
      ...(validation.asset ? { id: validation.asset.id } : {}),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
}

/** 加载一份 Graph 资产（工作区 → 全局 → 内置）；目录/kind 不一致是硬错误。 */
export function loadGraphWorkflow(workspace: string, name: string): GraphLoadResult {
  const problems: string[] = [];
  const warnings: string[] = [];
  const candidates = graphCandidatePaths(workspace, name);
  // 工作区里的同名文件遮蔽全局/内置：只取第一个存在的候选，但**继续检查**是否还有别的
  // 类别（Flow）用了同一个名字 —— 跨类别同名由 listAssetsIn/doctor 统一报。
  let chosen: { file: string; source: GraphWorkflowEntry["source"] } | undefined;
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate.file).isFile()) { chosen = candidate; break; }
    } catch {}
  }
  if (!chosen) {
    problems.push(`未找到 Graph 工作流 "${name}"。把 YAML 放到 ${graphWorkspaceDir(workspace)}/<name>.yaml 即可被识别。`);
    return { def: null, problems, warnings };
  }
  const { doc, problem } = readYamlFile(chosen.file);
  if (problem) return { def: null, problems: [problem], warnings, path: chosen.file };
  const classified = classifyYamlDocument(doc);
  if (classified.kind === "flow") {
    problems.push(`${chosen.file} 是 Flow 资产（steps），却放在 graphs/ 目录：Flow 资产只放 workflows/。`);
    return { def: null, problems, warnings, path: chosen.file };
  }
  if (classified.kind !== "graph") {
    problems.push(...classified.problems);
    return { def: null, problems, warnings, path: chosen.file };
  }
  const validation = validateGraphAsset(withGraphIdentity(doc, name));
  warnings.push(...validation.warnings);
  if (!validation.asset) {
    problems.push(...validation.errors.map((error) => `${error.path || "/"}：${error.message}`));
    return { def: null, problems, warnings, path: chosen.file };
  }
  const asset = validation.asset;
  const fileBase = path.basename(chosen.file).replace(/\.ya?ml$/i, "");
  if (asset.id !== fileBase) {
    // 文件名是启动名与技能名，id 是资产自身标识；不一致会让“报告里的 id”与“启动的名字”分叉。
    warnings.push(`资产 id "${asset.id}" 与文件名 "${fileBase}" 不一致：启动名以文件名为准，报告会同时记录两者。`);
  }
  return { def: asset, problems, warnings, path: chosen.file };
}

/** 跨类别同名：返回同时出现在 Flow 与 Graph 里的名字（doctor/list/start 都据此拒绝）。 */
export function crossKindNameConflicts(flowNames: readonly string[], graphEntries: readonly GraphWorkflowEntry[]): Array<{ name: string; kind: "flow-graph" }> {
  const graphNames = new Set(graphEntries.map((entry) => entry.name));
  return [...new Set(flowNames)].filter((name) => graphNames.has(name)).sort().map((name) => ({ name, kind: "flow-graph" as const }));
}

/** 供测试与 doctor 用：列出候选文件（不读内容）。 */
export function graphAssetFiles(workspace: string): string[] {
  const files: string[] = [];
  for (const dir of [graphWorkspaceDir(workspace), graphGlobalDir()]) {
    try {
      for (const entry of fs.readdirSync(dir)) if (/\.ya?ml$/i.test(entry)) files.push(path.join(dir, entry));
    } catch {}
  }
  for (const name of BUILTIN_GRAPHS) {
    const file = builtinGraphPath(name);
    if (file) files.push(file);
  }
  return files;
}
