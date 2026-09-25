# 实例生命周期任务书

> **读者**：`ralph-flow-dsh` 的实现者。读完后应能仅在本仓库完成改造，并用下列验收项判断是否交付。
>
> **状态**：待实现。本文件描述目标行为，不代表当前代码已经如此运行。
>
> **前置定案（作者）**：**照 opencode 版的既有解办，不重新设计。** 该实现已长期运行、且已解掉我们在 `.dsh/` 里实际观察到的三个不一致（幽灵活跃实例、孤儿报告、实例目录永不清理）。只有一处要在它的基础上做得更好（见「实现边界 3」与「实现边界 2 的报告写失败分支」）。

## 目标

把「**活实例**」与「**历史档案**」分成两层，让机器状态文件敢被销毁：

- 工作流终止（完成 / 取消）时：**归档报告 → 销毁实例目录**。
- 产出（`artifacts/`）**永不自动删除**。
- 「工作流实例」列表只列**活跃**实例；已结束的从 `reports/` 读出来。

现状的问题不是"删不删"，而是三份数据（`instances/`、`reports/`、`artifacts/`）各自独立、生命周期互不相关，且 `state.json` 同时承担「运行中机器状态」与「历史实例索引」两个职责——后者导致它删不起（删了工具就"忘了"这个实例），于是只能永不删。

## 核心不变量（不得违反）

1. **实例是临时的，报告与产出是永久的。**
2. **先除名，后删物理文件**：`unlink(state.json)` 必须**先于**递归删目录。理由：即使递归删除部分失败（Windows EBUSY 等），实例也已从列表消失，**不会变成幽灵**。
3. **销毁前抢救**：报告必须在销毁前写完；产出目录名必须在销毁前读出来。
4. **产出只删空目录**：用**非递归** `rmdir`——非空即失败即保留。真实交付物永远活得比实例久。**不变量交给机制，不交给代码纪律。**
5. **销毁后不得再写 state**：`writeState` 会 `mkdirSync(instanceDir)`，任何后续写入都会**复活**实例目录（且复活成"已结束但存在"的僵尸）。

## 公开行为契约

| 事件 | 结果 |
|---|---|
| 工作流完成 | 报告归档到 `<ws>/.dsh/ralph-flow/reports/<instId>.md`；实例目录被销毁；产出保留 |
| 实例取消 | 同上（报告状态为「取消」）|
| `/ralphflow-list` | 「活跃实例」节只列活跃实例；「历史运行」节列出已归档的运行 |
| 完成 / 取消消息 | 给出报告的**精确相对路径**，不是"在 reports/ 目录里" |
| `doctor` | 报出实例目录异常（缺 state.json / 损坏 / 已结束但未销毁）|

## 实现边界

### 1. 销毁函数 `destroyInstance(instId, status)`

新增，顺序**严格**如下（顺序本身是正确性的一部分）：

1. `archiveReport(...)` → 失败返回 `null` 时 **中止销毁**（见边界 2）。
2. 解析 `artifactsDirOf(workspace, instId)`——**先**读出来，之后目录就没了。
3. 从全局索引 `registry` 删除该条目并 `saveRegistry()`——**立即**除名，不等下次 `restore()` 的 GC。
4. `try { fs.unlinkSync(statePath(instId)) } catch {}`——物理除名。
5. `try { fs.rmSync(instanceDir(instId), { recursive: true, force: true }) } catch (e) { log("warn", ...) }`。
6. `try { fs.rmdirSync(artifactsDir) } catch {}`——**非递归**；非空即保留。

返回报告路径。调用点：`complete()` 与 `cancelInstance()` 里现有的两处 `archiveReport(instId, state, wf, "done" | "cancelled")` 换成 `destroyInstance(...)`，并**删掉紧随其前的 `writeState`**——报告是用内存里的 `state` 渲染的，落盘再删纯属浪费。

> **引用约定**：本任务书对**本仓库**只给符号名（函数/字段），不给行号——行号会被其它改动冲掉。仅「附：opencode 依据」表给行号，那是外部仓库、稳定。

**迟到的验证回调已被现有护栏挡住**：`launchVerification` 落判定前会 `readState(instId)`，实例目录没了即 `fresh === null` → 记 `verdict_discarded/instance_state_missing` 后 `return`，不写盘（在 `launchVerification` 内、`ownsRun` 判据那一段）。**不要动这条护栏**，它是本改造安全性的前提。

### 2. 报告归档失败时**不**销毁

opencode 在报告写失败后仍然销毁（审计轨迹随之丢失）。我们**不照抄这一处**：`archiveReport` 返回 `null` 时保留实例目录与 `state.json`，并 `notify` 告警「报告归档失败，实例未销毁」，记 `log("warn", "report_archive_failed", ...)`。理由：宁可留一个"已结束但未销毁"的可见残留（doctor 会报出来、可人工抢救），也不能静默丢掉全部轨迹。

### 3. 列表语义与历史入口

- `listInstances()` 只返回 `state.active === true` 的实例（照 opencode）。
- 新增 `listHistory()`：扫 `reportsDir` 下的 `*.md`，**解析报告头部已有的字段**（`- 实例：` / `- 状态：` / `- 任务：` / `- 开始：` / `- 结束：`）渲染历史条目，按 `- 结束：` 倒序。
  **不新增派生索引文件**（宪法 §10.4：状态不存派生量）。解析失败的报告**列出但标注「无法解析」**，不得静默丢弃。
- `listAll()` 分两节：「活跃实例」+「历史运行（已归档）」，历史节末尾给出 `reports/` 的相对路径。

**这一处是对 opencode 的改进**：它没有任何"列出已结束实例"的入口（`reports/` 只写不读），只靠完成消息告诉你路径——**消息丢了就再也找不回来**。dsh 是基准，这里要比它好。

### 4. 完成 / 取消消息与状态查询

- `complete()` / `cancelInstance()` 的 `notify` 文本带上精确相对路径：`` `.dsh/ralph-flow/reports/<instId>.md` ``。
- `nextActionHint` 的 `!s.active` 分支基本不可达（实例已销毁），保留但改为指向报告。
- `statusOf` 对已销毁实例：`readState` 为 `null` 且找不到实例时，若存在同名报告则指向它并说明「实例已结束并销毁，历史在报告里」；否则明说找不到。**不得**因为查不到就说"没有实例"——那会让用户以为跑丢了。

### 5. `doctor` 报实例目录异常

扫 `instances/` 下每个目录：

| 情况 | 告警 |
|---|---|
| 缺 `state.json` | `实例目录 instances/<id>/ 缺少 state.json —— 所有工具都看不到它。若是残留目录可直接删除` |
| `state.json` 损坏 | `实例 <id> 的 state.json 损坏（<原因>）—— 该实例无法恢复，确认无需保留后可删除整个目录` |
| `state.json` 存在但 `active=false` | `实例 <id> 已结束但目录未被销毁（可能是报告归档失败）。先确认报告是否已生成，再决定是否删除该目录` |

**只报不删。** 另可报一条**孤儿产出**：`artifacts/<name>/` 既无对应报告、也无对应实例目录（通常来自被手动清理的实例）——同样只报不删。

> **注意别把正常状态当异常**：改造后「报告存在 + 产出存在 + 实例目录不存在」正是终止后的**正常终态**，不是异常。只有"三者都对不上"才算异常。

### 5b. 存量数据不做自动迁移

改造前留下的已结束实例（`active=false` 但目录仍在，如当前工作区里的 `loop-mudrr90d-xd5d`）**不自动销毁**——自动删除违反「插件永不删除任何东西」。它们会由边界 5 的第三条告警报出来，由用户显式决定。也不要把它们写进测试夹具（测试一律自造 `mkdtemp` 工作区）。

### 6. 产出目录名可读化

- `makeArtifactsDirName(task, instId)`：任务摘要转 slug（空白转 `-`、去掉路径分隔符与 `..`），按**码点**（`Array.from`）截 30 个再 `trim` 掉首尾 `-`（先截后 trim：截断本身会暴露尾随 `-`；用 `slice()` 会切碎代理对，产出 U+FFFD 让提示词和真实目录名指向两个地方），拼 instId 尾段。
- 启动时把结果写进 `state.json` 的新字段 `artifacts_dir_name`。**它不是派生量**：将来子工作流会改写 `user_task`，名字事后无法重算（opencode 的原注释理由）。
- 读取时缺该字段 → 回退 `instId`（向后兼容老 `state.json`；老实例的产出目录名不变）。
- `artifactsRelDirOf` 随之改变，DO/CHECK 提示词注入的产出路径自动跟随。

**这里避开 opencode 的一个坑**：它把产出目录名存在实例目录内的独立文件（`artifacts-dir`），于是销毁时必须**先读出来**、多一个顺序依赖。写进 `state.json` 即可——报告在销毁前渲染，之后不再需要这个名字。

### 7. 本轮**不做**

- `execution.log` JSONL 与日志轮转：我们没有独立的审计日志文件，`state.history` 已全量进报告。
- `step-records.json`：我们用 `state.history`。
- 子工作流状态栈：本版本没有子工作流。
- **不引入任何自动清理**：除「终止时销毁自己的实例目录」与「删空产出目录」外，插件**永不删除任何东西**。历史报告与产出只能由用户显式删除。保留既有血泪规则：复现脚本不得动真实工作区。

## 验收标准

1. 完成 → 实例目录消失；报告存在且内容完整（全轨迹 + 全部判定）；产出目录与其中文件**一个字节不少**。
2. 取消 → 同上，报告状态为「取消」。
3. 产出为空 → `artifacts/<name>/` 一并消失（`rmdir` 成功）。
4. 产出非空 → `artifacts/<name>/` 与其中文件**原样保留**（逐字节比对）。
5. 终止后 `listInstances()` 不含该实例；「历史运行」节能列出它（实例 id、状态、任务、结束时间、报告路径）。
6. 完成消息与取消消息都含**精确相对路径**，且该路径文件存在（`fs.existsSync` 断言，不靠字符串匹配）。
7. **报告归档失败 → 不销毁**：构造写失败的 `reports/`（如用同名文件占位使其无法建目录），断言实例目录与 `state.json` **仍在**、索引仍含该条目、且发出了告警。
8. **幽灵防护的顺序**：注入让递归删除失败的 `fs` 替身，断言 `state.json` 已不在、`listInstances()` 与「历史运行」都不再显示该实例。
9. `doctor` 报出上述三类实例目录异常。
10. **迟到判定护栏未被破坏**：销毁后到达的验证回调不得写盘、不得复活实例目录（回调跑完后断言 `!fs.existsSync(instanceDir)`）。
11. 老 `state.json`（无 `artifacts_dir_name`）仍可读，产出目录回退为 `instId`。
12. 产出目录名：中文 / emoji 任务不被切碎（断言名字不含 U+FFFD、不含 `/`、`\`、`..`）。
13. `npm run typecheck`、`npm run build`，以及 `scripts/` 下**全部 8 个** `*.mjs` 脚本（`engine-test`、`hardening-test`、`verdict-integrity-test`、`native-delegation-test`、`visibility-test`、`alert-test`、`submit-flow-test`、`verify-activation`）全部通过，无失败、无回归。

**测试纪律**（既有陷阱表）：复现脚本一律 `mkdtempSync` 造工作区 + 隔离 `process.env.HOME`；**绝不** `rmSync` 真实工作区或真实 `.dsh/` 路径。

## 交付物

- 本仓库的实现、必要测试，以及同步后的文档（README 的报告与产出目录说明、design 的目录布局与生命周期章节、工作流创建指引里「产出目录」一段）。
- 一份简短变更说明：列出新增的公开行为（列表语义、历史入口、精确报告路径、doctor 检查）、销毁顺序及其理由、对 opencode 的两处有意偏离，以及验收命令的实际结果。

## 附：opencode 版依据（供实现者省去重新取证）

| 事实 | 位置 |
|---|---|
| `destroyInstance` 在 `completed` 与 `cancelled` 都调用 | `engine.ts:2046`、`tools.ts:656` |
| 先 `unlink(state.json)` 再递归删目录，注释原文：*"the instance is de-listed and can't act as a ghost"* | `engine.ts:808-813` |
| 销毁前把 `execution.log` 复制进 `reports/`，注释原文：*"without a copy the whole audit trail … dies with it"* | `engine.ts:769-782` |
| 产出目录名先读出再销毁（名字文件在实例目录里） | `engine.ts:806-807` |
| `rmdirSync(artifactsDir)` 非递归，注释原文：*"rmdir refuses non-empty dirs, so real deliverables always outlive the instance"* | `engine.ts:814-816` |
| 产出目录在 `instances/` **之外**，注释说明原因（实例目录会被销毁、产出要跨实例隔离） | `engine.ts:266-270` |
| `listInstances()` 过滤 `!state.active` | `engine.ts:640` |
| 完成消息给精确路径 `执行报告：<relative>` | `engine.ts:2049`、`tools.ts:658` |
| `doctor` 报实例目录异常（缺 / 损坏 state.json） | `engine.ts:1437-1447` |
| 产出目录名 = 任务 slug + instId 尾段（按码点截断） | `engine.ts:273-288` |
| 日志轮转 10MB × 3（我们本轮不做） | `engine.ts:1859-1878` |
| 插件加载时清理孤儿验证者会话（每进程每项目一次） | `index.ts:32-74` |
