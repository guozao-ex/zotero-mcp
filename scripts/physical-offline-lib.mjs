#!/usr/bin/env node
/**
 * 物理断网实测的**可复用逻辑**（供 CLI 与契约测试共用；本文件没有顶层副作用）。
 *
 * 拆分原因：判定与流程必须可被契约测试注入复现（尤其是「网络仍可达 → 拒绝出证据」这条），
 * 而 CLI 一跑就会真的探测与跑测试，不能在被 import 时执行。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { hostname, networkInterfaces, platform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { lookup } from 'node:dns/promises';

/** 公网探测目标：一个 IP（绕过 DNS）与一个域名（走 DNS）。 */
export const PROBE_IP = { host: '1.1.1.1', port: 443 };
export const PROBE_HOST = 'api.crossref.org';
/** 单条探测的超时上限（毫秒）：断网时 DNS 解析会长时间挂住，必须有硬上限。 */
export const PROBE_TIMEOUT_MS = 4000;

/**
 * 给任意 promise 加硬超时：超时返回 `fallback`，正常返回原值。
 * 断网时 `dns.lookup()` 会挂到系统解析器超时（可能几十秒），不能让它拖住整条流程。
 */
export async function withTimeout(promise, timeoutMs, fallback) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/** 判定「网络是否仍可达」：任一探测成功即视为可达（纯函数，便于注入复现）。 */
export function networkStillReachable(probes) {
  return probes.some((probe) => probe.ok === true);
}

/**
 * 依据探测、回环闭环与契约测试结果决定本次形态（纯函数）：
 *   - 网络可达 → `refuse`（拒绝出证据，退出码 2）；
 *   - 全通过 → `evidence` + ok；
 *   - 有失败 → `evidence` + 非 ok（如实记录，退出码 1）。
 */
export function decideOutcome({ probes, loop, tests }) {
  if (networkStillReachable(probes)) {
    return { mode: 'refuse', ok: false, exitCode: 2, reason: '网络仍然可达：这不是物理断网，拒绝写出证据' };
  }
  const ok = loop?.exitCode === 0 && loop?.summary?.ok === true && tests?.exitCode === 0;
  return { mode: 'evidence', ok, exitCode: ok ? 0 : 1, reason: ok ? '物理断网下回环读写闭环与契约测试全部通过' : '存在未通过项' };
}

/**
 * 三类非回环探测：DNS 解析、到公网 IP 的 TCP 连接、到公网 HTTPS 的 GET。
 *
 * 每条都受 `PROBE_TIMEOUT_MS` 硬上限约束，并在完成时立刻回调 `onProbe`——
 * 断网时不能出现「跑了几十秒什么都不打印」的假死观感。
 */
export async function probeNetwork(options = {}) {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const onProbe = typeof options.onProbe === 'function' ? options.onProbe : () => {};
  const probes = [];
  const record = (probe) => {
    probes.push(probe);
    onProbe(probe);
  };

  const started = Date.now();
  try {
    const resolved = await withTimeout(lookup(PROBE_HOST), timeoutMs, '__timeout__');
    if (resolved === '__timeout__') {
      record({ kind: 'dns', target: PROBE_HOST, ok: false, detail: `timeout(${timeoutMs}ms)`, durationMs: Date.now() - started });
    } else {
      record({ kind: 'dns', target: PROBE_HOST, ok: true, detail: resolved.address, durationMs: Date.now() - started });
    }
  } catch (error) {
    record({ kind: 'dns', target: PROBE_HOST, ok: false, detail: String(error?.code ?? error), durationMs: Date.now() - started });
  }

  await new Promise((done) => {
    const startedAt = Date.now();
    const socket = createConnection({ host: PROBE_IP.host, port: PROBE_IP.port });
    const finish = (ok, detail) => {
      socket.removeAllListeners();
      socket.destroy();
      record({ kind: 'tcp', target: `${PROBE_IP.host}:${PROBE_IP.port}`, ok, detail, durationMs: Date.now() - startedAt });
      done();
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, 'connected'));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (error) => finish(false, String(error?.code ?? error)));
  });

  const startedHttps = Date.now();
  try {
    const response = await fetch(`https://${PROBE_HOST}/works/10.1000/offline-probe`, {
      signal: AbortSignal.timeout(timeoutMs + 1000),
      headers: { accept: 'application/json' },
    });
    record({ kind: 'https', target: `https://${PROBE_HOST}`, ok: true, detail: `HTTP ${response.status}`, durationMs: Date.now() - startedHttps });
  } catch (error) {
    record({
      kind: 'https',
      target: `https://${PROBE_HOST}`,
      ok: false,
      detail: error?.cause?.code ?? error?.name ?? String(error),
      durationMs: Date.now() - startedHttps,
    });
  }

  return probes;
}

/** 接口快照：只读（Node 的 os.networkInterfaces），另尝试 Windows 的 Get-NetAdapter 状态。 */
export function interfaceSnapshot() {
  const snapshot = { nodeInterfaces: [], windowsAdapters: null };
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses ?? []) {
      snapshot.nodeInterfaces.push({ name, address: address.address, family: address.family, internal: address.internal, mac: address.mac });
    }
  }
  if (platform() === 'win32') {
    try {
      const raw = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetAdapter | Select-Object Name,Status,LinkSpeed,MediaType | ConvertTo-Json -Compress'],
        { encoding: 'utf8', timeout: 20000, windowsHide: true },
      ).trim();
      snapshot.windowsAdapters = raw.length === 0 ? null : JSON.parse(raw);
    } catch (error) {
      snapshot.windowsAdapters = { error: String(error?.message ?? error) };
    }
  }
  return snapshot;
}

/** 跑一个子步骤并保留退出码、耗时、输出尾部与（可选）完整日志路径。 */
export function runStep(label, argv, cwd, options = {}) {
  const started = Date.now();
  const result = spawnSync(process.execPath, argv, { cwd, encoding: 'utf8', timeout: 1_800_000, env: { ...process.env } });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const entry = {
    label,
    exitCode: result.status,
    durationMs: Date.now() - started,
    tail: output.trim().split(/\r?\n/u).slice(-40),
    output,
  };
  if (typeof options.logFile === 'string' && options.logFile.length > 0) {
    try {
      mkdirSync(dirname(options.logFile), { recursive: true });
      writeFileSync(options.logFile, output, 'utf8');
      entry.logFile = options.logFile;
    } catch {
      // 日志写不出不应让检查失败
    }
  }
  return entry;
}

/**
 * 从 node:test 的输出里抽出失败用例名与紧随其后的定位行（`test at <file:line>`）。
 * 断网实测失败时必须能直接看到「哪条用例、在哪一行」，而不是只留四行尾巴。
 *
 * node:test 的真实输出有噪声，这里一并处理：`✖ failing tests:` 是小节标题（不是用例）；用例名
 * 带 ` (12.3ms)` 耗时后缀；同一失败会先逐行出现、再在小节里重复出现（去重时把定位信息算进去）。
 */
export function parseFailingTests(output) {
  const lines = output.split(/\r?\n/u);
  const failures = [];
  const seen = new Map();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line.startsWith('✖ ')) continue;
    const rawName = line.slice(2).trim();
    if (/^failing tests:?$/iu.test(rawName)) continue;
    const name = rawName.replace(/\s*\(\d+(?:\.\d+)?ms\)$/u, '').trim();
    if (name.length === 0) continue;
    const details = [];
    // node:test 的两种排布都要认：逐行输出里细节在 ✖ 之后；而 `failing tests:` 小节里
    // `test at <file:line>` 定位行在 ✖ **之前**（真实格式如此），因此还要向前看几行。
    for (let probe = index - 1; probe >= Math.max(0, index - 4); probe -= 1) {
      const previous = lines[probe].trim();
      if (previous.startsWith('test at ')) {
        details.unshift(previous);
        break;
      }
      if (previous.startsWith('✖ ')) break;
    }
    for (let probe = index + 1; probe < Math.min(index + 8, lines.length); probe += 1) {
      const next = lines[probe].trim();
      if (next.startsWith('test at ') || next.startsWith('AssertionError') || next.startsWith('Error')) details.push(next);
      if (next.startsWith('✖ ')) break;
    }
    const key = name;
    const existing = seen.get(key);
    if (existing !== undefined) {
      // 同一失败会在「逐行输出」和「failing tests 小节」里各出现一次：合并细节而不是新增条目
      for (const detail of details) if (!existing.details.includes(detail)) existing.details.push(detail);
      continue;
    }
    const entry = { name, details };
    seen.set(key, entry);
    failures.push(entry);
  }
  return failures;
}

/** 从闭环脚本的输出里取最后一行 JSON（它自报 ok 与各步骤）。 */
export function parseClosedLoop(output) {
  let summary = null;
  for (const line of output.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      summary = JSON.parse(trimmed);
    } catch {
      // 非 JSON 行忽略
    }
  }
  return summary;
}

/**
 * 完整流程（依赖可注入，便于契约测试复现「拒绝」与「出证据」两条路径）。
 *
 * @param {object} options
 * @param {string} options.repoRoot 仓库根目录（子步骤的 cwd）
 * @param {string} options.outPath 证据输出路径
 * @param {boolean} [options.forceOut] 允许覆盖已存在的证据
 * @param {() => Promise<object[]>} [options.probes] 依赖注入：非回环探测
 * @param {(label: string, argv: string[], cwd: string) => object} [options.step] 依赖注入：子步骤执行器
 * @param {(event: object) => void} [options.onProgress] 进度回调（探测/步骤开始与结束），CLI 用它即时打印
 * @returns {Promise<{ exitCode: number, mode: string, reason: string, evidence: object | null, probes: object[], loop: object | null, tests: object | null, refusedBecause: string | null }>}
 */
export async function runPhysicalOffline(options) {
  const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const probe = options.probes;
  const probes = probe === undefined
    ? await probeNetwork({ onProbe: (entry) => progress({ phase: 'probe', probe: entry }) })
    : await probe();
  const reachable = networkStillReachable(probes);

  if (reachable) {
    const decision = decideOutcome({ probes, loop: null, tests: null });
    return { exitCode: decision.exitCode, mode: decision.mode, reason: decision.reason, evidence: null, probes, loop: null, tests: null, refusedBecause: decision.reason };
  }

  const step = options.step ?? runStep;
  const logDir = typeof options.logDir === 'string' && options.logDir.length > 0 ? options.logDir : null;
  const logFileFor = (id) => (logDir === null ? undefined : join(logDir, `physical-offline.${id}.log`));
  progress({ phase: 'step-start', step: 'loop' });
  const loop = step('读写闭环（scripts/offline-closed-loop.mjs）', ['scripts/offline-closed-loop.mjs'], options.repoRoot, { logFile: logFileFor('closed-loop') });
  const loopSummary = parseClosedLoop(loop.output);
  const loopResult = { exitCode: loop.exitCode, durationMs: loop.durationMs, summary: loopSummary, tail: loop.tail, ...(loop.logFile === undefined ? {} : { logFile: loop.logFile }) };
  progress({ phase: 'step-end', step: 'loop', result: loopResult });
  progress({ phase: 'step-start', step: 'tests' });
  const tests = step('契约测试（scripts/run-tests.mjs contract）', ['scripts/run-tests.mjs', 'contract'], options.repoRoot, { logFile: logFileFor('contract-tests') });
  const failingTests = parseFailingTests(tests.output ?? '');
  const testsResult = {
    exitCode: tests.exitCode,
    durationMs: tests.durationMs,
    tail: tests.tail,
    ...(tests.logFile === undefined ? {} : { logFile: tests.logFile }),
    ...(failingTests.length === 0 ? {} : { failingTests }),
  };
  progress({ phase: 'step-end', step: 'tests', result: testsResult });

  const decision = decideOutcome({ probes, loop: loopResult, tests: testsResult });
  const evidence = {
    schema: 'zotero-mcp.physical-offline.v1',
    kind: 'physical-offline',
    recordedAt: new Date().toISOString(),
    environment: { hostname: hostname(), platform: platform(), release: release(), node: process.version, repoRoot: options.repoRoot },
    network: { reachable: false, probes, interfaces: interfaceSnapshot() },
    loopbackClosedLoop: loopResult,
    contractTests: testsResult,
    conclusion: { ok: decision.ok, exitCode: decision.exitCode, note: decision.reason },
  };

  if (existsSync(options.outPath) && options.forceOut !== true) {
    return {
      exitCode: 1,
      mode: 'refused-overwrite',
      reason: `证据文件已存在：${options.outPath}（未覆盖；确认要覆盖时加 --force-out）`,
      evidence: null,
      probes,
      loop: loopResult,
      tests: testsResult,
      refusedBecause: 'evidence-exists',
    };
  }

  mkdirSync(dirname(options.outPath), { recursive: true });
  writeFileSync(options.outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  return { exitCode: decision.exitCode, mode: decision.mode, reason: decision.reason, evidence, probes, loop: loopResult, tests: testsResult, refusedBecause: null };
}


