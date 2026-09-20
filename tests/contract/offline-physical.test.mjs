/**
 * 物理断网实测契约测试（V1）。
 *
 * 三块：
 *   1. 判定函数：探测结果 → 「拒绝出证据 / 出证据」的判定必须可复现（含任一探测成功即拒绝）；
 *   2. 流程（依赖注入）：拒绝路径**不写文件**；断网路径写出字段齐备的证据；失败路径如实记录非 ok；
 *      既有证据未加 --force-out 时拒绝覆盖；
 *   3. 真跑（当前联网环境）：CLI 必须退出码 2、写明「不是物理断网」、且不创建证据文件。
 *
 * 断网本身无法在测试里复现（那需要真的拔网线），所以断网路径用注入的探测/步骤结果覆盖逻辑，
 * 真实断网证据由用户执行一次后落在 docs/evidence/（存在时本测试校验其结构与脱敏）。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  PROBE_TIMEOUT_MS,
  decideOutcome,
  networkStillReachable,
  parseFailingTests,
  probeNetwork,
  runStep,
  runPhysicalOffline,
  withTimeout,
} from '../../scripts/physical-offline-lib.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = join(ROOT, 'scripts', 'verify-physical-offline.mjs');
const EVIDENCE = join(ROOT, 'docs', 'evidence', 'physical-offline.json');
const execFileAsync = promisify(execFile);

const DOWN_PROBES = [
  { kind: 'dns', target: 'api.crossref.org', ok: false, detail: 'ENOTFOUND', durationMs: 3 },
  { kind: 'tcp', target: '1.1.1.1:443', ok: false, detail: 'ENETUNREACH', durationMs: 2 },
  { kind: 'https', target: 'https://api.crossref.org', ok: false, detail: 'ENETUNREACH', durationMs: 4 },
];

function fakeStep(loopOk) {
  return (label, argv) => {
    if (argv.includes('scripts/offline-closed-loop.mjs')) {
      return {
        label,
        exitCode: loopOk ? 0 : 1,
        durationMs: 42,
        tail: ['{"ok":' + String(loopOk) + '}'],
        output: `读 → dry-run → 提交 → 回滚\n${JSON.stringify({ ok: loopOk, steps: [{ name: '读（GET）', detail: '2 条' }, { name: '一次授权提交', detail: 'authorizeCount=1，写入 2 条' }] })}`,
      };
    }
    return { label, exitCode: 0, durationMs: 7, tail: ['tests 183 / pass 183'], output: 'tests 183 / pass 183' };
  };
}

test('V1 判定：任一非回环探测成功即拒绝出证据', () => {
  assert.equal(networkStillReachable(DOWN_PROBES), false);
  assert.equal(networkStillReachable([...DOWN_PROBES, { kind: 'dns', ok: true }]), true);

  const refused = decideOutcome({ probes: [...DOWN_PROBES, { kind: 'https', ok: true }], loop: null, tests: null });
  assert.equal(refused.mode, 'refuse');
  assert.equal(refused.exitCode, 2);
  assert.match(refused.reason, /网络仍然可达/u);

  const passed = decideOutcome({
    probes: DOWN_PROBES,
    loop: { exitCode: 0, summary: { ok: true } },
    tests: { exitCode: 0 },
  });
  assert.equal(passed.mode, 'evidence');
  assert.equal(passed.ok, true);
  assert.equal(passed.exitCode, 0);

  const failed = decideOutcome({
    probes: DOWN_PROBES,
    loop: { exitCode: 0, summary: { ok: false } },
    tests: { exitCode: 0 },
  });
  assert.equal(failed.mode, 'evidence');
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 1);
});

test('V1 探测超时：DNS 挂住时也必须在上限内返回，不出现假死', async () => {
  // 断网时 dns.lookup() 会挂到系统解析器超时（可能几十秒）——必须被硬超时兜住
  const started = Date.now();
  const hung = new Promise(() => {});
  assert.equal(await withTimeout(hung, 60, '__timeout__'), '__timeout__');
  assert.ok(Date.now() - started < 2000, '超时必须及时返回');

  const value = await withTimeout(Promise.resolve('ok'), 1000, '__timeout__');
  assert.equal(value, 'ok', '正常返回时必须透传原值');
  assert.ok(PROBE_TIMEOUT_MS > 0 && PROBE_TIMEOUT_MS <= 10_000, '单条探测必须有合理的硬上限');

  // 进度回调：探测与两个步骤都必须上报（CLI 靠它即时打印，避免长时间无输出）
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-physical-progress-'));
  try {
    const events = [];
    await runPhysicalOffline({
      repoRoot: ROOT,
      outPath: join(dir, 'evidence.json'),
      probes: async () => DOWN_PROBES,
      step: fakeStep(true),
      onProgress: (event) => events.push(event),
    });
    const phases = events.map((event) => `${event.phase}:${event.step ?? event.probe?.kind ?? ''}`);
    assert.deepEqual(phases, ['step-start:loop', 'step-end:loop', 'step-start:tests', 'step-end:tests']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V1 流程：联网时零文件写出，断网时证据字段齐备', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-physical-'));
  try {
    // ① 联网（注入「可达」探测）：拒绝且不写文件
    const reachableOut = join(dir, 'reachable.json');
    const refused = await runPhysicalOffline({
      repoRoot: ROOT,
      outPath: reachableOut,
      probes: async () => [...DOWN_PROBES, { kind: 'tcp', target: '1.1.1.1:443', ok: true, detail: 'connected', durationMs: 1 }],
      step: fakeStep(true),
    });
    assert.equal(refused.exitCode, 2);
    assert.equal(refused.mode, 'refuse');
    assert.equal(refused.evidence, null);
    assert.equal(existsSync(reachableOut), false, '拒绝出证据时不得写出文件');

    // ② 断网（注入「全失败」探测 + 注入步骤结果）：证据落盘且字段齐备
    const disconnectedOut = join(dir, 'disconnected.json');
    const recorded = await runPhysicalOffline({
      repoRoot: ROOT,
      outPath: disconnectedOut,
      probes: async () => DOWN_PROBES,
      step: fakeStep(true),
    });
    assert.equal(recorded.exitCode, 0);
    assert.equal(recorded.mode, 'evidence');
    const evidence = JSON.parse(readFileSync(disconnectedOut, 'utf8'));
    assert.equal(evidence.schema, 'zotero-mcp.physical-offline.v1');
    assert.equal(evidence.network.reachable, false);
    assert.deepEqual(evidence.network.probes.map((probe) => probe.ok), [false, false, false]);
    assert.ok(Array.isArray(evidence.network.interfaces.nodeInterfaces));
    assert.equal(evidence.loopbackClosedLoop.summary.ok, true);
    assert.equal(evidence.loopbackClosedLoop.summary.steps[1].detail, 'authorizeCount=1，写入 2 条');
    assert.equal(evidence.contractTests.exitCode, 0);
    assert.equal(evidence.conclusion.ok, true);
    assert.equal(evidence.conclusion.exitCode, 0);
    assert.match(evidence.environment.node, /^v\d+/u);
    // 脱敏：证据里不得出现文献正文或凭证
    const raw = JSON.stringify(evidence);
    assert.doesNotMatch(raw, /"before"|"after"/u);
    assert.doesNotMatch(raw, /ZOTERO_MCP_PLUGIN_TOKEN|Bearer [A-Za-z0-9]{8,}/u);

    // ③ 失败路径：如实记录非 ok（仍然落盘，不美化）
    const failedOut = join(dir, 'failed.json');
    const failed = await runPhysicalOffline({
      repoRoot: ROOT,
      outPath: failedOut,
      probes: async () => DOWN_PROBES,
      step: fakeStep(false),
    });
    assert.equal(failed.exitCode, 1);
    const failedEvidence = JSON.parse(readFileSync(failedOut, 'utf8'));
    assert.equal(failedEvidence.conclusion.ok, false);
    assert.equal(failedEvidence.loopbackClosedLoop.exitCode, 1);

    // ④ 既有证据未加 --force-out：拒绝覆盖，文件逐字节不变
    const before = readFileSync(disconnectedOut, 'utf8');
    const again = await runPhysicalOffline({
      repoRoot: ROOT,
      outPath: disconnectedOut,
      probes: async () => DOWN_PROBES,
      step: fakeStep(true),
    });
    assert.equal(again.mode, 'refused-overwrite');
    assert.equal(again.exitCode, 1);
    assert.equal(readFileSync(disconnectedOut, 'utf8'), before, '未加 --force-out 时不得改写既有证据');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V1 诊断：失败用例名与完整日志必须可定位', async () => {
  // 断网实测失败时只留四行尾巴是不可接受的：必须能直接看到哪条用例、哪一行
  // 与真实 node:test 输出同形：逐行段细节在 ✖ 之后；`failing tests:` 小节里 `test at` 在 ✖ **之前**
  const sample = [
    '✖ V1 示例用例 (12.3ms)',
    '  AssertionError [ERR_ASSERTION]: boom',
    '    at TestContext.<anonymous> (file:///D:/x/tests/contract/demo.test.mjs:42:5)',
    '✖ failing tests:',
    '',
    'test at tests\contract\demo.test.mjs:42:1',
    '✖ V1 示例用例 (12.3ms)',
    '  AssertionError [ERR_ASSERTION]: boom',
    '',
    'test at tests\contract\demo.test.mjs:99:1',
    '✖ 另一条用例 (1.2ms)',
    '  AssertionError: 也炸了',
  ].join(String.fromCharCode(10));
  const parsed = parseFailingTests(sample);
  assert.equal(parsed.length, 2, '`✖ failing tests:` 小节标题与重复条目必须被过滤掉');
  assert.equal(parsed[0].name, 'V1 示例用例', '用例名必须去掉耗时后缀');
  assert.ok(parsed[0].details.some((line) => line.includes('AssertionError')));
  assert.ok(parsed[0].details.some((line) => line.includes('test at ')));
  assert.equal(parsed[1].name, '另一条用例');
  // 关键：小节里的行号定位在 ✖ 之前，也必须被取到（这正是上一轮 Verifier 指出的缺口）
  assert.ok(parsed[0].details.some((line) => line.includes('demo.test.mjs:42:1')), '第一条必须拿到小节里的 test at 定位');
  assert.ok(parsed[1].details.some((line) => line.includes('demo.test.mjs:99:1')), '第二条同样必须拿到');
  assert.deepEqual(parseFailingTests('全部通过'), []);

  // 完整日志确实落盘（logDir 给出时），且失败用例名进证据
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-physical-log-'));
  try {
    const out = join(dir, 'evidence.json');
    const failingStep = (label, argv) => {
      if (argv.includes('scripts/offline-closed-loop.mjs')) return fakeStep(true)(label, argv);
      return {
        label,
        exitCode: 1,
        durationMs: 9,
        tail: ['✖ 假失败用例 (1ms)'],
        output: `✖ 假失败用例 (1ms)${String.fromCharCode(10)}  AssertionError: 假${String.fromCharCode(10)}test at tests/contract/demo.test.mjs:1:1`,
      };
    };
    const result = await runPhysicalOffline({
      repoRoot: ROOT,
      outPath: out,
      logDir: dir,
      probes: async () => DOWN_PROBES,
      step: failingStep,
    });
    assert.equal(result.exitCode, 1);
    const evidence = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(evidence.contractTests.failingTests.length, 1);
    assert.equal(evidence.contractTests.failingTests[0].name, '假失败用例', '耗时后缀必须被去掉');
    assert.ok(evidence.contractTests.failingTests[0].details.some((line) => line.includes('test at ')));

    // 完整日志由真实的 runStep 负责落盘（注入的假步骤不写日志），这里直接验证 runStep 本身
    const stepLog = join(dir, 'step.log');
    const real = runStep('假步骤', ['-e', "console.log('诊断输出行')"], ROOT, { logFile: stepLog });
    assert.equal(real.exitCode, 0);
    assert.equal(real.logFile, stepLog);
    assert.equal(existsSync(stepLog), true, '完整输出必须落盘');
    assert.match(readFileSync(stepLog, 'utf8'), /诊断输出行/u);
    assert.deepEqual(real.tail, ['诊断输出行']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V1 CLI：联网环境下退出码 2、不创建证据文件（已断网时按设计跳过）', async (t) => {
  // 本用例断言的是「联网时必须拒绝」这一半；断网时 CLI 会真的往下跑闭环与契约测试（嵌套一整套，
  // 且此时它本来就该出证据），因此断网环境下必须跳过——否则整套契约测试会在物理断网时自相矛盾地失败。
  const probes = await probeNetwork({ timeoutMs: 1500 });
  if (!networkStillReachable(probes)) {
    t.skip('当前环境已处于断网状态：本用例只覆盖「联网时必须拒绝」；断网那一半由物理断网实测（docs/evidence/physical-offline.json）覆盖');
    return;
  }

  const out = join(mkdtempSync(join(tmpdir(), 'zotero-mcp-physical-cli-')), 'evidence.json');
  try {
    const result = await execFileAsync(process.execPath, [CLI, '--out', out], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }).then(
      (value) => ({ code: 0, stdout: value.stdout }),
      (error) => ({ code: typeof error.code === 'number' ? error.code : -1, stdout: String(error.stdout ?? '') }),
    );
    assert.equal(result.code, 2, '联网状态下必须拒绝（退出码 2）');
    assert.match(result.stdout, /这不是物理断网/u);
    assert.match(result.stdout, /网络仍然可达/u);
    assert.equal(existsSync(out), false, '拒绝时不得创建证据文件');
  } finally {
    rmSync(join(out, '..'), { recursive: true, force: true });
  }
});

test('V1 证据：物理断网证据存在时校验结构与脱敏，不存在时如实跳过', { skip: existsSync(EVIDENCE) ? false : '尚未执行物理断网实测（docs/evidence/physical-offline.json 还不存在）' }, () => {
  const evidence = JSON.parse(readFileSync(EVIDENCE, 'utf8'));
  // 受控证据沿用 docs/evidence/ 的统一信封（live-evidence.v1 + kind），原始机读 schema 单独记在 rawSchema
  assert.equal(evidence.schema, 'zotero-mcp.live-evidence.v1');
  assert.equal(evidence.kind, 'physical-offline');
  assert.equal(evidence.rawSchema, 'zotero-mcp.physical-offline.v1');
  assert.equal(evidence.network.reachable, false);
  assert.equal(evidence.network.probes.length >= 3, true);
  assert.equal(evidence.network.probes.every((probe) => probe.ok === false), true, '三类探测必须全部失败');
  assert.equal(evidence.conclusion.ok, true);
  assert.equal(evidence.contractTests.exitCode, 0);
  assert.equal(evidence.contractTests.failed, 0);
  assert.equal(evidence.loopbackClosedLoop.ok, true);
  // 断网事实必须自证：非内部网卡 0 个 + 探测全失败
  assert.equal(evidence.network.nonInternalInterfaces, 0);
  assert.equal(evidence.network.adapters.every((adapter) => adapter.status === 'Disconnected'), true);
  // 跳过项必须写明原因（不静默通过）
  assert.equal(evidence.contractTests.skippedTests.length, evidence.contractTests.skipped);
  assert.ok(evidence.contractTests.skippedTests.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0));
  assert.ok(typeof evidence.capturedAt === 'string' && evidence.capturedAt.length > 0);
  assert.ok(statSync(EVIDENCE).size > 0);
  const raw = readFileSync(EVIDENCE, 'utf8');
  assert.doesNotMatch(raw, /"before"|"after"/u);
  assert.doesNotMatch(raw, /ZOTERO_MCP_PLUGIN_TOKEN|Bearer [A-Za-z0-9]{8,}/u);
  // 证据不得把「进程级替身」混为一谈
  assert.doesNotMatch(raw, /进程级禁网替身/u);
});

