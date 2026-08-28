/**
 * Ralph Flow for dsh — client 端加载冒烟
 *
 * 通过 VM 模拟 dsh 运行时（window.__ModuleLoader__ + seed 模块 react），
 * 真实执行 lib/client.js bundle，验证 factory 注册与 apply/inject 导出，
 * 再调用 apply() 断言插槽/事件/词典注册。
 */
import { readFileSync } from "node:fs";
import vm from "node:vm";

const code = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");

const seed = {
  react: { useState: () => {}, useEffect: () => {}, useRef: () => {}, useMemo: () => {} },
  "react/jsx-runtime": { jsx: () => {}, jsxs: () => {}, Fragment: {} },
};
const factories: Record<string, (r: (s: string) => unknown) => unknown> = {};

const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (o: { id: string; factory: (r: (s: string) => unknown) => unknown }) => { factories[o.id] = o.factory; },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    open: () => {},
  },
  document: {
    querySelector: () => null,
    addEventListener: () => {},
    createElement: () => ({}),
    head: { appendChild: () => {} },
  },
  Event: class {},
  CustomEvent: class {},
  console,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const id = "ralphflow";
if (!factories[id]) {
  console.error("CLIENT SMOKE FAIL — bundle did not register factory", id);
  process.exit(1);
}
const makeRequire = (spec: string): unknown => {
  if (spec in seed) return seed[spec];
  throw new Error(`missing require: ${spec}`);
};
const mod = factories[id](makeRequire) as { apply: (ctx: any) => void; inject: string[]; name: string };
if (!mod.apply || !mod.inject || mod.name !== "ralphflow-client") {
  console.error("CLIENT SMOKE FAIL — bad exports", Object.keys(mod));
  process.exit(1);
}

const registered: string[] = [];
const injected: { slot: string; key?: string }[] = [];
const localized: string[] = [];
const listeners: Record<string, Function[]> = {};
(globalThis as any).window = {
  addEventListener: (t: string, fn: Function) => { (listeners[t] ??= []).push(fn); },
  removeEventListener: (t: string, fn: Function) => { (listeners[t] = (listeners[t] ?? []).filter((f) => f !== fn)); },
  open: () => {},
};

const ctx = {
  conversationEvents: {
    register: (def: any) => { registered.push(`event:${def.kind}`); },
  },
  slots: {
    inject: (slot: string, fn: () => any) => {
      const reg = fn();
      injected.push({ slot, key: reg?.key });
    },
    register: (def: any, _comp: any) => def,
  },
  locale: {
    register: (ns: string, _dict: any) => { localized.push(ns); },
  },
  effect: (fn: Function) => { fn(); return () => {}; },
  logger: { warn() {}, info() {}, error() {} },
};

mod.apply(ctx);

const checks = [
  ["事件定义注册", registered.includes("event:ralphflow-run")],
  ["chat.node 插槽", injected.some((i) => i.slot === "conversation.chat.node" && i.key === "ralphflow-run")],
  ["header.actions 插槽", injected.some((i) => i.slot === "conversation.session.header.actions")],
  ["locale 注册", localized.includes("ralphflow")],
];
for (const [label, ok] of checks) {
  console.log(ok ? "✓" : "✗", label);
}
if (checks.every(([, ok]) => ok)) {
  console.log("CLIENT SMOKE OK");
} else {
  console.error("CLIENT SMOKE FAIL");
  process.exit(1);
}