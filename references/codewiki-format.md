# CodeWiki 固定格式契约

本文件是 `codewiki` 工作流的运行时格式契约。每个节点用 `read` 读取 `随包 codewiki-format 参考`；CHECK 也以本文件为准。

版本：`codewiki_schema: 1`。修改输出树、页面模板、schema 或校验清单时递增版本，并同步更新工作流资产。

## 输出树

```text
<outputDir>/
├── index.md
├── overview.md
├── architecture.md
├── workflows.md
├── interfaces.md
├── operations.md
├── modules/
│   ├── <slug>.md
│   └── ...
└── metadata.json
```

- 页面集合固定：`index`、`overview`、`architecture`、`workflows`、`interfaces`、`operations` 各一页，模块页 1–12 页（目标 3–8 页）。
- `<outputDir>` 是专用目录，只包含上树列出的文件。工作区暂存目录 `<workspace>/.ralphflow-codewiki/` 只放 `verify.mjs` 和 `validation.json`，不属于 wiki；plan、manifests、delivery 是节点产物，由引擎的 artifact store 保存。
- `outputDir`、`repository` 都是相对工作区根目录的路径；`outputDir` 不能等于 `repository` 根目录。

工作区暂存文件：

```text
<workspace>/.ralphflow-codewiki/
├── verify.mjs
└── validation.json
```

节点产物（逻辑路径）：

```text
.ralphflow-codewiki/
├── plan.json
├── manifests/
│   ├── core.json
│   ├── modules.json
│   └── operations.json
└── delivery.json
```

节点的 `ralphflow_artifact_write` 把这些产物写入本次运行的 artifact store，物理根是 `.dsh/ralph-flow/artifacts/<artifactsDir>/nodes/<nodeId>/<attemptId>/`；下游用 `read` 读取，不要在 `<workspace>/.ralphflow-codewiki/` 复制这些 JSON。

## 页面契约

### frontmatter

每页（包括 `index.md`）以 `---` 包围的 YAML frontmatter 开始。键和顺序固定：

```yaml
---
codewiki_schema: 1
title: <页面标题>
kind: <index|overview|architecture|workflow|module|interface|operations>
source_commit: <40 位提交 SHA，或 worktree>
generated_at: <ISO 8601>
source_paths:
  - <相对 repository 的路径>
---
```

- `source_paths` 非空，每个路径在 `repository` 下存在；目录和文件都可以。
- 键、顺序、大小写固定；不增加其他键。
- `source_commit` 在所有页面中相同，取自 `plan.source.commit`。
- `generated_at` 是生成该页时的有效 ISO 8601 时间。

### 标题与摘要

```markdown
# <title>

> <一句话摘要，说明本页回答的问题>
```

### 固定二级标题

按顺序使用下列 8 个 H2，编号和文字固定；不增删 H2。H3 可用于页内细分。

`zh-CN`：

1. 定位与职责
2. 关键文件与入口
3. 结构与关系
4. 流程与数据流
5. 接口、配置与依赖
6. 约束、失败模式与坑
7. 源码索引
8. 未覆盖与假设

`en`：

1. Purpose and scope
2. Key files and entry points
3. Structure and relationships
4. Flows and data flow
5. Interfaces, configuration, and dependencies
6. Constraints, failure modes, and pitfalls
7. Source index
8. Uncovered areas and assumptions

`index.md` 使用同一组标题，内容依次为：wiki 范围与阅读顺序、页面清单、页面依赖图、推荐阅读路径、生成输入与元数据、生成限制、源码索引、未覆盖与假设。

### 内容规则

- 正文语言由 `language` 决定；代码标识符、路径、命令保留原文。
- 每条关于代码结构、行为、接口或命令的陈述，在同一节内用行内代码标注来源，例如 `` `src/index.mjs:42` ``；源码索引列出本页引用的全部路径。
- 只写能从仓库文件验证的事实；无法验证的内容放入「未覆盖与假设」，并写明检查过的路径。
- `index`、`architecture`、`workflow` 和每个 `module` 页至少包含一个 ` ```mermaid ` 代码块；图与正文描述一致。
- 页面不出现 `TODO`、`TBD`、`待补充`、`占位符` 或空章节；无内容时写「本仓库未发现……」，并列出检查路径。
- 建议长度（不是校验判据）：`overview`/`architecture` 800–1600 个汉字，模块页 400–1000 个汉字。

### 源码索引格式

每行一个路径，按字典序：

```markdown
- `src/index.mjs`
- `src/index.mjs:42`
```

## index.md 契约

- 阅读顺序固定：`overview` → `architecture` → `workflows` → `interfaces` → `operations` → `modules`（按 slug 字典序）。
- 每个页面一行链接和一句话用途：`- [<title>](<path>) — <用途>`。
- 链接使用相对 `outputDir` 的路径，覆盖全部页面，不链接计划外页面。
- 页面依赖图使用 `mermaid` `flowchart`。
- 不把源码路径做成链接；源码路径只作为行内代码出现在正文和源码索引中。

## metadata.json 契约

```json
{
  "schema": "ralphflow-codewiki/metadata@1",
  "generator": "ralphflow-codewiki",
  "generated_at": "2026-01-01T00:00:00.000Z",
  "source": {
    "repository": ".",
    "commit": "worktree",
    "dirty": false
  },
  "language": "zh-CN",
  "format": {
    "page_schema": "ralphflow-codewiki/page@1",
    "frontmatter_keys": ["codewiki_schema", "title", "kind", "source_commit", "generated_at", "source_paths"],
    "headings": ["定位与职责", "关键文件与入口", "结构与关系", "流程与数据流", "接口、配置与依赖", "约束、失败模式与坑", "源码索引", "未覆盖与假设"],
    "required_diagrams": ["architecture", "workflow", "module"]
  },
  "files": [
    {
      "path": "overview.md",
      "kind": "overview",
      "sha256": "64 位小写十六进制",
      "bytes": 1234,
      "sources": ["README.md"],
      "diagram_count": 0
    }
  ],
  "modules": [
    {
      "slug": "core",
      "path": "modules/core.md",
      "title": "核心模块",
      "parent": null,
      "sources": ["src/core"]
    }
  ],
  "coverage": {
    "source_roots": ["src"],
    "excluded": ["node_modules", ".git"],
    "uncovered": []
  },
  "validation": {
    "status": "passed",
    "checks": [
      {"id": "page-set", "status": "passed"}
    ]
  }
}
```

- `files` 覆盖 wiki 中除 `metadata.json` 外的全部文件，按路径字典序；`sha256` 和 `bytes` 与文件内容一致。
- `modules` 与 `plan.modules` 一致，按 slug 字典序。
- `validation` 在 assemble 节点最后写入；`status` 只在全部检查通过时为 `passed`。
- `format` 与 `plan.format` 逐字一致。

## plan.json 契约

```json
{
  "schema": "ralphflow-codewiki/plan@1",
  "status": "ready",
  "blocked_reason": null,
  "generated_at": "2026-01-01T00:00:00.000Z",
  "source": {
    "repository": ".",
    "outputDir": "codewiki",
    "commit": "worktree",
    "dirty": false,
    "languages": ["JavaScript"],
    "source_roots": ["src"]
  },
  "format": {
    "page_schema": "ralphflow-codewiki/page@1",
    "frontmatter_keys": ["codewiki_schema", "title", "kind", "source_commit", "generated_at", "source_paths"],
    "headings": ["定位与职责", "关键文件与入口", "结构与关系", "流程与数据流", "接口、配置与依赖", "约束、失败模式与坑", "源码索引", "未覆盖与假设"],
    "required_diagrams": ["index", "architecture", "workflow", "module"],
    "language": "zh-CN"
  },
  "pages": [
    {
      "path": "overview.md",
      "kind": "overview",
      "owner": "core-pages",
      "title": "项目概览",
      "source_paths": ["README.md"],
      "diagram_required": false
    }
  ],
  "modules": [
    {
      "slug": "core",
      "path": "modules/core.md",
      "title": "核心模块",
      "parent": null,
      "source_paths": ["src/core"],
      "summary": "一句话说明模块职责"
    }
  ],
  "commands": [
    {"id": "build", "command": "npm run build", "source": "package.json"},
    {"id": "test", "command": "npm test", "source": "package.json"},
    {"id": "lint", "command": null, "source": null, "reason": "未发现 lint 配置"}
  ],
  "coverage": {
    "source_roots": ["src"],
    "excluded": ["node_modules", ".git"],
    "uncovered": []
  },
  "assumptions": []
}
```

- `status` 只取 `ready` 或 `blocked`；`blocked` 时 `blocked_reason` 写明冲突文件和原因，`pages`/`modules` 可以为空。
- `pages` 包含 markdown 页面，不包含 `metadata.json`；每页的 `owner` 按固定映射填写：`index` → `assemble`，`overview`/`architecture`/`workflows` → `core-pages`，`interfaces`/`operations` → `operations-pages`，`modules/*` → `module-pages`。
- 页面路径相对 `outputDir`；`source_paths` 和 `modules[].source_paths` 相对 `repository`。
- `modules` 与 `pages` 中的 `kind: "module"` 页面一一对应；模块页按 slug 字典序。
- `commands` 固定包含 `build`、`test`、`lint` 三项；未知项用 `command: null`、`source: null`、`reason` 说明。

## manifest.json 契约

```json
{
  "schema": "ralphflow-codewiki/manifest@1",
  "node": "core-pages",
  "generated_at": "2026-01-01T00:00:00.000Z",
  "files": [
    {
      "path": "overview.md",
      "kind": "overview",
      "sha256": "64 位小写十六进制",
      "bytes": 1234,
      "diagram_count": 0,
      "sources": ["README.md"]
    }
  ]
}
```

- `node` 是产出该 manifest 的节点 id。
- `files` 恰好是该节点在 plan 中负责的页面，按路径字典序；哈希和字节数与实际文件一致。
- `sources` 等于页面的 `source_paths`；`diagram_count` 是该页 Mermaid 代码块数量。

## validation.json 与 delivery.json 契约

```json
{
  "schema": "ralphflow-codewiki/validation@1",
  "command": "node .ralphflow-codewiki/verify.mjs codewiki --write",
  "exit_code": 0,
  "status": "passed",
  "checks": [
    {"id": "page-set", "status": "passed", "evidence": "..."}
  ]
}
```

```json
{
  "schema": "ralphflow-codewiki/delivery@1",
  "status": "passed",
  "outputDir": "codewiki",
  "entry": "codewiki/index.md",
  "metadata": "codewiki/metadata.json",
  "validation": ".ralphflow-codewiki/validation.json",
  "page_count": 10,
  "module_count": 3,
  "files": [
    {"path": "codewiki/index.md", "sha256": "64 位小写十六进制"}
  ]
}
```

- `validation.checks` 固定包含下表 10 项，一项一条；`status` 只在全部 `passed` 时为 `passed`。
- `delivery.files` 覆盖 wiki 中除内部文件外的全部文件（含 `metadata.json`），路径相对工作区根目录，按字典序。
- `delivery.status` 等于 `validation.status`。

## 模块树规则

- 源根优先识别：`src`、`lib`、`app`、`apps`、`packages`、`crates`、`cmd`、`internal`、`pkg`、`modules`；没有这些目录时使用包含源文件最多的顶层目录。
- 排除：`.git`、`node_modules`、`dist`、`build`、`out`、`target`、`vendor`、`coverage`、`.venv`、`venv`、`__pycache__`、`.next`、`.cache`、`generated`、压缩或生成文件，以及 `outputDir` 和 `.ralphflow-codewiki`。
- 模块从源根下的顶层目录开始；源根本身直接包含源文件时，源根作为一个模块。模块数目标 3–8、上限 12。少于 3 个可分离区域时按实际数量，并在 `assumptions` 说明原因。
- 超过 12 个时按源文件数降序保留 11 个，其余源文件归入 `modules/other.md`，总模块页数为 12；`other` 页的 `summary` 说明聚合规则。
- slug：相对路径小写，非 `[a-z0-9]` 转 `-`，合并连续 `-`，去掉首尾 `-`；冲突追加 `-2`、`-3`。源根作为模块时，slug 取源根目录名；repository 本身作为源根时，取 repository 目录名。
- 每个未被排除的源文件至少属于一个模块，或列入 `coverage.uncovered` 并说明原因。

## 校验清单

`assemble` 节点实现的 `verify.mjs` 逐项检查：

| id | 检查 |
| --- | --- |
| `page-set` | 实际 `.md` 文件集合等于 `plan.pages`；不多不少。 |
| `frontmatter` | 每页 frontmatter 键和顺序等于契约，YAML 可解析。 |
| `headings` | 每页 H2 恰好是 `plan.format.headings` 的 8 项，编号和顺序一致，无额外 H2。 |
| `kind` | 每页 `kind` 在允许集合内，且与页面角色一致。 |
| `sources` | 每页 `source_paths` 非空且存在；源码索引中的路径存在。 |
| `diagrams` | `index`、`architecture`、`workflow`、每个 `module` 页至少一个 Mermaid 块；所有 Mermaid 围栏闭合。 |
| `links` | `index.md` 链接全部页面且不链接计划外页面；所有页面中的相对 `.md` 链接可解析。 |
| `metadata` | `metadata.json` 的 `files`、`modules`、哈希、字节数与实际文件一致。 |
| `placeholders` | 全部页面不含 `TODO`、`TBD`、`待补充`、`占位符`。 |
| `language` | 正文语言与 `language` 一致；固定标题等于对应语言的标题表。`language` 检查以固定标题表为主，正文语言由 CHECK 抽样复核。 |

`verify.mjs` 支持两种运行方式：

- `node .ralphflow-codewiki/verify.mjs <outputDir> --check`：只读，打印 JSON 并以 0/1 退出。
- `node .ralphflow-codewiki/verify.mjs <outputDir> --write`：执行同样检查，并写 `.ralphflow-codewiki/validation.json`。

## 变更规则

- 固定格式的变化以 schema 版本标识；`codewiki_schema`、`page@1`、`plan@1`、`metadata@1`、`manifest@1`、`validation@1`、`delivery@1` 同步递增。
- 修改本文件后，重新校验工作流资产，并至少运行一次隔离样例验证新契约。
