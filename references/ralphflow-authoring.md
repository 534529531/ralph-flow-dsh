# RalphFlow 作者适配

本文件只补 RalphFlow 的落盘约定；grill、spec、tickets 的方法用同目录 `matt/` 的原文，不在这里复述。

## 本地文件模式

Matt 的 `to-spec` / `to-tickets` 默认发布到 issue tracker。RalphFlow 使用本地文件，不运行 `/setup-matt-pocock-skills`，不创建 GitHub/Linear issue。

一次设计使用 `.dsh/ralph-flow/designs/<slug>/`：

- `grill.md`：grill 的决定与未决项
- `spec.md`：spec 正文
- `tickets/<NN>-<slug>.md`：一个 ticket 一个文件
- `tickets.json`：ticket 图，字段 `id`、`title`、`depends_on`、`acceptance`、`files`
- `design-delivery.json`：交付摘要

`<slug>` 用小写 kebab-case，与最终 `.dsh/ralph-flow/graphs/<slug>.yaml` 同名。

## 生成的 Graph

- 一个 ticket 一个 `steps` 条目；`id` 用 ticket id
- `depends_on` 来自 `tickets.json`
- `do` 指向 spec 与 ticket 的绝对路径，写清本 ticket 的完整动作与完成条件
- `check` 来自 ticket 的 acceptance，写成可观察、可复核的判据
- 资产生成后用 `ralphflow_doctor` 校验；不自动启动
- 生成资产自包含：只引用用户项目的 spec/ticket 文件，不引用插件内部 `references/`

## 写作规范

写 spec、tickets、Graph 的 DO/CHECK 前，读 `matt/writing-for-agents.md`；每条适用规则都要落到交付物里。
