/**
 * 从 Zotero 全文里取**精确**页边界（change `precise-page-labels`，路线图 Q2）。
 *
 * ## 关键发现（独立验收用地面真值核查后确认，2026-09-20）
 *
 * `GET /items/<key>/fulltext` 的 `content` **自带分页符 `\f`（U+000C）**：本机 12 篇 PDF 实测，
 * 每篇的 `\f` 个数**恰好等于 `indexedPages - 1`**（12/12 全中）。也就是说——
 *
 * > **精确页边界根本不需要解析 PDF。** `\f` 本身就是 Zotero 自己给的页分隔。
 *
 * 这比「解析 PDF 再把逐页文本对齐回全文」可靠得多：后者要靠探针 token 猜页首，
 * 真实库上 11 篇「锚点全命中」的样本里只有 4 篇的边界真的落在页首（其余错位 336–38225 字符，
 * 最坏一篇 98% 正文错位）——**「锚点命中率」不等于「页码正确率」**。
 *
 * 因此本模块是**首选边界来源**；PDF 解析只用来取页标签名（`/PageLabels`），不再用来定边界。
 *
 * ## 不变量
 *
 * - 只有 `\f` 个数**恰好等于 `pageCount - 1`** 才认（差一个都不认，宁可退回估算）；
 * - 边界恒以 0 开头、严格递增，且每页区间非空；
 * - 任一条件不满足即返回 `ok:false` + 可读原因，由调用方退回线性估算。
 */

export interface PageBreaksOk {
  ok: true;
  /** 每页首个字符在 `content` 里的偏移；首项恒为 0。 */
  boundaries: number[];
  /** 页数 = `boundaries.length`。 */
  pageCount: number;
}

export interface PageBreaksFailed {
  ok: false;
  code: 'no-separators' | 'count-mismatch' | 'empty-page';
  reason: string;
  /** 实际数到的分页符个数。 */
  separatorCount: number;
}

export type PageBreaks = PageBreaksOk | PageBreaksFailed;

/**
 * 从全文内容里解析页边界。
 *
 * @param content `GET /items/<key>/fulltext` 的 `content`
 * @param pageCount 期望页数（Zotero 的 `indexedPages`；不传则只按 `\f` 推断）
 */
export function pageBreaksFromFulltext(content: string, pageCount?: number | null): PageBreaks {
  const separators: number[] = [];
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 0x0c) separators.push(index);
  }

  if (separators.length === 0) {
    return {
      ok: false,
      code: 'no-separators',
      reason: '全文里没有分页符（\\f）：无法从全文得到精确页边界，退回估算',
      separatorCount: 0,
    };
  }

  const impliedPages = separators.length + 1;
  if (typeof pageCount === 'number' && Number.isFinite(pageCount) && pageCount > 0 && impliedPages !== pageCount) {
    return {
      ok: false,
      code: 'count-mismatch',
      reason: `分页符个数与页数不一致（数到 ${separators.length} 个 \\f → ${impliedPages} 页，但 Zotero 报告 ${pageCount} 页）：退回估算`,
      separatorCount: separators.length,
    };
  }

  // 边界 = [0, 第 1 个 \f 之后, 第 2 个 \f 之后, …]
  const boundaries = [0, ...separators.map((at) => at + 1)];
  for (let index = 0; index < boundaries.length; index += 1) {
    const start = boundaries[index] as number;
    const end = index + 1 < boundaries.length ? (boundaries[index + 1] as number) : content.length;
    // 「空页」有两种形态，都算不合格：
    //   ① 区间本身为空（end <= start）—— 防御性检查，正常不会出现；
    //   ② 区间里**没有可读文本**（只有分页符与空白）——真机上对应扫描页/纯图片页。
    //      此时该页没有正文可归位，硬给边界会让这一页的分块页码错位，宁可整篇退回估算。
    if (end <= start || content.slice(start, end).replace(/[\s\u000c]/gu, '').length === 0) {
      return {
        ok: false,
        code: 'empty-page',
        reason: `第 ${index + 1} 页没有任何可读文本（${start} → ${end}）：退回估算`,
        separatorCount: separators.length,
      };
    }
  }

  return { ok: true, boundaries, pageCount: boundaries.length };
}
