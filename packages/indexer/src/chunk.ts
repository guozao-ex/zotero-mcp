/**
 * 段落级分块与溯源。
 *
 * 三条硬要求（来自 `semantic-index` 规格）：
 *   1. 段落级切分：先按空行 / 换行切段，长段再按句末标点切，仍超长才按 token 上限硬切；
 *   2. 相邻分块的重叠按 **token** 计落在 10%–15%（不得为 0，也不得超过 20%）；
 *   3. 每个分块带精确的 `charRange`（指向原文，逐字可还原）与如实标注的 `pageLabel`。
 *
 * 页码为什么是估算：`GET /items/<key>/fulltext` 只返回 `{content, indexedPages, totalPages}`，
 * **没有逐页字符偏移**（本机 Zotero 10.0.3 实测）。因此这里按 `content.length / indexedPages`
 * 线性估算，并用 `pageLabelEstimated: true` 如实标注；拿不到页数时为 null。
 */

import { createHash } from 'node:crypto';

import { labelForPage, pageIndexOf } from './page-labels.ts';
import type { WordPieceTokenizer } from './tokenizer.ts';

export interface Chunk {
  itemKey: string;
  /** 同一条目内的分块序号（0 起）。 */
  index: number;
  text: string;
  charStart: number;
  charEnd: number;
  pageLabel: string | null;
  pageLabelEstimated: boolean;
  contentHash: string;
  tokens: number;
}

export interface ChunkOptions {
  tokenizer: WordPieceTokenizer;
  /** 单个分块的内容 token 上限（不含 `[CLS]` / `[SEP]`）。 */
  maxTokens: number;
  /** 重叠比例（按 token 计），规格要求 10%–15%。 */
  overlapRatio?: number;
  /** 全文端点给出的已索引页数；用于估算页码，缺失时为 null。 */
  indexedPages?: number | null;
  /**
   * **精确**页边界（每页首个字符在 `content` 里的偏移，change `precise-page-labels`）。
   * 给了它且校验通过时页码取真实页、`pageLabelEstimated: false`；没给则行为与改动前逐字一致。
   */
  pageBoundaries?: number[] | null;
  /**
   * 与 `pageBoundaries` 配套的页标签（来自 PDF 的 `/PageLabels`）。
   * 空串按 Zotero 阅读器口径**回退成页序**（`_pageLabels[i] || (i+1)`），不会原样输出空串。
   */
  pageLabels?: string[] | null;
  /** 总页数；缺省取 `pageBoundaries.length`。 */
  pageCount?: number | null;
}

export interface TextSegment {
  text: string;
  start: number;
  end: number;
}

/** 段落切分：优先空行，其次单换行；保留每段的字符区间。 */
export function splitParagraphs(content: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const pattern = /[^\n]+(?:\n(?!\s*\n)[^\n]+)*/gu;
  for (const match of content.matchAll(pattern)) {
    const text = match[0];
    if (text.trim().length === 0) continue;
    const start = match.index ?? 0;
    segments.push({ text, start, end: start + text.length });
  }
  return segments;
}

/** 把超长段落按句末标点再切（中英文标点都认）。 */
export function splitSentences(segment: TextSegment): TextSegment[] {
  const out: TextSegment[] = [];
  const pattern = /[^。！？!?.;；\n]+[。！？!?.;；]?/gu;
  for (const match of segment.text.matchAll(pattern)) {
    const text = match[0];
    if (text.trim().length === 0) continue;
    const start = segment.start + (match.index ?? 0);
    out.push({ text, start, end: start + text.length });
  }
  return out.length > 0 ? out : [segment];
}

function hashOf(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 条目级内容指纹：由各分块指纹按顺序聚合。
 *
 * 索引器（跳过判断）与存储（items 表）必须用**同一个函数**，否则「指纹相同就跳过」会永远不成立。
 */
export function itemFingerprint(chunks: readonly Chunk[]): string {
  return createHash('sha256').update(chunks.map((chunk) => chunk.contentHash).join('|')).digest('hex').slice(0, 16);
}

/**
 * 页码解析：**精确优先，估算兜底**。
 *
 * - 给了 `pageBoundaries`（且非空、递增）时按真实页取标签，`estimated: false`；
 *   页标签由 PDF 的 `/PageLabels` 命名，**表项为空串时回退成页序**
 *   （与 Zotero 阅读器 `_pageLabels[i] || (i+1)` 同口径，不得保留空串）；
 *   没有标签表时合成 `String(pageIndex + 1)`。
 * - 没给（全文没有分页符 / 分页符计数不符 / 存在不可读页 / 调用方没接线）时，与改动前**逐字一致**地线性估算并标 `true`。
 */
function pageLabelFor(
  charStart: number,
  contentLength: number,
  indexedPages: number | null | undefined,
  precise?: { boundaries: readonly number[]; labels: readonly string[] | null | undefined; pageCount: number } | null,
): { pageLabel: string | null; estimated: boolean } {
  if (precise != null && precise.boundaries.length > 0) {
    const pageIndex = pageIndexOf(precise.boundaries, charStart);
    if (pageIndex >= 0) {
      return { pageLabel: labelForPage(pageIndex, precise.labels, precise.pageCount), estimated: false };
    }
  }
  if (typeof indexedPages !== 'number' || !Number.isFinite(indexedPages) || indexedPages <= 0 || contentLength <= 0) {
    return { pageLabel: null, estimated: false };
  }
  const charsPerPage = contentLength / indexedPages;
  const page = Math.min(indexedPages, Math.floor(charStart / charsPerPage) + 1);
  return { pageLabel: String(page), estimated: true };
}

/** 二分找「token 数不超过 limit」的最大字符前缀长度。 */
function maxCharsWithinTokens(text: string, limit: number, tokenizer: WordPieceTokenizer): number {
  let low = 1;
  let high = text.length;
  let best = 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (tokenizer.countTokens(text.slice(0, mid)) <= limit) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/** 二分找「token 数接近但不超过 target」的最大后缀起始位置对应的字符数。 */
function overlapCharsFor(text: string, targetTokens: number, tokenizer: WordPieceTokenizer): number {
  if (targetTokens <= 0) return 0;
  let low = 0;
  let high = text.length;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (tokenizer.countTokens(text.slice(text.length - mid)) <= targetTokens) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/**
 * 把一条全文切成带溯源的分块。
 *
 * 实现要点：全程在**字符坐标**上工作（分块是字符区间），token 只用来定预算，因此
 * `content.slice(charStart, charEnd) === chunk.text` 永远成立。
 */
export function chunkText(itemKey: string, content: string, options: ChunkOptions): Chunk[] {
  const { tokenizer, maxTokens } = options;
  const overlapRatio = options.overlapRatio ?? 0.125;
  if (!(overlapRatio > 0) || overlapRatio > 0.2) {
    throw new Error(`overlapRatio 必须落在 (0, 0.2]，收到：${String(options.overlapRatio)}`);
  }
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error(`maxTokens 必须是正整数，收到：${String(options.maxTokens)}`);
  }
  if (content.trim().length === 0) return [];

  const overlapTokens = Math.max(1, Math.round(maxTokens * overlapRatio));
  const chunks: Chunk[] = [];
  // 精确页边界只接受「非空 + 首项为 0 + 严格递增」的数组；任何不满足都当没给——
  // 宁可退回诚实的估算，也不用可疑的边界给出错误页码。
  const candidateBoundaries = options.pageBoundaries;
  const precise =
    Array.isArray(candidateBoundaries) &&
    candidateBoundaries.length > 0 &&
    candidateBoundaries[0] === 0 &&
    candidateBoundaries.every((value, index) => index === 0 || value > (candidateBoundaries[index - 1] as number))
      ? {
          boundaries: candidateBoundaries,
          labels: options.pageLabels ?? null,
          pageCount: options.pageCount ?? candidateBoundaries.length,
        }
      : null;
  const push = (start: number, end: number) => {
    const text = content.slice(start, end);
    if (text.trim().length === 0) return;
    const { pageLabel, estimated } = pageLabelFor(start, content.length, options.indexedPages, precise);
    chunks.push({
      itemKey,
      index: chunks.length,
      text,
      charStart: start,
      charEnd: end,
      pageLabel,
      pageLabelEstimated: estimated,
      contentHash: hashOf(text),
      tokens: tokenizer.countTokens(text),
    });
  };

  // ① 先把段落拆成原子片段：每片都 ≤ maxTokens − overlapTokens，给重叠留出预算
  const pieceBudget = Math.max(1, maxTokens - overlapTokens);
  const atoms: TextSegment[] = [];
  for (const paragraph of splitParagraphs(content)) {
    if (tokenizer.countTokens(paragraph.text) <= pieceBudget) {
      atoms.push(paragraph);
      continue;
    }
    for (const sentence of splitSentences(paragraph)) {
      if (tokenizer.countTokens(sentence.text) <= pieceBudget) {
        atoms.push(sentence);
        continue;
      }
      let offset = sentence.start;
      while (offset < sentence.end) {
        const remaining = content.slice(offset, sentence.end);
        const take = maxCharsWithinTokens(remaining, pieceBudget, tokenizer);
        atoms.push({ text: content.slice(offset, offset + take), start: offset, end: offset + take });
        if (offset + take >= sentence.end) break;
        // 硬切之间也要保留重叠
        offset += Math.max(1, take - overlapCharsFor(content.slice(offset, offset + take), overlapTokens, tokenizer));
      }
    }
  }

  // ② 贪心合并：能塞下就延长，塞不下就结块；新块的起点从上一块尾部**按 token 预算**回退，
  //    这样无论边界落在段落、句子还是硬切片上，重叠都真实存在（且总和不超过 maxTokens）。
  let current: { start: number; end: number } | null = null;
  const flush = (): void => {
    if (current === null) return;
    push(current.start, current.end);
    current = null;
  };
  for (const atom of atoms) {
    if (current === null) {
      current = { start: atom.start, end: atom.end };
      continue;
    }
    if (tokenizer.countTokens(content.slice(current.start, atom.end)) <= maxTokens) {
      current = { start: current.start, end: atom.end };
      continue;
    }
    const previous: { start: number; end: number } = current;
    flush();
    const tail = content.slice(previous.start, previous.end);
    // 回溯预算必须按**上一块的实际 token 数**算，不能用 maxTokens 的固定比例：上一块偏短时
    // 固定预算会把它整块吞掉，重叠比例直接越界（真机上出现过 53%）。上限再夹到 15%。
    const previousTokens = tokenizer.countTokens(tail);
    const budget = Math.max(1, Math.min(Math.round(previousTokens * overlapRatio), Math.round(maxTokens * 0.15)));
    const backtrack = overlapCharsFor(tail, budget, tokenizer);
    const start = Math.max(previous.start, previous.end - backtrack);
    // 回退后的区间必须仍在上限内；万一超了就整段重切（极端短上限时才会发生）
    const candidate = { start, end: atom.end };
    current = tokenizer.countTokens(content.slice(candidate.start, candidate.end)) <= maxTokens ? candidate : { start: atom.start, end: atom.end };
  }
  flush();
  return chunks;
}
