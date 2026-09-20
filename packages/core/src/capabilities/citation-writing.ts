/**
 * 引用写作集成（M6）：把 Zotero 引用以 Word 域代码写进 `.docx`。
 *
 * 域代码形态取自 Zotero 自身实现：
 * - 引用：` ADDIN ZOTERO_ITEM CSL_CITATION <csl-citation JSON> `
 * - 参考文献块：` ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY `
 *
 * 引用数据全部来自本地 API（`format=csljson` 与官方格式化输出），本模块只发 GET，
 * 不写文库；写入目标只有调用方指定的 `.docx`。
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { requestLocalApi, requestLocalText } from '../channels/local-api.ts';
import { exportItems } from './citations.ts';
import { decodeXmlEntities } from './enrichment.ts';
import { LIBRARY_PREFIX, mapWithConcurrency } from './read.ts';
import type { ChannelOptions } from './read.ts';
import { DOCUMENT_PART, buildMinimalDocx, escapeXmlText, readZip, replaceEntry, writeZip } from './docx-zip.ts';
import type { ZipArchive } from './docx-zip.ts';

export const DEFAULT_CITATION_STYLE = 'chicago-shortened-notes-bibliography';
export const DEFAULT_CITATION_LOCALE = 'en-US';
export const CITATION_SCHEMA_URL =
  'https://github.com/citation-style-language/schema/raw/master/csl-citation.json';
/** 参考文献块占位符的保留名字：`{{zotero:bibliography}}`。 */
export const BIBLIOGRAPHY_PLACEHOLDER = 'bibliography';
/** 引用 URI 的库段：本地 API 的「当前用户」别名，Refresh 时 Zotero 会规范化回写。 */
export const URI_USER_SEGMENT = '0';

const PLACEHOLDER_PATTERN = /\{\{zotero:([^{}]*)\}\}/gu;

export interface CitationMappingEntry {
  keys: string[];
  locator?: string;
  label?: string;
  prefix?: string;
  suffix?: string;
  suppressAuthor?: boolean;
}

export type CitationMappingValue = string | string[] | CitationMappingEntry;
export type CitationMappingInput = Record<string, CitationMappingValue>;

/** 把外部 `mapping` 归一化为「占位符名 → 引用条目」。 */
export function normalizeMapping(input: CitationMappingInput | undefined): Map<string, CitationMappingEntry> {
  const out = new Map<string, CitationMappingEntry>();
  if (input === undefined || input === null) return out;
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'string' || Array.isArray(value)) {
      const keys = (Array.isArray(value) ? value : [value]).map((key) => String(key).trim()).filter((key) => key.length > 0);
      out.set(name, { keys });
      continue;
    }
    const keys = (value.keys ?? []).map((key) => String(key).trim()).filter((key) => key.length > 0);
    const entry: CitationMappingEntry = { keys };
    if (typeof value.locator === 'string') entry.locator = value.locator;
    if (typeof value.label === 'string') entry.label = value.label;
    if (typeof value.prefix === 'string') entry.prefix = value.prefix;
    if (typeof value.suffix === 'string') entry.suffix = value.suffix;
    if (value.suppressAuthor === true) entry.suppressAuthor = true;
    out.set(name, entry);
  }
  return out;
}

/** 占位符名解析：含逗号按内联 key 列表；否则先查 `mapping`，未命中再当单个 key。 */
export function resolvePlaceholder(
  name: string,
  mapping: Map<string, CitationMappingEntry>,
): { entry: CitationMappingEntry; source: 'mapping' | 'inline' } | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes(',')) {
    const keys = trimmed.split(',').map((key) => key.trim()).filter((key) => key.length > 0);
    return keys.length === 0 ? null : { entry: { keys }, source: 'inline' };
  }
  const mapped = mapping.get(trimmed);
  if (mapped !== undefined) {
    return mapped.keys.length === 0 ? null : { entry: mapped, source: 'mapping' };
  }
  return { entry: { keys: [trimmed] }, source: 'inline' };
}

// ---------------------------------------------------------------- 文本 run 扫描

interface TextRun {
  /** 段落内该 run 的原始 XML（未改动时逐字保留）。 */
  raw: string;
  /** `<w:rPr>…</w:rPr>` 子串，重建 run 时复用。 */
  rPr: string;
  /** run 的可见文本（各 `<w:t>` 内容拼接）。 */
  text: string;
  /** run 内是否含 `<w:t>` / `<w:rPr>` 之外的内容（图片、换行等）。 */
  hasOtherContent: boolean;
}

const RUN_TOKEN = /<w:r(?=[ >/])|<\/w:r>/gu;

/** 解析一个段落 XML 里的 run 列表（按文档顺序）。 */
export function scanParagraphRuns(paragraphXml: string): TextRun[] {
  const runs: TextRun[] = [];
  const starts: number[] = [];
  RUN_TOKEN.lastIndex = 0;
  let token: RegExpExecArray | null;
  while ((token = RUN_TOKEN.exec(paragraphXml)) !== null) {
    if (token[0] === '</w:r>') {
      const start = starts.pop();
      if (start === undefined) continue;
      if (starts.length > 0) continue; // 嵌套（如 w:ruby）：只按最外层 run 记录
      runs.push(buildRun(paragraphXml.slice(start, token.index + 6)));
      continue;
    }
    // 自闭合的 <w:r/> 不含文本，直接记一个空 run，避免它把后续 run 误判成嵌套
    const tagEnd = paragraphXml.indexOf('>', token.index);
    if (tagEnd > 0 && paragraphXml[tagEnd - 1] === '/') {
      runs.push({ raw: paragraphXml.slice(token.index, tagEnd + 1), rPr: '', text: '', hasOtherContent: false });
      RUN_TOKEN.lastIndex = tagEnd + 1;
      continue;
    }
    starts.push(token.index);
  }
  return runs;
}

function buildRun(raw: string): TextRun {
  let rPr = '';
  const rPrStart = raw.indexOf('<w:rPr>');
  if (rPrStart >= 0) {
    const rPrEnd = raw.indexOf('</w:rPr>', rPrStart);
    if (rPrEnd >= 0) rPr = raw.slice(rPrStart, rPrEnd + 8);
  }
  const textParts: string[] = [];
  const textPattern = /<w:t(?=[ >/])[^>]*>([\s\S]*?)<\/w:t>/gu;
  let match: RegExpExecArray | null;
  while ((match = textPattern.exec(raw)) !== null) textParts.push(match[1] ?? '');
  const skeleton = raw
    .replace(/<w:rPr>[\s\S]*?<\/w:rPr>/u, '')
    .replace(/<w:t(?=[ >/])[^>]*>[\s\S]*?<\/w:t>/gu, '')
    .replace(/^<w:r(?=[ >/])[^>]*>/u, '')
    .replace(/<\/w:r>$/u, '');
  return { raw, rPr, text: textParts.join(''), hasOtherContent: skeleton.trim().length > 0 };
}

/** 一个段落里所有占位符的命中位置（相对该段落的纯文本）。 */
export interface PlaceholderHit {
  paragraph: number;
  offset: number;
  name: string;
  raw: string;
}

/** 定位 `<w:p>` 段落的字节区间（表格内的段落同样计入；段落不嵌套）。 */
function paragraphSpans(xml: string): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  const open = /<w:p(?=[ >/])/gu;
  let match: RegExpExecArray | null;
  while ((match = open.exec(xml)) !== null) {
    const tagEnd = xml.indexOf('>', match.index);
    if (tagEnd < 0) break;
    if (xml[tagEnd - 1] === '/') {
      spans.push({ start: match.index, end: tagEnd + 1 });
      open.lastIndex = tagEnd + 1;
      continue;
    }
    const close = xml.indexOf('</w:p>', tagEnd);
    if (close < 0) break;
    spans.push({ start: match.index, end: close + 6 });
    open.lastIndex = close + 6;
  }
  return spans;
}

/** 扫描整份 `document.xml`，按段落顺序返回全部占位符命中。 */
export function findPlaceholders(documentXml: string): PlaceholderHit[] {
  const hits: PlaceholderHit[] = [];
  paragraphSpans(documentXml).forEach((span, paragraph) => {
    const xml = documentXml.slice(span.start, span.end);
    const plain = scanParagraphRuns(xml).map((run) => run.text).join('');
    PLACEHOLDER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PLACEHOLDER_PATTERN.exec(plain)) !== null) {
      hits.push({ paragraph, offset: match.index, name: match[1] ?? '', raw: match[0] });
    }
  });
  return hits;
}

// ---------------------------------------------------------------- 域代码

function fieldRuns(code: string, resultText: string): string {
  const lines = resultText.split(/\r?\n/u);
  const resultRuns = lines
    .map((line, index) =>
      index === lines.length - 1
        ? `<w:r><w:t xml:space="preserve">${escapeXmlText(line)}</w:t></w:r>`
        : `<w:r><w:t xml:space="preserve">${escapeXmlText(line)}</w:t><w:br/></w:r>`,
    )
    .join('');
  return (
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    `<w:r><w:instrText xml:space="preserve">${escapeXmlText(code)}</w:instrText></w:r>` +
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
    resultRuns +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
  );
}

/** 构造一条引用域代码（` ADDIN ZOTERO_ITEM CSL_CITATION <json> `）。 */
export function buildCitationCode(options: {
  citationId: string;
  items: { key: string; itemData: unknown; entry?: CitationMappingEntry }[];
  formattedCitation: string;
}): string {
  const citationItems = options.items.map((item) => {
    const payload: Record<string, unknown> = {
      id: item.key,
      uris: [citationUri(item.key)],
      itemData: item.itemData,
    };
    const entry = item.entry;
    if (entry?.locator !== undefined) payload['locator'] = entry.locator;
    if (entry?.label !== undefined) payload['label'] = entry.label;
    if (entry?.prefix !== undefined) payload['prefix'] = entry.prefix;
    if (entry?.suffix !== undefined) payload['suffix'] = entry.suffix;
    if (entry?.suppressAuthor === true) payload['suppress-author'] = true;
    return payload;
  });
  const citation = {
    citationID: options.citationId,
    properties: {
      formattedCitation: options.formattedCitation,
      plainCitation: options.formattedCitation,
      noteIndex: 0,
    },
    citationItems,
    schema: CITATION_SCHEMA_URL,
  };
  return ` ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify(citation)} `;
}

/** 构造参考文献块域代码（` ADDIN ZOTERO_BIBL <json> CSL_BIBLIOGRAPHY `）。 */
export function buildBibliographyCode(): string {
  return ` ADDIN ZOTERO_BIBL ${JSON.stringify({ uncited: [], omitted: [], custom: [] })} CSL_BIBLIOGRAPHY `;
}

/** 条目的 Zotero URI（本地 API 的当前用户别名口径）。 */
export function citationUri(key: string): string {
  return `http://zotero.org/users/${URI_USER_SEGMENT}/items/${key}`;
}

/** 引用域结果文本：本地 API 的逐条格式化结果合并为一条组引用文本。 */
export function joinCitationTexts(texts: string[]): string {
  const cleaned = texts
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => text.replace(/^\((.*)\)$/u, '$1').trim());
  if (cleaned.length === 0) return '';
  if (cleaned.length === 1) return `(${cleaned[0]})`;
  return `(${cleaned.join('; ')})`;
}

/**
 * 数字字符引用解码（`&#38;` / `&#x26;`）。
 *
 * 真机的 citeproc HTML 输出会把 `&` 写成 `&#38;`，只解 `&amp;` 会把它原样漏进域结果文本。
 * 必须在命名实体之前解：`&amp;#38;` 的正确语义是字面量 `&#38;`，先解数字引用不会碰它。
 */
function decodeNumericEntities(value: string): string {
  return value.replace(/&#(x[0-9a-fA-F]+|[0-9]+);/gu, (whole, code: string) => {
    const numeric = code.startsWith('x') || code.startsWith('X') ? Number.parseInt(code.slice(1), 16) : Number.parseInt(code, 10);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 0x10ffff) return whole;
    try {
      return String.fromCodePoint(numeric);
    } catch {
      return whole;
    }
  });
}

/** 把本地 API 的 HTML 输出转成可见纯文本。 */
export function htmlToPlainText(html: string): string {
  return decodeXmlEntities(
    decodeNumericEntities(
      html
        .replace(/<[^>]*>/gu, '')
        .replace(/\s+/gu, ' '),
    ),
  ).trim();
}

// ---------------------------------------------------------------- 注入

export interface InjectionField {
  /** 落进域代码的完整文本（含前后空格）。 */
  code: string;
  /** 域的可见结果文本。 */
  resultText: string;
}

export interface InjectionRequest {
  /** 占位符名 → 域内容；名 `bibliography` 走参考文献块，其余为引用。 */
  fields: Map<string, InjectionField>;
  /** 文档中没有 `bibliography` 占位符时，把参考文献块追加到文末。 */
  bibliography?: InjectionField;
}

export interface InjectionOutcome {
  xml: string;
  /** 每个被替换的占位符：段落序号、段内字符偏移、名字。 */
  applied: { name: string; paragraph: number; offset: number }[];
  /** 无法安全替换的占位符与原因（非空时调用方必须拒绝写入）。 */
  errors: { name: string; reason: string }[];
  bibliographyApplied: 'placeholder' | 'appended' | 'none';
}

/**
 * 把占位符替换成 Word 域结构。
 *
 * 只重建「与占位符相交」的 run；其余 run 逐字保留，段落之间的内容（含 `<w:tbl>` 等
 * 包裹标签）原样保留。占位符必须完整落在同一段落内，且跨越的 run 不能含图片 / 换行等
 * 非文本内容，否则如实报错而不是猜位置。
 */
export function injectFields(documentXml: string, request: InjectionRequest): InjectionOutcome {
  const spans = paragraphSpans(documentXml);
  const applied: { name: string; paragraph: number; offset: number }[] = [];
  const errors: { name: string; reason: string }[] = [];
  let bibliographyApplied: 'placeholder' | 'appended' | 'none' =
    request.bibliography === undefined ? 'none' : 'none';
  const pieces: string[] = [];
  let cursor = 0;

  spans.forEach((span, paragraph) => {
    // 段落之间的内容（含 <w:tbl> 等包裹标签）必须原样保留
    if (span.start > cursor) pieces.push(documentXml.slice(cursor, span.start));
    const xml = documentXml.slice(span.start, span.end);
    const runs = scanParagraphRuns(xml);
    const plain = runs.map((run) => run.text).join('');

    interface Interval {
      start: number;
      end: number;
      name: string;
      field: InjectionField;
      kind: 'citation' | 'bibliography';
    }
    const intervals: Interval[] = [];
    PLACEHOLDER_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PLACEHOLDER_PATTERN.exec(plain)) !== null) {
      const raw = match[0];
      const name = (match[1] ?? '').trim();
      const isBibliography = name === BIBLIOGRAPHY_PLACEHOLDER;
      const field = isBibliography ? request.bibliography : request.fields.get(name);
      if (field === undefined) {
        errors.push({ name, reason: '文档中出现了未提供内容的占位符' });
        continue;
      }
      intervals.push({
        start: match.index,
        end: match.index + raw.length,
        name: isBibliography ? BIBLIOGRAPHY_PLACEHOLDER : name,
        field,
        kind: isBibliography ? 'bibliography' : 'citation',
      });
    }

    if (intervals.length === 0) {
      pieces.push(xml);
      cursor = span.end;
      return;
    }

    // run 的字符区间（相对段落纯文本）
    const runRanges: { start: number; end: number; run: TextRun }[] = [];
    let offset = 0;
    for (const run of runs) {
      runRanges.push({ start: offset, end: offset + run.text.length, run });
      offset += run.text.length;
    }

    const rebuilt = runRanges.map((range) => {
      const overlapping = intervals.filter((interval) => interval.start < range.end && interval.end > range.start);
      if (overlapping.length === 0) return range.run.raw;
      if (range.run.hasOtherContent) {
        errors.push({
          name: overlapping[0]?.name ?? '',
          reason: '占位符所在的 run 含非文本内容（图片 / 换行等），无法安全替换',
        });
        return range.run.raw;
      }
      const localIntervals = overlapping
        .map((interval) => ({
          start: Math.max(interval.start, range.start) - range.start,
          end: Math.min(interval.end, range.end) - range.start,
          interval,
        }))
        .sort((left, right) => left.start - right.start);

      let out = '';
      let position = 0;
      for (const local of localIntervals) {
        if (local.start > position) out += textRun(range.run.rPr, range.run.text.slice(position, local.start));
        // 域代码插在「占位符开始」的那个 run 的位置上
        if (local.interval.start >= range.start && local.interval.start < range.end) {
          out += fieldRuns(local.interval.field.code, local.interval.field.resultText);
          applied.push({ name: local.interval.name, paragraph, offset: local.interval.start });
          if (local.interval.kind === 'bibliography') bibliographyApplied = 'placeholder';
        }
        position = Math.max(position, local.end);
      }
      if (position < range.run.text.length) out += textRun(range.run.rPr, range.run.text.slice(position));
      return out;
    });

    const firstRun = runs[0];
    const headEnd = firstRun === undefined ? 0 : xml.indexOf(firstRun.raw);
    pieces.push(xml.slice(0, headEnd));
    pieces.push(rebuilt.join(''));
    const lastRun = runs[runs.length - 1];
    const tailStart = lastRun === undefined ? xml.length : xml.lastIndexOf(lastRun.raw) + lastRun.raw.length;
    pieces.push(xml.slice(tailStart));
    cursor = span.end;
  });

  pieces.push(documentXml.slice(cursor));
  let xml = pieces.join('');

  if (request.bibliography !== undefined && bibliographyApplied === 'none') {
    const insertion = fieldRuns(request.bibliography.code, request.bibliography.resultText);
    const sectPr = xml.lastIndexOf('<w:sectPr');
    const bodyEnd = xml.lastIndexOf('</w:body>');
    const at = sectPr >= 0 && bodyEnd >= 0 && sectPr < bodyEnd ? sectPr : bodyEnd;
    if (at < 0) {
      errors.push({ name: BIBLIOGRAPHY_PLACEHOLDER, reason: '文档缺少 w:body，无法追加参考文献块' });
    } else {
      xml = `${xml.slice(0, at)}<w:p>${insertion}</w:p>${xml.slice(at)}`;
      bibliographyApplied = 'appended';
    }
  }

  return { xml, applied, errors, bibliographyApplied };
}

function textRun(rPr: string, text: string): string {
  if (text.length === 0) return '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${escapeXmlText(text)}</w:t></w:r>`;
}

// ---------------------------------------------------------------- 引用数据

interface ItemCitationData {
  key: string;
  itemData: unknown;
  citationText: string;
  bibText: string;
}

function channelOf(options: ChannelOptions): ChannelOptions {
  const channel: ChannelOptions = {};
  if (options.baseUrl !== undefined) channel.baseUrl = options.baseUrl;
  if (options.fetchImpl !== undefined) channel.fetchImpl = options.fetchImpl;
  if (options.timeoutMs !== undefined) channel.timeoutMs = options.timeoutMs;
  return channel;
}

/** 逐条取回 CSL JSON、内文引用文本与参考文献条目文本（全部只读）。 */
export async function fetchCitationData(
  keys: string[],
  options: ChannelOptions & { style?: string; locale?: string } = {},
): Promise<Map<string, ItemCitationData>> {
  const style = options.style ?? DEFAULT_CITATION_STYLE;
  const locale = options.locale ?? DEFAULT_CITATION_LOCALE;
  const channel = channelOf(options);
  const params = new URLSearchParams({ style, locale });
  const unique = [...new Set(keys)];
  const results = await mapWithConcurrency(unique, 5, async (key): Promise<ItemCitationData> => {
    const csl = await requestLocalApi({
      ...channel,
      path: `${LIBRARY_PREFIX}/items/${key}?format=csljson`,
    });
    const itemData = Array.isArray(csl.body) ? (csl.body as unknown[])[0] ?? null : csl.body;
    let citationText = '';
    try {
      const includeResponse = await requestLocalApi({
        ...channel,
        path: `${LIBRARY_PREFIX}/items/${key}?include=citation&${params.toString()}`,
      });
      const body = includeResponse.body as Record<string, unknown> | null;
      if (body !== null && typeof body === 'object' && typeof body['citation'] === 'string') {
        citationText = htmlToPlainText(body['citation']);
      }
    } catch {
      citationText = '';
    }
    const bib = await requestLocalText({
      ...channel,
      path: `${LIBRARY_PREFIX}/items/${key}?format=bib&${params.toString()}`,
    });
    const bibText = htmlToPlainText(bib.body);
    const trimmedBib = bibText.replace(/^\(?[\d]+\.\s*/u, '').trim();
    return {
      key,
      itemData,
      citationText: citationText.length > 0 ? citationText : trimmedBib,
      bibText: trimmedBib.length > 0 ? trimmedBib : bibText,
    };
  });
  return new Map(results.map((result) => [result.key, result]));
}

// ---------------------------------------------------------------- 环境探测

/** 本机 Word 是否可用（注入本身不需要 Word，但没有 Word 就无法 Refresh）。 */
export function detectWord(): { available: boolean; path: string | null } {
  const candidates = [
    process.env['ProgramFiles'] === undefined
      ? 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE'
      : join(process.env['ProgramFiles'], 'Microsoft Office', 'root', 'Office16', 'WINWORD.EXE'),
    'C:\\Program Files (x86)\\Microsoft Office\\root\\Office16\\WINWORD.EXE',
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { available: true, path: candidate };
  }
  const fromPath = lookupOnPath('WINWORD.EXE');
  return fromPath === null ? { available: false, path: null } : { available: true, path: fromPath };
}

function lookupOnPath(executable: string): string | null {
  const pathValue = process.env['PATH'] ?? '';
  for (const dir of pathValue.split(delimiter)) {
    if (dir.trim().length === 0) continue;
    const candidate = join(dir, executable);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export interface LatexEnvironment {
  available: boolean;
  binDir: string | null;
  latexmk: string | null;
  reason: string | null;
}

/**
 * 解析 MiKTeX 目录：`ZOTERO_MCP_LATEX_BIN`（显式覆盖）→ PATH → 已知安装目录。
 * 找不到时如实报告不可用，绝不把未执行的编译当作通过。
 */
export function resolveLatex(options: { override?: string } = {}): LatexEnvironment {
  const override = options.override ?? process.env['ZOTERO_MCP_LATEX_BIN'];
  const candidates: string[] = [];
  if (override !== undefined && override.trim().length > 0) candidates.push(override.trim());
  const fromPath = lookupOnPath('latexmk.exe') ?? lookupOnPath('latexmk');
  if (fromPath !== null) candidates.push(dirname(fromPath));
  const localAppData = process.env['LOCALAPPDATA'];
  if (localAppData !== undefined) {
    candidates.push(join(localAppData, 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'));
  }
  candidates.push('C:\\Program Files\\MiKTeX\\miktex\\bin\\x64');
  candidates.push(join(homedir(), 'AppData', 'Local', 'Programs', 'MiKTeX', 'miktex', 'bin', 'x64'));

  for (const dir of candidates) {
    const exe = join(dir, 'latexmk.exe');
    if (existsSync(exe)) return { available: true, binDir: dir, latexmk: exe, reason: null };
  }
  return {
    available: false,
    binDir: null,
    latexmk: null,
    reason: '找不到 MiKTeX 的 latexmk（可用 ZOTERO_MCP_LATEX_BIN 显式指定 bin 目录）',
  };
}

export interface BibCompileResult {
  compiled: boolean;
  latexAvailable: boolean;
  latexmk: string | null;
  command: string | null;
  exitCode: number | null;
  pdfPath: string | null;
  bblPath: string | null;
  undefinedCitations: string[];
  /** MiKTeX 等外部工具链的联网类失败（环境前提），非编译路径缺陷；无则为 null。 */
  environmentIssue: string | null;
  reason: string | null;
  stdoutTail: string;
}

/** 用一份最小 LaTeX 文档真编译导出的 `.bib`（证据形态：PDF + `.bbl` + 零 undefined）。 */
export function compileBibSample(options: {
  bibPath: string;
  keys: string[];
  workDir: string;
  timeoutMs?: number;
}): BibCompileResult {
  const latex = resolveLatex();
  if (!latex.available || latex.latexmk === null || latex.binDir === null) {
    return {
      compiled: false,
      latexAvailable: false,
      latexmk: null,
      command: null,
      exitCode: null,
      pdfPath: null,
      bblPath: null,
      undefinedCitations: [],
      environmentIssue: null,
      reason: latex.reason,
      stdoutTail: '',
    };
  }
  mkdirSync(options.workDir, { recursive: true });
  const mainPath = join(options.workDir, 'main.tex');
  const tex = [
    '\\documentclass{article}',
    '\\begin{document}',
    `See ${options.keys.map((key) => `\\cite{${key}}`).join(' and ')}.`,
    '\\bibliographystyle{plain}',
    '\\bibliography{refs}',
    '\\end{document}',
    '',
  ].join('\n');
  writeFileSync(mainPath, tex, 'utf8');
  // 用与 .bib 同目录的副本编译，避免 latexmk 的 outdir 语义差异
  const localBib = join(options.workDir, 'refs.bib');
  writeFileSync(localBib, readFileSync(options.bibPath));

  // 注意：这里**不**传 MiKTeX 的 `--disable-installer`。实测（本机 MiKTeX，更新检查未完成的状态下）
  // 禁用安装器会让 pdflatex 直接以 `FATAL … not checked for MiKTeX updates` 退出 1——与断网时看到的
  // 是同一种失败。加参数只会换个方式踩同一个坑；失败原因交给 detectLatexEnvironmentIssue 如实识别。
  const result = spawnSync(latex.latexmk, ['-pdf', '-interaction=nonstopmode', 'main.tex'], {
    cwd: options.workDir,
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 180000,
    env: { ...process.env, PATH: `${latex.binDir}${delimiter}${process.env['PATH'] ?? ''}` },
  });
  const stdout = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const pdfPath = join(options.workDir, 'main.pdf');
  const bblPath = join(options.workDir, 'main.bbl');
  const logPath = join(options.workDir, 'main.log');
  const undefinedCitations: string[] = [];
  if (existsSync(logPath)) {
    for (const line of readFileSync(logPath, 'utf8').split(/\r?\n/u)) {
      if (/undefined/iu.test(line)) undefinedCitations.push(line.trim());
    }
  }
  const compiled = (result.status ?? 1) === 0 && existsSync(pdfPath) && existsSync(bblPath) && undefinedCitations.length === 0;
  const environmentIssue = compiled ? null : detectLatexEnvironmentIssue(stdout);
  return {
    compiled,
    latexAvailable: true,
    latexmk: latex.latexmk,
    command: 'latexmk -pdf -interaction=nonstopmode main.tex',
    exitCode: result.status,
    pdfPath: existsSync(pdfPath) ? pdfPath : null,
    bblPath: existsSync(bblPath) ? bblPath : null,
    undefinedCitations,
    environmentIssue,
    reason: compiled
      ? null
      : environmentIssue ?? `latexmk 退出码 ${result.status ?? 'null'}；未定义引用 ${undefinedCitations.length} 处`,
    stdoutTail: stdout.slice(-1500),
  };
}

/**
 * 判断这次编译失败是不是 **MiKTeX 自身的联网行为**造成的（环境前提，不是本项目的编译路径缺陷）。
 *
 * 实测背景（V1 物理断网）：MiKTeX 在未完成更新检查时会主动访问 `api2.miktex.org`；断网时它以
 * `FATAL … not checked for MiKTeX updates` 结束，`pdflatex` 退出码 1、`latexmk` 随之退出码 1。
 * 这类失败必须被**如实识别并写明前提**，而不是含糊地报一句「latexmk 退出码 1」。
 */
export function detectLatexEnvironmentIssue(output: string): string | null {
  const text = output ?? '';
  if (/not checked for MiKTeX updates/iu.test(text)) {
    return 'MiKTeX 自身的更新检查在断网时会以 FATAL 退出（exit 1）：这是 MiKTeX 的环境前提，不是本项目的编译路径缺陷。请在联网时完成一次 MiKTeX Console → Updates 检查（或管理员模式执行 `miktex --admin packages check-update`）后重试离线编译。';
  }
  if (/api2\.miktex\.org|going to download/iu.test(text)) {
    return 'MiKTeX 尝试联网获取宏包仓库清单（api2.miktex.org）但不可达：请先在联网状态完成一次更新检查或补齐宏包，再离线编译。';
  }
  if (/cannot contact.*repository/iu.test(text)) {
    return 'MiKTeX 无法访问宏包仓库（断网或仓库不可达）：请先在联网状态完成一次更新检查或补齐宏包，再离线编译。';
  }
  // 注意：**裸的「宏包缺失」不算环境前提**。规格把「宏包缺失」（例如
  // `! LaTeX Error: File 'x.sty' not found.`、`The required package … is missing`）明确列为第 1 类
  // 真实编译错误，必须判失败；只有同时出现「仓库/下载不可达」这类联网信号时才算第 3 类环境前提。
  // 兜底：MiKTeX 的 FATAL/联网类错误在断网时的具体文案可能随版本变化（curl 报错、仓库不可达等），
  // 只要输出里同时出现 MiKTeX 工具与「致命 / 连不上」两类信号，就按环境前提如实标注。
  if (/miktex/iu.test(text) && /FATAL|Could not resolve host|Failed to connect|Connection timed out|SSL connect error|could not be contacted/iu.test(text)) {
    return 'MiKTeX 在启动阶段报了致命/联网类错误（断网时它仍会尝试更新检查与仓库访问）：这是 MiKTeX 的环境前提，请先在联网状态完成一次更新检查或补齐宏包，再离线编译。原始输出已附在 stdoutTail。';
  }
  return null;
}

// ---------------------------------------------------------------- 主编排

export interface InjectCitationsOptions extends ChannelOptions {
  /** 目标 `.docx`；不存在时按 `mapping` 生成最小文档（决策 2）。 */
  docxPath: string;
  mapping?: CitationMappingInput;
  style?: string;
  locale?: string;
  /** 输出路径；缺省原地写回 `docxPath`（先备份为 `<docxPath>.bak`）。 */
  outPath?: string;
  overwrite?: boolean;
  /** 缺省 true：只返回计划，不写任何文件。 */
  dryRun?: boolean;
  /** 参考文献块标题占位（可选，仅用于新建文档时的可读性）。 */
  title?: string;
}

export interface InjectCitationsResult {
  injected: boolean;
  dryRun: boolean;
  created: boolean;
  docxPath: string;
  outputPath: string;
  backupPath: string | null;
  citations: { name: string; keys: string[]; source: string; paragraph: number; offset: number }[];
  bibliography: { mode: 'placeholder' | 'appended' | 'none'; position: number | null };
  word: { available: boolean; path: string | null };
  /** 已注入但需要用户在 Word 里执行 `Zotero → Refresh` 才能成为受管引用。 */
  requiresRefresh: boolean;
  reason: string | null;
  /**
   * 文档里全部占位符命中；成功与拒绝都会回填。
   * `paragraph` 是 0 基段落序号（与 `citations[].paragraph`、`bibliography.position` 同一口径），
   * `offset` 是该占位符在段落纯文本里的起始字符偏移。
   */
  placeholderHits: { name: string; paragraph: number; offset: number }[];
  /** 命中异常的具体条目（拒绝写入时非空），与 `reason` 同源、便于机器消费。 */
  problems: string[];
  /** 无法注入时给出的替代产物（CSL / BibTeX / RIS 文本）。 */
  textExports: { csljson: string; bibtex: string; ris: string } | null;
}

function citationId(): string {
  return randomBytes(4).toString('hex');
}

/**
 * 注入引用与参考文献块。
 *
 * 失败时一律返回 `injected: false`、可读原因与 CSL / BibTeX / RIS 替代产物，
 * 不写任何文件、不抛未捕获异常。
 */
export async function injectCitations(options: InjectCitationsOptions): Promise<InjectCitationsResult> {
  const dryRun = options.dryRun !== false;
  const channel = channelOf(options);
  const style = options.style ?? DEFAULT_CITATION_STYLE;
  const locale = options.locale ?? DEFAULT_CITATION_LOCALE;
  const mapping = normalizeMapping(options.mapping);
  const word = detectWord();
  const outputPath = options.outPath ?? options.docxPath;
  const base: InjectCitationsResult = {
    injected: false,
    dryRun,
    created: false,
    docxPath: options.docxPath,
    outputPath,
    backupPath: null,
    citations: [],
    bibliography: { mode: 'none', position: null },
    word,
    requiresRefresh: false,
    reason: null,
    placeholderHits: [],
    problems: [],
    textExports: null,
  };

  // 所有出现在 mapping 里的 key（用于降级时的文本导出）
  const mappedKeys = [...mapping.values()].flatMap((entry) => entry.keys);

  const fail = async (
    reason: string,
    keys: string[],
    extra: Partial<InjectCitationsResult> = {},
  ): Promise<InjectCitationsResult> => ({
    ...base,
    ...extra,
    reason,
    textExports: await bestEffortTextExports(keys.length > 0 ? keys : mappedKeys, { ...channel, style, locale }),
  });

  if (mapping.size === 0 && !existsSync(options.docxPath)) {
    return fail('文档不存在且没有提供 mapping，无法生成文档', []);
  }

  type Loaded =
    | { ok: true; archive: ZipArchive; documentXml: string; created: boolean }
    | { ok: false; reason: string };
  const loaded: Loaded = (() => {
    try {
      if (existsSync(options.docxPath)) {
        const archive = readZip(readFileSync(options.docxPath));
        const part = archive.entries.find((entry) => entry.name === DOCUMENT_PART);
        if (part === undefined) return { ok: false, reason: `不是合法的 .docx：缺少 ${DOCUMENT_PART}` };
        return { ok: true, archive, documentXml: part.data.toString('utf8'), created: false };
      }
      const placeholders = [...mapping.keys()]
        .filter((name) => name !== BIBLIOGRAPHY_PLACEHOLDER)
        .map((name) => `{{zotero:${name}}}`);
      placeholders.push(`{{zotero:${BIBLIOGRAPHY_PLACEHOLDER}}}`);
      const archive = readZip(buildMinimalDocx({ title: options.title ?? 'Zotero MCP 引用样例', placeholders }));
      const part = archive.entries.find((entry) => entry.name === DOCUMENT_PART);
      if (part === undefined) return { ok: false, reason: `生成的文档缺少 ${DOCUMENT_PART}` };
      return { ok: true, archive, documentXml: part.data.toString('utf8'), created: true };
    } catch (error) {
      return { ok: false, reason: `无法读取 .docx：${(error as Error).message}` };
    }
  })();
  if (!loaded.ok) return fail(loaded.reason, []);
  const { archive, documentXml, created } = loaded;

  // 占位符命中检查
  const hits = findPlaceholders(documentXml);
  const byName = new Map<string, PlaceholderHit[]>();
  for (const hit of hits) {
    const list = byName.get(hit.name) ?? [];
    list.push(hit);
    byName.set(hit.name, list);
  }
  const problems: string[] = [];
  const describeHits = (list: { paragraph: number; offset: number }[]): string =>
    list.map((hit) => `段落 ${hit.paragraph} 偏移 ${hit.offset}`).join('、');
  const placeholderHits = hits.map((hit) => ({ name: hit.name, paragraph: hit.paragraph, offset: hit.offset }));
  for (const [name, list] of byName) {
    if (name === BIBLIOGRAPHY_PLACEHOLDER) continue;
    if (list.length > 1) {
      problems.push(`占位符 {{zotero:${name}}} 命中 ${list.length} 次（必须恰好 1 次）：${describeHits(list)}`);
    }
  }
  for (const name of mapping.keys()) {
    if (name === BIBLIOGRAPHY_PLACEHOLDER) continue;
    const count = byName.get(name)?.length ?? 0;
    if (count === 0) problems.push(`mapping 中的 ${name} 在文档里命中 0 次：文档里没有任何位置`);
  }
  const bibliographyHits = byName.get(BIBLIOGRAPHY_PLACEHOLDER)?.length ?? 0;
  if (bibliographyHits > 1) {
    problems.push(`参考文献块占位符命中 ${bibliographyHits} 次（最多 1 次）：${describeHits(byName.get(BIBLIOGRAPHY_PLACEHOLDER) ?? [])}`);
  }
  if (problems.length > 0) {
    // 拒绝写入时同样回填命中清单，调用方仍然能读到「哪些位置命中了什么」
    return fail(`占位符命中异常：${problems.join('；')}`, [], { placeholderHits, problems });
  }

  // 解析每个命中对应的引用条目
  const groups: { name: string; entry: CitationMappingEntry; source: string; hit: PlaceholderHit }[] = [];
  const inlineProblems: string[] = [];
  for (const hit of hits) {
    if (hit.name === BIBLIOGRAPHY_PLACEHOLDER) continue;
    const resolved = resolvePlaceholder(hit.name, mapping);
    if (resolved === null) {
      inlineProblems.push(`占位符 {{zotero:${hit.name}}} 没有可用的 key`);
      continue;
    }
    groups.push({ name: hit.name, entry: resolved.entry, source: resolved.source, hit });
  }
  if (inlineProblems.length > 0) {
    return fail(`占位符无法解析：${inlineProblems.join('；')}`, []);
  }

  const bibliographyKeys = [...new Set(groups.flatMap((group) => group.entry.keys))];
  let data: Map<string, ItemCitationData>;
  try {
    data = await fetchCitationData(bibliographyKeys, { ...channel, style, locale });
  } catch (error) {
    return fail(`读取引用数据失败：${(error as Error).message}`, bibliographyKeys);
  }

  const missing = bibliographyKeys.filter((key) => {
    const entry = data.get(key);
    return entry === undefined || entry.itemData === null || entry.itemData === undefined;
  });
  if (missing.length > 0) {
    return fail(`以下条目取不到 CSL JSON：${missing.join(', ')}`, bibliographyKeys);
  }

  // 逐组构造域
  const fields = new Map<string, InjectionField>();
  const planned: InjectCitationsResult['citations'] = [];
  for (const group of groups) {
    const items = group.entry.keys.map((key) => ({
      key,
      itemData: (data.get(key) as ItemCitationData).itemData,
      entry: group.entry,
    }));
    const texts = group.entry.keys.map((key) => (data.get(key) as ItemCitationData).citationText);
    const resultText = joinCitationTexts(texts);
    const code = buildCitationCode({ citationId: citationId(), items, formattedCitation: resultText });
    fields.set(group.name, { code, resultText });
    planned.push({
      name: group.name,
      keys: group.entry.keys,
      source: group.source,
      paragraph: group.hit.paragraph,
      offset: group.hit.offset,
    });
  }

  const bibliographyField: InjectionField | undefined =
    bibliographyKeys.length === 0
      ? undefined
      : {
          code: buildBibliographyCode(),
          resultText: bibliographyKeys
            .map((key) => (data.get(key) as ItemCitationData).bibText)
            .filter((text) => text.length > 0)
            .join('\n'),
        };

  const outcome = injectFields(documentXml, {
    fields,
    ...(bibliographyField === undefined ? {} : { bibliography: bibliographyField }),
  });
  if (outcome.errors.length > 0) {
    return fail(`无法安全替换占位符：${outcome.errors.map((error) => `${error.name}（${error.reason}）`).join('；')}`, bibliographyKeys);
  }

  const appliedNames = new Set(outcome.applied.map((entry) => entry.name));
  const unapplied = [...fields.keys()].filter((name) => !appliedNames.has(name));
  if (unapplied.length > 0) {
    return fail(`占位符未被替换：${unapplied.join(', ')}`, bibliographyKeys);
  }

  const plannedWithPosition = planned.map((entry) => {
    const applied = outcome.applied.find((item) => item.name === entry.name);
    return { ...entry, paragraph: applied?.paragraph ?? entry.paragraph, offset: applied?.offset ?? entry.offset };
  });
  const bibliographyPosition =
    outcome.bibliographyApplied === 'placeholder'
      ? (outcome.applied.find((entry) => entry.name === BIBLIOGRAPHY_PLACEHOLDER)?.paragraph ?? null)
      : null;

  const result: InjectCitationsResult = {
    ...base,
    injected: true,
    created,
    placeholderHits,
    problems: [],
    citations: plannedWithPosition,
    bibliography: { mode: outcome.bibliographyApplied, position: bibliographyPosition },
    requiresRefresh: word.available,
    reason: word.available
      ? null
      : '本机未检测到 Word：文档已注入域代码，但需要安装 Word 并执行 Zotero → Refresh 才能成为受管引用',
  };
  if (dryRun) return result;

  // 写盘
  try {
    if (options.outPath !== undefined && existsSync(options.outPath) && options.overwrite !== true) {
      return { ...(await fail(`输出路径已存在，如需覆盖请显式传入 overwrite：${options.outPath}`, bibliographyKeys)), injected: false };
    }
    let backupPath: string | null = null;
    if (options.outPath === undefined) {
      const backup = `${options.docxPath}.bak`;
      if (existsSync(backup) && options.overwrite !== true) {
        return {
          ...(await fail(`备份文件已存在，如需覆盖请显式传入 overwrite：${backup}`, bibliographyKeys)),
          injected: false,
        };
      }
      if (existsSync(options.docxPath)) {
        writeFileSync(backup, readFileSync(options.docxPath));
        backupPath = backup;
      }
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    const repacked = writeZip(replaceEntry(archive, DOCUMENT_PART, Buffer.from(outcome.xml, 'utf8')));
    if (existsSync(outputPath) && options.outPath === undefined) {
      // 原地写回：先写临时文件再原子替换，避免中途失败留下半成品
      const temporary = `${outputPath}.tmp`;
      writeFileSync(temporary, repacked);
      renameSync(temporary, outputPath);
    } else {
      writeFileSync(outputPath, repacked);
    }
    return { ...result, backupPath };
  } catch (error) {
    return { ...(await fail(`写入失败：${(error as Error).message}`, bibliographyKeys)), injected: false };
  }
}

/** 降级产物：CSL JSON / BibTeX / RIS 文本（尽力而为，失败不影响主流程）。 */
async function bestEffortTextExports(
  keys: string[],
  options: ChannelOptions & { style?: string; locale?: string },
): Promise<{ csljson: string; bibtex: string; ris: string }> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return { csljson: '', bibtex: '', ris: '' };
  const channel = channelOf(options);
  const read = async (format: 'csljson' | 'bibtex' | 'ris'): Promise<string> => {
    try {
      const result = await exportItems({
        ...channel,
        keys: unique,
        format,
        ...(options.style === undefined ? {} : { style: options.style }),
        ...(options.locale === undefined ? {} : { locale: options.locale }),
      });
      return result.content;
    } catch {
      return '';
    }
  };
  const [csljson, bibtex, ris] = await Promise.all([read('csljson'), read('bibtex'), read('ris')]);
  return { csljson, bibtex, ris };
}
