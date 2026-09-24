# ralphflow v0 功能补全任务书

> **目标**：把**已有功能**补齐到与 opencode 版一致。
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

## 2. 边界（硬性）

- **不做有意推迟的**：`check_voting`、`reset`/`rewind`、子工作流、UI / 通知 / 沙箱
- **不新增**命令或模型可见工具
- **不自建**超时 / 看门狗 / 竞速（design §8）
- **不为**环境异常（重启、源码漂移）加代码（design §7）
- **不做**产出目录、执行日志（属新增，需作者先定案）

## 3. dsh 特性（不能照搬 opencode 的地方）

| 点 | opencode | 我们 |
|---|---|---|
| DO 交卷 | `<promise>done</promise>` 文本标签 | `ralphflow_submit` 工具（已定案，不改） |
| 判定 | 文本解析 | `outputSchema` 结构化 |
| **无 `check` 的步骤** | **跳过验证直接推进** | **不可照搬**：design §12.1 要求「跳过验证推进必须被拒」→ 保留通用兜底 + doctor 告警 |
| 缺必填字段 | 静默丢弃该步 | 按 design §8 → 硬错误说人话 |
| `extra_dirs` 项目外源材料 | 有 | 不做（dsh 无对应权限模型） |
| TUI / 窗口 | 有 | 不做（宪法不碰客户端） |
| 执行日志 | `execution.log` JSONL | 沿用 `state.json` 的 `history` + 归档报告 |

## 4. 验收

1. §1 每条都有**自己的复现证据** + 修复后验证。
2. **静默路径消失**：写错的 YAML 要么硬错误、要么 doctor 告警。
3. **不误伤**：`loop`/`spec` 与现有测试夹具照常加载（可达性 lint 最容易误报，必须验）。
4. 现有 8 个测试脚本全绿 + `APPLY_OK` + `tsc --noEmit` 干净；每条修复配断言。
5. `CREATE_GUIDE` 与引擎实际行为逐条一致。
6. 边界未破（§2）。
7. 每轮追加 `summary.md`（完成项 / 变更文件 / 证据 / 下一步）。

> 工作协议与已知陷阱沿用 `docs/v2/hardening-brief.md` §4–§5（含：复现只用 `mkdtemp` 临时工作区 + `HOME` 隔离、绝不删真实工作区、改完 `npm run build` 由作者重启、**不要在验证进行中重启或改源码**）。
