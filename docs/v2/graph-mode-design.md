# RalphFlow Graph 模式设计

> **状态**：已实现（v1.8，2026-10-21；2026-10-22 创建入口改为 `ralphflow-create` skill）。本文件保留为设计决策记录；验收与例外见 `scripts/graph-*-test.mjs` 与 `evidence/graph-mode/change-note.md`。
>
> **Git 集成现状（2026-10-25 重做）**：集成线是仓库里的真分支 `ralphflow/<实例>`，节点在自己的 worktree 与分支 `ralphflow-node/<实例>/<节点>` 上提交，交卷前把集成 tip 合进来，引擎只做快进。现行契约见 [design.md](design.md) 原则 15；下文涉及早期 Git 集成设计的段落是历史设计记录，以本节与设计原则为准。
>
> **创建入口现状**：`ralphflow-create` skill 负责 Flow 直接设计；Graph 启动 `create-graph` Flow（grill → spec → tickets → graph，spec/tickets 带 CHECK + 人工门）。`design-graph` 已删除；下文涉及 `design-graph` 的段落是历史设计记录。
> **读者**：在 `ralph-flow-dsh` 上实现本设计的 agent / 维护者。
> **权威**：[design.md](design.md) 的中心定理与宪法优先；本文只定义 Graph 模式的增量决策。
> **参考实现**：同级 checkout `../ralph-graph-dsh`（RalphGraph，未上线，可读、可搬、可改；不要把它作为第二个产品发布）。

## 读前

- 先读 [design.md](design.md) 的 §0（T1/T2）、§4（状态）、§8（命令/工具面）、§9（资产与目录）、§10（宪法）。本文不重复宪法的论证。
- Flow 侧的实现入口：`src/engine.ts`（引擎/状态/生命周期）、`src/index.ts`（投递与工作区锚定）、`src/verify.ts`（独立验证者）、`src/tools.ts` / `src/skills.ts`（入口；创建入口是 `ralphflow-create` skill）、`src/status-contract.ts` / `src/status-service.ts` / `src/client/*`（状态面）。
- Graph 侧的参考：`../ralph-graph-dsh/src/` 下的资产契约、调度、验证、workspace（Git 隔离）、报告与查看器；按 §7 的对照表取用，不要整包依赖。该实现的 integration ref / merger 段是旧设计，现行机制见上方“Git 集成现状”。
- 本文只定义 Graph 模式的增量决策；现有 Flow 的字段、事件、命令语义以代码和 `README.md` / `docs/commands.md` 为准。
- **写 DO/CHECK、工具描述或生成资产前读 §11**；完整规范随包在 `references/matt/writing-for-agents.md`，§11 只保留触发条件与检查清单。

## 0. 一句话

**RalphFlow 是一个产品；Graph 是它的一种工作流类别，不是第二个插件。**

一个包、一个 plugin row、一套 `/ralphflow-*` 命令、一套 `ralphflow_*` 工具、一个只读查看器、一个运行根目录、两个工作流资产目录。内部保留两个执行引擎：Flow 的顺序状态机与 Graph 的 DAG 调度器；一个门面按资产的 `kind` 路由。

Graph 尚未上线，因此**不保留** RalphGraph 的 `/ralphgraph-*`、`rg_*`、`.dsh/ralphgraph/`、独立侧栏 tab、独立 bundle 或任何别名。Flow 用户已有的 `/ralphflow-*`、`steps` YAML、`.dsh/ralph-flow/` 目录和报告保持不变。

### 0.1 术语

| 词 | 本文含义 |
|---|---|
| 工作流资产 | `workflows/` 或 `graphs/` 下的 YAML 文件；不是运行实例 |
| 实例 / 运行 | 资产的一次执行；Graph 的 `run` 就是实例，用户可见词统一用“实例” |
| 设计运行 | `design-graph` 的一次实例；它是真实 Graph 运行，不是伪运行 |
| 生成资产 | 设计运行产出的普通 Graph 资产；保存后不会自动执行 |
| 步骤 / 节点 | Flow 用“步骤”，Graph 用“节点”；不混用 |
| 创建 / 执行 | 创建产出资产；执行启动实例；`design-graph` 是“用于创建的工作流” |

## 1. 为什么不是“把 DAG 塞进 Flow 的状态机”

两种执行模型不是超集关系：

| | Flow | Graph |
|---|---|---|
| 推进 | 单当前步，`on_pass` / `on_fail` 可循环、回退 | 无环 DAG，就绪节点并行 |
| 并行 | 验证者并行；步骤串行 | 节点并行 |
| 失败 | `on_fail` 可跳回任意前序步骤 | 节点局部返工，不任意回跳 |
| 上下文 | 属主会话 DO；reset / rewind | 每节点独立 agent / worktree |
| 强项 | 对抗验证、循环返工、上下文管理 | 分解、并行、集成 |

把并行 frontier、逐节点 workspace、合入阶段塞进“只有一个 `current_step`”的状态机，会重写 Flow 的调度、状态、会话与验证语义；反过来把 Flow 的循环/回退塞进 DAG，也会破坏 Graph 的无环调度。**合成的正确层级是产品外壳，不是引擎语义。**

本文的“一个插件”指：一个安装单元、一个用户入口、一套状态/报告/查看器。内部两个引擎各自保持语义，由门面路由。

## 2. 资产契约

### 2.1 `kind`

顶层新增判别字段：

```yaml
kind: flow
description: ...
steps: ...
```

```yaml
kind: graph
description: 生成固定格式的 CodeWiki

steps:
  - id: survey
    desc: 盘点仓库
    do: ...
    output: plan.json
    check: |
      1. ...
```

规则：

| 输入 | 结果 |
|---|---|
| `kind: flow` + `steps` | Flow |
| 无 `kind` + `steps` | Flow（兼容现有 Flow 资产与跨端方言） |
| `kind: graph` + `nodes` | Graph |
| 无 `kind` + `nodes` | **加载期硬错误**：Graph 资产必须显式声明 `kind: graph` |
| `kind: flow` + `nodes` | 加载期硬错误 |
| 同时有 `steps` 和 `nodes` | 加载期硬错误 |
| `kind: graph` + `steps` | **有效**：Graph 的新 Flow 风格格式 |
| 无 `kind` + `steps` | Flow；若放在 `graphs/` 则按 Flow 资产拒绝 |

`kind` 是路由标记，不是把两套 schema 合并。Flow 的 `on_pass` / `on_fail` / `check_voting` 与 Graph 的 `depends_on` / `output` / Git worktree 各自校验、各自执行。

目录也参与分类：**Flow 资产只放 `workflows/`，Graph 资产只放 `graphs/`**。文件放错目录、或 `kind` 与目录不一致，都是加载期硬错误；不要靠目录静默执行或靠 `kind` 静默搬家。

**跨端**：Flow YAML 的 `kind` 是可选的；opencode / claude 版不认识时按未知顶层键忽略即可。Graph 是 dsh 专属类别，不进入跨端方言承诺。不要为了 Graph 改动 Flow 的现有字段语义。

### 2.2 Graph 资产

Graph 资产的**用户格式与 Flow 对齐**（2026-10-21 作者决定）：同样用 `steps`、`id`、`desc`、`do`、`output`、`check`；Graph 只额外用 `depends_on` 表达 DAG。

- 顶层：`kind: graph`、`description`、`manual_step`、`steps`
- 步骤：`id`、`desc`、`do`、`output`、`depends_on`、`execution`、`check`
- Graph 始终 Git 隔离；没有 workspace 开关、运行输入、共享资料、并发字段或每步模型
- `output` 是产物路径（省略默认 `<id>.md`）；`depends_on` 的上游 `output` 自动注入下游只读材料，不再需要 `inputs` 映射
- CHECK：`check` 是显式判据字符串，或 `check: null`；**没有固定默认 CHECK**，也没有 `{mode: ...}` 对象

文件名就是启动名/资产名，不需要再写 `id`/`name`。旧版 `nodes` / `dependsOn` / `artifact` / `inputs` 已移除。

Flow 字段保持原样；Graph 字段不进入 Flow 的步骤校验。

Graph 的顶层 `manual_step` 与 Flow 同名，都是“完成后停门”的节点/步骤 id 列表；放行入口按 kind 不同（见 §4.3）。

### 2.3 加载、校验与发现

- 统一 loader 先按目录分派（`workflows/` → Flow 校验器，`graphs/` → Graph 校验器），再校验 `kind` 与目录一致；**不要**先用 Flow 的 `steps` 校验去拒绝 Graph 资产，也不要只读 `kind` 就跨目录解析。
- Flow loader 把 `kind` 加入已知顶层键；旧 Flow 资产没有 `kind` 不产生告警。
- `ralphflow_doctor` 是唯一的校验入口（可接受 `workflow` 名或工作区路径）；不再保留 `rg_validate`。Graph 资产校验失败时，错误路径仍按 Graph schema 报，不伪装成 Flow 步骤错误。
- `ralphflow_list` 与动态快捷技能同时列出两类；每项带 `kind` 与节点/步骤数。
- 内置工作流：
  - Flow：`workflows/loop.yaml`、`workflows/spec.yaml`（保持现状）
  - Graph（公开）：`graphs/codewiki.yaml` + `references/codewiki-format.md`
  - Graph（公开）：`graphs/design-graph.yaml`，创建 Graph 工作流的内置设计工作流；可直接 `start`，也可由 `/ralphflow-create` 路由
  - 旧 `orchestrator` id/命令删除，不保留别名；`design-graph` 是同一实现的新名字，不是第二套实现
- 资产目录：
  - Flow：`<项目根>/.dsh/ralph-flow/workflows/`、`$DSH_HOME/ralph-flow/workflows/`
  - Graph：`<项目根>/.dsh/ralph-flow/graphs/`、`$DSH_HOME/ralph-flow/graphs/`
  - 项目根 = 从会话目录向上最近的含 `.git` 的祖先目录（没有就用会话目录本身），与 dsh 原生 Skill 一致；同一类别内项目根文件遮蔽用户级/内置；Graph 不会遮蔽 Flow 的同名文件。
- **同名跨类别是冲突**：`ralphflow_start <name>` 与动态技能只认一个名字；`workflows/` 和 `graphs/` 出现同名文件时，`doctor`/`list` 必须报错，`create` 也必须在保存前检查两边。不要用“先找到哪个算哪个”的隐式解析。
- **不静默覆盖**：`create`/`design-graph` 保存前检查目标文件；同名同类文件已存在时先确认，跨类别同名直接拒绝。
- 内置不落盘，工作区同名文件遮蔽内置；与现有 Flow 规则一致。

## 3. 运行状态与生命周期

### 3.1 一个运行根，两个资产目录

```text
<workspace>/.dsh/ralph-flow/
├── workflows/<flow-name>.yaml
├── graphs/<graph-name>.yaml
├── instances/<instance-id>/state.json
├── instances/<instance-id>/execution.log
├── instances/<instance-id>/worktrees/          # 仅 Graph
├── artifacts/<artifacts_dir_name>/             # Flow 产出 + Graph 最终产出
├── artifacts/<artifacts_dir_name>/nodes/       # Graph 节点产物
└── reports/<instance-id>.md
```

**一个运行根，两个资产目录**：Flow 继续用 `workflows/`，Graph 用新的 `graphs/`；运行状态/产物/报告仍统一在 `.dsh/ralph-flow/`。Flow 的布局、`artifacts_dir_name`、报告、执行日志、销毁序列保持不变；Flow 的产出仍是扁平的 `artifacts/<dir>/`。Graph 的节点产物放 `artifacts/<dir>/nodes/`，不改变 Flow 的产出路径。Graph 不再写 `.dsh/ralphgraph/`。

### 3.2 状态是唯一写入者的事实

沿用 `design.md §4/§10.3/§10.4`：引擎是唯一写入者；状态只存**主事实**，不存派生相位。

Graph 的联合状态建议：

```jsonc
{
  "kind": "graph",
  "active": true,
  "workflow_name": "codewiki",
  "user_task": "...",
  "owner_session": "...",
  "artifacts_dir_name": "...",
  "graph": {
    "asset": { /* 启动时冻结的完整资产 */ },
    "attempts": [],
    "submissions": [],
    "verdicts": [],
    "acceptances": [],
    "humanTodos": [],
    "integration": { /* ref、currentCommit、baseline */ },
    "worktrees": []
  },
  "history": []
}
```

- **不要照搬** RalphGraph 当前 `state.nodes[].status` / `waitReason` / `currentStage` 这类投影字段；节点是否运行、等待、完成、失败，由 attempts / submissions / verdicts / acceptances 派生。搬运时先做这一步，再谈兼容。
- 现有 Flow `state.json` 没有 `kind`：读取时按 `flow` 处理，不迁移、不重写。新写入的 Flow 状态可以补 `kind: "flow"`，但不是必需。
- Graph 新增的字段都是主事实（attempt、submission、verdict、acceptance、todo、integration、worktree）；不因 Graph 改动 Flow 的既有字段。`design.md §10.4` 禁止的是派生量，不是新的主事实。
- 一套判定账本：Flow 的 `verdicts` 扩展 `scope`（Flow step 或 Graph node/attempt/checkIndex）；不要同时保留 Graph 的 `checkResults` 与 Flow 的 `verdicts` 两份。
- 一套委派账本：复用 Flow 的 `delegations`，Graph CHECK 加 node/attempt 定位；不要另建验证会话表。
- 人审：Flow 的门是 `manual_step` 的静态派生；Graph 的节点问题/审查是主事实。两者在状态投影层合并，不新增第三份待办文件。
- 运行 id：统一用 Flow 的实例 id 方案（工作流名 + 随机尾段），Graph 的 `runId` 就是 `instance`。用户可见词统一为“实例”。

### 3.3 生命周期差异

- **Flow**：完成后归档报告、销毁实例目录（现有七步序列与 fail-safe 不变）。
- **Graph**：完成后归档报告，并**保留** `state.json`、执行日志和节点产物；没有自动销毁。原因：交付验收、人工审查、失败复核和后续 `status` 需要原始记录；Graph 不是“跑完即焚”的顺序流。
- `instances/` 的含义因此扩展为：活跃 Flow 实例、保留的 Graph 实例；Flow 完成实例仍不保留。`design.md` 的相应句子在实现时同步修订，不要悄悄改语义。
- **取消**：Flow 保持“归档报告 → 销毁实例”；Graph 归档报告后保留已接纳产物、worktree 和状态记录，标记为 cancelled，供复核。不要把 Graph 的取消改成 Flow 的销毁序列。
- **宿主重开**：复用 Flow 的实例扫描与恢复入口。Graph 只恢复主事实并标为 interrupted/paused，**不自动推进**；用户 `ralphflow_continue` 后才继续。Flow 的 `check_infra` 等既有恢复语义不变。
- **doctor/list**：按 `kind` 读取。保留的 Graph 完成实例是历史记录，不是“残留在跑”；只有缺 state、坏文件、真正中断的实例才按异常报。Flow 的既有诊断口径不变。
- `ralphflow_cleanup` 是**人**的机械命令（不注册工具）：只删除 Graph 已记录且干净的节点 worktree，不删除 state、artifacts、reports；Flow 没有 worktree，调用时明确说明不适用。
- Graph 的集成线是普通分支 `ralphflow/<instance>`（节点分支 `ralphflow-node/<instance>/<node>`）；Graph 尚未上线，直接改，不保留旧影子引用与 `RalphFlow-*` trailer。

### 3.4 报告与历史

- 一个报告路径 `reports/<instance>.md`，一个 JSONL 执行日志格式；Flow 的 `reports/<instance>-execution.log` 归档路径保持不变，Graph 同样归档。Flow 的 header/失败/历史节保留，Graph 追加节点、CHECK、人工门、集成、交付分类节。不要维护第二套报告模板。
- `ralphflow_list` 的历史 = Flow 的归档报告 ∪ Graph 保留的实例记录；不新增索引文件。Graph 完成后即使实例保留，也以报告为人类可读入口，状态记录为机器事实。
- `ralphflow_status` 对 Graph 给出节点计数、当前节点、等待原因、下一步；对 Flow 保持现有单步/投票视图。
- Graph CHECK 的验证者提示词与判定原文同样进执行日志（复用 Flow 的日志字段），报告只指路；不要把日志内容复制进报告。

## 4. 门面、工具与命令

### 4.1 门面职责

一个 `createEngine(workspace)` 对外提供统一方法，内部按 `kind` 分派：

- `start(workflow, task?)`：加载/校验资产；Flow 返回当前 DO；Graph 创建实例并启动调度，返回启动回执。`start` 可启动所有公开工作流，包括 `design-graph`；`create` 的 graph 分支走同一公开 `start`，不设内部入口。
- `continue(instance?)`、`cancel(instance?, reason?)`、`status(instance?)`、`list()`、`doctor(workflow?)`
- `submit(agent, summary?)`：Flow 主会话交卷；Graph 节点作用域交卷。
- `respond(agent, text, todoId?)`：Graph 人工问题/审查；Flow 没有此路径。

门面不得成为第三个引擎：它只做资产路由、生命周期编排、状态投影和工具注册。调度、验证、合并仍由对应引擎负责。**每个实例只有一个写入者**：Flow 实例由 Flow 引擎写，Graph 实例由 Graph 模块写；门面只路由，不重复写第二遍。

`start` 的输入按 kind 解释：

| kind | `task` | Git 前置 | 说明 |
|---|---|---|---|
| flow | 必填 | 不使用 | 不使用 |
| graph | 可选，作为任务上下文 | 工作区必须是 Git 仓库、有 HEAD、干净 | 缺失时 AI 先问用户，再由 AI 初始化 |

宿主重开后，Graph 实例走同一套恢复入口：恢复主事实、标为暂停/中断，等用户 `continue`；调度器不在挂载时自动推进。

### 4.2 命令面

只保留 `/ralphflow-*`，**不注册任何 `/ralphgraph-*`**：

```text
/ralphflow-start <workflow> [task]
/ralphflow-list
/ralphflow-status [instance]
/ralphflow-continue [instance]
/ralphflow-cancel [instance] [reason]
/ralphflow-create [idea]
/ralphflow-doctor [workflow|path]
/ralphflow-reset                  # Flow only
/ralphflow-rewind <step> <reason> # Flow only
/ralphflow-cleanup [instance]     # Graph only
```

- `start` 仍是**技能**（不是命令），保留 Flow 现有“新会话首句可命名”的行为；Graph 工作流的动态快捷技能也走同一路径。`design-graph` 是公开内置工作流，注册动态技能 `/ralphflow-design-graph`，可直接启动；`create` 只是路由到它。
- `reset` / `rewind` 对 Graph 明确拒绝并说明原因；`cleanup` 对 Flow 明确说明没有 worktree。
- 暂停没有命令：点发送键旁的方块停止当前回合，引擎把 Graph/Flow 实例转 `paused(user_stop)`；`continue` 恢复。Graph 在跑后台节点、主回合没有可停的回合时，输入区会出现独立的「暂停」按钮；在飞节点会被中断（attempt 标 `interrupted`），不再启动新节点。

### 4.3 工具面

Flow 的固定 8 个主工具保持不变：`ralphflow_start`、`ralphflow_submit`、`ralphflow_continue`、`ralphflow_status`、`ralphflow_list`、`ralphflow_cancel`、`ralphflow_create`、`ralphflow_doctor`。

`ralphflow_create` 增加一个可选 `kind` 参数：没有就返回“先问 kind”的短指引；`flow` 返回原指南；`graph` 用同一公开 `start` 启动 `design-graph` 并返回它的 DO。仍是一个工具，不新增 `create-graph` 或第二个创建工具。

Graph 的增量工具**只注册在作用域内**，不扩张主模型工具面：

- `ralphflow_respond`：仅当当前会话有 Graph 人工待办时可见；回答节点问题、提交人工审查决定。Flow 审查门仍走 `ralphflow_continue`。
- `ralphflow_artifact_write`：仅 Graph 节点 agent 可见；写入声明的节点产物。
- `ralphflow_submit` 不新增名字：它已在 8 个主工具里，按调用者绑定分派（Flow 主会话 / Graph 节点 attempt）。

**不要**注册 `rg_delivery`、`rg_query`、`rg_pause`、`rg_integrate` 等第二个命名空间；Graph 的交付分类并入 `status`/报告，原始诊断读执行日志与状态投影。

状态契约要显式加 `kind`，并为 Graph 增加独立投影（节点、当前节点、等待原因、下一步、交付分类），不要把 Graph 字段硬塞进 Flow 的 `step`/`votes`。Flow 的 `stage`/`step`/`votes` 字段保持原义；Graph 状态下这些 Flow 专有字段可以为空，**不要伪造一个 step**。状态契约的严格解析器要按 kind 分派，查看器与状态胶囊消费同一份投影。

### 4.4 验证与推进

- **T1**：Graph 节点 CHECK 必须走 Flow 现有的独立验证者运行时（`src/verify.ts` 的 persona、能力选择、结构化判定、无执行者自述）；Graph 只提供自己的 CHECK 判据与提示词构造。不得为 Graph 另写一套子代理/判定协议。
- **T2**：Graph 的节点 release、返工、快进顺序由机械调度器根据主事实决定；节点在自己的分支上合入集成分支（冲突由它自己解决），引擎只校验「worktree HEAD 在节点分支上 + 节点分支包含集成分支头 + 工作树干净」并前进引用，模型不能声称通过。
- **设计 CHECK ≠ 执行 CHECK**：`design-graph` 的 CHECK 验收的是“生成资产是否覆盖目标、结构是否正确、doctor 是否通过”；生成工作流自己的 CHECK 验收的是执行结果。两者不能互相冒充，`create` 也不能把设计 CHECK 通过说成生成工作流已可运行。
- **生成工作流不自动启动**：`create` 可以启动设计运行；设计通过后只给文件位置和启动方式，必须由用户明确 `/ralphflow-start <name>`。
- Flow 的 `check` / `check_voting` / `check_model` / 人工门语义逐字不变。Graph v1 不支持 `check_voting`；不要为 Graph 复制投票机制，后续有需求再按同一验证账本扩展。
- Flow 的“无 `check` = 跳过对抗验证”与 Graph 的 `check: null = 无独立 CHECK` 各自保留原措辞；两者都不能被写成“检查通过”。状态/报告要如实区分“跳过”和“关闭”。
- Graph 的 background 节点与 Flow 的主会话 DO 共存；工具作用域按执行模式注册，不混用。
- 容量：Flow 的“一实例一步”与 Graph 的就绪步骤全部放行，**不做工程内并发上限**；不要用一个全局队列把 Flow 的步骤和 Graph 的节点混排。节点 agent 走 `ctx.agents.create`，**不受**宿主 `maxActiveSubagents` 约束；那条池只约束走 `ctx.subagents` 的**验证者委派**（默认 8 槽、池满是 fail-fast）——引擎在委派点等槽后重试，不把“池满”判成 infra。接纳/合入由 `acceptTail` 串行。

## 5. 查看器

只增加一个只读侧栏 tab；不要保留 RalphGraph 的第二个 tab：

- 顶部选择工作流（Flow / Graph 徽标），按 Flow/Graph 分组列出 `.dsh/ralph-flow/workflows/`、`.dsh/ralph-flow/graphs/` 与全部公开内置；`design-graph` 在 Graph 组，描述标明“设计 Graph 工作流”。
- Flow：步骤链；`on_pass` 实线，`on_fail` 虚线/回边；当前步、审查门、投票。
- Graph：DAG 列布局；`depends_on` 边；节点状态、CHECK、合入阶段。
- 点击节点进入整页只读详情：DO、CHECK 判据、依赖/输入、产物/合入；Flow 同时展示 step 字段。
- **阶段必须可分辨**：Flow 当前步与 Graph 节点各出两枚芯片（`DO` / `CHECK`）——DO 阶段是 `DO · 执行中` + `CHECK · 待验证`，CHECK 阶段是 `DO · 已交卷` + `CHECK · 验证中`（Flow 带票数进度，表头同源）。在飞用业务色 `--dsw-alias-state-business-primary`；品牌色是黑白中性色，只能留给焦点环与选中态，否则夜间模式下工作图会退化成纯黑白。映射集中在 `src/client/phase.ts`（纯函数），界面只负责画。
- **打开就落在运行中的工作流上**：选择优先级 = 本次手动选择 → 正在跑的工作流 → 上次浏览偏好（`localStorage`）→ 目录第一个；运行中的工作流换了身份时手动选择作废、重新跟随运行。下拉里只有运行中的那一个带「运行中」标记，浏览别的资产时表头写「运行中：<name>」。规则在 `src/client/selection.ts`（纯函数）。
- 只读：没有启动、暂停、取消、审批、产物写入或运行选择控制；这些仍在聊天/工具里。
- 数据来源是一个新的只读 `ralphflowViewer` Typert remote（或扩展现有 status service），不要复用 Graph 的 `/ralphgraph` HTTP bridge，也不要新开第二套轮询。查看器订阅 `statusChanged`，与状态面同源。
- 客户端使用现有 DSH 主题 token；支持明暗主题。Graph 的 `graph-layout.mjs` 与查看器组件可搬，但必须按 Flow 的 `src/client/` TSX/esbuild 构建方式落地；新增 `sidebar.right.pane.tab` 注入与对应客户端依赖。
- 保留 Flow 现有的状态胶囊与输入区提示；查看器是新增的只读浏览面，不替代状态胶囊，也不复制它的下一动作逻辑。
- **宪法 §10.9**：客户端不得先于内核。查看器在状态/报告/工具面稳定后落地（见 §8 阶段 5）。

## 6. 创建：一个入口，一个可复用的设计工作流

### 6.1 一个 skill 管不了两类，但不需要 internal 特例

Flow 创建是轻的：现有 `CREATE_GUIDE` 用对话 + 参考就能覆盖“步骤图 → YAML → doctor”。Graph 创建是重的：目标澄清、步骤拆分、依赖、逐步骤产物、CHECK/人工门、Git 隔离、资产校验，还要独立 CHECK。把这些塞进同一个 skill，只有两种结果：提示词膨胀到每次都占上下文，或者模型在长流程里跳步。

**决定：`create` 是分流器，不是把两类塞进一个 skill；Graph 创建由内置工作流 `design-graph` 承载。**

- **Flow 分支**：继续用现有对话式指南；不启动任何运行。
- **Graph 分支**：路由到公开内置工作流 `design-graph`，由它承载完整创建流程和独立 CHECK；不把 Graph 的细节写进 create 指南。
- `design-graph` **是普通公开内置工作流**：用户可以 `/ralphflow-start design-graph <想法>` 直接使用，也可以让 `/ralphflow-create` 路由过去。没有 internal 标记、没有 start 拒绝、没有隐藏列表。

这不是“两套实现/两个产品入口”，而是**同一套实现的两个调用路径**：`create` 是知道 kind 的推荐入口，`design-graph` 是可直接复用的工作流。旧 orchestrator 的问题是与 create 各有一套创建实现和交付物；现在只有一套。

### 6.2 入口职责

| 入口 | 职责 | 不做什么 |
|---|---|---|
| `/ralphflow-create` | 先问 kind；Flow → 返回原指南；Graph → 用同一公开 `start` 路由到 `design-graph` 并返回它的 DO | 不直接执行生成的工作流，不复制 Graph 设计细节 |
| `design-graph` | 公开内置 Graph 工作流：澄清 → 设计 → 写 YAML → 独立 CHECK → 报告 | 不自动启动生成的工作流 |
| `ralphflow_doctor` | 静态校验 + 诊断 | 不设计、不改文件、不启动、不替用户修 |
| `/ralphflow-start` | 执行公开的已保存/内置工作流，包括 `design-graph` | 不创建、不修复 |

- `design-graph` 与 `codewiki` 一样是公开内置：出现在工作流列表、动态技能（`/ralphflow-design-graph`）和直接 `start` 中。它的描述写明“设计 Graph 工作流”，避免和普通业务工作流混淆。
- 生成的工作流**永远不自动启动**；设计运行完成、CHECK 通过、doctor 通过后，由用户明确 `/ralphflow-start <name>`。
- `create` 的 graph 分支启动的是**设计运行**，不是生成的工作流；这两个“启动”必须在提示词和回执里说清楚。

### 6.3 旧 orchestrator 的处置

旧 `orchestrator` 本身就是这条重流程的载体：主会话 design 节点 + 独立 CHECK，产出设计证据与 YAML。它的问题不是“用了工作流”或“公开”，而是它与 `create` 各有一套创建实现和交付物，形成两条实际分叉的路。

处置：

- **改名 `design-graph`，作为公开内置工作流**；保留它的 design 节点、CHECK、设计方法/资产编写参考，复用而不是重写。它的 DO/CHECK 与生成资产按 §11 写。
- 路径/输入适配到统一运行根：生成资产写 `.dsh/ralph-flow/graphs/<name>.yaml`；设计运行自己的证据（设计说明、校验结果）留在该实例的产出目录。
- **不在工作区根写 plan/design-delivery 文件**；工作区里只出现最终 YAML。设计证据是内部运行记录，不是第二个交付物。
- 只设计 Graph 资产；Flow 创建仍走现有指南，不启动 `design-graph`。
- 旧 `orchestrator` id、命令、动态技能全部删除，不保留别名；用户可以用 `/ralphflow-start design-graph` 或 `/ralphflow-create` 进入同一实现。

### 6.4 `create` 的行为

1. 先确定 kind；用户已经明确说“graph/并行/分支”时不要重复问。
2. **Flow**：返回现有 `CREATE_GUIDE`；步骤、字段、投票、reset、子工作流规则不变。
3. **Graph**：用同一公开 `start` 把用户的想法交给 `design-graph`，把它的 DO 返回给主会话；后续由该工作流问 graph 字段、写 YAML、跑 CHECK 和 `doctor`。`create` 不重复这些指令。
4. 生成资产只写 `.dsh/ralph-flow/graphs/<name>.yaml`，`kind: graph`；目标文件已存在时先确认，不静默覆盖。写完按 §11 自检，由设计工作流的 CHECK 独立验证，再让用户审查。Flow 创建仍写 `workflows/`，两类不混放。
5. **不自动启动生成的工作流**；只给文件位置、节点图、运行输入和启动方式。

`ralphflow_create` 增加一个可选 `kind` 参数：没有就返回“先问 kind”的短指引；有 `flow`/`graph` 就进入对应容器。工具数量不变，不新增 `create-graph` 命令或工具。

Graph 专属问题、字段和反例放在 `references/graph-authoring.md`，由 `design-graph` 的 DO/CHECK 按需读取；公共规则（命名、保存位置、校验、运行输入、工作区）只在 `references/workflow-authoring.md` 保留一份。

`design-graph` 的输入契约与直接启动一致：启动任务的文本就是用户的想法；`create` 路由时传同一份文本，不构造第二套上下文。

### 6.5 边界

- `create` 是**推荐/引导入口**；`design-graph` 是**公开可复用的工作流**。两者调用同一实现，不维护两份设计指令、两份交付物。
- 不新增 `/ralphflow-create-graph` 命令，也不保留 `orchestrator` 别名；直接使用就 `/ralphflow-start design-graph`，想被引导就 `/ralphflow-create`。
- Flow 步骤不能调用 Graph 工作流，Graph 节点不能调用 Flow 工作流；`workflow:` 子工作流仍是 Flow-only。
- 不做一个“混合调度器”把两种 kind 嵌进同一实例；需要组合时拆成两条工作流分别运行。
- 生成的工作流与设计工作流都不自动串联；设计完成即止，执行由用户显式启动。

### 6.6 验收

- **Flow 回归**：不指定 graph 时，`create` 仍按原指南产出 Flow 资产；旧资产与命令不变。
- **两条调用路径等价**：`/ralphflow-start design-graph <想法>` 与 `/ralphflow-create` 的 graph 分支产生同一输入契约、同一设计流程、同一 CHECK、同一输出路径。
- **Graph 创建**：设计运行问清 graph 字段、写出 `kind: graph` 资产、CHECK 通过、`doctor` 零告警；生成的工作流没有被自动启动。
- **公开性**：`design-graph` 出现在工作流列表和动态技能中，可直接 `start`；不搞 internal 特例，也不拒绝直接启动。
- **唯一实现**：没有第二套 Graph 设计指令/交付物；旧 `orchestrator` id 和别名不存在。
- **证据边界**：设计运行证据在实例产出目录；工作区没有 plan/design-delivery 文件；最终 YAML 是唯一工作区交付物。
- **组合边界**：尝试在 Flow 步骤里调用 Graph 工作流、或在 Graph 节点里调用 Flow 工作流时，给出明确拒绝与拆分建议。
- **Agent 可读内容**：`writing-for-agents` 参考随包；`design-graph` 的 DO 写出读取条件；生成资产通过 §11.3 的 checklist；`create` 只加指针，没有第二份原则副本。

## 7. 复用对照表（不要重复造轮子）

参考实现：`../ralph-graph-dsh`。下列文件是**素材**，不是要整包 import 的依赖；按特性抽取，落到 `ralph-flow-dsh` 的模块边界。

| 能力 | 来源 | 动作 |
|---|---|---|
| 实例状态、生命周期、报告归档、执行日志、销毁序列 | `src/engine.ts` | 扩展联合 `kind`；Flow 分支保持逐字不变 |
| 独立验证者运行时、persona、能力选择、结构化判定 | `src/verify.ts`、`src/voting.ts` | 直接复用；Graph CHECK 只接判据与提示词 |
| 重置门、rewind | `src/reset.ts`、`src/engine.ts` | Flow 专用；Graph 不接 |
| 消息投递、播报、通知、工作区锚定 | `src/index.ts`、`src/message-source.ts` | 直接复用；Graph 节点事件走同一分类 |
| 工具/命令/技能、创建指南 | `src/tools.ts`、`src/skills.ts`、`src/create.ts` | 扩展现有面；不注册第二命名空间 |
| 状态契约、状态服务、状态 UI | `src/status-contract.ts`、`src/status-service.ts`、`src/client/*` | 扩展 `kind` 联合；保留现有 Flow 视图 |
| Graph 资产契约与校验 | `../ralph-graph-dsh/src/asset-contract.mjs`、`asset.mjs` | 搬规则；Graph 必填 `kind` |
| Graph CHECK 提示词/判定 schema | `../ralph-graph-dsh/src/check.mjs` | 搬判据与 schema；验证会话走 Flow 的 `verify.ts` |
| DAG 调度、并发、节点 attempt、人工待办、交付 | `../ralph-graph-dsh/src/index.mjs`、`human-todos.mjs`、`delivery.mjs` | **按特性抽取**；不要整文件 import |
| Git worktree、集成分支、快进合入 | `../ralph-graph-dsh/src/index.mjs` 的 workspace/integration 段 | 抽取为 Graph 模块；现行实现只做快进，旧 integration ref / merger 不在移植范围 |
| Graph 报告、状态投影、布局 | `../ralph-graph-dsh/src/report.mjs`、`status.mjs`、`layout.mjs`、`graph-layout.mjs` | 合并进 Flow 的报告/状态/查看器；去掉重复事实 |
| 只读查看器组件 | `../ralph-graph-dsh/src/client-entry.mjs`、`client.js` | 搬交互与布局；按 Flow TSX/esbuild 重写装配 |
| CodeWiki 示例与格式契约 | `../ralph-graph-dsh/src/builtin/codewiki.yaml`、`src/builtin/references/codewiki-format.md` | 搬为 Flow 内置 Graph 资产，落 `graphs/codewiki.yaml` |
| Graph 创建工作流 `design-graph` | `../ralph-graph-dsh/src/builtin/orchestrator.yaml` + 其 references | 改名/作为公开内置，落 `graphs/design-graph.yaml`；复用设计节点、CHECK、参考；路径与输入适配 |
| Graph 设计方法/资产编写规则 | `../ralph-graph-dsh/src/builtin/references/design-methods.md`、`asset-authoring.md` | 收敛进 `design-graph` 的 DO/CHECK/参考；不另写一份 |
| Agent 可读内容规范 | `../ralph-graph-dsh/src/builtin/references/writing-for-agents.md` + `LICENSE` | 打包进 Flow `references/`；`design-graph`/`create` 用指针；不复制进每个资产 |

**明确不要搬**：

- RalphGraph 的插件入口、`apply`、`rg_*` 工具、`/ralphgraph-*` 命令、独立 bundle、独立侧栏 tab、`/ralphgraph` HTTP bridge。
- RalphGraph 的 `.dsh/ralphgraph/` 路径与 `refs/ralphgraph/...` 引用。
- 旧 `orchestrator` id、`rg_orchestrator` 工具/命令、别名；`design-graph` 是公开内置工作流，不维护第二套实现。
- RalphGraph 的 `state.nodes[].status` 等派生字段；搬事实，不搬投影。
- RalphGraph 的验证者委派/persona/判定通道；统一走 Flow 的 `src/verify.ts`，避免第二套 T1。

`../ralph-graph-dsh/src/index.mjs` 约 6600 行，调度、workspace、工具、bridge 混在一起。实现时按上表拆成模块；不要把它作为黑盒依赖，也不要把整段复制进 Flow 的 `engine.ts`。

Graph 的参考实现是纯 JS，Flow 是 TypeScript。先按模块边界移植，允许阶段性用类型声明包住 JS 模块；不要为了语言统一重写调度、验证或 workspace 逻辑。

Graph 的 `sample` 启动语义在第一版统一入口中暂不暴露；保留在 Graph 模块内部，后续要加时只加一个可选参数，不改 `kind` 契约。

## 8. 实施顺序与验收

按“内核 → 工具/状态 → 查看器”的顺序落地；每阶段完成条件可独立验证。

### 阶段 1：资产契约与加载

- 目录分派：`workflows/` → Flow，`graphs/` → Graph；增加 `kind` 推断/目录一致性校验；Flow 现有 YAML 不改仍可跑。
- Graph 资产校验、`ralphflow_list`、动态技能、`ralphflow_doctor` 能识别两类，并按目录分组。
- **验收**：Flow 的 `loop`/`spec` 原样加载；Graph `codewiki` 从 `graphs/` 通过；无 `kind` 的 `nodes` 资产、`kind` 与结构冲突、文件放错目录均被拒；跨类别同名被 `doctor`/`list` 报出；Flow 的全部 `scripts/*.mjs` 仍绿。

### 阶段 2：Graph 状态与门面

- 把 Graph 调度、节点 attempt、CHECK、人工待办、合并搬入 Flow 的包内；联合状态落 `.dsh/ralph-flow/`。
- 统一 `start/continue/cancel/status/list` 的 kind 分派；Flow 分支行为不变。
- Graph CHECK 走 Flow 的 `verify.ts`；T1/T2 探测；Graph 的派生状态不落盘。
- **验收**：一个默认工作区 Graph 实例（codewiki）跑通并归档报告；一个 Git Graph 流程跑通 worktree + 节点分支 + 集成分支快进；Flow 全量回归；负对照证明节点状态由事实派生，而不是复制旧 `status` 字段。

### 阶段 3：工具、命令、技能

- 主工具面保持 8；Graph 的 respond/artifact_write 只做作用域注册；`ralphflow_submit` 按绑定分派。
- `/ralphflow-*` 统一；删除 `/ralphgraph-*` 与 `rg_*`；Flow 的 reset/rewind 对 Graph 拒绝，cleanup 对 Flow 说明不适用。
- Graph 的 Git 前置在 start 前校验；缺失时只返回给模型的初始化提示，不自动初始化。
- **验收**：`/ralphflow-start codewiki`（技能）能收集并绑定输入；Graph 人工问题通过 `ralphflow_respond` 回答；Flow 原有命令/技能回归；工具清单中没有第二命名空间。

### 阶段 4：报告、历史与保留

- Flow 的归档/销毁不变；Graph 归档报告并保留状态/日志/产物；`instances/` 语义与 `design.md` 同步。
- `ralphflow_list` 合并 Flow 报告与 Graph 保留实例；无新索引。
- 集成分支 `ralphflow/<实例>` 与节点分支 `ralphflow-node/<实例>/<节点>` 生效；cleanup 只清干净 worktree，保留有改动/未登记的 worktree 与它的 git 注册。
- **验收**：同工作区 Flow 与 Graph 各跑一次，都能从 `list`/`status`/报告定位；Flow 完成实例仍销毁；Graph 完成后 `status`/报告/产物可用；cleanup 不动 state/artifacts/reports。

### 阶段 5：只读查看器

- 一个 `sidebar.right.pane.tab`；Flow 链与 Graph DAG 同一入口，按 `workflows/` / `graphs/` 分组；节点详情 DO/CHECK；无控制面。
- 数据来自一个只读 remote，与状态面同源；明暗主题；窄栏默认纵向，宽屏列布局。
- **验收**：两种 kind 都能渲染；Flow 回边/当前步、Graph 并行/合入可见；切换/刷新后仍能定位；没有启动/审批/写操作；客户端构建与注入通过。

### 阶段 6：创建与内置

- 把旧 `orchestrator` 改名为 `design-graph`，作为公开内置，落 `graphs/design-graph.yaml`；复用设计节点、CHECK、设计方法/资产编写参考；路径与输入适配到 `.dsh/ralph-flow/`。
- 按 §6 把 `/ralphflow-create` 做成 dispatcher：Flow 分支返回原指南并写 `workflows/`；Graph 分支用同一公开 `start` 路由到 `design-graph`，生成资产写 `graphs/`；工具增加可选 `kind`。
- `codewiki` 作为公开 Graph 示例，落 `graphs/codewiki.yaml`；`loop`/`spec` 保留在 `workflows/`；`design-graph` 出现在 `list`/动态技能/公开 `start`，描述标明“设计 Graph 工作流”。
- 打包 `references/writing-for-agents.md` + `LICENSE`；`references/workflow-authoring.md` 与 `create` 指南加同一指针；`design-graph` 的 DO 写明读取条件，CHECK 按 §11.3 核对。
- **验收**：从需求创建 Flow 与 Graph 各一个资产，分别落在 `workflows/` 与 `graphs/`；Graph 创建由设计运行完成并 CHECK/doctor 通过；生成的工作流没有被自动启动；工作区没有 plan/design-delivery 文件；没有第二套 Graph 设计实现/交付物，`design-graph` 可直接启动，`create` 只是路由；生成资产的 DO/CHECK 通过 §11.3 的检查。

**回归门槛**：`npm run typecheck`、`npm run build`、全部 `scripts/*.mjs` 绿；Flow 的既有 YAML/命令/路径/报告逐字不变；新增 Graph 验收与负对照；客户端打包与真实宿主页面验收。

**测试纪律**：新增 Graph 用例必须让 `projectDir` 与会话工作区是两个不同的临时目录（`dsh web` 的真实形态是 cwd ≠ 会话工作区），并用 `mkdtemp` + 隔离 `HOME`；不要用同一个目录冒充两者，也不要删除真实 `.dsh/` 路径。

## 交付物

- 实现（`src/`、`workflows/`、`graphs/`、`references/`）+ 验收脚本（`scripts/*.mjs`）；`package.json` 的 `files` 增加 `graphs/` 与 `references/writing-for-agents.md`（及 LICENSE）。
- 同步文档：`README.md`、`docs/v2/design.md`（状态/命令/工具/目录/资产目录/创建边界）、`docs/commands.md`、`docs/custom-workflows.md`、`docs/how-it-works.md`。
- 把本次三项决策写进仓库的权威记录：两个资产目录、`create`/`design-graph` 分流、Graph 运行保留；按仓库既有方式（Flow 是 `design.md`；如存在 ADR/GLOSSARY 约定则一并更新），不要只留这份草案。
- 产出目录的 `change-note.md`：改了什么、每条验收怎么取证、负对照输出、如实披露的例外。
- 必须实跑并附真实输出：`npm run typecheck`、`npm run build`、全部 `scripts/*.mjs`、真实宿主页面验收；不要写“应该能过”。

## 9. 宪法对齐

- **T1**：Graph 判定只来自独立验证者会话；执行者自述不进验证请求。
- **T2**：Graph 推进由机械调度器按主事实决定；节点只负责自己的分支，快进由引擎做。
- **设计 CHECK**：`design-graph` 的 CHECK 独立验证生成资产；设计通过不等于生成工作流已可运行，不能互相冒充。
- **唯一写入者**：Flow 实例只由 Flow 引擎写，Graph 实例只由 Graph 模块写；门面只路由，查看器与状态服务只读。
- **不存派生量**：Graph 节点状态、等待原因、当前阶段由 attempt/verdict/acceptance 派生；搬运旧 Graph 状态时先剥离投影。
- **单一事实源**：一个判定账本、一个委派账本、一个状态文件、一个报告路径；不建第二索引。
- **客户端不得先于内核**：查看器在阶段 5。
- **资产目录**：Flow `workflows/`、Graph `graphs/`；一个运行根；目录与 `kind` 必须一致；跨类别同名视为冲突；不迁移 Flow 的现有 `workflows/` 路径。
- **工具面**：主模型固定 8；`ralphflow_create` 增加可选 `kind`，不新增工具；Graph 应答/产物写入只在作用域注册。若宿主无法作用域化 `respond`，才把它升为第 9 个主工具，并同步修订 `design.md` 的命令/工具表——不要默默扩张。
- **创建容器**：Flow 用指南，Graph 用公开内置 `design-graph`；`create` 只是分流器，不把两类塞进一个 skill。两者是同一实现的两个调用路径，不是两套实现。
- **Agent 可读内容**：`design-graph`/`create` 生成的 DO/CHECK 与工具描述按 `writing-for-agents`；参考随包，只有一份；生成资产不引用设计期指南。
- **命令面**：新增 Graph-only 的 `pause`/`cleanup` 人命令（无同名工具），Flow-only 的 `reset`/`rewind` 保持不变；命令表同步到 `design.md` 与 `docs/commands.md`。
- **不自动修复**：cleanup 只清干净 worktree；doctor 只诊断；Graph 的暂停/中断恢复仍需用户明确 `continue`。
- **方言**：Flow YAML 不加必填键；Graph 是 dsh 专属，不承诺跨端；两类资产目录分离，Flow 的 `workflows/` 语义不变。

## 10. 明确不做

- 不做第三个“图引擎”或第二套调度器。
- 不做 `/ralphgraph-*` 别名、`rg_*` 兼容层、`.dsh/ralphgraph/` 迁移。
- 不把 Flow 的 `current_step` 改造成 DAG 进度表；Graph 用独立联合状态。
- 不把 Flow/Graph 资产混进同一目录；不按 `kind` 静默跨目录解析，不迁移 Flow 的 `workflows/`。
- 不把 Graph 的 `node.status` 直接复制进新状态；先证明它能由事实派生。
- 不新增 Graph 专用报告/状态/历史索引；扩展现有 Flow 面。
- 不把 `design-graph` 做成第二套实现或第二个产品入口；它是公开内置工作流，`create` 只是路由。不保留 `orchestrator` 别名。
- 不自动启动生成的工作流；`create` 只启动设计运行。
- 不在查看器里放启动、暂停、取消、审批或产物写入。
- 不把 `writing-for-agents` 复制进每个资产/指南；只有一份随包参考。本次不生成 Skill，不打包 `skill-mechanics.md`。

## 11. Agent 可读内容的质量（writing-for-agents）

`design-graph` 和 `create` 产出的不是普通 YAML，而是 **agent 会读取的执行指令**：每个节点的 DO、CHECK，以及设计工作流自己的 DO/CHECK。它们必须按 `writing-for-agents` 的原则写；否则图能通过 `doctor`，运行时却会跳步、重复、漏验收。

### 11.1 参考随包交付

- 把 `../ralph-graph-dsh/src/builtin/references/writing-for-agents.md`（连同其 `LICENSE`）打包到 Flow 的 `references/writing-for-agents.md`。这是**唯一权威副本**，不要复制进每个资产。
- `design-graph` 的 DO 写明读取条件：**写任何节点的 DO/CHECK 之前**读它；写完按 §11.3 自检。
- 生成资产的 DO/CHECK **不引用设计期写作指南**；它们是被写出来的执行指令，不是让执行者再去读写作指南。任务需要的项目参考可以保留，但不要把设计期指南塞进运行期。
- Flow `create` 指南和 `references/workflow-authoring.md` 用**同一条指针**指向它；不要在 create 或每个资产里复述原则。
- 路径解析：`design-graph` 是内置资产，可用包内相对路径 `../references/writing-for-agents.md`；Flow 运行时指南沿用 `AUTHORING_REFERENCE_PATH` 的引擎注入绝对路径；工作区资产不硬编码开发机绝对路径。
- 本次生成的是工作流资产，不是 Skill；只打包 `writing-for-agents.md`。若未来增加“生成 Skill”的能力，再按同一规则补 `skill-mechanics.md`。

### 11.2 用在三条路径上

- **`design-graph` 生成 Graph 资产**：设计节点的 DO 要求先读参考；写每个节点时，为 DO 写可核查的完成条件、为 CHECK 写可独立取证的判据；共享规则只出现一次，节点之间用指针而不是复制。
- **`create` 的 Flow 分支**：现有 `CREATE_GUIDE` 增加同一读取条件；只加指针，不复制原则。
- **工具/命令描述**：`ralphflow_create`、`ralphflow_start` 等按同一原则写：前置触发词，一个 kind 一个分支，不堆同义描述；不要把完整 CLI 文档搬进工具描述。
- **`design-graph` 自己的 DO/CHECK**：也按同一原则写；它是 agent 读的，不是给人看的散文。

### 11.3 自检清单（`design-graph` 的 CHECK 用）

- 每个 DO 以**可核查的完成条件**收尾；CHECK 判据可独立取证、覆盖交付物。
- 每个上下文指针说明“材料是什么 + 何时读”；没有无条件的“见文档”。
- 按需披露：每个分支都需要的规则内联，只有部分分支/设计期才需要的参考放到指针后；不要把整套设计指南塞进每个节点。
- 同一含义只有一个权威位置；节点 DO 不复制共享规则或其他节点的指令。
- 用**正面指令**说明目标行为；禁止只保留为无法正面表述的硬护栏；能用引导词压缩的重复概念，不要展开成多段。
- 序列只在跨真实上下文边界（交接/子代理）时拆分；不要用拆步掩盖模糊的完成条件。
- 不重述环境可查的路径/命令/配置；只缓存非显然约定、理由和坑；删掉模型默认就会遵守的空话。
- 生成资产不引用设计期写作指南；设计期指南只服务设计过程。
- 工具描述一个触发分支一段，不用同义描述堆叠。

### 11.4 验收

- 参考文件随包、可解析；`design-graph` 的 DO 明确写出读取条件。
- 生成资产通过 §11.3 的 checklist；`design-graph` 的 CHECK 读生成资产本身并记录核对结果，不采信设计节点的自述。
- `create` 的 Flow 路径与 `workflow-authoring.md` 只有指针，没有第二份原则副本。
- 直接启动 `design-graph` 与通过 `create` 路由生成同一类资产时，质量判据一致。
- 本文只定义写作与验收契约；实际 DO/CHECK 质量要在实现后用真实的 `design-graph` 运行和生成资产验收，不能用文档审查代替运行验证。

## 12. 运行边界补遗

### 12.1 权限与安全

- Graph 节点与 CHECK 验证者都是子代理。节点要在自己的 worktree 里 `git commit`、把集成分支合进来，而 worktree 的 Git 元数据在主仓库 `.git` 下：所以节点拿到的是与 Claude Code 子 agent 同级的权限，隔离靠 worktree 目录与提示词，不靠截断 git；**不新增 `extra_dirs` 或平行权限面**。Flow 既有的“权限是宿主职责”结论同样适用。
- 所有节点都在 Git worktree 中运行；可读范围由宿主权限决定，插件不建第二套授权。
- Graph 始终为每个节点建独立 worktree；写同一项目不会互相覆盖，合入由引擎按实例串行快进集成分支。
- 节点只在集成分支的历史上提交，集成分支由引擎快进，都不自动 push、不自动改远端；外部网络与凭据仍由宿主权限控制。
- 节点 agent 是 owner 会话的直接子会话：创建时引擎补一条 `subagent/catalog`（`mode: "one-shot"`），顶部子智能体监控因此可见并可打开它的会话（只读、不可续）。验证者走 `ctx.subagents`，本来就在 catalog 里。
- Graph 节点是独立 agent；节点 agent 没有工程内并发上限（也不受宿主 `maxActiveSubagents` 约束——那条池只管验证者委派），所以 `parallel` 字段不存在。验证者委派由宿主池限流（引擎在池满时等待重试）；接纳/合入串行。
- 查看器只读；`design-graph` 只写 `graphs/` 和自身实例目录，不写工作区根的其他文件（最终 YAML 例外）。

### 12.2 资产快照与版本

- 启动时冻结资产：Graph 状态保留 `asset` 快照；Flow 启动时读取定义后不热加载。运行中修改 YAML **不影响已启动实例**，新实例才用新定义。
- 报告记录资产路径、名称和内容 hash；有 `version` 字段则一并记录。Graph 状态已有 `asset` 快照，Flow 不新增状态字段。审计时能定位“当时跑的是哪份定义”。
- 内置更新不改变活跃实例；`design-graph` 生成的资产保存后不会自动启动。
- 不新增必填 `version`：有则用，没有则用内容 hash；跨类别同名冲突在启动前解决。

### 12.3 失败与恢复

| 场景 | 行为 |
|---|---|
| 资产非法 / 目录或 `kind` 冲突 / 跨类别同名 | `start`/`doctor` 拒绝，不创建实例 |
| CHECK 失败 | Flow 走 `on_fail`；Graph 节点局部返工；都受失败预算约束 |
| 失败预算耗尽 | Flow 暂停；Graph 暂停/失败；等用户明确 `continue` |
| 宿主重开 | 复用恢复入口；Flow/Graph 标为暂停/中断，**不自动推进** |
| 取消 | Flow 归档报告并销毁实例；Graph 归档报告并保留状态/产物/worktree |
| 合并冲突 / 权限错误 | Graph 暂停或失败并报告原因；不自动强推、不自动提权 |
| 设计运行失败 | 生成资产可能已部分写入；不自动启动生成资产，用户审查后重试 |

诊断入口：

- `ralphflow_status`：当前实例的节点/步骤、CHECK、等待原因、下一步。
- `ralphflow_list`：工作流目录（Flow/Graph 分组）、活跃实例、历史。
- `ralphflow_doctor`：资产与实例的静态问题。
- 报告 `reports/<instance>.md`：完成/取消后的归档视图。
- 执行日志：验证者提示词与判定原文；Graph 节点事件同一格式。
- 查看器：只读状态/图/节点详情。
- **不注册** `rg_query`/`rg_delivery`；交付分类并入 `status`/报告，原始诊断读日志与状态。

### 12.5 第一版延后/开放项

- Graph `check_voting`：v1 不支持，见 §4.4。
- 跨类别组合：v1 不支持，见 §6.5。
- `sample`：v1 不进入统一入口，见 §7。
- `ralphflow_respond` 作用域：优先方案与回退见 §4.3。
- `graphs/` 目录名：v1 固定，见 §2.3。
