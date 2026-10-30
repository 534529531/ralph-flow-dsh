/**
 * Ralph Flow for dsh v2 — 验证者 Agent Preset（0.2.1-rc.2+）
 *
 * 0.2.1-rc.2 起 DSH 删除了子代理 start() 的 `persona` / `toolFilter` 入口：
 * 这两个能力只能通过 Agent Preset 声明。验证者的「独立 + 有纪律的只读裁判」身份
 * 因此从逐次请求参数下沉为一份**注册到宿主的 preset**：
 *
 *  - persona 行：`@deepseek-ai/dsh-persona`，正文来自 `VERIFIER_PERSONA`（仍单一来源）；
 *  - 工具面：只挂 read / read_image / grep / glob / bash（含 Windows 的 pwsh 分支），
 *    不挂 write / edit —— 验证者拿不到写工具，而不是靠提示词自律；
 *  - compaction：长取证不因上下文膨胀而中断（与宿主 standard preset 同款）。
 *
 * preset 在插件 apply 时注册到 `agentPresets` 服务；验证调用带 `agentPreset` 选择它。
 * 服务不存在（如 headless 组合未装 preset registry）时注册不会发生，验证调用会在
 * `start()` 处失败并落到 infra 判定 —— 仍然 fail-closed，绝不生成通过判定。
 */
import type { Context } from "@deepseek-ai/cordis";
import { VERIFIER_PERSONA, VERIFIER_PRESET_ID } from "./verify.js";

/** 验证者 preset 的声明形状（与 `@deepseek-ai/dsh-agent-preset` 的 Config 对齐）。 */
export interface VerifierPresetDefinition {
  id: string;
  name: string;
  description: string;
  order: number;
  plugins: unknown[];
}

/**
 * 验证者 preset 的完整声明。
 *
 * 行 id 固定（persona/tool-fs/tool-fs-search/bash/pwsh/compaction），方便在
 * 宿主 preset 编辑器中辨认；preset id 由 verify.ts 的 `VERIFIER_PRESET_ID` 唯一来源。
 */
export function verifierPresetDefinition(): VerifierPresetDefinition {
  const windows = process.platform === "win32";
  return {
    id: VERIFIER_PRESET_ID,
    name: "Ralph Flow Verifier",
    description: "Ralph Flow 的独立只读验证者：只读工具 + 对抗性取证纪律，不写交付物。",
    order: 90,
    plugins: [
      {
        id: "persona",
        name: "@deepseek-ai/dsh-persona",
        config: { prefix: VERIFIER_PERSONA },
      },
      {
        id: "tool-fs",
        name: "@deepseek-ai/dsh-tool-fs",
        config: { read: true, readImage: true, write: false, edit: false },
      },
      {
        id: "tool-fs-search",
        name: "@deepseek-ai/dsh-tool-fs-search",
        config: { sampleOverCapGlobResults: false },
      },
      {
        id: "tool-bash",
        name: "@deepseek-ai/dsh-tool-bash",
        disabled: windows,
      },
      {
        id: "tool-pwsh",
        name: "@deepseek-ai/dsh-tool-pwsh",
        disabled: !windows,
      },
      {
        id: "compaction",
        name: "cordis:group",
        group: true,
        isolate: { compaction: true },
        config: [
          { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
          { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
        ],
      },
    ],
  };
}

interface PresetRegistryFace {
  register(definition: VerifierPresetDefinition): Promise<() => Promise<void>>;
}

interface RegistryContext {
  get?: (name: string) => unknown;
  inject?: (deps: string[], callback: (ctx: Context) => void) => unknown;
  logger?: { warn?: (...args: unknown[]) => void };
}

function registryOf(ctx: Context): PresetRegistryFace | undefined {
  try {
    const registry = (ctx as unknown as RegistryContext).get?.("agentPresets") as PresetRegistryFace | undefined;
    return registry && typeof registry.register === "function" ? registry : undefined;
  } catch {
    return undefined;
  }
}

function logRegisterFailure(ctx: Context, message: string): void {
  try {
    (ctx as unknown as RegistryContext).logger?.warn?.(`[ralphflow] 验证者 preset 注册失败：${message}`);
  } catch {}
}

/** 每个宿主 registry 只注册一次：验证并发时不重复注册同一 id。 */
const registrations = new WeakMap<object, Promise<boolean>>();
/** 缺少 agentPresets 的宿主只尝试一次等待，避免每轮验证都挂一个新的 inject effect。 */
const attemptedWithoutRegistry = new WeakSet<object>();

function registerWith(ctx: Context, registry: PresetRegistryFace): Promise<boolean> {
  return registry.register(verifierPresetDefinition())
    .then((dispose) => {
      // HMR/卸载时注销 preset，避免旧 persona/工具面在进程里滞留。
      try {
        const effect = (ctx as unknown as { effect?: (fn: () => () => Promise<void>, label?: string) => unknown }).effect;
        if (typeof effect === "function") effect(() => dispose, "ralphflow-verifier-preset");
      } catch {}
      return true;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // 插件热重载/重复 apply 会再次注册：同一个 preset 已存在视为就绪。
      if (/Duplicate agent preset/i.test(message)) return true;
      logRegisterFailure(ctx, message);
      return false;
    });
}

/**
 * 注册验证者 preset（best-effort、幂等）。
 *
 * 宿主若尚未激活 `agentPresets` 服务，会等它出现后再注册；始终不激活时不会注册，
 * 验证调用随后 fail-closed。返回值只表示**本次**是否已经发起注册，便于诊断；
 * 调用方不需要等待它（preset 注册与首次验证之间隔着用户的启动/交卷动作）。
 */
export function registerVerifierPreset(ctx: Context): Promise<boolean> {
  const registry = registryOf(ctx);
  if (registry) {
    const existing = registrations.get(registry);
    if (existing) return existing;
    const ready = registerWith(ctx, registry);
    registrations.set(registry, ready);
    return ready;
  }
  // 最小测试上下文（没有 Cordis 的 get()）不代管 preset：调用方自会提供替身。
  if (typeof (ctx as unknown as RegistryContext).get !== "function") return Promise.resolve(true);
  if (attemptedWithoutRegistry.has(ctx)) return Promise.resolve(false);
  attemptedWithoutRegistry.add(ctx);
  try {
    (ctx as unknown as RegistryContext).inject?.(["agentPresets"], (child) => {
      const late = registryOf(child);
      if (late && !registrations.has(late)) registrations.set(late, registerWith(ctx, late));
    });
  } catch {}
  return Promise.resolve(false);
}
