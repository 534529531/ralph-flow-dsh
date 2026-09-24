/**
 * 委派生命周期：跟随 dsh 原生能力，不设 ralphflow 自造的超时。
 *
 * 设计取舍（作者定案）：我们用的是宿主的原生委派能力，就该跟随它的契约。
 * dsh 沿革：subagent / subagent-in-process-driver / agent-loop 对整次子代理运行
 * **都不设上界**；上层只提供请求级防护（dsh-llm-deepseek 的 streamIdleTimeoutMs
 * 空闲看门狗，默认 5min，收到 chunk 即重新计时）。宿主在迭代（更完善的取消/看门狗），
 * 跟随它才能吃到迭代红利；自造超时反而会与其契约脱节。
 *
 * 本文件断言「我们与原生契约一致」的三件事：
 *   1. 委派只传 dsh 要求的取消句柄（signal），不注入自造超时；
 *   2. 取消（cancel/实例结束）能真正中止在飞验证者；
 *   3. 验证者结果原样交给判定解析（structured 优先，文本兜底，fail-closed）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine } from "../lib/engine.js";
import { runVerifier, parseVerdict } from "../lib/verify.js";

let pass = 0, fail = 0;
const check = (n, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${n}`); } else { fail++; console.error(`  ✗ ${n} ${e}`); } };
const sleep = (ms = 60) => new Promise((r) => setTimeout(r, ms));

console.log("D1 委派请求只带 dsh 契约字段，不注入自造超时");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-native-"));
  let captured = null;
  const ctx = {
    subagents: {
      list: () => ["spawn"],
      getProvider: () => ({ capabilities: { outputSchema: true } }),
      start: async (_n, req) => {
        captured = req;
        return { id: "child", result: Promise.resolve({ output: [], structured: { passed: true, reason: "ok" }, stopReason: "completed" }) };
      },
    },
    tools: { schemas: () => [{ name: "read" }] },
    agents: { get: () => undefined },
  };
  const e = createEngine(ws, { deliver: () => true, verify: (r) => runVerifier({ ctx }, r), log: () => {} });
  e.ensureLayout();
  e.start("loop", "原生字段", "d1");
  e.onSubmit("d1", "完成");
  await sleep(120);

  check("委派已发出", !!captured);
  check("带 dsh 要求的取消句柄 signal", captured?.signal instanceof AbortSignal);
  check("未注入自造超时字段（timeoutMs/deadline/timeout）",
    !("timeoutMs" in (captured ?? {})) && !("deadline" in (captured ?? {})) && !("timeout" in (captured ?? {})) && !("controller" in (captured ?? {})),
    JSON.stringify(Object.keys(captured ?? {})));
  const ip = path.join(os.homedir(), ".dsh", "ralphflow-instances-index.json");
  const idx = JSON.parse(fs.readFileSync(ip, "utf-8"));
  for (const k of Object.keys(idx)) if (idx[k] === ws) delete idx[k];
  fs.writeFileSync(ip, JSON.stringify(idx, null, 2));
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nD2 取消能真正中止在飞验证者（原生取消语义）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-cancel-"));
  let aborted = false;
  let resolveVerify;
  const e = createEngine(ws, {
    deliver: () => true,
    verify: (req) => new Promise((resolve) => {
      resolveVerify = resolve;
      req.signal.addEventListener("abort", () => { aborted = true; resolve({ check_index: req.checkIndex, step_id: req.step.id, ts: new Date().toISOString(), status: "infra", reason: "已中止" }); });
    }),
    log: () => {},
  });
  e.ensureLayout();
  const sid = "d2";
  e.start("loop", "取消中止", sid);
  const iid = e.listInstances().at(-1).id;
  e.onSubmit(sid, "完成");
  await sleep(80);
  check("验证在飞", e.readState(iid).delegations.length === 1);

  e.cancelInstance(sid, undefined, "用户中止");
  await sleep(80);
  check("取消真正传播到在飞验证者（signal aborted）", aborted);
  const st = e.readState(iid);
  check("实例已取消且报告归档", !st.active && fs.existsSync(path.join(ws, "ralph-flow", "reports", `${iid}.md`)));
  check("在飞委派已清空", st.delegations.length === 0);
  void resolveVerify;
  const ip = path.join(os.homedir(), ".dsh", "ralphflow-instances-index.json");
  const idx = JSON.parse(fs.readFileSync(ip, "utf-8"));
  for (const k of Object.keys(idx)) if (idx[k] === ws) delete idx[k];
  fs.writeFileSync(ip, JSON.stringify(idx, null, 2));
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nD3 判定解析：structured 优先，文本兜底，解析不出 → infra（fail-closed）");
{
  const sid = "loop";
  const v1 = parseVerdict({ structured: { passed: false, reason: "证据不足" } }, sid, 0);
  check("structured 优先且尊重 passed=false", v1.status === "failed" && v1.reason === "证据不足");

  const v2 = parseVerdict({ output: [{ type: "text", text: "取证过程…\n<promise-check>true</promise-check>" }] }, sid, 0);
  check("文本标签兜底（原生 structured 不可用时）", v2.status === "passed", v2.status);

  const v3 = parseVerdict({ output: [{ type: "text", text: "我觉得还行吧" }] }, sid, 0);
  check("解析不出判定 → infra（绝不默认通过）", v3.status === "infra", v3.status);

  const v4 = parseVerdict({ output: [], stopReason: "aborted" }, sid, 0);
  check("中止/无输出 → infra", v4.status === "infra", v4.status);
}

console.log("\nD4 验证者判定通道：原生 structured 优先，文本标记仅在降级时要求");
{
  let captured = null;
  const mk = (caps) => ({
    subagents: {
      list: () => ["spawn"],
      getProvider: () => ({ capabilities: caps }),
      start: async (_n, req) => {
        captured = req;
        return { id: "c", result: Promise.resolve({ structured: { passed: true, reason: "ok" }, output: [], stopReason: "completed" }) };
      },
    },
    tools: { schemas: () => [{ name: "read" }] },
    agents: { get: () => undefined },
  });
  const wf = { name: "loop", steps: [{ id: "s", check: "核对 X" }], manual_step: [], warnings: [] };
  const req = () => ({ instId: "t", step: wf.steps[0], workflow: wf, userTask: "u", submitSummary: "", checkIndex: 0, signal: new AbortController().signal });

  await runVerifier({ ctx: mk({ outputSchema: true }) }, req());
  const p1 = captured.prompt[0].text;
  check("structured 可用 → 传 outputSchema", !!captured.outputSchema);
  check("structured 可用 → 要求 structured_output 工具", /structured_output/.test(p1));
  check("structured 可用 → **不再**要求 <promise-check> 文本标记", !/promise-check/.test(p1));

  await runVerifier({ ctx: mk({ outputSchema: false, toolFilter: true, persona: true, agentOptions: true, depthLimit: true }) }, req());
  const p2 = captured.prompt[0].text;
  check("structured 不可用 → 不传 outputSchema", !captured.outputSchema);
  check("structured 不可用 → 降级要求文本标记", /promise-check/.test(p2));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
