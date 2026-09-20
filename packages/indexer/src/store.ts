/**
 * 向量存储：Node 24 内置 `node:sqlite` + `sqlite-vec` 原生扩展。
 *
 * 为什么不用第三方绑定：本机实测 `new DatabaseSync(path, { allowExtension: true })` 后
 * `loadExtension(<sqlite-vec>/vec0.dll)` 可用（`vec_version()` 返回 v0.1.9），KNN 也正确，
 * 因此路线图 D4 的 LanceDB 兜底不触发。但**所有向量读写都收在这个模块里**，便于按 D4 更换实现。
 *
 * 两个实测坑：
 *   1. 扩展加载必须在**建库时**用 `allowExtension: true` 打开（之后再调用会报 ERR_INVALID_STATE）；
 *   2. `vec0` 的 rowid 必须传 **BigInt** —— `node:sqlite` 把普通 number 绑成 REAL，会报
 *      "Only integers are allows for primary key values on ..."。
 */

import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { resolveCacheDir } from '@zotero-mcp/core';

import { itemFingerprint } from './chunk.ts';
import type { Chunk } from './chunk.ts';

/**
 * 索引 schema 版本。
 *
 * 版本 2（change `precise-page-labels`）：`chunks` 的 `page_label` 语义从「线性估算」变为
 * 「精确优先、估算兜底」，同一条目在新旧版本下会得到**不同的页码值**（内容哈希不变，因此
 * 单看指纹无法察觉）。bump 版本会让既有索引被判定为「需重建」，避免新旧页码混在同一个库里。
 */
export const INDEX_SCHEMA_VERSION = 2;

/** 找 `sqlite-vec` 的原生扩展路径（平台包由 sqlite-vec 的 optionalDependencies 提供）。 */
export function resolveVecExtension(): string {
  const require = createRequire(import.meta.url);
  const mod = require('sqlite-vec') as { getLoadablePath?: () => string };
  if (typeof mod.getLoadablePath !== 'function') {
    throw new Error('sqlite-vec 模块没有导出 getLoadablePath()');
  }
  return mod.getLoadablePath();
}

export interface IndexMeta {
  modelId: string;
  dim: number;
  schemaVersion: number;
  /** 增量水位：清单里出现过的最大条目版本；下次 update 从这里继续。 */
  watermark?: number;
  /**
   * 页对齐结论的 JSON（change `precise-page-labels`）。形状见 `PageAlignmentMeta`。
   * 持久化它的意义：用户**不重建索引**也能查明「为什么这些条目只有估算页码」（规格要求如实记录原因与命中页数）。
   */
  pageAlignment?: string;
}

/** `meta.page_alignment` 的 JSON 形状。 */
export interface PageAlignmentMeta {
  attempted: number;
  precise: number;
  estimated: number;
  failures: { itemKey: string; code: string; reason: string; matchedPages: number; totalPages: number }[];
}

export interface IndexStatus {
  dir: string;
  exists: boolean;
  items: number;
  chunks: number;
  modelId: string | null;
  dim: number | null;
  schemaVersion: number | null;
  /** 增量水位（0 表示还没有记录）。 */
  watermark: number;
  lastIndexedAt: string | null;
  /**
   * 页码来源分布（change `precise-page-labels`）：精确（`pageLabelEstimated=false`）与估算的**分块数**。
   * 无需重建索引即可看出「这次索引里有多少分块拿到了真实页码」——是失败率报告的补充口径。
   */
  pageLabels: { precise: number; estimated: number };
  /**
   * 页对齐明细（change `precise-page-labels`）：多少条目尝试过、多少精确、失败条目及原因与命中页数。
   * 从 meta 的 `page_alignment` 读出；旧索引（或本 change 之前建的索引）为 null。
   */
  pageAlignment: PageAlignmentMeta | null;
}

export interface SearchHit {
  chunkId: number;
  itemKey: string;
  text: string;
  charStart: number;
  charEnd: number;
  pageLabel: string | null;
  pageLabelEstimated: boolean;
  distance: number;
}

export interface IndexStore {
  dir: string;
  dirPath: string;
  dbPath: string;
  meta(): IndexMeta | null;
  setMeta(meta: IndexMeta): void;
  replaceItem(itemKey: string, chunks: readonly Chunk[], vectors: readonly Float32Array[], storedAt: string): void;
  /** 某条目已存的内容指纹与分块数；不存在时为 null。 */
  item(itemKey: string): { contentHash: string; chunkCount: number } | null;
  removeItem(itemKey: string): void;
  search(vector: Float32Array, limit: number): SearchHit[];
  items(): { itemKey: string; contentHash: string; chunkCount: number }[];
  status(): IndexStatus;
  close(): void;
}

/** 索引是本地缓存，不能落进 `.audit/`（那是审计与快照的目录）；缺省 `cache/index/`。 */
export function resolveIndexDir(configured?: string): string {
  return configured ?? process.env['ZOTERO_MCP_INDEX_DIR'] ?? join(resolveCacheDir(), 'index');
}


function ensureSchema(db: DatabaseSync, dim: number): void {
  db.exec(`
    create table if not exists meta (key text primary key, value text not null);
    create table if not exists items (
      item_key text primary key,
      content_hash text not null,
      chunk_count integer not null,
      stored_at text not null
    );
    create table if not exists chunks (
      chunk_id integer primary key autoincrement,
      item_key text not null,
      idx integer not null,
      text text not null,
      char_start integer not null,
      char_end integer not null,
      page_label text,
      page_label_estimated integer not null default 0,
      content_hash text not null
    );
    create index if not exists chunks_item on chunks(item_key);
  `);
  // 向量表维度固定，模型/维度变化时由调用方重建整库
  db.exec(`create virtual table if not exists vec_chunks using vec0(embedding float[${dim}])`);
}

export function openIndexStore(dir: string, meta: IndexMeta): IndexStore {
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'index.db');
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  db.loadExtension(resolveVecExtension());
  ensureSchema(db, meta.dim);
  db.prepare('insert or replace into meta(key, value) values (?, ?)').run('model_id', meta.modelId);
  db.prepare('insert or replace into meta(key, value) values (?, ?)').run('dim', String(meta.dim));
  db.prepare('insert or replace into meta(key, value) values (?, ?)').run('schema_version', String(meta.schemaVersion));
  db.prepare('insert or replace into meta(key, value) values (?, ?)').run('watermark', String(meta.watermark ?? 0));

  const valueOf = (key: string): string | null => {
    const row = db.prepare('select value from meta where key = ?').get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  };

  return {
    dir,
    dirPath: dir,
    dbPath,
    meta: () => {
      const modelId = valueOf('model_id');
      const dim = Number(valueOf('dim'));
      const schemaVersion = Number(valueOf('schema_version'));
      if (modelId === null || !Number.isFinite(dim)) return null;
      return { modelId, dim, schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : 0 };
    },
    setMeta: (next) => {
      db.prepare('insert or replace into meta(key, value) values (?, ?)').run('model_id', next.modelId);
      db.prepare('insert or replace into meta(key, value) values (?, ?)').run('dim', String(next.dim));
      db.prepare('insert or replace into meta(key, value) values (?, ?)').run('schema_version', String(next.schemaVersion));
      db.prepare('insert or replace into meta(key, value) values (?, ?)').run('watermark', String(next.watermark ?? 0));
      if (typeof next.pageAlignment === 'string') {
        db.prepare('insert or replace into meta(key, value) values (?, ?)').run('page_alignment', next.pageAlignment);
      }
    },
    item: (itemKey) => {
      const row = db.prepare('select content_hash, chunk_count from items where item_key = ?').get(itemKey) as
        | { content_hash?: string; chunk_count?: number }
        | undefined;
      if (row?.content_hash === undefined) return null;
      return { contentHash: row.content_hash, chunkCount: Number(row.chunk_count ?? 0) };
    },
    removeItem: (itemKey) => {
      db.exec('begin');
      try {
        const rows = db.prepare('select chunk_id from chunks where item_key = ?').all(itemKey) as { chunk_id: number }[];
        for (const row of rows) db.prepare('delete from vec_chunks where rowid = ?').run(BigInt(row.chunk_id));
        db.prepare('delete from chunks where item_key = ?').run(itemKey);
        db.prepare('delete from items where item_key = ?').run(itemKey);
        db.exec('commit');
      } catch (error) {
        db.exec('rollback');
        throw error;
      }
    },
    replaceItem: (itemKey, chunks, vectors, storedAt) => {
      if (chunks.length !== vectors.length) {
        throw new Error(`分块数与向量数不一致：${chunks.length} vs ${vectors.length}`);
      }
      db.exec('begin');
      try {
        const oldRows = db.prepare('select chunk_id from chunks where item_key = ?').all(itemKey) as { chunk_id: number }[];
        for (const row of oldRows) {
          // rowid 必须传 BigInt
          db.prepare('delete from vec_chunks where rowid = ?').run(BigInt(row.chunk_id));
        }
        db.prepare('delete from chunks where item_key = ?').run(itemKey);
        const insertChunk = db.prepare(
          'insert into chunks(item_key, idx, text, char_start, char_end, page_label, page_label_estimated, content_hash) values (?, ?, ?, ?, ?, ?, ?, ?)',
        );
        const insertVector = db.prepare('insert into vec_chunks(rowid, embedding) values (?, ?)');
        const contentHash = itemFingerprint(chunks);
        for (let index = 0; index < chunks.length; index += 1) {
          const chunk = chunks[index] as Chunk;
          const info = insertChunk.run(
            itemKey,
            chunk.index,
            chunk.text,
            chunk.charStart,
            chunk.charEnd,
            chunk.pageLabel,
            chunk.pageLabelEstimated ? 1 : 0,
            chunk.contentHash,
          );
          const chunkId = Number(info.lastInsertRowid);
          insertVector.run(BigInt(chunkId), vectors[index] as Float32Array);
        }
        db.prepare('insert or replace into items(item_key, content_hash, chunk_count, stored_at) values (?, ?, ?, ?)').run(
          itemKey,
          contentHash,
          chunks.length,
          storedAt,
        );
        db.exec('commit');
      } catch (error) {
        db.exec('rollback');
        throw error;
      }
    },
    search: (vector, limit) => {
      const rows = db
        .prepare(
          // vec0 的 KNN 查询要求 LIMIT 落在**它自己**的扫描上（放到外层 join 会报
          // "A LIMIT or 'k = ?' constraint is required on vec0 knn queries"），因此先取近邻再 join。
          `select v.rowid as chunk_id, v.distance as distance, c.item_key as item_key, c.text as text,
                  c.char_start as char_start, c.char_end as char_end, c.page_label as page_label,
                  c.page_label_estimated as page_label_estimated
           from (select rowid, distance from vec_chunks where embedding match ? order by distance limit ?) v
           join chunks c on c.chunk_id = v.rowid
           order by v.distance`,
        )
        .all(vector, limit) as {
        chunk_id: number;
        distance: number;
        item_key: string;
        text: string;
        char_start: number;
        char_end: number;
        page_label: string | null;
        page_label_estimated: number;
      }[];
      return rows.map((row) => ({
        chunkId: Number(row.chunk_id),
        itemKey: row.item_key,
        text: row.text,
        charStart: Number(row.char_start),
        charEnd: Number(row.char_end),
        pageLabel: row.page_label,
        pageLabelEstimated: Number(row.page_label_estimated) === 1,
        distance: Number(row.distance),
      }));
    },
    items: () => {
      const rows = db.prepare('select item_key, content_hash, chunk_count from items order by item_key').all() as {
        item_key: string;
        content_hash: string;
        chunk_count: number;
      }[];
      return rows.map((row) => ({ itemKey: row.item_key, contentHash: row.content_hash, chunkCount: Number(row.chunk_count) }));
    },
    status: () => {
      const items = Number((db.prepare('select count(*) as n from items').get() as { n: number }).n);
      const chunks = Number((db.prepare('select count(*) as n from chunks').get() as { n: number }).n);
      const last = (db.prepare('select max(stored_at) as t from items').get() as { t: string | null }).t;
      const preciseChunks = Number(
        (db.prepare('select count(*) as n from chunks where page_label_estimated = 0').get() as { n: number }).n,
      );
      const estimatedChunks = Number(
        (db.prepare('select count(*) as n from chunks where page_label_estimated = 1').get() as { n: number }).n,
      );
      const meta = {
        modelId: valueOf('model_id'),
        dim: Number(valueOf('dim')),
        schemaVersion: Number(valueOf('schema_version')),
      };
      return {
        dir,
        exists: true,
        items,
        chunks,
        modelId: meta.modelId,
        dim: Number.isFinite(meta.dim) ? meta.dim : null,
        schemaVersion: Number.isFinite(meta.schemaVersion) ? meta.schemaVersion : null,
        watermark: Number(valueOf('watermark')) || 0,
        lastIndexedAt: last,
        pageLabels: { precise: preciseChunks, estimated: estimatedChunks },
        pageAlignment: parseAlignmentMeta(valueOf('page_alignment')),
      };
    },
    close: () => db.close(),
  };
}

/** 只读地读现状：索引文件不存在时返回 `exists: false`，不建库。 */
/** 宽松解析 meta 里的 page_alignment：坏了就当没有，不让状态查询失败。 */
function parseAlignmentMeta(raw: string | null): PageAlignmentMeta | null {
  if (raw === null || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PageAlignmentMeta>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return {
      attempted: Number(parsed.attempted ?? 0),
      precise: Number(parsed.precise ?? 0),
      estimated: Number(parsed.estimated ?? 0),
      failures: Array.isArray(parsed.failures) ? parsed.failures : [],
    };
  } catch {
    return null;
  }
}

export function readIndexStatus(dir: string): IndexStatus {
  const dbPath = join(dir, 'index.db');
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const items = Number((db.prepare('select count(*) as n from items').get() as { n: number }).n);
      const chunks = Number((db.prepare('select count(*) as n from chunks').get() as { n: number }).n);
      const last = (db.prepare('select max(stored_at) as t from items').get() as { t: string | null }).t;
      // 页码来源分布：精确/估算各多少分块（用于失败率与「是否真的拿到精确页码」的当场核对）
      const preciseChunks = Number(
        (db.prepare('select count(*) as n from chunks where page_label_estimated = 0').get() as { n: number }).n,
      );
      const estimatedChunks = Number(
        (db.prepare('select count(*) as n from chunks where page_label_estimated = 1').get() as { n: number }).n,
      );
      const valueOf = (key: string): string | null => {
        const row = db.prepare('select value from meta where key = ?').get(key) as { value?: string } | undefined;
        return row?.value ?? null;
      };
      return {
        dir,
        exists: true,
        items,
        chunks,
        modelId: valueOf('model_id'),
        dim: Number(valueOf('dim')) || null,
        schemaVersion: Number(valueOf('schema_version')) || null,
        watermark: Number(valueOf('watermark')) || 0,
        lastIndexedAt: last,
        pageLabels: { precise: preciseChunks, estimated: estimatedChunks },
        pageAlignment: parseAlignmentMeta(valueOf('page_alignment')),
      };
    } finally {
      db.close();
    }
  } catch {
    return { dir, exists: false, items: 0, chunks: 0, modelId: null, dim: null, schemaVersion: null, watermark: 0, lastIndexedAt: null, pageLabels: { precise: 0, estimated: 0 }, pageAlignment: null };
  }
}
