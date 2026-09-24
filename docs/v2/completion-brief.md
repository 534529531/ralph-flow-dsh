# ralphflow v0 功能补全任务书

> **目标**：把**已有功能**补齐到与 opencode 版一致；并按作者定案新增 **§1.7 产出目录**（opencode 有、我们缺的基础功能）与 **§1.8 运行时目录改 dot-dir**。
> **对齐基准**：`/home/yj/.config/opencode/plugins/ralph-flow`（`main` = v2.11.0 = GitHub main）。**只读它做参照，不要移植它的代码**（宪法 §10.9）。
> 判定标准：**"用户写错了却没有任何信号"就是缺陷**——要么硬错误，要么 doctor 告警，不允许没反应。

## 1. 对齐清单

**1.1 加载期校验**（对齐 opencode 的方言严格性）
- `check` 存在但非字符串（`check: true`）→ 硬错误
- `manual_step` 引用不存在的步骤 id → 硬错误（`create.ts` 已自称是硬规则，实际没校验）
- `manual_step` 支持逗号字符串写法（opencode 两种都支持）
- `max_fail_count` 必须是 ≥1 整数（`0`/负数现在静默接受）
- `do` 缺失 → 硬错误

**1.2 doctor**（对齐 opencode 的诊断覆盖）
- 可达性 lint：不可达步骤告警；**没有任何可达步骤 `on_pass: done` → 永不完成**（现在报 ✅ 且运行时无限循环）
- 未解析的模板变量 `{{...}}` 标记出来
- 非 `manual_step` 且无 `check` 的步骤告警

**1.3 验证者提示词**（对齐 opencode 的 CHECK 上下文）
- 补 `desc` + `output`：我们 DO 提示词有「## 交付物」，CHECK 没有，验证者不知道本步承诺交付什么

**1.4 报告**（对齐 opencode 的报告内容）
- 补每步耗时 / 重试次数（从 `history` 的 `ts` 与 `fail_counts` 派生，**不新增落盘字段**）

**1.5 卫生**
- 实例索引 GC：`restore()` 时清掉 `state.json` 已不存在的悬挂条目

**1.6 文档**
- `src/create.ts` 的 `CREATE_GUIDE` 与实际行为逐条对齐（含快捷命令已改为 `/ralphflow-<工作流名>`）

**1.7 产出目录**（对齐 opencode 的产出目录功能，形态按 dsh 调整）
- 每实例一个隔离目录：`<workspace>/.dsh/ralph-flow/artifacts/<instId>/`；实例启动时由 `ensureLayout` 建好，**完成后保留**
- DO 与 CHECK 提示词**各注入一行**「产出目录：`.dsh/ralph-flow/artifacts/<instId>/`」（**工作区相对路径**）
- 由此 `do`/`output` 里写**裸文件名**即落到产出目录；**内置 `loop.yaml`/`spec.yaml` 不用改**（那句"追加到 `summary.md`"和 `proposal.md` 等自动归位）
- **不做** `{{artifacts_dir}}` 模板记号：opencode 自己文档都说"你几乎用不到"，做了等于多一个记号解析器（与 §1.2 的未知 `{{}}` 告警也重复）
- 要解决的现状：裸文件名落在**会话工作区根**、跨任务串味——`summary.md` 已长到 67KB 且**被提交进了 git**

**1.8 运行时目录改为工作区 dot-dir**
- `<workspace>/ralph-flow/` → `<workspace>/.dsh/ralph-flow/`
- 理由：与 opencode `.opencode/ralph-flow/`、claude `.claude/ralph-flow/` 形状一致；并与全局 `~/.dsh/ralph-flow/workflows` 形成对称（插件命名空间在两个作用域里都是 `ralph-flow`）
- 改动面：`RALPH_FLOW_DIR`（[engine.ts:16](src/engine.ts#L16)，路径全由它派生）+ 6 处用户可见文案里的硬编码路径（`engine.ts:710/1076`、`tools.ts:286/299/309`、`create.ts:8`）+ `.gitignore` + 文档（README / design §9 / CREATE_GUIDE）
- `.gitignore` 写 **`.dsh/ralph-flow/`（精确）**，**不要**整个 `.dsh/`——将来 dsh 可能在工作区 `.dsh/` 里放需要入库的项目配置
- 迁移：旧 `ralph-flow/` 一次性 `mv` 即可。**当前无用户数据**（全局工作流目录为空、本地只有 loop/spec 自动副本、实例是 gitignored 临时数据）
- 过渡期：本轮 round 1 时产出目录还没生效，loop 的累积器**仍会在仓库根生成一个新的 `summary.md`**；§1.7 落地后把它删掉，并确认后续轮次不再在根生成
- **注意覆盖 `hardening-brief.md` §4.1**：那份说"审计清单写入 `summary.md`"，是上一轮遗留的说法（正是它把 67KB 摘要写进了仓库根并入库）。本轮改为写入 `docs/v2/evidence/summary-completion.md`（见 §4.9）
- 顺带归档：仓库根的 `summary.md`（上一轮加固的 67KB 累积摘要，**已入库**）移到 `docs/v2/evidence/summary-hardening.md`，避免与新轮的累积器混淆
- **1.7 与 1.8 一起做**（同一次改动），避免迁移两次

## 2. 边界（硬性）

- **不做有意推迟的**：`check_voting`、`reset`/`rewind`、子工作流、UI / 通知 / 沙箱
- **不新增**命令或模型可见工具
- **不自建**超时 / 看门狗 / 竞速（design §8）
- **不为**环境异常（重启、源码漂移）加代码（design §7）
- **不做**执行日志（`execution.log` JSONL，属新增，需作者先定案）

## 3. dsh 特性（不能照搬 opencode 的地方）

| 点 | opencode | 我们 |
|---|---|---|
| DO 交卷 | `<promise>done</promise>` 文本标签 | `ralphflow_submit` 工具（已定案，不改） |
| 判定 | 文本解析 | `outputSchema` 结构化 |
| **无 `check` 的步骤** | **跳过验证直接推进** | **不可照搬**：design §12.1 要求「跳过验证推进必须被拒」→ 保留通用兜底 + doctor 告警 |
| 缺必填字段 | 静默丢弃该步 | 按 design §8 → 硬错误说人话 |
| `extra_dirs` 项目外源材料 | 有 | 不做（dsh 无对应权限模型） |
| **产出目录位置** | `.opencode/ralph-flow/artifacts/<任务摘要>-<后缀>/` | `<workspace>/.dsh/ralph-flow/artifacts/<instId>/`。dsh **没有**工作区级 dot-dir 惯例（它的 home 是全局 `~/.dsh`，且不往项目里写东西），所以这是**我们的选择**；用 `instId` 免去给中文任务造 slug |
| **验证者能否读产出** | 靠 `external_directory: allow` | **验证者继承父会话工作区**（`subagents.start` 的 `SubagentStartRequest` **没有 cwd 参数**；E2E 已证验证者 `pwd` = 会话工作区）→ 产出目录**必须在工作区内**，放外面验证者直接读不到，而**我们没有**该权限的等价物 |
| **产出可见性** | TUI，需 `cat` 路径 | 工作区文件浏览器**不过滤隐藏文件**（`dsh-api-workspace-files` 无 dotfile 逻辑），`.dsh/` 照样可见；且 dsh 按会话记录文件变更 + diff |
| TUI / 窗口 | 有 | 不做（宪法不碰客户端） |
| 执行日志 | `execution.log` JSONL | 沿用 `state.json` 的 `history` + 归档报告 |

## 4. 验收

1. §1 每条都有**自己的复现证据** + 修复后验证。
2. **静默路径消失**：写错的 YAML 要么硬错误、要么 doctor 告警。
3. **不误伤**：`loop`/`spec` 与现有测试夹具照常加载（可达性 lint 最容易误报，必须验）。
4. 现有 8 个测试脚本全绿 + `APPLY_OK` + `tsc --noEmit` 干净；每条修复配断言。
5. `CREATE_GUIDE` 与引擎实际行为逐条一致。
6. 边界未破（§2）。
7. **产出目录生效**（§1.7）：跑一个真实 `loop`，`summary.md` 落在 `.dsh/ralph-flow/artifacts/<instId>/` 而**不是**工作区根；DO 与 CHECK 提示词都含「产出目录」行；验证者的取证证据里出现该路径（证明它读得到）。
8. **布局迁移完成**（§1.8）：`<workspace>/.dsh/ralph-flow/{workflows,instances,reports,artifacts}` 齐全、旧 `ralph-flow/` 不再被创建、`git status` 干净（`.dsh/ralph-flow/` 已忽略）、README / design §9 / `CREATE_GUIDE` 里的路径全部更新。
9. **交付摘要入库**：本轮审计与完成记录写入 `docs/v2/evidence/summary-completion.md`（**入库**，供下轮/作者查阅）。注意与 loop 自己的累积器区分——`summary.md` 现在落在产出目录（**不入库**），别再往仓库根写。

> 工作协议与已知陷阱沿用 `docs/v2/hardening-brief.md` §4–§5（含：复现只用 `mkdtemp` 临时工作区 + `HOME` 隔离、绝不删真实工作区、改完 `npm run build` 由作者重启、**不要在验证进行中重启或改源码**）。
