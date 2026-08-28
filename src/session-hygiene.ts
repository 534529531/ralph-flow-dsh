/**
 * Ralph Flow for dsh — 会话卫生：检测与修复「插件自定义事件帧砖化会话」
 *
 * 背景：dsh 会话日志落盘后若含未知事件类型（不在 KNOWN_SESSION_EVENT_TYPES
 * 且未标 ignorable），加载时被 SessionFormatUnsupportedError 拒绝——整个会话
 * 打不开（会话变砖）。历史版本曾用 session.append 写 tool-ralphflow/* 自定义
 * 帧，已砖化过真实会话（见 scripts/unbrick-sessions.mjs 与 ~/.dsh/unbrick-*）。
 *
 * 本模块（v2 架构）：
 *  - scanSessionLogs：扫描 $DSH_HOME/sessions 下全部 .zstd 会话日志，检出含
 *    tool-ralphflow 事件帧的会话（doctor 报告 / unbrick 工具共用）；
 *  - unbrickSessions：备份后移除这些帧，按 dsh 多帧 zstd 格式重写（header
 *    单帧 + 事件分批帧，与 dsh-session-persistence 的 frame-boundary 语义对齐）。
 * 压缩走系统 zstd CLI（与 dsh 全链路同款工具，插件无 JS 压缩依赖；缺失时
 * 给出明确指引而非静默失败）。
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 本插件写过的全部自定义帧类型（检测/移除名单） */
const PLUGIN_EVENT_TYPES = new Set([
  "tool-ralphflow/run-start",
  "tool-ralphflow/run-detach",
  "tool-ralphflow/step-start",
  "tool-ralphflow/check-voter-start",
  "tool-ralphflow/check-verdict",
  "tool-ralphflow/check-result",
  "tool-ralphflow/gate",
  "tool-ralphflow/rewind",
  "tool-ralphflow/reset",
  "tool-ralphflow/report",
  "tool-ralphflow/run-end",
  "tool-ralphflow/command-result",
]);

/** 会话存储根：$DSH_HOME/sessions（尊重 DSH_HOME，缺省 ~/.dsh） */
export function sessionRoot(): string {
  const home = process.env.DSH_HOME && path.isAbsolute(process.env.DSH_HOME)
    ? process.env.DSH_HOME
    : path.join(os.homedir(), ".dsh");
  return path.join(home, "sessions");
}

function zstdAvailable(): boolean {
  try { execSync("zstd --version", { stdio: "ignore" }); return true; } catch { return false; }
}

function listSessionLogs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      // 跳过解砖备份目录（历史 v2 脚本与内置模块的备份都可能含待移除帧）
      if (e.isDirectory() && /(^|-)(ralphflow-)?unbrick-backup-/.test(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".zstd")) out.push(p);
    }
  };
  walk(root);
  return out;
}

function decodeLog(file: string): string[] | null {
  try {
    const text = execSync("zstd -d -c", {
      input: fs.readFileSync(file),
      maxBuffer: 512 * 1024 * 1024,
    }).toString("utf-8");
    return text.split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

function pluginFrameCount(lines: string[]): { count: number; types: string[] } {
  const types = new Map<string, number>();
  for (const line of lines) {
    try {
      const type = JSON.parse(line)?.type;
      if (typeof type === "string" && PLUGIN_EVENT_TYPES.has(type)) {
        types.set(type, (types.get(type) ?? 0) + 1);
      }
    } catch {}
  }
  const sorted = [...types.entries()].sort((a, b) => b[1] - a[1]);
  return { count: sorted.reduce((n, [, c]) => n + c, 0), types: sorted.map(([t, c]) => `${t}×${c}`) };
}

export interface SessionScanEntry {
  /** 会话文件（绝对路径） */
  file: string;
  /** 待移除的插件帧总数 */
  count: number;
  /** 类型分布（人读摘要，如 ["tool-ralphflow/command-result×3"]） */
  types: string[];
}

/** 扫描全部会话存储，返回含插件自定义帧的会话（只读，不修改） */
export function scanSessionLogs(): SessionScanEntry[] {
  const out: SessionScanEntry[] = [];
  if (!zstdAvailable()) return out;
  const root = sessionRoot();
  if (!fs.existsSync(root)) return out;
  for (const file of listSessionLogs(root)) {
    try {
      const lines = decodeLog(file);
      if (!lines) continue;
      const { count, types } = pluginFrameCount(lines);
      if (count > 0) out.push({ file, count, types });
    } catch {}
  }
  return out;
}

/** 多帧 zstd：第一帧 header 单独成帧，其余事件按批次独立成帧（v2 正确格式） */
function encodeMultiFrame(lines: string[]): Buffer {
  if (lines.length === 0) throw new Error("empty log");
  const frames: Buffer[] = [];
  const headerLine = lines[0];
  frames.push(execSync("zstd -q -f -c", {
    input: Buffer.from(headerLine + "\n", "utf-8"),
    maxBuffer: 64 * 1024 * 1024,
  }));
  const BATCH = 64;
  const rest = lines.slice(1);
  for (let i = 0; i < rest.length; i += BATCH) {
    const chunk = rest.slice(i, i + BATCH);
    frames.push(execSync("zstd -q -f -c", {
      input: Buffer.from(chunk.join("\n") + "\n", "utf-8"),
      maxBuffer: 64 * 1024 * 1024,
    }));
  }
  return Buffer.concat(frames);
}

export interface UnbrickResult {
  scanned: number;
  fixed: number;
  backupRoot: string | null;
  fixedFiles: string[];
  errors: string[];
}

/**
 * 解砖：备份并移除全部插件自定义帧。
 * skipFreshMs 内的文件跳过（可能是正在运行的进程仍在写——例如当前宿主进程
 * 自己；解砖对象应是已停写的历史会话）。
 */
export function unbrickSessions(skipFreshMs = 60_000): UnbrickResult {
  const result: UnbrickResult = { scanned: 0, fixed: 0, backupRoot: null, fixedFiles: [], errors: [] };
  if (!zstdAvailable()) {
    result.errors.push("系统未安装 zstd CLI（`zstd --version` 失败）。安装 zstd 后重试，或手动运行 scripts/unbrick-sessions.mjs。");
    return result;
  }
  const root = sessionRoot();
  if (!fs.existsSync(root)) {
    result.errors.push(`未找到会话目录：${root}`);
    return result;
  }
  const files = listSessionLogs(root);
  result.scanned = files.length;
  const now = Date.now();
  const backupRoot = path.join(root, "ralphflow-unbrick-backup-" + Date.now());
  let backupCreated = false;
  for (const file of files) {
    try {
      const st = fs.statSync(file);
      if (now - st.mtimeMs < skipFreshMs) continue; // 活跃写盘中的会话不动
      const lines = decodeLog(file);
      if (!lines) {
        result.errors.push(`解码失败（可能正在写入或已损坏）：${file}`);
        continue;
      }
      const { count } = pluginFrameCount(lines);
      if (count === 0) continue;
      const kept = lines.filter((line) => {
        try {
          const type = JSON.parse(line)?.type;
          return !(typeof type === "string" && PLUGIN_EVENT_TYPES.has(type));
        } catch {
          return true;
        }
      });
      if (!backupCreated) {
        fs.mkdirSync(backupRoot, { recursive: true });
        backupCreated = true;
      }
      const rel = path.relative(root, file);
      const bak = path.join(backupRoot, rel);
      fs.mkdirSync(path.dirname(bak), { recursive: true });
      fs.copyFileSync(file, bak);
      fs.writeFileSync(file, encodeMultiFrame(kept));
      result.fixed++;
      result.fixedFiles.push(`${rel}（移除 ${count} 帧）`);
    } catch (e) {
      result.errors.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  result.backupRoot = backupCreated ? backupRoot : null;
  return result;
}