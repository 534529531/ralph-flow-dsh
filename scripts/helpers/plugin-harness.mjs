/**
 * 测试基建：**两个会话、一个进程**的最小宿主替身（问题一的用例要用）。
 *
 * 为什么需要它：真实 GUI 里每个会话各自装载插件、各自 `apply(ctx)`，但都在**同一个
 * dsh 进程**里，共用同一个工作区的 `.dsh/ralph-flow/`。会话 A 交卷后在飞验证、会话 B
 * 碰一下任何 ralphflow 工具（哪怕只读的 `/ralphflow-list`）——这就是出问题的那个交叉点，
 * 而引擎的 `restore()` 恰好挂在所有工具的入口 `engineFor()` 上。
 *
 * 本文件只提供「假宿主」与文本小工具，**不含任何断言**：它不是测试，是脚手架
 * （放在 helpers/ 子目录里，不会被 `scripts/*.mjs` 的用例遍历跑到）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Session } from "@deepseek-ai/dsh-session";

/**
 * 造一个「会话 + 插件宿主」。
 *
 * @param {string} ws  会话工作区（必须是一个 mkdtemp 出来的隔离目录）
 * @param {string} sid 会话 id
 * @param {object} [opts]
 * @param {Function} [opts.start] `subagents.start` 的替身；缺省立刻返回一个通过判定。
 *   传一个「永不 resolve」的实现即可把验证**钉在飞行中**（问题一的用例就是这么做的）。
 */
export function mkEnv(ws, sid, opts = {}) {
  const ctx = new Context();
  const registered = { tools: [], commands: [] };
  const sent = [];
  const agents = new Map();
  const session = Session.create(sid, [], { version: 3, id: sid, createdAt: Date.now(), cwd: ws, isSeeded: false }, 0);
  agents.set(sid, { id: sid, session, steer: (m) => sent.push(m), followup: (m) => sent.push(m) });

  ctx.provide("tools", {
    register: (d) => registered.tools.push(d),
    // 验证者的工具白名单是从部署实际工具集求交集的（verify.ts resolveToolAllow）
    schemas: () => [{ name: "read" }, { name: "grep" }, { name: "glob" }, { name: "bash" }],
  });
  ctx.provide("commands", { register: (d) => { registered.commands.push(d); return () => {}; } });
  ctx.provide("subagents", {
    list: () => ["spawn"],
    getProvider: () => ({ capabilities: { outputSchema: true, persona: true, toolFilter: true }, inheritsParentContext: false }),
    start: opts.start
      ?? (async () => ({ id: "child", result: Promise.resolve({ structured: { passed: true, reason: "ok" }, output: [], stopReason: "completed" }) })),
  });
  ctx.provide("agents", { get: (id) => agents.get(id) });
  ctx.provide("sessions", { list: () => [], get: (id) => (id === sid ? session : undefined) });
  ctx.provide("logger", { info() {}, warn() {}, error() {} });
  return { ctx, registered, sent, sid, agents };
}

/** 注册表里取工具（名字与 dsh 工具名同形） */
export const toolOf = (registered, name) => registered.tools.find((t) => t.name === name);
/** 注册表里取命令 */
export const cmdOf = (registered, name) => registered.commands.find((c) => c.name === name);
/** 插件投递出去的那条消息的正文 */
export const textOf = (m) => (m?.content ?? []).filter((b) => b?.type === "text").map((b) => b.text).join("");

/** 调工具：包一层 exec 形状（agent.session.id 就是会话身份） */
export async function execTool(tool, args, sid) {
  return tool.execute(args ?? {}, { agent: { session: { id: sid } }, signal: new AbortController().signal });
}

/** 调命令：命令面只把指令投给模型（触发词语义），返回 {kind:"success"} */
export async function execCommand(cmd, sid) {
  return cmd.handler({ commandId: `c-${sid}`, agent: { session: { id: sid } }, rawInput: "", attachments: [], signal: new AbortController().signal });
}

export const sleep = (ms = 100) => new Promise((r) => setTimeout(r, ms));

export const rfDir = (ws) => path.join(ws, ".dsh", "ralph-flow");
export const instanceDirOf = (ws, instId) => path.join(rfDir(ws), "instances", instId);
export const statePathOf = (ws, instId) => path.join(instanceDirOf(ws, instId), "state.json");
export const reportPathOf = (ws, instId) => path.join(rfDir(ws), "reports", `${instId}.md`);

export function readTextFile(p) {
  try { return fs.readFileSync(p, "utf-8"); } catch { return null; }
}

/** 读一个实例的 state.json（不存在返回 null） */
export function readStateFile(ws, instId) {
  const raw = readTextFile(statePathOf(ws, instId));
  try { return raw === null ? null : JSON.parse(raw); } catch { return null; }
}

/** 列出工作区里实例目录名（排序后返回，断言稳定） */
export function instanceDirs(ws) {
  try {
    return fs.readdirSync(path.join(rfDir(ws), "instances"), { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch { return []; }
}

/**
 * 清理**只可能是 mkdtemp 出来的**隔离目录。
 *
 * 硬护栏（任务书 §4）：绝不对真实工作区或 `~/.dsh` 路径做递归删除 ——
 * 路径必须坐落在系统临时目录里、且目录名带 `rf-` 前缀才允许删。
 */
export function cleanupTmp(p) {
  const tmpRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(p);
  const insideTmp = resolved === tmpRoot || resolved.startsWith(tmpRoot.endsWith(path.sep) ? tmpRoot : tmpRoot + path.sep);
  if (!insideTmp || !path.basename(resolved).startsWith("rf-")) {
    throw new Error(`拒绝删除非隔离路径：${resolved}（只允许删 mkdtemp 出来、目录名以 rf- 开头的临时目录）`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

/** mkdtemp 的薄封装：所有临时工作区/构建目录都走它，名字统一带 `rf-` 前缀 */
export function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rf-${prefix}-`));
}
