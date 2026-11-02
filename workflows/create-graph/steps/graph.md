## 做什么

按 `ralphflow-create` skill 资源目录中的 `graph-authoring.md`、`ralphflow-authoring.md` 和 `matt/writing-for-agents.md` 生成资产。

按 tickets.json 生成 `.dsh/ralph-flow/graphs/<slug>/`：一个 ticket 一个步骤，`id` 用 ticket id，`depends_on` 来自 ticket 依赖。`graph.yaml` 是入口地图：每步只写一句「做什么、交付什么」加指针（`do` ≤ 120 字符），`check` 只写一句验收指针（≤ 80 字符）；每个 ticket 的完整动作与验收写进同目录 `nodes/<ticket-id>.md`，分「## 做什么」「## 验收」两节，入口用相对路径 `nodes/<ticket-id>.md` 指向。节点文件用项目内路径引用 spec 与 ticket。可复用的契约与模板放进同一个资产目录，用相对路径指向；入口不复述做法，也不复制 Matt 参考正文。

用 `ralphflow_doctor({ "path": ".dsh/ralph-flow/graphs/<slug>/graph.yaml" })` 校验；修到全部通过。把资产路径、ticket 图和下一步写进交付消息；不启动生成的 Graph。

完成条件：资产通过 doctor，目录名与启动名一致，ticket、步骤与 `nodes/<id>.md` 一一对应，交付消息给出路径和用户下一步。

## 验收

1. 每个 ticket 恰好对应一个 Graph 步骤；id、depends_on 与 tickets.json 一致，依赖无环。
2. `graph.yaml` 是入口地图：每个 `do` 是一句「目标 + 交付」并指向 `nodes/<ticket-id>.md`（≤ 120 字符），每个 `check` 是一句验收指针（≤ 80 字符）；入口每行只描述「做什么」。
3. 每个 ticket 的完整动作与验收都写在同目录 `nodes/<ticket-id>.md` 的两节里：`## 做什么` 覆盖 spec 与 ticket 的动作、完成条件，`## 验收` 覆盖 ticket acceptance；执行者顺指针能拿到全部做法。
4. 生成的 DO/CHECK 符合 `ralphflow-create` skill 资源目录中的 `matt/writing-for-agents.md`；可复用的契约与模板放在同一个资产目录并由相对路径指向，没有复制进节点提示词；入口是 `.dsh/ralph-flow/graphs/<slug>/graph.yaml`，每条相对路径都指向同目录里存在的文件（含 `nodes/<id>.md`）。
5. `ralphflow_doctor` 对保存的资产全部通过；交付声明没有启动生成的 Graph。
