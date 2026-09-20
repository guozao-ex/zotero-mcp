/**
 * 逐页标签读数（**只读**）：给一篇 PDF 附件打印
 *   ① 父条目 / 文件名 / indexedPages / 全文分页符个数
 *   ② PDF 原始 `/PageLabels`（前几项）
 *   ③ **我们算出的逐页标签**——与索引里分块 `pageLabel` 同一口径（`_pageLabels[i] || (i+1)`）
 *
 * 用途：A8「阅读器目视对照」的复现入口。把 ③ 与 Zotero 阅读器页码框里显示的数字对照即可。
 * 只发本机回环 GET（`/items/<key>`、`/items/<key>/fulltext`、`/items/<key>/file` 的 302），
 * 只读 PDF 字节，不写文库、不写索引。
 *
 * 用法：npm run report:page-labels -- <itemKey>
 */
import { readPdfPages } from '../packages/indexer/src/pdf-pages.ts';
import { pageBreaksFromFulltext } from '../packages/indexer/src/page-breaks.ts';
import { labelForPage } from '../packages/indexer/src/page-labels.ts';

const BASE = process.env['ZOTERO_MCP_BASE_URL'] ?? 'http://127.0.0.1:23119';
const key = process.argv[2] ?? '9Y9MRLWC';
const api = (path, init) => fetch(`${BASE}/api/users/0/${path}`, init);

const item = await (await api(`items/${key}`)).json();
const title = item?.data?.title ?? '(未知标题)';
const fileName = item?.data?.filename ?? '(未知文件名)';
const parentKey = item?.data?.parentItem ?? null;
let parentTitle = '(无父条目)';
if (parentKey) {
  const parent = await (await api(`items/${parentKey}`)).json();
  parentTitle = parent?.data?.title ?? '(父条目无标题)';
}

// 全文端点可能是 404（Zotero 还没为这个附件建全文索引，扫描件更是本来就无文本）：
// 那种情况下**如实报「全文不可用」并继续给 PDF 侧信息**，不要因为一个 404 的 `Not found`
// 响应体去 JSON.parse 而整条命令崩掉。
const ftRes = await api(`items/${key}/fulltext`);
let content = '';
let indexedPages = null;
let fulltextNote = null;
if (ftRes.ok) {
  const ft = await ftRes.json();
  content = String(ft.content ?? '');
  indexedPages = ft.indexedPages ?? null;
} else {
  fulltextNote = `全文不可用（HTTP ${ftRes.status}）：该附件在 Zotero 里还没有全文索引（扫描件/刚加入的 linked 文件都可能如此）`;
}
const breaks = content.length === 0 ? null : pageBreaksFromFulltext(content, indexedPages);

const fileRes = await api(`items/${key}/file`, { redirect: 'manual' });
const loc = fileRes.headers.get('location') ?? '';
let rawLabels = null;
let pdfPages = null;
if (loc.startsWith('file://')) {
  const pathname = decodeURIComponent(new URL(loc).pathname);
  const winPath = pathname.replace(/^\//u, '').replace(/\//gu, '\\');
  const pages = await readPdfPages(winPath);
  if (pages.ok) {
    rawLabels = pages.pageLabels;
    pdfPages = pages.pageCount;
  } else {
    console.log(`（PDF 解析失败：${pages.code} — ${pages.reason}）`);
  }
}

console.log(`父条目：${parentTitle}`);
console.log(`附件：${title}｜文件名：${fileName}｜key=${key}`);
console.log(
  `Zotero 报的 indexedPages=${indexedPages ?? '(无)'}｜PDF 页数=${pdfPages ?? '(未知)'}｜全文字符数=${content.length}｜分页符个数=${content.split('\f').length - 1}`,
);
if (fulltextNote !== null) console.log(`⚠️ ${fulltextNote}`);
console.log(`PDF 原始 /PageLabels 前 5 项：${rawLabels ? JSON.stringify(rawLabels.slice(0, 5)) : '(无标签表)'}`);
if (breaks === null) {
  console.log('（没有全文：无法算「我们算出的逐页标签」；上面的 PDF 原始 /PageLabels 仍然可用）');
} else if (breaks.ok) {
  console.log('我们算出的逐页标签（前 5 页；与索引里分块 pageLabel 同口径）：');
  for (let i = 0; i < Math.min(5, breaks.pageCount); i += 1) {
    console.log(`  第 ${i + 1} 页  ->  "${labelForPage(i, rawLabels, breaks.pageCount)}"`);
  }
  console.log('请把上面这几行与 Zotero 阅读器页码框里显示的数字对照（A8）。');
} else {
  console.log(`（精确页边界不可用，整篇退回估算：${breaks.code} — ${breaks.reason}）`);
}
