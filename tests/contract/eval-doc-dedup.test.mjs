import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dedupeHitsByItem } from '../../scripts/lib/semantic-eval-hits.mjs';

test('评测去重：同一条目的多个分块只占一个名次，且保留最高分块', () => {
  const hits = [
    { itemKey: 'AAAA1111', score: 0.5, text: '低分块' },
    { itemKey: 'BBBB2222', score: 0.9, text: 'B 的块' },
    { itemKey: 'AAAA1111', score: 0.8, text: '高分块' },
  ];
  const deduped = dedupeHitsByItem(hits);
  assert.deepEqual(deduped.map((hit) => hit.itemKey), ['AAAA1111', 'BBBB2222'], '每篇只占一个名次');
  const a = deduped.find((hit) => hit.itemKey === 'AAAA1111');
  assert.equal(a.score, 0.8, '必须保留该篇的最高分块，而不是首个命中');
  assert.equal(a.text, '高分块');
});

test('评测去重：乱序输入同样取最高分；空输入与缺 itemKey 的命中被安全忽略', () => {
  const deduped = dedupeHitsByItem([
    { itemKey: 'CCCC3333', score: 0.2 },
    { itemKey: 'CCCC3333', score: 0.95 },
    { itemKey: 'CCCC3333', score: 0.6 },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].score, 0.95);
  assert.deepEqual(dedupeHitsByItem([]), []);
  assert.deepEqual(dedupeHitsByItem(undefined), []);
  assert.deepEqual(dedupeHitsByItem([{ score: 1 }, null]), [], '缺 itemKey 的命中不进入结果');
});
