/**
 * 只读能力层：库健康度与重复候选（强键 + 弱键聚类复用 dedupe 模块）。
 */

import { requestLocalApi } from '../channels/local-api.ts';
import { LIBRARY_PREFIX, countAnnotations, toItemSummary } from './read.ts';
import { clusterItems, pickPrimary } from './dedupe.ts';
import type { DedupeCluster, DedupeOptions } from './dedupe.ts';
import type { ChannelOptions, ItemEnvelope } from './read.ts';

export const PAGE_SIZE = 100;

export interface LibraryStats {
  totalItems: number;
  missingPdf: number;
  missingDoi: number;
  missingMetadata: number;
  unfiled: number;
  duplicateCreators: number;
  byItemType: Record<string, number>;
}

async function request(options: ChannelOptions, path: string) {
  return requestLocalApi({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs,
    path,
  });
}

/** 分页拉取全部顶层条目（本地 API 无 Web 式分页元数据，用 Total-Results 判断结束）。 */
export async function fetchAllTopItems(options: ChannelOptions = {}): Promise<ItemEnvelope[]> {
  const collected: ItemEnvelope[] = [];
  let start = 0;
  for (let page = 0; page < 100; page += 1) {
    const response = await request(options, `${LIBRARY_PREFIX}/items/top?limit=${PAGE_SIZE}&start=${start}`);
    const batch = Array.isArray(response.body) ? (response.body as ItemEnvelope[]) : [];
    collected.push(...batch);
    const total = response.totalResults;
    start += batch.length;
    if (batch.length === 0) break;
    if (total !== null && start >= total) break;
    if (batch.length < PAGE_SIZE) break;
  }
  return collected;
}

/** 拉取全部附件（用于判断条目是否已有 PDF）。 */
export async function fetchAllAttachments(options: ChannelOptions = {}): Promise<ItemEnvelope[]> {
  const collected: ItemEnvelope[] = [];
  let start = 0;
  for (let page = 0; page < 100; page += 1) {
    const response = await request(options, `${LIBRARY_PREFIX}/items?itemType=attachment&limit=${PAGE_SIZE}&start=${start}`);
    const batch = Array.isArray(response.body) ? (response.body as ItemEnvelope[]) : [];
    collected.push(...batch);
    const total = response.totalResults;
    start += batch.length;
    if (batch.length === 0) break;
    if (total !== null && start >= total) break;
    if (batch.length < PAGE_SIZE) break;
  }
  return collected;
}

/** 库健康度：缺 PDF / 缺 DOI / 缺元数据 / 未分类 / 重名作者 / 类型分布。 */
export async function libraryStats(options: ChannelOptions = {}): Promise<LibraryStats> {
  const items = await fetchAllTopItems(options);
  const attachments = await fetchAllAttachments(options);
  const parentsWithPdf = new Set<string>();
  for (const attachment of attachments) {
    const parent = attachment.data['parentItem'];
    const contentType = attachment.data['contentType'];
    if (typeof parent === 'string' && contentType === 'application/pdf') parentsWithPdf.add(parent);
  }

  const creatorUsage = new Map<string, number>();
  const byItemType: Record<string, number> = {};
  let missingDoi = 0;
  let missingMetadata = 0;
  let unfiled = 0;

  for (const item of items) {
    const summary = toItemSummary(item);
    const type = summary.itemType ?? 'unknown';
    byItemType[type] = (byItemType[type] ?? 0) + 1;
    if (summary.doi === null || summary.doi.length === 0) missingDoi += 1;
    if (summary.title === null || summary.title.length === 0 || summary.year === null || summary.creators.length === 0) {
      missingMetadata += 1;
    }
    if (summary.collections.length === 0) unfiled += 1;
    for (const creator of summary.creators) {
      creatorUsage.set(creator, (creatorUsage.get(creator) ?? 0) + 1);
    }
  }

  const duplicateCreators = [...creatorUsage.values()].filter((count) => count > 1).length;

  return {
    totalItems: items.length,
    missingPdf: items.filter((item) => !parentsWithPdf.has(item.key)).length,
    missingDoi,
    missingMetadata,
    unfiled,
    duplicateCreators,
    byItemType,
  };
}

export type { DedupeCandidate as DuplicateCandidate, DedupeCluster as DuplicateCluster } from './dedupe.ts';

/** 归一化强键：DOI / ISBN / PMID（实现见 dedupe 模块，这里保持既有导出路径）。 */
export { normalizeStrongKey } from './dedupe.ts';

export interface DuplicateReport {
  clusters: DedupeCluster[];
  /** 被扫描的顶层条目数（工具统计用）。 */
  totalItems: number;
  /** 原始条目信封（供被拒对诊断复用，不随工具默认返回）。 */
  items: ItemEnvelope[];
}

/**
 * 重复候选报告：调用方只读全库顶层条目与附件，聚类本身是纯计算。
 *
 * 注释数只为**已成簇**的条目补齐，避免对全库逐条发请求；主记录建议在补齐后重算。
 */
export async function findDuplicateReport(
  options: ChannelOptions & DedupeOptions = {},
): Promise<DuplicateReport> {
  const items = await fetchAllTopItems(options);
  const attachments = await fetchAllAttachments(options);
  const attachmentCounts = new Map<string, number>();
  for (const attachment of attachments) {
    const parent = attachment.data['parentItem'];
    if (typeof parent === 'string') attachmentCounts.set(parent, (attachmentCounts.get(parent) ?? 0) + 1);
  }

  const clusters = clusterItems(items, { ...options, attachmentCounts });
  for (const cluster of clusters) {
    for (const candidate of cluster.items) {
      candidate.annotationCount = await countAnnotations(candidate.key, options);
    }
    cluster.suggestedPrimary = pickPrimary(cluster.items);
  }
  clusters.sort((left, right) => left.matchKey.localeCompare(right.matchKey));
  return { clusters, totalItems: items.length, items };
}

/** 只取簇的便捷入口。 */
export async function findDuplicateCandidates(
  options: ChannelOptions & DedupeOptions = {},
): Promise<DedupeCluster[]> {
  return (await findDuplicateReport(options)).clusters;
}
