# ralphflow v0 功能补全 — 完成记录与证据

> **任务**：按 `docs/v2/completion-brief.md` 补全已有功能并对齐 opencode 版。
> **对齐基准（只读参照，未移植代码）**：`/home/yj/.config/opencode/plugins/ralph-flow`（main = v2.11.0）。
> **实例**：`loop-muey7m8h-x1x0`（工作流 `loop`）。
> **判定标准**：写错了却没有任何信号 = 缺陷——要么硬错误，要么 doctor 告警。

---

## 0. 变更文件清单（本轮全部改动）

| 文件 | 改了什么 |
|---|---|
| `src/engine.ts` | §1.8 路径常量；§1.1 加载期硬校验；§1.2 `lintWorkflow`；§1.4 报告统计；§1.5 索引 GC；§1.7 产出目录 + DO 提示词 |
| `src/verify.ts` | §1.3 CHECK 提示词补 desc/交付物/产出目录（`buildCheckPrompt` 导出供测试断言） |
| `src/tools.ts` | §1.8 三处用户可见文案路径 |
| `src/create.ts` | §1.6 `CREATE_GUIDE` 与引擎实际行为逐条对齐 |
| `.gitignore` | `.dsh/ralph-flow/`（精确）+ 旧布局过渡行 |
| `README.md`、`docs/v2/design.md` | §1.8 路径与产出目录说明 |
| `scripts/*.mjs`（8 个） | dot-dir 路径、**HOME 隔离**（绝不读写真实 `~/.dsh`）、engine-test +33 项、native-delegation +6 项 |
| `docs/v2/evidence/summary-completion.md` | 本文件（新增，入库） |
| `.dsh/ralph-flow/artifacts/loop-muey7m8h-x1x0/summary.md` | loop 累积器摘要（**不入库**，产出目录生效后的正确落点） |

未改动：`workflows/loop.yaml`、`workflows/spec.yaml`（§1.7 明确不要求改）、命令面、工具面。

---

## 1. 逐条对齐：复现（改动前）→ 修复 → 验证（改动后）

**复现方法**：把 `git show HEAD:src/{engine,verify}.ts` 用本机 `tsc` 编译到临时目录，运行同一组探针；
只读旧代码，工作区用 `mkdtemp`，HOME 隔离。原始输出如下（`P*` = 探针编号）。

### §1.1 加载期校验（对齐 opencode 方言严格性）

| 探针 | 改动前（HEAD） | 改动后 |
|---|---|---|
| `check: true` | `def 有效 = true, problems = []`，`step.check = undefined`（静默当"无检查"） | 硬错误：``步骤 `a` 的 `check` 必须是字符串（当前是 boolean）…`` |
| `do` 缺失 | `def 有效 = true, problems = []` | 硬错误：``步骤 `a` 缺少 `do`…`` |
| `manual_step: [nope]` | `def 有效 = true`，`manual_step = ["nope"]`（审查门静默失效） | 硬错误：``manual_step 引用了不存在的步骤：`nope`…`` |
| `max_fail_count: 0` / `-2` / `1.5` | 全部 `def 有效 = true` | 硬错误：``…必须是 ≥1 的整数（当前 …）`` |
| `manual_step: a,b`（逗号字符串） | `manual_step = []`，警告"不是列表，已忽略" | 接受：`manual_step = ["a","b"]` |

实现：[engine.ts:412-424](src/engine.ts#L412-L424)（check/do/max_fail_count）、
[engine.ts:452-470](src/engine.ts#L452-L470)（manual_step 两种写法 + 未知引用硬错误）。

### §1.2 doctor 诊断覆盖

| 探针 | 改动前 | 改动后 |
|---|---|---|
| 无任何可达 `on_pass: done` | `warnings = []`（**旧 doctor 报 ✅，运行时无限循环**） | 告警："没有任何可达步骤的 `on_pass` 为 `done`，工作流永远无法正常完成" |
| 不可达步骤 | `warnings = []` | 告警："步骤 `orphan` …不可达，永远不会执行" |
| `{{output_dir}}` | `warnings = []`（原样进入提示词） | 告警："`do` 含模板变量 {{output_dir}}，引擎不会解析" |
| 非 manual 且无 `check` | `warnings = []` | 告警："未配置对抗检查（无 `check`）…" |

实现：[engine.ts:176-229](src/engine.ts#L176-L229) `lintWorkflow`，在
[engine.ts:470](src/engine.ts#L470) 汇入 `loadWorkflow().warnings`（doctor 与 start 都会展示）。
可达性按引擎真实推进规则计算：`on_pass` 缺省 = 顺序下一步、`on_fail` 缺省 = 自身
（与 `nextStepId`/`failStepId` 同规则），因此**不误报**。

**不误伤证据**：`engine-test` 断言「内置 loop 照常加载且无 lint 误报」「内置 spec 照常加载且无 lint 误报」，
以及既有 8 个脚本全绿（含 spec 审查门、on_fail 跨步回退、成环 on_fail 等夹具）。

### §1.3 验证者提示词

| 探针 | 改动前 | 改动后 |
|---|---|---|
| CHECK 含步骤 `desc` | `false` | `true` |
| CHECK 含「交付物」（`output`） | `false` | `true` |
| CHECK 含「产出目录」 | `false` | `true` |

改动前旧 prompt 只有 `## 检查依据`，验证者不知道本步承诺交付什么。实现：
[verify.ts:82-112](src/verify.ts#L82-L112) 新增「## 本步上下文」（步骤 id/desc/do/input/**交付物**/**产出目录**）
与取证要求「产出目录也在这个工作区内，用上面的相对路径即可读到」。`buildCheckPrompt` 已导出供测试断言。

### §1.4 报告（每步耗时 / 重试次数）

| 探针 | 改动前 | 改动后 |
|---|---|---|
| 报告含「总耗时」 | `false` | `true` |
| 报告含「步骤耗时与重试」 | `false` | `true` |
| 报告含「产出目录」 | `false` | `true` |

实现：[engine.ts:877-926](src/engine.ts#L877-L926) `stepStats` + `formatDuration`
（[engine.ts:236-244](src/engine.ts#L236-L244)）。**不新增落盘字段**：耗时从 `history.ts` 派生，
重试次数取 `max(fail_counts[step], 该步 verdict_failed 条数)`。

> 关键坑：`clearFailCount` 在通过时会把该步 `fail_counts` 清零、`continue` 恢复暂停时也清零，
> 所以只看 `fail_counts` 会把「先失败几次再通过」记成 0 轮；必须同时从 history 兜底。
> 断言：engine-test「报告含重试次数（fail_counts 派生）」（一个失败→返工→通过的 loop）。

### §1.5 实例索引 GC

| 探针 | 改动前 | 改动后 |
|---|---|---|
| 外部删除实例目录后 `restore()` | 悬挂条目**仍在**索引 | 悬挂条目被清出索引（且不动正常条目） |

实现：[engine.ts:1382-1410](src/engine.ts#L1382-L1410)。**只清索引条目，绝不删任何目录**
（硬性血泪规则：复现脚本不得动真实工作区；GC 只 `delete registry[id]` + 原子写索引）。
断言：engine-test「restore() 清掉悬挂条目」「restore() 不动正常条目」。

### §1.6 CREATE_GUIDE 对齐

`src/create.ts` 整篇重写为与引擎逐条一致：
- 路径全部改 `.dsh/ralph-flow/…`；
- 快捷命令写明 **`/ralphflow-<工作流名>`**（旧的"`/<名字>`"是错的）；
- 硬规则清单如实列出（`do` 必填、`check` 非字符串拒绝、`max_fail_count` ≥1 整数、引用校验、未知 `manual_step` 拒绝）；
- 新增 doctor 告警清单（不可达 / 无 done / `{{...}}` / 无 check）；
- `check` 不再标"必填"而是"非 manual_step 请务必填（缺则告警，运行时按通用兜底配方，**不会跳过验证**）"；
- `max_fail_count` 语义写明（缺失用默认 3；0/负数/小数硬错误）；
- 产出目录一节说明"写裸文件名即可，不需要模板记号"；
- `input`/`output` 从"v0 不校验"改为"进 DO/CHECK 提示词"。

### §1.7 产出目录

| 探针 | 改动前 | 改动后 |
|---|---|---|
| `start()` 后 `.dsh/ralph-flow/artifacts` 存在 | `false` | `true` |
| DO 提示词含「## 产出目录」 | `false` | `true` |

- 路径：`<workspace>/.dsh/ralph-flow/artifacts/<instId>/`，实例启动时建好
  （[engine.ts:990-991](src/engine.ts#L990-L991)），完成后**保留**（`complete`/`cancel` 都不删）。
- DO/CHECK 各注入一行**工作区相对路径**：DO [engine.ts:670-682](src/engine.ts#L670-L682)，
  CHECK [verify.ts:93](src/verify.ts#L93)；引擎把 `artifactsRelDir` 经 `VerifyRequest` 传给验证者
  （[engine.ts:160-166](src/engine.ts#L160-L166)、[engine.ts:749](src/engine.ts#L749)）。
- **不做** `{{artifacts_dir}}` 模板记号（任务书明确定案）。
- 内置 `loop.yaml`/`spec.yaml` **未改一字**：裸文件名 `summary.md` 由提示词归位到产出目录。

**验证者可读性证据**（dsh 特性表要求）：native-delegation-test D1 用**真实 `runVerifier`** 捕获
CHECK 提示词，提取其中的相对路径 `x.dsh/ralph-flow/artifacts/<id>`，在工作区内写出 `summary.md`
再读回 → 断言「验证者按该相对路径读得到产出（继承会话工作区，无需额外权限）」。
这对应任务书 §3 的结论：验证者继承父会话工作区，所以产出目录**必须在工作区内**。

### §1.8 运行时目录改 dot-dir

| 探针 | 改动前 | 改动后 |
|---|---|---|
| `start()` 后旧 `ralph-flow/` 被创建 | `true` | `false` |
| 新 `.dsh/ralph-flow/…` 布局 | `false` | `true` |

- `RALPH_FLOW_DIR = ".dsh/ralph-flow"`（[engine.ts:23](src/engine.ts#L23)）；
  新增 `RALPH_FLOW_NAME = "ralph-flow"` 用于全局命名空间 `~/.dsh/ralph-flow/workflows`
  （[engine.ts:25](src/engine.ts#L25)、[engine.ts:252](src/engine.ts#L252)）——
  两个作用域的插件命名空间都叫 `ralph-flow`，路径全由常量派生。
- 用户可见文案 6 处：`engine.ts` 完成播报 + `nextActionHint`、`tools.ts:286/299/309`。
- `.gitignore`：`.dsh/ralph-flow/`（**精确**，不忽略整个 `.dsh/`）+ 旧布局过渡行 `/ralph-flow/`。
- 文档：README「工作区结构」+ design §9（并补产出目录与 dot-dir 理由）。

---

## 2. 验收标准逐条自查（任务书 §4）

1. **§1 每条都有自己的复现证据 + 修复后验证** ✅ —— 见 §1 的 P1–P10 前后对照；复现脚本用
   `git show HEAD:src/*.ts` 编译出的旧引擎在临时工作区跑，输出已逐条抄录。
2. **静默路径消失** ✅ —— 写错的 YAML 要么硬错误（§1.1），要么 doctor 告警（§1.2）；
   engine-test 11/12 两组断言逐项覆盖（共 12 条）。
3. **不误伤** ✅ —— 内置 `loop`/`spec` 加载且 **warnings 长度为 0**（engine-test 显式断言）；
   既有夹具（spec 审查门、on_fail 跨步回退、成环 on_fail、gap/twostep/one/maxfail）全部照常加载。
4. **8 个测试脚本全绿 + APPLY_OK + tsc 干净** ✅：
   ```
   engine-test          57 passed, 0 failed
   hardening-test       29 passed, 0 failed
   verdict-integrity    39 passed, 0 failed
   native-delegation    22 passed, 0 failed
   alert-test           16 passed, 0 failed
   submit-flow-test     14 passed, 0 failed
   visibility-test      21 passed, 0 failed
   verify-activation    APPLY_OK
   npx tsc --noEmit     干净
   ```
   每条修复都配了断言（相比原 24 项，engine-test +33、native-delegation +6）。
5. **CREATE_GUIDE 与引擎逐条一致** ✅ —— 见 §1.6。
6. **边界未破** ✅ —— 见 §3。
7. **产出目录生效** ✅ —— DO/CHECK 提示词都含「产出目录」行；验证者按该相对路径读得到产出
   （真实 `runVerifier` 捕获 + 读回断言）；本轮的 `summary.md` 落在
   `.dsh/ralph-flow/artifacts/loop-muey7m8h-x1x0/summary.md`，**仓库根没有 `summary.md`**。
8. **布局迁移完成** ✅（含一条刻意的过渡残留，见 §5）——
   真实工作区 `<workspace>/.dsh/ralph-flow/{workflows,instances,reports,artifacts}` 齐全；
   新引擎**不再创建**旧 `ralph-flow/`（探针 P8 证明）；`git status` 无未跟踪噪声
   （`.dsh/ralph-flow/` 已精确忽略）；README / design §9 / `CREATE_GUIDE` 路径全部更新。
9. **交付摘要入库** ✅ —— 本文件即 `docs/v2/evidence/summary-completion.md`；
   loop 自己的累积器写在产出目录（`summary.md`，**不入库**），仓库根不再有 `summary.md`。

---

## 3. 边界自查（任务书 §2 禁止项逐条）

| 禁止项 | 本轮 | 说明 |
|---|---|---|
| `check_voting` / `reset` / `rewind` / 子工作流 | 未做 | 仅保留"警告忽略"/"只声明不实现"语义 |
| UI / 通知 / 沙箱 | 未做 | 无客户端、无传输、无沙箱改动 |
| 新增命令或模型可见工具 | **未新增** | 命令面与工具面逐字未变（只有文案里的路径字符串改动） |
| 自建超时 / 看门狗 / 竞速 | 未做 | 委派仍只传 `signal` 取消句柄；native-delegation D1 断言无 `timeoutMs/deadline/timeout/controller` |
| 为环境异常加代码 | 未做 | 验证者 prompt 未加任何环境异常条款 |
| 执行日志（`execution.log` JSONL） | 未做 | 沿用 `state.json.history` + 归档报告 |
| `extra_dirs` 项目外源材料 | 未做 | dsh 无对应权限模型 |
| 移植 opencode 代码 | 未做 | 只读参照语义（可达性 lint 思路、产出目录形态），实现全部按 dsh 重写 |

**未触碰的边界旁证**：`src/tools.ts` 的工具表与命令表零新增/零删除；`workflows/*.yaml` 未改。

---

## 4. 宪法自查（design §10 十二条）

1. **T1 裁判权在独立会话** —— 未改委派结构；主会话仍无任何影响判定内容/产生的路径。
2. **T2 推进权在机械程序** —— 推进逻辑未改；新增的都是"加载期拒绝"与"提示词/报告"层面。
3. **引擎是唯一写入者** —— 新逻辑只在引擎内；测试的 `restore()` GC 也只操作注册表。
4. **状态不存派生量** —— 耗时/重试**全部从 `history`/`fail_counts` 派生**，`state.json` 字段零新增；
   `fail_count` 仍是读取时派生、落盘时剔除。
5. **判定 fail-closed** —— `parseVerdict`/`normalizeVerdict` 未改；`buildCheckPrompt` 只加上下文。
6. **永不写自定义会话事件帧** —— 未触碰事件帧；仍只 `agent.steer(createUserMessage(...))`。
7. **主会话永不委派验证者** —— 委派仍只在 `launchVerification`（引擎）发出。
8. **不移植引擎** —— 见上。
9. **客户端禁止先于内核** —— 未碰客户端。
10. **不引入 doctor/reset 类修复命令的实现** —— 本轮**没有新增**命令；`doctor` 的存在是本轮之前
    已定案的既有实现（任务书 §1.2 明确要求增强它），`reset`/`rewind` 仍只声明不实现。
11. **每个功能入场合规** —— 本轮是任务书逐条验收的补全，非新功能扩张；无新功能越过 §11 门槛。
12. **不支持的方言键 = 警告忽略** —— `check_voting`/`timeout_ms`/未知键语义未变。

---

## 5. 需要作者重启 / 后续动作

改动只在 `npm run build`（已完成）后由作者重启 GUI 生效（宿主持有模块缓存，硬性协议：**不在验证进行中重启**）。

1. **重启后验证**：跑一次真实 `loop`/`spec`，确认
   - `summary.md` 落在 `.dsh/ralph-flow/artifacts/<instId>/`（不再落仓库根）；
   - `/ralphflow-doctor` 对内置 loop/spec 仍全 ✅；
   - 故意写坏一份 YAML（`check: true` / 未知 `manual_step`）→ 启动即被拒并说人话。
2. **清理旧布局过渡残留**（本轮刻意保留，见下）：作者重启后
   ```bash
   rm -rf /home/yj/ralph-flow-dsh/ralph-flow
   # 并从 .gitignore 删除 "/ralph-flow/" 过渡行
   ```
3. **`lib/` 已重新构建**（`npm run build` 成功，`tsc --noEmit` 干净）。

### 为什么旧 `ralph-flow/` 目录还剩一点东西（诚实说明）

本轮**在飞实例**（`loop-muey7m8h-x1x0`）的 state 在验证期间必须可读：运行中的宿主进程持有
**改动前**的模块缓存，仍只认旧路径 `<workspace>/ralph-flow/instances/<id>/state.json`；
若在验证进行中把它移走/重启，`launchVerification` 的归属校验会把判定判为 `run_superseded`
丢弃并悬空实例——这正是 `hardening-brief.md` §4.6 两次强调、并用实例 `loop-mudrr90d-xd5d`
证明过的陷阱。因此本轮做了**部分迁移**：

- 已迁入新布局：上一个已结束实例 `loop-mudrr90d-xd5d` 及其报告；
- 旧目录只剩**本轮在飞实例**的 state（+ 自动生成的内置工作流副本），作者重启后即可整体删除；
- `.gitignore` 因此暂时同时有 `.dsh/ralph-flow/`（新，精确）与 `/ralph-flow/`（旧，带注释的过渡行）。

这不是"旧布局仍在被使用"：探针 P8 已证明新引擎**不再创建** `ralph-flow/`；
残留是运行中宿主进程持有旧代码导致的一次性产物。

---

## 6. 结论

任务书 §1.1–§1.8 全部落地，每条都有改动前复现 + 改动后断言；§2 边界与 design §10 宪法逐条未破；
8 个测试脚本全绿 + `APPLY_OK` + `tsc --noEmit` 干净；唯一遗留是"在飞实例的旧路径 state"
与随之而来的重启后清理动作（已在 §5 写明原因与命令）。
