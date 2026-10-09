# 回归修复：过程文档漏进工作目录（产出目录 vs 交付物）

> 本文是**入库证据**（显式路径；与 loop 自己的累积器 `summary.md` 区分——后者落产出目录、不入库）。
> 对应任务：修「ralphflow 的过程文档漏进工作目录」的回归。工作区
> `/home/yj/ralph-flow-dsh`，日期 2026-10-09。

## 1. 病根：矛盾不在任何一个文件里，在**拼装之后**

真实 loop 跑了 34 轮，仓库根长期维护一份 `summary.md` 并被 git 跟踪（第 1 轮提交 `0f2dadf` 起），
而同实例其余 20 多份过程文档全部正确落在产出目录 —— **唯一漏出来的，就是被写进步骤 `output`
的那一个**。

修复前，把**真实投给模型的 DO 提示词**整篇拼出来（探针捕获，非逐文件阅读），矛盾就在相邻两节：

```
## 产出目录
`.dsh/ralph-flow/artifacts/给一个玩具项目加一句注释-w9a2/` —— 本步的文档产出（清单、方案、报告、
摘要等）统一放这里：`do`/`output` 里只写文件名的（如 `summary.md`）落到这个目录，写了其它路径的
按写的路径来。

## 交付物
实现的代码/文件 + summary.md（执行摘要）
```

- `## 产出目录` 那句（`src/engine.ts`）单独看没错：裸文件名 → 产出目录。
- `## 交付物` 那句来自 `workflows/loop.yaml` 的 `output`（修复前为
  `实现的代码/文件 + summary.md（执行摘要）`，`git show HEAD:workflows/loop.yaml` 可复核），
  单独看也没错。
- **两句拼到一起才打架**：`## 交付物` 把一份过程文档列成与代码并列的交付物，模型解不掉这个矛盾，
  就两边都写、并行维护、开始漂移（产出目录那份 33 轮、仓库那份 32 轮）。
- 上一轮按 `writing-for-agents` 打磨（`cc36020`，4/4 通过）**改的就是这一行**，矛盾照样漏过 ——
  因为它按文件审；而同一轮它抓到过一处同类矛盾（审查门的 DO 与交卷提醒自相矛盾），那两句恰好在
  同一段里相邻。
- 验证者也被带偏过：RA2 有一轮取证原文是「产出目录 `summary.md` 与仓库 `summary.md` 逐字节相同」
  —— 它把副本判成了正确。

意图早已定死：`docs/custom-workflows.md`「…也不进仓库根」；
`docs/v2/evidence/summary-completion.md:197`「loop 自己的累积器写在产出目录（`summary.md`，**不入库**），
仓库根不再有 `summary.md`」。

## 2. 修复

| 落点 | 改动 |
|---|---|
| `src/engine.ts:2277-2293` | DO 提示词「## 产出目录」一节改写为**落点边界**（过程文档 vs 产物；裸文件名→产出目录；明确路径→按写的路径；工作目录只放产物、同一份只写一处不留副本）；`## 交付物` 之后补一句「落点由『产出目录』一节决定」——**跨节矛盾在拼装层被消解** |
| `src/verify.ts:156` | CHECK 提示词同样写明边界，并明说「工作目录里的副本是落点正确、而是落点错误：不要把副本判成满足」；`交付物` 一项点明「落点看下一行『产出目录』」 |
| `workflows/loop.yaml:31-35` | 「交付物」不再列 `summary.md`：`output: 实现的代码/文件`；`do` 里「每轮把本轮摘要**追加**到 `summary.md`」原样保留，并补一句它是过程文档、落产出目录 |
| `src/create.ts:67-68,122` | CREATE_GUIDE 的规则拷贝同步；示例 `output` 也不再列 `summary.md` |
| `docs/custom-workflows.md:105,113` | 规则拷贝同步；「交付物目录」这一竞争叫法改回「产出目录」 |

修复后的**整篇拼装 DO 提示词**（实际捕获，节选）：

```
## 产出目录
`.dsh/ralph-flow/artifacts/给一个玩具项目加一句注释-4qz4/` —— 本步的**过程文档**（清单、方案、
报告、摘要、草稿等）只落这里：`do`/`output` 里写**裸文件名**的（如 `summary.md`）落到这个目录；
写了**明确路径**的（如 `docs/x.md`）按写的路径来。

工作目录只放本步的**产物**（代码、资源、可执行文件）；过程文档除「写了明确路径」外不进工作目录，
同一份过程文档只写一处、不要留副本（例如产出目录已有 `summary.md`、工作目录根又出现一份，那是
落点错误）。

## 交付物
实现的代码/文件

（这一节说的是本步**产出什么**；它们落在**哪里**由「产出目录」一节决定 —— 过程文档写裸文件名
就落产出目录，不因为列在这一节就改写进工作目录。）
```

关于「过程文档落在哪」，整篇只有 `## 产出目录` 一节给出落点说法；`## 交付物` 只说「产出什么」。
`scripts/artifact-placement-test.mjs` 用「位置指令句只在产出目录一节出现一次」把这条钉死。

## 3. 三层现状（如实区分，不拿低层冒充高层）

### 机械层 ✅

- DO 与 CHECK 提示词都写明落点边界（`src/engine.ts:2279`、`src/verify.ts:156`）。
- `do`/`output` 裸文件名归位产出目录、明确路径按写的路径来（提示词明写；引擎不改写作者写的 `output`）。
- `loop` 这一步的「交付物」不再把 `summary.md` 列为交付物（`workflows/loop.yaml:35`）。

### 拼装后自洽 ✅

- 用探针把**真实投给模型的整篇 DO 提示词**拼出来读（不是逐个源文件读）：`assembled-do-prompt.md`、
  `assembled-check-prompts.md`（loop 4 票）都在本实例产出目录里。
- 机械断言见 §4：按 `## ` 分节核对，覆盖「交付物一节不含过程文档名」「位置指令句唯一」「自定义
  `output` 列了过程文档名时仍被兜底」。
- 复现：`node scripts/artifact-placement-test.mjs` → 24 passed, 0 failed。

### 行为层（真正的判据）❌ 本轮未做

**为什么没做（诚实说明）**：

1. 本步是 ralphflow 的 DO 执行者，拿不到可独立驱动的真实模型去跑一次真实的、独立的 `loop`
   （同会话再起实例会与当前实例冲突；验证者会话由引擎在 CHECK 阶段另行委派）。
2. 即便能起，**当前宿主进程持有改动前的模块**：本实例的步骤定义是修复前加载的，正在进行的
   本轮（以及可能的返工轮）仍由旧代码拼提示词。这是与上一轮相同的模块缓存约束
   （见 `docs/v2/evidence/summary-completion.md` §5）。

因此本轮**只做到前两层**，不声称端到端已通过。

**作者复核步骤（具体、可照做）**：

1. 重启 DSH GUI（让宿主重新加载 `lib/` 与 `workflows/loop.yaml`；`npm run build` 已完成）。
2. 在一个干净工作区跑一次真实 `loop`，任务用短任务即可，至少完成一轮**交卷 + 验证**：
   ```
   /ralphflow-loop 在项目根加一句 README 注释
   ```
3. 跑完（至少一轮验证通过）后核对落点：
   ```
   test ! -e <workspace>/summary.md && echo "OK: 工作目录根无 summary.md"
   ls <workspace>/.dsh/ralph-flow/artifacts/*/summary.md && echo "OK: 产出目录里有"
   ```
4. 可选加强：在 `<workspace>/.dsh/ralph-flow/instances/<id>/execution.log` 里核对发给验证者的
   CHECK 提示词含「过程文档」「工作目录只放本步的**产物**」「不要把副本判成满足」。
5. 若第 3 步在仓库根又出现 `summary.md`，说明行为层仍未达成 —— 把该实例的
   `assembled DO/CHECK 提示词`与验证者取证原文留存后再改。

## 4. 回归断言（`scripts/artifact-placement-test.mjs`，24 条）

- A 病根：`loop` 的 `output` 不含 `summary.md`；`do` 仍保留「追加到 `summary.md`」。
- B 拼装自洽：DO 提示词按 `## ` 分节 —— 产出目录一节含过程文档/产物边界、裸文件名/明确路径规则、
  禁止副本；`## 交付物` 一节不含 `summary.md` 且点明落点由产出目录决定；旧矛盾句
  `… + summary.md（执行摘要）` 不再出现；位置指令句只在产出目录一节出现一次。
- C 通用兜底：自定义工作流 `output` 列了过程文档名时，`## 交付物` 仍附「落点由产出目录决定」，
  且不擅自改写作者写的 `output`。
- D CHECK：本步上下文含落点边界、裸文件名/明确路径规则、「副本是落点错误、不要把副本判成满足」。
- E 三份拷贝：DO 提示词 / `CREATE_GUIDE` / `docs/custom-workflows.md` 含同一批锚点，不分叉。

另在 `scripts/engine-test.mjs`（原只断言「DO 提示词含 `## 产出目录`」）与
`scripts/native-delegation-test.mjs`（真实 `runVerifier` 捕获 CHECK 提示词）升级为**内容**断言。

## 5. 边界未动自查

- 判定路径零改动：`parseVerdict` / `normalizeVerdict` / `applyRoundOutcome` / 投票聚合与失败返工
  语义未触碰（`git diff` 里无这些符号）。
- `check` / `check_voting` 语义不变；loop 的累积器要求保留。
- `产出目录` 这个名字、路径形态、`makeArtifactsDirName` 目录名算法零改动。
- 未新增命令、未新增模型可见工具、未新增实例状态字段。
- `do`/`output` 里写了明确路径的仍按写的路径来（提示词明写；引擎不代写路径）。
- 验证：`npm run verify` 全部 21 支套件通过。
