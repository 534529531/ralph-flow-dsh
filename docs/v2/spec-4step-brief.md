# spec 资产对齐任务书：7 步 → 4 步（三端一致）

> **目标**：把内置 `spec` 工作流从 **7 步**（被取代的旧版）换成 **4 步**（opencode 现行版），并同步 claude 版仓库。
> **作者定案**：7 步直接废弃，不做保留、不做 `spec-heavy` 变体。

## 1. 依据（不是"因为 opencode 这么做"，而是证据 + 分析）

**证据**：opencode 的 git 显示，`0b485e7`（2.6.0 重置门）**之前**的 `spec.yaml` 就是我们现在的 7 步——**连 description 都一字不差**（"完整的需求分析、规格定义、技术设计、代码实现工作流"）。该 release 把它重写成 4 步，新 description 明说"基于 OpenSpec 哲学重构的**轻量**迭代开发工作流……**不做瀑布式长篇文档**"。

**分析（4 步更优的五条理由）**：
1. **无 reset 时"步数多"≠"上下文干净"**：7 步是 7 个阶段挤在同一个不断膨胀的上下文里，最贵、最易被带偏的 `implement` 背着 4 份文档的历史干活；4 步只背 2 个阶段。
2. **7 步有三段验证重叠**：`implement.check`（测试/lint/TODO/tasks）、`verify.check`（测试/lint/需求覆盖）、`archive.check`（测试/tasks/summary）——测试与 lint 被验三遍，是**冗余不是覆盖**。
3. **审查门位置更对**：7 步的门在**第 1 步**（第一份草稿），审完还有 3 个文档阶段才到实现；4 步的 `explore` 先探过、门在第 2 步，审的是**已探明方向的定稿**，审完只剩 `implement`。
4. **回退更短**：7 步 `archive` 失败要 `verify`→`implement` 两跳；4 步直接回 `implement`。
5. **完整体下 4 步 + 子工作流才是正确形态**：重型规格流程应做成**可组合的独立工作流**，不该是内置单体（单体挡住了组合）。

**结论**：即使没有 reset 门，4 步仍更优（优势较小）；**reset 门落地后优势显著放大**。

## 2. 范围

### 2.1 我们的仓库（`ralph-flow-dsh`）
- `workflows/spec.yaml` → 4 步（`explore` → `propose` → `implement` → `archive`）
- `README.md` 内置工作流描述同步
- `docs/v2/design.md` 相关描述同步

### 2.1b 前置修复：内置工作流不该播种副本（否则本改动不生效）

**这是执行中发现、且必须一并修的**：我们的 `ensureLayout` 会把内置工作流**复制**进工作区（"已存在则不覆盖"），而 **opencode 与 claude 都明确不播种**，两端注释一字不差：

> Built-in workflows are intentionally NOT copied… **Seeding copies would shadow the plugin dir and go stale on plugin updates.**

后果实测：工作区里那份 7 步 `spec.yaml` 副本**把新版 4 步内置整个挡住了**——改了内置却"没生效"。

修复：`ensureLayout` 不再播种；内置始终回落插件目录取用（始终最新）。定制入口 = 放同名文件遮蔽（有意行为）。同时删掉已有工作区里那份**与旧内置逐字节相同**的陈旧副本（已核验未被用户改过，删除安全）。

### 2.2 claude 仓库（`ralph-flow-claude`）
- `workflows/spec.yaml` → 同一份 4 步
- `README.md` 示例 3 的 spec 走查（现在写的是 specs→design 两步）同步
- 跑通它的测试（`npm test`）
- **提交并 push 到 `origin/main`**（`https://github.com/534529531/ralph-flow-claude.git`）

## 3. 三端的 `reset` 差异（必须如实处理，不要抹平）

opencode 的 4 步给 `propose` 与 `implement` 标了 `reset: true`（重置门）——这是它 `implement` 能一口吞下所有任务的关键。

但**claude 版与 dsh 版都不支持重置门**：
- claude：换会话 = **弹窗口**，自动弹不可接受，故不实现（`server.mjs:1401-1413` 明确告警，指向手动 `/ralphflow-reset`）
- dsh：`reset` 是有意推迟项，当前 warn+ignore

**因此**：
- opencode 的 `spec.yaml` 保持带 `reset: true`（**不动它**）
- claude 与 dsh 的 `spec.yaml` **不带** `reset: true`——否则**内置工作流自己就会产生告警**（用户没写错却看到警告），且 dsh 的 `engine-test` 有"内置工作流零告警"断言
- 两处都用**注释**保留信息，写明"reset 门落地后启用（对齐 opencode）"

> 结论：三端资产在**可跑方言**上一致，`reset` 按各端能力裁剪——这是诚实的分歧，不是缺陷。

## 4. 验收

1. 我们的 `spec.yaml` 是 4 步，`engine-test` 全绿（含"内置 loop/spec 零告警"断言），`APPLY_OK`，`tsc` 干净。
2. claude 的 `spec.yaml` 是同一份 4 步，`npm test` 全绿。
3. 两端的 `spec` 都能 `doctor` 通过、无告警。
4. 文档（两边 README + 我们的 design）不再出现 7 步/`specs.md`/`design.md`/`verification.md` 作为 spec 内置步骤的描述。
5. claude 仓库提交并 **push 成功**。
6. `reset: true` 在两端都是注释形态，并写明启用条件。
