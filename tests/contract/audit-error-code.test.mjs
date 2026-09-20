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

/** 桩：写前读取可配（用于构造「集合不存在」的普通 Error）；写后回读一律 404（构造通道错误 http-error）。 */
function stub({ preReadMiss = false } = {}) {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
  const fetchImpl = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.includes('/items?limit=1')) return json([]);
    if (url.includes('/api/local/authorize')) return json({ key: 'FAKEKEY00000000000000000000000000' });
    if (method === 'PATCH' && url.includes('/collections/COL0001')) return new Response(null, { status: 204, headers: HEADERS });
    if (method === 'PATCH' && url.includes('/items/ITEM0001')) return new Response(null, { status: 204, headers: HEADERS });
    if (method === 'GET' && url.includes('/collections/COL0001')) return json({}, 404); // 前置读取失败 → 普通 Error
    if (method === 'GET' && url.includes('/items/ITEM0001')) {
      if (preReadMiss) return json({}, 404);
      return json({ key: 'ITEM0001', version: 5, data: { itemType: 'document', extra: 'x' } });
    }
    return json({}, 404);
  };
  return { fetchImpl };
}

const options = (fetchImpl, dir) => ({
  baseUrl: 'http://127.0.0.1:23119',
  fetchImpl,
  auditDir: dir,
  write: true,
  confirm: 'OVERWRITE',
  env: { ZOTERO_MCP_WRITE: 'on' },
});

/** 取失败审计行。 */
const failedLine = (auditPath) =>
  readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .find((entry) => entry.status === 'failed');

test('审计记 code：通道错误的失败行带准确 code（http-error），既有字段不丢', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-audit-'));
  const plan = makeChangePlan({
    targetKeys: ['ITEM0001'],
    changes: [],
    operations: [
      {
        kind: 'patch',
        key: 'ITEM0001',
        fields: { title: '不会成功的标题' },
      },
    ],
    summary: 'patch（写后回读恒 404 → 回读校验失败）',
  });
  try {
    const result = await applyPlan(plan, options(stub().fetchImpl, dir));
    assert.equal(result.operations[0].status, 'failed');
    const line = failedLine(result.auditPath);
    assert.equal(line['code'], 'http-error', '审计必须记下通道错误码');
    assert.equal(line['status'], 'failed');
    assert.equal(line['op'], 'patch');
    assert.equal(line['key'], 'ITEM0001', 'key 不得丢');
    assert.equal(typeof line['authorizeCount'], 'number');
    assert.match(String(line['error']), /回读(校验失败|内容与提交不符)/u, 'error 文案不变');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('审计记 code：非通道错误（普通 Error）显式记 null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-audit-'));
  // 集合重命名会先读集合；桩让该读取 404 → 抛普通 Error('集合不存在：COL0001')
  const plan = makeChangePlan({
    targetKeys: ['COL0001'],
    changes: [],
    operations: [{ kind: 'collection-rename', key: 'COL0001', name: '新名字' }],
    summary: '重命名不存在的集合',
  });
  try {
    const result = await applyPlan(plan, options(stub({ preReadMiss: true }).fetchImpl, dir));
    assert.equal(result.operations[0].status, 'failed');
    const line = failedLine(result.auditPath);
    assert.equal(line['code'], null, '普通 Error 的 code 必须显式为 null');
    assert.match(String(line['error']), /集合不存在/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
