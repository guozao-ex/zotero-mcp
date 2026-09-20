/**
 * 只读能力层：条目、子项、注释、笔记、附件与内容读取。
 *
 * 能力层与通道解耦：这里只调用 `requestLocalApi`，不关心 HTTP 细节；
 * 工具层（packages/mcp-server）只做参数校验与结果序列化。
 */

import { requestLocalApi, resolveItemFilePath } from '../channels/local-api.ts';
import type { LocalApiRequestOptions } from '../channels/local-api.ts';

/** Local API 与 Web API 一致的批量上限。 */
export const MAX_BATCH_KEYS = 50;

/** 本地库前缀（用户库 id 为 0）。 */
export const LIBRARY_PREFIX = '/api/users/0';

export type IncludeFlag = 'children' | 'attachments' | 'annotations' | 'notes' | 'collections' | 'tags';

export interface ChannelOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface ItemEnvelope {
  key: string;
  version: number;
  data: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

export interface AnnotationDetail {
  key: string;
  annotationType: string | null;
  text: string | null;
  comment: string | null;
  color: string | null;
  pageLabel: string | null;
  position: unknown;
  deepLink: string;
}

export interface NoteDetail {
  key: string;
  note: string | null;
}

export interface AttachmentDetail {
  key: string;
  title: string | null;
  contentType: string | null;
  linkMode: string | null;
  isPdf: boolean;
  annotationCount: number;
}

export interface ItemDetail {
  key: string;
  version: number;
  /** 原始 Zotero data 字段（写管线构造 before/after diff 时使用）。 */
  data: Record<string, unknown>;
  itemType: string | null;
  title: string | null;
  doi: string | null;
  year: string | null;
  creators: string[];
  collections: string[];
  tags: string[];
  attachments: AttachmentDetail[];
  annotations: AnnotationDetail[];
  notes: NoteDetail[];
}

export interface GetItemsOptions extends ChannelOptions {
  keys: string[];
  include?: IncludeFlag[];
}

export interface ReadContentOptions extends ChannelOptions {
  key: string;
  mode: 'path' | 'fulltext';
  pageRange?: string;
}

export interface ContentResult {
  key: string;
  mode: 'path' | 'fulltext';
  source: 'redirect-302' | 'body' | 'fulltext-endpoint';
  path?: string;
  content?: string;
  indexedChars?: number;
  totalChars?: number;
  /** 真机（Zotero 10.0.3）在全文端点返回的是页数；语义索引据此线性估算页码。 */
  indexedPages?: number;
  totalPages?: number;
}

/** 有界并发映射（本地 API 无批量过滤，逐条请求时用它控制并发窗口）。 */
export async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(limit, 1), values.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await worker(values[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function chunk<T>(values: T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) throw new Error('chunk size 必须是正整数');
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

function asArray(value: unknown): ItemEnvelope[] {
  return Array.isArray(value) ? (value as ItemEnvelope[]) : [];
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** 生成可直接打开的 PDF 深链接（读取注释时使用）。 */
export function annotationDeepLink(
  attachmentKey: string,
  annotationKey: string,
  pageLabel?: string | number | null,
): string {
  const base = `zotero://open-pdf/library/items/${attachmentKey}`;
  const params = new URLSearchParams();
  if (pageLabel !== undefined && pageLabel !== null && String(pageLabel).length > 0) {
    params.set('page', String(pageLabel));
  }
  params.set('annotation', annotationKey);
  return `${base}?${params.toString()}`;
}

/**
 * 把注释条目的原始 envelope 映射为 `AnnotationDetail`（含深链接）。
 *
 * 导出是为了让写侧（`zotero_add_note(fromAnnotations)`）复用同一套映射与深链接口径，
 * 而不是再写一份平行实现；本函数不改变任何既有读行为。
 */
export function toAnnotationDetail(envelope: ItemEnvelope, attachmentKey: string): AnnotationDetail {
  const data = envelope.data;
  const pageLabel = asString(data['annotationPageLabel']);
  return {
    key: envelope.key,
    annotationType: asString(data['annotationType']),
    text: asString(data['annotationText']),
    comment: asString(data['annotationComment']),
    color: asString(data['annotationColor']),
    pageLabel,
    position: data['annotationPosition'] ?? null,
    deepLink: annotationDeepLink(attachmentKey, envelope.key, pageLabel),
  };
}

export interface ItemSummary {
  key: string;
  version: number;
  itemType: string | null;
  title: string | null;
  doi: string | null;
  year: string | null;
  creators: string[];
  collections: string[];
  tags: string[];
}

/** 把 Zotero 条目信封压成工具层使用的摘要（搜索与统计复用）。 */
export function toItemSummary(envelope: ItemEnvelope): ItemSummary {
  const data = envelope.data;
  return {
    key: envelope.key,
    version: envelope.version,
    itemType: asString(data['itemType']),
    title: asString(data['title']),
    doi: asString(data['DOI']),
    year: asString(data['date'])?.slice(0, 4) ?? null,
    creators: creatorsOf(data),
    collections: Array.isArray(data['collections']) ? (data['collections'] as string[]) : [],
    tags: Array.isArray(data['tags'])
      ? (data['tags'] as unknown[])
          .map((tag) => (typeof tag === 'object' && tag !== null ? asString((tag as Record<string, unknown>)['tag']) : null))
          .filter((tag): tag is string => tag !== null)
      : [],
  };
}

export function creatorsOf(data: Record<string, unknown>): string[] {
  const creators = data['creators'];
  if (!Array.isArray(creators)) return [];
  return creators
    .map((creator) => {
      if (typeof creator !== 'object' || creator === null) return '';
      const record = creator as Record<string, unknown>;
      const name = asString(record['name']);
      if (name !== null) return name;
      const last = asString(record['lastName']) ?? '';
      const first = asString(record['firstName']) ?? '';
      return `${last}${last.length > 0 && first.length > 0 ? ', ' : ''}${first}`.trim();
    })
    .filter((entry) => entry.length > 0);
}

export async function fetchChildren(parentKey: string, options: ChannelOptions): Promise<ItemEnvelope[]> {
  const response = await requestLocalApi({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs,
    path: `${LIBRARY_PREFIX}/items/${parentKey}/children?limit=100`,
  } satisfies LocalApiRequestOptions);
  return asArray(response.body);
}

/**
 * 注释子项查询：**必须显式带 `itemType=annotation` 过滤**。
 *
 * 真机语义（Zotero 10.0.3，2026-09-19 实测）：`/items/<附件KEY>/children` 不带该过滤时**不返回注释**
 * （`bare → 0 条`、`?limit=100 → 0 条`），只有 `?itemType=annotation` 才拿得到。此前读层用不带过滤的
 * `fetchChildren` 再在客户端筛 `itemType==='annotation'`，于是在真机上静默漏掉全部注释
 * （`include=annotations` 返回空、`annotationCount` 为 0）。假服务器此前也无脑返回全部子项，
 * 让这条缺陷在离线测试里不可见——两处都已按真机对齐。
 */
export async function fetchAnnotationChildren(parentKey: string, options: ChannelOptions): Promise<ItemEnvelope[]> {
  const response = await requestLocalApi({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs,
    path: `${LIBRARY_PREFIX}/items/${parentKey}/children?itemType=annotation&limit=100`,
  } satisfies LocalApiRequestOptions);
  return asArray(response.body);
}

async function hydrate(envelope: ItemEnvelope, include: Set<IncludeFlag>, options: ChannelOptions): Promise<ItemDetail> {
  const data = envelope.data;
  const detail: ItemDetail = {
    key: envelope.key,
    version: envelope.version,
    data,
    itemType: asString(data['itemType']),
    title: asString(data['title']),
    doi: asString(data['DOI']),
    year: asString(data['date'])?.slice(0, 4) ?? null,
    creators: creatorsOf(data),
    collections: Array.isArray(data['collections']) ? (data['collections'] as string[]) : [],
    tags: Array.isArray(data['tags'])
      ? (data['tags'] as unknown[])
          .map((tag) => (typeof tag === 'object' && tag !== null ? asString((tag as Record<string, unknown>)['tag']) : null))
          .filter((tag): tag is string => tag !== null)
      : [],
    attachments: [],
    annotations: [],
    notes: [],
  };

  const wantsChildren =
    include.has('children') ||
    include.has('attachments') ||
    include.has('annotations') ||
    include.has('notes');
  if (!wantsChildren) return detail;

  const children = await fetchChildren(envelope.key, options);
  for (const child of children) {
    const childType = asString(child.data['itemType']);
    if (childType === 'note' && include.has('notes')) {
      detail.notes.push({ key: child.key, note: asString(child.data['note']) });
      continue;
    }
    if (childType !== 'attachment') continue;
    const contentType = asString(child.data['contentType']);
    const attachment: AttachmentDetail = {
      key: child.key,
      title: asString(child.data['title']),
      contentType,
      linkMode: asString(child.data['linkMode']),
      isPdf: contentType === 'application/pdf',
      annotationCount: 0,
    };
    if (include.has('annotations') && attachment.isPdf) {
      // 必须带 itemType=annotation 过滤：真机不带过滤时拿不到注释子项
      const annotations = await fetchAnnotationChildren(child.key, options);
      for (const grandChild of annotations) {
        if (asString(grandChild.data['itemType']) === 'annotation') {
          detail.annotations.push(toAnnotationDetail(grandChild, child.key));
          attachment.annotationCount += 1;
        }
      }
    }
    if (include.has('attachments') || include.has('annotations')) {
      detail.attachments.push(attachment);
    }
  }
  return detail;
}

/** 读取单个或多个条目；超过 50 个 key 自动分批。 */
export async function getItems(options: GetItemsOptions): Promise<ItemDetail[]> {
  const keys = [...new Set(options.keys.map((key) => key.trim()).filter((key) => key.length > 0))];
  if (keys.length === 0) throw new Error('keys 不能为空');
  const include = new Set<IncludeFlag>(options.include ?? []);
  const results: ItemDetail[] = [];
  // 真机验证（Zotero 10.0.2）：本地 API 的 /items?itemKey= 不做过滤（会返回库中前 N 条），
  // 因此批量读取必须逐条 GET /items/<key>；chunk 仍用于控制并发窗口（每批 ≤50）。
  for (const batch of chunk(keys, MAX_BATCH_KEYS)) {
    const envelopes = await mapWithConcurrency(batch, 5, async (key) => {
      try {
        const response = await requestLocalApi({
          ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
          ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
          timeoutMs: options.timeoutMs,
          path: `${LIBRARY_PREFIX}/items/${key}`,
        });
        const body = response.body;
        if (Array.isArray(body)) return body[0] as ItemEnvelope | undefined;
        return body as ItemEnvelope;
      } catch (error) {
        // 逐条读取时，不存在的 key 由单条端点返回 404：跳过而不是让整批失败。
        if (typeof error === 'object' && error !== null && 'status' in error && (error as { status?: unknown }).status === 404) {
          return undefined;
        }
        throw error;
      }
    });
    for (const envelope of envelopes) {
      if (envelope === undefined || envelope === null) continue;
      results.push(await hydrate(envelope, include, options));
    }
  }
  return results;
}

/** 统计某个条目下所有 PDF 附件的注释数量（重复候选的建议主记录据此排序）。 */
export async function countAnnotations(itemKey: string, options: ChannelOptions = {}): Promise<number> {
  const children = await fetchChildren(itemKey, options);
  let count = 0;
  for (const child of children) {
    if (asString(child.data['itemType']) !== 'attachment') continue;
    if (asString(child.data['contentType']) !== 'application/pdf') continue;
    // 同样必须带过滤：无过滤的 /children 在真机不返回注释
    const annotations = await fetchAnnotationChildren(child.key, options);
    count += annotations.filter((grandChild) => asString(grandChild.data['itemType']) === 'annotation').length;
  }
  return count;
}

/** 内容读取：mode=path 经 302 取本地路径，mode=fulltext 取索引全文。 */
export async function readContent(options: ReadContentOptions): Promise<ContentResult> {
  if (options.mode === 'path') {
    const resolved = await resolveItemFilePath({
      key: options.key,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      timeoutMs: options.timeoutMs,
    });
    return { key: options.key, mode: 'path', source: resolved.source, path: resolved.path };
  }
  const response = await requestLocalApi({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs,
    path: `${LIBRARY_PREFIX}/items/${options.key}/fulltext`,
  });
  const body = (response.body ?? {}) as Record<string, unknown>;
  return {
    key: options.key,
    mode: 'fulltext',
    source: 'fulltext-endpoint',
    content: asString(body['content']) ?? '',
    indexedChars: typeof body['indexedChars'] === 'number' ? body['indexedChars'] : undefined,
    totalChars: typeof body['totalChars'] === 'number' ? body['totalChars'] : undefined,
    // 真机（Zotero 10.0.3）返回的是页数而不是字符数；语义索引用它做页码线性估算的唯一依据
    indexedPages: typeof body['indexedPages'] === 'number' ? body['indexedPages'] : undefined,
    totalPages: typeof body['totalPages'] === 'number' ? body['totalPages'] : undefined,
  };
}

/**
 * 全文索引增量清单：`{ itemKey: version }`。
 *
 * 真机验证（Zotero 10.0.2）：`GET /fulltext` 必须带 `since` 参数，
 * 缺省会返回 400 `Invalid 'since' value 'null'`，因此这里默认传 since=0。
 */
export async function getFulltextIndex(
  options: ChannelOptions & { since?: number } = {},
): Promise<Record<string, number>> {
  const since = Number.isFinite(options.since) ? Number(options.since) : 0;
  const response = await requestLocalApi({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs,
    path: `${LIBRARY_PREFIX}/fulltext?since=${since}`,
  });
  const body = (response.body ?? {}) as Record<string, unknown>;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === 'number') out[key] = value;
  }
  return out;
}
