# 发现面锚定修复任务书

> **读者**：`ralph-flow-dsh` 的实现者。读完后应能仅在本仓库完成改造，并用下列验收项判断是否交付。
>
> **状态**：待实现。这是**缺陷修复**，不是新功能——不要顺手加特性。
>
> **前置定案（作者）**：实例、产出、报告落在**发起会话的工作区**，这是对的、不改。错的是**一半读取面仍锚在 `engine.projectDir`**。

## 缺陷：写入看会话工作区，读取看进程 cwd

`dsh web` 是**一个进程服务多个会话**。插件在进程启动时创建引擎，`resolveWorkspace()` = `process.cwd()`；而实例资产落在 `workspaceOfSession()` = 会话 header 的 `cwd`。真实 GUI 里这两者**必然不同**——作者实测：`dsh web` 的 cwd = `/home/yj`，会话工作区 = `/home/yj/ralph-flow-dsh`。

同一份数据，写入用 A、读取用 B，产生三个根因、四个症状（作者用独立探针在 `projectDir ≠ 工作区` 下逐条实测）：

| 症状 | 根因位置 |
|---|---|
| **① `/ralphflow-list` 的「历史运行」永远 0 条**：工作区里躺着 6 份归档报告，一份也列不出来 | `listHistory()` 只扫 `reportsDir`（`projectDir` 派生） |
| **② `/ralphflow-doctor` 报「（暂无实例）」**：工作区里躺着实例目录，诊断说没有 | `knownWorkspaces()` = `projectDir ∪ registry 值`；销毁时 registry 条目被删 → 该工作区**整个从发现范围消失** |
| **③ `CREATE_GUIDE` 教模型把自定义工作流写到 `<workspace>/.dsh/ralph-flow/workflows/`，启动时却报「未找到工作流」** | `knownWorkflowDirs()` = `projectDir ∪ 全局 ∪ registry 值`，同样漏掉会话工作区 |
| **③b 同一原因**：`ralphflow_list` 的「可用工作流」节也列不出它 | 同上 |

**④ 为什么 456 条断言一条都没抓住**：所有既有脚本都用**同一个 `mkdtemp` 目录**同时充当 `createEngine(dir)` 的 projectDir 与 `start(..., workspace = dir)` 的工作区。两者相等时缺陷不可见。

> **本任务的核心测试纪律由此而来：新增用例必须让 `projectDir ≠ 会话工作区`（两个不同的 `mkdtempSync` 目录）。做不到这一点的用例等于没测。**

## 目标

让**所有读取面与写入面锚定同一个工作区**：写入用会话工作区，读取也必须能看见会话工作区。

不改数据布局、不改生命周期、不改裁判权语义——只把「往哪儿写」和「从哪儿读」对齐。

## 实现边界

### 1. 零新持久化状态（宪法 §10.4）

**不得**新增索引文件，**不得**往 `InstanceState` 加字段，**不得**新增「已见工作区」这类落盘清单。

工作区来源是**宿主已经知道的事实**：工具层已有 `deps.workspaceOfSession(sessionId)`（`startHandler` 就在用，见 `src/tools.ts:71`）。把它传给其余读取面即可。

### 2. 引擎函数接受工作区参数，而不是自己猜

`listAll` / `listHistory` / `diagnose` / `loadWorkflow` / `listWorkflows` 增加可选的 `workspace` 参数（缺省仍是 `projectDir`，保持单根模式与既有测试可用）。

`src/tools.ts` 里所有**面向会话**的 handler（`list` / `doctor` / `status` / `continue` / `cancel` / `submit`）都要把 `deps.workspaceOfSession?.(sessionId)` 传下去——它们现在都拿到了 `agent`，取 `sessionId` 的辅助函数 `sessionIdOf(agent)` 已存在。

`loadWorkflow` 的内部调用方（`destroyInstance` 渲染报告、`advance` 注入下一步提示词等）此时**已经知道实例的工作区**（`workspaceOf(instId)`，且销毁路径已在除名之前把它固定下来）——把那个值传进去，不要回落。

> ⚠️ **这是本任务最大的回归风险**：`loadWorkflow` 有 7 处内部调用（`engine.ts` 的 529/1370/1437/1501/1616/1670/1825）。**漏传一个**，该处就会在工作流加载上回落或落空，表现为**跑到一半莫名其妙停摆**（`def` 为 `null`），而不是报错。改签名时逐个过一遍，并靠验收 6 的逐字节回归探针兜住。

### 3. `/ralphflow-list` 的作用域

- **「历史运行」= 当前会话的工作区**（opencode 是 per-project 的，这也符合直觉：用户问「这个项目的运行」）。输出里点明作用域（例如「本工作区」），不要让人以为它是全局的。
- **「活跃实例」保持 registry 全域**（跨工作区）——`/ralphflow-continue <实例ID>` 的「接管无属主实例」依赖它，不要收窄。
- **「可用工作流」必须包含当前会话工作区**的自定义工作流。

### 4. `/ralphflow-doctor` 的作用域要**更宽**，不是更窄

doctor 是诊断，职责是**捞出残留**。它的扫描范围 = 当前会话工作区 ∪ `projectDir` ∪ registry 值。这样上面症状 ② 那个「registry 除名后工作区消失」的洞就被当前会话工作区补上了。

**不做**自动迁移、不做跨工作区报告聚合。

### 5. 不得改动的回归基线

以下行为**逐字不得改变**（它们上一轮刚验收）：

- **无 `check` 跳过对抗性验证**：判据仍是 `stepHasCheck(step)`（纯读 `StepDef`），跳过时仍写 `check_skipped`、仍只写「跳过对抗性验证」、绝不写「检查通过」；`buildCheckPrompt` 对无 `check` 的步骤仍明确抛错。
- **有 `check` 的行为**（独立验证、审查门、失败返工）与改造前逐字相同。
- **销毁七步**：路径在除名之前解析并固定、失败留日志、销毁后复查、`instanceDirRemoved` 决定播报是否说「已销毁」。
- **不变量**：报告归档失败时不销毁实例目录；产出目录只删空的。

### 6. 文档同步

- `README.md` 现有那句「实例与报告都落在**发起会话的工作区**，与引擎进程的 cwd 无关」**今天只对了一半**——写入是对的，读取不是。改到与实现一致。
- `docs/v2/design.md` 的相应章节同步。
- 若 `CREATE_GUIDE`（`src/create.ts`）里「写到 `<workspace>/.dsh/ralph-flow/workflows/`」的说明在修复后仍然成立，保留原样；若你发现修复后仍有场景加载不到，如实说明并改文档，不要粉饰。

## 验收标准

1. **`projectDir ≠ 会话工作区` 时，`/ralphflow-list` 的「历史运行」能列出该工作区刚跑完的运行**（判据：归档报告确实在 `<workspace>/.dsh/ralph-flow/reports/`，列表条数 ≥ 1 且 id 对得上）。
2. **同形态下 `/ralphflow-doctor` 能报出该工作区的实例目录异常**（含「缺 state.json 的残留」这一形态；用一个手工造出来的残缺实例目录做用例）。
3. **同形态下 `ralphflow_start` 能加载写到会话工作区 `.dsh/ralph-flow/workflows/` 的自定义工作流**，且 `ralphflow_list` 的「可用工作流」节列出它。
4. **零新持久化状态**：`git diff` 里没有新文件、没有 `InstanceState` 新字段；工作区只来自 `workspaceOfSession` / 已存在的 registry / 显式参数。
5. **负对照**：把修复还原（只还原锚定逻辑）后，新增用例必须**失败**——用例真的在测这件事。附上还原后的失败输出。
6. **回归基线不动**：`npm run typecheck` exit 0；`scripts/` 下全部 `*.mjs` 全绿，且**有 `check` 的回归探针与 `73aded3` 基线逐字节相同**（沿用既有 `regression-probe.mjs` 的做法：跑 loop 全流程 + spec 四链 + lint，比对 md5）。
7. **诚实**：若某条验收你做不到或有例外，如实写进 `change-note.md` 并说明影响面——**不要**把它藏进"已实现"里。作者会独立复核。

## 交付物

- 实现（`src/`）+ 测试（`scripts/`）+ 同步文档（`README.md`、`docs/v2/design.md`）。
- 变更说明写到产出目录的 `change-note.md`：改了什么、每条验收怎么取证的、负对照输出、如实披露的例外。
- 必须实跑并附**真实输出**（不是"应该能过"）：`npm run typecheck`、`npm run build`、`scripts/` 下全部 `*.mjs`。

**测试纪律**：复现与测试一律 `mkdtempSync` 造工作区 + 隔离 `process.env.HOME`；**绝不** `rmSync` 真实工作区或真实 `.dsh/` 路径。

## 附：作者独立探针（可直接复用）

作者用下面这份探针在 `projectDir ≠ 工作区` 下复现了全部症状（当前代码：`16 passed, 4 failed`，4 条失败恰好对应上表症状 ①②③③b）：

```js
// /tmp/rf-independent-probe2.mjs —— 关键形态：两个不同的 mkdtemp 目录
const ENGINE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "rfprobe-engine-")); // dsh 进程 cwd 的替身
const WS         = fs.mkdtempSync(path.join(os.tmpdir(), "rfprobe-ws-"));     // 会话工作区
const engine = createEngine(ENGINE_DIR, ports);

engine.ensureLayout(ENGINE_DIR);
engine.ensureLayout(WS);
// 只写到会话工作区（CREATE_GUIDE 让模型写的位置）
fs.writeFileSync(path.join(WS, ".dsh/ralph-flow/workflows/mywf.yaml"), YAML, "utf-8");

// ① 跑完一个实例后（报告确实落在 WS/.dsh/ralph-flow/reports/、实例目录确实已销毁）
engine.listHistory().length            // 期望 ≥1，实测 0（引擎扫的是 ENGINE_DIR/reports）
// ②
engine.diagnose().text.includes("暂无实例")   // 期望 false，实测 true
// ③ / ③b
engine.loadWorkflow("mywf").def        // 期望非空，实测 null（"未找到工作流"）
engine.listWorkflows().map(w => w.name) // 期望含 "mywf"，实测 ["loop","nochk","spec"]
```

真实 GUI 形态（作者实测，可直接对照）：

```
$ readlink /proc/<dsh web pid>/cwd
/home/yj                                    # ← engine.projectDir
$ ls .dsh/ralph-flow/reports/               # 会话工作区 = /home/yj/ralph-flow-dsh
loop-muleot6s-rrj4.md  loop-mulh5tlx-0h0b.md  …（6 份）
$ 实时 /ralphflow-list → 历史运行（已归档）（0 个）
$ 实时 /ralphflow-doctor → 实例诊断（暂无实例）
```
