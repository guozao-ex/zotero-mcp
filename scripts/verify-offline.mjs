#!/usr/bin/env node
/**
 * 禁网验证（路线图成功标准 1 的可重跑证据）。
 *
 * 在**进程级禁网守卫**下跑两件事：
 *   1. `npm run test:contract`（契约测试全套）
 *   2. 读写闭环：读 → dry-run 预览 → 一次授权提交 → 回读 → 回滚 → 回读
 *
 * 守卫把任何非回环请求在发出之前拒绝并记账；被拦截清单非空即判失败（并逐个打印）。
 *
 * **如实声明**：这是进程级禁网替身，不是物理断网。它证明「核心读写路径不需要
 * 非回环网络」，但不覆盖网卡被拔掉、DNS 不可用等物理断网场景；物理断网实测由
 * `npm run verify:offline:physical` 承担（需要用户先真正断网），结果见
 * `docs/evidence/physical-offline.json`。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const guard = join('scripts', 'offline-guard.mjs');
const logDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-offline-'));
const logPath = join(logDir, 'blocked.log');
const env = { ...process.env, ZOTERO_MCP_OFFLINE_LOG: logPath };

function blockedList() {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, 'utf8')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function run(label, argv) {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--import', `./${guard.replaceAll('\\', '/')}`, ...argv], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 900000,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  return {
    label,
    exitCode: result.status,
    durationMs: Date.now() - started,
    tail: output.trim().split(/\r?\n/u).slice(-3).join(' | '),
    output,
  };
}

console.log('进程级禁网验证（这是禁网替身，不是物理断网）');
console.log(`守卫：node --import ./${guard.replaceAll('\\', '/')}`);
console.log('');

const steps = [];
steps.push(run('契约测试（npm run test:contract）', ['scripts/run-tests.mjs', 'contract']));
steps.push(run('读写闭环（scripts/offline-closed-loop.mjs）', ['scripts/offline-closed-loop.mjs']));

const blocked = blockedList();
let closedLoop = null;
for (const line of (steps[1]?.output ?? '').split(/\r?\n/u)) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) continue;
  try {
    closedLoop = JSON.parse(trimmed);
  } catch {
    // 非 JSON 行忽略
  }
}

console.log('');
for (const step of steps) {
  console.log(`  ${step.exitCode === 0 ? '✔' : '✖'} ${step.label}（退出码 ${step.exitCode}，${step.durationMs} ms）`);
  if (step.exitCode !== 0) console.log(`      ${step.tail}`);
}
if (closedLoop !== null) {
  for (const step of closedLoop.steps ?? []) console.log(`      · ${step.name}：${step.detail}`);
}

const loopOk = closedLoop !== null && closedLoop.ok === true;
const noBlocked = blocked.length === 0;
const allPassed = steps.every((step) => step.exitCode === 0) && loopOk && noBlocked;

console.log('');
console.log(`被拦截的非回环请求：${blocked.length} 个${noBlocked ? '' : '（核心路径本应完全不需要外网，逐个列出）'}`);
for (const url of blocked) console.log(`    • ${url}`);

rmSync(logDir, { recursive: true, force: true });

console.log('');
console.log(allPassed ? '结论：✔ 禁网（进程级替身）下的读写闭环与契约测试全部通过。' : '结论：✖ 存在未通过项，见上。');
console.log('说明：本次验证拦截的是「非回环网络请求」，不能等同于物理断网。');
console.log('物理断网本身已在 2026-09-19 由 V1（物理断网实测）执行过一次，结果记录在 docs/evidence/physical-offline.json；可重跑入口是 npm run verify:offline:physical（需要先真正断网）。');
process.exitCode = allPassed ? 0 : 1;
