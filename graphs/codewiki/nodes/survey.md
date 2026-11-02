# survey

## 做什么

以资产目录 `format.md` 为准（输出树、页面契约、模块树规则与 schema）。任务未指定时 repository 用 `.`、outputDir 用 `docs/codewiki`、language 用 `zh-CN`；确定后写进 plan，后续只读。

1. 检查路径与输出安全。完成条件：repository、outputDir 是工作区内相对路径；outputDir 是目录或不存在，不等于 repository 根与 `.ralphflow-codewiki`，且为空或本工作流先前生成的目录（§输出树）。用原生 bash 清空并重建 `.ralphflow-codewiki/`；plan、manifests、delivery 由 ralphflow_artifact_write 写入 artifact store。
2. 处理先前输出。完成条件：只删除 §输出树 记录的旧文件与 metadata.json、index.md，再删空目录，outputDir 为空。冲突时（outputDir 是文件、含计划外文件、记录有越界路径）把 plan.status 设为 blocked、blocked_reason 写明冲突路径，跳到第 7 步，冲突文件保持原样。
3. 扫描 repository。完成条件：记录语言、源根、入口点、包清单、构建/测试/lint/CI 配置与模块导入边，每项带路径来源；排除范围见 §模块树规则。
4. 建立模块树。完成条件：按 §模块树规则 生成 modules；每个未排除源文件属于一个模块或 coverage.uncovered；模块按 slug 字典序。
5. 制定页面计划并写 format 快照。完成条件：pages 覆盖 §输出树 的全部页面，字段齐全（§页面契约），owner 按固定映射，模块页与 modules 一一对应；plan.format 与 §页面契约 逐字一致。
6. 用 ralphflow_artifact_write 写 `.ralphflow-codewiki/plan.json`。完成条件：符合 §plan.json 契约；source.commit 与 dirty 来自 git 事实；commands 含 build、test、lint；无法确认的项写入 assumptions。
7. 完成自检。完成条件：ready 时所有 source_paths 在 repository 下存在；blocked 时 blocked_reason 与冲突一致；文件不含 TODO、TBD 或占位符。

## 验收

1. plan.json 符合资产目录 `format.md` 的 §plan.json 契约，status 为 ready，source.repository、source.outputDir、format.language 与任务文本或默认值一致。
2. pages 覆盖 §输出树 的全部页面，字段齐全（§页面契约），owner 符合固定映射，模块页与 modules 一一对应，路径无重复；plan.format 与 §页面契约 逐字一致。
3. modules 满足 §模块树规则：数量上限、slug 唯一、other 聚合与覆盖要求成立；每个 source_paths 在 repository 下存在。
4. source.source_roots 与 commands 的来源路径都在 repository 下存在；languages 由实际文件统计得出；无法确认的项在 assumptions 中说明。
5. 输出目录安全：ready 时没有删除或覆盖计划外文件的证据；blocked 时 blocked_reason 与实际冲突一致。
6. plan.json 可解析，generated_at 是有效 ISO 8601 时间，不含 TODO、TBD 或占位符。
