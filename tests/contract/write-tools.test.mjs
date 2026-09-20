/**
 * 写 / 整理工具面契约测试（change 5 · m2-write-tools）。
 *
 * 覆盖 A1–A17 中可在离线环境验证的部分：工具清单与契约、默认只读、创建 / 更新 / 删除、
 * 集合 / 标签 / 附件 / 笔记、标识符导入与非写入失败路径、演示脚本默认 dry-run。
 * 全部走假服务器与临时审计目录，不触真实库、不写真实 .audit。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  applyPlan,
  buildAddItemsPlan,
  buildAddNotePlan,
  buildCreateItemPlan,
  detectIdentifierKind,
  makeChangePlan,
  fetchAllTopItems,
  getItems,
  mapCrossrefWork,
  mapOpenLibraryBook,
  mapPubmedSummary,
  resolveIdentifier,
  rollbackFromSnapshot,
} from '../../packages/core/src/index.ts';
import { createServer } from '../../packages/mcp-server/src/server.ts';
import { TOOL_NAMES, WRITE_TOOL_NAMES } from '../../packages/mcp-server/src/tools.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

const execFileAsync = promisify(execFile);
const DEMO_SCRIPT = fileURLToPath(new URL('../../scripts/write-tools-demo.mjs', import.meta.url));
const FAKE_AUTHORIZE_KEY = 'FAKEKEY00000000000000000000000000';

async function connectPair() {
  const server = createServer();
  const client = new Client({ name: 'write-tools-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function parseResult(result) {
  return JSON.parse(String(result.content[0]?.text ?? 'null'));
}

/** 起假服务器 + 临时审计目录，并把环境变量指过去；结束后完整恢复。 */
async function withFake(fn, options = {}) {
  const fake = await startFakeZotero({ mode: 'ok', port: 0, ...options });
  const auditDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-write-tools-'));
  const previous = {
    base: process.env['ZOTERO_MCP_BASE_URL'],
    write: process.env['ZOTERO_MCP_WRITE'],
    audit: process.env['ZOTERO_MCP_AUDIT_DIR'],
  };
  process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
  process.env['ZOTERO_MCP_AUDIT_DIR'] = auditDir;
  const { client, server } = await connectPair();
  try {
    return await fn({ fake, client, server, auditDir });
  } finally {
    await client.close();
    await server.close();
    await fake.close();
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('ZOTERO_MCP_BASE_URL', previous.base);
    restore('ZOTERO_MCP_WRITE', previous.write);
    restore('ZOTERO_MCP_AUDIT_DIR', previous.audit);
    rmSync(auditDir, { recursive: true, force: true });
  }
}

function nonGetRequests(fake) {
  return fake.requests.filter((request) => request.method !== 'GET');
}

test('A11 工具清单：9 个写工具契约完备（enum 化 action/mode），总数与 write-tools 规格一致', async () => {
  const { client, server } = await connectPair();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 24);
    assert.equal(TOOL_NAMES.length, 24);
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...TOOL_NAMES].sort(),
    );
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const name of WRITE_TOOL_NAMES) {
      const tool = byName.get(name);
      assert.ok(tool, `缺少写工具 ${name}`);
      assert.ok(tool.inputSchema !== undefined && tool.inputSchema !== null, `${name} 缺少 JSON Schema`);
      assert.ok(
        Object.keys(tool.inputSchema.properties ?? {}).includes('dryRun'),
        `${name} 缺少 dryRun 参数`,
      );
    }
    const collections = byName.get('zotero_manage_collections');
    assert.deepEqual(collections.inputSchema.properties.action.enum, ['create', 'rename', 'addItems', 'removeItems']);
    const tags = byName.get('zotero_manage_tags');
    assert.deepEqual(tags.inputSchema.properties.action.enum, ['add', 'remove', 'rename']);
    const addItems = byName.get('zotero_add_items');
    assert.deepEqual(addItems.inputSchema.properties.mode.enum, ['identifier', 'pdf']);
    assert.deepEqual(addItems.inputSchema.properties.identifierType.enum, ['auto', 'doi', 'isbn', 'pmid']);
    const deleteItems = byName.get('zotero_delete_items');
    assert.equal(deleteItems.inputSchema.properties.permanent.type, 'boolean');
    assert.match(deleteItems.description, /垃圾箱/u);
  } finally {
    await client.close();
    await server.close();
  }
});

test('A12 默认只读：ZOTERO_MCP_WRITE 未开启时 8 个写工具全部被拒绝且零写请求', async () => {
  await withFake(async ({ fake, client, auditDir }) => {
    delete process.env['ZOTERO_MCP_WRITE'];
    const linked = join(auditDir, 'linked.pdf');
    writeFileSync(linked, '%PDF-1.4 fake', 'utf8');
    const calls = [
      ['zotero_create_item', { itemType: 'journalArticle', fields: { title: 'x' } }],
      ['zotero_update_item', { updates: [{ key: 'ITEM0003', field: 'language', value: 'en' }] }],
      ['zotero_delete_items', { keys: ['ITEM0003'] }],
      ['zotero_manage_collections', { action: 'create', name: 'NoWrite' }],
      ['zotero_manage_tags', { action: 'add', keys: ['ITEM0003'], tags: ['t'] }],
      ['zotero_attach_file', { parentKey: 'ITEM0001', mode: 'linked', path: linked }],
      ['zotero_add_note', { parentKey: 'ITEM0001', content: 'hello' }],
      ['zotero_add_items', { mode: 'identifier', identifier: '10.1000/alpha' }],
    ];
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: { ...args, dryRun: false } });
      assert.equal(result.isError, true, `${name} 应被默认只读拒绝`);
      assert.match(String(result.content[0]?.text ?? ''), /ZOTERO_MCP_WRITE|默认只读/u, `${name} 的拒绝原因不可读`);
    }
    assert.deepEqual(nonGetRequests(fake), []);
    assert.equal(fake.requests.length, 0, '默认只读时不应发出任何请求（连计划都不生成）');
  });
});

test('A13 创建条目经写管线并留痕（结果 / 快照 / 审计）', async () => {
  await withFake(async ({ fake, client, auditDir }) => {
    process.env['ZOTERO_MCP_WRITE'] = 'on';
    const result = await client.callTool({
      name: 'zotero_create_item',
      arguments: {
        itemType: 'journalArticle',
        fields: { title: 'Pipeline created', DOI: '10.1000/pipeline', date: '2026' },
        creators: [{ firstName: 'Ada', lastName: 'Lovelace' }],
        collections: ['COLL0001'],
        dryRun: false,
      },
    });
    assert.notEqual(result.isError, true, String(result.content[0]?.text ?? ''));
    const payload = parseResult(result);
    assert.equal(payload.ok, true, '全部操作成功时 ok 必须为 true');
    assert.deepEqual(payload.failed, []);
    const key = payload.result.createdKeys[0];
    assert.ok(typeof key === 'string' && key.length > 0, '结果里应包含新条目 key');
    assert.equal(payload.result.authorizeCount, 1, '同一计划只授权一次');
    assert.equal(
      fake.requests.filter((request) => request.path === '/api/local/authorize').length,
      1,
      '授权请求只应出现一次',
    );
    assert.ok(
      fake.requests.some((request) => request.method === 'POST' && request.path === '/api/users/0/items'),
      '创建走 POST /items',
    );

    const [created] = await getItems({ baseUrl: fake.url, keys: [key] });
    assert.equal(created.data['title'], 'Pipeline created');
    assert.deepEqual(created.collections, ['COLL0001']);
    assert.deepEqual(created.creators, ['Lovelace, Ada']);

    const snapshot = JSON.parse(readFileSync(payload.result.snapshotPath, 'utf8'));
    assert.ok(payload.result.snapshotPath.startsWith(auditDir), '快照应落在配置的审计目录');
    assert.ok(
      snapshot.created.some((entry) => entry.key === key),
      '新 key 必须写入写前快照',
    );
    const audit = readFileSync(payload.result.auditPath, 'utf8');
    assert.match(audit, new RegExp(key, 'u'), '新 key 必须写入审计 JSONL');
    assert.match(audit, /"status":"created"/u);
  });
});

test('A4 更新条目：dry-run 给出字段级 before → after diff，提交后回读一致', async () => {
  await withFake(async ({ fake, client }) => {
    process.env['ZOTERO_MCP_WRITE'] = 'on';
    const dry = await client.callTool({
      name: 'zotero_update_item',
      arguments: { updates: [{ key: 'ITEM0003', field: 'extra', value: 'dry-run-only' }] },
    });
    const dryPayload = parseResult(dry);
    assert.equal(dryPayload.dryRun, true);
    assert.match(dryPayload.preview, /extra:.*→.*dry-run-only/u);
    assert.equal(dryPayload.plan.changes.length, 1);
    assert.equal(dryPayload.plan.changes[0].before, null);
    assert.equal(fake.requests.length, 1, 'dry-run 只读取条目（一次 GET）');

    const applied = await client.callTool({
      name: 'zotero_update_item',
      arguments: { updates: [{ key: 'ITEM0003', field: 'extra', value: 'dry-run-only' }], dryRun: false },
    });
    const payload = parseResult(applied);
    assert.deepEqual(payload.result.submittedKeys, ['ITEM0003']);
    assert.equal(payload.result.operations[0].status, 'applied');
    const [item] = await getItems({ baseUrl: fake.url, keys: ['ITEM0003'] });
    assert.equal(item.data['extra'], 'dry-run-only');
  });
});

test('A5/A14 删除：默认进垃圾箱可读回，永久删除需要 confirm="DELETE"', async () => {
  await withFake(async ({ fake, client }) => {
    process.env['ZOTERO_MCP_WRITE'] = 'on';

    const trashResult = await client.callTool({
      name: 'zotero_delete_items',
      arguments: { keys: ['ITEM0003'], dryRun: false },
    });
    assert.notEqual(trashResult.isError, true, String(trashResult.content[0]?.text ?? ''));
    const trashed = parseResult(trashResult);
    assert.deepEqual(trashed.operationKinds, ['trash']);
    assert.equal(trashed.result.operations[0].status, 'applied');
    const trashList = await fetch(`${fake.url}/api/users/0/items/trash?limit=100`, {
      headers: { accept: 'application/json' },
    }).then((response) => response.json());
    assert.ok(
      Array.isArray(trashList) && trashList.some((entry) => entry.key === 'ITEM0003'),
      '条目应能从 /items/trash 读回',
    );
    // 真机语义：进垃圾箱是 PATCH {"deleted":1}，DELETE 在真机上是永久删除
    const trashRequest = fake.requests.find(
      (request) => request.method === 'PATCH' && request.path.endsWith('/ITEM0003'),
    );
    assert.ok(trashRequest, '移入垃圾箱必须走 PATCH /items/<key>');
    assert.match(String(trashRequest.body), /"deleted":1/u);
    assert.ok(
      !fake.requests.some((request) => request.method === 'DELETE'),
      '默认删除不得发出 DELETE（真机 DELETE 是永久删除）',
    );
    const topAfterTrash = await fetch(`${fake.url}/api/users/0/items/top?limit=100`, {
      headers: { accept: 'application/json' },
    }).then((response) => response.json());
    assert.ok(
      !topAfterTrash.some((entry) => entry.key === 'ITEM0003'),
      '垃圾箱条目不应出现在 /items/top',
    );
    const trashedItem = await fetch(`${fake.url}/api/users/0/items/ITEM0003`, {
      headers: { accept: 'application/json' },
    });
    assert.equal(trashedItem.status, 200, '垃圾箱条目的单条读取仍应 200');
    assert.equal((await trashedItem.json()).data.deleted, true);

    // 永久删除缺 confirm → 被拒绝，条目仍在垃圾箱
    const missingConfirm = await client.callTool({
      name: 'zotero_delete_items',
      arguments: { keys: ['ITEM0003'], permanent: true, dryRun: false },
    });
    assert.equal(missingConfirm.isError, true);
    assert.match(String(missingConfirm.content[0]?.text ?? ''), /confirm="DELETE"/u);

    const purged = await client.callTool({
      name: 'zotero_delete_items',
      arguments: { keys: ['ITEM0003'], permanent: true, confirm: 'DELETE', dryRun: false },
    });
    assert.notEqual(purged.isError, true, String(purged.content[0]?.text ?? ''));
    const after = await fetch(`${fake.url}/api/users/0/items/ITEM0003`);
    assert.equal(after.status, 404, '永久删除后条目应不存在');
    assert.equal(parseResult(purged).result.operations.at(-1).status, 'applied');
    assert.ok(
      fake.requests.some((request) => request.method === 'DELETE' && request.path.endsWith('/ITEM0003')),
      '永久删除必须走 DELETE /items/<key>',
    );
    const trashAfterPurge = await fetch(`${fake.url}/api/users/0/items/trash?limit=100`, {
      headers: { accept: 'application/json' },
    }).then((response) => response.json());
    assert.ok(
      !trashAfterPurge.some((entry) => entry.key === 'ITEM0003'),
      '永久删除后不应再出现在垃圾箱',
    );
  });
});

test('A6/A15 集合与标签整理：返回受影响清单，且只作用于显式传入的对象', async () => {
  await withFake(async ({ fake, client }) => {
    process.env['ZOTERO_MCP_WRITE'] = 'on';

    const created = parseResult(
      await client.callTool({
        name: 'zotero_manage_collections',
        arguments: { action: 'create', name: 'Contract collection', dryRun: false },
      }),
    );
    const collectionKey = created.result.operations[0].key;
    assert.ok(typeof collectionKey === 'string' && collectionKey.length > 0);

    const added = parseResult(
      await client.callTool({
        name: 'zotero_manage_collections',
        arguments: { action: 'addItems', collectionKey, keys: ['ITEM0001'], dryRun: false },
      }),
    );
    assert.deepEqual(added.affected, ['ITEM0001']);
    assert.ok(existsSync(added.result.auditPath));
    const [inCollection] = await getItems({ baseUrl: fake.url, keys: ['ITEM0001'] });
    const [untouched] = await getItems({ baseUrl: fake.url, keys: ['ITEM0002'] });
    assert.ok(inCollection.collections.includes(collectionKey), 'ITEM0001 应已加入集合');
    assert.ok(!untouched.collections.includes(collectionKey), 'ITEM0002 不应被波及');

    const removed = parseResult(
      await client.callTool({
        name: 'zotero_manage_collections',
        arguments: { action: 'removeItems', collectionKey, keys: ['ITEM0001'], dryRun: false },
      }),
    );
    assert.deepEqual(removed.affected, ['ITEM0001']);
    const [afterRemove] = await getItems({ baseUrl: fake.url, keys: ['ITEM0001'] });
    assert.ok(!afterRemove.collections.includes(collectionKey));

    const renamed = parseResult(
      await client.callTool({
        name: 'zotero_manage_collections',
        arguments: { action: 'rename', collectionKey, name: 'Renamed collection', dryRun: false },
      }),
    );
    assert.deepEqual(renamed.operationKinds, ['collection-rename']);

    const tagged = parseResult(
      await client.callTool({
        name: 'zotero_manage_tags',
        arguments: { action: 'add', keys: ['ITEM0002'], tags: ['beta'], dryRun: false },
      }),
    );
    assert.deepEqual(tagged.affected, ['ITEM0002']);
    const [taggedItem] = await getItems({ baseUrl: fake.url, keys: ['ITEM0002'] });
    assert.deepEqual(taggedItem.tags, ['beta']);
    const [other] = await getItems({ baseUrl: fake.url, keys: ['ITEM0001'] });
    assert.deepEqual(other.tags, ['alpha'], '未传入的条目不应被改动');

    const tagRename = parseResult(
      await client.callTool({
        name: 'zotero_manage_tags',
        arguments: { action: 'rename', from: 'beta', to: 'gamma', dryRun: false, confirm: 'OVERWRITE' },
      }),
    );
    assert.deepEqual(tagRename.affected, ['ITEM0002']);
    const [renamedTagItem] = await getItems({ baseUrl: fake.url, keys: ['ITEM0002'] });
    assert.deepEqual(renamedTagItem.tags, ['gamma']);

    const noConfirm = await client.callTool({
      name: 'zotero_manage_tags',
      arguments: { action: 'rename', from: 'gamma', to: 'delta', dryRun: false },
    });
    assert.equal(noConfirm.isError, true);
    assert.match(String(noConfirm.content[0]?.text ?? ''), /OVERWRITE/u);
  });
});

test('A7 附件与笔记：linked 附件可复用，笔记可新建与更新', async () => {
  await withFake(async ({ fake, client, auditDir }) => {
    process.env['ZOTERO_MCP_WRITE'] = 'on';
    const linked = join(auditDir, 'linked-demo.pdf');
    writeFileSync(linked, '%PDF-1.4 linked', 'utf8');

    const attached = parseResult(
      await client.callTool({
        name: 'zotero_attach_file',
        arguments: { parentKey: 'ITEM0001', mode: 'linked', path: linked, title: 'Linked demo', dryRun: false },
      }),
    );
    const attachmentKey = attached.result.createdKeys[0];
    assert.ok(typeof attachmentKey === 'string');

    const postsBefore = fake.requests.filter(
      (request) => request.method === 'POST' && request.path === '/api/users/0/items',
    ).length;
    const reused = parseResult(
      await client.callTool({
        name: 'zotero_attach_file',
        arguments: { parentKey: 'ITEM0001', mode: 'linked', path: linked, dryRun: false },
      }),
    );
    assert.equal(reused.reused, true, '同路径应复用已有附件');
    assert.equal(reused.key, attachmentKey);
    assert.equal(
      fake.requests.filter((request) => request.method === 'POST' && request.path === '/api/users/0/items').length,
      postsBefore,
      '复用路径不应再发创建请求',
    );

    const note = parseResult(
      await client.callTool({
        name: 'zotero_add_note',
        arguments: { parentKey: 'ITEM0002', content: '契约测试笔记', dryRun: false },
      }),
    );
    const noteKey = note.result.createdKeys[0];
    assert.equal(note.noteMode, 'create');
    const [withNote] = await getItems({ baseUrl: fake.url, keys: ['ITEM0002'], include: ['notes'] });
    assert.equal(withNote.notes.length, 1);
    assert.match(String(withNote.notes[0].note), /契约测试笔记/u);

    const updated = parseResult(
      await client.callTool({
        name: 'zotero_add_note',
        arguments: { noteKey, content: '<p>更新后的笔记</p>', dryRun: false },
      }),
    );
    assert.equal(updated.noteMode, 'update');
    assert.deepEqual(updated.affected, [noteKey]);
    const [afterUpdate] = await getItems({ baseUrl: fake.url, keys: ['ITEM0002'], include: ['notes'] });
    assert.equal(afterUpdate.notes[0].note, '<p>更新后的笔记</p>');
  });
});

test('A8/A16 标识符导入：解析失败给出可读原因且不写库；成功时标注通道', async () => {
  await withFake(async ({ fake, client }) => {
    process.env['ZOTERO_MCP_WRITE'] = 'on';
    const before = await fetchAllTopItems({ baseUrl: fake.url });

    const failed = await client.callTool({
      name: 'zotero_add_items',
      arguments: { mode: 'identifier', identifier: 'not-an-identifier', dryRun: false },
    });
    assert.equal(failed.isError, true);
    assert.match(String(failed.content[0]?.text ?? ''), /无法识别的标识符/u);
    assert.deepEqual(nonGetRequests(fake), [], '解析失败不得产生任何写请求');
    const after = await fetchAllTopItems({ baseUrl: fake.url });
    assert.equal(after.length, before.length, '解析失败不得新增条目');
  });
});

test('A8 标识符解析：translation-server 优先，Crossref 回退，映射与失败原因可读', async () => {
  assert.equal(detectIdentifierKind('10.1000/alpha'), 'doi');
  assert.equal(detectIdentifierKind('https://doi.org/10.1000/alpha'), 'doi');
  assert.equal(detectIdentifierKind('978-0-306-40615-7'), 'isbn');
  assert.equal(detectIdentifierKind('pmid:12345678'), 'pmid');
  assert.throws(() => detectIdentifierKind('hello world'), /无法识别/u);

  const crossrefMessage = {
    title: ['Crossref paper'],
    DOI: '10.1000/crossref',
    'container-title': ['Journal of Tests'],
    volume: '12',
    issue: '3',
    page: '1-9',
    ISSN: ['1234-5678'],
    issued: { 'date-parts': [[2024, 5, 6]] },
    author: [{ given: 'Ada', family: 'Lovelace' }],
    abstract: '<jats:p>short abstract</jats:p>',
  };
  const mapped = mapCrossrefWork(crossrefMessage);
  assert.equal(mapped.itemType, 'journalArticle');
  assert.equal(mapped.fields['title'], 'Crossref paper');
  assert.equal(mapped.fields['date'], '2024-05-06');
  assert.equal(mapped.fields['publicationTitle'], 'Journal of Tests');
  assert.equal(mapped.fields['abstractNote'], 'short abstract');
  assert.deepEqual(mapped.fields['creators'], [{ creatorType: 'author', lastName: 'Lovelace', firstName: 'Ada' }]);

  const book = mapOpenLibraryBook({ title: 'Beta book', isbn_13: '9780306406157', publish_date: '1999', publishers: ['Test Press'] }, ['Edit Or']);
  assert.equal(book.itemType, 'book');
  assert.equal(book.fields['ISBN'], '9780306406157');
  assert.deepEqual(book.fields['creators'], [{ creatorType: 'author', lastName: 'Or', firstName: 'Edit' }]);

  const pubmed = mapPubmedSummary({
    title: 'Pubmed paper',
    source: 'J Test',
    pubdate: '2020 Jan',
    volume: '5',
    issue: '1',
    pages: '10-12',
    articleids: [{ idtype: 'doi', value: '10.1000/pubmed' }],
    authors: [{ name: 'Grace Hopper' }],
  });
  assert.equal(pubmed.fields['DOI'], '10.1000/pubmed');
  assert.equal(pubmed.fields['publicationTitle'], 'J Test');
  assert.deepEqual(pubmed.fields['creators'], [{ creatorType: 'author', lastName: 'Hopper', firstName: 'Grace' }]);

  // translation-server 不可用 → 回退 Crossref（注入 fetch，不触网）
  const calls = [];
  const fetchImpl = async (input) => {
    calls.push(String(input));
    const url = String(input);
    if (url.includes('1969')) throw new Error('connect ECONNREFUSED 127.0.0.1:1969');
    return new Response(JSON.stringify({ message: crossrefMessage }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const resolved = await resolveIdentifier({ identifier: '10.1000/crossref', fetchImpl });
  assert.equal(resolved.source, 'crossref');
  assert.equal(resolved.kind, 'doi');
  assert.ok(
    calls.some((url) => url.includes('api.crossref.org')) && calls.some((url) => url.includes('1969')),
    '应先试 translation-server 再回退 Crossref',
  );
  assert.equal(resolved.attempts[0].source, 'translation-server');
  assert.equal(resolved.attempts[0].ok, false);

  // 全部通道失败 → 可读原因，且不产生任何写入计划
  const failingFetch = async () => {
    throw new Error('offline');
  };
  await assert.rejects(
    () => resolveIdentifier({ identifier: '10.1000/none', fetchImpl: failingFetch }),
    /标识符解析失败[\s\S]*crossref/u,
  );
  await assert.rejects(
    () => buildAddItemsPlan({ mode: 'identifier', identifier: '10.1000/none', fetchImpl: failingFetch }),
    /标识符解析失败/u,
  );
});

test('A9/A17 演示脚本：默认只打印 dry-run 计划，退出码 0 且不写库', async () => {
  await withFake(async ({ fake, auditDir }) => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [DEMO_SCRIPT], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)),
      env: {
        ...process.env,
        ZOTERO_MCP_BASE_URL: fake.url,
        ZOTERO_MCP_AUDIT_DIR: auditDir,
        ZOTERO_MCP_WRITE: 'off',
      },
    });
    assert.match(stdout, /dry-run/u);
    assert.match(stdout, /闭环步骤/u);
    assert.match(stdout, /未写入任何数据/u);
    assert.equal(stderr.trim(), '');
    assert.deepEqual(nonGetRequests(fake), [], '演示 dry-run 不得发出任何写请求');
    assert.ok(!existsSync(join(auditDir, 'audit.jsonl')), 'dry-run 不应产生审计写入');
  });
});

test('写管线：新建条目可通过快照回滚（永久删除逆操作）', async () => {
  await withFake(async ({ fake, auditDir }) => {
    process.env['ZOTERO_MCP_WRITE'] = 'on';
    const plan = buildCreateItemPlan({ itemType: 'book', fields: { title: 'Rollback target' } });
    const result = await applyPlan(plan, {
      baseUrl: fake.url,
      auditDir,
      write: true,
      authorizeImpl: async () => FAKE_AUTHORIZE_KEY,
    });
    const key = result.createdKeys[0];
    assert.ok(typeof key === 'string');
    const rollback = await rollbackFromSnapshot(result.snapshotPath, {
      baseUrl: fake.url,
      auditDir,
      write: true,
      authorizeImpl: async () => FAKE_AUTHORIZE_KEY,
    });
    assert.deepEqual(rollback.removed, [key]);
    const response = await fetch(`${fake.url}/api/users/0/items/${key}`);
    assert.equal(response.status, 404);
  });
});

test('真机语义：POST /items 必须数组体，对象体被本地 API 拒绝', async () => {
  await withFake(async ({ fake, client }) => {
    process.env['ZOTERO_MCP_WRITE'] = 'on';
    // 假服务器保真：对象体必须得到 400 Uploaded data must be a JSON array
    const objectResponse = await fetch(`${fake.url}/api/users/0/items`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'zotero-api-version': '3',
        'zotero-server-id': fake.serverId,
        'zotero-api-key': FAKE_AUTHORIZE_KEY,
        'if-unmodified-since-version': '1',
      },
      body: JSON.stringify({ itemType: 'document', title: 'object-body' }),
    });
    assert.equal(objectResponse.status, 400);
    assert.match(await objectResponse.text(), /Uploaded data must be a JSON array/u);

    const result = await client.callTool({
      name: 'zotero_create_item',
      arguments: { itemType: 'journalArticle', fields: { title: 'Array body' }, dryRun: false },
    });
    assert.notEqual(result.isError, true, String(result.content[0]?.text ?? ''));
    const key = parseResult(result).result.createdKeys[0];
    assert.ok(typeof key === 'string' && key.length > 0);
    const createRequests = fake.requests.filter(
      (request) => request.method === 'POST' && request.path === '/api/users/0/items',
    );
    // 第一条是上面手工发的对象体（被拒），真正的创建请求是最后一条
    const createRequest = createRequests.at(-1);
    assert.ok(createRequest, '应发出创建请求');
    const payload = JSON.parse(String(createRequest.body));
    assert.ok(Array.isArray(payload), '创建载荷必须是 JSON 数组');
    assert.equal(payload[0].itemType, 'journalArticle');
    const [created] = await getItems({ baseUrl: fake.url, keys: [key] });
    assert.equal(created.data['title'], 'Array body');
  });
});

test('真机语义：库级版本每个写请求前重读，同一计划两次写入都成功', async () => {
  await withFake(async ({ fake, auditDir }) => {
    process.env['ZOTERO_MCP_WRITE'] = 'on';
    const plan = makeChangePlan({
      targetKeys: [],
      changes: [],
      operations: [
        { kind: 'create', itemType: 'document', fields: { title: 'fresh-version-item' } },
        { kind: 'collection-create', name: 'fresh-version-collection' },
      ],
      summary: '两次写入（条目 + 集合）',
    });
    const result = await applyPlan(plan, {
      baseUrl: fake.url,
      auditDir,
      write: true,
      authorizeImpl: async () => FAKE_AUTHORIZE_KEY,
    });
    assert.deepEqual(
      result.operations.map((operation) => operation.status),
      ['applied', 'applied'],
    );
    const writes = fake.requests.filter((request) => request.method === 'POST');
    assert.equal(writes.length, 2);
    assert.ok(writes[0].version !== null && writes[1].version !== null);
    assert.notEqual(
      writes[1].version,
      writes[0].version,
      '第二次写入必须使用递增后的库版本（每次写前重读）',
    );
    assert.equal(result.createdKeys.length, 1);
  });
});

test('真机语义：创建遇到 412 时用 found 版本重试一次', async () => {
  await withFake(
    async ({ fake, auditDir }) => {
      process.env['ZOTERO_MCP_WRITE'] = 'on';
      const plan = makeChangePlan({
        targetKeys: [],
        changes: [],
        operations: [{ kind: 'create', itemType: 'document', fields: { title: 'retry-after-412' } }],
        summary: '412 重试',
      });
      const result = await applyPlan(plan, {
        baseUrl: fake.url,
        auditDir,
        write: true,
        authorizeImpl: async () => FAKE_AUTHORIZE_KEY,
      });
      assert.equal(result.operations[0].status, 'applied');
      assert.equal(
        fake.requests.filter((request) => request.method === 'POST' && request.path === '/api/users/0/items').length,
        2,
        '第一次 412、第二次用 found 版本成功',
      );
    },
    { staleVersionOnce: true },
  );
});

test('写安全：含 delete 操作的计划即使伪造 destructive=false 也必须携带 confirm="DELETE"', async () => {
  await withFake(async ({ fake, auditDir }) => {
    process.env['ZOTERO_MCP_WRITE'] = 'on';
    // 手工构造「非破坏性」计划：调用方谎报 destructive/confirmKeyword，管线必须自己兜底
    const plan = makeChangePlan({
      targetKeys: ['ITEM0003'],
      changes: [],
      operations: [{ kind: 'delete', key: 'ITEM0003' }],
      summary: '伪造的非破坏性永久删除',
      destructive: false,
      confirmKeyword: null,
    });
    assert.equal(plan.destructive, false);
    await assert.rejects(
      () =>
        applyPlan(plan, {
          baseUrl: fake.url,
          auditDir,
          write: true,
          authorizeImpl: async () => FAKE_AUTHORIZE_KEY,
        }),
      /confirm="DELETE"/u,
    );
    assert.ok(
      !fake.requests.some((request) => request.method === 'DELETE'),
      '未确认时不得发出任何 DELETE',
    );
    assert.equal(fake.requests.length, 0, '门禁在任何请求之前生效');
    const stillThere = await fetch(`${fake.url}/api/users/0/items/ITEM0003`);
    assert.equal(stillThere.status, 200, '条目必须仍然存在');

    const applied = await applyPlan(plan, {
      baseUrl: fake.url,
      auditDir,
      write: true,
      confirm: 'DELETE',
      authorizeImpl: async () => FAKE_AUTHORIZE_KEY,
    });
    assert.equal(applied.operations[0].status, 'applied');
    assert.equal((await fetch(`${fake.url}/api/users/0/items/ITEM0003`)).status, 404);
  });
});

// ── zotero_add_note(fromAnnotations)：由注释生成结构化 note ────────────────

/** 三个注释（页码乱序、其中一个没有页码），挂在 ITEM0001 的 PDF 附件下。 */
const ANNOTATION_LIBRARY = {
  children: {
    ITEM0001: [
      {
        key: 'ATT00001',
        version: 1,
        data: {
          itemType: 'attachment',
          contentType: 'application/pdf',
          title: 'Full Text PDF',
          linkMode: 'imported_url',
          parentItem: 'ITEM0001',
        },
      },
    ],
    ITEM0002: [],
    ITEM0003: [],
    ATT00001: [
      {
        key: 'ANNO0003',
        version: 1,
        data: {
          itemType: 'annotation',
          annotationType: 'highlight',
          annotationText: '第五页的高亮',
          annotationComment: '待复核',
          annotationColor: '#ff6666',
          annotationPageLabel: '5',
          annotationPosition: '{"pageIndex":4}',
          parentItem: 'ATT00001',
        },
      },
      {
        key: 'ANNO0001',
        version: 1,
        data: {
          itemType: 'annotation',
          annotationType: 'underline',
          annotationText: '第二页的下划线',
          annotationPageLabel: '2',
          annotationPosition: '{"pageIndex":1}',
          parentItem: 'ATT00001',
        },
      },
      {
        key: 'ANNO0002',
        version: 1,
        data: {
          itemType: 'annotation',
          annotationType: 'note',
          annotationComment: '没有页码信息的批注',
          annotationPosition: '{}',
          parentItem: 'ATT00001',
        },
      },
    ],
  },
};

/** 从 note HTML 里取出全部 `<a href>` 深链接（顺序即写入顺序）。 */
function deepLinksIn(noteHtml) {
  return [...String(noteHtml).matchAll(/<a href="([^"]+)">/gu)].map((match) => match[1]);
}

test('A3/A5 fromAnnotations：N 个注释生成 N 个深链接，按页码排序且与读层 deepLink 逐字一致', async () => {
  await withFake(
    async ({ fake, client, auditDir }) => {
      process.env['ZOTERO_MCP_WRITE'] = 'on';

      // 读层给出的 deepLink 是本次实现的对照口径（必须逐字一致）
      const [detail] = await getItems({ baseUrl: fake.url, keys: ['ITEM0001'], include: ['annotations'] });
      const readLayer = new Map(detail.annotations.map((annotation) => [annotation.key, annotation.deepLink]));
      assert.equal(readLayer.size, 3, '读层应能看到附件下的 3 条注释');

      // dry-run：只出计划，零写请求
      const requestsBefore = fake.requests.length;
      const planned = parseResult(
        await client.callTool({
          name: 'zotero_add_note',
          arguments: { parentKey: 'ITEM0001', fromAnnotations: true },
        }),
      );
      assert.equal(planned.dryRun, true);
      assert.equal(planned.noteMode, 'from-annotations');
      assert.equal(planned.annotationCount, 3);
      assert.deepEqual(nonGetRequests(fake), []);
      assert.equal(fake.requests.length - requestsBefore > 0, true, '计划阶段应读注释（GET）');

      // 提交：note 内容里恰好 3 个深链接，顺序按页码（2 → 5 → 无页码）
      const submitted = parseResult(
        await client.callTool({
          name: 'zotero_add_note',
          arguments: { parentKey: 'ITEM0001', fromAnnotations: true, dryRun: false },
        }),
      );
      assert.equal(submitted.noteMode, 'from-annotations');
      const noteKey = submitted.result.createdKeys[0];
      const [withNote] = await getItems({ baseUrl: fake.url, keys: ['ITEM0001'], include: ['notes'] });
      assert.equal(withNote.notes.length, 1);
      const noteHtml = String(withNote.notes[0].note);

      const links = deepLinksIn(noteHtml);
      assert.equal(links.length, 3, '恰好 3 个深链接');
      assert.deepEqual(links, [
        'zotero://open-pdf/library/items/ATT00001?page=2&annotation=ANNO0001',
        'zotero://open-pdf/library/items/ATT00001?page=5&annotation=ANNO0003',
        'zotero://open-pdf/library/items/ATT00001?annotation=ANNO0002',
      ]);
      // 与读层 deepLink 逐字一致
      assert.equal(links[0], readLayer.get('ANNO0001'));
      assert.equal(links[1], readLayer.get('ANNO0003'));
      assert.equal(links[2], readLayer.get('ANNO0002'));
      // 工具返回的 deepLinks 与写进 note 的一致
      assert.deepEqual(submitted.deepLinks, links);
      // 正文含注释文本、批注文本与条数标题；无页码者如实写「无页码」
      assert.match(noteHtml, /注释清单（3 条）/u);
      assert.match(noteHtml, /第二页的下划线/u);
      assert.match(noteHtml, /第五页的高亮/u);
      assert.match(noteHtml, /批注：待复核/u);
      assert.match(noteHtml, /无页码/u);
      // 落进审计与快照
      assert.equal(existsSync(join(auditDir, 'audit.jsonl')), true);
      assert.ok(submitted.result.snapshotPath.length > 0);
      assert.ok(noteKey.length > 0);
    },
    { library: ANNOTATION_LIBRARY },
  );
});

test('A4 fromAnnotations：目标自身就是附件时取它的注释子项，且不重复', async () => {
  await withFake(
    async ({ client }) => {
      process.env['ZOTERO_MCP_WRITE'] = 'on';
      const planned = parseResult(
        await client.callTool({
          name: 'zotero_add_note',
          arguments: { parentKey: 'ATT00001', fromAnnotations: true },
        }),
      );
      assert.equal(planned.annotationCount, 3);
      assert.deepEqual(planned.deepLinks, [
        'zotero://open-pdf/library/items/ATT00001?page=2&annotation=ANNO0001',
        'zotero://open-pdf/library/items/ATT00001?page=5&annotation=ANNO0003',
        'zotero://open-pdf/library/items/ATT00001?annotation=ANNO0002',
      ]);
    },
    { library: ANNOTATION_LIBRARY },
  );
});

test('fromAnnotations：取注释走带 itemType=annotation 过滤的子项查询（真机语义）', async () => {
  await withFake(
    async ({ fake, client }) => {
      process.env['ZOTERO_MCP_WRITE'] = 'on';
      // 附件自身形态：必须用带过滤的查询才拿得到注释（真机不带过滤返回 0 条）
      const planned = parseResult(
        await client.callTool({ name: 'zotero_add_note', arguments: { parentKey: 'ATT00001', fromAnnotations: true } }),
      );
      assert.equal(planned.annotationCount, 3);
      assert.ok(
        fake.requests.some(
          (request) => request.url.includes('/items/ATT00001/children') && request.url.includes('itemType=annotation'),
        ),
        '附件自身形态必须使用带过滤的子项查询',
      );
      // 父条目形态：附件下的注释同样要经过滤查询拿到
      const viaParent = parseResult(
        await client.callTool({ name: 'zotero_add_note', arguments: { parentKey: 'ITEM0001', fromAnnotations: true } }),
      );
      assert.equal(viaParent.annotationCount, 3);
    },
    { library: ANNOTATION_LIBRARY },
  );
});

test('A6/A8 fromAnnotations：零注释与参数冲突都在写库之前拒绝', async () => {
  await withFake(async ({ fake, client, auditDir }) => {
    process.env['ZOTERO_MCP_WRITE'] = 'on';
    const snapshotsDir = join(auditDir, 'snapshots');
    const cases = [
      ['零注释（条目存在但没有注释）', { parentKey: 'ITEM0003', fromAnnotations: true }],
      ['零注释 + 提交', { parentKey: 'ITEM0003', fromAnnotations: true, dryRun: false }],
      ['条目不存在', { parentKey: 'NOPE0000', fromAnnotations: true }],
      ['同时给 content', { parentKey: 'ITEM0001', fromAnnotations: true, content: '不该生效' }],
      ['同时给 noteKey', { parentKey: 'ITEM0001', noteKey: 'NOTE0001', fromAnnotations: true }],
      ['缺 parentKey', { fromAnnotations: true }],
    ];
    const reasonsByLabel = new Map();
    // 默认库里 ITEM0001 已有一条既有笔记（NOTE0001）：被拒绝时它的条数必须不变
    const [before] = await getItems({ baseUrl: fake.url, keys: ['ITEM0001'], include: ['notes'] });
    const notesBefore = before.notes.map((note) => note.key);
    for (const [label, args] of cases) {
      const result = await client.callTool({ name: 'zotero_add_note', arguments: args });
      assert.equal(result.isError, true, `${label} 应被拒绝`);
      const text = String(result.content[0]?.text ?? '');
      assert.ok(text.length > 0, `${label} 的原因必须可读`);
      reasonsByLabel.set(label, text);
    }
    // 零注释的 dry-run 与提交必须给出同一条原因（表现一致）
    assert.equal(reasonsByLabel.get('零注释（条目存在但没有注释）'), reasonsByLabel.get('零注释 + 提交'));
    // 其余四种拒绝原因互不相同
    const others = [...reasonsByLabel.entries()]
      .filter(([label]) => label !== '零注释 + 提交')
      .map(([, text]) => text);
    assert.equal(new Set(others).size, others.length, '各拒绝原因必须互不相同');

    // 一次写请求都没有：文库、快照、审计都不新增
    assert.deepEqual(nonGetRequests(fake), []);
    assert.equal(existsSync(snapshotsDir), false, '被拒绝时不许落快照');
    assert.equal(existsSync(join(auditDir, 'audit.jsonl')), false, '被拒绝时不许写审计');
    const [parent] = await getItems({ baseUrl: fake.url, keys: ['ITEM0001'], include: ['notes'] });
    assert.deepEqual(
      parent.notes.map((note) => note.key),
      notesBefore,
      '不得凭空写出笔记（既有 NOTE0001 之外的条数必须为 0）',
    );
  });
});

test('A2/A7 fromAnnotations：默认只读仍拦得住，且不带 fromAnnotations 时行为不变', async () => {
  await withFake(
    async ({ fake, client }) => {
      // 默认只读：fromAnnotations 同样在计划之前被拒，且零请求
      delete process.env['ZOTERO_MCP_WRITE'];
      const gated = await client.callTool({
        name: 'zotero_add_note',
        arguments: { parentKey: 'ITEM0001', fromAnnotations: true, dryRun: false },
      });
      assert.equal(gated.isError, true);
      assert.match(String(gated.content[0]?.text ?? ''), /ZOTERO_MCP_WRITE|默认只读/u);
      assert.equal(fake.requests.length, 0, '默认只读时连计划都不生成');

      // 不带 fromAnnotations 的既有语义不变：content 缺失被拒、给了 content 正常出计划
      process.env['ZOTERO_MCP_WRITE'] = 'on';
      const missing = await client.callTool({ name: 'zotero_add_note', arguments: { parentKey: 'ITEM0001' } });
      assert.equal(missing.isError, true);
      assert.match(String(missing.content[0]?.text ?? ''), /content/u);
      const legacy = parseResult(
        await client.callTool({ name: 'zotero_add_note', arguments: { parentKey: 'ITEM0001', content: '纯文本笔记' } }),
      );
      assert.equal(legacy.noteMode, 'create');
      assert.equal(legacy.annotationCount, undefined);
      assert.match(legacy.preview, /新建 note/u);
      // 既有语义：纯文本仍被包成 HTML 段落（直接核对计划里的 note 字段）
      const outcome = await buildAddNotePlan({ baseUrl: fake.url, parentKey: 'ITEM0001', content: '纯文本笔记' });
      assert.equal(outcome.mode, 'create');
      assert.match(JSON.stringify(outcome.plan.operations), /<p>纯文本笔记<\/p>/u);
    },
    { library: ANNOTATION_LIBRARY },
  );
});
