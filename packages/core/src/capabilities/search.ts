/**
 * 只读能力层：搜索、集合树与标签。
 */

import { requestLocalApi } from '../channels/local-api.ts';
import { LIBRARY_PREFIX, toItemSummary } from './read.ts';
import type { ChannelOptions, ItemEnvelope, ItemSummary } from './read.ts';

export type SearchMode = 'keyword' | 'fulltext' | 'saved';

export const DEFAULT_SEARCH_LIMIT = 25;

export interface SearchOptions extends ChannelOptions {
  mode: SearchMode;
  /** keyword / fulltext 模式的检索词。 */
  query?: string;
  /** saved 模式使用的保存搜索 key。 */
  savedSearchKey?: string;
  itemType?: string;
  tag?: string;
  collection?: string;
  limit?: number;
  start?: number;
}

export interface SearchResult {
  mode: SearchMode;
  /** 实际请求的路径：用于证明 saved 模式走的是本地独有端点。 */
  path: string;
  total: number | null;
  items: ItemSummary[];
}

function buildSearchPath(options: SearchOptions): string {
  const params = new URLSearchParams();
  const limit = options.limit ?? DEFAULT_SEARCH_LIMIT;
  params.set('limit', String(Math.min(Math.max(limit, 1), 100)));
  if (options.start !== undefined) params.set('start', String(options.start));

  if (options.mode === 'saved') {
    const key = options.savedSearchKey?.trim();
    if (key === undefined || key.length === 0) throw new Error('saved 模式必须提供 savedSearchKey');
    return `${LIBRARY_PREFIX}/searches/${key}/items?${params.toString()}`;
  }

  const query = options.query?.trim() ?? '';
  if (query.length === 0) throw new Error(`${options.mode} 模式必须提供 query`);
  params.set('q', query);
  params.set('qmode', options.mode === 'fulltext' ? 'everything' : 'titleCreatorYear');
  if (options.itemType !== undefined) params.set('itemType', options.itemType);
  if (options.tag !== undefined) params.set('tag', options.tag);
  if (options.collection !== undefined) {
    const collectionParams = new URLSearchParams(params);
    return `${LIBRARY_PREFIX}/collections/${options.collection}/items/top?${collectionParams.toString()}`;
  }
  return `${LIBRARY_PREFIX}/items/top?${params.toString()}`;
}

/** 搜索：keyword（标题/作者/年份）、fulltext（全文）、saved（执行保存搜索）。 */
export async function searchItems(options: SearchOptions): Promise<SearchResult> {
  const path = buildSearchPath(options);
  const response = await requestLocalApi({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs,
    path,
  });
  const items = Array.isArray(response.body) ? (response.body as ItemEnvelope[]).map(toItemSummary) : [];
  return { mode: options.mode, path, total: response.totalResults, items };
}

export interface CollectionNode {
  key: string;
  name: string | null;
  parentCollection: string | false;
  /** 形如 `/父集合/子集合` 的可读路径。 */
  path: string;
  itemCount: number | null;
  children: CollectionNode[];
}

export interface CollectionsResult {
  tree: CollectionNode[];
  flat: CollectionNode[];
}

/** 集合树：包含父子关系、可读路径与（可选）条目计数。 */
export async function listCollections(
  options: ChannelOptions & { withCounts?: boolean; countLimit?: number } = {},
): Promise<CollectionsResult> {
  const response = await requestLocalApi({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs,
    path: `${LIBRARY_PREFIX}/collections?limit=100`,
  });
  const envelopes = Array.isArray(response.body) ? (response.body as ItemEnvelope[]) : [];
  const withCounts = options.withCounts ?? true;
  const flat: CollectionNode[] = [];

  for (const envelope of envelopes) {
    let itemCount: number | null = null;
    if (withCounts) {
      const counted = await requestLocalApi({
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        timeoutMs: options.timeoutMs,
        path: `${LIBRARY_PREFIX}/collections/${envelope.key}/items/top?limit=1`,
      });
      itemCount = counted.totalResults;
    }
    const parent = envelope.data['parentCollection'];
    flat.push({
      key: envelope.key,
      name: typeof envelope.data['name'] === 'string' ? (envelope.data['name'] as string) : null,
      parentCollection: typeof parent === 'string' ? parent : false,
      path: '',
      itemCount,
      children: [],
    });
  }

  const byKey = new Map(flat.map((node) => [node.key, node]));
  const tree: CollectionNode[] = [];
  for (const node of flat) {
    const parentKey = node.parentCollection;
    const parent = typeof parentKey === 'string' ? byKey.get(parentKey) : undefined;
    if (parent === undefined) tree.push(node);
    else parent.children.push(node);
  }
  const assignPath = (node: CollectionNode, prefix: string): void => {
    node.path = `${prefix}/${node.name ?? node.key}`;
    for (const child of node.children) assignPath(child, node.path);
  };
  for (const node of tree) assignPath(node, '');

  return { tree, flat };
}

export interface TagSummary {
  tag: string;
  itemCount: number | null;
}

/** 标签与频次。 */
export async function listTags(
  options: ChannelOptions & { limit?: number } = {},
): Promise<TagSummary[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 100);
  const response = await requestLocalApi({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs,
    path: `${LIBRARY_PREFIX}/tags?limit=${limit}`,
  });
  if (!Array.isArray(response.body)) return [];
  return (response.body as Record<string, unknown>[])
    .map((entry) => {
      const tag = typeof entry['tag'] === 'string' ? (entry['tag'] as string) : null;
      const meta = entry['meta'];
      const numItems =
        typeof meta === 'object' && meta !== null && typeof (meta as Record<string, unknown>)['numItems'] === 'number'
          ? ((meta as Record<string, unknown>)['numItems'] as number)
          : null;
      return tag === null ? null : { tag, itemCount: numItems };
    })
    .filter((entry): entry is TagSummary => entry !== null);
}
