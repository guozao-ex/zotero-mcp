/**
 * 契约层测试：zod 契约、响应头解析、JSON Schema 导出与缓存分区。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';

import {
  DEFAULT_LOCAL_API_BASE,
  JSON_SCHEMA_EXPORTS,
  UNKNOWN_HEADER_VALUE,
  assertLoopbackUrl,
  exportJsonSchemas,
  isLoopbackUrl,
  probeResultSchema,
  readZoteroHeaders,
  serverCachePath,
} from '../../packages/core/src/index.ts';

const VALID_PROBE_RESULT = {
  reachable: true,
  statusCode: 200,
  apiVersion: '3',
  serverId: 'ABC12345',
  schemaVersion: '42',
  writeAvailable: true,
  errorCode: null,
  reason: null,
  cachePath: 'cache/ABC12345',
  nextSteps: [],
  target: `${DEFAULT_LOCAL_API_BASE}/api/users/0/items?limit=1`,
  probedAt: '2026-01-01T00:00:00.000Z',
};

test('探针结果契约接受合法样例、拒绝缺字段样例', () => {
  assert.equal(probeResultSchema.safeParse(VALID_PROBE_RESULT).success, true);
  const missingWrite = { ...VALID_PROBE_RESULT };
  delete missingWrite.writeAvailable;
  assert.equal(probeResultSchema.safeParse(missingWrite).success, false);
  assert.equal(probeResultSchema.safeParse({ ...VALID_PROBE_RESULT, errorCode: 'nope' }).success, false);
});

test('响应头解析：缺失返回 unknown，不抛异常', () => {
  const empty = readZoteroHeaders(new Headers());
  assert.equal(empty.apiVersion, UNKNOWN_HEADER_VALUE);
  assert.equal(empty.serverId, UNKNOWN_HEADER_VALUE);
  assert.equal(empty.schemaVersion, UNKNOWN_HEADER_VALUE);

  const headers = new Headers({
    'zotero-api-version': '3',
    'zotero-server-id': 'ABCD1234',
    'zotero-schema-version': '42',
  });
  const parsed = readZoteroHeaders(headers);
  assert.deepEqual(parsed, { apiVersion: '3', serverId: 'ABCD1234', schemaVersion: '42' });
});

test('JSON Schema 导出：结构完整，可用于校验合法/非法样例', () => {
  const schemas = exportJsonSchemas();
  assert.deepEqual(Object.keys(schemas).sort(), Object.keys(JSON_SCHEMA_EXPORTS).sort());

  const probeSchema = schemas['probe-result'];
  assert.equal(probeSchema.type, 'object');
  assert.ok(Array.isArray(probeSchema.required));
  for (const required of ['reachable', 'writeAvailable', 'serverId', 'cachePath']) {
    assert.ok(probeSchema.required.includes(required), `required 缺少 ${required}`);
  }

  // 用 zod 自带能力把导出的 JSON Schema 转回校验器，验证往返一致
  const validator = z.fromJSONSchema(probeSchema);
  assert.equal(validator.safeParse(VALID_PROBE_RESULT).success, true);
  assert.equal(validator.safeParse({ ...VALID_PROBE_RESULT, reachable: 'yes' }).success, false);
  const missingCachePath = { ...VALID_PROBE_RESULT };
  delete missingCachePath.cachePath;
  assert.equal(validator.safeParse(missingCachePath).success, false);
});

test('缓存路径按 serverID 分区；未取得 serverID 时不产生路径', () => {
  assert.equal(serverCachePath(null), null);
  assert.equal(serverCachePath('unknown', undefined), null);
  assert.match(serverCachePath('SERVER01', 'cache') ?? '', /cache\/SERVER01$/);
});

test('回环约束', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:23119'), true);
  assert.equal(isLoopbackUrl('http://localhost:23119'), true);
  assert.equal(isLoopbackUrl('http://192.168.1.10:23119'), false);
  assert.equal(isLoopbackUrl('not-a-url'), false);
  assert.throws(() => assertLoopbackUrl('http://example.com:23119'), /只允许访问回环地址/);
  assert.doesNotThrow(() => assertLoopbackUrl('http://127.0.0.1:23119'));
});
