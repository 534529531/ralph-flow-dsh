/**
 * 实例生命周期验收测试（docs/v2/instance-lifecycle-brief.md「验收标准」1–12）。
 *
 * 不变量：实例是临时的，报告与产出是永久的；先除名后删物理文件；销毁前抢救；
 * 产出只删空目录；销毁后不得再写 state。
 *
 * 纪律：一律 mkdtemp 造工作区 + 隔离 process.env.HOME；绝不 rmSync 真实工作区或真实 .dsh/。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine, makeArtifactsDirName } from "../lib/engine.js";

// HOME 隔离：索引与全局工作流目录都在这里；必须在 createEngine 之前设置。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });

let pass = 0, fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}
const sleep = (ms = 60) => new Promise((r) => setTimeout(r, ms));
const RUN = Math.random().toString(36).slice(2, 8);

const RF = ".dsh/ralph-flow";
// 引擎已改为「按工作区实例化、单根」：全局实例索引与 workspaceOf 的回落一并删除，
// 因此不再需要 forget()/readIndex() 这类索引维护 helper（每个用例的工作区互相隔离）。
function forget(ws) {
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch {}
}
const reportPathOf = (ws, id) => path.join(ws, ".dsh", "ralph-flow", "reports", `${id}.md`);
const artifactsDirOfName = (ws, name) => path.join(ws, ".dsh", "ralph-flow", "artifacts", name);
const stateFileOf = (ws, id) => path.join(ws, ".dsh", "ralph-flow", "instances", id, "state.json");

function mkEngine(ws, scripted = [], logs = [], deliveries = []) {
  return createEngine(ws, {
    deliver: (_sid, text) => { deliveries.push(text); return true; },
    verify: async (req) => {
      const v = scripted.shift();
      if (!v) throw new Error("no scripted verdict");
      return { check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), ...v };
    },
    log: (lvl, ev, d) => logs.push({ lvl, ev, d }),
  });
}
/** start 并返回活跃实例 id（listInstances 只含活跃实例） */
function start(engine, wf, task, sid) {
  const r = engine.start(wf, task, sid);
  return { r, id: engine.listInstances().at(-1)?.id };
}

// ── 1) 完成 → 实例目录消失；报告完整；产出一个字节不少 ────────────────────────
console.log("L1 完成：归档报告 → 销毁实例目录；产出逐字节保留（验收 1/4）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-lc1-"));
  const logs = [], notes = [];
  const engine = mkEngine(ws, [{ status: "passed", reason: "hello.txt 内容正确" }], logs, notes);
  engine.ensureLayout();
  const sid = `lc1-${RUN}`;
  const task = "写一个 hello.txt 并核对 🚀";
  const { id } = start(engine, "loop", task, sid);
  const artName = makeArtifactsDirName(task, id);
  const artDir = artifactsDirOfName(ws, artName);
  fs.writeFileSync(path.join(artDir, "hello.txt"), "hello\n", "utf-8");
  fs.mkdirSync(path.join(artDir, "sub"), { recursive: true });
  const bytes = Buffer.from([0, 1, 2, 250, 255, 128]);
  fs.writeFileSync(path.join(artDir, "sub", "bin.dat"), bytes);

  engine.onSubmit(sid, "完成");
  await sleep();

  check("完成：实例目录被销毁", !fs.existsSync(engine.instanceDir(id)) && engine.readState(id) === null);
  check("完成：state.json 物理消失", !fs.existsSync(stateFileOf(ws, id)));
  const report = fs.readFileSync(reportPathOf(ws, id), "utf-8");
  check("报告：头部字段齐全（实例/状态/任务/开始/结束）",
    report.includes(`- 实例：\`${id}\``) && report.includes("- 状态：**完成**") && report.includes("- 任务：") &&
    report.includes("- 开始：") && report.includes("- 结束："), report.slice(0, 300));
  check("报告：全轨迹 + 全部判定（含验证者的理由）",
    report.includes("## 轨迹") && report.includes("verify_start") && report.includes("## 判定") && report.includes("hello.txt 内容正确"));
  check("产出：文件逐字节不变",
    fs.readFileSync(path.join(artDir, "hello.txt"), "utf-8") === "hello\n" &&
    Buffer.compare(fs.readFileSync(path.join(artDir, "sub", "bin.dat")), bytes) === 0);
  check("产出目录名来自任务 slug（而非裸 instId）", fs.existsSync(artDir) && artDir.endsWith(artName));
  // 正常终态 = 报告存在 + 产出存在 + 实例目录不存在 → doctor 不得误报
  const doc = engine.diagnose().text;
  check("doctor 不把正常终态当异常（无实例目录异常 / 孤儿产出）",
    !doc.includes("实例目录异常") && !doc.includes("孤儿产出"), doc.slice(-400));
  forget(ws);
}

// ── 2) 取消 → 同上，报告状态为「取消」；消息给精确相对路径（验收 2/6）──────────
console.log("\nL2 取消：同样归档 + 销毁；消息含精确相对路径且文件存在（验收 2/6）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-lc2-"));
  const notes = [];
  const engine = mkEngine(ws, [], [], notes);
  engine.ensureLayout();
  const sid = `lc2-${RUN}`;
  const task = "取消用例";
  const { id } = start(engine, "loop", task, sid);
  const artName = makeArtifactsDirName(task, id);
  fs.writeFileSync(path.join(artifactsDirOfName(ws, artName), "keep.md"), "keep\n", "utf-8");
  notes.length = 0;

  const r = engine.cancelInstance(sid, undefined, "用户中止");
  check("取消成功", r.ok, r.text);
  check("取消：实例目录被销毁", !fs.existsSync(engine.instanceDir(id)) && engine.readState(id) === null);
  const report = fs.readFileSync(reportPathOf(ws, id), "utf-8");
  check("报告状态为「取消」", report.includes("- 状态：**取消**"), report.slice(0, 200));
  check("取消：非空产出保留", fs.existsSync(path.join(artifactsDirOfName(ws, artName), "keep.md")));

  const rel = `${RF}/reports/${id}.md`;
  const cancelNote = notes.find((t) => t.includes(id) && t.includes("已取消"));
  check("取消消息含精确相对路径", !!cancelNote && cancelNote.includes(rel), cancelNote?.slice(0, 200));
  check("取消消息里的路径文件确实存在（fs.existsSync 断言）", fs.existsSync(path.join(ws, rel)), path.join(ws, rel));
  forget(ws);
}

// ── 3) 产出为空 → 产出目录一并消失（验收 3）──────────────────────────────────
console.log("\nL3 空产出目录随实例销毁一并消失（验收 3）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-lc3-"));
  const engine = mkEngine(ws, [{ status: "passed", reason: "ok" }]);
  engine.ensureLayout();
  const sid = `lc3-${RUN}`;
  const { id } = start(engine, "loop", "空产出用例", sid);
  const artDir = artifactsDirOfName(ws, makeArtifactsDirName("空产出用例", id));
  check("启动时产出目录已建好", fs.existsSync(artDir));
  engine.onSubmit(sid, "完成");
  await sleep();
  check("空产出目录被 rmdir 删除", !fs.existsSync(artDir), artDir);
  forget(ws);
}

// ── 4) 列表语义：listInstances 只活跃；listHistory / listAll 有历史入口（验收 5）─
console.log("\nL4 列表语义与历史入口（验收 5）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-lc4-"));
  const engine = mkEngine(ws, [{ status: "passed", reason: "ok" }]);
  engine.ensureLayout();
  const sid = `lc4-${RUN}`;
  const task = "历史入口用例";
  const { id } = start(engine, "loop", task, sid);
  engine.onSubmit(sid, "完成");
  await sleep();

  check("listInstances() 不含已结束实例", !engine.listInstances().some((i) => i.id === id));
  const hist = engine.listHistory();
  const hit = hist.find((h) => h.id === id);
  check("listHistory() 列出归档运行（解析成功）", !!hit && hit.parsed, JSON.stringify(hit));
  check("历史条目字段齐全（id/状态/任务/结束时间/报告路径）",
    !!hit && hit.statusLabel === "完成" && hit.task === task && !!hit.endedAt && hit.relPath === `${RF}/reports/${id}.md`,
    JSON.stringify(hit));

  // 无法解析的报告也必须列出（标注「无法解析」），不得静默丢弃
  fs.writeFileSync(reportPathOf(ws, "broken-report"), "这不是报告\n", "utf-8");
  const broken = engine.listHistory().find((h) => h.id === "broken-report");
  check("解析失败的报告仍被列出且标注无法解析", !!broken && !broken.parsed && broken.statusLabel === "无法解析");

  const text = engine.listAll().text;
  const [activePart, historyPart] = text.split("## 历史运行（已归档）");
  check("listAll 分「活跃实例」与「历史运行（已归档）」两节", text.includes("## 活跃实例") && !!historyPart);
  check("已结束实例不在活跃节", !activePart.includes(`### \`${id}\``), activePart.slice(0, 200));
  check("历史节列出该实例（含报告路径）", historyPart.includes(`### \`${id}\``) && historyPart.includes(`${RF}/reports/${id}.md`));
  check("历史节末尾给出 reports/ 相对路径", historyPart.includes(`${RF}/reports/`));
  forget(ws);
}

// ── 5) 完成消息精确相对路径 + 状态查询指向已销毁实例的报告（验收 6 / 边界 4）────
console.log("\nL5 完成消息精确路径 + statusOf 对已销毁实例指向报告（验收 6）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-lc5-"));
  const notes = [];
  const engine = mkEngine(ws, [{ status: "passed", reason: "ok" }], [], notes);
  engine.ensureLayout();
  const sid = `lc5-${RUN}`;
  const { id } = start(engine, "loop", "完成消息用例", sid);
  notes.length = 0;
  engine.onSubmit(sid, "完成");
  await sleep();

  const rel = `${RF}/reports/${id}.md`;
  const doneNote = notes.find((t) => t.includes("完成") && t.includes(id));
  check("完成消息含精确相对路径", !!doneNote && doneNote.includes(rel), doneNote?.slice(0, 200));
  check("完成消息路径文件存在（fs.existsSync 断言）", fs.existsSync(path.join(ws, rel)));

  const st = engine.statusOf(sid, id);
  check("statusOf(已销毁实例) 指向报告且不谎称「没有实例」",
    st.ok && st.text.includes(rel) && st.text.includes("已结束并销毁"), st.text.slice(0, 200));
  const stMissing = engine.statusOf(sid, "no-such-instance-xyz");
  check("statusOf(查不到且无报告) 明说找不到", stMissing.text.includes("找不到"), stMissing.text.slice(0, 120));
  forget(ws);
}

// ── 6) 报告归档失败 → 不销毁（验收 7）────────────────────────────────────────
console.log("\nL6 报告归档失败：保留实例目录 + state.json + 索引，并告警（验收 7）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-lc6-"));
  const logs = [], notes = [];
  const engine = mkEngine(ws, [{ status: "passed", reason: "ok" }], logs, notes);
  engine.ensureLayout();
  const sid = `lc6-${RUN}`;
  const { id } = start(engine, "loop", "归档失败用例", sid);

  // 用**同名普通文件**占位 reports/：mkdir/write 全部 ENOTDIR，稳定复现写失败。
  const reportsDir = path.join(ws, ".dsh", "ralph-flow", "reports");
  fs.rmSync(reportsDir, { recursive: true, force: true });
  fs.writeFileSync(reportsDir, "occupied");

  notes.length = 0;
  engine.onSubmit(sid, "完成");
  await sleep();

  try {
    check("归档失败：实例目录仍在", fs.existsSync(engine.instanceDir(id)));
    check("归档失败：state.json 仍在", fs.existsSync(stateFileOf(ws, id)));
    check("归档失败：state.json 已落「已结束」（doctor 才能报出）", engine.readState(id)?.active === false);
    check("归档失败：不再出现在活跃列表（active=false）", !engine.listInstances().some((i) => i.id === id));
    check("归档失败：doctor 报出「已结束但目录未被销毁」", engine.diagnose().text.includes("已结束但目录未被销毁"), engine.diagnose().text.slice(-200));
    check("归档失败：日志记 report_archive_failed", logs.some((l) => l.ev === "report_archive_failed"), JSON.stringify(logs.map((l) => l.ev)));
    check("归档失败：向用户发出告警（含「未销毁」）", notes.some((t) => t.includes("未销毁") && t.includes(id)), notes.at(-1)?.slice(0, 160));
    check("归档失败：报告确实没生成", !fs.existsSync(reportPathOf(ws, id)));
    const doc = engine.diagnose().text;
    check("doctor 报出「已结束但目录未被销毁」", doc.includes("已结束但目录未被销毁") && doc.includes(id), doc.slice(-400));
  } finally {
    fs.rmSync(reportsDir, { recursive: true, force: true });
    fs.mkdirSync(reportsDir, { recursive: true });
  }
  forget(ws);
}

// ── 7) 幽灵防护：递归删除失败也必须已除名（验收 8）──────────────────────────
console.log("\nL7 幽灵防护：注入 rmSync 失败 → state.json 已不在、列表不含鬼影（验收 8）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-lc7-"));
  const logs = [];
  const engine = mkEngine(ws, [{ status: "passed", reason: "ok" }], logs);
  engine.ensureLayout();
  const sid = `lc7-${RUN}`;
  const { id } = start(engine, "loop", "幽灵防护用例", sid);

  const realRmSync = fs.rmSync;
  fs.rmSync = () => { throw new Error("EBUSY: injected recursive-delete failure"); };
  try {
    engine.onSubmit(sid, "完成");
    await sleep();
  } finally {
    fs.rmSync = realRmSync;
  }

  try {
    check("递归删除失败：state.json 已不在（先除名）", !fs.existsSync(stateFileOf(ws, id)));
    check("递归删除失败：实例目录仍残留（如实播报的前提）", fs.existsSync(path.join(ws, RF, "instances", id)));
    check("递归删除失败：listInstances() 不含鬼影", !engine.listInstances().some((i) => i.id === id));
    check("递归删除失败：告警可诊断", logs.some((l) => l.ev === "instance_dir_remove_failed"), JSON.stringify(logs.map((l) => l.ev)));
    const text = engine.listAll().text;
    const activePart = text.split("## 历史运行（已归档）")[0];
    check("递归删除失败：活跃节不含该实例", !activePart.includes(`### \`${id}\``));
    check("递归删除失败：报告已归档（历史仍在）", fs.existsSync(reportPathOf(ws, id)));
  } finally {
    try { fs.rmSync(engine.instanceDir(id), { recursive: true, force: true }); } catch {}
  }
  forget(ws);
}

// ── 8) doctor 三类实例目录异常 + 孤儿产出（验收 9）──────────────────────────
console.log("\nL8 doctor 报实例目录异常与孤儿产出（只报不删，验收 9）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-lc8-"));
  const engine = mkEngine(ws);
  engine.ensureLayout();
  const instRoot = path.join(ws, ".dsh", "ralph-flow", "instances");
  fs.mkdirSync(path.join(instRoot, "a-missing"), { recursive: true });
  fs.mkdirSync(path.join(instRoot, "b-corrupt"), { recursive: true });
  fs.writeFileSync(path.join(instRoot, "b-corrupt", "state.json"), "{ definitely-not-json", "utf-8");
  fs.mkdirSync(path.join(instRoot, "c-ended"), { recursive: true });
  fs.writeFileSync(path.join(instRoot, "c-ended", "state.json"), JSON.stringify({ active: false }), "utf-8");
  const orphan = path.join(ws, ".dsh", "ralph-flow", "artifacts", "orphan-dir");
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, "x.txt"), "x", "utf-8");

  const doc = engine.diagnose().text;
  check("报「缺少 state.json」", doc.includes("缺少 state.json") && doc.includes("a-missing"), doc.slice(-600));
  check("报「state.json 损坏」", doc.includes("损坏") && doc.includes("b-corrupt"));
  check("报「已结束但目录未被销毁」", doc.includes("已结束但目录未被销毁") && doc.includes("c-ended"));
  check("报孤儿产出目录", doc.includes("孤儿产出") && doc.includes("orphan-dir"));
  check("只报不删（目录与文件都还在）",
    fs.existsSync(path.join(instRoot, "a-missing")) && fs.existsSync(path.join(instRoot, "b-corrupt", "state.json")) &&
    fs.existsSync(path.join(instRoot, "c-ended", "state.json")) && fs.existsSync(path.join(orphan, "x.txt")));
  forget(ws);
}

// ── 9) 迟到判定护栏：销毁后回调不得写盘/复活目录（验收 10）────────────────────
console.log("\nL9 迟到判定：销毁后到达的验证回调不得复活实例目录（验收 10）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-lc9-"));
  const logs = [];
  let resolveVerify;
  const engine = createEngine(ws, {
    deliver: () => true,
    verify: () => new Promise((r) => { resolveVerify = r; }),
    log: (lvl, ev, d) => logs.push({ lvl, ev, d }),
  });
  engine.ensureLayout();
  const sid = `lc9-${RUN}`;
  const { id } = start(engine, "loop", "迟到判定用例", sid);
  engine.onSubmit(sid, "完成");
  await sleep();
  engine.cancelInstance(sid, undefined, "中途取消");
  check("取消后实例目录已销毁", !fs.existsSync(engine.instanceDir(id)));

  // 模拟真实 dsh driver 的 aborted 路径：被中止的委派仍会「正常 resolve」一笔判定。
  resolveVerify({ check_index: 0, step_id: "loop", ts: new Date().toISOString(), status: "passed", reason: "迟到的通过" });
  await sleep(120);

  check("迟到判定被丢弃（记 instance_state_missing）",
    logs.some((l) => l.ev === "verdict_discarded" && l.d?.reason === "instance_state_missing"), JSON.stringify(logs.filter((l) => l.ev === "verdict_discarded")));
  check("迟到判定未复活实例目录", !fs.existsSync(engine.instanceDir(id)) && engine.readState(id) === null);
  forget(ws);
}

// ── 10) 老 state.json（无 artifacts_dir_name）仍可读，产出目录回退 instId（验收 11）
console.log("\nL10 老 state.json 兼容：产出目录回退 instId（验收 11）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-lc10-"));
  const engine = mkEngine(ws, [{ status: "passed", reason: "ok" }]);
  engine.ensureLayout();
  const sid = `lc10-${RUN}`;
  const task = "老格式兼容用例";
  const { id } = start(engine, "loop", task, sid);
  const sf = stateFileOf(ws, id);
  const raw = JSON.parse(fs.readFileSync(sf, "utf-8"));
  check("新实例已写入 artifacts_dir_name", typeof raw.artifacts_dir_name === "string" && raw.artifacts_dir_name.length > 0, JSON.stringify(raw.artifacts_dir_name));
  delete raw.artifacts_dir_name;
  fs.writeFileSync(sf, JSON.stringify(raw, null, 2), "utf-8");

  const st = engine.readState(id);
  check("老 state.json 仍可读", !!st && st.active === true);
  check("缺字段 → 产出目录回退 instId", engine.artifactsDirOf(id).endsWith(path.join("artifacts", id)), engine.artifactsDirOf(id));
  check("产出相对路径同样回退 instId", engine.artifactsRelDirOf(id).endsWith(`/artifacts/${id}`), engine.artifactsRelDirOf(id));
  engine.onSubmit(sid, "完成");
  await sleep();
  const report = fs.readFileSync(reportPathOf(ws, id), "utf-8");
  check("归档报告也用回退后的产出目录", report.includes(`/artifacts/${id}/`), report.slice(0, 400));
  forget(ws);
}

// ── 11) 产出目录名：中文/emoji 不被切碎、不越界（验收 12）────────────────────
console.log("\nL11 产出目录名 slug：码点截断 + 路径安全（验收 12）");
{
  const emojiTask = "🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉 中文任务里塞满 emoji 🚀🧪";
  const name = makeArtifactsDirName(emojiTask, "loop-abc123-tail9");
  check("不含替换字符 U+FFFD", !name.includes("\uFFFD"), name);
  check("不含路径分隔符 / 与 \\", !name.includes("/") && !name.includes("\\"), name);
  check("不含 ..", !name.includes(".."), name);
  check("非空且带实例尾段", name.length > 0 && name.endsWith("-tail9"), name);
  const slugPart = name.slice(0, name.lastIndexOf("-"));
  check("slug 按码点截 30 以内", Array.from(slugPart).length <= 30, `${Array.from(slugPart).length}`);

  const evil = makeArtifactsDirName("../../etc/passwd", "loop-x-y7y7");
  check("路径穿越任务被净化", !evil.includes("/") && !evil.includes("\\") && !evil.includes(".."), evil);

  // 真跑一遍：任务含 emoji，实际目录名与状态字段一致
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-lc11-"));
  const engine = mkEngine(ws, [{ status: "passed", reason: "ok" }]);
  engine.ensureLayout();
  const { id } = start(engine, "loop", emojiTask, `lc11-${RUN}`);
  const st = engine.readState(id);
  check("启动时 state.artifacts_dir_name 已落盘且与目录一致",
    st.artifacts_dir_name === makeArtifactsDirName(emojiTask, id) && fs.existsSync(artifactsDirOfName(ws, st.artifacts_dir_name)),
    JSON.stringify(st.artifacts_dir_name));
  forget(ws);
}

// ── 12) 单根销毁：路径解析不再有任何回落，实例目录必须真的消失 ────────────────
// 曾经的缺陷：destroyInstance 先除名索引，再经 workspaceOf() = registry[instId] ?? projectDir
// 解析路径 —— 跨工作区时删除静默打空（unlink 的 catch 是空的、rmSync 带 force）。
// 索引与回落已随「引擎按工作区实例化」删除：引擎根**就是**会话工作区，路径只有一根。
// 这条用例守住「销毁是真删，不是调用过删除」。
console.log("\nL12 单根销毁：实例目录必须真的消失（不再有路径回落）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-lc12-"));
  const notes = [];
  const engine = mkEngine(ws, [{ status: "passed", reason: "ok" }], [], notes);
  const sid = `lc12-${RUN}`;
  const r = engine.start("loop", "单根销毁用例", sid);
  const id = engine.listInstances().at(-1).id;
  const realInstDir = path.join(ws, RF, "instances", id);
  const realStateFile = path.join(realInstDir, "state.json");
  check("实例落在引擎根（前置条件）", r.ok && fs.existsSync(realStateFile), realInstDir);
  check("engine.instanceDir 与真实路径逐字一致（不再有回落）", engine.instanceDir(id) === realInstDir, engine.instanceDir(id));
  engine.onSubmit(sid, "完成");
  await sleep();
  check("完成后实例目录消失（不再静默残留）", !fs.existsSync(realInstDir), realInstDir);
  check("state.json 一并消失（先 unlink 后删目录）", !fs.existsSync(realStateFile));
  check("readState 为 null", engine.readState(id) === null);
  check("报告归档在引擎根", fs.existsSync(reportPathOf(ws, id)));
  check("完成播报说「实例目录已销毁」（与事实一致）", notes.some((t) => t.includes("实例目录已销毁")), notes.at(-1)?.slice(0, 200));
  forget(ws);
}

// ── 13) 销毁失败必须诚实：删不掉就别说「已销毁」，且 doctor 要报得出残留 ──────────
console.log("\nL13 销毁失败：播报不得谎称已销毁（+ 删除失败不静默）");
{
  // 13a) 确定性注入：把 state.json 占位成**目录** → unlinkSync 必失败（EISDIR，任何权限下都失败）。
  // 直接驱动导出的 destroyInstance（传内存 state）：若走 onSubmit，readState 会因 EISDIR 读不出实例，
  // 交卷根本不受理 —— 那样测的就不是 unlink 失败分支了。
  const wsA = fs.mkdtempSync(path.join(os.tmpdir(), "rf-lc13a-"));
  const notesA = [], logsA = [];
  const engineA = mkEngine(wsA, [], logsA, notesA);
  engineA.ensureLayout();
  const sidA = `lc13a-${RUN}`;
  const { id: idA } = start(engineA, "loop", "unlink 失败用例", sidA);
  const savedA = engineA.readState(idA);
  fs.rmSync(stateFileOf(wsA, idA), { force: true });
  fs.mkdirSync(stateFileOf(wsA, idA)); // 目录占位 → unlinkSync 必 EISDIR
  const resA = engineA.destroyInstance(idA, "done", savedA);
  check("state.json 删除失败**不静默**（记 state_unlink_failed）",
    logsA.some((l) => l.ev === "state_unlink_failed"), JSON.stringify(logsA.map((l) => l.ev)));
  check("返回结构如实说明目录已删（instanceDirRemoved=true）",
    !!resA && resA.instanceDirRemoved === true, JSON.stringify(resA));
  check("实例目录仍被递归删掉（该失败不阻断销毁）", !fs.existsSync(path.join(wsA, RF, "instances", idA)));
  check("报告仍已归档", fs.existsSync(reportPathOf(wsA, idA)));
  forget(wsA);

  // 13b) 注入「目录删不掉」：instances 父目录不可写（非高权限运行时 EACCES）
  const wsB = fs.mkdtempSync(path.join(os.tmpdir(), "rf-lc13b-"));
  const notesB = [], logsB = [];
  const engineB = mkEngine(wsB, [{ status: "passed", reason: "ok" }], logsB, notesB);
  engineB.ensureLayout();
  const sidB = `lc13b-${RUN}`;
  const { id: idB } = start(engineB, "loop", "销毁失败用例", sidB);
  const instDirB = path.join(wsB, RF, "instances", idB);
  const parentB = path.join(wsB, RF, "instances");
  fs.chmodSync(parentB, 0o500);
  try {
    engineB.onSubmit(sidB, "完成");
    await sleep();
    if (fs.existsSync(instDirB)) {
      // 注入生效：删除确实失败 → 播报必须诚实
      check("播报不谎称「实例目录已销毁」", !notesB.some((t) => t.includes("实例目录已销毁")), notesB.at(-1)?.slice(0, 240));
      check("播报如实说明未销毁 + 指向 doctor",
        notesB.some((t) => t.includes("实例目录未能删除") && t.includes("ralphflow-doctor")), notesB.at(-1)?.slice(0, 320));
      check("失败留下可诊断日志（instance_dir_remove_failed / instance_dir_not_removed）",
        logsB.some((l) => l.ev === "instance_dir_remove_failed" || l.ev === "instance_dir_not_removed"), JSON.stringify(logsB.map((l) => l.ev)));
      check("报告仍已归档（归档与删除解耦）", fs.existsSync(reportPathOf(wsB, idB)));
      check("doctor 报出该残留（缺 state.json 的实例目录）",
        engineB.diagnose().text.includes(idB), engineB.diagnose().text.slice(-260));
      check("不再出现在活跃列表（不复活成幽灵）", !engineB.listInstances().some((i) => i.id === idB));
    } else {
      // 高权限环境（root）下 chmod 挡不住删除：改为断言成功路径的自洽性，并明确标注
      console.log("  ⚠️  本环境无法注入删除失败（权限过高），13b 改为断言成功路径的自洽性");
      check("高权限下删除成功且播报与事实一致", notesB.some((t) => t.includes("实例目录已销毁")));
    }
  } finally {
    fs.chmodSync(parentB, 0o700);
  }
  fs.rmSync(instDirB, { recursive: true, force: true });
  forget(wsB);

  // 13c) 取消路径同样诚实：删不掉时回执与通知都不得说「已销毁」
  const wsC = fs.mkdtempSync(path.join(os.tmpdir(), "rf-lc13c-"));
  const notesC = [], logsC = [];
  const engineC = mkEngine(wsC, [], logsC, notesC);
  engineC.ensureLayout();
  const sidC = `lc13c-${RUN}`;
  const { id: idC } = start(engineC, "loop", "取消失败用例", sidC);
  const instDirC = path.join(wsC, RF, "instances", idC);
  const parentC = path.join(wsC, RF, "instances");
  fs.chmodSync(parentC, 0o500);
  try {
    const res = engineC.cancelInstance(sidC, undefined, "测试取消");
    await sleep();
    if (fs.existsSync(instDirC)) {
      check("取消回执不谎称已销毁、如实说明残留",
        res.ok && !res.text.includes("已销毁") && res.text.includes("实例目录未能删除"), res.text);
      check("取消通知同样诚实（含 doctor 指引）",
        notesC.some((t) => t.includes("实例目录未能删除") && t.includes("ralphflow-doctor")), notesC.at(-1)?.slice(0, 300));
      check("取消也留下可诊断日志",
        logsC.some((l) => l.ev === "instance_dir_remove_failed" || l.ev === "instance_dir_not_removed"), JSON.stringify(logsC.map((l) => l.ev)));
      check("取消报告仍已归档", fs.existsSync(reportPathOf(wsC, idC)));
    } else {
      console.log("  ⚠️  本环境无法注入删除失败（权限过高），13c 改为断言成功路径的自洽性");
      check("高权限下取消删除成功且回执不谎称残留", res.ok && !res.text.includes("未能删除"), res.text);
    }
  } finally {
    fs.chmodSync(parentC, 0o700);
  }
  fs.rmSync(instDirC, { recursive: true, force: true });
  forget(wsC);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
