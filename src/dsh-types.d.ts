/**
 * Ralph Flow for dsh — dsh 服务接口的本地类型声明
 *
 * 官方包的 Context 声明通过 declare module 合并；此处声明本插件实际用到的
 * 服务面（subagents/commands/sessions/agents/jobs），避免依赖类型缺失。
 */
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { JobHooks, JobKindMap, JobStart } from "@deepseek-ai/dsh-jobs";
import type { SessionId } from "@deepseek-ai/dsh-session";

declare module "js-yaml" {
  const yaml: {
    load(text: string): unknown;
    loadAll(text: string): unknown[];
  };
  export default yaml;
  export const load: (text: string) => unknown;
  export const loadAll: (text: string) => unknown[];
  export const dump: (obj: unknown) => string;
}

declare module "@deepseek-ai/dsh-session" {
  interface SessionEventMap {
    "tool-ralphflow/run-start": { runId: string; workflow: string; task: string; steps: { id: string; desc: string }[] };
    "tool-ralphflow/step-start": { runId: string; step: string; phase: "do" | "check"; failCount: number };
    "tool-ralphflow/check-verdict": { runId: string; step: string; voter: number; count: number; model: string; status: "pass" | "fail" | "infra"; reasoning: string };
    "tool-ralphflow/check-result": { runId: string; step: string; passed: boolean; reason?: string };
    "tool-ralphflow/gate": { runId: string; step: string; title: string; reason: string; diffSummary?: string };
    "tool-ralphflow/rewind": { runId: string; fromStep: string; toStep: string; reason: string };
    "tool-ralphflow/reset": { runId: string; step: string; reason?: string };
    "tool-ralphflow/report": { runId: string; text: string; reportPath?: string };
    "tool-ralphflow/run-end": { runId: string; stopReason: "done" | "cancelled" | "failed"; reportId?: string };
  }
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    tools: {
      register(def: unknown): void;
      get?(name: string): { execute(args: unknown, exec: unknown): Promise<unknown> | unknown } | undefined;
    };
    jobs: {
      attachController(name: string): void;
      start(spec: JobStart): string;
      kill(id: string, caller?: unknown, reason?: string): void;
      get?(id: string): unknown;
    };
    commands: {
      register(def: {
        name: string;
        description?: string;
        handler: (line: string, exec: any) => Promise<{ success: boolean; text?: string }> | { success: boolean; text?: string };
      }): void;
    };
    sessions: {
      get(id: string): {
        id: string;
        header?: { cwd?: string };
        events: readonly { type: string; data?: unknown }[];
        on?(t: string, l: (s: unknown, e: { type: string; data?: unknown }) => void): () => void;
        append?(t: string, d: unknown): unknown;
      } | undefined;
      list(): { id: string; header?: { cwd?: string } }[];
    };
    agents: {
      get(id: string): Agent | undefined;
    };
    subagents: {
      start(name: string, request: any): Promise<{
        result: Promise<{ output?: unknown; stopReason?: string }>;
      }>;
    };
    effect(fn: () => unknown | (() => void), name?: string): () => void;
    logger: {
      warn(...args: unknown[]): void;
      info(...args: unknown[]): void;
      error(...args: unknown[]): void;
    };
  }
}

declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    ralphflow: "ralphflow";
  }
}

export type { Agent, JobHooks, JobStart, JobKindMap, SessionId };