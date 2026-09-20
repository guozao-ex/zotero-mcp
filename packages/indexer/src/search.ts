/**
 * 段落级语义检索。
 *
 * 返回的是**分块**而不是条目：每命中带 `itemKey`、分块原文、`charRange`（指向全文的精确字符区间）、
 * `pageLabel`（含 `pageLabelEstimated` 标记，因为全文端点不提供逐页偏移）与相似度分数。
 *
 * 降级（规格「检索」）：索引不存在 / 为空、模型不可用、嵌入失败时，一律返回 `degraded: true`
 * 与可读原因，由调用方回退到既有关键词 / 全文检索；这里绝不抛未捕获异常，也不假装成功。
 */

import { getItems } from '@zotero-mcp/core';
import type { ChannelOptions } from '@zotero-mcp/core';

import { DEFAULT_MODEL } from './embedder.ts';
import { defaultModelsDir } from './indexer.ts';
import { readIndexStatus, resolveIndexDir } from './store.ts';
import type { Embedder } from './embedder.ts';

export interface SemanticHit {
  itemKey: string;
  /** 命中分块的原文。 */
  text: string;
  /** 余弦相似度（向量已 L2 归一化，故 `1 - distance² / 2`）。 */
  score: number;
  /** 指向该附件全文的字符区间 `[start, end)`，可直接切原文核对。 */
  charRange: { start: number; end: number };
  pageLabel: string | null;
  pageLabelEstimated: boolean;
  /** 条目级元数据（取不到时为 null；不影响命中本身）。 */
  title: string | null;
  year: string | null;
}

export interface SemanticSearchResult {
  degraded: boolean;
  reason: string | null;
  modelId: string | null;
  dim: number | null;
  hits: SemanticHit[];
}

export interface SemanticSearchOptions extends ChannelOptions {
  /** 模型选择：`ZOTERO_MCP_INDEX_MODEL` 的显式覆盖（必须与建索引时一致，否则状态会报需重建）。 */
  model?: string;
  indexDir?: string;
  modelsDir?: string;
  /** 缺省 10，上限 50。 */
  limit?: number;
  /** 注入嵌入器（测试用）。 */
  embedder?: Embedder;
  /** false 时不取条目标题 / 年份（省一次请求）。 */
  withMetadata?: boolean;
}

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 50;

/** L2 归一化向量的余弦相似度：`cos = 1 - d² / 2`（sqlite-vec 的默认距离是 L2）。 */
export function scoreFromDistance(distance: number): number {
  const value = 1 - (distance * distance) / 2;
  return Math.max(-1, Math.min(1, value));
}

/**
 * 段落级语义检索。
 *
 * 查询串为空或只有空白时抛 `Error`（这是调用方参数错误，不是降级场景）；其余不可用情况一律降级。
 */
export async function semanticSearch(query: string, options: SemanticSearchOptions = {}): Promise<SemanticSearchResult> {
  const text = query.trim();
  if (text.length === 0) throw new Error('query 不能为空');
  const limit = Math.max(1, Math.min(MAX_LIMIT, options.limit ?? DEFAULT_LIMIT));
  const indexDir = resolveIndexDir(options.indexDir);
  const modelsDir = options.modelsDir ?? defaultModelsDir();

  const status = readIndexStatus(indexDir);
  if (!status.exists || status.chunks === 0) {
    return {
      degraded: true,
      reason: status.exists ? '索引里还没有任何分块：请先执行 zotero_index(action=build)' : `索引文件不存在（${indexDir}）`,
      modelId: null,
      dim: null,
      hits: [],
    };
  }

  let embedder = options.embedder;
  if (embedder === undefined) {
    const { createEmbedder, resolveModelSpec } = await import('./embedder.ts');
    try {
      embedder = await createEmbedder({
        spec: resolveModelSpec(options.model),
        modelsDir,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        download: false,
      });
    } catch (error) {
      return {
        degraded: true,
        reason: `本地嵌入不可用：${error instanceof Error ? error.message : String(error)}`,
        modelId: null,
        dim: null,
        hits: [],
      };
    }
  }

  if (status.dim !== null && status.dim !== embedder.dim) {
    return {
      degraded: true,
      reason: `索引维度（${status.dim}）与模型维度（${embedder.dim}）不一致：请重建索引`,
      modelId: embedder.modelId,
      dim: embedder.dim,
      hits: [],
    };
  }

  // 维度相同**不**代表模型相同：多语种模型与缺省英文模型同为 384 维。只比 dim 会让「换了模型却复用旧索引」
  // 变成静默混用向量（检索结果看着像成功），所以这里必须再比 model_id。
  if (status.modelId !== null && status.modelId !== embedder.modelId) {
    return {
      degraded: true,
      reason: `索引是用另一个模型建的（索引 ${status.modelId}，当前 ${embedder.modelId}）：请重建索引`,
      modelId: embedder.modelId,
      dim: embedder.dim,
      hits: [],
    };
  }

  let vectors: Float32Array[];
  try {
    vectors = await embedder.embed([text]);
  } catch (error) {
    return {
      degraded: true,
      reason: `嵌入查询失败：${error instanceof Error ? error.message : String(error)}`,
      modelId: embedder.modelId,
      dim: embedder.dim,
      hits: [],
    };
  }
  const vector = vectors[0];
  if (vector === undefined) {
    return { degraded: true, reason: '嵌入查询没有返回向量', modelId: embedder.modelId, dim: embedder.dim, hits: [] };
  }

  // 查询用的库连接只读打开，不建库
  const { openIndexStore } = await import('./store.ts');
  const store = openIndexStore(indexDir, { modelId: status.modelId ?? embedder.modelId, dim: embedder.dim, schemaVersion: status.schemaVersion ?? 1 });
  let raw: { chunkId: number; itemKey: string; text: string; charStart: number; charEnd: number; pageLabel: string | null; pageLabelEstimated: boolean; distance: number }[];
  try {
    raw = store.search(vector, limit);
  } finally {
    store.close();
  }

  const titles = new Map<string, { title: string | null; year: string | null }>();
  if (options.withMetadata !== false && raw.length > 0) {
    const keys = [...new Set(raw.map((entry) => entry.itemKey))];
    try {
      const details = await getItems({
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        timeoutMs: options.timeoutMs,
        keys,
        include: ['children'],
      });
      for (const detail of details) titles.set(detail.key, { title: detail.title, year: detail.year });
    } catch {
      // 元数据取不到不影响命中本身
    }
  }

  return {
    degraded: false,
    reason: null,
    modelId: status.modelId ?? embedder.modelId,
    dim: status.dim ?? embedder.dim ?? DEFAULT_MODEL.dim,
    hits: raw.map((entry) => ({
      itemKey: entry.itemKey,
      text: entry.text,
      score: scoreFromDistance(entry.distance),
      charRange: { start: entry.charStart, end: entry.charEnd },
      pageLabel: entry.pageLabel,
      pageLabelEstimated: entry.pageLabelEstimated,
      title: titles.get(entry.itemKey)?.title ?? null,
      year: titles.get(entry.itemKey)?.year ?? null,
    })),
  };
}
