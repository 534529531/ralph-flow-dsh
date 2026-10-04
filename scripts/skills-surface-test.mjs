/**
 * 启动类快捷入口 = **技能**（不是命令）：技能面的可复核证据。
 *
 * 为什么要有这支用例：任务书的完成判据 1–6 里有一半是**面**的问题（谁看得见、谁被删掉了、
 * 名字合不合法、标题口径成不成立），用替身断言「注册了什么东西」只能证明我们调了哪个 API，
 * 证明不了 dsh 真的会那样工作。所以这里挂**真的 dsh 服务**：
 *
 *   · `@deepseek-ai/dsh-skill` 的 `SkillRegistry` —— 真合并、真 invocation 策略、真 `get()` 加载；
 *   · `@deepseek-ai/dsh-commands` 的 `CommandRuntime` —— 真解析：`execute()` 对未知名字返回
 *     `undefined`（这正是客户端把它当普通消息提交、`source.kind === "user"` 成立的前提）；
 *   · `@deepseek-ai/dsh-session-title` 的 `SessionTitleService` —— 真标题口径：
 *     `user/message` + `source.kind === "user"` ⇒ 兜底标题真的产生；`command/run` ⇒ 永远没有。
 *
 * 五节：
 *   T1 真 registry：注册了什么、哪一面看得见、描述逐字等于触发词；
 *   T2 真命令面：`/ralphflow-start …` 与 `/ralphflow-<工作流> …` **不再**被解析成命令（判据 2）；
 *   T3 真标题口径：人敲那条路真的产出标题（判据 5 的「人敲」半边，附源码位置）；
 *   T4 名字合语法：非法工作流名**如实拒绝并说清原因**，绝不静默跳过（判据 4）；
 *   T5【负对照】把启动入口还原成命令 → 同一个 T2 判据必然判不通过。
 *
 * 纪律：一切临时资产走 mkdtemp + 隔离 HOME（真实 `~/.dsh` 绝不读写）。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { Session, SESSION_FORMAT_VERSION } from "@deepseek-ai/dsh-session";
import SkillRegistry, { isModelInvocable, isUserInvocable, isSkillName } from "@deepseek-ai/dsh-skill";
import CommandRuntime from "@deepseek-ai/dsh-commands";
import SessionProjectionRegistry from "@deepseek-ai/dsh-session-projection";
import SessionTitleService from "@deepseek-ai/dsh-session-title";
import { mkTmp, cleanupTmp, toolOf, execTool } from "./helpers/plugin-harness.mjs";
import { REPO, buildPluginCopy, revertStartShortcutToCommand } from "./helpers/reverted-build.mjs";

// HOME 隔离：引擎在创建时解析 os.homedir()（全局工作流目录），测试绝不读写真实 HOME。
process.env.HOME = mkTmp("home");
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };
const RUN = Math.random().toString(36).slice(2, 8);
const PLUGIN_ENTRY = pathToFileURL(path.join(REPO, "lib", "index.js")).href;
const sleep = (ms = 100) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setTimeout(r, 30));

/**
 * 触发词（任务书「描述文本」一节**逐字**）。写死在这里是**判据本身**：技能描述必须逐字等于它，
 * 否则「触发词只出现一次」那条就无从谈起。
 */
const START_DESCRIPTION = "每步都由独立会话的验证者验收的工作流。用户点名 ralphflow，或要求做完由独立验证者验收才算完成时用它。";

/** 命令面的**完整**清单（判据 1/2/6：逐条归类后剩下的就是这 8 条）。 */
const EXPECTED_COMMANDS = [
  "ralphflow-cancel", "ralphflow-continue", "ralphflow-create", "ralphflow-doctor",
  "ralphflow-list", "ralphflow-reset", "ralphflow-rewind", "ralphflow-status",
];

/**
 * 模型目录里那一行的渲染形态：`dsh-tool-skill` 的 `renderCatalogEntries` 是
 * `` `- \`${entry.name}\`: ${escapeText(entry.description)}` ``，`escapeText` 是
 * `&`/`<`/`>` 三个实体的替换。这里照抄同一条式子，用来断言目录里**逐字**长什么样。
 */
const catalogLine = (e) => `- \`${e.name}\`: ${String(e.description).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}`;

/**
 * 一个「真服务 + 隔离工作区」的环境。
 *
 * @param entryUrl 插件入口（可以是负对照构建的入口）
 * @param label 标签（缓存破坏 + 临时目录命名）
 */
async function mkSurfaceEnv(entryUrl, label) {
  const ws = mkTmp(`skills-${label}`);
  process.env.RALPHFLOW_WORKSPACE = ws;

  // 自定义工作流：一个合语法（必须登记成 ralphflow-my-flow）+ 一个不合语法（必须被如实拒绝）
  const wfDir = path.join(ws, ".dsh", "ralph-flow", "workflows");
  fs.mkdirSync(wfDir, { recursive: true });
  const wfBody = "steps:\n  - id: only\n    desc: 一步\n    do: 做一件事\n";
  fs.writeFileSync(path.join(wfDir, "my-flow.yaml"), `description: 我的自定义流程\n${wfBody}`);
  fs.writeFileSync(path.join(wfDir, "Bad_Name.yaml"), `description: 名字不合语法\n${wfBody}`);

  const mkSession = (id) => Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: ws, isSeeded: false }, 0);
  const sid = `skills-${label}-${RUN}`;
  const session = mkSession(sid);
  const agent = { id: sid, session, steer: () => {}, followup: () => {} };
  // 负对照会话（T3 的「命令没有标题」半边）：同一台宿主、另一条会话
  const sidCmd = `skills-cmd-${label}-${RUN}`;
  const sessionCmd = mkSession(sidCmd);
  const sessions = new Map([[sid, session], [sidCmd, sessionCmd]]);

  const ctx = new Context();
  const registered = { tools: [], skills: [] };
  ctx.provide("tools", { register: (d) => registered.tools.push(d), schemas: () => [] });
  ctx.provide("subagents", {
    list: () => [],
    getProvider: () => ({ capabilities: { outputSchema: true, persona: true, toolFilter: true }, inheritsParentContext: false }),
    start: async () => ({ id: "child", result: Promise.resolve({ structured: { passed: true, reason: "ok" }, output: [], stopReason: "completed" }) }),
  });
  ctx.provide("sessions", { list: () => [...sessions.values()], get: (id) => sessions.get(id) });
  ctx.provide("agents", { get: (id) => (id === sid ? agent : undefined) });
  ctx.provide("logger", { info() {}, warn() {}, error() {} });

  // 真服务：技能面 / 命令面 / 标题面。SessionTitleService 声明了 inject（sessions + sessionProjections），
  // 所以 sessions 必须先 provide（上面已做），sessionProjections 由 registry 自己装上。
  ctx.plugin(SkillRegistry);
  ctx.plugin(CommandRuntime);
  ctx.plugin(SessionProjectionRegistry);
  await tick();
  ctx.plugin(SessionTitleService, { fallbackMaxWords: 8, fallbackMaxBytes: 64, maxTitleBytes: 128 });
  await tick();

  const plugin = await import(entryUrl + (label === "fixed" ? "" : `?${label}-${RUN}`));
  plugin.apply(ctx);
  await tick();

  return { ws, sid, sidCmd, session, sessionCmd, agent, ctx, registered, cleanup: () => cleanupTmp(ws) };
}

/** 命令面解析一条斜杠行（`undefined` = 名字不解析 ⇒ 客户端按普通用户消息提交）。 */
const asCommand = (env, line) => env.ctx.commands.execute(env.agent, line, [], new AbortController().signal);

/** **唯一判据**：这一行不会被解析成命令（T2 用它判通过，T5 用它判修复前必然失败）。 */
const notACommand = async (env, line) => (await asCommand(env, line)) === undefined;

// ─────────────────────────────────────────────────────────────────────────────

const fixed = await mkSurfaceEnv(PLUGIN_ENTRY, "fixed");
const snapshot = await fixed.ctx.skills.snapshot({ cwd: fixed.ws });
const ralphflowSkills = snapshot.skills.filter((s) => s.name.startsWith("ralphflow-"));
const modelVisible = ralphflowSkills.filter(isModelInvocable);

console.log("T1 真 SkillRegistry：注册了什么、哪一面看得见（判据 1 / 2 / 3 / 4）");
{
  check("registry 合并完成（真 provider 收集，不是替身）", snapshot.complete === true, JSON.stringify(snapshot.complete));

  check("模型目录里与 ralphflow 相关的条目**只有一条**，且就是 ralphflow-start",
    modelVisible.length === 1 && modelVisible[0].name === "ralphflow-start",
    `modelVisible=${modelVisible.map((s) => s.name).join(",")}`);

  const start = ralphflowSkills.find((s) => s.name === "ralphflow-start");
  check("ralphflow-start 的描述**逐字**等于任务书那句触发词",
    start?.description === START_DESCRIPTION, JSON.stringify(start?.description));

  check("模型目录里那一行逐字是 `- \\`ralphflow-start\\`: <触发词>`（renderCatalogEntries 形态）",
    modelVisible.map(catalogLine).join("\n") === `- \`ralphflow-start\`: ${START_DESCRIPTION}`,
    JSON.stringify(modelVisible.map(catalogLine)));

  check("ralphflow-start 两面都有（invocation 省略 ⇒ modelInvocable + userInvocable）",
    !!start && isModelInvocable(start) && isUserInvocable(start), JSON.stringify(start?.invocation));

  const userOnly = ["ralphflow-loop", "ralphflow-spec", "ralphflow-my-flow"];
  check("ralphflow-<工作流> 三条都在（loop / spec / 自定义 my-flow），且都只给人看",
    userOnly.every((n) => {
      const s = ralphflowSkills.find((x) => x.name === n);
      return s !== undefined && isUserInvocable(s) && !isModelInvocable(s);
    }),
    ralphflowSkills.map((s) => `${s.name}:${JSON.stringify(s.invocation)}`).join(" | "));

  check("每个 ralphflow 技能名都满足 dsh 的技能名语法 [a-z0-9]+(-[a-z0-9]+)*",
    ralphflowSkills.every((s) => isSkillName(s.name)), ralphflowSkills.map((s) => s.name).join(","));

  check("ralphflow-<工作流> 的描述直接用工作流 YAML 的 description（loop 那句）",
    ralphflowSkills.find((s) => s.name === "ralphflow-loop")?.description === "单步对抗验证循环：实现与验证在同一环节内迭代，直到通过",
    JSON.stringify(ralphflowSkills.find((s) => s.name === "ralphflow-loop")?.description));

  const startDef = await fixed.ctx.skills.get("ralphflow-start", { cwd: fixed.ws });
  check("真 registry 能按名字加载正文（get）", !!startDef && startDef.content.length > 0);
  check("正文让模型调 ralphflow_start，并把参数来源指向**用户那条消息**",
    !!startDef && startDef.content.includes("ralphflow_start") && startDef.content.includes("用户那条消息"),
    startDef?.content.slice(0, 160));
  check("正文带工作流机制说明（DO/CHECK 两阶段、自动验证）",
    !!startDef && startDef.content.includes("工作流机制") && startDef.content.includes("ralphflow_submit"));

  const loopDef = await fixed.ctx.skills.get("ralphflow-loop", { cwd: fixed.ws });
  check("人敲 /ralphflow-loop 时注入的正文点名该工作流与任务来源",
    !!loopDef && loopDef.content.includes("ralphflow-loop") && loopDef.content.includes("用户那条消息"),
    loopDef?.content.slice(0, 160));

  // ── 触发词「只此一处」（判据 3）：运行期源码里只有定义那一处；工具描述不复述；没有系统提示词段落 ──
  const srcDir = path.join(REPO, "src");
  const triggerHits = fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))
    .map((f) => ({ f, n: fs.readFileSync(path.join(srcDir, f), "utf-8").split(START_DESCRIPTION).length - 1 }))
    .filter((x) => x.n > 0);
  check("运行期源码里触发词**恰好出现 1 次**（src/skills.ts 的那条定义）",
    triggerHits.length === 1 && triggerHits[0].f === "skills.ts" && triggerHits[0].n === 1,
    JSON.stringify(triggerHits));

  const startToolDesc = toolOf(fixed.registered, "ralphflow_start")?.description ?? "";
  check("`ralphflow_start` 的工具描述里没有复述触发词（整句与半句都没有）",
    !startToolDesc.includes(START_DESCRIPTION)
      && !startToolDesc.includes("用户点名 ralphflow")
      && !startToolDesc.includes("独立验证者验收才算完成"),
    startToolDesc);

  check("插件没有往系统提示词里加段落（不加第二处触发点）",
    fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))
      .every((f) => !/systemPrompt/.test(fs.readFileSync(path.join(srcDir, f), "utf-8"))));
}

console.log("\nT2 真命令面：启动类**不再**是命令（判据 2；这正是标题口径成立的前提）");
{
  const names = fixed.ctx.commands.list(fixed.agent).map((d) => d.name);
  check("命令面恰好是这 8 条 —— 启动类不在其中，也没有任何动态工作流快捷命令",
    JSON.stringify(names) === JSON.stringify(EXPECTED_COMMANDS), JSON.stringify(names));

  check("`/ralphflow-start loop …` 解析不出命令（execute ⇒ undefined ⇒ 客户端按普通消息提交）",
    await notACommand(fixed, "/ralphflow-start loop 标题口径验证"));

  check("`/ralphflow-loop …` 同样解析不出命令", await notACommand(fixed, "/ralphflow-loop 标题口径验证"));

  check("边界上的快捷入口仍是命令（`/ralphflow-status` 解析成功）",
    (await asCommand(fixed, "/ralphflow-status")) !== undefined);

  check("`ralphflow_start` 工具仍在（工具面不变）", !!toolOf(fixed.registered, "ralphflow_start"));
  check("没有把启动类做成工具（工具面保持固定：不给模型新的可调用入口）",
    !toolOf(fixed.registered, "ralphflow_start_shortcut") && fixed.registered.tools.length === 8,
    fixed.registered.tools.map((t) => t.name).join(","));
}

console.log("\nT3 真标题口径：人敲 `/ralphflow-start …` 真的产出标题（判据 5 的「人敲」半边）");
{
  // 真 SessionTitleService 的事件入口就是宿主的 `session/event` 观察者（它在构造里 ctx.on(...)），
  // 所以这里按宿主同款投一条**普通用户消息**，再把事件交给服务自己的上下文派发。
  fixed.ctx.sessionTitle.ctx.emit("session/created", fixed.session);
  const evUser = fixed.session.append("user/message", {
    id: "m-title",
    content: [{ type: "text", text: "/ralphflow-start loop 标题口径验证" }],
    source: { kind: "user", rpcId: "r1" },
  }, { surfaceOp: "append" });
  fixed.ctx.sessionTitle.ctx.emit("session/event", fixed.session, evUser);

  // 负对照：同样的位置敲一条**命令**（`command/run`），标题永远不会有。
  fixed.ctx.sessionTitle.ctx.emit("session/created", fixed.sessionCmd);
  const evCmd = fixed.sessionCmd.append("command/run", {
    commandId: "c1", name: "ralphflow-start", args: "loop 标题口径验证", source: { kind: "user" },
  });
  fixed.ctx.sessionTitle.ctx.emit("session/event", fixed.sessionCmd, evCmd);
  await sleep(250);

  const title = fixed.ctx.sessionTitle.get(fixed.session);
  const cmdTitle = fixed.ctx.sessionTitle.get(fixed.sessionCmd);
  check("人敲技能：那条消息是 source.kind === \"user\" 的普通 user/message",
    evUser.type === "user/message" && evUser.data.source.kind === "user", JSON.stringify(evUser.data.source));
  check("真标题服务为它落了兜底标题（source.kind === \"fallback\"）—— 会话不再「未命名」",
    title?.source?.kind === "fallback" && title.title.length > 0, JSON.stringify(title));
  check("标题文本就是用户敲的那句（dsh-session-title 的 fallbackSessionTitle）",
    title?.title.includes("/ralphflow-start"), JSON.stringify(title?.title));
  check("【负对照】命令落成 command/run ⇒ 真标题服务永远不给它标题",
    cmdTitle === undefined && evCmd.type === "command/run", JSON.stringify(cmdTitle));
  check("标题事件真的写进了会话日志（不是内存里的投影假象）",
    fixed.session.snapshotEvents().some((e) => e.type === "session/title"),
    fixed.session.snapshotEvents().map((e) => e.type).join(","));
}

console.log("\nT4 名字合语法：非法工作流名**如实拒绝并说清原因**（判据 4）");
{
  check("不合语法的工作流没有登记成技能（没有 ralphflow-Bad_Name）",
    !snapshot.skills.some((s) => s.name.toLowerCase().includes("bad")), snapshot.skills.map((s) => s.name).join(","));

  // 引擎入口带会话 id 时会**当场**把原因说给这个会话听（投一条可见播报，不唤醒）
  await execTool(toolOf(fixed.registered, "ralphflow_list"), {}, fixed.sid);
  const notices = fixed.session.snapshotEvents().filter((e) => e.type === "user/message" && /没能做成快捷技能/.test(e.data?.source?.summary ?? ""));
  check("不合语法时投了一条可见播报（绝不静默跳过）", notices.length >= 1, `n=${notices.length}`);
  const reason = (notices.at(-1)?.data?.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  check("理由点名那个工作流、给出技能名语法、并给出改法（重命名成小写 kebab）",
    reason.includes("Bad_Name") && reason.includes("[a-z0-9]+(-[a-z0-9]+)*") && reason.includes("my-flow.yaml"), reason.slice(0, 400));
  check("理由说清它**仍可用** /ralphflow-start <工作流> 启动（拒绝的是快捷入口，不是工作流本身）",
    reason.includes("/ralphflow-start Bad_Name"), reason.slice(0, 400));
  check("合语法的工作流不受影响（my-flow 仍登记着）", snapshot.skills.some((s) => s.name === "ralphflow-my-flow"));
}

console.log("\nT5【负对照】把启动入口还原成命令 → 同一个 T2 判据必然判不通过");
{
  const legacy = buildPluginCopy({ "tools.ts": revertStartShortcutToCommand }, "skills-reverted");
  try {
    const env = await mkSurfaceEnv(legacy.entry, "reverted");
    const resolved = await asCommand(env, "/ralphflow-start loop 标题口径验证");
    check("还原后：`/ralphflow-start loop …` 被解析成命令（execute 有结果）",
      resolved !== undefined, JSON.stringify(resolved?.result?.kind));
    check("还原后：**同一个判据 notACommand** 为假 —— 新用例在修复前必然失败",
      (await notACommand(env, "/ralphflow-start loop 标题口径验证")) === false);
    check("还原后：命令面里多出了 ralphflow-start（8 条 → 9 条）",
      env.ctx.commands.list(env.agent).map((d) => d.name).includes("ralphflow-start"),
      env.ctx.commands.list(env.agent).map((d) => d.name).join(","));
    env.cleanup();
  } finally {
    legacy.cleanup();
  }
}

fixed.cleanup();

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
