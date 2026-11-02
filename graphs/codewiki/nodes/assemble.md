# assemble

## 做什么

以资产目录 `format.md` 与四个上游产物为准；repository、outputDir、language 以 plan 为准。

1. 核对输入。完成条件：plan.status 为 ready；三个 manifest 与 plan 中对应 owner 的页面完全一致。不一致时停止写 wiki，用原生 write 把差异写到 `.ralphflow-codewiki/validation.json`，保留现场供 CHECK 复核。
2. 写 index.md。完成条件：符合 §index.md 契约；链接覆盖全部页面，不链接计划外页面。
3. 写 metadata.json。完成条件：符合 §metadata.json 契约；files 覆盖除 metadata.json 外全部 wiki 文件；modules 与 plan 一致；validation 先写 pending 与空 checks。
4. 写 `.ralphflow-codewiki/verify.mjs`，实现 §校验清单 的 10 项检查，支持 --check 与 --write。完成条件：脚本可执行；--check 只读并打印 JSON；--write 写出 validation.json。
5. 运行 --check，修复自己负责的 index.md 与 metadata.json；上游页面缺陷保持原样并记录。完成条件：退出码为 0，或失败项都来自上游页面且有证据。
6. 运行 --write，通过后把 validation.status 与 checks 写回 metadata.json，再运行一次 --check。完成条件：validation.status 为 passed；metadata.validation 与 validation.json 一致；--check 退出码为 0。
7. 用 ralphflow_artifact_write 写 `.ralphflow-codewiki/delivery.json`。完成条件：符合 §validation.json 与 delivery.json 契约；字段与实际一致，files 按路径字典序。
8. 完成自检。完成条件：wiki 目录只含 plan.pages 与 metadata.json；没有临时文件；全部页面通过 §页面验收清单。

## 验收

1. index.md 与 metadata.json 存在；index 符合资产目录 `format.md` 的 §index.md 契约，链接覆盖全部页面且不指向计划外页面。
2. metadata 符合 §metadata.json 契约；files 覆盖除 metadata.json 外全部文件，字段与实际一致；modules 与 plan 一致；validation 与 validation.json 一致。
3. validation.json 的 §校验清单 10 项 id 齐全且全部 passed，evidence 指向实际文件，validation.command 可复现。
4. 重跑 `node .ralphflow-codewiki/verify.mjs <outputDir> --check` 返回 0，输出与 validation.json 一致，且不修改工作区文件。
5. wiki 目录恰好是 plan.pages 加 metadata.json；没有临时文件或计划外文件。
6. delivery.json 符合契约，status 为 passed，路径都存在，files 覆盖全部 wiki 文件且字段与实际一致。
7. 全部页面按 §页面验收清单 逐条核对并给出证据。
