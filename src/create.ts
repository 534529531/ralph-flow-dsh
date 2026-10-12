/** Workflow creation recipe; detailed dialect is disclosed through a shipped reference. */
import { fileURLToPath } from "node:url";

export const AUTHORING_REFERENCE_PATH = fileURLToPath(new URL("../references/workflow-authoring.md", import.meta.url));

export const CREATE_GUIDE = `与用户设计自定义 Ralph Flow 工作流，按以下顺序完成：

1. 明确流程目标、交付物与可验证的完成条件，找出需要用户审查的位置；已有信息足够就直接设计，仅问会影响流程的缺项。
2. 展示紧凑步骤图：步骤 → 交付物 → 验收方式 → on_pass / on_fail 目标。方向明确后写 YAML；跨步任务应有可从文件恢复的需求、决定和证据。
3. 默认写入 \`<workspace>/.dsh/ralph-flow/workflows/<name>.yaml\`。用户要求全局复用时写入 \`~/.dsh/ralph-flow/workflows/<name>.yaml\`。用小写 kebab-case 命名；同名文件会遮蔽内置或全局工作流，先确认这是用户意图。
4. 写定义前读取下方 YAML 参考的基本字段与硬规则。用投票时查 check_voting；需要模型覆盖时查模型配置与优先级；跨步清上下文时查 reset；复用子流程时查子工作流调用点与继承。参考文件：
   \`${AUTHORING_REFERENCE_PATH}\`
5. do 写执行顺序与交付标准；check 写独立验证者可以取证的通过/失败条件。项目专用流程点名文件与命令，通用流程按项目实际入口选方法。投票各管一个互补视角；通常 2–3 票足够。角色纪律与判定输出由插件提供。
6. 调用 \`ralphflow_doctor\`，修复目标工作流的每个 ❌ 与告警再重跑，直到目标定义全部 ✅ 且无告警。它同时检查其它定义与实例：范围外问题如实告知用户，勿为完成创建而修改其它运行。
7. 给出文件位置、最终步骤图、审查门和运行方式 \`/ralphflow-start <名字> <任务>\`。后续会话可使用快捷技能 \`/ralphflow-<工作流名> <任务>\`；本次创建不自动启动执行。

过程文档（清单、方案、报告、摘要、草稿）的默认落点是实例产出目录。写裸文件名即可；明确路径按指定路径。工作目录只放本步的**产物**；同一份过程文档只写一处。DO 与 CHECK 会给出实际目录，工作目录中的重复副本是落点错误。

需要人工决定的步骤列入顶层 manual_step；on_fail 通常指自身，只有前序成果确实失效才指向前序步骤。失败预算适合任务成本，不靠无限循环掩盖缺少验收依据。正文使用用户的语言。`;
