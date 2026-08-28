# Ralph Flow for DeepSeek Harness (dsh)

> **npm:** [`ralphflow-dsh`](https://www.npmjs.com/package/ralphflow-dsh) · **源码:** [github.com/534529531/ralph-flow-dsh](https://github.com/534529531/ralph-flow-dsh) · 上游: [ralph-flow](https://github.com/534529531/ralph-flow)

DO/CHECK 状态机工作流引擎的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 原生插件。插件名 **ralphflow**，命令与工具命名和 opencode 版完全一致。

<img width="3839" height="2160" alt="Screenshot from 2026-08-28 21-45-14" src="https://github.com/user-attachments/assets/760187b8-2a74-4a3e-b230-cb0a778f7633" />


## 什么是 Ralph Flow

模型执行任务（DO），独立验证者对抗检查（CHECK），失败自动返工，关键步骤停下等你审查。全程状态机驱动，你只需要等待和关键时刻点一下。

### 页头任务列表

点击页面右上角 **Ralph Flow** 入口展开抽屉：实时进度、超时进度条、验证票状态、一键通过/打回/取消。

### 对话内命令卡

`/ralphflow-start`、`/ralphflow-continue` 等命令的结果以显眼卡片渲染在对话流里，不只是一行灰色工具行。

## 安装

### npm 安装

```bash
dsh plugin --profile web add ralphflow-dsh
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

```yaml
- insert:
    - id: ralphflow
      name: ralphflow-dsh
```

重启 dsh。

### 本地源码安装

```bash
git clone https://github.com/534529531/ralph-flow-dsh.git
cd ralph-flow-dsh
npm install
npm run build
dsh plugin --profile web add .
```

## 使用

### 基本命令

| 命令 | 用途 |
|---|---|
| `/ralphflow-start <工作流> <任务>` | 启动工作流 |
| `/ralphflow-continue` | 批准审查 / 恢复暂停 / 接管实例 |
| `/ralphflow-status` | 查看进度 |
| `/ralphflow-list` | 列出工作流与实例 |
| `/ralphflow-cancel` | 取消并归档报告 |
| `/ralphflow-rewind <步骤> <原因>` | 回退到上游步骤 |
| `/ralphflow-reset [原因]` | 重做当前步 |
| `/ralphflow-doctor` | 诊断定义与实例状态 |
| `/ralphflow-unbrick` | 修复会话日志中的历史遗留帧 |
| `/ralphflow-create [想法]` | 交互式创建新工作流 |

### 快捷命令

```bash
/loop 写一个贪吃蛇游戏       # 等同于 /ralphflow-start loop ...
/spec 修复登录模块的空指针    # 等同于 /ralphflow-start spec ...
```

### 工作区结构

```
<workspace>/ralph-flow/
├── workflows/        # 自定义工作流 YAML（loop/spec 为内置）
├── instances/        # 活跃实例状态
├── reports/          # 完成后的报告
└── artifacts/        # 任务产物
```

## 工作流

每个工作流是一个 YAML 文件，定义步骤序列、检查依据、失败策略。内置两个：

### loop（迭代验证）

```
DO: 完成用户任务
CHECK: 独立验证者投票（3 票）
  通过 → 完成
  失败 → 重做（最多 100 轮）
```

### spec（规范驱动）

```
explore → propose → implement → archive
每步都有独立验证，propose 步骤需要人工审查
```

自定义工作流放到 `<workspace>/ralph-flow/workflows/` 即可被识别。

## 与 opencode 版对比

| | opencode 版 | dsh 版 |
|---|---|---|
| 命令/工具 | `/ralphflow-*` + `ralphflow_*` | 完全一致 |
| 状态机 | 引擎驱动 | 引擎移植，驱动换 dsh jobs |
| 验证者 | opencode 会话 | dsh 子代理 |
| 审查门 | 卡片 + 命令 | 页头抽屉一键操作 |
| UI | TUI + 自绘 | dsh 原生插槽 |
| 主题 | 自绘 | dsh 官方 token |

## 技术特性

- **零会话污染**：不向会话日志写任何自定义事件帧，通过折叠宿主官方 `command/run` + `command/done` 渲染命令卡——第三方自定义帧会让整个会话无法加载
- **全局通知**：审查门/暂停/完成到达时弹系统通知，任意页面都提醒，跨标签页去重
- **动作直连**：抽屉按钮通过 HTTP POST 直连 host 执行，不走命令注入输入框
- **超时进度条**：CHECK 阶段显示剩余时间，验证票实时显示飞行时长
- **会话卫生**：`/ralphflow-doctor` 检测工作流/资源/会话三维度；`/ralphflow-unbrick` 一键修复历史遗留问题
- **崩溃恢复**：进程重启后自动扫描实例目录恢复任务视图

## 依赖

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) `>=0.1.0-rc.7`
- [ralph-flow](https://github.com/534529531/ralph-flow)（上游状态机引擎）

## 许可

[MIT](LICENSE)
