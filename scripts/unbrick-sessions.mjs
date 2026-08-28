/**
 * Ralph Flow for dsh — 会话解砖脚本（v3：委托插件内置模块）
 *
 * 背景与格式细节见 src/session-hygiene.ts。v2 的「多帧 zstd：header 单帧 +
 * 事件分批帧」编码已内置于插件模块，本脚本只是 CLI 壳（在宿主进程外独立跑的
 * 场景用；宿主内推荐 /ralphflow-unbrick 命令或 ralphflow_unbrick 工具）。
 *
 * 用法：node scripts/unbrick-sessions.mjs
 * 安全：每个改动文件先备份到 <sessions>/ralphflow-unbrick-backup-<ts>/；
 *      60 秒内有写入的文件自动跳过（疑似仍被运行中的进程写盘）。
 */
import { unbrickSessions, scanSessionLogs } from "../lib/session-hygiene.js";

const infected = scanSessionLogs();
if (infected.length === 0) {
  console.log("所有会话日志干净，无需解砖。");
  process.exit(0);
}
console.log(`检出 ${infected.length} 个含插件自定义事件帧的会话：`);
for (const e of infected) console.log(`  - ${e.file}（${e.count} 帧：${e.types.join("、")}）`);

const result = unbrickSessions();
if (result.fixed === 0 && result.errors.length === 0) {
  console.log("没有可修复的会话（可能因写入保护被跳过，稍后再试）。");
  process.exit(1);
}
for (const f of result.fixedFiles) console.log(`✓ 已修复：${f}`);
if (result.errors.length > 0) {
  console.log("⚠ 问题：");
  for (const e of result.errors) console.log(`  - ${e}`);
}
console.log(`\n完成：扫描 ${result.scanned} 个会话文件，修复 ${result.fixed} 个。备份在 ${result.backupRoot ?? "（无）"}`);
console.log("验证修复文件可加载：重启 dsh 后会话应可打开。");