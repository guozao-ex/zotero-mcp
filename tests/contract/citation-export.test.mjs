/** 引用与导出契约测试：路径参数、Citation Key 提取、.bib 结构校验与落盘约定。 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  buildExportPath,
  exportItems,
  extractCitationKey,
  validateBib,
} from '../../packages/core/src/index.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';
import { auditBibYears, describeBibYears } from '../../scripts/live-bib-check.mjs';

test('导出路径透传 format/style/locale', () => {
  // 真机：/items?itemKey= 不做过滤，导出改为逐条请求；citation 映射到受支持的 bib
  const path = buildExportPath({ keys: ['A', 'B'], format: 'citation', style: 'apa', locale: 'zh-CN' });
  assert.match(path, /items\/A\?/u);
  assert.match(path, /format=bib/u);
  assert.match(path, /style=apa/u);
  assert.match(path, /locale=zh-CN/u);
  assert.match(buildExportPath({ keys: ['A'], format: 'bib' }), /format=bibtex/u);
  assert.throws(() => buildExportPath({ keys: [], format: 'bib' }), /keys 不能为空/u);
});

test('提取 Better BibTeX 的 Citation Key', () => {
  assert.equal(extractCitationKey('Citation Key: alphaPaper2021'), 'alphaPaper2021');
  assert.equal(extractCitationKey('foo\nCitation Key: bbtKey99\nbar'), 'bbtKey99');
  assert.equal(extractCitationKey('nothing here'), null);
  assert.equal(extractCitationKey(null), null);
});

test('validateBib 校验条目头、括号配平与必需字段', () => {
  const good = '@article{k1,\n  title = {T},\n  author = {A, B},\n  year = {2021}\n}\n';
  assert.equal(validateBib(good).ok, true);
  const missing = validateBib('@article{k1,\n  title = {T}\n}\n');
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.some((issue) => issue.problem.includes('author')));
  const unbalanced = validateBib('@article{k1,\n  title = {T},\n  author = {A},\n  year = {2021}\n');
  assert.equal(unbalanced.ok, false);
});

test('validateBib 的 year 口径：默认必须，显式放宽时只免除 year 并如实报出', () => {
  const dated = '@article{k1,\n  title = {T},\n  author = {A, B},\n  year = {2021}\n}\n';
  const undated = '@article{k2,\n  title = {T2},\n  author = {C, D}\n}\n';
  const mixed = `${dated}${undated}`;

  // 默认行为逐字不变：缺 year 仍然判失败
  const strict = validateBib(mixed);
  assert.equal(strict.ok, false);
  assert.ok(strict.issues.some((issue) => issue.problem.includes('year')));
  assert.deepEqual(strict.missingYear, ['k2']);

  // 显式放宽：只免除 year，其它结构性规则仍然强制
  const relaxed = validateBib(mixed, { requireYear: false });
  assert.equal(relaxed.ok, true);
  assert.deepEqual(relaxed.keys, ['k1', 'k2']);
  assert.deepEqual(relaxed.missingYear, ['k2'], '放宽时仍要如实报出缺 year 的条目');
  assert.deepEqual(validateBib(dated, { requireYear: false }).missingYear, []);

  assert.equal(validateBib('@article k2,\n  title = {T2},\n  author = {C}\n}\n', { requireYear: false }).ok, false, '放宽 year 不得放过非法条目头');
  assert.equal(validateBib('@article{k3,\n  title = {T3}\n}\n', { requireYear: false }).ok, false, '放宽 year 不得放过缺 author');
  assert.equal(validateBib('@article{k4,\n  author = {E}\n}\n', { requireYear: false }).ok, false, '放宽 year 不得放过缺 title');
  assert.equal(validateBib('@article{k5,\n  title = {T5},\n  author = {F}\n', { requireYear: false }).ok, false, '放宽 year 不得放过花括号不配平');
});

test('auditBibYears 守卫本身可以失败：有 date 缺 year 必判失败，无 date 只计入说明', () => {
  const withYear = { ok: true, keys: ['k1'], issues: [], missingYear: [] };
  const withoutYear = { ok: true, keys: ['k2'], issues: [], missingYear: ['k2'] };
  const broken = { ok: false, keys: ['k3'], issues: [{ problem: '缺少必需字段 title' }], missingYear: [] };

  assert.deepEqual(auditBibYears([{ key: 'ITEM1', hasDate: true, validation: withYear }]).failures, []);

  // 这条是本轮修复的核心：守卫必须真的能失败，否则就是死代码
  const datedWithoutYear = auditBibYears([{ key: 'ITEM1', hasDate: true, validation: withoutYear }]);
  assert.equal(datedWithoutYear.failures.length, 1, '有 date 却缺 year 必须判失败');
  assert.match(datedWithoutYear.failures[0], /有 date 却缺少 year/u);

  const undatedWithoutYear = auditBibYears([{ key: 'ITEM2', hasDate: false, validation: withoutYear }]);
  assert.deepEqual(undatedWithoutYear.failures, []);
  assert.deepEqual(undatedWithoutYear.undated, ['ITEM2']);
  assert.match(describeBibYears(undatedWithoutYear), /没有日期因而没有 year/u);

  // 放宽 year 不得放过结构性错误
  assert.equal(auditBibYears([{ key: 'ITEM3', hasDate: false, validation: broken }]).failures.length, 1);

  // 空输入与缺校验结果都不能静默通过
  assert.equal(auditBibYears([]).failures.length, 1);
  assert.equal(auditBibYears([{ key: 'ITEM4', hasDate: true, validation: null }]).failures.length, 1);

  // 混合：一条有日期且合规、一条无日期缺 year —— 整体通过并把后者计入说明
  const mixed = auditBibYears([
    { key: 'ITEM1', hasDate: true, validation: withYear },
    { key: 'ITEM2', hasDate: false, validation: withoutYear },
  ]);
  assert.deepEqual(mixed.failures, []);
  assert.deepEqual(mixed.undated, ['ITEM2']);
  assert.deepEqual(mixed.bibKeys, ['k1', 'k2']);
});

test('导出 .bib：引用键优先用 Citation Key，落盘遵守不覆盖约定', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-export-'));
  try {
    const result = await exportItems({ baseUrl: fake.url, keys: ['ITEM0001', 'ITEM0003'], format: 'bib' });
    const validation = validateBib(result.content);
    assert.equal(validation.ok, true);
    assert.deepEqual(validation.keys, ['alphaPaper2021', 'ITEM0003']);
    assert.equal(result.count, 2);

    const target = join(dir, 'refs.bib');
    const written = await exportItems({ baseUrl: fake.url, keys: ['ITEM0001'], format: 'bib', outPath: target });
    assert.equal(written.path_written, target);
    assert.match(readFileSync(target, 'utf8'), /@article\{alphaPaper2021,/u);

    await assert.rejects(
      () => exportItems({ baseUrl: fake.url, keys: ['ITEM0001'], format: 'bib', outPath: target }),
      /已存在/u,
    );
    writeFileSync(target, 'sentinel', 'utf8');
    await assert.rejects(
      () => exportItems({ baseUrl: fake.url, keys: ['ITEM0001'], format: 'bib', outPath: target }),
      /已存在/u,
    );
    await exportItems({ baseUrl: fake.url, keys: ['ITEM0001'], format: 'bib', outPath: target, overwrite: true });
    assert.match(readFileSync(target, 'utf8'), /@article\{alphaPaper2021,/u);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('csljson 返回可消费的结构化数组', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  try {
    const result = await exportItems({ baseUrl: fake.url, keys: ['ITEM0001', 'ITEM0003'], format: 'csljson' });
    assert.equal(result.count, 2);
    assert.ok(Array.isArray(result.data));
    for (const entry of result.data) {
      assert.equal(typeof entry.id, 'string');
      assert.equal(typeof entry.type, 'string');
    }
  } finally {
    await fake.close();
  }
});
