# module-pages

## 做什么

以资产目录 `format.md` 的 §页面契约 与 §manifest.json 契约为准；repository、outputDir、language 以 plan 为准。

1. 从 plan.pages 取出 owner 为 module-pages 的页面，与 plan.modules 一一核对。完成条件：每个模块恰好一页，路径为 modules/<slug>.md。
2. 逐模块阅读 source_paths 的代码与导入边，记录职责、接口、流程与坑。完成条件：每个模块页的结论都有 path:line 来源；无法验证的内容列入「未覆盖与假设」。
3. 按 §页面契约 写每个模块页与模块间链接。完成条件：每页通过 §页面验收清单；链接都指向已计划的模块页。
4. 用原生 write 写全部模块页，用 ralphflow_artifact_write 写 `.ralphflow-codewiki/manifests/modules.json`。完成条件：符合 §manifest.json 契约，files 与实际文件一致。
5. 完成自检。完成条件：按 §页面验收清单 自查，逐条给出证据。

## 验收

1. 按资产目录 `format.md` 的 §页面验收清单 逐条核对并给出证据。
2. manifest 符合 §manifest.json 契约；files 恰好是 owner 为 module-pages 的页面，字段与实际文件一致。
3. 每个模块恰好一页，路径为 modules/<slug>.md；slug、标题与 source_paths 与 plan.modules 一致。
4. other 页说明聚合规则。
