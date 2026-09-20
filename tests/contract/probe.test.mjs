/**
 * 环境探针契约测试：三种环境结论（未运行 / 本地 API 未开启 / 可用）+ CLI 退出码。
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { probeLocalApi } from '../../packages/core/src/index.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** 先占一个端口再关掉，得到一个确定无人监听的地址。 */
async function closedPortUrl() {
  const server = await startFakeZotero({ mode: 'ok', port: 0 });
  const url = server.url;
  await server.close();
  return url;
}

/**
 * 以子进程运行探针 CLI。
 * 必须异步：同进程内可能正跑着假服务器，阻塞事件循环会让它无法应答。
 */
function runProbe(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/probe.mjs', ...args], { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('Zotero 未运行时：reachable=false、不产生缓存路径、退出码 0', async () => {
  const url = await closedPortUrl();
  const cacheDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-probe-'));
  try {
    const result = await probeLocalApi({ baseUrl: url, cacheDir, timeoutMs: 1500 });
    assert.equal(result.reachable, false);
    assert.equal(result.statusCode, null);
    assert.equal(result.writeAvailable, false);
    assert.equal(result.errorCode, 'connection-refused');
    assert.equal(result.cachePath, null);
    assert.ok(result.reason && result.reason.length > 0);
    assert.ok(result.nextSteps.length > 0);
    // 未取得 serverID 时不得创建缓存目录
    assert.equal(existsSync(join(cacheDir, result.serverId)), false);
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test('本地 API 未开启（403）：给出原因与设置路径提示', async () => {
  const fake = await startFakeZotero({ mode: 'api-disabled', port: 0 });
  try {
    const result = await probeLocalApi({ baseUrl: fake.url });
    assert.equal(result.reachable, true);
    assert.equal(result.statusCode, 403);
    assert.equal(result.writeAvailable, false);
    assert.equal(result.errorCode, 'local-api-disabled');
    assert.equal(result.cachePath, null);
    assert.ok(result.nextSteps.some((step) => step.includes('Settings → Advanced')));
  } finally {
    await fake.close();
  }
});

test('通道可用（200）：解析三个响应头并按 serverID 分区缓存路径', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0, serverId: 'ABC12345' });
  const workspace = mkdtempSync(join(tmpdir(), 'zotero-mcp-probe-'));
  const cacheDir = join(workspace, 'cache');
  try {
    const result = await probeLocalApi({ baseUrl: fake.url, cacheDir });
    assert.equal(result.reachable, true);
    assert.equal(result.statusCode, 200);
    assert.equal(result.serverId, 'ABC12345');
    assert.equal(result.schemaVersion, fake.schemaVersion);
    assert.equal(result.apiVersion, fake.apiVersion);
    assert.equal(result.writeAvailable, true);
    assert.equal(result.errorCode, null);
    assert.ok(result.cachePath?.endsWith('cache/ABC12345'), `cachePath=${result.cachePath}`);
    assert.ok(result.cachePath?.includes(cacheDir.replaceAll('\\', '/')));
    // 只计算路径，不创建目录
    assert.equal(existsSync(cacheDir), false);
  } finally {
    await fake.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('CLI：默认退出码 0，--strict 在不可用环境下退出码 2', async () => {
  const url = await closedPortUrl();

  const normal = await runProbe(['--json', '--url', url, '--timeout', '1500']);
  assert.equal(normal.status, 0, normal.stderr);
  const parsed = JSON.parse(normal.stdout);
  assert.equal(parsed.reachable, false);
  assert.equal(parsed.errorCode, 'connection-refused');

  const strict = await runProbe(['--json', '--strict', '--url', url, '--timeout', '1500']);
  assert.equal(strict.status, 2, strict.stderr);
});

test('CLI：--strict 在可用通道下退出码 0，人类可读输出包含关键字段', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0, serverId: 'HUMAN001' });
  try {
    const result = await runProbe(['--strict', '--url', fake.url]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Zotero 本地 API 探测/);
    assert.match(result.stdout, /serverID/);
    assert.match(result.stdout, /HUMAN001/);
  } finally {
    await fake.close();
  }
});

test('CLI：参数错误退出码 1', async () => {
  const result = await runProbe(['--nope']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /未知参数/);
});
