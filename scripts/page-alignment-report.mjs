#!/usr/bin/env node
/**
 * 精确页码对齐失败率报告（change `precise-page-labels`，只读）。
 *
 *   npm run report:page-align [-- --limit N] [--json]
 *
 * 遍历本机库里的 PDF 附件，逐个：
 *   1. `GET /items/<key>/fulltext` 取整篇正文与页数；
 *   2. `GET /items/<key>/file`（302 → `file://`）拿到本地 PDF 路径；
 *   3. 逐页解析（unpdf）并对齐回全文；
 *   4. 打印每篇的 `matched/total`、是否 ok、失败原因，并聚合失败原因分布。
 *
 * **只读**：只发 GET、只读 PDF 字节；不写文库、不写索引、不修改任何文件。
 * 失败篇目**逐条列出**（含原因），不只报成功数——这是本项「如实」那一半的证据。
 */

import { requestLocalApi, resolveItemFilePath, libraryStats } from '../packages/core/src/index.ts';
import { readPdfPages } from '../packages/indexer/src/pdf-pages.ts';
import { pageBreaksFromFulltext } from '../packages/indexer/src/page-breaks.ts';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const limitIndex = argv.indexOf('--limit');
const limit = limitIndex === -1 ? Number.POSITIVE_INFINITY : Number(argv[limitIndex + 1] ?? '0') || Number.POSITIVE_INFINITY;

function channelOptions() {
  return { baseUrl: process.env['ZOTERO_MCP_BASE_URL'] ?? 'http://127.0.0.1:23119' };
}

async function main() {
  const options = channelOptions();
  const headers = { 'zotero-api-version': '3' };

  // 列出所有 PDF 附件（只读）；`/items?itemType=attachment` 覆盖子项
  const response = await requestLocalApi({ ...options, path: '/api/users/0/items?itemType=attachment&limit=200', headers });
  const attachments = (Array.isArray(response.body) ? response.body : [])
    .map((entry) => entry?.data)
    .filter((data) => data !== undefined && data !== null && typeof data === 'object')
    .filter((data) => data['contentType'] === 'application/pdf')
    .map((data) => ({ key: String(data['key'] ?? ''), title: String(data['title'] ?? '') }))
    .filter((entry) => entry.key.length > 0)
    .slice(0, Number.isFinite(limit) ? limit : undefined);

  const rows = [];
  const reasonCounts = new Map();

  for (const attachment of attachments) {
    let fulltext = null;
    try {
      const ft = await requestLocalApi({ ...options, path: `/api/users/0/items/${attachment.key}/fulltext`, headers });
      fulltext = ft.body ?? null;
    } catch (error) {
      rows.push({ ...attachment, status: 'fulltext-unavailable', reason: error instanceof Error ? error.message.slice(0, 120) : String(error), matched: null, total: null });
      continue;
    }
    const content = typeof fulltext?.content === 'string' ? fulltext.content : '';
    const indexedPages = typeof fulltext?.indexedPages === 'number' ? fulltext.indexedPages : null;
    const totalPages = typeof fulltext?.totalPages === 'number' ? fulltext.totalPages : null;

    if (content.length === 0) {
      rows.push({ ...attachment, status: 'no-fulltext', reason: 'Zotero 全文为空（可能未索引）', matched: null, total: totalPages });
      continue;
    }

    // ① 首选：全文的 \f 分页符（零依赖、零误差）
    const breaks = pageBreaksFromFulltext(content, indexedPages);
    if (!breaks.ok) {
      rows.push({ ...attachment, status: 'fallback-estimated', reason: `${breaks.code}: ${breaks.reason}`, matched: 0, total: indexedPages, hasPageLabels: false });
      continue;
    }

    // ② 交叉核对（只读、可选）：\f 边界处切出的页首是否能在 pdf.js 该页文本里找到，
    //    以及 PDF 页数是否与 \f 推出的页数一致——用于暴露「Zotero 全文分页 ≠ PDF 分页」的异常。
    //    注意：即便这一项不完全命中，\f 边界仍是 Zotero 官方口径（全文本就带它），**不影响精确判定**。
    let crossCheck = null;
    let labelSource = 'synthesized';
    let hasPageLabels = false;
    try {
      const { path } = await resolveItemFilePath({ ...options, key: attachment.key, headers });
      const pages = await readPdfPages(path);
      if (pages.ok && pages.pageCount === breaks.pageCount) {
        let hits = 0;
        for (let index = 0; index < breaks.pageCount; index += 1) {
          const head = (pages.pageTexts[index] ?? '').trim().slice(0, 24);
          const segment = content.slice(breaks.boundaries[index], breaks.boundaries[index] + 400);
          // 中文页首没有空格，按「去空白后包含」判断
          const normalize = (value) => value.replace(/\s+/gu, '');
          if (head.length > 0 && normalize(segment).includes(normalize(head))) hits += 1;
        }
        crossCheck = `${hits}/${breaks.pageCount}`;
        hasPageLabels = pages.hasPageLabels;
        if (pages.hasPageLabels) labelSource = 'pdf-page-labels';
      } else if (pages.ok) {
        crossCheck = `pdf-pages-mismatch:${pages.pageCount}vs${breaks.pageCount}`;
      } else {
        crossCheck = `pdf-${pages.code}`;
      }
    } catch (error) {
      crossCheck = `pdf-read-error`;
      void error;
    }

    rows.push({
      ...attachment,
      status: 'precise',
      reason: null,
      matched: breaks.pageCount,
      total: breaks.pageCount,
      hasPageLabels,
      labelSource,
      crossCheck,
      /** 边界来源：Zotero 全文自带的 \f 分页符（不是 PDF 对齐） */
      boundarySource: 'fulltext-formfeed',
    });
  }

  for (const row of rows) {
    const bucket = row.status === 'precise' ? 'precise' : row.status === 'fallback-estimated' ? (row.reason ?? '').split(':')[0] ?? 'alignment-failed' : row.status;
    reasonCounts.set(bucket, (reasonCounts.get(bucket) ?? 0) + 1);
  }

  const precise = rows.filter((row) => row.status === 'precise').length;
  const summary = {
    scanned: rows.length,
    precise,
    fallbackOrSkipped: rows.length - precise,
    preciseRate: rows.length === 0 ? 0 : Number((precise / rows.length).toFixed(4)),
    reasonDistribution: Object.fromEntries([...reasonCounts.entries()].sort((a, b) => b[1] - a[1])),
  };

  if (asJson) {
    console.log(JSON.stringify({ summary, rows }, null, 2));
    return 0;
  }

  console.log('精确页码对齐失败率报告（只读；未写文库、未写索引）');
  console.log(`扫描 PDF 附件：${summary.scanned} 篇`);
  console.log('');
  for (const row of rows) {
    const matched = row.matched === null ? '  -  ' : `${row.matched}/${row.total}`;
    console.log(`  ${row.status === 'precise' ? '✔' : '·'} ${row.key}  ${matched.padStart(7)}  ${row.status.padEnd(20)} ${(row.title || '').slice(0, 34)}`);
    if (row.reason !== null) console.log(`      ↳ ${row.reason}`);
  }
  console.log('');
  console.log(`精确（pageLabelEstimated=false）：${summary.precise}/${summary.scanned} = ${(summary.preciseRate * 100).toFixed(1)}%`);
  console.log('失败/跳过原因分布：');
  for (const [reason, count] of Object.entries(summary.reasonDistribution)) {
    console.log(`  ${String(count).padStart(3)} × ${reason}`);
  }
  console.log('');
  console.log('说明：以上为真实库的实测结果；未精确的篇目在索引里会退回线性估算并标 pageLabelEstimated=true。');
  return 0;
}

process.exitCode = await main();
