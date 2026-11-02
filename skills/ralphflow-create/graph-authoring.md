# RalphFlow 工作流资产编写

供编写和校验可交付 Graph 工作流资产时参考。结构和有效 CHECK（独立验收）内容，以 `ralphflow_doctor` 的检查为准。

- 写任何节点的 DO/CHECK 或其他面向 agent 的文本之前，先读同目录的 [`matt/writing-for-agents.md`](matt/writing-for-agents.md)；它是随包唯一权威副本，本文件不复述原则。
- Flow 资产（`steps` / `on_pass` / `check_voting`）的字段见 [`workflow-authoring.md`](workflow-authoring.md)；Graph 与 Flow 字段不混用。

## 结构

Graph 资产用与 Flow 相同的 `steps` 数组，每个步骤有 `id`、`desc`、`do`；`output` 是交付文件路径（省略时默认 `<id>.md`），`depends_on` 是前驱步骤 id 数组。上游步骤的 `output` 会自动注入下游的只读材料，**不需要再写 `inputs` 映射**；只表达顺序时也写 `depends_on`。目录名就是启动名（入口固定是 `graph.yaml`），不要再写 `id` 或 `name`。

## 资产目录

资产是一个目录：`graphs/<name>/graph.yaml` 加它引用的资源。**参考根是入口文件所在目录**：DO/CHECK 引用的**资产资源**（契约、页面模板、校验清单）用相对路径按它解析，执行者与验证者的提示词里都会带上同一个目录。所以这些资源放在资产自己的目录里，用 `format.md`、`templates/page.md` 这样的相对路径指向；不要把它们复制进每一步的提示词。这个根只解析资产资源，工作区路径与节点产物仍按各自一节的路径规则。单文件形态 `graphs/<name>.yaml` 仍可加载，参考根是 `graphs/`（兼容形态，共享资源放那里）。

只有产物工作流中必须与用户讨论某个决定的步骤，才使用 `execution: "main"`；普通的自主工作使用 `background`。顶层 `manual_step` 标记在启用的 CHECK 通过后仍需用户明确审查的步骤。

Graph 始终使用 Git 隔离：每个步骤在自己的 worktree 与自己的分支上运行，交卷前把运行级集成分支合进来；引擎只做快进。没有 workspace 开关，也没有并发数字；就绪步骤全部放行，由 DSH 的 agent 并发限制排队。

## 工作区与 Git

Graph 需要工作区是 Git 仓库、有 HEAD、且工作区干净。不满足时启动失败，错误提示会要求 AI 先问用户是否初始化；用户同意后由 AI 执行 `git init` / `git add -A` / `git commit -m baseline`，再重新启动。引擎不自动初始化。

方案要写明最终结果在集成分支 `ralphflow/<实例>`（节点分支 `ralphflow-node/<实例>/<节点>`），而不是自动改源 checkout；跑完用 `git log` / `git ls-tree` / `git checkout` 查看。设计 CHECK 必须核对：每个 DO 需要的原生能力在 Git worktree 中真实存在；输出位置和最终可审查位置已经写明。

## 可复用场景

当请求设计的是要在多个项目或主题上运行的流程时，流程资产就是产品。一次性执行设计跳过本分支。

1. 只向用户询问流程目标及其约束。完成条件：每个重要的设计决定都已得到回答或记录为待定选项，且完成设计不需要任何未来的项目、主题、材料或运行值。
2. 把每个在不同运行之间会变化的值写进任务约定（DO 里说明这些值从任务文本读取），资产中不出现任何未来的值。完成条件：每个步骤动作都从任务文本读取其变化的值。
3. 把流程目标到步骤交付物的映射写进交付产物的 `plan` 字段，在 `goalCoverage` 中重复这份映射。完成条件：每个请求的成果都指明一个已存在的步骤、它的产物、依赖理由和验收路径。
4. 在交付边界检查资产的结构、步骤指引、依赖和目标覆盖。完成条件：`ralphflow_doctor` 校验有效，且 `assetAcceptance` 为每个维度记录了可观察的已通过检查。
5. 把下一步作为两个明确选项提供：停止并保留资产，或运行一个真实实例。让 `nextStep.started` 和 `generatedWorkflowStarted` 保持 false。完成条件：产物说明只有用户的明确选择才会启动运行。

## 用引用代替复制

让资产只承载流程与验收；可复用的方法正文放在参考资料里。

- 当一条规则已经存在于共享参考资料中时，指明该参考资料及其触发条件，让执行者去读；步骤或判据只写依赖这条规则的结果。
- CHECK 判据保持为用户可查看的验收结果。细节属于方法时，指向共享参考资料；细节属于任务特定结果时，把判据明确写出来。
- 把多个节点共用的约定放进资产目录里的一份文件（例如 `format.md`），或放进一个上游产物（例如 `CONVENTIONS.md`），并让每个节点指向它。
- 只有拿不到资产目录的辅助者才需要内联正文；拿到参考根的辅助者按相对路径自己读。

完成条件：每条可复用的规则只有一个归属；方案指明这个归属；没有节点复述它。

## CHECK 的选择

Graph 不提供固定的默认 CHECK：每个步骤的独立验收都由资产作者按 writing-for-agents 写成显式判据。

- 需要独立验收：写 `check: |` 加可观察、穷尽的判据，每条一行编号（`1. ...`）。判据覆盖该步骤必须交付的所有内容；`ralphflow_doctor` 的「有效 CHECK」会逐条显示。
- 独立验收没有额外价值：写 `check: null`。报告与查看器会明确显示“CHECK 关闭”，不等于验证通过。
- 不要写 `check: {mode: default}` 或 `{mode: custom, criteria}`：Graph 的 `check` 是字符串或 `null`，没有默认判据模式。

## 编写顺序

1. 应用方案中的成果映射。完成条件：每个请求的成果都由一个节点交付物承载，并有一条验收路径。
2. 按 writing-for-agents 的规则，把每个节点的 DO 写成有序动作，并带有可核查的完成条件。完成条件：全新的执行者无需猜测就能判断节点何时完成。
3. 把 writing-for-agents 应用到每个交付节点的 DO、CHECK 和面向用户的指引。完成条件：指针写明触发条件，每条规则只有一个归属，指引以正面方式陈述目标行为。
4. 组装对象，包含其依赖、产物和 CHECK 选择。完成条件：对象中的每一处引用都指向该对象已声明的内容。
5. 用 `ralphflow_doctor`（工作区资产路径） 校验该对象。修复每个报告的错误并重新校验。完成条件：`ralphflow_doctor` 报告全部 ✅ 且无告警，每个步骤的有效 CHECK 与方案一致。
6. 把资产保存为 `.dsh/ralph-flow/graphs/<slug>/graph.yaml`，把 DO/CHECK 引用的契约与模板放在同一目录。完成条件：入口在该路径可读，目录名与启动名一致，每条相对路径都指向同目录里存在的文件。
7. 用 `ralphflow_doctor({ "path": ".dsh/ralph-flow/graphs/<slug>/graph.yaml" })` 校验已保存的文件。完成条件：`valid` 为 true，且 doctor 无阻塞项。
8. 用 `ralphflow_artifact_write` 写入交付产物：请求、`plan` 文本、`assetPath`、完整的资产、两次校验结果、每个步骤的有效 CHECK、针对保存资产的查看器指引、标记为 `choiceRequired` 且 `started: false` 的 `nextStep` 选项，以及 `generatedWorkflowStarted: false`。可复用场景的交付还要包含 `designKind`、`goalCoverage`、`assetAcceptance` 和 `realRun`。完成条件：产物指明方案文本、资产路径和已保存文件的校验结果，且可复用场景字段满足可复用场景分支；然后调用一次 `ralphflow_submit`。

## 打开已交付的资产

保存后资产会出现在 RalphFlow 只读查看器的 Graph 列表里；让用户打开右侧 RalphFlow 标签页并重新加载即可。编辑资产走常规路径：编辑、doctor 校验、保存、重新加载。

## 交付边界

设计运行以方案和资产收尾。在最终回复的结尾给出两个保存路径、打开工作图的指引，以及作为用户明确选择的下一步：审查工作图、在主会话中请求修改、停止并保留资产，或运行一个真实实例。对于可复用场景，在任务约定里说明真实运行需要随任务提供的值；v1 不提供隔离样例启动。生成的工作流只在那次明确请求之后启动；设计期间不创建任何生成工作流的运行实例。

v1 不提供隔离样例启动：用户明确要求运行后，用 `ralphflow_start` 以任务文本启动真实实例。
