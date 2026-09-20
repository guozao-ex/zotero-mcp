/**
 * 引用与导出能力：六种格式、style/locale 透传、可落盘与 .bib 结构校验。
 *
 * 导出走本地 API 的格式化输出（`/items?format=…`），不在客户端重实现 CSL 渲染；
 * `.bib`/`.ris`/`citation`/`bibliography` 是文本，`csljson` 是结构化 JSON。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { existsSync } from 'node:fs';

import { requestLocalApi, requestLocalText } from '../channels/local-api.ts';
import { mapWithConcurrency } from './read.ts';
import { LIBRARY_PREFIX } from './read.ts';
import { buildCitaviAnnotationExchange } from './highlight-exchange.ts';
import type { ChannelOptions } from './read.ts';

export const EXPORT_FORMATS = ['bib', 'bibtex', 'csljson', 'ris', 'citation', 'bibliography', 'citavi'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * 本地 API 的格式名与用户意图的差异（真机验证 Zotero 10.0.2）：
 * - `format=bib` 返回的是 HTML 参考文献块（csl-bib-body），不是原始 BibTeX；
 * - 原始 BibTeX（可落盘为 .bib）要用 `format=bibtex`。
 * 因此对外仍提供 `bib` 语义（用户要的是一份 .bib），请求时映射为 `bibtex`。
 */
const API_FORMAT_ALIASES: Partial<Record<ExportFormat, string>> = {
  bib: 'bibtex',
  bibtex: 'bibtex',
  ris: 'ris',
  csljson: 'csljson',
  // 本地 API 不支持 format=citation / format=bibliography（真机返回 400），
  // 格式化输出统一走 format=bib + style/locale。
  citation: 'bib',
  bibliography: 'bib',
};

/** 返回结构化 JSON 的格式（其余为纯文本）。 */
const JSON_FORMATS = new Set<ExportFormat>(['csljson']);

export interface ExportOptions extends ChannelOptions {
  keys: string[];
  format: ExportFormat;
  /** citation / bibliography 使用。 */
  style?: string;
  locale?: string;
  /** 落盘路径（不在回环语义内，只是本地文件系统写入）。 */
  outPath?: string;
  /** 允许覆盖已存在文件，默认 false。 */
  overwrite?: boolean;
}

export interface ExportResult {
  format: ExportFormat;
  count: number;
  /** 实际请求路径（用于证明 style/locale 进入请求）。 */
  path: string;
  content: string;
  /** csljson 解析后的结构化数据；其他格式为 null。 */
  data: unknown[] | null;
  /** 落盘后的绝对/相对路径；未落盘为 null。 */
  path_written?: string;
  /** format=citavi 专用：逐条可读问题（被跳过的注释、类型不被通道保留的提示）。 */
  annotationIssues?: { kind: string; id: string; reason: string }[];
  /** format=citavi 专用：每个条目的导出摘要（条目 / 附件 / 注释条数）。 */
  annotationSummary?: { itemKey: string; attachmentKey: string; annotationCount: number }[];
}

export interface BibValidationIssue {
  entry: string;
  problem: string;
}

export interface BibValidation {
  ok: boolean;
  entryCount: number;
  keys: string[];
  issues: BibValidationIssue[];
  /** 缺 `year` 的条目数（放宽校验时用于如实报出，而不是静默放过）。 */
  missingYear: string[];
}

export interface BibValidationOptions {
  /**
   * 是否要求每个条目都有 `year`（默认 true，保持既有语义）。
   *
   * 置为 false 时只免除 `year`：条目头、花括号配平、`title` 与 `author` 仍然强制。
   * 真实库里存在没有日期的条目（Zotero 不会为它们导出 `year`），调用方按条目实际日期
   * 决定要不要要求 `year` 时用得上。
   */
  requireYear?: boolean;
}

/** 构造单条导出请求路径（本地 API 不支持按 itemKey 过滤，导出同样逐条请求）。 */
export function buildExportPath(options: Pick<ExportOptions, 'keys' | 'format' | 'style' | 'locale'>): string {
  const keys = [...new Set(options.keys.map((key) => key.trim()).filter((key) => key.length > 0))];
  if (keys.length === 0) throw new Error('keys 不能为空');
  const apiFormat = API_FORMAT_ALIASES[options.format] ?? options.format;
  const params = new URLSearchParams();
  params.set('format', apiFormat);
  if (options.style !== undefined && options.style.length > 0) params.set('style', options.style);
  if (options.locale !== undefined && options.locale.length > 0) params.set('locale', options.locale);
  return `${LIBRARY_PREFIX}/items/${keys[0]}?${params.toString()}`;
}

/** 从 `extra` 字段提取 Better BibTeX 的 Citation Key。 */
export function extractCitationKey(extra: string | null | undefined): string | null {
  if (typeof extra !== 'string') return null;
  const match = /^\s*Citation Key:\s*([^\s]+)\s*$/imu.exec(extra);
  return match?.[1] ?? null;
}

/**
 * `.bib` 结构校验：条目头、花括号配平与必需字段（title / author / year）。
 * 本机未安装 LaTeX，因此用结构校验替代编译验证。
 */
export function validateBib(content: string, options: BibValidationOptions = {}): BibValidation {
  const requireYear = options.requireYear !== false;
  const issues: BibValidationIssue[] = [];
  const missingYear: string[] = [];
  const keys: string[] = [];
  const entries = content.split(/^@/mu).slice(1);
  for (const raw of entries) {
    const head = /^([A-Za-z]+)\s*\{\s*([^,\s]+)\s*,/u.exec(raw);
    if (head === null) {
      issues.push({ entry: raw.slice(0, 40), problem: '缺少合法条目头（@type{key,）' });
      continue;
    }
    const key = head[2];
    if (key === undefined || key.length === 0) {
      issues.push({ entry: raw.slice(0, 40), problem: '引用键为空' });
      continue;
    }
    keys.push(key);
    let depth = 0;
    for (const character of `@${raw}`) {
      if (character === '{') depth += 1;
      else if (character === '}') depth -= 1;
    }
    if (depth !== 0) issues.push({ entry: key, problem: `花括号不配平（差 ${depth}）` });
    const body = raw.toLowerCase();
    const requiredFields = requireYear ? ['title', 'author', 'year'] : ['title', 'author'];
    for (const field of requiredFields) {
      if (!new RegExp(`\\b${field}\\s*=`, 'u').test(body)) {
        issues.push({ entry: key, problem: `缺少必需字段 ${field}` });
      }
    }
    // 不论是否要求 year，都把缺 year 的条目如实报出
    if (!/\byear\s*=/u.test(body)) missingYear.push(key);
  }
  return { ok: issues.length === 0 && keys.length > 0, entryCount: keys.length, keys, issues, missingYear };
}

/** 导出条目：按格式取文本或 JSON，可选落盘。 */
export async function exportItems(options: ExportOptions): Promise<ExportResult> {
  const keys = [...new Set(options.keys.map((key) => key.trim()).filter((key) => key.length > 0))];
  if (keys.length === 0) throw new Error('keys 不能为空');

  // format=citavi：导出「可导入的高亮清单」（Citavi 6 交换 XML，Zotero 自带导入器可直接导入并建注释条目）。
  // 它不走本地 API 的格式化端点，只读附件与注释；落盘/覆盖语义与其它格式一致。
  if (options.format === 'citavi') {
    const exchange = await buildCitaviAnnotationExchange({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      keys,
    });
    // 缺数据必须拒绝，且逐条给出原因——不得产出「空的骨架 XML」这种不可导入的东西。
    if (exchange.rejected.length > 0) {
      throw new Error(
        `这些条目无法导出可导入的高亮清单（未产出任何文件）：${exchange.rejected
          .map((item) => `${item.itemKey}：${item.reason}`)
          .join('；')}`,
      );
    }
    if (exchange.entries.length === 0 || exchange.annotationTotal === 0) {
      throw new Error(
        `没有可导出的注释（未产出任何文件）：${
          exchange.skipped.length > 0
            ? exchange.skipped.map((item) => `${item.annotationKey}：${item.reason}`).join('；')
            : '所选条目下没有任何带坐标的注释'
        }`,
      );
    }
    const result: ExportResult = {
      format: 'citavi',
      count: exchange.annotationTotal,
      path: `${LIBRARY_PREFIX}/items`,
      content: exchange.xml,
      data: null,
      // 逐条可读问题（跳过的注释、类型不被通道保留的提示）必须随结果返回，不能丢在内部对象里
      annotationIssues: [
        ...exchange.issues.map((issue) => ({ kind: issue.kind, id: issue.id, reason: issue.reason })),
      ],
      annotationSummary: exchange.entries.map((entry) => ({
        itemKey: entry.itemKey,
        attachmentKey: entry.attachmentKey,
        annotationCount: entry.annotationCount,
      })),
    };
    if (options.outPath !== undefined && options.outPath.length > 0) {
      if (existsSync(options.outPath) && options.overwrite !== true) {
        throw new Error(`目标文件已存在，如需覆盖请显式传入 overwrite：${options.outPath}`);
      }
      await mkdir(dirname(options.outPath), { recursive: true });
      await writeFile(options.outPath, exchange.xml, 'utf8');
      result.path_written = options.outPath;
    }
    return result;
  }

  const apiFormat = API_FORMAT_ALIASES[options.format] ?? options.format;
  const params = new URLSearchParams();
  params.set('format', apiFormat);
  if (options.style !== undefined && options.style.length > 0) params.set('style', options.style);
  if (options.locale !== undefined && options.locale.length > 0) params.set('locale', options.locale);
  const suffix = params.toString();
  const pathOf = (key: string): string => `${LIBRARY_PREFIX}/items/${key}?${suffix}`;
  const common = {
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs,
  };

  // 本地 API 的 /items?itemKey= 不做过滤，导出同样逐条请求后合并。
  const parts = await mapWithConcurrency(keys, 5, async (key) =>
    JSON_FORMATS.has(options.format)
      ? ((await requestLocalApi({ ...common, path: pathOf(key) })).body as unknown)
      : (await requestLocalText({ ...common, path: pathOf(key) })).body,
  );

  let content: string;
  let data: unknown[] | null = null;
  let count: number;
  if (JSON_FORMATS.has(options.format)) {
    const merged = parts.flatMap((part) => (Array.isArray(part) ? part : [part]));
    data = merged;
    content = JSON.stringify(merged, null, 2);
    count = merged.length;
  } else {
    const text = (parts as string[]).map((part) => part.trim()).filter((part) => part.length > 0);
    const NLc = String.fromCharCode(10);
    content = text.join(NLc + NLc) + NLc;
    count = options.format === 'citation' || options.format === 'bibliography'
      ? text.length
      : countBibLikeEntries(content, options.format);
  }

  const result: ExportResult = {
    format: options.format,
    count,
    path: keys.length > 0 ? pathOf(keys[0] as string) : `${LIBRARY_PREFIX}/items`,
    content,
    data,
  };
  if (options.outPath !== undefined && options.outPath.length > 0) {
    if (existsSync(options.outPath) && options.overwrite !== true) {
      throw new Error(`目标文件已存在，如需覆盖请显式传入 overwrite：${options.outPath}`);
    }
    await mkdir(dirname(options.outPath), { recursive: true });
    await writeFile(options.outPath, content, 'utf8');
    result.path_written = options.outPath;
  }
  return result;
}

/** 统计文本型导出里的条目数量（bib 按 @type 计数，citation/bibliography 按非空行计）。 */
export function countBibLikeEntries(content: string, format: ExportFormat): number {
  const trimmed = content.trim();
  if (trimmed.length === 0) return 0;
  if (format === 'bib' || format === 'bibtex') {
    return trimmed.split(/^@/mu).slice(1).length;
  }
  if (format === 'ris') {
    return trimmed.split(/^TY\s{2}-/mu).length - 1;
  }
  return trimmed.split(/\n{2,}/u).filter((block) => block.trim().length > 0).length;
}
