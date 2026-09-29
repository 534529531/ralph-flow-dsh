# 执行日志任务书（JSONL）

> **读者**：`ralph-flow-dsh` 的实现者。读完后应能仅在本仓库完成改造，并用下列验收项判断是否交付。
>
> **状态**：待实现。这是**补功能**，对齐 opencode 版的「日志与报告」能力。
>
> **前置定案（作者）**：**只移植 `execution.log`（JSONL），不移植 `step-records.json`**。理由见 §2。

## 目标

给每个实例一份**机器可读**的追加式执行日志，随报告一起归档。

现状：我们只有**人类可读**的归档报告（报告里的「轨迹」是粗粒度事件列表），出了问题无法复盘「验证者当时到底看到了什么」。opencode 那边这一层是一直有的，且它把**发给验证者的（近乎完整的）提示词**也写进日志——这恰恰是排查「验证者为什么判错」唯一有效的东西。

## 1. 关键约束：报告与日志分工，不许互相抄

| | 报告 `reports/<id>.md` | 日志 `reports/<id>-execution.log` |
|---|---|---|
| 读者 | **人** | **机器**（grep / jq） |
| 形态 | Markdown，叙述式 | JSONL，每行一个 JSON 对象 |
| 内容 | 任务、状态、耗时、重试、轨迹摘要、判定摘要 | 完整事件流 + 验证者提示词与判定原文 |

**报告保持现状**（已验收），只新增**一行**指向归档日志。**不要**把日志内容倒进报告，也不要把报告内容重复进日志。

## 2. 不做 `step-records.json`（**这一条是任务的一部分，不是遗漏**）

opencode 的 `step-records.json` 是 `StepExecutionRecord[]`（`stepId/phase/status/failCount/startTime/endTime/reason/workflowName`）。它的主要消费者是 **`rewind`**（倒退到上游已通过 CHECK 的步骤）——而 `rewind` 本仓库**已定案押后**。

同时，**我们的报告已经从 `history` 派生了同样的信息**：每步耗时与重试次数（`stepStats()`，见 `src/engine.ts`），刚刚修好并补了合成 history 单测。

再移植一份 step-records，就是给同一件事造**第二个事实源**：两处会漂移、报告会自相矛盾、将来做 rewind 时还得先决定信谁。**要补的是缺失的那一层（机器可读日志），不是补一份我们已有的派生量。**

> 若你在实现中发现「没有 step-records 就做不了日志」——那是判断错误，回来看这一节。日志是**事件流**，不需要任何派生记录。

## 3. 实现边界

### 3.1 位置与生命周期

- 运行期：`<workspace>/.dsh/ralph-flow/instances/<实例ID>/execution.log`（与 `state.json` 同目录）
- 销毁时：**随报告归档**到 `<workspace>/.dsh/ralph-flow/reports/<实例ID>-execution.log`
- 报告里新增一行指路，例如：`- 执行日志：\`.dsh/ralph-flow/reports/<实例ID>-execution.log\``

沿用既有的销毁顺序不变量：**报告归档失败 → 不销毁**（现状不变）。**日志归档失败只告警、不阻塞销毁**——报告才是主事实，日志是辅助证据，不能因为辅助证据写不出来就把实例卡住。

### 3.2 内容：必须是可复盘的事件流

每行 `{ ts, level, event, ...extra }`，`level` ∈ `info|warn|error`。至少覆盖：

- 生命周期：`start` / `step_start` / `do_submitted` / `verify_start` / `verdict` / `advance` / `gate_opened` / `gate_released` / `check_skipped` / `pause` / `resume` / `complete` / `cancelled` / `destroy`
- **验证者取证**：发给验证者的**提示词原文**、验证者返回的**判定原文**（`reason` 全文，不截断）、耗时
- 已有的内部告警：`state_unlink_failed` / `instance_dir_remove_failed` / `instance_dir_not_removed` / `registry_*` 之类的既有 `log()` 事件

> **提示词与判定不截断**：截断的日志在排查时等于没有。体积由 §3.3 的轮转兜住。

### 3.3 轮转

照 opencode：单文件上限 **10 MB**，保留 **3** 份轮转（`.log.1` / `.log.2` / `.log.3`，最旧的删除）。阈值要能在测试里注入小值（否则没法验证）。

### 3.4 日志失败绝不影响主流程

写日志的任何异常（目录只读、磁盘满、轮转失败）**只记一条 warning 到插件的 `log()` 端口**，绝不抛出、绝不中断工作流、绝不改变推进判定。opencode 同款语义。

### 3.5 零新持久化状态

**不得**往 `InstanceState` 加任何字段。日志是 **append-only 的文件事实**，不是状态；`state.json` 一个字节都不因为本任务改变。

### 3.6 不得改动的回归基线

- 报告内容与格式（除新增那一行指路）
- 销毁七步与「报告归档失败 → 不销毁」不变量
- 无 `check` 跳过对抗性验证、诚实标注口径（含 `check_skipped`）
- 有 `check` 的全部行为
- 判定落账与 fail-closed 判据

## 4. 验收标准

1. **运行期日志存在且是合法 JSONL**：跑一轮后 `instances/<id>/execution.log` 每行都能 `JSON.parse`。
2. **归档**：完成后 `reports/<id>-execution.log` 存在；报告里有一行指向它；**报告其余内容与本任务前逐字节相同**（用 diff 证明）。
3. **可复盘**：日志里能找到①发给验证者的提示词原文 ②验证者返回的判定原文（与报告里的判定字符串一致）。
4. **轮转生效**：注入小阈值（如 1 KB）跑一轮，出现 `.log.1` 且当前文件不超阈值。
5. **失败不致命**：把日志目录设成不可写（`chmod 500`），工作流仍能正常跑完并推进——只多一条 warning。测完恢复权限。
6. **零状态变化**：`git diff` 里 `InstanceState` 接口无新增字段；对比跑同一工作流前后 `state.json` 的键集合一致。
7. **负对照**：把日志写入关掉（或还原实现），上述 1/2/3/4 至少一条必须失败。
8. **全量回归**：`npm run typecheck` exit 0；`scripts/` 下全部 `*.mjs` 全绿（当前 471 断言）；**有 `check` 的回归探针与 `HEAD` 基线逐字节相同**（沿用既有 `regression-probe.mjs` 的做法：loop 全流程 + spec 四链 + lint，比对 md5）。
9. **诚实**：做不到或有例外的条目，如实写进 `change-note.md` 并说明影响面——**不要**藏进"已实现"里。作者会独立复核。

## 5. 交付物

- 实现（`src/`）+ 测试（`scripts/`）+ 同步文档（`README.md`：工作区结构里加日志文件；`docs/v2/design.md` 相应章节）。
- 变更说明写到产出目录的 `change-note.md`：改了什么、每条验收怎么取证的、负对照输出、如实披露的例外。
- 必须实跑并附**真实输出**：`npm run typecheck`、`npm run build`、`scripts/` 下全部 `*.mjs`。

**测试纪律**：复现与测试一律 `mkdtempSync` 造工作区 + 隔离 `process.env.HOME`；**绝不** `rmSync` 真实工作区或真实 `.dsh/` 路径。

## 附：opencode 版依据（供实现者省去重新取证）

```ts
// opencode: src/engine.ts
const MAX_LOG_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_LOG_ROTATIONS = 3;

function logEvent(instId, level, event, extra?) {
  try {
    ensureLogDir(instId);
    rotateLogIfNeeded(instId);
    const entry = { ts: new Date().toISOString(), level, event, ...extra };
    fs.appendFileSync(path.join(getLogDir(instId), "execution.log"), JSON.stringify(entry) + "\n");
  } catch (e) { diag(`[ralph-flow] Log failed (${event}):`, e.message); }   // ← 只诊断，不抛
}
```

- 归档：`destroyInstance` 内 `fs.copyFileSync(getLogDir(instId)/execution.log, reportsDir/<id>-execution.log)`，并把路径追加进完成消息
- `src/check.ts:227` 的注释说明它**有意把发给验证者的近乎完整提示词写进日志**，好让日志可复盘
- **本任务不移植** `step-records.json`（见 §2）
