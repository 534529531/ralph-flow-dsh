# Ralph Flow for DeepSeek Harness (dsh)

> **npm:** [`ralphflow-dsh`](https://www.npmjs.com/package/ralphflow-dsh) · **源码:** [github.com/534529531/ralph-flow-dsh](https://github.com/534529531/ralph-flow-dsh)

**执行者/验证者模式的具象化**：主会话执行任务，独立验证者（全新会话，不可见主会话自辩）取证判定，失败自动返工；**是否推进只由机械程序决定**（裁判权定理，见 [docs/v2/design.md](docs/v2/design.md)）。这是 v2 原生重做版（旧版在 `archive/v1` 分支）。

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
| `/ralphflow-start` | `ralphflow_start` | 启动工作流（模型执行 → 独立验证 → 失败自动返工） |
| `/ralphflow-continue` | `ralphflow_continue` | 放行审查门 / 解除暂停 / 接管实例 |
| `/ralphflow-status` | `ralphflow_status` | 查看实例状态与判定 |
| `/ralphflow-list` | `ralphflow_list` | 列出实例与工作流（表格） |
| `/ralphflow-cancel` | `ralphflow_cancel` | 取消并归档报告 |
| `/ralphflow-create` | `ralphflow_create` | 交互式创建自定义工作流 |
| `/ralphflow-doctor` | `ralphflow_doctor` | 诊断工作流定义与实例状态 |
| `/ralphflow-<工作流名>` | — | 动态注册的工作流快捷命令（如 `/ralphflow-loop`、`/ralphflow-spec`；命名与 claude code 版一致） |

`reset / rewind` 已声明未实现（涉及上下文管理，暂缓）；其余命令与 opencode 版功能看齐。命令语义 = **触发词**：`/ralphflow-*` **一律**由模型自然语言回复（含用法错误与未实现命令），**零程序化卡片返回**，行为与 claude code/opencode 完全一致。

内置工作流：`loop`（单步对抗验证循环）、`spec`（需求→规格→设计→任务→实现→验收→归档，propose 步带审查门）。自定义工作流按同一方言放到 `<workspace>/.dsh/ralph-flow/workflows/`。

## 工作区结构

实例与资产沉淀在**发起会话的工作区**（dot-dir，与 opencode `.opencode/ralph-flow/`、claude `.claude/ralph-flow/` 形状一致）：

```
<workspace>/.dsh/ralph-flow/
├── workflows/     # 自定义工作流 YAML（内置 loop/spec 会先复制进来，可编辑）
├── instances/     # 活跃/已结束实例状态（每实例一个目录）
├── reports/       # 完成/取消后的报告归档
└── artifacts/     # 每实例隔离的产出目录 <instId>/（启动时建好，完成后保留）
```

`artifacts/<instId>/` 是 DO 阶段的交付物落点：DO 与 CHECK 提示词都会自动带上一行「产出目录」，所以工作流里写**裸文件名**（如 `summary.md`）即可落到该实例的目录，跨任务不串味、也不进仓库根。

多工作区各自独立；实例索引在 `~/.dsh/ralphflow-instances-index.json`。`.gitignore` 只忽略 `.dsh/ralph-flow/`（精确），不忽略整个 `.dsh/`。

## 设计

- **裁判权定理**：判定只可能产生于独立会话（T1）；推进只由机械程序决定（T2）。
- 状态模型：无相位字段，全部阶段由原始事实派生（交卷了吗 / 判定落地了吗 / 有在飞委派吗 / 暂停了吗）。
- 验证者：全新独立会话，只见任务 + 检查依据 + 交卷摘要 +（可读的）产出目录，只读工具白名单，结构化判定 + 文本兜底，fail-closed。
- 完整设计、宪法与路线图见 [docs/v2/design.md](docs/v2/design.md)；引擎验证测试见 `scripts/engine-test.mjs`（57 项，含布局/产出目录/加载期硬校验/doctor lint/报告统计/索引 GC）。

## v0 范围（诚实声明）

有：YAML 引擎、loop + spec、审查门、续跑/接管、失败重试、多工作区、崩溃 fail-safe、报告归档（含每步耗时与重试）、产出目录、create/doctor 实现。
无：多验证者投票（`check_voting` 键会警告忽略）、reset/rewind、子工作流、客户端 UI、系统通知、验证者沙箱、执行日志。每项的准入触发条件见设计文档 §11。

## 许可

[MIT](LICENSE)