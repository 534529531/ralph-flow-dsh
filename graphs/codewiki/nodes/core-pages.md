# core-pages

## 做什么

以资产目录 `format.md` 的 §页面契约 与 §manifest.json 契约为准；repository、outputDir、language 以 plan 为准。

1. 从 plan.pages 取出 owner 为 core-pages 的页面。完成条件：恰好是 overview.md、architecture.md、workflows.md。
2. 阅读页面 source_paths，收集可验证事实。完成条件：每个结论都有 path:line 来源；无法验证的内容列入「未覆盖与假设」。
3. 按 §页面契约 写三页。完成条件：三页通过 §页面验收清单。
4. 用原生 write 写页面，用 ralphflow_artifact_write 写 `.ralphflow-codewiki/manifests/core.json`。完成条件：符合 §manifest.json 契约，files 与实际文件一致。
5. 完成自检。完成条件：按 §页面验收清单 自查，逐条给出证据。

## 验收

1. 按资产目录 `format.md` 的 §页面验收清单 逐条核对并给出证据。
2. manifest 符合 §manifest.json 契约；files 恰好是 owner 为 core-pages 的页面，字段与实际文件一致。
3. 页面集合恰好是 overview.md、architecture.md、workflows.md。
