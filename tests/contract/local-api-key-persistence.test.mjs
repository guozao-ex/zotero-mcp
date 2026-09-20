import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { applyPlan, makeChangePlan, resetLocalApiAuthCache } from '../../packages/core/src/index.ts';
import { putRememberedKey, getRememberedKey } from '../../packages/core/src/capabilities/local-api-key-store.ts';

process.env['ZOTERO_MCP_WRITE'] = 'on';

const HEADERS = (serverId = 'TESTSRV01') => ({
  'content-type': 'application/json',
  'zotero-api-version': '3',
  'zotero-server-id': serverId,
  'zotero-schema-version': '44',
});

/** 可编程桩：探测 / 授权 / 写 / 回读都可控；绝不起服务器。 */
function stub({ serverId = 'TESTSRV01', probeIds = [], writeStatus = 204, authorized = { key: 'NEWKEY0001', remember: true } } = {}) {
  const calls = { probe: 0, authorize: 0, patch: 0 };
  const json = (body, status = 200, id = serverId) => new Response(JSON.stringify(body), { status, headers: HEADERS(id) });
  const fetchImpl = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.includes('/items?limit=1')) {
      calls.probe += 1;
      const id = probeIds[calls.probe - 1] ?? serverId; // 第 n 次探测可返回不同实例 ID（模拟换实例）
      return json([], 200, id);
    }
    if (url.includes('/api/local/authorize')) {
      calls.authorize += 1;
      return json(authorized);
    }
    if (method === 'PATCH' && url.includes('/items/ITEM0001')) {
      calls.patch += 1;
      if (typeof writeStatus === 'function') {
        const decided = writeStatus(calls.patch);
        if (decided !== 204) return json({}, decided);
      } else if (writeStatus !== 204) {
        return json({}, writeStatus);
      }
      return new Response(null, { status: 204, headers: HEADERS(serverId) });
    }
    if (method === 'GET' && url.includes('/items/ITEM0001')) {
      return json({ key: 'ITEM0001', version: 5, data: { itemType: 'document', extra: 'x' } });
    }
    return json({}, 404);
  };
  return { fetchImpl, calls };
}

const plan = () =>
  makeChangePlan({ targetKeys: ['ITEM0001'], changes: [], operations: [{ kind: 'patch', key: 'ITEM0001', fields: { extra: 'x' } }], summary: 'patch' });

function options(fetchImpl, dir, extra = {}) {
  return {
    baseUrl: 'http://127.0.0.1:23119',
    fetchImpl,
    auditDir: dir,
    write: true,
    confirm: 'OVERWRITE',
    env: { ZOTERO_MCP_WRITE: 'on', ZOTERO_MCP_DATA_DIR: dir },
    localApiKeyStorePath: join(dir, 'keys.json'),
    ...extra,
  };
}

const auditLines = (path) => readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line));

test('A1：落盘里有 remembered key 时，两个计划零授权调用', async () => {
  resetLocalApiAuthCache(); // 内存缓存不许跨用例串味（落盘才是跨进程层）
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-persist-'));
  const storePath = join(dir, 'keys.json');
  try {
    putRememberedKey('TESTSRV01', 'STOREDKEY0001', { path: storePath });
    const s = stub();
    const first = await applyPlan(plan(), options(s.fetchImpl, dir));
    const second = await applyPlan(plan(), options(s.fetchImpl, dir));
    assert.equal(s.calls.authorize, 0, '有落盘 key 时不得再调授权端点');
    assert.equal(first.authSource, 'file');
    assert.equal(first.operations[0].status, 'applied');
    assert.equal(second.operations[0].status, 'applied');
    const summary = auditLines(first.auditPath).find((entry) => entry.status === 'plan-summary');
    assert.equal(summary['authSource'], 'file', '审计要记来源');
    assert.equal(summary['remembered'], false, '复用落盘 key 时本轮没有新的授权动作');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A2a：无落盘时授权一次；remember=true 才落盘', async () => {
  resetLocalApiAuthCache(); // 内存缓存不许跨用例串味（落盘才是跨进程层）
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-persist-'));
  const storePath = join(dir, 'keys.json');
  try {
    const s = stub({ authorized: { key: 'REMEMBERME01', remember: true } });
    const result = await applyPlan(plan(), options(s.fetchImpl, dir));
    assert.equal(s.calls.authorize, 1);
    assert.equal(result.authSource, 'authorize');
    assert.equal(result.remembered, true);
    assert.equal(getRememberedKey('TESTSRV01', storePath), 'REMEMBERME01', 'remembered key 必须落盘');
    assert.equal(result.authNotice, undefined, '永久授权不该有提示');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A2b：remember=false 绝不落盘，并在结果里提示选 Always Allow', async () => {
  resetLocalApiAuthCache(); // 内存缓存不许跨用例串味（落盘才是跨进程层）
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-persist-'));
  const storePath = join(dir, 'keys.json');
  try {
    const s = stub({ authorized: { key: 'ONESHOT0001', remember: false } });
    const result = await applyPlan(plan(), options(s.fetchImpl, dir));
    assert.equal(s.calls.authorize, 1);
    assert.equal(result.remembered, false);
    assert.match(String(result.authNotice ?? ''), /Always Allow/u, '一次性授权必须提示使用者');
    assert.equal(existsSync(storePath), false, '一次性 key 绝不落盘');
    assert.equal(getRememberedKey('TESTSRV01', storePath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A3：落盘 key 被 401 拒绝 → 恰好重新授权一次并刷新落盘', async () => {
  resetLocalApiAuthCache(); // 内存缓存不许跨用例串味（落盘才是跨进程层）
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-persist-'));
  const storePath = join(dir, 'keys.json');
  try {
    putRememberedKey('TESTSRV01', 'STALEKEY0001', { path: storePath });
    // 第一次写被拒（401 → 分类为 write-unauthorized），重新授权后成功
    const s = stub({ writeStatus: (n) => (n === 1 ? 401 : 204), authorized: { key: 'FRESHKEY0001', remember: true } });
    const result = await applyPlan(plan(), options(s.fetchImpl, dir));
    assert.equal(s.calls.authorize, 1, '恰好重新授权一次');
    assert.equal(result.operations[0].status, 'applied');
    assert.equal(getRememberedKey('TESTSRV01', storePath), 'FRESHKEY0001', '落盘被刷新为新 key');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A4：412 且探测到的实例 ID 不同 → 删除分区；ID 相同 → 保留分区', async () => {
  const dirDifferent = mkdtempSync(join(tmpdir(), 'zotero-mcp-persist-'));
  const dirSame = mkdtempSync(join(tmpdir(), 'zotero-mcp-persist-'));
  try {
    // 换实例：第二次探测返回另一个 server ID
    const p1 = join(dirDifferent, 'keys.json');
    putRememberedKey('TESTSRV01', 'STALEKEY0001', { path: p1 });
    const s1 = stub({ writeStatus: 412, probeIds: ['TESTSRV01', 'OTHERSRV99'] });
    await applyPlan(plan(), options(s1.fetchImpl, dirDifferent)).catch(() => {});
    assert.equal(getRememberedKey('TESTSRV01', p1), null, '换实例后旧分区必须作废');

    // 同一个实例的普通版本竞争：不得误删 remembered key（否则会白让使用者再点一次）
    const p2 = join(dirSame, 'keys.json');
    putRememberedKey('TESTSRV01', 'KEEPKEY0001', { path: p2 });
    const s2 = stub({ writeStatus: 412, probeIds: ['TESTSRV01'] });
    await applyPlan(plan(), options(s2.fetchImpl, dirSame)).catch(() => {});
    assert.equal(getRememberedKey('TESTSRV01', p2), 'KEEPKEY0001', '同一实例的 412 不应删除分区');
  } finally {
    rmSync(dirDifferent, { recursive: true, force: true });
    rmSync(dirSame, { recursive: true, force: true });
  }
});

test('A5：key 明文不出现在审计里（唯一 marker 扫描）', async () => {
  resetLocalApiAuthCache(); // 内存缓存不许跨用例串味（落盘才是跨进程层）
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-persist-'));
  const marker = 'MARKERKEY0123456789ABCDEF';
  try {
    const s = stub({ authorized: { key: marker, remember: true } });
    const result = await applyPlan(plan(), options(s.fetchImpl, dir));
    const audit = readFileSync(result.auditPath, 'utf8');
    assert.equal(audit.includes(marker), false, '审计里绝不能出现 key 明文');
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(marker), false, '返回结果里也不能出现 key 明文');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
