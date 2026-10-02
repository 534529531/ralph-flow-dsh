# Ralph Flow for DeepSeek Harness (dsh)

> **npm:** [`ralphflow-dsh`](https://www.npmjs.com/package/ralphflow-dsh) · **源码:** [github.com/534529531/ralph-flow-dsh](https://github.com/534529531/ralph-flow-dsh)

**执行者/验证者模式的具象化**：主会话执行任务，**有 `check` 的步骤**由独立验证者（全新会话，不可见主会话自辩）取证判定，失败自动返工（**没有 `check` 的步骤跳过对抗性验证**，见下文）；**是否推进只由机械程序决定**（裁判权定理，见 [docs/v2/design.md](docs/v2/design.md)）。这是 v2 原生重做版（旧版在 `archive/v1` 分支）。

## 安装

```bash
dsh plugin --profile web add ralphflow-dsh          # 或本地路径：dsh plugin --profile web add /path/to/ralph-flow-dsh
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 追加并重启：

```yaml
- insert:
    - id: ralphflow
      name: ralphflow-dsh
```

## 使用

| 命令 | 工具 | 用途 |
|---|---|---|
| `/ralphflow-start` | `ralphflow_start` | 启动工作流（模型执行 → 有 `check` 的步骤独立验证 → 失败自动返工） |
| `/ralphflow-continue` | `ralphflow_continue` | 放行审查门 / 解除暂停 / 接管实例 |
| `/ralphflow-status` | `ralphflow_status` | 查看实例状态与判定 |
| `/ralphflow-list` | `ralphflow_list` | 列出实例与工作流（表格） |
| `/ralphflow-cancel` | `ralphflow_cancel` | 取消并归档报告 |
| `/ralphflow-create` | `ralphflow_create` | 交互式创建自定义工作流 |
| `/ralphflow-doctor` | `ralphflow_doctor` | 诊断工作流定义与实例状态 |
| `/ralphflow-<工作流名>` | — | 动态注册的工作流快捷命令（如 `/ralphflow-loop`、`/ralphflow-spec`；命名与 claude code 版一致） |

`reset / rewind` 已声明未实现（涉及上下文管理，暂缓）；其余命令与 opencode 版功能看齐。命令语义 = **触发词**：`/ralphflow-*` **一律**由模型自然语言回复（含用法错误与未实现命令），**零程序化卡片返回**，行为与 claude code/opencode 完全一致。

内置工作流：`loop`（单步对抗验证循环）、`spec`（探索→提案→逐任务实现→归档，propose 步带审查门）。自定义工作流按同一方言放到 `<workspace>/.dsh/ralph-flow/workflows/`。

**`check` 决定本步是否被独立验证（与 opencode 一致）**：写了 `check` → 交卷后由独立验证者取证判定；**不写 `check` → 该步跳过对抗性验证**，DO 完成直接进入下一步（**工作流级** `manual_step` 列表里的这类步骤则是**纯人工审查**：停在审查门等你 `/ralphflow-continue` 放行）。跳过时通知、轨迹与归档报告一律写「跳过对抗性验证」——绝不会写成「检查通过」。不在 `manual_step` 列表里的无 `check` 步骤会在加载期与 `/ralphflow-doctor` 告警（提醒它不会被独立验证）；`check` 写了但非字符串（如 `check: true`）仍是加载期硬错误（本意是免验证请直接删掉该键）。内置 `loop`/`spec` 四步全有 `check`，行为不受影响。

**人工审查门只有一种写法：工作流级（顶层，与 `steps` 同级）的 `manual_step:` 列表**（列表写法，也接受逗号字符串 `"design,review"`；引用不存在的步骤 = 加载期硬错误）。**步骤级 `manual_step` 键已删除**：写进步骤里（不论 `true`/`false`/空值）都是**加载期硬错误**，报错文案会给出正确写法（把该步 id 列进顶层列表）。理由：opencode/pi 只认这个顶层列表，步骤级写法在那边只是「不认识的步骤键」——被警告忽略后**人工审查门静默消失**；静默跳过审查门比报错严重得多，所以这里 fail-fast。

**多验证者投票（`check_voting`，行为对齐 opencode 2.8.0）**：把 `check` 换成 1–5 个验证者，各自**并行**只查自己那条检查依据（可各配 `model`），**全过才放行**；任一票不通过 → 整体失败，聚合所有失败票的理由（含各票检查依据原文）反馈 DO 返工。每票完成即时推送一行进度，`/ralphflow-status` 可看每票状态。基础设施故障（票没跑成）**自动重试一次**且不计失败次数，只重跑故障票（已通过的保留）；重试仍故障才暂停，`/ralphflow-continue` 只补跑未通过的票。与 `check` **互斥**（同写 = 加载期硬错误），与 `check` 都不写 = 跳过对抗性验证。

```yaml
steps:
  - id: implement
    do: 按 design.md 实现
    output: 测试通过的代码
    check_voting:                      # 1-5 条；写几条就是几个验证者
      - check: 用户任务的每一条要求都已落实
      - check: 实现的行为符合预期，真实可用
        model: anthropic/claude-sonnet # 可选：该票专用模型（不填继承全局 adversarial_check.model）
      - check: 没有遗漏的需求，边界情况已覆盖
    on_pass: done
    on_fail: implement
    max_fail_count: 5
```

票数超过 5、空数组、条目缺 `check`、`check` 与 `check_voting` 同写、`check_voting` 与 `check_model` 同写，都是**加载期硬错误**（说人话、不静默）。条目里写 `timeout_ms` / `system_prompt` 与 `adversarial_check` 下同名键同一口径：本版本不兑现，加载期告警并忽略（验证超时交给宿主 dsh 的原生看门狗；验证者职责是插件内部定义）。投票进度**不另立文件**：每票状态就是实例 `state.json` 里的判定与在飞委派（单根事实源，见设计 §10.4），`/ralphflow-status` 现算。

> **内置工作流不落盘**（对齐 opencode/claude）：它们只存在于插件目录，加载时回落取用，因此**始终是随插件发布的最新版本**。要定制，就在 `<workspace>/.dsh/ralph-flow/workflows/` 放一个同名文件——它会遮蔽内置（这是唯一的定制入口，也是有意行为）。

## 工作区结构

实例与资产沉淀在**发起会话的工作区**（dot-dir，与 opencode `.opencode/ralph-flow/`、claude `.claude/ralph-flow/` 形状一致）：

```
<workspace>/.dsh/ralph-flow/
├── workflows/     # 自定义工作流 YAML（内置 loop/spec 不在此，放同名文件即遮蔽内置）
├── instances/     # **仅活跃**实例的机器状态（每实例一个目录：state.json + execution.log；结束时销毁）
├── reports/       # 完成/取消后归档的报告（永久保留，历史的唯一入口；执行日志归档为 <实例ID>-execution.log）
└── artifacts/     # 每实例隔离的产出目录（永久保留；只有空目录会随实例销毁）
```

**执行日志（JSONL，机器可读）**：每个活跃实例在 `instances/<实例ID>/execution.log` 追加「一行一个 JSON 对象」（`{ts, level, event, …}`），完整记录生命周期事件与**验证者提示词原文、判定原文**（不截断）——报告给人看，日志给机器（`grep` / `jq`）看。结束/取消时随报告归档到 `reports/<实例ID>-execution.log`，报告里因此多一行 `- 执行日志：…` 指路（报告其余内容不变）。单文件上限 10 MB、保留 3 份轮转（`.log.1..3`），阈值可用 `RALPHFLOW_LOG_MAX_BYTES` 注入小值。写日志失败（目录只读、磁盘满）**只记一条 warning**，绝不影响工作流推进。

**实例是临时的，报告与产出是永久的。** 工作流完成或取消时：报告归档到 `.dsh/ralph-flow/reports/<实例ID>.md` → 从实例列表除名 → 销毁 `.dsh/ralph-flow/instances/<实例ID>/`。产出目录名 = 任务摘要 slug + 实例 id 尾段（按码点截断，中文/emoji 不会被切碎），在 `artifacts/<名字>/` 下；**非空产出目录整个保留**（`rmdir` 拒绝非空目录——真实交付物永远活得比实例久），只有空产出目录才会被删掉。报告归档失败时**不销毁**实例目录（宁可留一个可见残留，也不静默丢掉轨迹），`/ralphflow-doctor` 会报出来。**销毁失败也不会谎称成功**：实例目录没删掉时，完成/取消播报会如实说明残留并指向 `/ralphflow-doctor`（残留目录缺 `state.json`，doctor 报「缺少 state.json」）；实例与报告都落在**发起会话的工作区**，与引擎进程的 cwd 无关。

`artifacts/<产出目录名>/` 是 DO 阶段的交付物落点：DO 与 CHECK 提示词都会自动带上一行「产出目录」，所以工作流里写**裸文件名**（如 `summary.md`）即可落到该实例的目录，跨任务不串味、也不进仓库根。

`/ralphflow-list` 分两节：**活跃实例** + **历史运行（已归档）**。后者扫 `reports/*.md` 现读现解析（实例 id、状态、任务、结束时间、报告路径），不需要任何派生索引——已结束的运行永远不会因为实例目录被销毁而"找不回来"。`/ralphflow-status <实例ID>` 对已销毁实例会直接指向它的报告，而不是谎称"没有实例"。

**一个工作区一个引擎**（对齐 opencode 的「每个项目目录一个插件实例」）：引擎的根就是**发起会话的工作区**，所以列表、历史、`doctor`、自定义工作流查找全都落在同一个地方。工作区之间互相独立、互不可见；**没有全局索引**——任何跨工作区的映射都会让「写入看会话工作区、读取看进程 cwd」这类缺陷复活（引擎的 `projectDir` 是 dsh 进程的 cwd，真实 GUI 里与会话工作区必然不同）。`.gitignore` 只忽略 `.dsh/ralph-flow/`（精确），不忽略整个 `.dsh/`。

## 设计

- **裁判权定理**：判定只可能产生于独立会话（T1）；推进只由机械程序决定（T2）。
- 状态模型：无相位字段，全部阶段由原始事实派生（交卷了吗 / 判定落地了吗 / 有在飞委派吗 / 暂停了吗）。
- **验证者**：全新独立会话（按能力自动选择全新上下文的后端，与名称无关），只见任务 + 检查依据 +（可读的）产出目录——**看不到执行者的交卷摘要**；只读工具白名单，结构化判定 + 文本兜底，fail-closed。
- **验证者配置（YAML `adversarial_check`）**：**只接受 `model` 一个字段**（可选，`"provider/model"` 或 `{providerID, modelID}`），步骤级 `check_model` 可覆盖它；都不写就沿用发起会话当前模型。验证者的身份与职责是插件内部定义，工作流不再能配置它。写了其它字段（或 `adversarial_check` 不是对象）会在加载期告警并忽略，`/ralphflow-doctor` 同样报出。模型优先级链：`check_voting` 条目 `model` > 步骤 `check_model` > 全局 `adversarial_check.model` > 发起会话当前模型。
- **多验证者投票**：N 票各自独立会话、独立提示词（共享上下文 + 该票专属检查依据 + 「你是 N 个之一」约束）、独立取消句柄与心跳；**全部终态才聚合**，聚合优先级 `failed > infra > 全过`（工作问题绝不被基础设施故障遮蔽）。
- 完整设计、宪法与路线图见 [docs/v2/design.md](docs/v2/design.md)；多验证者投票验收见 `scripts/voting-test.mjs`（加载校验/提示词变体/聚合优先级/infra 重试与续跑/跨轮重投/每票进度/取消传播/单 check 回归）；引擎验证测试见 `scripts/engine-test.mjs`（含布局/产出目录/加载期硬校验/doctor lint/报告统计/**单根发现面**/CREATE_GUIDE 一致性），实例生命周期验收见 `scripts/lifecycle-test.mjs`，执行日志（JSONL）验收见 `scripts/execution-log-test.mjs`（JSONL 合法性 / 归档与报告指路 / 提示词与判定原文可复盘 / 轮转 / 写失败不致命 / 零状态字段；`RF_LIB=<基线库>` 即负对照）。
- **生命周期不变量**（违反即回退）：实例是临时的、报告与产出是永久的；先除名（`unlink(state.json)`）后删物理文件（否则部分删除失败会留下幽灵实例）；销毁前先写完报告、先读出产出目录名；产出只用非递归 `rmdir`（非空即保留）；销毁后不再写 `state.json`（`writeState` 会 `mkdirSync` 复活的实例目录）。

## v0 范围（诚实声明）

有：YAML 引擎、loop + spec、审查门、续跑/接管、失败重试、按工作区单根、崩溃 fail-safe、报告归档（含每步耗时与重试）、产出目录、实例生命周期（终止即归档并销毁实例目录 + 历史运行列表 + doctor 实例目录体检）、执行日志（JSONL，机器可读，随报告归档 + 轮转）、create/doctor 实现、**多验证者投票（`check_voting`）**。
无：reset/rewind、子工作流、客户端 UI、系统通知、验证者沙箱。每项的准入触发条件见设计文档 §11。

## 许可

[MIT](LICENSE)