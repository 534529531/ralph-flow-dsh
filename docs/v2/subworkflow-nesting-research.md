# 子工作流 / 可复用子流程：业界六系统横向调研

方法：结论均来自一手来源（官方文档、OMG 规范 PDF、官方仓库源码/Issue/PR），编号见文末「一手来源」。带**【推断】**的是我的判断、来源未明说；查不到的写 **[NOT FOUND]**。本次环境无搜索引擎，全部来源为直连官方站点/仓库抓取。日期：2026-10-02。

## 一、对照表

| 系统 | 怎么表示嵌套 | 失败 / 重试预算归谁 | 深度限制与环检测 |
|---|---|---|---|
| **Argo Workflows** | **同一实例内展开**：`steps`/`dag` 中用 `templateRef` 调另一个模板，调用点成为父 Workflow CR node 树里的一个节点（递归示例的 `argo get` 输出直接显示缩进的节点树）[1][2][4]。跨实例另有官方模式 "Workflow of Workflows"：resource 模板提交一个新 Workflow CR，靠 `successCondition: status.phase == Succeeded` 轮询 [3] | 归**被调用模板**：`retryStrategy` 配在模板上；`spec.retryStrategy` 的 Go 注释是 "RetryStrategy for all templates in the workflow" [5][2]。子模板自己重试到上限，才把失败交给父节点【推断：由 node 树归属直接决定】 | **无编译期检查**：递归是被文档示范的能力（coinflip 自调用）[4]。实际深度上限来自资源体积——etcd 单资源 1MB → 压缩 → 落 SQL 库（`nodeStatusOffLoad`）[6]，纯运行期 |
| **Temporal** | **独立子实例**：Child Workflow 有自己的 RunId / Event History；父子的历史各自独立，无共享本地状态，只能异步通信 [7] | 子的 RetryPolicy 是子自己的；父的历史只记录子的启动/结果事件 [7]。官方原话："Temporal tracks all state changes within a Child Workflow Execution in Event History. Only the input, output, and retry attempts of an Activity Execution is tracked." [7] | **运行期**：单执行 51,200 events / 2,000 Updates / 10,000 Signals 即被终止 [8]；官方建议"单个父不要 spawn 超过 1,000 个子"；Continue-As-New 不保留在飞子工作流 [7] |
| **AWS Step Functions** | **独立执行**：Task 调 `states:startExecution.sync` 等子状态机跑完，用 `AWS_STEP_FUNCTIONS_STARTED_BY_EXECUTION_ID` 关联 [9]；Distributed Map 的每个 item 是一个 child workflow execution，有独立执行历史 [11] | 两侧各自结算：父 Task 有自己的 `Retry`/`Catch`；子内部重试不外溢，子超时上抛为 `States.TaskFailed` [12]。Map Run 另有 `ToleratedFailureCount` / `ToleratedFailurePercentage`，超阈值报 `States.ExceedToleratedFailureThreshold` [11] | **运行期硬配额**：单个执行 25,000 events 即失败 [10]。官方最佳实践直接教用"嵌套执行 / 分布式 Map"绕开历史配额 [10] |
| **GitHub Actions** | **展平进同一次 run**：`jobs.<job_id>.uses` 的语义就是"一个 reusable workflow 文件 **to run as a job**"；limits 进一步明确 "Reusable workflows are viewed as a single entity"（一个含 30 个 reusable workflow 的 run 计为 1）[13][14] | **无跨边界预算**：边界失败=调用 job 失败；"重试"只有整 run 重跑，上限 50 次 [15]。secrets 不自动继承，需显式传或 `secrets: inherit`，且**只传给直接调用的那一层**（A>B>C 时 C 拿不到 A 的 secrets 除非 B 转发）[13] | **静态规则 + 明确数字**：FPT/GHEC 最多 10 层（顶层 + 9 层），GHES 4 层；"Loops in the workflow tree are not permitted." [13]。检测发生在编译期还是运行期文档未说 **[NOT FOUND]** |
| **Airflow** | 官方先后实践过两条路：SubDAG=**独立 DagRun**，`SubDagOperator` 是个 sensor 轮询它（`poke` 直到 `dag_run.state != RUNNING`，非 SUCCESS 就抛异常）[16]；TaskGroup=**纯 UI 分组**，"Tasks in TaskGroups live on the same original DAG… honor all the DAG settings and pool configurations" [17] | SubDAG 内：子的 task 重试是子 DAG 自己的，父不感知；父的 `retries` 落在 sensor 上，重试时会 `_reset_dag_run_and_task_instances` 把失败 TI 重置让调度器重捡 [16]（两层重试互不知情，属【推断】）。TaskGroup 没有边界，也就没有归属问题 | SubDAG 的坑是"静默"：子 DAG 的 schedule 为 `None`/`@once` 时 "the SubDAG will succeed without having done anything" [17]；pool 不被 SubDagOperator 遵守、可能死锁，源码 docstring 教用 `mode=reschedule` 规避 [16] |
| **BPMN 2.0** | 规范**刻意分两种**：Embedded Sub-Process "shares the same set of data as its parent process"，而可复用的那个要"Data needs to be passed to the referenced Sub-Process"；后者即 Call Activity，用 `calledElement` 引用全局 Process [18] | 规范是建模层，不定义重试预算 **[NOT FOUND]**。实现层（Camunda 8）：进入 call activity 即创建被调流程的新实例；中断型边界事件会终止该实例，且其变量不回传 [19] | 规范对 call activity 递归深度无任何规定 **[NOT FOUND]**；全文 `recursi*` 只出现在 compensation 语境 [18]。版本绑定 `latest`/`deployment`/`versionTag` 决定调哪一版 [19] |

## 二、关键洞察

1. **"三种表示法"实际只有两种状态所有权。** 静态展开/同 run 调用（GH Actions 的 reusable workflow、Airflow TaskGroup 甚至连执行层级都不产生、只是分组）与运行时栈（Argo 同实例 node 树、BPMN embedded sub-process）都是"子的进度不是一等事实"；独立子实例（Temporal、SFN、BPMN call activity、Airflow SubDAG）才把子的进度变成可单独寻址的事实。真正的分水岭不是语法，而是**父的状态里存的是"子的进度快照"还是"我在等某个子"**。
2. **独立实例派的共同代价是状态重复 + 配额压力**，三家给出的逃逸机制几乎一模一样：SFN 是 25,000 events 配额 → 用子执行续命 [10]；Temporal 是 51,200 events → Continue-As-New（但**不保留在飞子工作流**）[7][8]；Argo 是 1MB etcd → 压缩 → offload 到 SQL [6]。**它们的嵌套能力很大程度上是"单实例状态装不下"逼出来的，而不是抽象洁癖。**
3. **重试预算必须恰有一处归属。** 所有成熟系统都让重试跟着"状态所在的那一层"：Argo 配在模板上、SFN 用父 Task 的 `Retry`、Temporal 用子自己的 RetryPolicy。没有任何一家做"父预算 + 子预算相乘"的叠加语义——两层同名计数器相乘会让失败次数不可解释。
4. **展平派把"复用"与"层级"解耦，这是它们成功的关键。** TaskGroup / reusable workflow 都只解决可视化与去重，不产生新执行单元，因此没有边界、没有归属、没有状态重复。Airflow 的结论尤其硬：废弃 SubDAG 的理由不是性能，而是**两套执行实体造成语义分裂**（见下）。
5. **"共享数据"与"显式传递"的分野是规范级设计**（BPMN 同一条规范同时给了两种），而显式传递的代价（变量映射、边界事件、终止语义）正是小引擎最容易假装不存在的那部分成本 [18][19]。

## 三、反面教训（重点）

- **Airflow SubDAG：教科书级的"看起来优雅、实为坑"。** AIP-34 动机原文："the SubDagOperator launches a completely different DAG and then monitors it as a separate entity. This has lead to all sorts of edge case (e.g. when workers have different executors than the scheduler). Also currently, there are many handling logics for subdags in the codebase, which increase the maintenance burden." [20]。它踩的具体坑都被写进文档：子 DAG 必须 enabled 且有 schedule，否则"成功但什么都没干"（静默假成功）；清空/标成功在父子两侧语义不一致；pool 不生效可能死锁；executor 可被单独指定造成超额订阅 [17][16]。2.x 发弃用警告 [21]，3.0 的迁移表直接 `SubDAGs → Task Groups` [22]。**教训：把"执行单元"和"复用/分组"混在一个概念里，代价是两套状态机 + 一堆边角语义。**
- **Temporal 明确劝退"为组织代码而嵌套"**："There is no reason to use Child Workflows just for code organization."、"When in doubt, use an Activity."、"we recommend starting with a single Workflow implementation that uses Activities until there is a clear need for Child Workflows." [7]。
- **GH Actions：secrets 不继承、只传直接层、environment secrets 根本传不了**（`on.workflow_call` 不支持 `environment`），权限"只能维持或降低、不能提升"，且 500KB 的 workflow 文件限制反过来逼人做 reusable workflow [13][14]。嵌套不是免费的抽象，是显式的数据管道工程。
- **SFN：阈值超了不代表子执行停了**——"Step Functions may continue to run child workflows in a Map Run even after the tolerated failure threshold is exceeded, but before the Map Run fails." [11]。跨边界的"预算"永远滞后于事实，父必须容忍在飞孤儿。
- **Argo 反例（正面教训）**：递归在 Argo 里是被文档鼓励的能力 [4]，代价是它把"环检测"完全推给运行期，最后真正兜底的是存储体积（1MB → offload）[6]。
- 可选参照：Make 的递归子 make 是同类问题的鼻祖，Miller 1998 的结论是"分区的构建被证明是所有症状的同一根因"，主张单会话整体构建 [23]；Jenkins shared library 则是"复用=加载进同一进程的代码"，只有 `vars/`+`src/` 的结构约定与 CPS 变换约束，不引入任何子实例 [24]。

## 四、对一个小型引擎的启示

**(a) 大系统特有、小引擎照抄必变重**：事件历史配额与 offload 机制（SFN 25,000 / Temporal 51,200 / Argo 1MB→SQL）——它们源于"每个实例一条 append-only 日志"的架构，只为解决"状态装不下"；child-per-item 的大规模 fan-out（Distributed Map 10,000 并发、1000 个 Map Run 上限）；ParentClosePolicy / task queue / 版本绑定 / 变量映射 DSL。这些都不该进一个小引擎。

**(b) 普遍适用**：① 边界即状态边界——父只记"我在等某个子"，不复制子的内部进度；② 重试预算恰有一处归属，绝不相乘；③ 跨边界失败必须携带子的终态原因（SFN 的 `States.TaskFailed`、Temporal 的 child failure），否则父无法归因；④ 环检测位置由定义是否静态决定；⑤ 深度上限要么静态规定（GH Actions 的 10/4 层），要么给运行期兜底。

**(c) 三选一推荐：独立子实例（且只加一个"在飞子指针"）。** 理由针对本引擎的具体约束：
1. **静态展开不可行**：`on_fail` 可回退到更早步骤且可成环（`fail_counts` 的按步设计正是为此），步骤执行次数无上界 → 无法预展开；展开还会污染 `fail_counts` 的"每步预算"语义（一次逻辑失败被拆成多个物理步骤）。
2. **运行时栈与本引擎宪法冲突**：栈意味着状态文件里存一条父子指针链（并把 `current_step` 从单字符串变成栈顶派生量），而引擎已确立"`current_step` 是唯一推进点"（`src/engine.ts` 推进处注释：只有这里改 `current_step`）与"状态不存派生量"（§10.4）。栈崩溃恢复时必须从盘上重放调用链，正是 fail-closed 最怕的那类隐藏状态。
3. **独立子实例的落地形状（最小）**：父状态只增加一个**事实**字段 `awaiting_child: <instanceId>`（与既有 `delegations` 一样是事实、不是派生量），子的进度全在子自己的 `state.json`；子失败 = 父当前步骤失败 **一次**，计入父的 `fail_counts[current_step]`，子的内部重试与 `max_fail_count` 完全自理（对应 Argo/SFN/Temporal 的一致做法）；崩溃恢复直接复用既有孤儿实例识别与 `/ralphflow-continue` 接管路径，父子两侧各自 fail-closed。
4. **深度与环**：定义是静态 YAML → 在 `loadWorkflow` 阶段做一次定义图检查（A→B→A 直接拒绝）+ 显式深度上限（建议 1，最多 2），比 Argo/Temporal 的运行期兜底便宜得多，也符合 GH Actions 的先例 [13]。
5. **副产品**：`artifacts_dir_name` / `user_task` 的既有设计注释已预告子工作流会改写 `user_task`——独立实例方案让"子实例用子 workflow 的 user_task、父实例不变"成为自然结果，不需要新增派生规则。

## 一手来源

[1] Argo Workflow Templates / `templateRef`：https://argo-workflows.readthedocs.io/en/latest/workflow-templates/ ・源码 https://raw.githubusercontent.com/argoproj/argo-workflows/main/docs/workflow-templates.md
[2] Argo Workflow Concepts（steps vs dag）：https://github.com/argoproj/argo-workflows/blob/main/docs/workflow-concepts.md
[3] Argo "Workflow of Workflows" 模式：https://github.com/argoproj/argo-workflows/blob/main/docs/workflow-of-workflows.md
[4] Argo Recursion（模板自调用）：https://github.com/argoproj/argo-workflows/blob/main/docs/walk-through/recursion.md
[5] `spec.retryStrategy` 定义："RetryStrategy for all templates in the workflow."：https://github.com/argoproj/argo-workflows/blob/main/pkg/apis/workflow/v1alpha1/workflow_types.go
[6] Argo Offloading Large Workflows（1MB etcd → 压缩 → SQL）：https://github.com/argoproj/argo-workflows/blob/main/docs/offloading-large-workflows.md
[7] Temporal Child Workflows：https://docs.temporal.io/child-workflows
[8] Temporal Event History limits（51,200 / 2,000 / 10,000）：https://docs.temporal.io/workflow-execution/event
[9] SFN 从 Task 启动嵌套执行：https://docs.aws.amazon.com/step-functions/latest/dg/connect-stepfunctions.html ・https://docs.aws.amazon.com/step-functions/latest/dg/concepts-nested-workflows.html
[10] SFN 历史配额 25,000 与"用嵌套绕开"最佳实践：https://docs.aws.amazon.com/step-functions/latest/dg/limits-overview.html ・https://docs.aws.amazon.com/step-functions/latest/dg/sfn-best-practices.html#bp-history-limit
[11] SFN Distributed Map（child workflow execution、独立历史、ToleratedFailure*）：https://docs.aws.amazon.com/step-functions/latest/dg/state-map-distributed.html
[12] SFN 错误处理（嵌套状态机超时→父收 `States.TaskFailed`）：https://docs.aws.amazon.com/step-functions/latest/dg/concepts-error-handling.html
[13] GH Actions 嵌套深度 10/4 层、禁止环、secrets 只传直接层：https://docs.github.com/en/actions/sharing-automations/reusing-workflows ・https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
[14] GH Actions limits（reusable workflows 视为一个整体）：https://docs.github.com/en/actions/reference/limits
[15] GH Actions 重跑上限 50 次：https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs
[16] Airflow SubDagOperator 源码（sensor/poke/create_dagrun/pool 不生效）：https://github.com/apache/airflow/blob/2.9.0/airflow/operators/subdag.py
[17] Airflow 文档 TaskGroup 与 SubDAG 提示：https://github.com/apache/airflow/blob/2.9.0/docs/apache-airflow/core-concepts/dags.rst
[18] OMG BPMN 2.0.2 规范 PDF（§7.2 Table 7.2；§10.3.6 Call Activity）：https://www.omg.org/spec/BPMN/2.0.2/PDF
[19] Camunda 8 Call activities（新流程实例、边界事件终止子实例、变量映射、bindingType）：https://docs.camunda.io/docs/components/modeler/bpmn/call-activities/
[20] AIP-34 动机原文：https://cwiki.apache.org/confluence/display/AIRFLOW/AIP-34+TaskGroup%3A+A+UI+task+grouping+concept+as+an+alternative+to+SubDagOperator ・https://github.com/apache/airflow/issues/8078
[21] SubDagOperator 弃用 PR：https://github.com/apache/airflow/pull/17488
[22] Airflow 3.0 Release Notes 迁移表 `SubDAGs → Task Groups`：https://github.com/apache/airflow/blob/3.0.0/RELEASE_NOTES.rst
[23] Miller, "Recursive Make Considered Harmful" (1998)：http://aegis.sourceforge.net/auug97.pdf
[24] Jenkins Shared Libraries：https://www.jenkins.io/doc/book/pipeline/shared-libraries/
