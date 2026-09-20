import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { applyPlan, makeChangePlan } from '../../packages/core/src/index.ts';

process.env['ZOTERO_MCP_WRITE'] = 'on';

const HEADERS = {
  'content-type': 'application/json',
  'zotero-api-version': '3',
  'zotero-server-id': 'TESTSRV01',
  'zotero-schema-version': '44',
};

/** 可编程桩：不起服务器，注入 fetchImpl。reads 控制「第 n 次读回」的应答。 */
function stub({ reads, kind = 'patch' }) {
  const calls = { create: 0, patch: 0, readback: 0, afterWrite: 0 };
  let wrote = false;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
  const fetchImpl = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.includes('/items?limit=1')) return json([]);
    if (url.includes('/api/local/authorize')) return json({ key: 'FAKEKEY00000000000000000000000000' });
    if (method === 'POST' && /\/items$/u.test(url)) {
      calls.create += 1;
      wrote = true;
      return json({ successful: { 0: { key: 'NEWITEM01', version: 1 } } });
    }
    if (method === 'POST' && /\/collections$/u.test(url)) {
      calls.create += 1;
      wrote = true;
      return json({ successful: { 0: { key: 'NEWCOL01', version: 1 } } });
    }
    if (method === 'PATCH' && url.includes('/items/ITEM0001')) {
      calls.patch += 1;
      wrote = true;
      return new Response(null, { status: 204, headers: HEADERS }); // 204 不得带 body
    }
    if ((method === 'PATCH' || method === 'PUT') && url.includes('/collections/COL0001')) {
      calls.patch += 1;
      wrote = true;
      return new Response(null, { status: 204, headers: HEADERS }); // 204 不得带 body
    }
    if (method === 'GET' && url.includes('/items/ITEM0001')) {
      if (!wrote) return json({ key: 'ITEM0001', version: 5, data: { itemType: 'document', extra: 'x' } });
      calls.readback += 1;
      calls.afterWrite += 1;
      const answer = reads(calls.afterWrite);
      if (answer === null) return json({}, 404);
      return json({ key: 'ITEM0001', version: 5, data: { itemType: 'document', ...answer } });
    }
    if (method === 'GET' && url.includes('/collections/COL0001')) {
      if (!wrote) return json({ key: 'COL0001', version: 5, data: { name: '集合' } });
      calls.readback += 1;
      calls.afterWrite += 1;
      const answer = reads(calls.afterWrite);
      if (answer === null) return json({}, 404);
      return json({ key: 'COL0001', version: 5, data: { name: '集合', ...answer } });
    }
    if (method === 'GET' && url.includes('/collections/NEWCOL01')) {
      if (!wrote) return json({ key: 'NEWCOL01', version: 5, data: { name: '新集合' } });
      calls.readback += 1;
      calls.afterWrite += 1;
      const answer = reads(calls.afterWrite);
      if (answer === null) return json({}, 404);
      return json({ key: 'NEWCOL01', version: 5, data: { name: '新集合', ...answer } });
    }
    return json({}, 404);
  };
  return { fetchImpl, calls };
}

const options = (fetchImpl, dir) => ({
  baseUrl: 'http://127.0.0.1:23119',
  fetchImpl,
  auditDir: dir,
  write: true,
  confirm: 'OVERWRITE',
  env: { ZOTERO_MCP_WRITE: 'on' },
});

const patchPlan = () =>
  makeChangePlan({ targetKeys: ['ITEM0001'], changes: [], operations: [{ kind: 'patch', key: 'ITEM0001', fields: { extra: 'x' } }], summary: 'patch' });

test('patch 回读：瞬时读不到会重试并成功；持续读不到用 http-error + 准确文案', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-rb-'));
  try {
    // 瞬时：前两次 404、第三次返回匹配字段
    const okStub = stub({ reads: (n) => (n < 3 ? null : { extra: 'x' }) });
    const ok = await applyPlan(patchPlan(), options(okStub.fetchImpl, dir));
    assert.equal(ok.operations[0].status, 'applied', '重试后 patch 应成功');
    assert.ok(okStub.calls.afterWrite >= 3);

    // 持续 404
    const failStub = stub({ reads: () => null });
    const fail = await applyPlan(patchPlan(), options(failStub.fetchImpl, dir));
    assert.equal(fail.operations[0].status, 'failed');
    const audit = readFileSync(fail.auditPath, 'utf8');
    assert.match(audit, /回读校验失败/u);
    assert.match(audit, /已重试 3 次/u);
    assert.doesNotMatch(audit, /write-unauthorized/u, '不得再用 write-unauthorized');
    assert.equal(failStub.calls.afterWrite, 3, '写后回读重试应有界（恰好 3 次）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('patch 回读内容不符：独立文案、不重试', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-rb-'));
  const mismatch = stub({ reads: () => ({ extra: '别的值' }) });
  try {
    const result = await applyPlan(patchPlan(), options(mismatch.fetchImpl, dir));
    assert.equal(result.operations[0].status, 'failed');
    const audit = readFileSync(result.auditPath, 'utf8');
    assert.match(audit, /回读内容与提交不符/u);
    assert.doesNotMatch(audit, /已重试/u, '内容不符不应重试');
    assert.equal(mismatch.calls.afterWrite, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const collectionPlan = () =>
  makeChangePlan({ targetKeys: [], changes: [], operations: [{ kind: 'collection-create', name: '新集合' }], summary: '集合' });

test('集合创建回读：瞬时读不到会重试并成功；持续读不到用 http-error + 准确文案', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-rb-'));
  try {
    const okStub = stub({ reads: (n) => (n < 3 ? null : { name: '新集合' }), kind: 'collection' });
    const ok = await applyPlan(collectionPlan(), options(okStub.fetchImpl, dir));
    assert.equal(ok.operations[0].status, 'applied', '重试后集合创建应成功');

    const failStub = stub({ reads: () => null, kind: 'collection' });
    const fail = await applyPlan(collectionPlan(), options(failStub.fetchImpl, dir));
    assert.equal(fail.operations[0].status, 'failed');
    const audit = readFileSync(fail.auditPath, 'utf8');
    assert.match(audit, /新建集合回读校验失败/u);
    assert.match(audit, /已重试 3 次/u);
    assert.doesNotMatch(audit, /write-unauthorized/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const renamePlan = () =>
  makeChangePlan({ targetKeys: ['COL0001'], changes: [], operations: [{ kind: 'collection-rename', key: 'COL0001', name: '集合' }], summary: '改名' });

test('集合重命名回读：瞬时读不到会重试并成功；持续读不到用 http-error + 准确文案', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-rb-'));
  try {
    const okStub = stub({ reads: (n) => (n < 3 ? null : { name: '集合' }), kind: 'collection' });
    const ok = await applyPlan(renamePlan(), options(okStub.fetchImpl, dir));
    assert.equal(ok.operations[0].status, 'applied', '重试后重命名应成功；审计=' + readFileSync(ok.auditPath, 'utf8'));

    const failStub = stub({ reads: () => null, kind: 'collection' });
    const fail = await applyPlan(renamePlan(), options(failStub.fetchImpl, dir));
    assert.equal(fail.operations[0].status, 'failed', readFileSync(fail.auditPath, 'utf8'));
    const audit = readFileSync(fail.auditPath, 'utf8');
    assert.match(audit, /集合重命名回读校验失败/u);
    assert.doesNotMatch(audit, /write-unauthorized/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
