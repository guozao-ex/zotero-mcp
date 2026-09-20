/**
 * PDF 元数据识别链（G2，M3 change 7）。
 *
 * 按 L1 → L2 → L3 → L4 顺序执行，每一级的结论都写进 `hits`（含跳过原因与失败原因）：
 *   L1 文本层正则（DOI / arXiv / ISBN）—— 附件场景优先复用 Zotero 全文索引，不重复解析 PDF；
 *   L2 PDF `/Info` 与 XMP —— 只用字节窗口扫描，不引入 PDF 解析库；
 *   L3 translation-server 标识符解析 —— 复用既有通道（端点 / 令牌 / 超时 / 脱敏不变）；
 *   L4 标题模糊检索 —— Crossref 与 OpenAlex，按 Jaro-Winkler 打分选出最佳候选。
 *
 * 结果记录按可信度取「L3 > L4 > L2」，四级都拿不到记录才判定 `needsMetadata`。
 * 识别本身**只读**：不写库、不产生审计；入库由调用方经写安全管线完成。
 */

import { open } from 'node:fs/promises';
import { basename } from 'node:path';

import { resolveItemFilePath } from '../channels/local-api.ts';
import { jaroWinkler, normalizeTitle } from './dedupe.ts';
import { readContent } from './read.ts';
import { DEFAULT_CROSSREF_MAILTO, resolveIdentifier } from './write-tools.ts';
import type { ChannelOptions } from './read.ts';
import type { ResolvedRecord } from './write-tools.ts';

export type IdentificationLevel = 'L1' | 'L2' | 'L3' | 'L4';

/** 单级结论：ok 为假时 detail 必须写明原因或跳过理由。 */
export interface IdentificationHit {
  level: IdentificationLevel;
  ok: boolean;
  source: string;
  detail: string;
}

export interface PdfIdentificationResult {
  /** 产出最终记录的层级（L2 / L3 / L4）；四级都没产出记录时为 null。 */
  level: IdentificationLevel | null;
  needsMetadata: boolean;
  identifier: { kind: 'doi' | 'arxiv' | 'isbn'; value: string } | null;
  /** 识别出的条目记录（itemType + fields）；未识别时为 null。 */
  record: ResolvedRecord | null;
  /** 逐级结论（含短路 / 跳过 / 失败原因）。 */
  hits: IdentificationHit[];
  /** 文件名回退标题（识别失败时的降级标题）。 */
  fallbackTitle: string;
  input: { path: string | null; itemKey: string | null; fileName: string; filePath: string | null };
}

/** L4 标题相似度阈值。 */
export const TITLE_MATCH_THRESHOLD = 0.8;
/** L2 扫描窗口：文件头 256 KB。 */
export const HEAD_WINDOW_BYTES = 256 * 1024;
/** L2 扫描窗口：文件尾 64 KB（`/Info` 通常靠近 trailer）。 */
export const TAIL_WINDOW_BYTES = 64 * 1024;
/** 未识别时写入的标签。 */
export const NEEDS_METADATA_TAG = 'needs-metadata';

export interface IdentificationIO {
  /** L1：Zotero 全文索引文本（附件场景）。 */
  fulltext(itemKey: string): Promise<string | null>;
  /** L1/L2：读取文件头尾窗口（binary-safe 的 latin1 文本）。 */
  fileBytes(filePath: string): Promise<string | null>;
  /** 附件 key → 本地文件路径（`/items/<key>/file` 的 302）。 */
  filePathOf(itemKey: string): Promise<string | null>;
  /** L3：标识符解析（返回记录与实际通道）。 */
  resolveIdentifier(identifier: string): Promise<{ records: ResolvedRecord[]; source: string } | null>;
  /** L4：标题检索（返回候选记录与实际通道）。 */
  searchByTitle(title: string): Promise<{ records: ResolvedRecord[]; source: string } | null>;
}

export interface IdentifyPdfOptions extends ChannelOptions {
  /** 本地 PDF 绝对路径。 */
  path?: string;
  /** Zotero 附件 key（可用全文索引）。 */
  itemKey?: string;
  translationServerUrl?: string;
  translationToken?: string;
  /** 覆盖默认 IO（测试注入用）。 */
  io?: Partial<IdentificationIO>;
}

// DOI 合法字符集（近似 doi.org 官方口径）：避免把 PDF 全文里的装饰字符（如 ⟩）吃进标识符
const DOI_PATTERN = /10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+/u;
const ARXIV_PATTERN = /arXiv:\s*(\d{4}\.\d{4,5})(?:v\d+)?/iu;
const ISBN_PATTERN = /\bISBN(?:-1[03])?:?\s*((?:97[89][-\s]?)?\d[-\d\s]{9,16}[\dXx])\b/u;

/** 文件名 → 回退标题：去扩展名，把下划线 / 连字符 / 多余空白转成空格。 */
export function titleFromFileName(fileName: string): string {
  const withoutExt = fileName.replace(/\.pdf$/iu, '');
  const cleaned = withoutExt
    .replaceAll(/_+/gu, ' ')
    .replaceAll(/-+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
  return cleaned.length === 0 ? fileName : cleaned;
}

/** 从文本里抽取最可信的标识符（DOI 优先，其次 arXiv，最后 ISBN）。 */
export function extractIdentifier(text: string): { kind: 'doi' | 'arxiv' | 'isbn'; value: string } | null {
  const doi = DOI_PATTERN.exec(text)?.[0];
  if (doi !== undefined) return { kind: 'doi', value: doi.replace(/[.,;:]+$/u, '') };
  const arxiv = ARXIV_PATTERN.exec(text)?.[1];
  if (arxiv !== undefined) return { kind: 'arxiv', value: arxiv };
  const isbn = ISBN_PATTERN.exec(text)?.[1];
  if (isbn !== undefined) {
    const digits = isbn.replaceAll(/[^0-9Xx]/gu, '');
    if (digits.length >= 10) return { kind: 'isbn', value: digits };
  }
  return null;
}

function firstMatch(text: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text)?.[1];
    if (match !== undefined) {
      const value = match.trim();
      if (value.length > 0) return value;
    }
  }
  return null;
}

function decodePdfHexString(hex: string): string {
  const cleaned = hex.replaceAll(/\s+/gu, '');
  if (cleaned.length < 2) return '';
  const bytes: number[] = [];
  for (let index = 0; index + 1 < cleaned.length; index += 2) {
    bytes.push(Number.parseInt(cleaned.slice(index, index + 2), 16));
  }
  // /Title 常见两种编码：UTF-16BE（带 BOM）与 PDFDocEncoding（近似 latin1）
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      out += String.fromCharCode(((bytes[index] ?? 0) << 8) | (bytes[index + 1] ?? 0));
    }
    return out.trim();
  }
  return Buffer.from(bytes).toString('latin1').trim();
}

/** XMP 里的 `dc:title` / `dc:creator` / `dc:date` / `prism:doi`（兼容元素形式与属性形式）。 */
export function parseXmp(text: string): {
  title: string | null;
  creators: string[];
  date: string | null;
  doi: string | null;
} {
  const title = firstMatch(text, [
    /<dc:title>[\s\S]{0,400}?<rdf:li[^>]*>([^<]{2,300})<\/rdf:li>/iu,
    /dc:title="([^"]{2,300})"/iu,
  ]);
  const creators = [...text.matchAll(/<dc:creator>[\s\S]{0,400}?<rdf:li[^>]*>([^<]{2,200})<\/rdf:li>/giu)].map(
    (match) => match[1]?.trim() ?? '',
  );
  const attributeCreator = /dc:creator="([^"]{2,200})"/iu.exec(text)?.[1];
  if (creators.length === 0 && attributeCreator !== undefined) creators.push(attributeCreator.trim());
  const date = firstMatch(text, [
    /<dc:date>[\s\S]{0,300}?<rdf:li[^>]*>([^<]{2,40})<\/rdf:li>/iu,
    /xmp:CreateDate="([^"]{4,40})"/iu,
    /dc:date="([^"]{4,40})"/iu,
  ]);
  const doi = firstMatch(text, [/prism:doi="([^"]{4,200})"/iu]);
  return { title, creators: creators.filter((entry) => entry.length > 0), date, doi };
}

/** PDF `/Info` 字典里的 `/Title`、`/Author`、`/CreationDate`（未压缩时可直接正则命中）。 */
export function parsePdfInfo(text: string): { title: string | null; author: string | null; date: string | null } {
  const titleLiteral = firstMatch(text, [/\/Title\s*\(([^)]{1,300})\)/u]);
  const titleHex = firstMatch(text, [/\/Title\s*<([0-9A-Fa-f\s]{8,600})>/u]);
  const title = titleLiteral ?? (titleHex === null ? null : decodePdfHexString(titleHex) || null);
  const authorLiteral = firstMatch(text, [/\/Author\s*\(([^)]{1,200})\)/u]);
  const authorHex = firstMatch(text, [/\/Author\s*<([0-9A-Fa-f\s]{8,600})>/u]);
  const author = authorLiteral ?? (authorHex === null ? null : decodePdfHexString(authorHex) || null);
  const date = firstMatch(text, [/\/CreationDate\s*\(D:(\d{4})(\d{2})?(\d{2})?/u]);
  return { title, author, date };
}

/** PDF 日期（`D:20210301` 或 ISO）归一成 Zotero 的 `date`。 */
export function normalizePdfDate(raw: string | null): string | null {
  if (raw === null) return null;
  const compact = /^(\d{4})(\d{2})?(\d{2})?$/u.exec(raw.trim());
  if (compact !== null) {
    const [, year, month, day] = compact;
    return [year, month, day].filter((part) => part !== undefined && part.length > 0).join('-');
  }
  const iso = /^(\d{4}-\d{2}-\d{2})/u.exec(raw.trim());
  return iso === null ? null : (iso[1] ?? null);
}

/** `Last, First` 或 `First Last` → Zotero creators。 */
export function parseCreatorName(raw: string): Record<string, unknown> {
  const value = raw.trim();
  if (value.includes(',')) {
    const [lastName, firstName] = value.split(',', 2);
    return { creatorType: 'author', lastName: (lastName ?? '').trim(), firstName: (firstName ?? '').trim() };
  }
  const parts = value.split(/\s+/u);
  if (parts.length === 1) return { creatorType: 'author', lastName: value };
  return {
    creatorType: 'author',
    lastName: parts[parts.length - 1] ?? value,
    firstName: parts.slice(0, -1).join(' '),
  };
}

/** PDF `/Info` 与 XMP 里常见的「不是标题」的占位值（真机样本里出现过 Abstract）。 */
const JUNK_TITLES = new Set([
  'abstract',
  'untitled',
  'document',
  'document1',
  'main',
  'full text',
  'fulltext',
  'microsoft word',
  'pdf',
  'article',
  'paper',
  'manuscript',
  'no title',
  'title',
]);

/**
 * 判断标题是否可用作元数据或检索词：太短、纯编号、命中占位词表都视为不可用
 * （避免用 "Abstract" 去 Crossref 搜出一堆噪声，也避免把附件 key 当标题去检索）。
 */
export function isUsableTitle(title: string | null | undefined): boolean {
  if (title === null || title === undefined) return false;
  const cleaned = title.trim();
  if (cleaned.length < 6) return false;
  if (JUNK_TITLES.has(cleaned.toLowerCase())) return false;
  if (/^[\d\W_]+$/u.test(cleaned)) return false;
  // 真机样本里出现过「拿附件 key 当标题」的情况：无空格的短串几乎不可能是真实论文标题
  if (!/\s/u.test(cleaned) && cleaned.length < 12) return false;
  return true;
}

/** 把 L2 读到的字段拼成条目记录；有 DOI 时用 journalArticle，否则用 document。 */
export function recordFromPdfMetadata(metadata: {
  title: string | null;
  creators: string[];
  date: string | null;
  doi: string | null;
}): ResolvedRecord | null {
  if (!isUsableTitle(metadata.title)) return null;
  const fields: Record<string, unknown> = { title: (metadata.title as string).trim() };
  if (metadata.creators.length > 0) fields['creators'] = metadata.creators.map((name) => parseCreatorName(name));
  const date = normalizePdfDate(metadata.date);
  if (date !== null) fields['date'] = date;
  if (metadata.doi !== null) fields['DOI'] = metadata.doi.trim();
  return { itemType: metadata.doi === null ? 'document' : 'journalArticle', fields };
}

/** 在候选里挑相似度最高且不低于阈值的一条。 */
export function pickBestByTitle(
  title: string,
  records: ResolvedRecord[],
  threshold = TITLE_MATCH_THRESHOLD,
): { record: ResolvedRecord; score: number } | null {
  const target = normalizeTitle(title);
  if (target.length === 0) return null;
  let best: { record: ResolvedRecord; score: number } | null = null;
  for (const record of records) {
    const candidate = record.fields['title'];
    if (typeof candidate !== 'string' || !isUsableTitle(candidate)) continue;
    const score = jaroWinkler(target, normalizeTitle(candidate));
    if (best === null || score > best.score) best = { record, score };
  }
  return best !== null && best.score >= threshold ? best : null;
}

function defaultIo(options: IdentifyPdfOptions): IdentificationIO {
  const channel: ChannelOptions = {
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs,
  };
  const mailto = process.env['ZOTERO_MCP_CROSSREF_MAILTO'] ?? DEFAULT_CROSSREF_MAILTO;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  return {
    async fulltext(itemKey) {
      try {
        const content = await readContent({ ...channel, key: itemKey, mode: 'fulltext' });
        return content.content ?? null;
      } catch {
        return null;
      }
    },
    async fileBytes(filePath) {
      // 只读文件头 256 KB 与尾 64 KB：大 PDF 不必整份读进内存（识别只需要这两个窗口）
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(filePath, 'r');
        const size = (await handle.stat()).size;
        const headLength = Math.min(HEAD_WINDOW_BYTES, size);
        const headBuffer = Buffer.alloc(headLength);
        await handle.read(headBuffer, 0, headLength, 0);
        const tailStart = Math.max(headLength, size - TAIL_WINDOW_BYTES);
        const tailLength = Math.max(0, size - tailStart);
        const tailBuffer = Buffer.alloc(tailLength);
        if (tailLength > 0) await handle.read(tailBuffer, 0, tailLength, tailStart);
        return `${headBuffer.toString('latin1')}\n${tailBuffer.toString('latin1')}`;
      } catch {
        return null;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
    async filePathOf(itemKey) {
      try {
        const resolved = await resolveItemFilePath({ ...channel, key: itemKey });
        return resolved.path;
      } catch {
        return null;
      }
    },
    async resolveIdentifier(rawIdentifier) {
      try {
        const resolution = await resolveIdentifier({
          identifier: rawIdentifier,
          ...(options.translationServerUrl === undefined
            ? {}
            : { translationServerUrl: options.translationServerUrl }),
          ...(options.translationToken === undefined ? {} : { translationToken: options.translationToken }),
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        return { records: resolution.records, source: resolution.source };
      } catch {
        return null;
      }
    },
    async searchByTitle(title) {
      const candidates: ResolvedRecord[] = [];
      const sources: string[] = [];
      try {
        const response = await fetchImpl(
          `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(title)}&rows=5&mailto=${encodeURIComponent(mailto)}`,
          { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) },
        );
        if (response.ok) {
          const body = (await response.json()) as { message?: { items?: unknown[] } };
          const items = body.message?.items ?? [];
          for (const item of items) {
            const message = (item ?? {}) as Record<string, unknown>;
            const recordTitle = Array.isArray(message['title']) ? message['title'][0] : message['title'];
            if (typeof recordTitle !== 'string' || recordTitle.length === 0) continue;
            candidates.push({
              itemType: 'journalArticle',
              fields: {
                title: recordTitle,
                ...(typeof message['DOI'] === 'string' ? { DOI: message['DOI'] } : {}),
                ...(Array.isArray(message['container-title']) && typeof message['container-title'][0] === 'string'
                  ? { publicationTitle: message['container-title'][0] }
                  : {}),
              },
            });
          }
          if (items.length > 0) sources.push('crossref');
        }
      } catch {
        // 单源失败不影响另一源
      }
      try {
        const response = await fetchImpl(
          `https://api.openalex.org/works?search=${encodeURIComponent(title)}&per-page=5&mailto=${encodeURIComponent(mailto)}`,
          { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) },
        );
        if (response.ok) {
          const body = (await response.json()) as { results?: unknown[] };
          const results = body.results ?? [];
          for (const item of results) {
            const work = (item ?? {}) as Record<string, unknown>;
            const recordTitle = work['display_name'];
            if (typeof recordTitle !== 'string' || recordTitle.length === 0) continue;
            candidates.push({
              itemType: 'journalArticle',
              fields: {
                title: recordTitle,
                ...(typeof work['doi'] === 'string'
                  ? { DOI: String(work['doi']).replace(/^https?:\/\/doi\.org\//iu, '') }
                  : {}),
              },
            });
          }
          if (results.length > 0) sources.push('openalex');
        }
      } catch {
        // 同上
      }
      if (candidates.length === 0) return null;
      return { records: candidates, source: sources.join('+') };
    },
  };
}

function hit(level: IdentificationLevel, ok: boolean, source: string, detail: string): IdentificationHit {
  return { level, ok, source, detail };
}

/** 执行四级识别链。 */
export async function identifyPdf(options: IdentifyPdfOptions): Promise<PdfIdentificationResult> {
  const io: IdentificationIO = { ...defaultIo(options), ...(options.io ?? {}) };
  const path = options.path?.trim();
  const itemKey = options.itemKey?.trim();
  const hasPath = path !== undefined && path.length > 0;
  const hasItemKey = itemKey !== undefined && itemKey.length > 0;
  if (!hasPath && !hasItemKey) throw new Error('识别必须提供 path 或 itemKey');
  const fileName = hasPath ? basename(path as string) : `${itemKey ?? 'attachment'}.pdf`;
  const fallbackTitle = titleFromFileName(fileName);
  const hits: IdentificationHit[] = [];

  const filePath = hasPath ? (path as string) : (itemKey === undefined ? null : await io.filePathOf(itemKey));

  // ── L1 文本层正则 ─────────────────────────────────────────────────────
  let text: string | null = null;
  let textSource = 'no-text';
  if (hasItemKey) {
    text = await io.fulltext(itemKey as string);
    textSource = 'zotero-fulltext';
  }
  if ((text === null || text.length === 0) && filePath !== null) {
    text = await io.fileBytes(filePath);
    textSource = 'file-bytes';
  }
  let identifier = text === null ? null : extractIdentifier(text);
  if (identifier !== null) {
    hits.push(hit('L1', true, textSource, `匹配到 ${identifier.kind}=${identifier.value}`));
  } else {
    hits.push(
      hit(
        'L1',
        false,
        filePath === null && text === null ? 'no-text' : textSource,
        text === null || text.length === 0 ? '拿不到文本层（既无全文索引也没有可读文件）' : '文本层里没有 DOI / arXiv / ISBN',
      ),
    );
  }

  // ── L2 /Info 与 XMP ───────────────────────────────────────────────────
  let l2Record: ResolvedRecord | null = null;
  if (filePath === null) {
    hits.push(hit('L2', false, 'no-file', '没有可读的本地文件路径'));
  } else {
    const bytes = await io.fileBytes(filePath);
    if (bytes === null) {
      hits.push(hit('L2', false, 'no-file', `文件不可读：${filePath}`));
    } else {
      const xmp = parseXmp(bytes);
      const info = parsePdfInfo(bytes);
      const metadata = {
        title: xmp.title ?? info.title,
        creators: xmp.creators.length > 0 ? xmp.creators : info.author === null ? [] : [info.author],
        date: xmp.date ?? info.date,
        doi: xmp.doi,
      };
      const source = xmp.title !== null || xmp.creators.length > 0 ? 'xmp' : info.title !== null ? 'pdf-info' : 'none';
      l2Record = recordFromPdfMetadata(metadata);
      if (l2Record === null) {
        hits.push(hit('L2', false, source, 'XMP 与 /Info 里都没有可用标题'));
      } else {
        hits.push(
          hit(
            'L2',
            true,
            source,
            `标题「${String(l2Record.fields['title'])}」${metadata.creators.length > 0 ? `，作者 ${metadata.creators.join(' / ')}` : ''}${metadata.doi === null ? '' : `，DOI ${metadata.doi}`}`,
          ),
        );
        if (identifier === null && metadata.doi !== null) identifier = { kind: 'doi', value: metadata.doi };
      }
    }
  }

  // ── L3 标识符解析 ─────────────────────────────────────────────────────
  let record: ResolvedRecord | null = null;
  let level: IdentificationLevel | null = null;
  if (identifier === null) {
    hits.push(hit('L3', false, 'skipped', '没有可解析的标识符（L1 未命中，L2 也没有 DOI）'));
  } else {
    const resolved = await io.resolveIdentifier(
      identifier.kind === 'arxiv' ? `arXiv:${identifier.value}` : identifier.value,
    );
    if (resolved !== null && resolved.records.length > 0) {
      record = resolved.records[0] ?? null;
      level = 'L3';
      hits.push(
        hit('L3', true, resolved.source, `按 ${identifier.kind}=${identifier.value} 解析出 ${record?.itemType ?? '未知类型'}`),
      );
    } else {
      hits.push(hit('L3', false, 'unresolved', `标识符 ${identifier.kind}=${identifier.value} 未能解析出条目`));
    }
  }

  // ── L4 标题模糊检索（可用 ZOTERO_MCP_TITLE_SEARCH=off 关闭外呼） ──────
  const l2TitleForSearch = typeof l2Record?.fields['title'] === 'string' ? (l2Record.fields['title'] as string) : null;
  const queryTitleForSearch = isUsableTitle(l2TitleForSearch) ? (l2TitleForSearch as string) : fallbackTitle;
  const titleSearchEnabled = (process.env['ZOTERO_MCP_TITLE_SEARCH'] ?? 'on').trim().toLowerCase() !== 'off';
  if (record === null && !titleSearchEnabled) {
    hits.push(hit('L4', false, 'disabled', '标题检索已按 ZOTERO_MCP_TITLE_SEARCH=off 关闭'));
  } else if (record === null && !isUsableTitle(queryTitleForSearch)) {
    hits.push(hit('L4', false, 'unusable-title', `标题「${queryTitleForSearch}」太短或属于占位值，跳过外呼检索`));
  } else if (record === null) {
    const searched = await io.searchByTitle(queryTitleForSearch);
    if (searched === null) {
      hits.push(hit('L4', false, 'no-candidates', `按标题「${queryTitleForSearch}」在 Crossref / OpenAlex 都没有候选`));
    } else {
      const best = pickBestByTitle(queryTitleForSearch, searched.records);
      if (best === null) {
        hits.push(hit('L4', false, searched.source, `候选相似度都低于 ${TITLE_MATCH_THRESHOLD}`));
      } else {
        record = best.record;
        level = 'L4';
        hits.push(
          hit('L4', true, searched.source, `最佳候选相似度 ${best.score.toFixed(3)}：${String(best.record.fields['title'])}`),
        );
      }
    }
  } else {
    hits.push(hit('L4', false, 'skipped', 'L3 已产出记录，短路跳过'));
  }

  // 结果记录：L3 / L4 优先，其次 L2 自报元数据
  if (record === null && l2Record !== null) {
    record = l2Record;
    level = 'L2';
  }

  return {
    level,
    needsMetadata: record === null,
    identifier,
    record,
    hits,
    fallbackTitle,
    input: { path: hasPath ? (path as string) : null, itemKey: hasItemKey ? (itemKey as string) : null, fileName, filePath },
  };
}

/** 识别成功时用于入库的字段（未识别时返回 null，由调用方走降级计划）。 */
export function identifiedFields(
  identification: PdfIdentificationResult,
): { itemType: string; fields: Record<string, unknown> } | null {
  if (identification.record === null || identification.needsMetadata) return null;
  return { itemType: identification.record.itemType, fields: { ...identification.record.fields } };
}
