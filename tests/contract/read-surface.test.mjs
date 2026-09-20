/**
 * 只读能力层契约测试：全部通过假服务器驱动，不依赖真实 Zotero。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MAX_BATCH_KEYS,
  annotationDeepLink,
  chunk,
  countAnnotations,
  findDuplicateCandidates,
  getItems,
  libraryStats,
  listCollections,
  listTags,
  normalizeStrongKey,
  readContent,
  searchItems,
} from '../../packages/core/src/index.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

/** 记录所有请求方法与路径，用于证明只读约束。 */
function recordingFetch(record) {
  return async (input, init) => {
    record.push({ method: init?.method ?? 'GET', url: String(input) });
    return fetch(input, init);
  };
}

test('chunk 按 50 分批', () => {
  assert.equal(MAX_BATCH_KEYS, 50);
  assert.equal(chunk(Array.from({ length: 120 }, (_, index) => index), MAX_BATCH_KEYS).length, 3);
  assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]);
});

test('批量读取：多个 key + 子项/注释/笔记，且全程只读', async () => {
  const record = [];
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  try {
    const items = await getItems({
      baseUrl: fake.url,
      fetchImpl: recordingFetch(record),
      keys: ['ITEM0001', 'ITEM0003'],
      include: ['attachments', 'annotations', 'notes'],
    });
    assert.equal(items.length, 2);
    const withAnnotation = items.find((item) => item.key === 'ITEM0001');
    assert.equal(withAnnotation?.attachments.length, 1);
    assert.equal(withAnnotation?.attachments[0]?.isPdf, true);
    assert.equal(withAnnotation?.annotations.length, 1);
    assert.equal(withAnnotation?.annotations[0]?.pageLabel, '3');
    assert.equal(
      withAnnotation?.annotations[0]?.deepLink,
      'zotero://open-pdf/library/items/ATT00001?page=3&annotation=ANNO0001',
    );
    assert.equal(withAnnotation?.notes.length, 1);

    // 只读约束：所有请求都是 GET
    assert.ok(record.length >= 3);
    assert.deepEqual([...new Set(record.map((entry) => entry.method))], ['GET']);
    assert.ok(record.every((entry) => entry.url.includes('/api/users/0/')));
  } finally {
    await fake.close();
  }
});

test('超过 50 个 key 时自动分批（每批不超过 50）', async () => {
  const record = [];
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  try {
    const keys = Array.from({ length: 55 }, (_, index) => `ITEM${String(index).padStart(4, '0')}`);
    await getItems({ baseUrl: fake.url, fetchImpl: recordingFetch(record), keys });
    // 真机行为：本地 API 的 /items?itemKey= 不做过滤，因此实现逐条请求 /items/<key>
    const perItem = record.filter((entry) => /\/items\/ITEM\d{4}$/u.test(entry.url));
    assert.equal(perItem.length, 55);
    assert.ok(record.every((entry) => !entry.url.includes('itemKey=') || entry.url.includes('itemKey=ITEM')));
  } finally {
    await fake.close();
  }
});

test('搜索：saved 模式走 /searches/<key>/items', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  try {
    const saved = await searchItems({ baseUrl: fake.url, mode: 'saved', savedSearchKey: 'SEARCH01' });
    assert.match(saved.path, /^\/api\/users\/0\/searches\/SEARCH01\/items/u);
    assert.equal(saved.items.length, 1);

    const keyword = await searchItems({ baseUrl: fake.url, mode: 'keyword', query: 'alpha' });
    assert.match(keyword.path, /qmode=titleCreatorYear/u);
    assert.equal(keyword.items.length, 2);

    const fulltext = await searchItems({ baseUrl: fake.url, mode: 'fulltext', query: 'alpha' });
    assert.match(fulltext.path, /qmode=everything/u);

    await assert.rejects(() => searchItems({ baseUrl: fake.url, mode: 'saved' }), /savedSearchKey/u);
    await assert.rejects(() => searchItems({ baseUrl: fake.url, mode: 'keyword' }), /query/u);
  } finally {
    await fake.close();
  }
});

test('集合树与标签', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  try {
    const collections = await listCollections({ baseUrl: fake.url });
    assert.equal(collections.flat.length, 1);
    assert.equal(collections.flat[0]?.path, '/Reading');
    assert.equal(collections.flat[0]?.itemCount, 1);
    assert.equal(collections.tree.length, 1);

    const tags = await listTags({ baseUrl: fake.url });
    assert.deepEqual(tags, [{ tag: 'alpha', itemCount: 1 }]);
  } finally {
    await fake.close();
  }
});

test('内容读取：mode=path 经 302，mode=fulltext 取索引正文', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  try {
    const path = await readContent({ baseUrl: fake.url, key: 'ATT00001', mode: 'path' });
    assert.equal(path.source, 'redirect-302');
    assert.match(path.path ?? '', /paper\.pdf$/u);

    const fulltext = await readContent({ baseUrl: fake.url, key: 'ATT00001', mode: 'fulltext' });
    assert.equal(fulltext.source, 'fulltext-endpoint');
    assert.match(fulltext.content ?? '', /Alpha paper full text/u);
    assert.equal(typeof fulltext.indexedChars, 'number');
  } finally {
    await fake.close();
  }
});

test('库健康度与强键重复候选', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  try {
    const stats = await libraryStats({ baseUrl: fake.url });
    assert.equal(stats.totalItems, 3);
    assert.equal(stats.missingPdf, 1);
    assert.equal(stats.missingDoi, 1);
    assert.equal(stats.unfiled, 2);
    assert.equal(stats.byItemType['journalArticle'], 2);

    const duplicates = await findDuplicateCandidates({ baseUrl: fake.url });
    assert.equal(duplicates.length, 1);
    const cluster = duplicates[0];
    assert.equal(cluster?.matchType, 'doi');
    assert.equal(cluster?.matchKey, '10.1000/alpha');
    assert.equal(cluster?.items.length, 2);
    // 两个候选附件数相同（1 vs 1），注释数不同（1 vs 0）→ 注释更全者优先
    const byKey = Object.fromEntries((cluster?.items ?? []).map((item) => [item.key, item]));
    assert.equal(byKey['ITEM0001']?.attachmentCount, 1);
    assert.equal(byKey['ITEM0002']?.attachmentCount, 1);
    assert.equal(byKey['ITEM0001']?.annotationCount, 1);
    assert.equal(byKey['ITEM0002']?.annotationCount, 0);
    assert.equal(cluster?.suggestedPrimary, 'ITEM0001');

    assert.equal(normalizeStrongKey('doi', 'https://doi.org/10.1000/ALPHA'), '10.1000/alpha');
    assert.equal(normalizeStrongKey('isbn', '978-0-306-40615-7'), '9780306406157');
    assert.equal(normalizeStrongKey('pmid', 'PMID: 12345678'), '12345678');
  } finally {
    await fake.close();
  }
});

test('注释深链接构造', () => {
  assert.equal(
    annotationDeepLink('ATT1', 'ANNO1', '12'),
    'zotero://open-pdf/library/items/ATT1?page=12&annotation=ANNO1',
  );
  assert.equal(annotationDeepLink('ATT1', 'ANNO1', null), 'zotero://open-pdf/library/items/ATT1?annotation=ANNO1');
});

test('语义模式降级时真的回退关键词 / 全文检索（而不是只返回空命中）', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createServer } = await import('../../packages/mcp-server/src/server.ts');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  // 指向一个空索引目录：索引不存在 → semanticSearch 必然 degraded
  const indexDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-empty-index-'));
  const previousBase = process.env['ZOTERO_MCP_BASE_URL'];
  const previousIndex = process.env['ZOTERO_MCP_INDEX_DIR'];
  process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
  process.env['ZOTERO_MCP_INDEX_DIR'] = indexDir;

  const server = createServer();
  const client = new Client({ name: 'read-surface-semantic', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    // 命中型 query：全文回退应当带真实命中
    const hit = await client.callTool({ name: 'zotero_search', arguments: { mode: 'semantic', query: 'alpha' } });
    const hitPayload = JSON.parse(hit.content[0].text);
    assert.equal(hitPayload.degraded, true, '索引不存在时必须如实降级');
    assert.equal(typeof hitPayload.reason, 'string');
    assert.ok(hitPayload.reason.length > 0);
    assert.equal(hitPayload.fallback.mode, 'fulltext', '先走全文检索');
    assert.ok(hitPayload.fallback.items.length > 0, '回退必须带回真实命中，而不是空数组');

    // 零命中型 query：全文无结果时应继续回退到关键词
    const miss = await client.callTool({ name: 'zotero_search', arguments: { mode: 'semantic', query: 'zzz-no-such-term' } });
    const missPayload = JSON.parse(miss.content[0].text);
    assert.equal(missPayload.degraded, true);
    assert.equal(missPayload.fallback.mode, 'keyword', '全文没有命中时继续回退关键词');
    assert.deepEqual(missPayload.fallback.items, []);

    // 其余模式不受影响：同一 query 的 keyword 结果与回退结果同口径
    const keyword = await client.callTool({ name: 'zotero_search', arguments: { mode: 'keyword', query: 'alpha' } });
    const keywordPayload = JSON.parse(keyword.content[0].text);
    assert.equal(keywordPayload.mode, 'keyword');
    assert.equal(keywordPayload.degraded, undefined, 'keyword 模式不带降级标记');
    assert.deepEqual(
      keywordPayload.items.map((item) => item.key).sort(),
      hitPayload.fallback.items.map((item) => item.key).sort(),
    );
  } finally {
    await client.close();
    await server.close();
    if (previousBase === undefined) delete process.env['ZOTERO_MCP_BASE_URL'];
    else process.env['ZOTERO_MCP_BASE_URL'] = previousBase;
    if (previousIndex === undefined) delete process.env['ZOTERO_MCP_INDEX_DIR'];
    else process.env['ZOTERO_MCP_INDEX_DIR'] = previousIndex;
    await fake.close();
    rmSync(indexDir, { recursive: true, force: true });
  }
});

// ── 注释读取的真机语义（Zotero 10.0.3：/children 不带 itemType 过滤不返回注释） ──

test('注释读取：走带 itemType=annotation 过滤的子项查询，计数一致且零注释如实', async () => {
  const fake = await startFakeZotero({
    mode: 'ok',
    port: 0,
    library: {
      items: [
        {
          key: 'ITEM0001',
          version: 1,
          data: { itemType: 'journalArticle', title: 'With annotations', date: '2020', collections: [], tags: [] },
        },
        {
          key: 'ITEM0002',
          version: 1,
          data: { itemType: 'journalArticle', title: 'Without annotations', date: '2021', collections: [], tags: [] },
        },
      ],
      children: {
        ITEM0001: [
          {
            key: 'ATT00001',
            version: 1,
            data: {
              itemType: 'attachment',
              contentType: 'application/pdf',
              title: 'PDF',
              linkMode: 'imported_url',
              parentItem: 'ITEM0001',
            },
          },
        ],
        ITEM0002: [
          {
            key: 'ATT00002',
            version: 1,
            data: {
              itemType: 'attachment',
              contentType: 'application/pdf',
              title: 'PDF',
              linkMode: 'imported_url',
              parentItem: 'ITEM0002',
            },
          },
        ],
        ATT00001: [
          {
            key: 'ANNO0001',
            version: 1,
            data: {
              itemType: 'annotation',
              annotationType: 'highlight',
              annotationText: 'first',
              annotationPageLabel: '3',
              annotationPosition: '{"pageIndex":2}',
              parentItem: 'ATT00001',
            },
          },
          {
            key: 'ANNO0002',
            version: 1,
            data: {
              itemType: 'annotation',
              annotationType: 'underline',
              annotationText: 'second',
              annotationPageLabel: '5',
              annotationPosition: '{"pageIndex":4}',
              parentItem: 'ATT00001',
            },
          },
        ],
        ATT00002: [],
      },
    },
  });
  try {
    const [detail] = await getItems({ baseUrl: fake.url, keys: ['ITEM0001'], include: ['attachments', 'annotations'] });
    assert.equal(detail.annotations.length, 2, '真机语义下也必须取到 2 条注释');
    assert.deepEqual(detail.annotations.map((entry) => entry.key).sort(), ['ANNO0001', 'ANNO0002']);
    assert.equal(detail.annotations[0].pageLabel !== null, true);
    assert.match(String(detail.annotations[0].deepLink), /^zotero:\/\/open-pdf\/library\/items\/ATT00001\?/u);
    assert.equal(detail.attachments.find((entry) => entry.key === 'ATT00001')?.annotationCount, 2);
    assert.equal(await countAnnotations('ITEM0001', { baseUrl: fake.url }), 2);

    // 零注释：如实返回 0 / 空，不报错也不编造
    const [empty] = await getItems({ baseUrl: fake.url, keys: ['ITEM0002'], include: ['attachments', 'annotations'] });
    assert.equal(empty.annotations.length, 0);
    assert.equal(empty.attachments[0]?.annotationCount, 0);
    assert.equal(await countAnnotations('ITEM0002', { baseUrl: fake.url }), 0);

    // 读层的注释查询确实带了过滤参数（假服务器只把 pathname 存进 path，查询串在 url）
    const annotationQueries = fake.requests.filter(
      (request) => request.url.includes('/children') && request.url.includes('itemType=annotation'),
    );
    assert.ok(annotationQueries.length >= 2, `必须用带过滤的查询取注释，实际 ${annotationQueries.length} 次`);
    assert.ok(annotationQueries.every((request) => request.method === 'GET'), '注释查询必须是只读');
  } finally {
    await fake.close();
  }
});
