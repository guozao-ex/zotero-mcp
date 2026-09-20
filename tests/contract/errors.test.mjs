/**
 * 错误分类契约测试：五类错误路径（401 / 403 / 412 / 428 / 429）各有稳定语义，
 * 且端到端行为与路线图「错误码语义」表一致。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ZoteroChannelError,
  classifyFetchError,
  classifyStatus,
  describeError,
  probeLocalApi,
  requestLocalApi,
} from '../../packages/core/src/index.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

async function closedPortUrl() {
  const server = await startFakeZotero({ mode: 'ok', port: 0 });
  const url = server.url;
  await server.close();
  return url;
}

test('状态码 → 错误码映射覆盖 401/403/412/428/429', () => {
  assert.equal(classifyStatus(401), 'write-unauthorized');
  assert.equal(classifyStatus(403), 'local-api-disabled');
  assert.equal(classifyStatus(412), 'version-conflict');
  assert.equal(classifyStatus(428), 'missing-server-id');
  assert.equal(classifyStatus(429), 'rate-limited');
  assert.equal(classifyStatus(500), 'http-error');
});

test('每个错误码都带与路线图一致的处理策略', () => {
  assert.match(describeError('write-unauthorized').strategy, /重新走一次运行时授权/);
  assert.match(describeError('local-api-disabled').strategy, /不重试/);
  assert.match(describeError('version-conflict').strategy, /重新拉取对象/);
  assert.match(describeError('missing-server-id').strategy, /注入缓存的 serverID 后重试一次/);
  assert.match(describeError('rate-limited').strategy, /等待窗口恢复/);
  assert.equal(describeError('local-api-disabled').retryable, false);
  assert.equal(describeError('missing-server-id').retryable, true);
});

test('网络错误 → connection-refused', () => {
  assert.equal(classifyFetchError(Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })), 'connection-refused');
  assert.equal(classifyFetchError(Object.assign(new Error('timeout'), { name: 'TimeoutError' })), 'connection-refused');
  assert.equal(classifyFetchError(new Error('weird')), 'http-error');
});

test('401：写请求未授权 → write-unauthorized', async () => {
  const fake = await startFakeZotero({ mode: 'unauthorized', port: 0 });
  try {
    await assert.rejects(
      () => requestLocalApi({ baseUrl: fake.url, path: '/api/users/0/items', method: 'POST', body: { items: [] } }),
      (error) => {
        assert.ok(error instanceof ZoteroChannelError);
        assert.equal(error.code, 'write-unauthorized');
        assert.equal(error.status, 401);
        assert.equal(error.retryable, true);
        return true;
      },
    );
  } finally {
    await fake.close();
  }
});

test('403：本地 API 未开启 → local-api-disabled（探针与请求两条路径）', async () => {
  const fake = await startFakeZotero({ mode: 'api-disabled', port: 0 });
  try {
    const probed = await probeLocalApi({ baseUrl: fake.url });
    assert.equal(probed.errorCode, 'local-api-disabled');
    await assert.rejects(
      () => requestLocalApi({ baseUrl: fake.url, path: '/api/users/0/items' }),
      (error) => error.code === 'local-api-disabled' && error.status === 403,
    );
  } finally {
    await fake.close();
  }
});

test('412：版本冲突 → version-conflict（不可盲目重试）', async () => {
  const fake = await startFakeZotero({ mode: 'version-conflict', port: 0 });
  try {
    // 走**正常的数组体批量创建**路径：旧用例发的是 `{ items: [] }`，那条 body 形态会落到
    // 「非数组 / 非对象体」的兜底分支，因此即使模式名过宽也能拿到 412。这里必须用真的写形态。
    await assert.rejects(
      () =>
        requestLocalApi({
          baseUrl: fake.url,
          path: '/api/users/0/items',
          method: 'POST',
          headers: {
            'zotero-api-key': 'FAKEKEY00000000000000000000000000',
            'zotero-server-id': fake.serverId,
            'if-unmodified-since-version': '1',
          },
          body: [{ itemType: 'journalArticle', title: '版本冲突用例' }],
        }),
      (error) => error.code === 'version-conflict' && error.retryable === false,
    );
  } finally {
    await fake.close();
  }
});

test('version-conflict 模式覆盖任意写请求，且不影响读请求', async () => {
  const fake = await startFakeZotero({ mode: 'version-conflict', port: 0 });
  const writeHeaders = {
    'zotero-api-key': 'FAKEKEY00000000000000000000000000',
    'zotero-server-id': fake.serverId,
    'if-unmodified-since-version': '1',
  };
  try {
    const isConflict = (error) => error.code === 'version-conflict';

    // POST /collections（数组体）
    await assert.rejects(
      () =>
        requestLocalApi({
          baseUrl: fake.url,
          path: '/api/users/0/collections',
          method: 'POST',
          headers: writeHeaders,
          body: [{ name: '版本冲突集合' }],
        }),
      isConflict,
    );

    // PATCH /items/<key>：正常字段覆盖路径
    await assert.rejects(
      () =>
        requestLocalApi({
          baseUrl: fake.url,
          path: '/api/users/0/items/ITEM0001',
          method: 'PATCH',
          headers: writeHeaders,
          body: { extra: 'updated' },
        }),
      isConflict,
    );

    // DELETE /items/<key>
    await assert.rejects(
      () =>
        requestLocalApi({
          baseUrl: fake.url,
          path: '/api/users/0/items/ITEM0002',
          method: 'DELETE',
          headers: writeHeaders,
        }),
      isConflict,
    );

    // 写请求都被 412 拦下后，条目仍在库里（没有真的被改动或删除）
    const survived = await requestLocalApi({ baseUrl: fake.url, path: '/api/users/0/items/ITEM0002' });
    assert.equal(survived.status, 200);
  } finally {
    await fake.close();
  }
});

test('428：缺少 Zotero-Server-ID → missing-server-id；补头后成功', async () => {
  const fake = await startFakeZotero({ mode: 'missing-server-id', port: 0 });
  try {
    await assert.rejects(
      () => requestLocalApi({ baseUrl: fake.url, path: '/api/users/0/items', method: 'POST', body: { items: [] } }),
      (error) => error.code === 'missing-server-id' && error.status === 428,
    );
    const ok = await requestLocalApi({
      baseUrl: fake.url,
      path: '/api/users/0/items',
      method: 'POST',
      headers: { 'zotero-server-id': fake.serverId },
      body: { items: [] },
    });
    assert.equal(ok.status, 200);
  } finally {
    await fake.close();
  }
});

test('429：触发限流 → rate-limited（写会话停止等待窗口）', async () => {
  const fake = await startFakeZotero({ mode: 'rate-limited', port: 0 });
  try {
    await assert.rejects(
      () => requestLocalApi({ baseUrl: fake.url, path: '/api/local/authorize', method: 'POST', body: {} }),
      (error) => error.code === 'rate-limited' && error.status === 429,
    );
  } finally {
    await fake.close();
  }
});

test('连接被拒绝 → connection-refused（请求路径）', async () => {
  const url = await closedPortUrl();
  await assert.rejects(
    () => requestLocalApi({ baseUrl: url, path: '/api/users/0/items', timeoutMs: 1500 }),
    (error) => error.code === 'connection-refused',
  );
});

test('非回环地址被拒绝', async () => {
  await assert.rejects(() => requestLocalApi({ baseUrl: 'http://192.168.1.10:23119', path: '/api/users/0/items' }), /只允许访问回环地址/);
});

test('ZOTERO_MCP_BASE_URL 对 core 通道生效，且非回环被拒绝', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const previous = process.env['ZOTERO_MCP_BASE_URL'];
  try {
    // 环境变量生效：不传 baseUrl 也应打到该端口（此前 local-api 四个入口都直接用默认地址）
    process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
    const response = await requestLocalApi({ path: '/api/users/0/items/top?limit=1' });
    assert.equal(response.status, 200);
    assert.ok(
      fake.requests.some((entry) => entry.path === '/api/users/0/items/top'),
      '请求应真的打到环境变量指定的服务，而不是默认的 127.0.0.1:23119',
    );

    // 显式参数优先于环境变量
    const other = await startFakeZotero({ mode: 'ok', port: 0 });
    try {
      await requestLocalApi({ baseUrl: other.url, path: '/api/users/0/items/top?limit=1' });
      assert.ok(other.requests.length > 0, '显式 baseUrl 应优先生效');
    } finally {
      await other.close();
    }

    // 非回环：请求发出之前就被拒绝（服务端观察不到请求）
    process.env['ZOTERO_MCP_BASE_URL'] = 'http://192.0.2.10:23119';
    const beforeCount = fake.requests.length;
    await assert.rejects(() => requestLocalApi({ path: '/api/users/0/items/top?limit=1' }), /只允许访问回环地址/);
    assert.equal(fake.requests.length, beforeCount, '被拒绝的请求不得真的发出');
  } finally {
    if (previous === undefined) delete process.env['ZOTERO_MCP_BASE_URL'];
    else process.env['ZOTERO_MCP_BASE_URL'] = previous;
    await fake.close();
  }
});
