import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { applyPlan, makeChangePlan } from '../../packages/core/src/index.ts';

process.env['ZOTERO_MCP_WRITE'] = 'on';

const AUTHORIZE_KEY = 'FAKEKEY00000000000000000000000000';

/** 最小可编程假本地 API：不起服务器，直接实现 fetch 形状（真 Response）。 */
function stubServer({ readback, itemType = 'document', title = 'X' }) {
  const calls = { probe: 0, authorize: 0, create: 0, readback: 0 };
  // 本机 API 的探测与写请求都要读这三个头（否则管线判定「不可写」）
  const zoteroHeaders = {
    'content-type': 'application/json',
    'zotero-api-version': '3',
    'zotero-server-id': 'TESTSRV01',
    'zotero-schema-version': '44',
  };
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: zoteroHeaders });
  const fetchImpl = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    // 探测：/api/users/0/items?limit=1
    if (method === 'GET' && url.includes('/items?limit=1')) {
      calls.probe += 1;
      return json([]);
    }
    if (url.includes('/api/local/authorize')) {
      calls.authorize += 1;
      return json({ key: AUTHORIZE_KEY });
    }
    if (method === 'POST' && /\/items$/u.test(url)) {
      calls.create += 1;
      return json({ successful: { 0: { key: 'NEWITEM01', version: 1 } }, success: { 0: 'NEWITEM01' } });
    }
    if (method === 'GET' && url.includes('/items/NEWITEM01')) {
      calls.readback += 1;
      const answer = readback(calls.readback);
      if (answer === null) return json({}, 404);
      return json({ key: 'NEWITEM01', version: 1, data: { itemType, title, ...answer } });
    }
    return json({}, 404);
  };
  return { fetchImpl, calls };
}

function createPlan() {
  return makeChangePlan({
    targetKeys: [],
    changes: [],
    operations: [{ kind: 'create', itemType: 'document', fields: { title: 'X' }, source: 'readback-test' }],
    summary: '新建一个 document',
  });
}

const run = async (stub, dir) =>
  applyPlan(createPlan(), {
    baseUrl: 'http://127.0.0.1:23119',
    fetchImpl: stub.fetchImpl,
    auditDir: dir,
    write: true,
    env: { ZOTERO_MCP_WRITE: 'on' },
  });

test('回读重试：刚创建后瞬时读不到（前两次 404）不再误报失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-readback-'));
  // 第 1、2 次读回 404；第 3 次返回正确条目
  const stub = stubServer({ readback: (n) => (n < 3 ? null : {}) });
  try {
    const result = await run(stub, dir);
    assert.deepEqual(result.createdKeys, ['NEWITEM01'], '重试后应判定为创建成功');
    assert.equal(result.operations[0].status, 'applied');
    assert.equal(result.operations.filter((op) => op.status === 'failed').length, 0, '不得出现误报失败');
    assert.equal(stub.calls.create, 1, '不应重复创建');
    assert.ok(stub.calls.readback >= 3, `应重试读回（实际 ${stub.calls.readback} 次）`);
    const audit = readFileSync(result.auditPath, 'utf8');
    assert.doesNotMatch(audit, /回读校验失败/u, '审计里不得出现回读失败');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('回读持续读不到：仍 fail-closed，但错误码为 http-error（不再误用 write-unauthorized）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-readback-'));
  const stub = stubServer({ readback: () => null });
  try {
    const result = await run(stub, dir);
    assert.deepEqual(result.createdKeys, [], '读不回来就不得算成功');
    const failed = result.operations.filter((op) => op.status === 'failed');
    assert.equal(failed.length, 1);
    // 失败原因写在审计里（operations[] 只有 kind/key/status）
    const audit = readFileSync(result.auditPath, 'utf8');
    assert.match(audit, /回读校验失败/u, '审计要点明是回读校验');
    assert.match(audit, /已重试 3 次/u, '审计要含重试次数');
    assert.doesNotMatch(audit, /write-unauthorized/u, '不得再误用 write-unauthorized');
    assert.doesNotMatch(audit, /授权/u, '不得再误导向授权问题');
    assert.equal(result.submittedKeys.includes('NEWITEM01'), false);
    assert.equal(stub.calls.readback, 3, '重试次数应有界（3 次）');
    // 快照里仍登记该 key（可清理）
    const snapshot = JSON.parse(readFileSync(result.snapshotPath, 'utf8'));
    assert.ok(snapshot.created.some((item) => item.key === 'NEWITEM01'), '失败时快照仍要登记，便于清理');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('回读内容不符：与「读不到」用不同文案区分，同样 fail-closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-readback-'));
  const stub = stubServer({ readback: () => ({ itemType: 'note' }) });
  try {
    const result = await run(stub, dir);
    const failed = result.operations.filter((op) => op.status === 'failed');
    assert.equal(failed.length, 1);
    const audit = readFileSync(result.auditPath, 'utf8');
    assert.match(audit, /回读内容与提交不符/u, '内容不符要有独立文案');
    assert.doesNotMatch(audit, /回读校验失败/u, '不得与「读不到」混用同一句');
    assert.equal(stub.calls.readback, 1, '内容不符不需要重试');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
