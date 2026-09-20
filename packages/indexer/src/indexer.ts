/**
 * 索引器：全量 build / 增量 update / 只读 status。
 *
 * 增量口径（规格「重建与性能」）：
 *   - 首次 `build` 用 `since=0` 的全量清单，并重建索引库；
 *   - 之后 `update` 用上次记录的**水位**（清单里出现过的最大条目版本）拉增量，再拉一次全量清单
 *     用于发现「已从索引清单里消失」的条目并清理；
 *   - 是否真的重嵌还要看**内容指纹**：指纹与分块数都没变就跳过，因此「连续两次 update 且库未变」
 *     的第二次嵌入计数为 0（幂等）。
 *
 * 索引器只读文库：对本地 API 只发 GET，不写审计、不写快照、不产生任何写请求。
 */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { getFulltextIndex, readContent, resolveCacheDir, resolveItemFilePath } from '@zotero-mcp/core';
import type { ChannelOptions } from '@zotero-mcp/core';

import { chunkText, itemFingerprint } from './chunk.ts';
import { labelForPage } from './page-labels.ts';
import { pageBreaksFromFulltext } from './page-breaks.ts';
import { readPdfPages } from './pdf-pages.ts';
import { inspectModel, resolveModelSpec } from './embedder.ts';
import { INDEX_SCHEMA_VERSION, openIndexStore, readIndexStatus, resolveIndexDir } from './store.ts';
import type { Embedder } from './embedder.ts';
import type { Chunk } from './chunk.ts';
import type { IndexStatus } from './store.ts';

export interface IndexTimings {
  manifestMs: number;
  fetchMs: number;
  chunkMs: number;
  embedMs: number;
  storeMs: number;
  totalMs: number;
}

export interface IndexReport {
  action: 'build' | 'update';
  indexDir: string;
  modelId: string;
  dim: number;
  /** 本轮实际读取并分块的条目数。 */
  manifestItems: number;
  /** 内容指纹变化、真正重嵌的条目数。 */
  changedItems: number;
  /** 指纹未变被跳过的条目数（幂等证据）。 */
  skippedItems: number;
  /** 从索引里清理掉的条目数（库里已无全文）。 */
  removedItems: number;
  /** 本轮实际编码的分块数。 */
  embeddedChunks: number;
  /** 索引里当前的分块总数。 */
  totalChunks: number;
  timings: IndexTimings;
}

export interface IndexOptions extends ChannelOptions {
  indexDir?: string;
  /** 模型选择：`ZOTERO_MCP_INDEX_MODEL` 的显式覆盖（缺省/中文/多语种或模型 id）。 */
  model?: string;
  modelsDir?: string;
  /** 注入嵌入器（测试用）；缺省按需建本地 ONNX 嵌入器。 */
  embedder?: Embedder;
  /** false 时不允许下载模型。 */
  downloadModel?: boolean;
  maxTokens?: number;
  overlapRatio?: number;
  /** 显式指定增量水位；缺省用索引里记录的水位（首次 build 恒为 0）。 */
  since?: number;
  now?: () => Date;
  /** 只处理清单里的前 N 条（测试 / 报告用）。 */
  limitItems?: number;
  /**
   * true 时**不做**页对齐（分块一律退回线性估算并标 `pageLabelEstimated: true`）。
   * 供测试与「只要向量、不要页码」的场景使用；缺省 false（尽力做精确页码）。
   */
  skipPageAlignment?: boolean;
  /** 便于测试注入：替代本地 PDF 逐页解析。 */
  readPdfPagesImpl?: (path: string) => Promise<import('./pdf-pages.ts').PdfPageTexts>;
}

/**
 * 索引默认超时：本地 API 客户端的探测超时只有 3 秒，索引要拉清单与逐条正文，
 * 300 篇规模上实测会稳定超时（并被错误分类成 connection-refused），所以这里显式给足超时。
 */
export const DEFAULT_INDEX_TIMEOUT_MS = 30_000;

/** 只重试一次：本地 API 的失败多为瞬时（超时/连接抖动），重试两次仍失败才算真失败。 */
async function withRetry<T>(operation: () => Promise<T>, attempts = 2): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw last;
}

export class IndexUnavailableError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`语义索引不可用：${reason}`);
    this.name = 'IndexUnavailableError';
    this.reason = reason;
  }
}

export function defaultModelsDir(): string {
  return join(resolveCacheDir(), 'models');
}

/**
 * 单条目的页对齐结论（change `precise-page-labels`）。
 *
 * `precise` 为 true 时 `boundaries`/`labels` 会把分块页码变成**精确**值；
 * 其余情况一律退回线性估算，并在索引元数据里如实留下原因与命中页数（供失败率统计）。
 */
export interface PageAlignmentOutcome {
  precise: boolean;
  reason: string | null;
  matchedPages: number;
  totalPages: number;
  boundaries: number[] | null;
  labels: string[] | null;
  hasPageLabels: boolean;
}

interface Prepared {
  items: { itemKey: string; content: string; indexedPages: number | null; pageAlignment: PageAlignmentOutcome }[];
  aliveKeys: Set<string>;
  watermark: number;
  manifestMs: number;
  fetchMs: number;
}

/**
 * 给单个条目算精确页边界与页标签。
 *
 * **两条来源，优先级写死**（change `precise-page-labels`）：
 *   1. **全文的 \f 分页符**（零依赖、零误差）：\f 个数恰好等于 `indexedPages - 1` 时，
 *      边界直接由分页符位置得到——这是本机 12/12 篇都成立的形态，不需要解析 PDF。
 *   2. **PDF 的 `/PageLabels`**（可选增强）：只用来给这些边界**取页标签名**。
 *      拿不到 PDF、页数不一致或没有标签表时，标签由 `labelForPage` 合成 `1..N`（与阅读器同口径）。
 *
 * 两条来源都失败（例如全文没有 \f）时才退回线性估算，并如实记下原因。
 * **任何失败都不抛异常**：页码是增强信息，不值得让整个索引构建失败。
 */
async function alignItemPages(options: {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  key: string;
  content: string;
  indexedPages: number | null;
  readPdfPagesImpl?: IndexOptions['readPdfPagesImpl'];
}): Promise<PageAlignmentOutcome> {
  const fallback = (reason: string, matchedPages = 0, totalPages = 0): PageAlignmentOutcome => ({
    precise: false,
    reason,
    matchedPages,
    totalPages,
    boundaries: null,
    labels: null,
    hasPageLabels: false,
  });

  // ① 首选：全文的 \f 分页符（精确、零依赖）
  const breaks = pageBreaksFromFulltext(options.content, options.indexedPages);
  if (!breaks.ok) return fallback(`${breaks.code}: ${breaks.reason}`);

  // ② 可选：PDF 的 /PageLabels 只用来命名这些边界
  let labels: string[] | null = null;
  let hasPageLabels = false;
  let labelNote: string | null = null;
  try {
    const resolved = await resolveItemFilePath({
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      key: options.key,
    });
    const reader = options.readPdfPagesImpl ?? ((target: string) => readPdfPages(target));
    const pages = await reader(resolved.path);
    if (!pages.ok) {
      labelNote = `页标签不可用（${pages.code}），按页序命名`;
    } else if (pages.pageCount !== breaks.pageCount) {
      labelNote = `页标签不可用（PDF ${pages.pageCount} 页 vs 全文 ${breaks.pageCount} 页），按页序命名`;
    } else {
      labels = pages.pageLabels;
      hasPageLabels = pages.hasPageLabels;
    }
  } catch (error) {
    labelNote = `页标签不可用（${error instanceof Error ? error.message.slice(0, 80) : String(error)}），按页序命名`;
  }

  // ③ 命名：走 labelForPage（与 Zotero 阅读器同口径：空串回退页序）
  const finalLabels = Array.from({ length: breaks.pageCount }, (_, index) =>
    labelForPage(index, labels, breaks.pageCount),
  );

  return {
    precise: true,
    reason: labelNote,
    matchedPages: breaks.pageCount,
    totalPages: breaks.pageCount,
    boundaries: breaks.boundaries,
    labels: finalLabels,
    hasPageLabels,
  };
}

/**
 * 把逐条目的页对齐结论汇总成可持久化的摘要。
 *
 * `attempted` 是尝试过对齐的条目数，`precise` 是拿到精确页码的条目数，
 * `failures` 逐条带可读原因与 matched/total —— 这是规格要求的「如实记录」，
 * 也是用户排查「为什么这篇只有估算页码」的唯一入口（从 `zotero_index(action=status)` 可读）。
 */
function summarizePageAlignment(items: readonly { itemKey: string; pageAlignment: PageAlignmentOutcome }[]): {
  attempted: number;
  precise: number;
  estimated: number;
  failures: { itemKey: string; code: string; reason: string; matchedPages: number; totalPages: number }[];
} {
  const failures: { itemKey: string; code: string; reason: string; matchedPages: number; totalPages: number }[] = [];
  let precise = 0;
  for (const item of items) {
    if (item.pageAlignment.precise) {
      precise += 1;
      continue;
    }
    const reason = item.pageAlignment.reason ?? '未知原因';
    failures.push({
      itemKey: item.itemKey,
      code: reason.split(':')[0] ?? 'unknown',
      reason: reason.slice(0, 300),
      matchedPages: item.pageAlignment.matchedPages,
      totalPages: item.pageAlignment.totalPages,
    });
  }
  return { attempted: items.length, precise, estimated: items.length - precise, failures };
}

async function prepare(options: IndexOptions, since: number): Promise<Prepared> {
  const channel: ChannelOptions = {
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs ?? DEFAULT_INDEX_TIMEOUT_MS,
  };

  const startedManifest = Date.now();
  const incremental = await withRetry(() => getFulltextIndex({ ...channel, since }));
  // 增量清单只给出变化的条目；清理「已消失」的条目要看全量清单
  const full = since === 0 ? incremental : await withRetry(() => getFulltextIndex({ ...channel, since: 0 }));
  const manifestMs = Date.now() - startedManifest;

  const changedKeys = Object.keys(incremental);
  const selected = options.limitItems === undefined ? changedKeys : changedKeys.slice(0, options.limitItems);
  const items: Prepared['items'] = [];
  const startedFetch = Date.now();
  for (const itemKey of selected) {
    try {
      const detail = (await withRetry(() => readContent({ ...channel, key: itemKey, mode: 'fulltext' }))) as {
        content?: string;
        indexedPages?: number;
        totalChars?: number;
      };
      const content = detail.content ?? '';
      if (content.trim().length === 0) continue;
      const indexedPages = typeof detail.indexedPages === 'number' ? detail.indexedPages : null;
      // 精确页码是**可选增强**：任何失败都只记原因、退回估算，绝不让建索引失败
      const pageAlignment = options.skipPageAlignment === true
        ? { precise: false, reason: '调用方显式关闭了页对齐', matchedPages: 0, totalPages: 0, boundaries: null, labels: null, hasPageLabels: false }
        : await alignItemPages({
            ...channel,
            key: itemKey,
            content,
            indexedPages,
            ...(options.readPdfPagesImpl === undefined ? {} : { readPdfPagesImpl: options.readPdfPagesImpl }),
          });
      items.push({ itemKey, content, indexedPages, pageAlignment });
    } catch {
      // 单条取正文失败不阻塞整轮；它会在下一轮增量里再次出现
      continue;
    }
  }
  const fetchMs = Date.now() - startedFetch;

  // 水位是「已经看到过的库级版本」，**必须单调**：取变化条目的最大版本，与本次查询用的 `since` 取大。
  // 只取变化条目时，**清单为空**（库自 `since` 以来没变）会算出 0，把水位写回 0，
  // 下一次 update 就退化成全量清单扫描（内容指纹未变时仍零嵌入，但白扫一轮、增量诊断也失真）。
  const watermark = Math.max(
    Object.values(incremental).reduce((max, version) => (version > max ? version : max), 0),
    since,
  );
  return { items, aliveKeys: new Set(Object.keys(full)), watermark, manifestMs, fetchMs };
}

async function runIndex(action: 'build' | 'update', options: IndexOptions): Promise<IndexReport> {
  const startedTotal = Date.now();
  const indexDir = resolveIndexDir(options.indexDir);
  const modelsDir = options.modelsDir ?? defaultModelsDir();
  const now = options.now ?? (() => new Date());

  let embedder = options.embedder;
  if (embedder === undefined) {
    const { createEmbedder } = await import('./embedder.ts');
    try {
      embedder = await createEmbedder({
        modelsDir,
        // 模型可显式选择（ZOTERO_MCP_INDEX_MODEL / options.model）；未知值在 resolveModelSpec 里可读拒绝
        spec: resolveModelSpec(options.model),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        download: options.downloadModel !== false,
      });
    } catch (error) {
      throw new IndexUnavailableError(error instanceof Error ? error.message : String(error));
    }
  }
  const maxTokens = options.maxTokens ?? Math.max(16, embedder.maxTokens - 2);

  const previous = readIndexStatus(indexDir);
  const incompatible =
    previous.exists &&
    (previous.modelId !== embedder.modelId || previous.dim !== embedder.dim || previous.schemaVersion !== INDEX_SCHEMA_VERSION);
  if (previous.exists && (action === 'build' || incompatible)) {
    // 模型 / 维度 / schema 变了，旧向量不可用：整库重建，绝不混用
    rmSync(indexDir, { recursive: true, force: true });
  }
  const resetDone = action === 'build' || incompatible || !previous.exists;
  const since = resetDone ? 0 : (options.since ?? previous.watermark);

  const prepared = await prepare(options, since);

  const store = openIndexStore(indexDir, { modelId: embedder.modelId, dim: embedder.dim, schemaVersion: INDEX_SCHEMA_VERSION });
  let chunkMs = 0;
  let embedMs = 0;
  let storeMs = 0;
  let embeddedChunks = 0;
  let changedItems = 0;
  let skippedItems = 0;
  const storedAt = now().toISOString();
  try {
    for (const item of prepared.items) {
      const startedChunk = Date.now();
      const chunks: Chunk[] = chunkText(item.itemKey, item.content, {
        tokenizer: embedder.tokenizer,
        maxTokens,
        ...(options.overlapRatio === undefined ? {} : { overlapRatio: options.overlapRatio }),
        ...(item.indexedPages === null ? {} : { indexedPages: item.indexedPages }),
        ...(item.pageAlignment.precise && item.pageAlignment.boundaries !== null
          ? {
              pageBoundaries: item.pageAlignment.boundaries,
              pageLabels: item.pageAlignment.labels,
              pageCount: item.pageAlignment.totalPages,
            }
          : {}),
      });
      chunkMs += Date.now() - startedChunk;
      if (chunks.length === 0) continue;

      const known = store.item(item.itemKey);
      if (known !== null && known.contentHash === itemFingerprint(chunks) && known.chunkCount === chunks.length) {
        skippedItems += 1;
        continue;
      }

      const startedEmbed = Date.now();
      const vectors = await embedder.embed(chunks.map((chunk) => chunk.text));
      embedMs += Date.now() - startedEmbed;

      const startedStore = Date.now();
      store.replaceItem(item.itemKey, chunks, vectors, storedAt);
      storeMs += Date.now() - startedStore;
      embeddedChunks += chunks.length;
      changedItems += 1;
    }

    // 清理：全量清单里没有的条目从索引里删掉
    let removedItems = 0;
    for (const entry of store.items()) {
      if (prepared.aliveKeys.has(entry.itemKey)) continue;
      store.removeItem(entry.itemKey);
      removedItems += 1;
    }

    // 页对齐结论持久化进 meta：用户不重建索引也能查明「为什么这些条目只有估算页码」。
    // **清单为空的增量 update 不覆盖**上一次的结论：那种情况下本轮没有处理任何条目，
    // 若照写 `attempted: 0 / failures: []` 会把先前的失败原因抹掉，与上面那句意图相反
    // （全量 build 仍照写——它反映的是整库当前状态）。
    const alignment = summarizePageAlignment(prepared.items);
    store.setMeta({
      modelId: embedder.modelId,
      dim: embedder.dim,
      schemaVersion: INDEX_SCHEMA_VERSION,
      watermark: prepared.watermark,
      ...(prepared.items.length === 0 && action === 'update' ? {} : { pageAlignment: JSON.stringify(alignment) }),
    });
    const status = store.status();
    return {
      action,
      indexDir,
      modelId: embedder.modelId,
      dim: embedder.dim,
      manifestItems: prepared.items.length,
      changedItems,
      skippedItems,
      removedItems,
      embeddedChunks,
      totalChunks: status.chunks,
      timings: {
        manifestMs: prepared.manifestMs,
        fetchMs: prepared.fetchMs,
        chunkMs,
        embedMs,
        storeMs,
        totalMs: Date.now() - startedTotal,
      },
    };
  } finally {
    store.close();
  }
}

export async function buildIndex(options: IndexOptions = {}): Promise<IndexReport> {
  return runIndex('build', options);
}

export async function updateIndex(options: IndexOptions = {}): Promise<IndexReport> {
  return runIndex('update', options);
}

export interface IndexStatusReport extends IndexStatus {
  model: { available: boolean; modelId: string; dim: number; reason: string | null; dir: string };
  degraded: boolean;
  reason: string | null;
}

/**
 * 只读现状：不建库、不下载模型、不发任何请求。
 *
 * 模型可显式选择（`ZOTERO_MCP_INDEX_MODEL` / `options.model`）：索引里记录的 `model_id` / `dim`
 * 与当前选中的模型不一致时必须报「需重建」——**不得**把不同模型的向量混用（混用会静默给出无意义的相似度）。
 */
export function indexStatus(options: { indexDir?: string; modelsDir?: string; model?: string } = {}): IndexStatusReport {
  const indexDir = resolveIndexDir(options.indexDir);
  const modelsDir = options.modelsDir ?? defaultModelsDir();
  const spec = resolveModelSpec(options.model);
  const status = readIndexStatus(indexDir);
  const model = inspectModel(modelsDir, spec);
  const mismatched = status.exists && (status.modelId !== spec.id || status.dim !== spec.dim);
  const empty = !status.exists || status.chunks === 0;
  const degraded = empty || mismatched;
  const reason = mismatched
    ? `索引是用另一个模型建的（索引 modelId=${status.modelId} dim=${status.dim}，当前选择 ${spec.id} dim=${spec.dim}）：请重建（MCP 工具 zotero_index(action=build)，或本地跑 npm run report:index —— 缺省会按当前模型更新/重建索引）`
    : degraded
      ? status.exists
        ? '索引里还没有任何分块：请先执行 zotero_index(action=build)'
        : `索引文件不存在（${indexDir}）`
      : null;
  return {
    ...status,
    model: { available: model.available, modelId: model.modelId, dim: model.dim, reason: model.reason, dir: model.dir },
    degraded,
    reason,
  };
}
