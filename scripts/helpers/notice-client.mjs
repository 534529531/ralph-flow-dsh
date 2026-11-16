import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const chat = fs.readFileSync(new URL("../../node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js", import.meta.url), "utf8");
// Execute the installed host's predicate verbatim; fail loudly if its implementation moves.
// Locate the function tolerating both pretty output (`…) {`) and rc.3's minified output (`…){`),
// then take its balanced-brace body. A regex that assumes a newline before the closing brace
// silently finds nothing once the host minifies.
const head = /function\s+isVisibleChatNode\s*\(node\)\s*\{/.exec(chat);
if (!head) throw new Error("installed Chat visibility predicate not found");
const open = head.index + head[0].length - 1;
let depth = 0;
let end = -1;
let quote = "";
let escaped = false;
let lineComment = false;
let blockComment = false;
for (let i = open; i < chat.length; i++) {
  const ch = chat[i];
  const next = chat[i + 1];
  if (lineComment) {
    if (ch === "\n") lineComment = false;
    continue;
  }
  if (blockComment) {
    if (ch === "*" && next === "/") { blockComment = false; i++; }
    continue;
  }
  if (quote) {
    if (escaped) { escaped = false; continue; }
    if (ch === "\\") { escaped = true; continue; }
    if (ch === quote) quote = "";
    continue;
  }
  if (ch === "/" && next === "/") { lineComment = true; i++; continue; }
  if (ch === "/" && next === "*") { blockComment = true; i++; continue; }
  if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
  if (ch === "{") depth++;
  else if (ch === "}" && --depth === 0) { end = i + 1; break; }
}
if (end < 0) throw new Error("installed Chat visibility predicate has unbalanced braces");
const predicate = chat.slice(head.index, end);
export const isVisibleChatNode = vm.runInNewContext(`(${predicate})`);

/** Load the published factory and collect its real Definition and renderer registration. */
export function loadNoticeClient({ disabled = false } = {}) {
  let entry;
  vm.runInNewContext(fs.readFileSync(new URL("../../lib/client.js", import.meta.url), "utf8"), {
    window: { __ModuleLoader__: { load: (record) => { entry = record; } } },
  });
  const plugin = entry.factory((id) => {
    // Status transport is verified by status-source-test and real web, outside this notice-only harness.
    if (id === "@deepseek-ai/dsh-api-gateway/client" || id === "@deepseek-ai/dsh-client-ui-primitives") return {};
    return require(id);
  });
  const definitions = [], renderers = new Map();
  if (!disabled) plugin.apply({
    inject() {},
    uiConversation: { events: { register: (def) => definitions.push(def) } },
    slots: {
      inject(_name, setup) { return setup(); },
      register: ({ key }, render) => { renderers.set(key, render); },
    },
  });
  return {
    definitions, renderers,
    nodes(events) {
      return events.flatMap((event) => definitions.flatMap((def) => {
        const match = def.match(event);
        if (!match) return [];
        const context = { key: `${def.kind}:${match.id}`, id: match.id,
          start: { ...match, event, location: { kind: "step" } } };
        context.state = def.start(context, context.start);
        return [def.buildViewNode(context)].filter(Boolean);
      }));
    },
    visible(event) {
      return this.nodes([event]).some((node) => {
        if (!isVisibleChatNode(node)) return false;
        const row = renderers.get(node.kind)?.({ node });
        return row?.type === "details" && row.props.children[0]?.type === "summary"
          && row.props.children[0].props.children === event.data.source.summary;
      });
    },
  };
}
