#!/usr/bin/env node
/**
 * 校验随包的 Matt Pocock skills 与上游记录逐字一致。
 *
 * 只读本地文件：记录在同目录 `SHA256SUMS`，本脚本不联网、不下载。
 * 任一文件缺失或哈希不符就点名并以非 0 退出。
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "ralphflow-create", "matt");
const sumsPath = path.join(dir, "SHA256SUMS");
const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exitCode = 1;
};

let lines;
try {
  lines = fs.readFileSync(sumsPath, "utf-8").split(/\r?\n/);
} catch (error) {
  fail(`读不到 ${sumsPath}：${error instanceof Error ? error.message : String(error)}`);
}

const entries = [];
for (const [index, line] of (lines ?? []).entries()) {
  if (!line.trim()) continue;
  const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
  if (!match) {
    fail(`SHA256SUMS 第 ${index + 1} 行格式无效：${line}`);
    continue;
  }
  entries.push({ expected: match[1], file: match[2] });
}
if (entries.length === 0 && !process.exitCode) fail("SHA256SUMS 没有可校验的条目");

for (const { expected, file } of entries) {
  let actual;
  try {
    actual = createHash("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex");
  } catch (error) {
    fail(`${file} 无法读取：${error instanceof Error ? error.message : String(error)}`);
    continue;
  }
  if (actual !== expected) fail(`${file} 已变化：期望 ${expected}，实际 ${actual}`);
}

if (!process.exitCode) console.log("matt 随包文件与上游记录一致");
