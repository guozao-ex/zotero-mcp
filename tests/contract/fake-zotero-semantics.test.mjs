/**
 * 假服务器的真机语义契约测试（api-contract 规格）。
 *
 * 重点是 `/items/<KEY>/children` 的注释过滤语义：Zotero 10.0.3 实测（2026-09-19）不带 `itemType`
 * 过滤时**不返回注释子项**，只有 `?itemType=annotation` 才返回。假服务器此前无脑返回全部子项，
 * 让读层「用无过滤查询取注释」的缺陷在离线测试里不可见——这里把它钉死。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

const get = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  assert.equal(response.status, 200, `${url} 应返回 200`);
  return await response.json();
};

test('假服务器 /children 复现真机的注释过滤语义', async () => {
  // 默认固件：ITEM0001 → [ATT00001（PDF）, NOTE0001（笔记）]；ATT00001 → [ANNO0001（注释）]
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  try {
    const base = `${fake.url}/api/users/0/items`;

    // ① 不带过滤：注释被排除，但附件与笔记照旧
    const bareAttachment = await get(`${base}/ATT00001/children`);
    assert.deepEqual(bareAttachment, [], '不带 itemType 过滤时不得返回注释子项');

    const bareParent = await get(`${base}/ITEM0001/children`);
    assert.deepEqual(
      bareParent.map((entry) => entry.data.itemType).sort(),
      ['attachment', 'note'],
      '不带过滤时父条目的附件与笔记必须照常返回（只有注释被排除）',
    );

    // ② 带 itemType=annotation：只返回注释
    const filtered = await get(`${base}/ATT00001/children?itemType=annotation`);
    assert.deepEqual(filtered.map((entry) => entry.key), ['ANNO0001']);
    assert.equal(filtered[0].data.annotationType, 'highlight');

    // ③ 其它 itemType 过滤保持可用
    const notes = await get(`${base}/ITEM0001/children?itemType=note`);
    assert.deepEqual(notes.map((entry) => entry.key), ['NOTE0001']);

    // ④ 该语义让「用无过滤查询取注释」的实现必然拿不到数据（即离线可复现真机缺陷）
    assert.equal(
      bareAttachment.filter((entry) => entry.data.itemType === 'annotation').length,
      0,
      '依赖无过滤查询的实现在此必然拿不到注释',
    );
  } finally {
    await fake.close();
  }
});
