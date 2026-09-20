/**
 * 页码标签口径（change `precise-page-labels`）。
 *
 * 本模块只有一件事：把「第几页」换算成**Zotero 阅读器实际显示的页码字符串**。
 *
 * 口径来自 Zotero 自己的代码：阅读器取页码是
 * `this._pageLabels[pageIndex] || (pageIndex + 1).toString()`（同文件里缩略图与标注弹窗同样兜底）。
 * 也就是：
 *   - 表里有**非空**值 → 用它；
 *   - 表里是**空串**（`/PageLabels` 从第 2 页才开始时，第 1 页就是这种）→ **回退成页序** `"1"`；
 *   - 没有表（`getPageLabels()` 返回 null）→ 同样回退成页序 `"1".."N"`。
 *
 * 这条兜底很关键：本机 12 篇 PDF 里有 5 篇的 `/PageLabels` 从第 2 页才开始，若我们保留空串，
 * 第 1 页的页码就会与阅读器显示不一致（库内 12 条既有注释的 `annotationPageLabel` 全是 `"1"`，
 * 说明 Zotero 自己写入时也走这个兜底）。
 *
 * ## 页边界从哪来？
 *
 * 不在本模块。精确页边界由 `page-breaks.ts` 从 **Zotero 全文自带的 `\f` 分页符**得到
 * （零依赖、零误差）；PDF 解析（`pdf-pages.ts`）只用来取 `/PageLabels` 给这些边界命名。
 * 早先那版「把 PDF 逐页文本对齐回全文」的做法已被独立验收证伪（11 篇「锚点全命中」的样本里
 * 只有 4 篇边界真的落在页首，最坏一篇 98% 正文错位），因此整块删掉，只保留本模块的取名口径。
 */

/**
 * 把页序号换算成页标签（与 Zotero 阅读器显示值一致）。
 *
 * @param pageIndex 0 起的页序号
 * @param labels PDF 的 `/PageLabels`（可为 null / 更短）
 * @param pageCount 总页数（用于越界保护）
 */
export function labelForPage(pageIndex: number, labels: readonly string[] | null | undefined, pageCount: number): string {
  if (pageIndex < 0 || pageIndex >= pageCount) return '';
  const fallback = String(pageIndex + 1);
  const fromTable = labels?.[pageIndex];
  if (typeof fromTable !== 'string') return fallback;
  const trimmed = fromTable.trim();
  return trimmed.length === 0 ? fallback : fromTable;
}

/**
 * 在页边界数组里定位某个字符偏移属于哪一页（0 起）。
 *
 * 二分查找：`boundaries[i] <= charStart < boundaries[i+1]` → 第 i 页。越界夹到首/尾页。
 */
export function pageIndexOf(boundaries: readonly number[], charStart: number): number {
  if (boundaries.length === 0) return -1;
  let low = 0;
  let high = boundaries.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((boundaries[mid] as number) <= charStart) low = mid;
    else high = mid - 1;
  }
  return low;
}
