/**
 * 委派生命周期：跟随 dsh 原生能力，不设 ralphflow 自造的超时。
 *
 * 设计取舍（作者定案）：我们用的是宿主的原生委派能力，就该跟随它的契约。
 * dsh 沿革：subagent / subagent-in-process-driver / agent-loop 对整次子代理运行
 * **都不设上界**；上层只提供请求级防护（dsh-llm-deepseek 的 streamIdleTimeoutMs
 * 空闲看门狗，默认 5min，收到 chunk 即重新计时）。宿主在迭代（更完善的取消/看门狗），
 * 跟随它才能吃到迭代红利；自造超时反而会与其契约脱节。
 *
 * 本文件断言「我们与原生契约一致」的四件事：
 *   1. 委派只传 dsh 要求的取消句柄（signal），不注入自造超时；
 *   2. 取消（cancel/实例结束）能真正中止在飞验证者；
 *   3. 验证者结果原样交给判定解析（structured 优先，文本兜底，fail-closed）；
 *   4. 后端**按能力**选择（全新上下文 + persona/toolFilter），与名字无关，绝不落到 `fork`。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEngine } from "../lib/engine.js";
import { runVerifier, parseVerdict, VERIFIER_PERSONA } from "../lib/verify.js";

// HOME 隔离（任务书 §4 工作协议）：测试绝不读写真实 ~/.dsh（索引/全局工作流目录都在这里）。
// 必须在 createEngine / apply 之前设置，因为引擎在创建时解析 os.homedir()。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ralphflow-home-"));
fs.mkdirSync(path.join(process.env.HOME, ".dsh"), { recursive: true });


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
      getProvider: () => ({ capabilities: { outputSchema: true, persona: true, toolFilter: true }, inheritsParentContext: false }),
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
  const startRes = e.start("loop", "原生字段", "d1");

  // ── §1.7 产出目录：DO 与 CHECK 提示词都注入，且验证者按相对路径读得到 ──────
  // 目录名 = 任务摘要 slug + instId 尾段，可能含中文/emoji，故用宽松的相对路径正则。
  const relRe = /\.dsh\/ralph-flow\/artifacts\/[^/`\s]+/;
  check("DO 提示词含产出目录行 + 工作区相对路径", startRes.text.includes("## 产出目录") && relRe.test(startRes.text), startRes.text.slice(-260));
  const relFromDo = startRes.text.match(relRe)?.[0];
  // 先把真实产出写进去，再交卷 —— 它必须在实例销毁后原样存活。
  if (relFromDo) fs.writeFileSync(path.join(ws, relFromDo, "summary.md"), "verified-by-check\n", "utf-8");

  e.onSubmit("d1", "完成");
  await sleep(120);

  check("委派已发出", !!captured);
  check("带 dsh 要求的取消句柄 signal", captured?.signal instanceof AbortSignal);
  check("未注入自造超时字段（timeoutMs/deadline/timeout）",
    !("timeoutMs" in (captured ?? {})) && !("deadline" in (captured ?? {})) && !("timeout" in (captured ?? {})) && !("controller" in (captured ?? {})),
    JSON.stringify(Object.keys(captured ?? {})));

  const prompt = captured?.prompt?.[0]?.text ?? "";
  check("CHECK 提示词含本步上下文与产出目录行", prompt.includes("## 本步上下文") && prompt.includes("**产出目录**"));
  check("CHECK 提示词含交付物（DO 的 output 承诺）", prompt.includes("交付物") && prompt.includes("summary.md"), prompt.slice(0, 400));
  const rel = prompt.match(relRe)?.[0];
  check("CHECK 提示词含工作区相对产出路径", !!rel, prompt.slice(0, 300));
  check("DO/CHECK 指向同一个产出目录", !!rel && rel === relFromDo, JSON.stringify({ rel, relFromDo }));
  if (rel) {
    const abs = path.join(ws, rel);
    const seen = fs.readFileSync(path.join(abs, "summary.md"), "utf-8");
    check("验证者按该相对路径读得到产出（继承会话工作区，无需额外权限）", seen.includes("verified-by-check"));
    check("实例销毁后非空产出目录与文件原样保留", fs.existsSync(path.join(abs, "summary.md")));
  }
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
  const reportPath = path.join(ws, ".dsh", "ralph-flow", "reports", `${iid}.md`);
  const report = fs.readFileSync(reportPath, "utf-8");
  check("实例已取消并销毁", e.readState(iid) === null && !fs.existsSync(e.instanceDir(iid)));
  check("取消报告已归档且状态为「取消」", /状态：\*\*取消\*\*/.test(report), report.slice(0, 200));
  check("取消后不再出现在活跃实例列表", !e.listInstances().some((i) => i.id === iid));
  void resolveVerify;
  const ip = path.join(os.homedir(), ".dsh", "ralphflow-instances-index.json");
  const idx = JSON.parse(fs.readFileSync(ip, "utf-8"));
  check("索引已立即除名", !(iid in idx), JSON.stringify(Object.keys(idx)));
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

console.log("\nD4 验证者判定通道：原生 structured 优先，文本标记仅在降级时要求；角色说明只经 persona 传入");
{
  let captured = null;
  const ALL = { outputSchema: true, persona: true, toolFilter: true };
  const mk = (caps = ALL) => ({
    subagents: {
      list: () => ["spawn"],
      getProvider: () => ({ capabilities: caps, inheritsParentContext: false }),
      start: async (name, req) => {
        captured = { name, req };
        return { id: "c", result: Promise.resolve({ structured: { passed: true, reason: "ok" }, output: [], stopReason: "completed" }) };
      },
    },
    tools: { schemas: () => [{ name: "read" }] },
    agents: { get: () => undefined },
  });
  const wf = { name: "loop", steps: [{ id: "s", check: "核对 X" }], manual_step: [], warnings: [] };
  const req = () => ({ instId: "t", step: wf.steps[0], workflow: wf, userTask: "u", checkIndex: 0, artifactsRelDir: ".dsh/ralph-flow/artifacts/t", signal: new AbortController().signal });

  await runVerifier({ ctx: mk({ outputSchema: true, persona: true, toolFilter: true }) }, req());
  const p1 = captured.req.prompt[0].text;
  check("structured 可用 → 传 outputSchema", !!captured.req.outputSchema);
  check("structured 可用 → 要求 structured_output 工具", /structured_output/.test(p1));
  check("structured 可用 → **不再**要求 <promise-check> 文本标记", !/promise-check/.test(p1));

  await runVerifier({ ctx: mk({ outputSchema: false, toolFilter: true, persona: true, agentOptions: true, depthLimit: true }) }, req());
  const p2 = captured.req.prompt[0].text;
  check("structured 不可用 → 不传 outputSchema", !captured.req.outputSchema);
  check("structured 不可用 → 降级要求文本标记", /promise-check/.test(p2));

  // 角色说明只有一份、且经 persona 通道传入；任务消息正文只留事实
  await runVerifier({ ctx: mk() }, req());
  const p3 = captured.req.prompt[0].text;
  check("persona 通道承载验证者角色说明（单一来源）", captured.req.persona === VERIFIER_PERSONA, String(captured.req.persona).slice(0, 40));
  check("任务消息正文不再拼入角色说明（不重复表达）", !p3.includes(VERIFIER_PERSONA) && !p3.includes("你是严格、独立、对抗性的检查者"), p3.slice(0, 100));
  check("步骤 check 仍完整到达验证者", p3.includes("## 检查依据") && p3.includes("核对 X"), p3.slice(0, 200));
  check("验证请求不含执行者交卷摘要", !("submitSummary" in captured.req) && !/执行者交卷摘要/.test(p3), JSON.stringify(Object.keys(captured.req)));
  // 模型覆盖经 DSH 原生 agentOptions 传给验证者；没有覆盖时不传（宿主继承父级 = 发起会话当前模型）
  await runVerifier({ ctx: mk() }, { ...req(), model: { providerID: "openai", modelID: "gpt-5" } });
  check("模型覆盖经原生 agentOptions 传递（不由提示词要求模型自切）", captured.req.agentOptions?.provider === "openai" && captured.req.agentOptions?.model === "gpt-5", JSON.stringify(captured.req.agentOptions));
  await runVerifier({ ctx: mk() }, req());
  check("没有模型覆盖 → 不传 agentOptions（宿主 resolveChildAgentOptions 继承父级）", !("agentOptions" in captured.req), JSON.stringify(Object.keys(captured.req)));
}

console.log("\nD5 后端选择按能力判定、与名字无关，且绝不落到继承上下文的后端");
{
  const wf = { name: "loop", steps: [{ id: "s", check: "核对 X" }], manual_step: [], warnings: [] };
  const req = () => ({ instId: "t", step: wf.steps[0], workflow: wf, userTask: "u", checkIndex: 0, artifactsRelDir: ".dsh/ralph-flow/artifacts/t", signal: new AbortController().signal });
  const ALL = { outputSchema: true, persona: true, toolFilter: true };
  /** providers: { 名字: provider 描述 } —— list() 返回其键；start 计数用于断言「先委派后判定」不会漏网 */
  const mk = (providers) => {
    let startCalls = 0;
    const started = [];
    const ctx = {
      subagents: {
        list: () => Object.keys(providers),
        getProvider: (n) => providers[n],
        start: async (n) => {
          startCalls++;
          started.push(n);
          return { id: "c", result: Promise.resolve({ structured: { passed: true, reason: "ok" }, output: [], stopReason: "completed" }) };
        },
      },
      tools: { schemas: () => [{ name: "read" }] },
      agents: { get: () => undefined },
    };
    return { ctx, startCalls: () => startCalls, started };
  };

  // ① 只有继承上下文的后端 → infra，且 start **一次都没被调用**
  {
    const m = mk({ fork: { capabilities: ALL, inheritsParentContext: true } });
    const v = await runVerifier({ ctx: m.ctx }, req());
    check("list=[fork]（inheritsParentContext=true）→ infra", v.status === "infra", JSON.stringify(v));
    check("list=[fork] → start 一次都没被调用（不是先委派后判定）", m.startCalls() === 0, `startCalls=${m.startCalls()}`);
    check("infra 理由写明「本部署没有全新上下文的委派后端」", /本部署没有全新上下文的委派后端/.test(v.reason), v.reason);
  }
  // ② 判定与名字无关：全新上下文的后端叫什么都行
  {
    const m = mk({ fork: { capabilities: ALL, inheritsParentContext: true }, fresh: { capabilities: ALL, inheritsParentContext: false } });
    const v = await runVerifier({ ctx: m.ctx }, req());
    check("list=[fork,fresh] → 选中 fresh（跳过继承上下文的 fork）", v.status === "passed" && m.started[0] === "fresh", JSON.stringify({ s: v.status, n: m.started }));
  }
  {
    const m = mk({ fresh: { capabilities: ALL, inheritsParentContext: false } });
    const v = await runVerifier({ ctx: m.ctx }, req());
    check("list=[fresh]（不叫 spawn）→ 同样选中 fresh", v.status === "passed" && m.started[0] === "fresh", JSON.stringify({ s: v.status, n: m.started }));
  }
  // ③ 全新上下文但缺能力 → infra，理由点名缺哪个，且不调用 start
  {
    const m = mk({ fork: { capabilities: ALL, inheritsParentContext: true }, spawn: { capabilities: { outputSchema: true, toolFilter: true }, inheritsParentContext: false } });
    const v = await runVerifier({ ctx: m.ctx }, req());
    check("全新后端缺 persona → infra", v.status === "infra", JSON.stringify(v));
    check("理由点名缺失的能力 persona", /persona/.test(v.reason), v.reason);
    check("缺能力时不调用 start（不等抛 UNSUPPORTED_CAPABILITY）", m.startCalls() === 0, `startCalls=${m.startCalls()}`);
  }
  {
    const m = mk({ spawn: { capabilities: { outputSchema: true, persona: true }, inheritsParentContext: false } });
    const v = await runVerifier({ ctx: m.ctx }, req());
    check("全新后端缺 toolFilter → infra 且理由点名 toolFilter", v.status === "infra" && /toolFilter/.test(v.reason), JSON.stringify(v));
  }
  // ④ 现网 list()=["spawn","fork"] 只作正向用例（真实部署里 spawn 永远在，构造不出失败分支）
  {
    const m = mk({ spawn: { capabilities: ALL, inheritsParentContext: false }, fork: { capabilities: ALL, inheritsParentContext: true } });
    const v = await runVerifier({ ctx: m.ctx }, req());
    check("现网 list=[spawn,fork] → 正向选中 spawn", v.status === "passed" && m.started[0] === "spawn", JSON.stringify({ s: v.status, n: m.started }));
  }
  // ⑤ `agent` 字段已从公开契约删除：写进 YAML 也不再影响后端选择
  {
    const m = mk({ fork: { capabilities: ALL, inheritsParentContext: true }, fresh: { capabilities: ALL, inheritsParentContext: false } });
    const v = await runVerifier({ ctx: m.ctx }, { ...req(), workflow: { ...wf, adversarial_check: { agent: "fork" } } });
    check("adversarial_check.agent 不再影响后端选择（仍选 fresh，绝不落到 fork）", v.status === "passed" && m.started[0] === "fresh", JSON.stringify({ s: v.status, n: m.started }));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
