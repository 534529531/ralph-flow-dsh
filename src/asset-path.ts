/**
 * 资产形态：**一个目录 + 固定入口文件**，或兼容的**单文件**。
 *
 * ```text
 * workflows/<name>/workflow.yaml      ← 目录形态（推荐）
 * workflows/<name>.yaml               ← 单文件形态（兼容）
 * graphs/<name>/graph.yaml
 * graphs/<name>.yaml
 * ```
 *
 * 两种形态的**参考根都是入口文件所在目录** —— 与 dsh 的 Skill 完全同构
 * （`<name>/SKILL.md` 的根是那个目录，`<name>.md` 的根是它所在的目录）。DO/CHECK 里引用的
 * **资产资源**（页面契约、模板、校验清单）用相对路径按它解析，资产因此可以把这些材料放在
 * 自己旁边，而不是把它们复制进每一步的提示词。要写出的交付物按 `output` / 产出目录的落点
 * —— 资产资源与产出物是两条并行的落点规则。
 *
 * 这里只做路径拼装与推导：不读内容、不建目录、不校验资产。
 */
import fs from "node:fs";
import path from "node:path";

/** 目录形态的 Flow 入口文件名。 */
export const FLOW_ENTRY_FILE = "workflow.yaml";
/** 目录形态的 Graph 入口文件名。 */
export const GRAPH_ENTRY_FILE = "graph.yaml";

/** Flow 资产根目录名：目录形态的入口在 `workflows/<name>/` 下一层。 */
const FLOW_ROOT_DIRNAME = "workflows";
/** Graph 资产根目录名：目录形态的入口在 `graphs/<name>/` 下一层。 */
const GRAPH_ROOT_DIRNAME = "graphs";

/** 一个资产在某个目录里的候选入口：目录形态优先，其次是兼容的单文件形态。 */
export function assetCandidates(dir: string, name: string, entryFile: string): string[] {
  return [path.join(dir, name, entryFile), path.join(dir, `${name}.yaml`), path.join(dir, `${name}.yml`)];
}

/** 某个目录里该资产的入口文件（目录形态优先）；没有就 undefined。 */
export function assetFileIn(dir: string, name: string, entryFile: string): string | undefined {
  return assetCandidates(dir, name, entryFile).find(isFile);
}

/** 参考根：入口文件所在目录。没有加载到资产时没有根。 */
export function assetRootOf(entryPath: string | undefined): string | undefined {
  return entryPath ? path.dirname(entryPath) : undefined;
}

/**
 * 从入口路径推导资产名：目录形态取父目录名，单文件形态取文件名去掉扩展名。
 *
 * 目录形态的判据只有一条：入口文件位于**资产根**（`workflows/` / `graphs/`）下一层，
 * 即 `workflows/<name>/workflow.yaml`、`graphs/<name>/graph.yaml`。不在这一层里的
 * `workflow.yaml` / `graph.yaml` 是兼容形态的**单文件资产**（名为 `workflow` / `graph`），
 * 不能因为扩展名前缀恰好撞上固定入口名就被读成目录形态。
 *
 * 名字规则只写在路径层：doctor 的路径参数与以后任何「拿一个入口路径问名字」的调用都走这里，
 * 不在调用方各自 `path.basename(...).replace(...)`。
 */
export function assetNameOf(entryPath: string): string {
  const base = path.basename(entryPath);
  const parentDir = path.dirname(entryPath);
  const rootDirName = path.basename(path.dirname(parentDir));
  const expectedRoot = base === FLOW_ENTRY_FILE
    ? FLOW_ROOT_DIRNAME
    : base === GRAPH_ENTRY_FILE
      ? GRAPH_ROOT_DIRNAME
      : undefined;
  return expectedRoot && rootDirName === expectedRoot
    ? path.basename(parentDir)
    : assetNameFromFile(entryPath);
}

/** 单文件形态的名字：文件名去掉 `.yaml` / `.yml`。 */
function assetNameFromFile(file: string): string {
  return path.basename(file).replace(/\.ya?ml$/i, "");
}

export interface AssetEntry {
  /** 入口文件路径。 */
  file: string;
  /** 资产名（目录形态取目录名，单文件形态取文件名）。 */
  name: string;
}

/**
 * 把一个路径解析成资产入口：入口文件本身，或包含 `workflow.yaml` / `graph.yaml` 的资产目录。
 *
 * 只接受真实存在的文件或目录；解析不出来返回 undefined，由调用方说清合法形态。
 */
export function assetEntryAt(target: string): AssetEntry | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return undefined;
  }
  if (stat.isDirectory()) {
    const name = path.basename(target);
    for (const entryFile of [FLOW_ENTRY_FILE, GRAPH_ENTRY_FILE]) {
      const file = path.join(target, entryFile);
      if (isFile(file)) return { file, name };
    }
    return undefined;
  }
  if (!stat.isFile()) return undefined;
  return { file: target, name: assetNameOf(target) };
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * 列出一个目录里的全部资产入口（名字 → 入口文件）。
 *
 * 目录形态优先：同名时以 `<name>/<entryFile>` 为准。不读内容、不建目录。
 *
 * 用 `statSync` 判断类型（跟随符号链接），与 `loadWorkflow` 的 `statSync` 口径一致：
 * 软链到目录或 YAML 的资产同样能被 list / doctor / 动态技能发现，不在发现面与加载面分叉。
 */
export function discoverAssetsIn(dir: string, entryFile: string): Map<string, string> {
  const found = new Map<string, string>();
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    const entry = path.join(dir, name);
    if (!isDirectory(entry)) continue;
    const file = path.join(entry, entryFile);
    if (isFile(file)) found.set(name, file);
  }
  for (const name of names) {
    if (!/\.ya?ml$/i.test(name)) continue;
    const assetName = assetNameFromFile(name);
    if (found.has(assetName)) continue;
    const file = path.join(dir, name);
    if (isFile(file)) found.set(assetName, file);
  }
  return found;
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/**
 * DO 与 CHECK 提示词里同一段「资产目录」说明（没有资产路径时返回 undefined）。
 *
 * 与 dsh 注入 Skill 资源根的两句同构（名词不同）：模型在 Skill 里见过同一个形状，迁过来没有
 * 新概念。**只在这里写一次** —— Flow/Graph × 执行者/验证者四处注入点都引用它。
 *
 * 第二句限定在**资产资源**：要写出的交付物仍按 `output` / 任务指定的落点。边界按**用途**
 * （读参考材料 vs 写交付物）划，不按「文件名是否带路径」划 —— 短指针 `format.md` 是资产资源，
 * `summary.md` 是过程文档，两者都可以是裸文件名。
 */
export function assetReferenceSection(root: string | undefined): string | undefined {
  if (!root) return undefined;
  return `## 资产目录\n\`${root}\` —— 本资产的基准目录。\n本资产自己的资源（契约、模板、校验清单等）若用相对路径，先相对这个基准目录解析再使用，需要的资源才读取；要写出的交付物按各自的落点（\`output\`、任务指定的落点），不在这个目录。`;
}
