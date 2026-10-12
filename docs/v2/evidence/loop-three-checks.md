# loop 三票与验证恢复验收（2.3.0）

内置 loop 将「需求落实」与「遗漏/边界」合为一票，保留实际可用性与回归影响两票；三个互补视角全部通过才结束。执行者交卷前自行核验，如实记录未验证事项。每轮摘要、上下文重置、失败返工与失败上限沿用原规则。自定义工作流仍支持 1–5 票；默认三票不构成供应商全局并发限制。

单 `check` 与投票统一基础设施恢复：首次 infra 自动重试一次，不重新执行 DO、不计工作失败、不唤醒主会话；再次 infra 暂停，用户继续后恢复一次重试预算。正常 failed 仍走返工与失败上限。新增 `single-check-retry-test.mjs` 覆盖成功恢复、预算耗尽与继续、正常失败、非法返回/异常及取消后的迟到结果。

## 真机 Chat 与负对照

使用隔离 HOME 和本地可控模型输出，在 dsh 0.2.1-alpha.1 的真实 AgentLoop、ToolRuntime、spawn、持久化和 Web Chat 上运行；没有调用付费远程模型。

- [状态验收结果](loop-three-checks/status/result.json)：三张原生票、失败一轮只累计一次、重置后模型恰好三条输入、刷新恢复、暂停/审查门/完成/取消、会话隔离、断线重连与冷重启均通过。
- [状态弹层截图](loop-three-checks/status/popover-votes.png)：真实 Chat 显示三票及各票进度。
- [通知验收结果](loop-three-checks/notice/result.json)：逐票通知、汇总、返工、完成、持久化刷新与主会话不被通知唤醒均通过。
- 负对照保留原断言：移除客户端工厂，真实 Chat 通知和状态入口断言失败；切断状态推送、移除固定位置时，同一状态验收分别失败。详见上述结果 JSON 与 `negative-*.png`。

运行命令：

```sh
RALPHFLOW_UI_EVIDENCE_DIR="$PWD/docs/v2/evidence/loop-three-checks/status" node scripts/ui-status-web.mjs
RALPHFLOW_UI_EVIDENCE_DIR="$PWD/docs/v2/evidence/loop-three-checks/notice" node scripts/ui-notice-web.mjs
npm run build && npm run typecheck && npm run verify
```

前两项均返回 PASS；完整自动检查结果以本次提交前输出及发布 Action 的闸门为准，发布闸门会在干净安装的 npm 默认正式版宿主依赖上重新验证。
