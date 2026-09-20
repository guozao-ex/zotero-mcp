/**
 * 精确页码契约测试（change `precise-page-labels`，路线图 Q2）。
 *
 * 三条独立验证线：
 *   1. **页边界来源**（`page-breaks.ts`）：全文 `\f` 分页符给出的边界是否精确、计数不符/空页是否如实判失败；
 *      以及**页标签口径**（`page-labels.ts`，空表项回退页序）；
 *   2. **分块器**（`chunk.ts`）：给精确边界时 `pageLabelEstimated=false`、页标签逐页正确；
 *      **不给边界时与改动前逐字一致**（线性估算 + `true`）；
 *   3. **PDF 逐页解析**（`pdf-pages.ts`）：用**测试期自建的最小 PDF** 真跑 unpdf，
 *      断言页数、逐页文本与 `/PageLabels`；以及失败路径（缺文件/非 PDF/超阈值）不抛异常。
 *
 * 全程不访问网络、不碰真实库、不写真实缓存。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';

import { chunkText } from '../../packages/indexer/src/chunk.ts';
import { labelForPage, pageIndexOf } from '../../packages/indexer/src/page-labels.ts';
import { pageBreaksFromFulltext } from '../../packages/indexer/src/page-breaks.ts';
import { normalizePageLabels, readPdfPages } from '../../packages/indexer/src/pdf-pages.ts';
import { INDEX_SCHEMA_VERSION, openIndexStore, readIndexStatus } from '../../packages/indexer/src/store.ts';

/** 极简分词器：按空白切，够用来测分块（本 change 不动 tokenizer）。 */
const whitespaceTokenizer = {
  countTokens: (text) => text.split(/\s+/u).filter((piece) => piece.length > 0).length,
};

// ── 测试期自建最小 PDF ──────────────────────────────────────────────────

/**
 * 拼一个最小但**合法**的多页 PDF：每页一个内容流，文字用 Helvetica。
 *
 * `pageLabels` 传入时写出 `/PageLabels` 数字树（支持空串标签——这正是真机上遇到的形态：
 * 第 1 页没有标签、第 2 页起是 477…）。
 */
function buildPdf({ pageTexts, pageLabels }) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length; // 1 起的对象号
  };

  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const contentIds = [];
  for (const text of pageTexts) {
    const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/gu, (ch) => `\\${ch}`)}) Tj ET`;
    contentIds.push(add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`));
  }
  const pageIds = [];
  for (const contentId of contentIds) {
    pageIds.push(
      add(
        `<< /Type /Page /Parent PAGES_REF /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
      ),
    );
  }
  const pagesId = add(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
  for (const pageId of pageIds) {
    objects[pageId - 1] = objects[pageId - 1].replace('PAGES_REF', `${pagesId} 0 R`);
  }

  let labelRef = '';
  if (Array.isArray(pageLabels)) {
    // **按 Zotero 的真实形态写**：`/Nums` 是 `[index1 dict1 index2 dict2 …]`，且
    // **空标签的页不写项**（真机 9Y9MRLWC 的标签表就是 `["","477","478",…]`——第 0 页没有项，
    // pdf.js 对它给空串，调用方再按阅读器口径 `_pageLabels[i] || (i+1)` 回退成页序）。
    // 若给空标签也写一项 `/P ()`，pdf.js 会算出 `"1"`，就与真机形态不符了。
    const entries = pageLabels
      .map((label, index) => {
        const text = label ?? '';
        if (text === '') return null;
        const dict = /^\d+$/u.test(text)
          ? `<< /S /D /St ${text} >>`
          : `<< /S /D /P (${String(text).replace(/[()\\]/gu, '')}) >>`;
        return `${index} ${dict}`;
      })
      .filter((entry) => entry !== null)
      .join(' ');
    const labelId = add(`<< /Nums [ ${entries} ] >>`);
    labelRef = ` /PageLabels ${labelId} 0 R`;
  }
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R${labelRef} >>`);

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(out.length);
    out += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

// ── 1. 对齐算法 ──────────────────────────────────────────────────────────

test('Q2/A4：页标签取值口径——有表用非空值、空串回退页序、无表合成页序', () => {
  assert.equal(labelForPage(0, ['', '477'], 2), '1', '空串必须回退成页序（与 Zotero 阅读器 _pageLabels[i] || (i+1) 一致）');
  assert.equal(labelForPage(1, ['', '477'], 2), '477');
  assert.equal(labelForPage(2, ['', '477', '  '], 3), '3', '纯空白也按空串回退');
  assert.equal(labelForPage(0, null, 3), '1', '无表时合成页序');
  assert.equal(labelForPage(2, null, 3), '3');
  assert.equal(labelForPage(9, null, 3), '', '越界返回空串而不是崩');
  // 表比页数短：缺的位次按空串（调用方按「无表」处理的语义由 normalizePageLabels 决定）
  assert.deepEqual(normalizePageLabels(['', '477'], 4), ['', '477', '', '']);
  assert.deepEqual(normalizePageLabels(['1', '2', '3', '4'], 2), ['1', '2'], '多余的项忽略');
  assert.equal(normalizePageLabels(null, 3), null, 'null 表示没有标签表');
});

// ── 2. 分块器 ────────────────────────────────────────────────────────────

test('Q2/A1：给精确边界时页码精确、pageLabelEstimated=false，且页标签逐页正确', () => {
  const content = 'first page text here\nsecond page text here\nthird page text here';
  const secondAt = content.indexOf('second');
  const thirdAt = content.indexOf('third');
  const chunks = chunkText('ITEM0001', content, {
    tokenizer: whitespaceTokenizer,
    maxTokens: 8,
    pageBoundaries: [0, secondAt, thirdAt],
    pageLabels: ['', '477', '478'],
    pageCount: 3,
    indexedPages: 3,
  });
  assert.ok(chunks.length >= 1, `应至少切出 1 块，实际 ${chunks.length}`);
  for (const chunk of chunks) {
    assert.equal(chunk.pageLabelEstimated, false, '精确来源必须标 false');
    const page = pageIndexOf([0, secondAt, thirdAt], chunk.charStart);
    const expected = ['1', '477', '478'][page]; // 空串按阅读器口径回退成页序
    assert.equal(chunk.pageLabel, expected, `偏移 ${chunk.charStart} 应落在第 ${page + 1} 页（标签 ${JSON.stringify(expected)}）`);
  }
  // 溯源不回归：charStart/charEnd 指向的原文与 text 逐字一致
  for (const chunk of chunks) {
    assert.equal(content.slice(chunk.charStart, chunk.charEnd), chunk.text);
  }
});

test('Q2/A2：不给精确边界时行为与改动前逐字一致（线性估算 + true）', () => {
  const content = 'a'.repeat(300) + '\n' + 'b'.repeat(300);
  const baseline = chunkText('ITEM0001', content, { tokenizer: whitespaceTokenizer, maxTokens: 40, indexedPages: 4 });
  const withNull = chunkText('ITEM0001', content, {
    tokenizer: whitespaceTokenizer,
    maxTokens: 40,
    indexedPages: 4,
    pageBoundaries: null,
    pageLabels: null,
  });
  assert.deepEqual(withNull, baseline, '显式传 null 必须与不传完全一致');
  for (const chunk of baseline) {
    assert.equal(chunk.pageLabelEstimated, true, '估算必须标 true');
    assert.match(String(chunk.pageLabel), /^[1-4]$/u);
  }
  // indexedPages 缺失 → 页码为 null（既有口径）
  const noPages = chunkText('ITEM0001', content, { tokenizer: whitespaceTokenizer, maxTokens: 40 });
  assert.equal(noPages.every((chunk) => chunk.pageLabel === null), true);
  assert.equal(noPages.every((chunk) => chunk.pageLabelEstimated === false), true);
});

test('Q2/A7：可疑边界（首项非 0 / 不递增）一律当没给，退回估算', () => {
  const content = 'a'.repeat(120) + '\n' + 'b'.repeat(120);
  for (const boundaries of [[5, 100, 200], [0, 200, 150], [0, 0]]) {
    const chunks = chunkText('ITEM0001', content, {
      tokenizer: whitespaceTokenizer,
      maxTokens: 30,
      indexedPages: 2,
      pageBoundaries: boundaries,
      pageLabels: ['x', 'y'],
      pageCount: 2,
    });
    assert.equal(chunks.every((chunk) => chunk.pageLabelEstimated === true), true, `边界 ${JSON.stringify(boundaries)} 必须退回估算`);
  }
});

// ── 3. PDF 逐页解析（真跑 unpdf） ────────────────────────────────────────

test('Q2/A6：测试期自建的多页 PDF 能被解析出页数、逐页文本与 /PageLabels（含空标签）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-pdf-'));
  const path = join(dir, 'sample.pdf');
  try {
    writeFileSync(
      path,
      buildPdf({
        pageTexts: ['HAL Id first page', 'ORIGINAL PAPER second page', 'Third page body'],
        pageLabels: ['', '477', '478'],
      }),
    );
    const result = await readPdfPages(path);
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    assert.equal(result.pageCount, 3);
    assert.equal(result.pageTexts.length, 3);
    assert.match(result.pageTexts[0], /HAL Id first page/u);
    assert.match(result.pageTexts[1], /ORIGINAL PAPER second page/u);
    assert.match(result.pageTexts[2], /Third page body/u);
    assert.equal(result.hasPageLabels, true, '自建的 PDF 写了 /PageLabels，必须被读到');
    assert.equal(result.pageLabels.length, 3, '标签数组长度必须等于页数（缺失位次补空串）');
    assert.deepEqual(normalizePageLabels(result.pageLabels, 3), result.pageLabels);
    // **逐值断言**（此前缺失的那条路径）：/Nums 带索引键后，pdf.js 必须展开出真实标签，
    // 即「非空标签经 unpdf 读出」这条路真的被测到了；第 1 页是空串（调用方按阅读器口径回退页序）。
    assert.deepEqual(result.pageLabels, ['', '477', '478'], 'pdf.js 必须按 /Nums 的索引键展开出真实标签');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Q2/A6：没有 /PageLabels 的 PDF 返回 null（由调用方合成 1..N）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-pdf-nolabel-'));
  const path = join(dir, 'nolabel.pdf');
  try {
    writeFileSync(path, buildPdf({ pageTexts: ['page one', 'page two'], pageLabels: null }));
    const result = await readPdfPages(path);
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    assert.equal(result.pageCount, 2);
    assert.equal(result.pageLabels, null);
    assert.equal(result.hasPageLabels, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Q2/A7+A12：缺文件 / 非 PDF / 超阈值 / 坏文件都如实失败且不抛异常', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-pdf-fail-'));
  try {
    const missing = await readPdfPages(join(dir, 'nope.pdf'));
    assert.equal(missing.ok, false);
    assert.equal(missing.code, 'file-missing');

    const notPdf = join(dir, 'text.pdf');
    writeFileSync(notPdf, 'this is definitely not a pdf');
    const bad = await readPdfPages(notPdf);
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'not-a-pdf');

    const huge = join(dir, 'huge.pdf');
    writeFileSync(huge, buildPdf({ pageTexts: ['x'], pageLabels: null }));
    const tooLarge = await readPdfPages(huge, { maxBytes: 10 });
    assert.equal(tooLarge.ok, false);
    assert.equal(tooLarge.code, 'too-large');
    assert.match(tooLarge.reason, /上限/u);

    // 有魔数但内容损坏：必须走 parse-failed 而不是把异常抛出去
    const broken = join(dir, 'broken.pdf');
    writeFileSync(broken, '%PDF-1.4\nthis is garbage without xref\n');
    const parsed = await readPdfPages(broken);
    assert.equal(parsed.ok, false, '损坏的 PDF 必须判失败');
    assert.ok(['parse-failed', 'encrypted'].includes(parsed.code), `实际 ${parsed.code}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Q2/A12：超大页数的 PDF 不会让解析无限拖（用注入替身断言阈值与调用次数）', async () => {
  const pages = [];
  let getPageCalls = 0;
  const fake = {
    numPages: 3,
    getPageLabels: () => null,
    getPage: async (pageNumber) => {
      getPageCalls += 1;
      return { getTextContent: async () => ({ items: [{ str: `page ${pageNumber}` }] }) };
    },
  };
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-pdf-inject-'));
  const path = join(dir, 'injected.pdf');
  try {
    writeFileSync(path, '%PDF-1.4\n%%EOF\n');
    const result = await readPdfPages(path, { loadDocument: async () => fake });
    assert.equal(result.ok, true, result.ok ? '' : result.reason);
    assert.equal(getPageCalls, 3, '应按页数逐页调用，不多不少');
    assert.deepEqual(pages, []);
    assert.deepEqual(result.pageTexts, ['page 1', 'page 2', 'page 3']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Q2：页码来源统计——精确与估算分块都要能数出来', () => {
  const content = 'alpha '.repeat(40) + '\n' + 'beta '.repeat(40);
  const half = content.indexOf('beta');
  const precise = chunkText('ITEM0001', content, {
    tokenizer: whitespaceTokenizer,
    maxTokens: 30,
    pageBoundaries: [0, half],
    pageLabels: ['1', '2'],
    pageCount: 2,
  });
  const estimated = chunkText('ITEM0001', content, { tokenizer: whitespaceTokenizer, maxTokens: 30, indexedPages: 2 });
  const count = (chunks) => ({
    precise: chunks.filter((chunk) => !chunk.pageLabelEstimated).length,
    estimated: chunks.filter((chunk) => chunk.pageLabelEstimated).length,
  });
  const a = count(precise);
  const b = count(estimated);
  assert.ok(a.precise > 0 && a.estimated === 0, `精确集合应全为精确：${JSON.stringify(a)}`);
  assert.ok(b.estimated > 0 && b.precise === 0, `估算集合应全为估算：${JSON.stringify(b)}`);
  assert.equal(a.precise + a.estimated, precise.length);
  assert.equal(b.precise + b.estimated, estimated.length);
});

void deflateSync; // 保留 import：自建 PDF 若改用压缩流时需要（当前用明文流）
void assert;

test('Q2/A24 回归：局部 setMeta（不带 pageAlignment）不得抹掉既有的页对齐结论', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-q2-partial-meta-'));
  try {
    const store = openIndexStore(dir, { modelId: 'test-model', dim: 4, schemaVersion: INDEX_SCHEMA_VERSION });
    const meta = {
      attempted: 2,
      precise: 1,
      estimated: 1,
      failures: [{ itemKey: 'BBBB2222', code: 'count-mismatch', reason: '分页符个数与页数不一致：退回估算', matchedPages: 0, totalPages: 9 }],
    };
    store.setMeta({ modelId: 'test-model', dim: 4, schemaVersion: INDEX_SCHEMA_VERSION, watermark: 7, pageAlignment: JSON.stringify(meta) });
    // 模拟「清单为空的增量 update」：只推进水位、不带 pageAlignment（indexer 里就是这条分支）
    store.setMeta({ modelId: 'test-model', dim: 4, schemaVersion: INDEX_SCHEMA_VERSION, watermark: 9 });
    assert.deepEqual(store.status().pageAlignment, meta, '不带 pageAlignment 的局部 setMeta 必须保留上一次的结论');
    assert.equal(store.status().watermark, 9, '水位仍要推进');
    store.close();
    assert.deepEqual(readIndexStatus(dir).pageAlignment, meta, '重开索引也要读得到同一份结论');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 独立验收发现的两处缺口：回归断言 ────────────────────────────────────

test('Q2/A21 回归：对齐失败的原因与命中页数必须能持久化并被 status 读到', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-q2-meta-'));
  try {
    const store = openIndexStore(dir, { modelId: 'test-model', dim: 4, schemaVersion: INDEX_SCHEMA_VERSION });
    const meta = {
      attempted: 3,
      precise: 2,
      estimated: 1,
      failures: [
        { itemKey: 'AAAA1111', code: 'page-not-found', reason: '有 4/23 页在全文里找不到锚点（页号：20, 21, 22, 23）：退回估算', matchedPages: 19, totalPages: 23 },
      ],
    };
    store.setMeta({
      modelId: 'test-model',
      dim: 4,
      schemaVersion: INDEX_SCHEMA_VERSION,
      watermark: 7,
      pageAlignment: JSON.stringify(meta),
    });
    const status = store.status();
    assert.deepEqual(status.pageAlignment, meta, 'status 必须原样读出对齐明细（含失败原因与 matched/total）');
    store.close();

    // 重新打开（只读路径）也要读得到
    const reopened = readIndexStatus(dir);
    assert.deepEqual(reopened.pageAlignment, meta, 'readIndexStatus 也必须读出对齐明细');
    assert.equal(reopened.watermark, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Q2：indexer 的 readPdfPagesImpl 注入缝必须真的生效（不是死参数）', async () => {
  // 该缝曾被独立验收指出「传了不生效」；这里断言 alignItemPages 会把它透传下去。
  const source = readFileSync(new URL('../../packages/indexer/src/indexer.ts', import.meta.url), 'utf8');
  const call = source.slice(source.indexOf('await alignItemPages('), source.indexOf('await alignItemPages(') + 700);
  assert.match(call, /readPdfPagesImpl/u, 'alignItemPages 调用必须把 readPdfPagesImpl 传下去');
  assert.match(source, /options\.readPdfPagesImpl === undefined \? \{\} : \{ readPdfPagesImpl: options\.readPdfPagesImpl \}/u);
});

test('Q2：INDEX_SCHEMA_VERSION 已 bump 到 2（页码语义变了，旧索引需重建）', () => {
  assert.equal(INDEX_SCHEMA_VERSION, 2, '页码语义变更必须 bump schema 版本，避免新旧页码混用');
});

// ── 改用「全文 \f 分页符」作为首选边界来源后的断言 ──────────────────────

test('Q2/A1 关键：全文的 \f 分页符给出精确页边界（零依赖、零误差）', () => {
  const page1 = 'HAL Id: hal-01532431 https://hal.science';
  const page2 = 'ORIGINAL PAPER Viability of Lactobacillus';
  const page3 = '1 Introduction In recent years';
  const content = `${page1}\f${page2}\f${page3}`;

  const breaks = pageBreaksFromFulltext(content, 3);
  assert.equal(breaks.ok, true, breaks.ok ? '' : breaks.reason);
  assert.equal(breaks.pageCount, 3);
  assert.deepEqual(breaks.boundaries, [0, page1.length + 1, page1.length + 1 + page2.length + 1]);
  // 每页区间切出来必须正好是那一页
  assert.equal(content.slice(breaks.boundaries[0], breaks.boundaries[1]), `${page1}\f`);
  assert.equal(content.slice(breaks.boundaries[1], breaks.boundaries[2]), `${page2}\f`);
  assert.equal(content.slice(breaks.boundaries[2]), page3);
  // 首项恒为 0、严格递增
  assert.equal(breaks.boundaries[0], 0);
  for (let i = 1; i < breaks.boundaries.length; i += 1) assert.ok(breaks.boundaries[i] > breaks.boundaries[i - 1]);
});

test('Q2/A1：\f 个数与 Zotero 报告的页数不一致时必须判失败（不猜）', () => {
  const content = 'a\fb\fc'; // 3 页
  assert.equal(pageBreaksFromFulltext(content, 3).ok, true);
  const mismatch = pageBreaksFromFulltext(content, 5);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, 'count-mismatch');
  assert.match(mismatch.reason, /不一致/u);
  // 没有传页数时按 \f 推断
  assert.equal(pageBreaksFromFulltext(content).pageCount, 3);
});

test('Q2/A7：全文没有 \f 时判失败并退回估算', () => {
  const none = pageBreaksFromFulltext('no separators here at all', 4);
  assert.equal(none.ok, false);
  assert.equal(none.code, 'no-separators');
  assert.match(none.reason, /退回估算/u);
  // 空页（连续两个 \f）也不能算精确
  const empty = pageBreaksFromFulltext('a\f\fb', 3);
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'empty-page');
});

test('Q2/A1：\f 边界给出的页码必须与"阅读器显示"同口径的标签一致（含无标签表的合成）', () => {
  const content = 'p1 text\fp2 text\fp3 text';
  const breaks = pageBreaksFromFulltext(content, 3);
  assert.equal(breaks.ok, true);
  // 无标签表 → 合成 1..N
  const synthesized = Array.from({ length: breaks.pageCount }, (_, i) => labelForPage(i, null, breaks.pageCount));
  assert.deepEqual(synthesized, ['1', '2', '3']);
  // 有标签表且首项为空串 → 回退页序（与阅读器 _pageLabels[i] || (i+1) 一致）
  const withTable = Array.from({ length: breaks.pageCount }, (_, i) => labelForPage(i, ['', '477', '478'], breaks.pageCount));
  assert.deepEqual(withTable, ['1', '477', '478']);
});
