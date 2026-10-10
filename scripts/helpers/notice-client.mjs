import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const chat = fs.readFileSync(new URL("../../node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js", import.meta.url), "utf8");
// Execute the installed host's predicate verbatim; fail loudly if its implementation moves.
const predicate = chat.match(/function isVisibleChatNode\(node\) \{[\s\S]*?\n\s*\}/)?.[0];
if (!predicate) throw new Error("installed Chat visibility predicate not found");
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
