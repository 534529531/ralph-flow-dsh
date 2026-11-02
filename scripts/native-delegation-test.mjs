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
import { createEngine, voterCountOf } from "../lib/engine.js";
import { runVerifier, parseVerdict, VERIFIER_PERSONA, VERIFIER_PRESET_ID } from "../lib/verify.js";
import { verifierPresetDefinition } from "../lib/verifier-preset.js";

import { deliveryPorts } from "./helpers/ports.mjs";
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
      getProvider: () => ({ capabilities: { outputSchema: true, agentPreset: true }, inheritsParentContext: false }),
      startActivation: async (spec) => {
        captured = spec;
        return { childId: "child", result: Promise.resolve({ output: [], structured: { passed: true, reason: "ok" }, stopReason: "completed" }) };
      },
    },
    tools: { schemas: () => [{ name: "read" }] },
    agents: { get: () => undefined },
  };
  const e = createEngine(ws, { ...deliveryPorts(), verify: (r) => runVerifier({ ctx }, r), log: () => {} });
  e.ensureLayout();
  const startRes = e.start("loop", "原生字段", "d1");

  // ── §1.7 产出目录：DO 与 CHECK 提示词都注入，且验证者按相对路径读得到 ──────
  // 目录名 = 任务摘要 slug + instId 尾段，可能含中文/emoji，故用宽松的相对路径正则。
  const relRe = /\.dsh\/ralph-flow\/artifacts\/[^/`\s]+/;
  check("DO 提示词含落点行 + 工作区相对路径", startRes.text.includes("## 落点") && relRe.test(startRes.text), startRes.text.slice(-260));
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

  const prompt = captured?.request?.prompt?.[0]?.text ?? "";
  check("CHECK 提示词含本步上下文与落点行", prompt.includes("## 本步上下文") && prompt.includes("## 落点"));
  check("CHECK 提示词含交付物（DO 的 output 承诺）", prompt.includes("交付物") && prompt.includes("实现的代码/文件"), prompt.slice(0, 400));
  // 回归：验证者曾被副本带偏（RA2 取证原文把「产出目录 summary.md 与仓库 summary.md 逐字节相同」
  // 判成了正确）。CHECK 必须写明落点边界，并明说工作目录里的副本是落点错误、不算满足。
  check("CHECK 提示词写明过程记录/交付物落点边界",
    prompt.includes("过程记录") && prompt.includes("交付物") && prompt.includes("明确路径"), prompt.slice(0, 600));
  check("CHECK 提示词明说工作目录里的副本不算满足",
    prompt.includes("副本") && prompt.includes("不算满足"), prompt.slice(0, 600));
  const rel = prompt.match(relRe)?.[0];
  check("CHECK 提示词含工作区相对产出路径", !!rel, prompt.slice(0, 300));
  check("DO/CHECK 指向同一个产出目录", !!rel && rel === relFromDo, JSON.stringify({ rel, relFromDo }));
  if (rel) {
    const abs = path.join(ws, rel);
    const seen = fs.readFileSync(path.join(abs, "summary.md"), "utf-8");
    check("验证者按该相对路径读得到产出（继承会话工作区，无需额外权限）", seen.includes("verified-by-check"));
    check("实例销毁后非空产出目录与文件原样保留", fs.existsSync(path.join(abs, "summary.md")));
  }
  fs.rmSync(ws, { recursive: true, force: true });
}

console.log("\nD2 取消能真正中止在飞验证者（原生取消语义）");
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "rf-cancel-"));
  let aborted = false;
  let resolveVerify;
  const e = createEngine(ws, {
    ...deliveryPorts(),
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
  // 内置 loop 是多验证者投票步：一次交卷并发 N 笔委派（每票一笔），取消要**全部**传播
  check("验证在飞（每票一笔并发委派）", e.readState(iid).delegations.length === voterCountOf(e.loadWorkflow("loop").def.steps[0]));

  e.cancelInstance(sid, undefined, "用户中止");
  await sleep(80);
  check("取消真正传播到在飞验证者（signal aborted）", aborted);
  const reportPath = path.join(ws, ".dsh", "ralph-flow", "reports", `${iid}.md`);
  const report = fs.readFileSync(reportPath, "utf-8");
  check("实例已取消并销毁", e.readState(iid) === null && !fs.existsSync(e.instanceDir(iid)));
  check("取消报告已归档且状态为「取消」", /状态：\*\*取消\*\*/.test(report), report.slice(0, 200));
  check("取消后不再出现在活跃实例列表", !e.listInstances().some((i) => i.id === iid));
  void resolveVerify;
  // 单根模型：取消即从本工作区的 instances/ 消失（上面已断言），没有索引要复核
  check("取消后本工作区实例目录已消失", !fs.existsSync(e.instanceDir(iid)));
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

console.log("\nD4 验证者判定通道：原生 structured 优先，文本标记仅在降级时要求；角色说明经 Agent Preset 的 persona 行传入");
{
  let captured = null;
  const ALL = { outputSchema: true, agentPreset: true };
  const mk = (caps = ALL) => ({
    subagents: {
      list: () => ["spawn"],
      getProvider: () => ({ capabilities: caps, inheritsParentContext: false }),
      startActivation: async (spec) => {
        captured = spec;
        return { childId: "c", result: Promise.resolve({ structured: { passed: true, reason: "ok" }, output: [], stopReason: "completed" }) };
      },
    },
    tools: { schemas: () => [{ name: "read" }] },
    agents: { get: () => undefined },
  });
  const wf = { name: "loop", steps: [{ id: "s", check: "核对 X" }], manual_step: [], warnings: [] };
  const req = () => ({ instId: "t", step: wf.steps[0], workflow: wf, userTask: "u", checkIndex: 0, artifactsRelDir: ".dsh/ralph-flow/artifacts/t", signal: new AbortController().signal });

  await runVerifier({ ctx: mk({ outputSchema: true, agentPreset: true }) }, req());
  const p1 = captured.request.prompt[0].text;
  check("structured 可用 → 传 outputSchema", !!captured.request.outputSchema);
  check("structured 可用 → 要求 structured_output 工具", /structured_output/.test(p1));
  check("structured 可用 → **不再**要求 <promise-check> 文本标记", !/promise-check/.test(p1));

  await runVerifier({ ctx: mk({ outputSchema: false, agentPreset: true, agentOptions: true, depthLimit: true }) }, req());
  const p2 = captured.request.prompt[0].text;
  check("structured 不可用 → 不传 outputSchema", !captured.request.outputSchema);
  check("structured 不可用 → 降级要求文本标记", /promise-check/.test(p2));

  // 角色说明只有一份、且经 Agent Preset 的 persona 行传入；任务消息正文只留事实
  await runVerifier({ ctx: mk() }, req());
  const p3 = captured.request.prompt[0].text;
  check("委派选择 ralphflow-verifier preset（0.2.1-rc.2+ 的 persona/工具面通道）", captured.request.agentPreset === VERIFIER_PRESET_ID, String(captured.request.agentPreset));
  check("不再逐请求传 persona/toolFilter（宿主已删除这两个入口）", !("persona" in captured.request) && !("toolFilter" in captured.request), JSON.stringify(Object.keys(captured.request)));
  const preset = verifierPresetDefinition();
  const personaRow = preset.plugins.find((row) => row.id === "persona");
  check("preset 的 persona 行承载验证者角色说明（单一来源）", personaRow?.config?.prefix === VERIFIER_PERSONA, JSON.stringify(personaRow?.config).slice(0, 80));
  const fsRow = preset.plugins.find((row) => row.id === "tool-fs");
  check("preset 不提供 write/edit（只读工具面）", fsRow?.config?.write === false && fsRow?.config?.edit === false && fsRow?.config?.read === true, JSON.stringify(fsRow?.config));
  check("preset 不挂任何写工具行", !preset.plugins.some((row) => /tool-fs|tool-bash|tool-pwsh/.test(row.id) && row.config?.write === true) &&
    preset.plugins.some((row) => row.id === "tool-bash") && preset.plugins.some((row) => row.id === "tool-fs-search"), JSON.stringify(preset.plugins.map((row) => row.id)));
  check("任务消息正文不再拼入角色说明（不重复表达）", !p3.includes(VERIFIER_PERSONA) && !p3.includes("你是严格、独立、对抗性的检查者"), p3.slice(0, 100));
  check("步骤 check 仍完整到达验证者", p3.includes("## 检查依据") && p3.includes("核对 X"), p3.slice(0, 200));
  check("验证请求不含执行者交卷摘要", !("submitSummary" in captured.request) && !/执行者交卷摘要/.test(p3), JSON.stringify(Object.keys(captured.request)));
  // 模型覆盖经 DSH 原生 agentOptions 传给验证者；没有覆盖时不传（宿主继承父级 = 发起会话当前模型）
  await runVerifier({ ctx: mk() }, { ...req(), model: { providerID: "openai", modelID: "gpt-5" } });
  check("模型覆盖经原生 agentOptions 传递（不由提示词要求模型自切）", captured.request.agentOptions?.provider === "openai" && captured.request.agentOptions?.model === "gpt-5", JSON.stringify(captured.request.agentOptions));
  await runVerifier({ ctx: mk() }, req());
  check("没有模型覆盖 → 不传 agentOptions（宿主 resolveChildAgentOptions 继承父级）", !("agentOptions" in captured.request), JSON.stringify(Object.keys(captured.request)));
  // 旧版（0.2.0 / 0.2.1-alpha）兼容：没有 agentPreset 能力时回退 person/toolFilter 通道
  {
    const legacyCtx = mk({ outputSchema: true, persona: true, toolFilter: true });
    legacyCtx.subagents.startActivation = undefined;
    legacyCtx.subagents.start = async (name, request) => {
      captured = { legacy: true, name, request };
      return { id: "legacy", result: Promise.resolve({ structured: { passed: true, reason: "ok" }, output: [], stopReason: "completed" }) };
    };
    legacyCtx.tools = { schemas: () => [{ name: "read" }, { name: "write" }, { name: "bash" }] };
    const v = await runVerifier({ ctx: legacyCtx }, req());
    check("旧版后端（无 agentPreset）→ 回退 legacy 通道", v.status === "passed" && captured.legacy === true, JSON.stringify(v));
    check("legacy 通道仍传 persona/toolFilter（只读白名单）", captured.request.persona === VERIFIER_PERSONA &&
      JSON.stringify(captured.request.toolFilter) === JSON.stringify({ allow: ["read", "bash"] }), JSON.stringify(captured.request.toolFilter));
  }
}

console.log("\nD5 后端选择按能力判定、与名字无关，且绝不落到继承上下文的后端");
{
  const wf = { name: "loop", steps: [{ id: "s", check: "核对 X" }], manual_step: [], warnings: [] };
  const req = () => ({ instId: "t", step: wf.steps[0], workflow: wf, userTask: "u", checkIndex: 0, artifactsRelDir: ".dsh/ralph-flow/artifacts/t", signal: new AbortController().signal });
  const ALL = { outputSchema: true, agentPreset: true };
  /** providers: { 名字: provider 描述 } —— list() 返回其键；start 计数用于断言「先委派后判定」不会漏网 */
  const mk = (providers) => {
    let startCalls = 0;
    const started = [];
    const ctx = {
      subagents: {
        list: () => Object.keys(providers),
        getProvider: (n) => providers[n],
        startActivation: async (spec) => {
          startCalls++;
          started.push(spec.provider);
          return { childId: "c", result: Promise.resolve({ structured: { passed: true, reason: "ok" }, output: [], stopReason: "completed" }) };
        },
        start: async (name) => {
          startCalls++;
          started.push(name);
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
    const m = mk({ fork: { capabilities: ALL, inheritsParentContext: true }, spawn: { capabilities: { outputSchema: true }, inheritsParentContext: false } });
    const v = await runVerifier({ ctx: m.ctx }, req());
    check("全新后端既无 agentPreset 也无旧版 persona/toolFilter → infra", v.status === "infra", JSON.stringify(v));
    check("理由点名缺失的能力（agentPreset / persona / toolFilter）", /agentPreset/.test(v.reason) && /persona/.test(v.reason) && /toolFilter/.test(v.reason), v.reason);
    check("缺能力时不调用 start（不等抛 UNSUPPORTED_CAPABILITY）", m.startCalls() === 0, `startCalls=${m.startCalls()}`);
  }
  {
    // 旧版 persona/toolFilter 后端仍可被选中（向后兼容），但优先 agentPreset。
    const m = mk({ legacy: { capabilities: { outputSchema: true, persona: true, toolFilter: true }, inheritsParentContext: false } });
    const v = await runVerifier({ ctx: m.ctx }, req());
    check("只有旧版 persona/toolFilter 能力的全新后端 → 选中并走 legacy", v.status === "passed" && m.started[0] === "legacy", JSON.stringify({ s: v.status, n: m.started }));
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

console.log("\nD6 兜底配方退役：无 check 的步骤不得被委派（fail-closed，绝不静默生成通用配方）");
{
  const ALL = { outputSchema: true, agentPreset: true };
  let startCalls = 0;
  const ctx = {
    subagents: {
      list: () => ["fresh"],
      getProvider: () => ({ capabilities: ALL, inheritsParentContext: false }),
      startActivation: async () => {
        startCalls++;
        return { childId: "c", result: Promise.resolve({ structured: { passed: true, reason: "ok" }, output: [], stopReason: "completed" }) };
      },
    },
    tools: { schemas: () => [{ name: "read" }] },
    agents: { get: () => undefined },
  };
  const wf = { name: "skip", steps: [{ id: "a", do: "X" }], manual_step: [], warnings: [] };
  const v = await runVerifier({ ctx }, {
    instId: "t", step: wf.steps[0], workflow: wf, userTask: "u", checkIndex: 0,
    artifactsRelDir: ".dsh/ralph-flow/artifacts/t", signal: new AbortController().signal,
  });
  check("无 check 的步骤 → 判定为 infra（fail-closed，绝不是 passed）", v.status === "infra", JSON.stringify(v));
  check("infra 理由点名 check（明确失败，不静默）", /check/.test(v.reason), v.reason);
  check("无 check 的步骤 → 委派一次都没发生（start 调用为 0）", startCalls === 0, `startCalls=${startCalls}`);
}

console.log("D7 子代理池满：验证委派排队等槽，不把判定打成 infra");
{
  const step = { id: "s", desc: "d", do: "do it", check: "ok", input: "i", output: "o", on_pass: "done", on_fail: "s", max_fail_count: 1 };
  const wf = { name: "wf", steps: [step], warnings: [] };
  const req = () => ({
    instId: "x", step, workflow: wf, userTask: "task", checkIndex: 0,
    artifactsRelDir: ".dsh/ralph-flow/artifacts/x", signal: new AbortController().signal,
  });
  let attempts = 0;
  const poolFull = {
    subagents: {
      list: () => ["spawn"],
      getProvider: () => ({ capabilities: { outputSchema: true, agentPreset: true }, inheritsParentContext: false }),
      startActivation: async () => {
        attempts += 1;
        if (attempts <= 2) {
          const error = new Error("subagent limit reached (active child limit: 8); wait for an existing child to finish");
          error.code = "ACTIVATION_LIMIT_REACHED";
          throw error;
        }
        return { childId: "child", result: Promise.resolve({ output: [], structured: { passed: true, reason: "ok" }, stopReason: "completed" }) };
      },
    },
    tools: { schemas: () => [{ name: "read" }] },
    agents: { get: () => undefined },
  };
  const verdict = await runVerifier({ ctx: poolFull }, req());
  check("槽位满时等待重试，最终拿到判定（不报 infra）", attempts === 3 && verdict.status === "passed", JSON.stringify({ attempts, status: verdict.status }));

  let boomCount = 0;
  const boom = {
    subagents: {
      list: () => ["spawn"],
      getProvider: () => ({ capabilities: { outputSchema: true, agentPreset: true }, inheritsParentContext: false }),
      startActivation: async () => { boomCount += 1; throw new Error("provider exploded"); },
    },
    tools: { schemas: () => [{ name: "read" }] },
    agents: { get: () => undefined },
  };
  const failed = await runVerifier({ ctx: boom }, req());
  check("非槽位错误不重试，fail-closed 成 infra", boomCount === 1 && failed.status === "infra", JSON.stringify({ boomCount, status: failed.status }));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
