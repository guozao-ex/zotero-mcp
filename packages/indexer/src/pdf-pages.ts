/**
 * PDF 逐页解析（change `precise-page-labels`，路线图 Q2）。
 *
 * 只取三样东西：**页数**、**逐页文本**、**PDF 自带的 `/PageLabels` 表**（可能为 null）。
 * 正文永远来自 Zotero 的全文端点，这里只用 PDF 取**页标签与页数**（页边界来自全文自带的分页符）
 * ——这是本模块唯一的存在理由。
 *
 * 三条硬约束：
 *   1. **可选增强**：文件不存在 / 不是 PDF / 加密 / 超阈值 / 解析异常，一律返回 `ok:false` + 可读原因，
 *      **不抛异常**；页边界不依赖本模块，解析失败只让调用方按页序合成页标签（索引绝不能因此建不起来）；
 *   2. **只读**：只读文件字节，不修改 PDF、不写文库；
 *   3. **页标签口径与 Zotero 阅读器一致**：用 `getPageLabels()` 的结果，**表项为空串时由调用方回退成页序**
 *      （`/PageLabels` 可能从第 2 页才开始，阅读器的取值是 `_pageLabels[i] || (i+1)`）；返回 null 时合成 `1..N`。
 *
 * 依赖：`unpdf`（MIT，封装 pdf.js）。选它而不是官方 `pdfjs-dist`（未打包 34.7MB）的原因是体量小 16 倍，
 * 且直接暴露 `getPageLabels()`；`mupdf` 是 AGPL，仓库明确不引入。
 */

import { statSync } from 'node:fs';

/** 允许解析的最大文件字节数；超过即拒绝（避免把内存吃光）。可用环境变量覆盖。 */
export const DEFAULT_MAX_PDF_BYTES = 200 * 1024 * 1024;

export interface PdfPageTextsOk {
  ok: true;
  /** 页数（pdf.js 口径）。 */
  pageCount: number;
  /** 逐页文本，长度恒等于 `pageCount`。 */
  pageTexts: string[];
  /**
   * PDF 的 `/PageLabels` 表；**长度可能小于页数**，元素可能为空串。
   * `null` 表示没有标签表（调用方按 Zotero 口径合成 `1..N`）。
   * 缺失的位次用空串补齐，使数组长度恒等于 `pageCount`，便于按页索引。
   */
  pageLabels: string[] | null;
  /** 是否真的带标签表（`pageLabels !== null`）。 */
  hasPageLabels: boolean;
}

export interface PdfPageTextsFailed {
  ok: false;
  /** 机器可读的失败码。 */
  code: 'file-missing' | 'not-a-file' | 'too-large' | 'not-a-pdf' | 'encrypted' | 'parse-failed';
  /** 人类可读原因（不含文件内容）。 */
  reason: string;
}

export type PdfPageTexts = PdfPageTextsOk | PdfPageTextsFailed;

export interface ReadPdfPagesOptions {
  /** 最大字节数，缺省 `DEFAULT_MAX_PDF_BYTES`。 */
  maxBytes?: number;
  /** 便于测试注入：替代 `unpdf` 的文档加载。 */
  loadDocument?: (data: Uint8Array) => Promise<PdfDocumentLike>;
  /** 便于测试注入：替代 `node:fs` 的读取。 */
  readFileImpl?: (path: string) => Promise<Uint8Array>;
  /** 便于测试注入：替代 `node:fs` 的 stat。 */
  statImpl?: (path: string) => { isFile: () => boolean; size: number };
}

/** 只依赖我们真正用到的 pdf.js 表面，便于测试注入替身。 */
export interface PdfDocumentLike {
  numPages: number;
  getPageLabels?: () => Promise<string[] | null> | string[] | null;
  getPage: (pageNumber: number) => Promise<{
    getTextContent: () => Promise<{ items: { str?: string; hasEOL?: boolean }[] }>;
    cleanup?: () => void;
  }>;
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 页标签数组规整：缺失位次补空串、长度对齐页数、忽略多余项。
 *
 * 为什么要补齐：`/PageLabels` 表的**位次语义**是「从第 N 页开始应用某编号规则」，
 * pdf.js 的 `getPageLabels()` 已把它展开为逐页值，但实测真机上它可能是
 * `["", "477", "478", …]`（首元素空）或短于页数的形态。统一补齐到页数，
 * 调用方才能安全地按 `pageIndex` 取值。
 */
export function normalizePageLabels(raw: readonly string[] | null, pageCount: number): string[] | null {
  if (raw === null) return null;
  const out = new Array<string>(pageCount).fill('');
  for (let index = 0; index < pageCount; index += 1) {
    const value = raw[index];
    out[index] = typeof value === 'string' ? value : '';
  }
  return out;
}

/**
 * 读取一个本地 PDF 的逐页文本与页标签。**永不抛异常**。
 *
 * @param path 本地 PDF 绝对路径
 */
export async function readPdfPages(path: string, options: ReadPdfPagesOptions = {}): Promise<PdfPageTexts> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_PDF_BYTES;
  const statImpl = options.statImpl ?? ((target: string) => statSync(target));

  try {
    const info = statImpl(path);
    if (!info.isFile()) {
      return { ok: false, code: 'not-a-file', reason: `不是普通文件：${path}` };
    }
    if (info.size > maxBytes) {
      return {
        ok: false,
        code: 'too-large',
        reason: `PDF 超过解析上限（${info.size} > ${maxBytes} 字节）：已跳过页标签命名，页边界仍来自全文分页符`,
      };
    }
  } catch {
    return { ok: false, code: 'file-missing', reason: `文件不存在或不可读：${path}` };
  }

  let data: Uint8Array;
  try {
    if (options.readFileImpl !== undefined) {
      data = await options.readFileImpl(path);
    } else {
      const { readFile } = await import('node:fs/promises');
      data = new Uint8Array(await readFile(path));
    }
  } catch (error) {
    return { ok: false, code: 'file-missing', reason: `读取失败：${path}（${detailOf(error)}）` };
  }

  // 魔数校验：不是 PDF 就别交给解析器（错误信息更可读，也更快）
  if (data.length < 5 || String.fromCharCode(...data.subarray(0, 5)) !== '%PDF-') {
    return { ok: false, code: 'not-a-pdf', reason: `不是 PDF（缺少 %PDF- 魔数）：${path}` };
  }

  let doc: PdfDocumentLike;
  try {
    if (options.loadDocument !== undefined) {
      doc = await options.loadDocument(data);
    } else {
      const { getDocumentProxy } = await import('unpdf');
      doc = (await getDocumentProxy(data)) as unknown as PdfDocumentLike;
    }
  } catch (error) {
    const message = detailOf(error);
    // pdf.js 对加密文档的报错里含 PasswordException；这里只做关键词判断，不引入它的类型
    if (/password/i.test(message)) {
      return { ok: false, code: 'encrypted', reason: `PDF 已加密，无法解析页文本：${path}` };
    }
    return { ok: false, code: 'parse-failed', reason: `PDF 解析失败：${path}（${message}）` };
  }

  const pageCount = typeof doc.numPages === 'number' && doc.numPages > 0 ? doc.numPages : 0;
  if (pageCount === 0) {
    return { ok: false, code: 'parse-failed', reason: `PDF 报告 0 页：${path}` };
  }

  const pageTexts: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      // 保留 hasEOL 的换行语义：pdf.js 的 item 之间不一定带换行，靠 hasEOL 还原行界，
      // 否则相邻行会被粘成一个超长 token，伤害后面的锚点匹配。
      let text = '';
      for (const item of content.items) {
        if (typeof item.str === 'string') text += item.str;
        if (item.hasEOL === true) text += '\n';
      }
      pageTexts.push(text);
      page.cleanup?.();
    }
  } catch (error) {
    return { ok: false, code: 'parse-failed', reason: `读取页文本失败：${path}（${detailOf(error)}）` };
  }

  let rawLabels: string[] | null = null;
  if (typeof doc.getPageLabels === 'function') {
    try {
      const labels = await doc.getPageLabels();
      rawLabels = Array.isArray(labels) ? labels.map((value) => String(value)) : null;
    } catch {
      // 标签表读失败不影响页文本：按「没有标签表」处理，由调用方合成 1..N
      rawLabels = null;
    }
  }

  return {
    ok: true,
    pageCount,
    pageTexts,
    pageLabels: normalizePageLabels(rawLabels, pageCount),
    hasPageLabels: rawLabels !== null,
  };
}
