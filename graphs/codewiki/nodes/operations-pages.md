# operations-pages

## 做什么

以资产目录 `format.md` 的 §页面契约 与 §manifest.json 契约为准；repository、outputDir、language 以 plan 为准。

1. 从 plan.pages 取出 owner 为 operations-pages 的页面。完成条件：恰好是 interfaces.md 与 operations.md。
2. 阅读接口、配置、构建、测试、CI/CD、部署、可观测性、安全、性能相关文件与命令。完成条件：每个接口、命令和配置都有来源；无法验证的内容列入「未覆盖与假设」；N/A 项写明检查过的路径。
3. 按 §页面契约 写两页。完成条件：两页通过 §页面验收清单；每个命令与仓库文件一致。
4. 用原生 write 写页面，用 ralphflow_artifact_write 写 `.ralphflow-codewiki/manifests/operations.json`。完成条件：符合 §manifest.json 契约，files 与实际文件一致。
5. 完成自检。完成条件：按 §页面验收清单 自查，逐条给出证据。

## 验收

1. 按资产目录 `format.md` 的 §页面验收清单 逐条核对并给出证据。
2. manifest 符合 §manifest.json 契约；files 恰好是 owner 为 operations-pages 的页面，字段与实际文件一致。
3. 页面集合恰好是 interfaces.md 与 operations.md。
4. N/A 项写明检查过的路径。
