/**
 * Graph 工作流资产契约（`graphs/*.yaml`）。
 *
 * 用户格式与 Flow 对齐：`steps` / `id` / `desc` / `do` / `output` / `check`；
 * Graph 只额外用 `depends_on` 表达 DAG。运行时内部仍用 `GraphNode`
 *（`artifact` / `dependsOn` / 派生的上游 `inputs`）。
 *
 * Graph 始终在 Git 隔离 worktree 中并行执行，没有 workspace 开关；
 * 没有固定默认 CHECK；`check` 是显式判据字符串或 `null`。
 */
import { createHash } from "node:crypto";
import { checkDefinition } from "./check.js";

export const GRAPH_KIND = "graph" as const;

export type GraphExecution = "background" | "main";

export interface GraphInputReference {
  fromNode: string;
  artifact: string;
}

export interface GraphCheckCustom {
  mode: "custom";
  criteria: string;
}
export type GraphCheck = GraphCheckCustom;

export interface GraphNode {
  id: string;
  name?: string;
  do: string;
  artifact: string;
  dependsOn: string[];
  inputs: GraphInputReference[];
  execution: GraphExecution;
  check: GraphCheck | null;
}

export interface GraphAsset {
  kind: typeof GRAPH_KIND;
  id: string;
  name: string;
  description?: string;
  manual_step: string[];
  nodes: GraphNode[];
}

export interface GraphAssetIssue {
  path: string;
  code: string;
  message: string;
}

export interface GraphAssetValidation {
  asset: GraphAsset | null;
  errors: GraphAssetIssue[];
  warnings: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const stableIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isStableId(value: unknown): value is string {
  return typeof value === "string"
    && value.trim() === value
    && stableIdPattern.test(value)
    && !value.includes("..");
}

export function isArtifactPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return false;
  if (value.includes("\\") || value.includes("\0")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/** 校验并归一化一份 Graph 资产；返回的 asset 是深度冻结的快照。 */
export function validateGraphAsset(input: unknown): GraphAssetValidation {
  const errors: GraphAssetIssue[] = [];
  const warnings: string[] = [];
  const issue = (at: string, code: string, message: string): void => {
    errors.push({ path: at, code, message });
  };

  if (!isRecord(input)) {
    return { asset: null, errors: [{ path: "", code: "INVALID_ASSET", message: "Graph 资产必须是一个 YAML 映射。" }], warnings };
  }

  if (input.kind !== GRAPH_KIND) {
    issue("/kind", "MISSING_KIND", "Graph 资产必须显式声明 `kind: graph`。");
  }
  if (Object.prototype.hasOwnProperty.call(input, "nodes")) {
    issue("/nodes", "OLD_NODES_FORMAT", "Graph 只使用 `steps`；`nodes` / `dependsOn` / `artifact` 不是本版本的字段，改用 `steps` + `depends_on` + `output`。");
  }

  const unsupportedTopLevel = [
    "kind", "steps", "id", "name", "description", "manual_step",
    "inputs", "resources", "parallel", "run_inputs", "shared_resources", "max_parallel_agents",
    "workspace", "workspace_resources", "workspace_environment", "version",
  ];
  for (const key of Object.keys(input)) {
    if (!unsupportedTopLevel.includes(key)) {
      issue(`/${key}`, "UNSUPPORTED_FIELD", `Graph 资产不支持顶层字段 \`${key}\`。`);
    }
  }
  for (const key of ["inputs", "resources", "parallel", "run_inputs", "shared_resources", "max_parallel_agents", "workspace", "workspace_resources", "workspace_environment", "version"]) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      issue(`/${key}`, "REMOVED_FIELD", `Graph 资产不支持 \`${key}\`：Graph 始终用 Git 隔离；用 \`steps\` 的 \`depends_on\` 表达任务图，并发由宿主的 agent 额度管理。`);
    }
  }

  if (!isStableId(input.id)) {
    issue("/id", "INVALID_ID", "资产 id 必须是稳定的、可作文件名的标识（字母数字开头，只含 A-Z a-z 0-9 . _ -）。");
  }
  if (typeof input.name !== "string" || !input.name.trim()) {
    issue("/name", "MISSING_NAME", "资产 name 不能为空。");
  }
  if (input.description !== undefined && typeof input.description !== "string") {
    issue("/description", "INVALID_DESCRIPTION", "description 必须是字符串。");
  }

  const rawSteps = input.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    issue("/steps", "MISSING_STEPS", "Graph 资产至少需要一个步骤。");
    return { asset: null, errors, warnings };
  }

  const stepIndexById = new Map<string, number>();
  const outputById = new Map<string, string>();
  rawSteps.forEach((raw, index) => {
    if (!isRecord(raw)) return;
    if (isStableId(raw.id)) {
      stepIndexById.set(raw.id, index);
      outputById.set(raw.id, typeof raw.output === "string" ? raw.output : `${raw.id}.md`);
    }
  });

  const supportedStepKeys = new Set(["id", "desc", "do", "output", "depends_on", "execution", "check"]);
  const normalized: Array<GraphNode | null> = [];
  const artifactIndexByPath = new Map<string, number>();

  rawSteps.forEach((raw, index) => {
    const at = `/steps/${index}`;
    if (!isRecord(raw)) {
      issue(at, "INVALID_STEP", "步骤必须是对象。");
      normalized.push(null);
      return;
    }
    for (const key of Object.keys(raw)) {
      if (!supportedStepKeys.has(key)) issue(`${at}/${key}`, "UNSUPPORTED_STEP_FIELD", `Graph 步骤不支持 \`${key}\`；可用字段：id、desc、do、output、depends_on、execution、check。`);
    }

    if (!isStableId(raw.id)) issue(`${at}/id`, "INVALID_STEP_ID", "步骤 id 必须是稳定标识。");
    else if ([...rawSteps.slice(0, index)].some((item) => isRecord(item) && item.id === raw.id)) {
      issue(`${at}/id`, "DUPLICATE_STEP_ID", `步骤 id "${raw.id}" 重复。`);
    }
    if (typeof raw.desc !== "string" || !raw.desc.trim()) {
      issue(`${at}/desc`, "MISSING_STEP_DESC", "每个步骤都要写 `desc`（一句话说明）。");
    }
    if (typeof raw.do !== "string" || !raw.do.trim()) issue(`${at}/do`, "MISSING_DO", "步骤 DO 不能为空。");

    let check: GraphCheck | null;
    try {
      const definition = checkDefinition(raw.check as never);
      check = definition.mode === "disabled" ? null : { mode: "custom", criteria: definition.criteriaText };
    } catch (error) {
      issue(`${at}/check`, "INVALID_CHECK", error instanceof Error ? error.message : String(error));
      check = null;
    }

    const id = isStableId(raw.id) ? raw.id : "";
    const artifact = typeof raw.output === "string" ? raw.output : (id ? `${id}.md` : `step-${index + 1}.md`);
    if (!isArtifactPath(artifact)) {
      issue(`${at}/output`, "INVALID_ARTIFACT_PATH", "output 必须是非空、安全的相对路径（不能含 . / .. 段）。");
    } else if (artifactIndexByPath.has(artifact)) {
      issue(`${at}/output`, "DUPLICATE_ARTIFACT_PATH", `output "${artifact}" 与 /steps/${artifactIndexByPath.get(artifact)}/output 重复。`);
    } else {
      artifactIndexByPath.set(artifact, index);
    }

    let dependsRaw: unknown = raw.depends_on === undefined ? [] : raw.depends_on;
    if (!Array.isArray(dependsRaw)) {
      issue(`${at}/depends_on`, "INVALID_DEPENDENCIES", "depends_on 必须是步骤 id 数组。");
      dependsRaw = [];
    }
    const seenDependencies = new Set<string>();
    const dependsOn = (dependsRaw as unknown[]).map((dependency, dependencyIndex) => {
      if (!isStableId(dependency)) {
        issue(`${at}/depends_on/${dependencyIndex}`, "INVALID_DEPENDENCY_ID", "依赖必须是合法步骤 id。");
        return String(dependency);
      }
      if (seenDependencies.has(dependency)) {
        issue(`${at}/depends_on/${dependencyIndex}`, "DUPLICATE_DEPENDENCY", `依赖 "${dependency}" 重复。`);
      }
      seenDependencies.add(dependency);
      return dependency;
    });

    const execution = raw.execution === undefined ? "background" : raw.execution;
    if (execution !== "background" && execution !== "main") {
      issue(`${at}/execution`, "INVALID_EXECUTION", "execution 必须是 \"background\" 或 \"main\"。");
    }

    normalized.push({
      id,
      ...(typeof raw.desc === "string" ? { name: raw.desc.trim() } : {}),
      do: typeof raw.do === "string" ? raw.do.trim() : String(raw.do ?? ""),
      artifact,
      dependsOn,
      inputs: dependsOn.map((dependency) => ({ fromNode: dependency, artifact: outputById.get(dependency) ?? `${dependency}.md` })),
      execution: execution as GraphExecution,
      check,
    });
  });

  // 引用完整性 + 环检测
  normalized.forEach((node, index) => {
    if (!node) return;
    for (const [dependencyIndex, dependency] of node.dependsOn.entries()) {
      const sourceIndex = stepIndexById.get(dependency);
      if (sourceIndex === undefined) {
        issue(`/steps/${index}/depends_on/${dependencyIndex}`, "UNKNOWN_DEPENDENCY", `依赖 "${dependency}" 不存在于本资产。`);
      } else if (dependency === node.id) {
        issue(`/steps/${index}/depends_on/${dependencyIndex}`, "SELF_DEPENDENCY", "步骤不能依赖自身。");
      }
    }
    for (const [inputIndex, reference] of node.inputs.entries()) {
      const sourceIndex = stepIndexById.get(reference.fromNode);
      if (sourceIndex === undefined) {
        issue(`/steps/${index}/depends_on/${inputIndex}`, "UNKNOWN_INPUT_SOURCE", `输入来源 "${reference.fromNode}" 不存在。`);
        continue;
      }
      const source = normalized[sourceIndex];
      if (source && source.artifact !== reference.artifact) {
        issue(`/steps/${index}/depends_on/${inputIndex}`, "INPUT_ARTIFACT_MISMATCH", `步骤 "${reference.fromNode}" 的 output 是 "${source.artifact}"。`);
      }
    }
  });

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycleReported = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const index = stepIndexById.get(id);
      if (index !== undefined && !cycleReported.has(id)) {
        cycleReported.add(id);
        issue(`/steps/${index}/depends_on`, "DEPENDENCY_CYCLE", `步骤 "${id}" 参与了依赖环。`);
      }
      return;
    }
    visiting.add(id);
    const node = normalized[stepIndexById.get(id) ?? -1];
    for (const dependency of node?.dependsOn ?? []) if (stepIndexById.has(dependency)) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of stepIndexById.keys()) visit(id);

  let manualRaw: unknown = input.manual_step === undefined ? [] : input.manual_step;
  if (typeof manualRaw === "string") manualRaw = manualRaw.split(",").map((item) => item.trim()).filter(Boolean);
  if (!Array.isArray(manualRaw)) {
    issue("/manual_step", "INVALID_MANUAL_STEP", "manual_step 必须是步骤 id 列表（或逗号分隔字符串）。");
    manualRaw = [];
  }
  const manualSeen = new Set<string>();
  const manualStep = (manualRaw as unknown[]).map((id, index) => {
    if (!isStableId(id)) issue(`/manual_step/${index}`, "INVALID_MANUAL_STEP_ID", "manual_step 条目必须是合法步骤 id。");
    else if (!stepIndexById.has(id)) issue(`/manual_step/${index}`, "UNKNOWN_MANUAL_STEP", `manual_step 引用了不存在的步骤 "${id}"。`);
    if (manualSeen.has(String(id))) issue(`/manual_step/${index}`, "DUPLICATE_MANUAL_STEP", `步骤 "${String(id)}" 在 manual_step 中重复。`);
    manualSeen.add(String(id));
    return String(id);
  });

  if (errors.length > 0) return { asset: null, errors, warnings };

  const asset: GraphAsset = {
    kind: GRAPH_KIND,
    id: input.id as string,
    name: (input.name as string).trim(),
    ...(typeof input.description === "string" ? { description: input.description } : {}),
    manual_step: manualStep,
    nodes: normalized.filter((node): node is GraphNode => node !== null),
  };
  return { asset: deepFreeze(asset), errors: [], warnings };
}

/** 资产内容哈希（报告与状态快照用；不依赖文件 mtime）。 */
export function graphAssetHash(asset: GraphAsset): string {
  const canonical = {
    kind: asset.kind,
    id: asset.id,
    name: asset.name,
    description: asset.description,
    manual_step: asset.manual_step,
    nodes: asset.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      do: node.do,
      artifact: node.artifact,
      dependsOn: node.dependsOn,
      inputs: node.inputs,
      execution: node.execution,
      check: node.check,
    })),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

/** 启动回执里显示的节点摘要。 */
export function describeGraphAsset(asset: GraphAsset): string {
  return asset.nodes.map((node) => `${node.id}${node.dependsOn.length ? ` <- ${node.dependsOn.join(",")}` : ""}`).join("；");
}
