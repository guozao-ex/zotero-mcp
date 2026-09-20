/**
 * 注释页标签回填（写路径）契约测试。
 *
 * 覆盖规格 `specs/write-tools/spec.md`「注释页标签回填（写路径）」的那条场景：
 *   dry-run 零写请求 → 真写走写管线（版本头 + 审计）→ 无法匹配的注释不写入 → 其它字段逐值不变。
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  LABEL_BACKFILL_CONFIRM,
  applyAnnotationLabelBackfill,
  planAnnotationLabelBackfill,
} from '../../packages/core/src/index.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

/** 源附件（1 条带页标签 + 1 条无页标签）与目标附件（页标签为空 + 1 条无法匹配） */
const LIBRARY = {
  items: [
    { key: 'ITEM0001', version: 1, data: { itemType: 'journalArticle', title: 'Source', date: '2020', collections: [], tags: [] } },
    { key: 'ITEM0002', version: 1, data: { itemType: 'journalArticle', title: 'Imported', date: '2020', collections: [], tags: [] } },
  ],
  children: {
    ITEM0001: [{ key: 'ATT00001', version: 1, data: { itemType: 'attachment', contentType: 'application/pdf', title: 'PDF', linkMode: 'imported_url', parentItem: 'ITEM0001' } }],
    ITEM0002: [{ key: 'ATT00002', version: 1, data: { itemType: 'attachment', contentType: 'application/pdf', title: 'PDF', linkMode: 'imported_file', parentItem: 'ITEM0002' } }],
    ATT00001: [
      {
        key: 'ANNO0001',
        version: 1,
        data: {
          itemType: 'annotation',
          annotationType: 'highlight',
          annotationText: 'quoted text',
          annotationComment: 'my comment',
          annotationColor: '#ffd400',
          annotationPageLabel: '1',
          annotationPosition: '{"pageIndex":0,"rects":[[10,20,110,40]]}',
          parentItem: 'ATT00001',
        },
      },
      {
        key: 'ANNO0002',
        version: 1,
        data: {
          itemType: 'annotation',
          annotationType: 'highlight',
          annotationText: 'second quote',
          annotationPageLabel: '',
          annotationPosition: '{"pageIndex":3,"rects":[[10,20,110,40]]}',
          parentItem: 'ATT00001',
        },
      },
    ],
    ATT00002: [
      {
        key: 'ANNO0003',
        version: 1,
        data: {
          itemType: 'annotation',
          annotationType: 'highlight',
          annotationText: 'quoted text',
          annotationComment: 'my comment',
          annotationColor: '#ff6666',
          annotationPageLabel: '',
          annotationPosition: '{"pageIndex":0,"rects":[[10,20,110,40]]}',
          parentItem: 'ATT00002',
        },
      },
      {
        key: 'ANNO0004',
        version: 1,
        data: {
          itemType: 'annotation',
          annotationType: 'highlight',
          annotationText: 'never seen in source',
          annotationPageLabel: '',
          annotationPosition: '{"pageIndex":9,"rects":[[1,2,3,4]]}',
          parentItem: 'ATT00002',
        },
      },
    ],
  },
};

test('回填：dry-run 出计划且零写请求', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: LIBRARY });
  try {
    const backfill = await planAnnotationLabelBackfill({ baseUrl: fake.url, from: 'ATT00001', to: 'ATT00002' });
    assert.equal(backfill.pairs.length, 1, '只有一条能匹配上');
    assert.equal(backfill.pairs[0].targetKey, 'ANNO0003');
    assert.ok(backfill.pairs[0].before === '' || backfill.pairs[0].before === null, '目标页标签为空（空串或 null 都算）');
    assert.equal(backfill.pairs[0].after, '1');
    // 源第二条没有页标签 → 如实说明
    assert.equal(backfill.unmatched.length, 1);
    assert.match(backfill.unmatched[0].reason, /没有页标签/u);
    // 空 → 有值属于「填空」，不在既有写管线的破坏性口径内（不需要确认关键词）
    assert.equal(backfill.plan.destructive, false);
    assert.equal(backfill.plan.confirmKeyword, null);

    // dry-run：零写请求
    assert.deepEqual(fake.requests.filter((request) => request.method !== 'GET'), [], '计划阶段必须是纯只读');
  } finally {
    await fake.close();
  }
});

test('回填：目标已有不同非空标签时，计划是破坏性的并带确认关键词', async () => {
  const library = JSON.parse(JSON.stringify(LIBRARY));
  const target = library.children['ATT00002'].find((entry) => entry.key === 'ANNO0003');
  target.data.annotationPageLabel = '7';
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library });
  try {
    const backfill = await planAnnotationLabelBackfill({ baseUrl: fake.url, from: 'ATT00001', to: 'ATT00002' });
    assert.equal(backfill.pairs.length, 1);
    assert.equal(backfill.pairs[0].before, '7');
    assert.equal(backfill.pairs[0].after, '1');
    assert.equal(backfill.plan.destructive, true, '覆盖已有非空值必须是破坏性计划');
    assert.equal(backfill.plan.confirmKeyword, LABEL_BACKFILL_CONFIRM);
    assert.deepEqual(fake.requests.filter((request) => request.method !== 'GET'), []);
  } finally {
    await fake.close();
  }
});

test('回填：真写走写管线（版本头 + 审计），未匹配的注释不被写入，其它字段不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-backfill-'));
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: LIBRARY });
  const previous = process.env['ZOTERO_MCP_WRITE'];
  process.env['ZOTERO_MCP_WRITE'] = 'on';
  try {
    const raw = async (key) => (await fetch(`${fake.url}/api/users/0/items/${key}`, { headers: { accept: 'application/json' } })).json();
    const targetBefore = (await raw('ANNO0003')).data;
    const untouchedBefore = (await raw('ANNO0004')).data;
    const backfill = await planAnnotationLabelBackfill({ baseUrl: fake.url, from: 'ATT00001', to: 'ATT00002' });
    const result = await applyAnnotationLabelBackfill(backfill, {
      baseUrl: fake.url,
      write: true,
      auditDir: join(dir, 'audit'),
    });

    assert.deepEqual(result.submittedKeys, ['ANNO0003']);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].status, 'updated');
    assert.equal(existsSync(result.auditPath), true, '审计必须落盘');
    assert.equal(existsSync(result.snapshotPath), true, '快照必须落盘');
    assert.ok(readFileSync(result.auditPath, 'utf8').includes('annotationPageLabel'));

    // 写请求带齐版本前提
    const patches = fake.requests.filter((request) => request.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.ok(patches[0].version !== null && patches[0].version !== undefined, 'PATCH 必须带版本前提头');

    // 回填生效，且其它字段逐值不变（直接读原始条目，避免依赖 hydrate 的附件语义）
    const targetAfter = (await raw('ANNO0003')).data;
    assert.equal(targetAfter.annotationPageLabel, '1');
    assert.equal(targetAfter.annotationText, targetBefore.annotationText);
    assert.equal(targetAfter.annotationComment, targetBefore.annotationComment);
    assert.equal(targetAfter.annotationColor, targetBefore.annotationColor);
    assert.equal(targetAfter.annotationPosition, targetBefore.annotationPosition);
    // 未能匹配的注释保持原样（未被写入）
    const untouchedAfter = (await raw('ANNO0004')).data;
    assert.equal(untouchedAfter.annotationPageLabel, untouchedBefore.annotationPageLabel);
  } finally {
    if (previous === undefined) delete process.env['ZOTERO_MCP_WRITE'];
    else process.env['ZOTERO_MCP_WRITE'] = previous;
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('回填：总闸未开启 / 无变化 / 目标已同值时的拒绝与跳过', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: LIBRARY });
  const previous = process.env['ZOTERO_MCP_WRITE'];
  try {
    const backfill = await planAnnotationLabelBackfill({ baseUrl: fake.url, from: 'ATT00001', to: 'ATT00002' });

    // 总闸未开启：即使 write=true 也必须拒绝
    delete process.env['ZOTERO_MCP_WRITE'];
    await assert.rejects(
      () => applyAnnotationLabelBackfill(backfill, { baseUrl: fake.url, write: true, auditDir: join(tmpdir(), 'zotero-mcp-backfill-unused') }),
      /ZOTERO_MCP_WRITE/u,
    );

    // 已回填过（目标与源同值）：不再产生待回填项
    process.env['ZOTERO_MCP_WRITE'] = 'on';
    await applyAnnotationLabelBackfill(backfill, { baseUrl: fake.url, write: true, auditDir: mkdtempSync(join(tmpdir(), 'zotero-mcp-backfill-2-')) });
    const again = await planAnnotationLabelBackfill({ baseUrl: fake.url, from: 'ATT00001', to: 'ATT00002' });
    assert.equal(again.pairs.length, 0);
    assert.equal(again.unchanged.length, 1);
    assert.match(again.unchanged[0].reason, /已是/u);
    await assert.rejects(() => applyAnnotationLabelBackfill(again, { baseUrl: fake.url, write: true }), /没有需要回填/u);
  } finally {
    if (previous === undefined) delete process.env['ZOTERO_MCP_WRITE'];
    else process.env['ZOTERO_MCP_WRITE'] = previous;
    await fake.close();
  }
});
