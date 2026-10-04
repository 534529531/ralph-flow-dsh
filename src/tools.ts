/**
 * Ralph Flow for dsh v2 — 工具 + 命令（命名与 opencode/claude 版一致）
 *
 * 命令语义 = 触发词：`/ralphflow-*` 注入指令给模型，由模型调用同名工具并自然回复。
 * 已实现：list / status / continue / cancel / create / doctor；
 * `/ralphflow-rewind` 与 `/ralphflow-reset` 是两条**机械命令**（见下）。
 *
 * **启动类入口不在这里**：`/ralphflow-start` 与 `/ralphflow-<工作流>` 是**技能**（见
 * `src/skills.ts`）—— 人敲同一串字，但它落成一条普通 `user/message`（`source.kind === "user"`）
 * 而不是 `command/run`，所以新会话能自动命名；同名命令必须保持删除状态，否则客户端会把它
 * 解析回命令、标题照旧没有。逐条归类见 `docs/v2/skills-vs-commands.md`。
 *
 * **`/ralphflow-reset` 与 `/ralphflow-rewind` 是仅有的两条机械命令，但不是例外「命令面」**：
 * 它们由命令处理器**直接**调用引擎完成机械动作 —— reset = `resetCurrent`（只换干净上下文
 * + 重投当前步 DO，**不赦免失败**）；rewind = `rewindTo`（回退到更早的步骤 + 清暂停与失败计数
 * + 整段替换上下文 + 目标步 DO 带着原因重投）—— 再把结果交回模型自然语言回复。
 * 为什么不做成 `ralphflow_reset` / `ralphflow_rewind` 工具：
 *   · 这两件事是**机械程序**的职责（reset 不赦免失败才守得住 `max_fail_count`；rewind 的
 *     状态机倒退必须与机械动作原子发生），不该要求模型记得去调；
 *   · design §10.10 的边界 —— 不给模型任何「可调用的修复入口」（工具面保持固定）。
 *
 * 注意别把三者搞混：**步骤级 `reset: true` / 工作流级 `auto_reset: true`（重置门）**是工作流
 * 作者写的键（载体见 `src/reset.ts`）；`/ralphflow-reset`（重做当前步）与 `/ralphflow-rewind`
 * （回退到更早步骤并换方向）是**用户**手里的两个手动入口 —— 三条自动重置路径（步骤级 /
 * `auto_reset` / 调用点）与这两个手动入口全都走引擎的同一根接线（`deliverStepDo` 的
 * `opts.manual` / `opts.rewind`）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Engine } from "./engine.js";
import { CREATE_GUIDE } from "./create.js";

export interface ToolContext {
  ctx: Context;
  /**
   * 按工作区取引擎（**一个工作区一个引擎**，见 index.ts 的 engineFor）；缺省用进程工作区。
   * 第二个参数是发起会话 id（可选）：引擎创建时会把该工作区的工作流补登记成快捷技能，
   * 名字不合语法的工作流要**当场说清原因**给这个会话听（见 src/skills.ts）。
   */
  engineFor: (workspace?: string, sessionId?: string) => Engine;
  /**
   * **指令**投递（唤醒）。命令语义 = 触发词：`/ralphflow-*` 的每一条投递都是「要模型接着干活」
   * （调工具、用自然语言转达或追问），因此本文件**只有指令**，没有播报 —— 播报全部由引擎
   * 在状态迁移时发出（见 `src/engine.ts` 的 `notify` / `deliverNotice`）。
   * 分类审计见 `docs/v2/delivery-classification.md` 与 `scripts/delivery-classification-test.mjs`。
   */
  deliverDirective: (sessionId: string, text: string) => boolean;
  /** 解析发起会话的工作区（实例资产落点） */
  workspaceOfSession?: (sessionId: string) => string;
}

export type ToolHandler = (args: any, agent: Agent | undefined) => Promise<string> | string;

/**
 * 可用**命令**清单 —— 单一事实源：命令被拒绝时给模型转达的「还能用什么」与兜底回执共用同一份，
 * 避免两处各写一遍后走样。
 *
 * `/ralphflow-start` 与 `/ralphflow-<工作流>` **不在**这里：它们是技能（人敲同一串字，但落成
 * 普通 `user/message` + 宿主注入技能正文），不是命令。把它们写进「可用命令」会指错面。
 */
const AVAILABLE_COMMANDS = "`/ralphflow-list`、`/ralphflow-status`、`/ralphflow-continue`、`/ralphflow-reset`、`/ralphflow-rewind`、`/ralphflow-cancel`、`/ralphflow-create`、`/ralphflow-doctor`";

function sessionIdOf(agent: Agent | undefined): string | null {
  return (agent as { session?: { id?: string } } | undefined)?.session?.id ?? null;
}

// ─── 工具注册 ────────────────────────────────────────────────────────────────

export function registerTools(deps: ToolContext): Map<string, ToolHandler> {
  const { ctx } = deps;
  const handlers = new Map<string, ToolHandler>();
  const tools = ctx.tools as { register(def: unknown): void };

  /**
   * 会话 → 它所在工作区的引擎。**这是所有「发现面」的唯一入口。**
   *
   * 引擎的根就是会话工作区，所以列表、历史、doctor、自定义工作流查找天然落在对的地方。
   * 以前这里是「一个引擎 + 全局索引」：引擎根是 dsh 进程的 cwd，而实例资产落在会话
   * 工作区——真实 GUI 里两者必然不同（`dsh web` cwd = /home/yj，会话工作区 = 仓库），
   * 于是自定义工作流加载不到、历史列表永远空、doctor 看不见残留。
   */
  const engineOf = (agent: Agent | undefined): Engine => {
    const sid = sessionIdOf(agent);
    return deps.engineFor(sid ? deps.workspaceOfSession?.(sid) : undefined, sid ?? undefined);
  };

  const startHandler: ToolHandler = (args, agent) => {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return "找不到当前会话，无法启动工作流。";
    return engineOf(agent).start(String(args?.workflow ?? ""), String(args?.task ?? ""), sessionId).text;
  };

  const continueHandler: ToolHandler = (args, agent) => {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return "找不到当前会话。";
    return engineOf(agent).continueInstance(sessionId, args?.instance ? String(args.instance) : undefined).text;
  };

  const statusHandler: ToolHandler = (args, agent) => {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return "找不到当前会话。";
    return engineOf(agent).statusOf(sessionId, args?.instance ? String(args.instance) : undefined).text;
  };

  const listHandler: ToolHandler = (_args, agent) => engineOf(agent).listAll().text;

  const cancelHandler: ToolHandler = (args, agent) => {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return "找不到当前会话。";
    return engineOf(agent).cancelInstance(sessionId, args?.instance ? String(args.instance) : undefined, args?.reason ? String(args.reason) : undefined).text;
  };

  const createHandler: ToolHandler = (args, agent) => {
    const idea = args?.idea ? String(args.idea).trim() : "";
    // 写意图：把工作流目录建好，模型随后才写得进 <workspace>/.dsh/ralph-flow/workflows/
    try { engineOf(agent).ensureLayout(); } catch {}
    return idea ? `你要创建的工作流：**${idea}**\n\n---\n\n${CREATE_GUIDE}` : CREATE_GUIDE;
  };

  const doctorHandler: ToolHandler = (_args, agent) => engineOf(agent).diagnose().text;

  /**
   * DO 阶段交卷（dsh 原生方式：工具调用即事实，不靠正则扫自由文本）。
   * `concludeTurn` 由注册处调用，让本次工具结果结束当前回合。
   */
  const submitHandler: ToolHandler = (args, agent) => {
    const sessionId = sessionIdOf(agent);
    if (!sessionId) return "找不到当前会话，无法交卷。";
    const summary = args?.summary !== undefined ? String(args.summary) : undefined;
    return engineOf(agent).onSubmit(sessionId, summary).text;
  };

  const toolDefs: Array<{ name: string; description: string; params: Record<string, any>; handler: ToolHandler; concludeTurn?: boolean }> = [
    {
      name: "ralphflow_start",
      description: "启动一个 Ralph Flow 工作流：模型执行当前步骤；有 `check` / `check_voting` 的步骤交卷后由独立验证者取证判定（投票步 N 票并行、全过才放行），失败自动返工；没有 `check` / `check_voting` 的步骤跳过对抗性验证。启动结果会给出本步的 DO 提示与交卷方式。",
      params: {
        workflow: { type: "string", required: true, description: "工作流名（loop / spec，或自定义 YAML 名）。" },
        task: { type: "string", required: true, description: "要完成的任务描述。" },
      },
      handler: startHandler,
    },
    {
      name: "ralphflow_submit",
      description: "【DO 阶段交卷】本步工作完成后调用。有 `check` / `check_voting` 的步骤：独立验证者随即取证判定（投票步 N 票并行、全过才放行）；没有 `check` / `check_voting` 的步骤：跳过对抗性验证直接继续（`manual_step` 则停在审查门等放行）。不交卷则工作流不会推进。",
      params: {
        summary: { type: "string", description: "可选：简述本步做了什么。**验证者看不到它**（T1：验证请求不含执行者自述），它只留在实例状态里；验证者只独立取证。" },
      },
      handler: submitHandler,
      concludeTurn: true,
    },
    {
      name: "ralphflow_continue",
      description: "推进工作流：放行审查门 / 解除暂停 / 接管实例（**只在无属主时自动接管**；有属主的实例必须显式给 `instance`）。判定未通过时拒绝推进。",
      params: {
        instance: { type: "string", description: "要接管/推进的实例 ID（可前缀）。带它 = 用户显式指定 —— 有属主的实例只走这条显式路径。" },
      },
      handler: continueHandler,
    },
    {
      name: "ralphflow_status",
      description: "查看工作流状态、本轮判定、多验证者投票的每票进度与最近轨迹；实例已结束并销毁时指向它的历史报告。**无参且本会话没有活跃实例时，给出全部活跃实例的概览（含属主会话）**。",
      params: {
        instance: { type: "string", description: "实例 ID（可前缀）；缺省看当前会话实例，本会话没有就给全部活跃实例的概览。" },
      },
      handler: statusHandler,
    },
    {
      name: "ralphflow_list",
      description: "列出可用工作流与活跃实例（已结束的运行只给报告目录，不逐个列出）。",
      params: {},
      handler: listHandler,
    },
    {
      name: "ralphflow_cancel",
      description: "取消当前会话（或指定）的活跃实例：中止在飞验证者、归档报告到精确路径并销毁实例目录（报告归档失败时保留不销毁）。",
      params: {
        instance: { type: "string", description: "实例 ID（可前缀）。" },
        reason: { type: "string", description: "取消原因（可选）。" },
      },
      handler: cancelHandler,
    },
    {
      name: "ralphflow_create",
      description: "获取自定义工作流的交互式设计指引（模型与用户一轮问清流程 → 呈现步骤图 → 写 YAML → doctor 校验到全部 ✅ 且无告警）。",
      params: {
        idea: { type: "string", description: "用户想自动化的流程想法（可选，有则附在指引前）。" },
      },
      handler: createHandler,
    },
    {
      name: "ralphflow_doctor",
      description: "诊断工作流定义与实例状态：坏文件说人话、列出阻塞项，修完重跑直到全部 ✅。",
      params: {},
      handler: doctorHandler,
    },
  ];

  for (const def of toolDefs) {
    handlers.set(def.name, def.handler);
    tools.register(defineTool({
      name: def.name,
      description: def.description,
      parameters: def.params,
      output: { schema: { type: "string" }, render: (_args: unknown, value: string) => [{ type: "text", text: value }] },
      async execute(args: unknown, exec: { agent?: Agent; concludeTurn?: () => void }) {
        const out = await def.handler(args ?? {}, exec?.agent);
        // 交卷工具用宿主原生的 concludeTurn 结束本回合
        // （与 dsh-subagent-in-process-driver 的 structured_output 同款机制）。
        if (def.concludeTurn && typeof exec?.concludeTurn === "function") {
          try { exec.concludeTurn(); } catch {}
        }
        return out;
      },
    }));
  }

  // `/ralphflow-rewind` 与 `/ralphflow-reset` 一样**不注册为工具**：注册了就等于给模型一个
  // 可调用、会返回内容的实现，与「命令面固定 + 不给模型可调用的修复入口」的边界冲突
  // （design §10.10）。两者的机械动作都由命令处理器直接驱动引擎完成，见下面的 `run` 分支。
  // 「未实现」的占位处理函数因此不再需要：命令面从今日起没有任何「只声明不实现」的命令。

  return handlers;
}

// ─── 命令注册 ────────────────────────────────────────────────────────────────

/**
 * 注册命令面。
 *
 * 这里**只注册命令**：启动类快捷入口（`/ralphflow-start`、`/ralphflow-<工作流>`）是技能，
 * 见 `src/skills.ts`。同名命令必须保持删除状态 —— 只要同名命令还在，客户端就把它解析成
 * `command/run`（`dsh-commands` 的 `execute`），会话标题照旧没有（`dsh-session-title` 只认
 * `user/message` 且 `source.kind === "user"`）。
 */
export function registerCommands(deps: ToolContext & { handlers: Map<string, ToolHandler> }): void {
  const { ctx } = deps;
  const commands = (ctx as unknown as {
    commands: {
      register(def: {
        name: string;
        description: string;
        input?: { hint: string };
        handler: (inv: { rawInput: string; agent: Agent; signal: AbortSignal }) => Promise<{ kind: "success"; text?: string } | { kind: "error"; text: string }> | { kind: "success"; text?: string } | { kind: "error"; text: string };
      }): void;
    };
  }).commands;

  /** 每条命令 = 触发词：不直接渲染工具返回值，而是给模型一条指令，由模型调用工具并自然回复（claude/opencode 语义）。 */
  const defs: Array<{
    name: string;
    description: string;
    input?: { hint: string };
    /** 参数合法时返回给模型的指令；否则返回渲染给用户的卡片（用法错误/未实现） */
    shim?(inv: { rawInput: string; agent: Agent; signal: AbortSignal }):
      | { kind: "directive"; text: string }
      | { kind: "card"; text: string };
    /**
     * **机械命令**（`/ralphflow-reset`、`/ralphflow-rewind`）：命令处理器直接驱动引擎做事、
     * 再把结果交回模型自然语言回复 —— 不经过「模型记得去调同名工具」这一步。
     * 与 `shim` 二选一（`run` 优先）。
     */
    run?(inv: { rawInput: string; agent: Agent; signal: AbortSignal }): Promise<
      { kind: "success"; text?: string } | { kind: "error"; text: string }
    >;
  }> = [
    {
      name: "ralphflow-continue",
      description: "推进工作流：放行审查门 / 解除暂停 / 接管实例。示例：/ralphflow-continue <实例ID>",
      input: { hint: "[实例ID]" },
      shim: (inv) => {
        const parts = inv.rawInput.trim().split(/\s+/).filter(Boolean);
        const instance = parts[0] ? `，instance = \`${parts[0]}\`` : "";
        return {
          kind: "directive",
          text: `用户执行了 /ralphflow-continue。\`ralphflow_continue\` 只用于三种情况：**批准手动审查**（🙋 步骤停下等你放行：有 \`check\` / \`check_voting\` 的是已通过独立验证，没有 \`check\` / \`check_voting\` 的是已跳过对抗性验证的纯人工审查——两者都直接放行进入下一步，不重复验证）、**恢复暂停**（先看 \`/ralphflow-status\` 的失败原因，修复后调用，重置失败计数并重试；投票步的基础设施故障恢复只重跑未通过的票，已通过的保留）、**接管中断/他人实例**。有 \`check\` / \`check_voting\` 的普通步骤推进是自动的，不要调用它。

请调用 \`ralphflow_continue\` 工具${instance}。若不带实例 id 且本会话没有活跃实例，工具**只在恰好一个无属主实例时自动接管**；否则会列出候选（含属主会话）并要求显式指定 —— 把它展示给用户并询问接管哪个，再带 \`instance\` 调用。按工具结果行动：进入 DO 就执行该步任务；验证中就简短说明；完成就说「工作流结束」；暂停就说明原因与下一步。`,
        };
      },
    },
    {
      name: "ralphflow-status",
      description: "查看实例状态与判定。示例：/ralphflow-status",
      input: { hint: "[实例ID]" },
      shim: (inv) => {
        const parts = inv.rawInput.trim().split(/\s+/).filter(Boolean);
        const instance = parts[0] ? `，instance = \`${parts[0]}\`` : "";
        return {
          kind: "directive",
          text: `用户执行了 /ralphflow-status，想了解工作流进度。请调用 \`ralphflow_status\` 工具${instance}（不带参数时若本会话无实例，应显示项目里所有活跃实例的概览）。然后向用户清晰说明：工作流与当前步骤、状态（执行中/验证中/待放行/暂停及原因）、失败次数，以及**属主会话**——属于其他或已关闭会话的实例可通过 \`/ralphflow-continue <实例ID>\` 接管。若工具说该实例**已结束并销毁**，就把报告路径给用户（历史在报告里，不要在列表里找）。`,
        };
      },
    },
    {
      name: "ralphflow-list",
      description: "列出可用工作流与活跃实例。示例：/ralphflow-list",
      shim: () => ({
        kind: "directive",
        text: "用户执行了 /ralphflow-list。请调用 `ralphflow_list` 工具获取数据，然后把「可用工作流」整理成**表格**（列：工作流 | 用途描述），把「活跃实例」按工具返回的字段简要列给用户（实例 id、工作流、任务、步骤、状态、属主），并转达工具给的「已结束的运行」报告目录。数据以工具返回为准，不要编造；没有就直说。工作流解析顺序：工作区自定义 `.dsh/ralph-flow/workflows/` > 全局 `~/.dsh/ralph-flow/workflows/` > 插件内置。",
      }),
    },
    {
      name: "ralphflow-cancel",
      description: "取消活跃实例：归档报告并销毁实例目录。示例：/ralphflow-cancel",
      input: { hint: "[实例ID] [原因]" },
      shim: (inv) => {
        const parts = inv.rawInput.trim().split(/\s+/).filter(Boolean);
        const instance = parts[0] ? `，instance = \`${parts[0]}\`` : "";
        const reason = parts.length > 1 ? `，reason = \`${parts.slice(1).join(" ")}\`` : "";
        return {
          kind: "directive",
          text: `用户执行了 /ralphflow-cancel，要取消工作流实例${instance}。请调用 \`ralphflow_cancel\` 工具${reason}——它会中止任何在飞的独立验证会话、把最终报告归档到精确路径（\`.dsh/ralph-flow/reports/<实例ID>.md\`）并销毁实例目录；产出目录保留。若报告归档失败，它会保留实例目录不销毁并告警，请如实转达。然后向用户简短确认已取消（或转达错误），并把报告路径给用户。`,
        };
      },
    },
    {
      name: "ralphflow-create",
      description: "交互式创建自定义工作流（模型引导设计 → 写 YAML → doctor 校验）。示例：/ralphflow-create 把 C 代码迁移到 Rust",
      input: { hint: "[流程想法]" },
      shim: (inv) => ({
        kind: "directive",
        text: `用户想${inv.rawInput.trim() ? `创建一个工作流：${inv.rawInput.trim()}` : "创建自定义 Ralph Flow 工作流"}。请调用 \`ralphflow_create\` 工具获取完整设计指引，然后按指引与用户交互：一轮问清流程阶段与审查门位置（用户没说清楚才问）→ 呈现步骤图 → 写 YAML 到 \`.dsh/ralph-flow/workflows/\` → 调用 \`ralphflow_doctor\` 校验到全部 ✅ 且无告警 → 交接运行方式。`,
      }),
    },
    {
      name: "ralphflow-doctor",
      description: "诊断工作流定义与实例状态。示例：/ralphflow-doctor",
      shim: () => ({
        kind: "directive",
        text: "用户执行了 /ralphflow-doctor，想诊断工作流与实例。请调用 `ralphflow_doctor` 工具，然后把诊断为 ❌ 的每一项用通俗语言向用户说明原因与修复建议；全部 ✅ 就简短说「一切正常」。",
      }),
    },
    {
      name: "ralphflow-reset",
      description: "重做当前步：只换干净上下文（失败计数保留，不赦免失败）；暂停中请用 /ralphflow-continue。示例：/ralphflow-reset",
      run: async (inv) => {
        const sid = messageSessionId(inv.agent);
        if (!sid) return { kind: "error", text: "当前会话已离线，无法重置上下文。请刷新后重试。" };
        // 机械动作在**命令处理器**里完成（不经过模型调工具）：重置是程序的职责，
        // 「不赦免失败」也只有在程序手里才守得住。失败绝不抛，如实回。
        const res = deps.engineFor(deps.workspaceOfSession?.(sid)).resetCurrent(sid);
        if (res.ok) {
          // 成功：引擎已在**空闲窗口**排入整段替换，并会把当前步 DO 重投 + 发一条可见告知。
          // 不给程序化卡片（命令语义 = 触发词，回复由模型/引擎消息承担）。
          return { kind: "success" };
        }
        // 拒绝：把原因交回模型自然语言转达，并叫停重复尝试（命令语义不变）。
        deps.deliverDirective(
          sid,
          `[ralphflow] 用户执行了 /ralphflow-reset，但**被拒绝**：${res.text}\n\n请用自然语言如实向用户说明拒绝原因与下一步（暂停中指向 \`/ralphflow-continue\`；验证/审查门中请等结果）。**不要调用任何工具**，不要替用户重试重置。`,
        );
        return { kind: "success" };
      },
    },
    {
      name: "ralphflow-rewind",
      description: "回退到更早的步骤并换方向：清暂停与失败计数、作废本轮判定，属主会话上下文整段替换成交接稿，目标步 DO 带着原因重投。示例：/ralphflow-rewind design 改用另一种方案（回退只去当前步**之前**的步骤；目标步与原因都必填）",
      input: { hint: "<步骤> <原因>" },
      run: async (inv) => {
        const sid = messageSessionId(inv.agent);
        if (!sid) return { kind: "error", text: "当前会话已离线，无法回退。请刷新后重试。" };
        // 参数解析：`<步骤> <原因>` 两个都必填；原因是自由文本（可含空格），所以第一段是步骤、
        // 其余整段是原因。
        const parts = inv.rawInput.trim().split(/\s+/).filter(Boolean);
        if (parts.length < 2) {
          // 缺参数**交回模型自然语言追问**（与 /ralphflow-start 同款：像 opencode 一样由模型
          // 说明用法并问清缺失信息），不在这里给程序化卡片。
          const have = parts.length === 1 ? `用户已给出目标步骤 \`${parts[0]}\`，缺的是**回退原因**。` : "目标步骤与回退原因两者都缺。";
          deps.deliverDirective(
            sid,
            `[ralphflow] 用户执行了 /ralphflow-rewind 但参数不完整（用法：\`/ralphflow-rewind <步骤> <原因>\`，两个都必填）：${have}\n\n**不要调用任何工具**，先用自然语言向用户说明用法并询问缺少的信息（要回到哪个更早的步骤、以及为什么要换方向——原因会写进目标步的 DO 提示词，接手这一步的模型一定看得到）。必要时用 \`ralphflow_status\` 看当前步与工作流的步骤列表，供用户选择。`,
          );
          return { kind: "success" };
        }
        const stepId = parts[0]!;
        const reasonText = parts.slice(1).join(" ");
        // 机械动作在**命令处理器**里完成（不经过模型调工具）：状态机倒退 + 清暂停/失败计数
        // + 强制整段替换上下文 + 重投目标步 DO，必须与机械程序的决定原子发生，不能要求模型记得去调。
        const res = deps.engineFor(deps.workspaceOfSession?.(sid)).rewindTo(sid, stepId, reasonText);
        if (res.ok) {
          // 成功：引擎已在**空闲窗口**排入整段替换，并会把目标步 DO（带着原因）+ 可见告知投出。
          // 不给程序化卡片（命令语义 = 触发词，回复由模型/引擎消息承担）。
          return { kind: "success" };
        }
        // 拒绝：把原因交回模型自然语言转达（调用点 / 未来步 / 当前步 / 不存在 / 已交卷…每条
        // 都是具体理由），并叫停重复尝试（命令语义不变）。
        deps.deliverDirective(
          sid,
          `[ralphflow] 用户执行了 /ralphflow-rewind ${stepId} ${reasonText}，但**被拒绝**：${res.text}\n\n请用自然语言如实向用户说明拒绝原因与下一步（已交卷 / 验证中请等验证结果；想重做**当前步**用 \`/ralphflow-reset\`；想放行审查门或恢复暂停用 \`/ralphflow-continue\`）。当前可用命令：${AVAILABLE_COMMANDS}。**不要调用任何工具**，不要替用户重试回退。`,
        );
        return { kind: "success" };
      },
    },
  ];

  for (const def of defs) {
    try {
      commands.register({
        name: def.name,
        description: def.description,
        ...(def.input ? { input: { hint: def.input.hint } } : {}),
        handler: async (inv: { rawInput: string; agent: Agent; signal: AbortSignal }) => {
          try {
            // 机械命令：处理器直接驱动引擎，结果交回模型自然回复（零程序化卡片返回）
            if (def.run) return await def.run({ rawInput: inv.rawInput, agent: inv.agent, signal: inv.signal });
            const out = def.shim!({ rawInput: inv.rawInput, agent: inv.agent, signal: inv.signal });
            if (out.kind === "directive") {
              const sid = messageSessionId(inv.agent);
              if (sid) {
                deps.deliverDirective(sid, `[ralphflow] ${out.text}`);
                // 回复留给模型（claude/opencode 语义），命令卡不渲染任何程序文本
                return { kind: "success" };
              }
              // 找不到会话（罕见兜底）：卡片展示，避免用户什么反馈都没有
              return { kind: "error", text: "当前会话已离线，无法交给模型处理。请刷新后重试。" };
            }
            return { kind: "success", text: out.text };
          } catch (err) {
            return { kind: "error", text: err instanceof Error ? err.message : String(err) };
          }
        },
      });
    } catch (err) {
      ctx.logger?.warn?.("[ralphflow] command registration skipped:", err);
    }
  }
}

function messageSessionId(agent: Agent | undefined): string {
  return (agent as { session?: { id?: string } } | undefined)?.session?.id ?? "";
}