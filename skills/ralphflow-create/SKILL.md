---
name: ralphflow-create
description: 创建或修改 RalphFlow 工作流或 DAG：用户想把流程做成工作流、设计多 agent DAG，或修改现有 Flow/Graph 资产时使用。
---

# RalphFlow 创建

先判断产物是 Flow 还是 Graph，再走对应分支。两条分支都以「资产已保存、`ralphflow_doctor` 通过、没有启动实例」为完成条件。

## Flow

Flow 是顺序状态机，不走 Matt 的 grill/spec/tickets。

1. 问清目标、触发条件、输入、产出和结束条件；只问会改变步骤或验收的决定。
2. 读 `workflow-authoring.md`，按它的字段与写法起草；写 DO/CHECK 前读 `matt/writing-for-agents.md`。它只管写法，不引入 Graph 的 grill/spec/tickets。
3. 把资产写到项目根的 `.dsh/ralph-flow/workflows/<slug>/workflow.yaml`（项目根 = 从当前目录向上最近的含 `.git` 的祖先目录；没有就用当前目录）。资产目录里可以放 DO/CHECK 引用的契约、模板等资源，这些资源的相对路径按该目录解析；要写出的交付物按 `output` 与产出目录的落点。
4. 用 `ralphflow_doctor` 校验，修到全部通过。
5. 把路径和用法交给用户；生成的工作流只在用户明确要求时启动。

完成条件：doctor 通过，文件存在，没有启动实例。

## Graph / DAG

Graph 用 ticket DAG。启动内置 `create-graph` Flow，由它承载 grill → spec → tickets → graph，以及 spec/tickets 的独立 CHECK 和人工门：

`ralphflow_start({ workflow: "create-graph", task: "<用户想法>" })`

然后按它返回的步骤执行；方法由 create-graph 的步骤从 `ralphflow-create` skill 的资源目录读取随包 Matt 参考。

如果你已经在 `create-graph` 的某个步骤中，只执行当前步骤，不再启动新的 `create-graph`。

完成条件：create-graph 完成并给出 Graph 资产路径；没有启动生成的 Graph。
