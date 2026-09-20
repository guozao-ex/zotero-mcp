/**
 * 语义索引契约测试（change · m5-semantic-index）。
 *
 * 五条独立验证线：
 *   1. 分词与分块：CJK 逐字切、token 上限自适应、重叠 10%–15%、`charRange` 可逐字还原、页码如实标注；
 *   2. 嵌入：本地 ONNX 的模型清单校验、维度、L2 归一化与可复现性（**需要本机已有模型缓存**，
 *      没有时按 skip 处理而不是判失败——模型下载是外部条件）；
 *   3. 存储：`node:sqlite` + `sqlite-vec` 的建库、写入与 KNN（rowid 必须 BigInt）；
 *   4. 索引：增量幂等（内容未变则零嵌入）、内容变化只重嵌该条目、模型/维度变化整库重建、清理消失条目；
 *   5. 检索与降级：段落级命中带完整溯源；索引为空 / 模型缺失时降级且不影响既有 mode；
 *      工具面 22 个、`zotero_index` 不在写总闸里、`zotero_search(mode=semantic)` 契约。
 *
 * 全部用假本地 API 与临时目录，不访问真实库、不写仓库 `.audit`、不下载模型（除非本机已缓存）。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  CHINESE_MODEL,
  MULTILINGUAL_MODEL,
  DEFAULT_MODEL,
  MODEL_REGISTRY,
  basicTokenize,
  buildIndex,
  chunkText,
  createTokenizer,
  indexStatus,
  readIndexStatus,
  inspectModel,
  itemFingerprint,
  openIndexStore,
  pickSequenceOutputName,
  resolveModelSpec,
  resolveVecExtension,
  scoreFromDistance,
  semanticSearch,
  updateIndex,
} from '../../packages/indexer/src/index.ts';
import { createServer as createMcpServer } from '../../packages/mcp-server/src/server.ts';
import { ALL_TOOLS, GATED_TOOL_NAME_SET, TOOL_NAMES } from '../../packages/mcp-server/src/tools.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// 模型目录默认指向仓库自己的 cache/models（gitignored）：既不含机器相关路径，又不让模型相关用例跳过
const MODELS_DIR = process.env['ZOTERO_MCP_TEST_MODELS_DIR'] ?? join(ROOT, 'cache', 'models');
const MODEL_READY = inspectModel(MODELS_DIR, DEFAULT_MODEL).available;
const VOCAB_PATH = join(MODELS_DIR, DEFAULT_MODEL.id, 'vocab.txt');
const REPORT_SCRIPT = join(ROOT, 'scripts', 'index-report.mjs');
const execFileAsync = promisify(execFile);
const VOCAB_READY = existsSync(VOCAB_PATH);

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 与真实模型同词表的分词器（只要有 vocab.txt 就能独立验证分块，不依赖 ONNX）。 */
function tokenizerFromVocab(maxContentTokens = 510) {
  return createTokenizer(readFileSync(VOCAB_PATH, 'utf8'), { maxContentTokens });
}

/** 确定性假嵌入器：用字符 n-gram 哈希造向量，专供索引流程测试（不依赖 ONNX）。 */
function fakeEmbedder(dim = 64) {
  const build = (text) => {
    const vector = new Float32Array(dim);
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      vector[code % dim] = (vector[code % dim] ?? 0) + 1;
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    for (let index = 0; index < dim; index += 1) vector[index] = (vector[index] ?? 0) / norm;
    return vector;
  };
  return {
    modelId: 'fake-ngram',
    dim,
    maxTokens: 512,
    tokenizer: tokenizerFromVocab(),
    embed: async (texts) => texts.map(build),
    dispose: async () => {},
  };
}

// ── 1. 分词 ─────────────────────────────────────────────────────────────

test('分词：CJK 逐字切、标点独立、英文按词表子词切，token 数即为模型口径', { skip: VOCAB_READY ? false : '本机没有模型词表缓存' }, () => {
  const tokenizer = tokenizerFromVocab();
  assert.equal(tokenizer.vocabSize, 30522);
  // CJK 逐字：9 个汉字 → 9 个内容 token（否则整句会退化成 1 个 [UNK]）
  assert.equal(tokenizer.countTokens('冰川侵蚀作用与冰蚀'), 9);
  const encoded = tokenizer.encode('冰川');
  assert.equal(encoded.ids[0], 101, '必须以 [CLS] 开头');
  assert.equal(encoded.ids.at(-1), 102, '必须以 [SEP] 结尾');
  assert.equal(encoded.ids.length, 4);
  // 英文按子词切（不是按字符）
  assert.ok(tokenizer.countTokens('glacier erosion landforms') < 8);
  // 标点独立成 token
  assert.equal(tokenizer.encode('a.b').ids.length, 5, '[CLS] a . b [SEP] = 3 个内容 token + 2 个特殊 token');
  // 上限自适应：maxTokens=16 时总长度不超过 16
  const capped = tokenizer.encode('冰川侵蚀作用与冰蚀形貌研究进展'.repeat(10), { maxTokens: 16 });
  assert.equal(capped.ids.length, 16);
  assert.equal(capped.attentionMask.every((value) => value === 1), true);
});

// ── 2. 分块与溯源 ───────────────────────────────────────────────────────

test('分块：重叠落在 10%–15%、charRange 可逐字还原、页码如实标注估算', { skip: VOCAB_READY ? false : '本机没有模型词表缓存' }, () => {
  const tokenizer = tokenizerFromVocab();
  const paragraph = (index) => `第 ${index} 段：${'冰川侵蚀与冰蚀形貌研究进展。'.repeat(40)}`;
  const content = Array.from({ length: 30 }, (_, index) => paragraph(index)).join('\n\n');
  const chunks = chunkText('ITEM0001', content, { tokenizer, maxTokens: 128, indexedPages: 6 });

  assert.ok(chunks.length > 3, `分块数应当足够多，实际 ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.tokens <= 128, `分块 token 数不得超过上限：${chunk.tokens}`);
    assert.equal(content.slice(chunk.charStart, chunk.charEnd), chunk.text, 'charRange 必须能逐字还原原文');
    assert.equal(chunk.pageLabelEstimated, true, '页码是线性估算，必须如实标注');
    assert.ok(chunk.pageLabel !== null && Number(chunk.pageLabel) >= 1);
    assert.equal(chunk.contentHash.length, 16);
  }
  // 相邻分块必须重叠（按 token 计 10%–15%）
  for (let index = 1; index < chunks.length; index += 1) {
    const previous = chunks[index - 1];
    const current = chunks[index];
    assert.ok(current.charStart < previous.charEnd, `第 ${index} 块与上一块没有重叠`);
    const overlapText = content.slice(current.charStart, previous.charEnd);
    const ratio = tokenizer.countTokens(overlapText) / previous.tokens;
    assert.ok(ratio >= 0.1 && ratio <= 0.15, `重叠比例必须落在规格的 10%–15%：${ratio.toFixed(3)}`);
  }
  // 回归场景：段落长度参差（有的块会明显短于 maxTokens）时，重叠仍必须落在 10%–15%
  // —— 真机上就栽在这里：固定回溯预算会把短块整块吞掉（最大 53%）。
  const uneven = [
    '短段一。',
    '中等长度的一段：' + '冰川侵蚀与冰蚀形貌研究进展。'.repeat(12),
    '很短。',
    '超长段落：' + '冰芯气泡记录提供古气候证据。'.repeat(60),
    '又一段短的。',
  ].join('\n\n');
  const unevenChunks = chunkText('ITEM0004', uneven, { tokenizer, maxTokens: 128, indexedPages: 4 });
  for (let index = 1; index < unevenChunks.length; index += 1) {
    const previous = unevenChunks[index - 1];
    const current = unevenChunks[index];
    const shared = tokenizer.countTokens(uneven.slice(current.charStart, previous.charEnd));
    const ratio = shared / previous.tokens;
    assert.ok(ratio >= 0.1 && ratio <= 0.15, `参差段落下的重叠越界：${ratio.toFixed(3)}（第 ${index} 块）`);
  }

  // 拿不到页数时页码必须为 null，而不是瞎编
  const noPages = chunkText('ITEM0002', content, { tokenizer, maxTokens: 128 });
  assert.equal(noPages[0].pageLabel, null);
  assert.equal(noPages[0].pageLabelEstimated, false);
  // 空正文
  assert.deepEqual(chunkText('ITEM0003', '   \n  ', { tokenizer, maxTokens: 64 }), []);
});

test('分块：超长无标点段落按 token 上限硬切，且仍然保留重叠', { skip: VOCAB_READY ? false : '本机没有模型词表缓存' }, () => {
  const tokenizer = tokenizerFromVocab();
  const content = '冰川'.repeat(600); // 1200 个汉字 ≈ 1200 token，无标点无换行
  const chunks = chunkText('ITEM0001', content, { tokenizer, maxTokens: 100 });
  assert.ok(chunks.length >= 10, `硬切应当产生足够多的块，实际 ${chunks.length}`);
  for (const chunk of chunks) {
    assert.ok(chunk.tokens <= 100, `硬切后仍不得超过上限：${chunk.tokens}`);
    assert.equal(content.slice(chunk.charStart, chunk.charEnd), chunk.text);
  }
  for (let index = 1; index < chunks.length; index += 1) {
    assert.ok(chunks[index].charStart < chunks[index - 1].charEnd, '硬切之间也要有重叠');
  }
});

// ── 3. 存储 ─────────────────────────────────────────────────────────────

test('存储：sqlite-vec 扩展可加载，KNN 按距离升序且 rowid 用 BigInt', { skip: VOCAB_READY ? false : '本机没有模型词表缓存' }, async () => {
  const extension = resolveVecExtension();
  assert.ok(existsSync(extension), `扩展不存在：${extension}`);
  const dir = tempDir('zotero-mcp-index-store-');
  const tokenizer = tokenizerFromVocab();
  const embedder = fakeEmbedder(8);
  try {
    const store = openIndexStore(dir, { modelId: 'fake-ngram', dim: 8, schemaVersion: 1 });
    try {
      // 内容要足够长才能切成多块（否则「与第二块最相似」没有对象）
      const content = ['冰川侵蚀与冰蚀形貌研究进展。', '海冰范围在北极夏季持续退缩。', '冰芯气泡记录提供古气候证据。']
        .map((line) => line.repeat(20))
        .join('\n\n');
      const chunks = chunkText('ITEM0001', content, { tokenizer, maxTokens: 64 });
      assert.ok(chunks.length >= 2, `至少要切成两块，实际 ${chunks.length}`);
      const vectors = await Promise.all(chunks.map((chunk) => embedder.embed([chunk.text]).then(([vector]) => vector)));
      store.replaceItem('ITEM0001', chunks, vectors, '2026-09-18T00:00:00.000Z');
      const status = store.status();
      assert.equal(status.items, 1);
      assert.equal(status.chunks, chunks.length);
      assert.equal(status.dim, 8);

      const probe = await embedder.embed([chunks[1].text]).then(([vector]) => vector);
      const hits = store.search(probe, 3);
      assert.equal(hits.length, Math.min(3, chunks.length));
      assert.equal(hits[0].itemKey, 'ITEM0001');
      assert.equal(hits[0].distance, 0, '与自己最相似');
      assert.ok(hits[0].distance <= (hits[1]?.distance ?? Number.POSITIVE_INFINITY), '必须按距离升序');
      assert.ok(hits[0].text.length > 0);
      assert.equal(typeof hits[0].pageLabelEstimated, 'boolean');

      // 覆盖写：同一条目重写不会留下孤儿向量
      store.replaceItem('ITEM0001', [chunks[0]], [vectors[0]], '2026-09-18T00:00:01.000Z');
      assert.equal(store.status().chunks, 1);
      assert.equal(store.item('ITEM0001').chunkCount, 1);
      // 删除
      store.removeItem('ITEM0001');
      assert.equal(store.status().chunks, 0);
      assert.equal(store.item('ITEM0001'), null);
    } finally {
      store.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. 索引：增量、幂等、重建 ───────────────────────────────────────────

function syntheticServer(count = 6, prefix = 'SYN') {
  const fulltext = {};
  const content = {};
  const pages = {};
  for (let index = 0; index < count; index += 1) {
    const key = `${prefix}${String(index).padStart(3, '0')}`;
    fulltext[key] = index + 1;
    content[key] = Array.from({ length: 4 }, (_, paragraph) => `[${key}-${paragraph}] ${'冰川侵蚀与冰蚀形貌研究进展。'.repeat(6)}`).join('\n\n');
    pages[key] = 4;
  }
  return { fulltext, content, pages };
}

test('索引：build 落库、update 幂等（内容未变零嵌入）、内容变化只重嵌该条目', { skip: VOCAB_READY ? false : '本机没有模型词表缓存' }, async () => {
  const corpus = syntheticServer(5);
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: { fulltext: corpus.fulltext }, fulltextContentMap: corpus.content, fulltextPages: corpus.pages });
  const indexDir = tempDir('zotero-mcp-index-inc-');
  const embedder = fakeEmbedder();
  try {
    const options = { baseUrl: fake.url, indexDir, embedder, downloadModel: false };
    const build = await buildIndex(options);
    assert.equal(build.action, 'build');
    assert.equal(build.changedItems, 5);
    assert.ok(build.embeddedChunks >= 5);
    assert.equal(build.skippedItems, 0);
    assert.ok(build.timings.totalMs >= 0);

    // 幂等路径 A：水位已推进，增量清单为空 → 本轮什么都不做
    const noop = await updateIndex({ ...options, indexDir });
    assert.equal(noop.manifestItems, 0, '水位之后没有变化项');
    assert.equal(noop.embeddedChunks, 0, '内容未变时不得再嵌入');
    assert.equal(noop.changedItems, 0);

    // 幂等路径 B：显式 since=0（清单把全部条目都报为“变化”），指纹相同仍必须跳过
    const again = await updateIndex({ ...options, indexDir, since: 0 });
    assert.equal(again.embeddedChunks, 0, '指纹未变时不得再嵌入');
    assert.equal(again.changedItems, 0);
    assert.equal(again.skippedItems, 5, '五条都应按内容指纹跳过');

    // 只改一条：把某个 key 的正文与版本一起改，然后再拉增量
    const target = 'SYN002';
    corpus.content[target] = `${corpus.content[target]}\n\n新增段落：冰芯气泡记录提供古气候证据。`;
    corpus.fulltext[target] = 99;
    const updatedFake = await startFakeZotero({ mode: 'ok', port: 0, library: { fulltext: corpus.fulltext }, fulltextContentMap: corpus.content, fulltextPages: corpus.pages });
    try {
      const changed = await updateIndex({ ...options, baseUrl: updatedFake.url });
      assert.equal(changed.changedItems, 1, '只有内容变化的那一条需要重嵌');
      assert.equal(changed.skippedItems, 0, '增量清单里只有变化项，其它条目本轮不参与');
      assert.ok(changed.embeddedChunks > 0);
      assert.equal(changed.removedItems, 0);
    } finally {
      await updatedFake.close();
    }
  } finally {
    await fake.close();
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test('索引：模型或维度变化时整库重建，不混用旧向量', { skip: VOCAB_READY ? false : '本机没有模型词表缓存' }, async () => {
  const corpus = syntheticServer(3);
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: { fulltext: corpus.fulltext }, fulltextContentMap: corpus.content, fulltextPages: corpus.pages });
  const indexDir = tempDir('zotero-mcp-index-model-');
  try {
    const first = fakeEmbedder(32);
    await buildIndex({ baseUrl: fake.url, indexDir, embedder: first, downloadModel: false });
    const statusA = openIndexStore(indexDir, { modelId: 'fake-ngram', dim: 32, schemaVersion: 1 });
    assert.equal(statusA.status().dim, 32);
    statusA.close();

    // 换成不同维度的模型再 update：必须整库重建
    const second = { ...fakeEmbedder(64), modelId: 'fake-ngram-v2' };
    const report = await updateIndex({ baseUrl: fake.url, indexDir, embedder: second, downloadModel: false });
    assert.equal(report.dim, 64);
    assert.equal(report.changedItems, 3, '维度变化后必须重嵌全部条目');
    const statusB = openIndexStore(indexDir, { modelId: 'fake-ngram-v2', dim: 64, schemaVersion: 1 });
    assert.equal(statusB.status().dim, 64);
    assert.equal(statusB.status().modelId, 'fake-ngram-v2');
    statusB.close();
  } finally {
    await fake.close();
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test('索引：全量清单里消失的条目会被清理', { skip: VOCAB_READY ? false : '本机没有模型词表缓存' }, async () => {
  const corpus = syntheticServer(4);
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: { fulltext: corpus.fulltext }, fulltextContentMap: corpus.content, fulltextPages: corpus.pages });
  const indexDir = tempDir('zotero-mcp-index-prune-');
  const embedder = fakeEmbedder();
  try {
    await buildIndex({ baseUrl: fake.url, indexDir, embedder, downloadModel: false });
    // 删掉一条（全量清单不再包含它），并把剩余条目的版本抬高以出现在增量清单里
    delete corpus.fulltext['SYN001'];
    delete corpus.content['SYN001'];
    corpus.fulltext['SYN000'] = 50;
    const pruned = await startFakeZotero({ mode: 'ok', port: 0, library: { fulltext: corpus.fulltext }, fulltextContentMap: corpus.content, fulltextPages: corpus.pages });
    try {
      const report = await updateIndex({ baseUrl: pruned.url, indexDir, embedder, downloadModel: false });
      assert.equal(report.removedItems, 1, '消失的条目必须从索引里清掉');
      const store = openIndexStore(indexDir, { modelId: 'fake-ngram', dim: 64, schemaVersion: 1 });
      assert.equal(store.item('SYN001'), null);
      assert.equal(store.status().items, 3);
      store.close();
    } finally {
      await pruned.close();
    }
  } finally {
    await fake.close();
    rmSync(indexDir, { recursive: true, force: true });
  }
});

// ── 5. 检索与降级 ───────────────────────────────────────────────────────

test('检索：段落级命中带完整溯源；charRange 切回的原文与命中文本一致', { skip: VOCAB_READY ? false : '本机没有模型词表缓存' }, async () => {
  const corpus = syntheticServer(3);
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: { fulltext: corpus.fulltext }, fulltextContentMap: corpus.content, fulltextPages: corpus.pages });
  const indexDir = tempDir('zotero-mcp-index-search-');
  const embedder = fakeEmbedder();
  try {
    await buildIndex({ baseUrl: fake.url, indexDir, embedder, downloadModel: false });
    const result = await semanticSearch('冰川侵蚀', { indexDir, embedder, baseUrl: fake.url, limit: 4 });
    assert.equal(result.degraded, false);
    assert.ok(result.hits.length > 0);
    assert.equal(result.dim, 64);
    for (const hit of result.hits) {
      assert.ok(hit.itemKey.startsWith('SYN'));
      assert.ok(hit.charRange.end > hit.charRange.start);
      assert.equal(corpus.content[hit.itemKey].slice(hit.charRange.start, hit.charRange.end), hit.text, 'charRange 必须能切回命中原文');
      assert.equal(typeof hit.pageLabelEstimated, 'boolean');
      assert.ok(hit.score <= 1.0000001 && hit.score >= -1.0000001);
    }
    for (let index = 1; index < result.hits.length; index += 1) {
      assert.ok(result.hits[index - 1].score >= result.hits[index].score, '必须按相似度降序');
    }
    // limit 上限保护
    const capped = await semanticSearch('冰川', { indexDir, embedder, baseUrl: fake.url, limit: 999 });
    assert.ok(capped.hits.length <= 50);
    // 空查询是参数错误而不是降级
    await assert.rejects(() => semanticSearch('   ', { indexDir, embedder }), /query 不能为空/u);
  } finally {
    await fake.close();
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test('降级：索引不存在 / 为空 / 模型缺失时如实降级，不抛未捕获异常', { skip: VOCAB_READY ? false : '本机没有模型词表缓存' }, async () => {
  const indexDir = tempDir('zotero-mcp-index-empty-');
  try {
    const missing = await semanticSearch('任意查询', { indexDir, embedder: fakeEmbedder(), limit: 3 });
    assert.equal(missing.degraded, true);
    assert.match(String(missing.reason), /索引文件不存在/u);
    assert.deepEqual(missing.hits, []);

    // 建了库但没有分块
    const empty = openIndexStore(indexDir, { modelId: 'fake-ngram', dim: 64, schemaVersion: 1 });
    empty.close();
    const none = await semanticSearch('任意查询', { indexDir, embedder: fakeEmbedder(), limit: 3 });
    assert.equal(none.degraded, true);
    assert.match(String(none.reason), /还没有任何分块/u);

    // 索引有向量但模型不可用（本地无模型缓存且不允许下载）
    const corpus = syntheticServer(2);
    const fake = await startFakeZotero({ mode: 'ok', port: 0, library: { fulltext: corpus.fulltext }, fulltextContentMap: corpus.content, fulltextPages: corpus.pages });
    const builtDir = tempDir('zotero-mcp-index-degraded-');
    try {
      await buildIndex({ baseUrl: fake.url, indexDir: builtDir, embedder: fakeEmbedder(), downloadModel: false });
      const blocked = await semanticSearch('冰川', { indexDir: builtDir, modelsDir: join(tmpdir(), 'zotero-mcp-no-such-models'), limit: 3 });
      assert.equal(blocked.degraded, true);
      assert.match(String(blocked.reason), /本地嵌入不可用/u);
      assert.deepEqual(blocked.hits, []);
    } finally {
      await fake.close();
      rmSync(builtDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test('余弦换算：距离 → 相似度单调且落在 [-1, 1]', () => {
  assert.equal(scoreFromDistance(0), 1);
  assert.ok(Math.abs(scoreFromDistance(Math.SQRT2)) < 1e-9, '正交向量相似度为 0');
  assert.ok(scoreFromDistance(0.5) > scoreFromDistance(1));
  assert.ok(scoreFromDistance(10) >= -1);
});

// ── 6. 工具面 ───────────────────────────────────────────────────────────

test('工具面：公开工具清单与 write-tools 口径一致，zotero_index 只读且不在写总闸里，语义检索走工具层', async () => {
  assert.equal(ALL_TOOLS.length, 24);
  assert.equal(TOOL_NAMES.length, 24);
  assert.ok(TOOL_NAMES.includes('zotero_index'));
  assert.equal(GATED_TOOL_NAME_SET.has('zotero_index'), false, 'zotero_index 只读文库，不该受 ZOTERO_MCP_WRITE 门禁');
  assert.ok(GATED_TOOL_NAME_SET.has('zotero_merge_duplicates'), '既有门禁不受影响');

  const corpus = syntheticServer(2);
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: { fulltext: corpus.fulltext }, fulltextContentMap: corpus.content, fulltextPages: corpus.pages });
  const indexDir = tempDir('zotero-mcp-index-tools-');
  const previous = { base: process.env['ZOTERO_MCP_BASE_URL'], index: process.env['ZOTERO_MCP_INDEX_DIR'], write: process.env['ZOTERO_MCP_WRITE'] };
  process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
  process.env['ZOTERO_MCP_INDEX_DIR'] = indexDir;
  delete process.env['ZOTERO_MCP_WRITE'];
  const server = createMcpServer();
  const client = new Client({ name: 'semantic-index-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const parse = (result) => JSON.parse(String(result.content[0]?.text ?? 'null'));
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 24);
    const indexTool = tools.find((entry) => entry.name === 'zotero_index');
    assert.ok(indexTool, '缺少 zotero_index');
    assert.deepEqual(indexTool.inputSchema.properties.action.enum, ['build', 'update', 'status']);
    assert.deepEqual([...indexTool.inputSchema.required], ['action']);
    const searchTool = tools.find((entry) => entry.name === 'zotero_search');
    assert.deepEqual(searchTool.inputSchema.properties.mode.enum, ['keyword', 'fulltext', 'saved', 'semantic']);

    // 规格要求的 model 参数：默认可省；未知取值必须可读拒绝且**不回落缺省**（Q1 起支持中文模型）
    const unknownModel = await client.callTool({ name: 'zotero_index', arguments: { action: 'status', model: 'no-such-model' } });
    assert.equal(unknownModel.isError, true);
    assert.match(String(unknownModel.content[0].text), /未知的语义模型/u);
    const chineseModel = parse(await client.callTool({ name: 'zotero_index', arguments: { action: 'status', model: 'chinese' } }));
    assert.equal(chineseModel.model.modelId, 'bge-small-zh-v1.5-quantized');
    const defaultModel = parse(await client.callTool({ name: 'zotero_index', arguments: { action: 'status', model: 'all-MiniLM-L6-v2-quantized' } }));
    assert.equal(defaultModel.exists, false);

    // status 只读、不建库、不需要写开关
    const status = parse(await client.callTool({ name: 'zotero_index', arguments: { action: 'status' } }));
    assert.equal(status.exists, false);
    assert.equal(status.degraded, true);
    assert.equal(fake.requests.filter((request) => request.method !== 'GET').length, 0, '索引任何动作都不得写文库');

    // 语义检索在没有索引时必须降级（而不是报错）
    const degraded = parse(await client.callTool({ name: 'zotero_search', arguments: { mode: 'semantic', query: '冰川' } }));
    assert.equal(degraded.degraded, true);
    assert.deepEqual(degraded.hits, []);
    assert.ok(degraded.reason.length > 0);

    // 缺 query 被拒
    const refused = await client.callTool({ name: 'zotero_search', arguments: { mode: 'semantic' } });
    assert.equal(refused.isError, true);
    assert.match(String(refused.content[0].text), /必须提供 query/u);
  } finally {
    await client.close();
    await server.close();
    await fake.close();
    rmSync(indexDir, { recursive: true, force: true });
    if (previous.base === undefined) delete process.env['ZOTERO_MCP_BASE_URL'];
    else process.env['ZOTERO_MCP_BASE_URL'] = previous.base;
    if (previous.index === undefined) delete process.env['ZOTERO_MCP_INDEX_DIR'];
    else process.env['ZOTERO_MCP_INDEX_DIR'] = previous.index;
    if (previous.write !== undefined) process.env['ZOTERO_MCP_WRITE'] = previous.write;
  }
});

// ── 7. 真实模型（有缓存才跑） ───────────────────────────────────────────

test('真实模型：维度 384、输出 L2 归一化、同一文本可复现', { skip: MODEL_READY ? false : '本机没有模型缓存（外部条件）' }, async () => {
  const { createEmbedder } = await import('../../packages/indexer/src/index.ts');
  const embedder = await createEmbedder({ modelsDir: MODELS_DIR, download: false });
  try {
    assert.equal(embedder.modelId, DEFAULT_MODEL.id);
    assert.equal(embedder.dim, 384);
    const [first] = await embedder.embed(['冰川侵蚀作用与冰蚀形貌研究进展']);
    const [second] = await embedder.embed(['冰川侵蚀作用与冰蚀形貌研究进展']);
    assert.equal(first.length, 384);
    const norm = Math.sqrt(first.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(norm - 1) < 1e-5, `必须 L2 归一化，实际 ${norm}`);
    let dot = 0;
    for (let index = 0; index < first.length; index += 1) dot += first[index] * second[index];
    assert.ok(dot > 0.999, `同一文本两次编码必须几乎一致，实际余弦 ${dot}`);
    // 不同语义的文本不应完全一样
    const [other] = await embedder.embed(['approximate nearest neighbour vector search']);
    let cross = 0;
    for (let index = 0; index < first.length; index += 1) cross += first[index] * other[index];
    assert.ok(cross < 0.999, '不同文本不应给出相同向量');
  } finally {
    await embedder.dispose();
  }
});

// ── 8. 基准索引库的清理与护栏（report:index --cleanup） ──────────────────

test('A5/A6 基准目录：--cleanup 自收尾，不带时保留', async () => {
  const benchDir = join(tempDir('zotero-mcp-bench-'), 'index');
  try {
    // 不带 --cleanup：目录保留（与加该参数之前的行为一致）
    const plain = await execFileAsync(process.execPath, [REPORT_SCRIPT, '--synthetic', '12', '--index-dir', benchDir], {
      cwd: ROOT,
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(existsSync(benchDir), true, '不带 --cleanup 时基准目录必须保留');
    assert.doesNotMatch(plain.stdout, /--cleanup：已删除/u);
    const sizeBefore = statSync(join(benchDir, 'index.db')).size;
    assert.ok(sizeBefore > 0);

    // 带 --cleanup：目录被删除且打印释放体积
    const cleaned = await execFileAsync(
      process.execPath,
      [REPORT_SCRIPT, '--synthetic', '12', '--index-dir', benchDir, '--cleanup'],
      { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 },
    );
    assert.equal(existsSync(benchDir), false, '--cleanup 后基准目录必须被删除');
    assert.match(cleaned.stdout, /--cleanup：已删除/u);
    assert.match(cleaned.stdout, /释放 [\d.]+ (B|KB|MB|GB)/u);
  } finally {
    rmSync(join(benchDir, '..'), { recursive: true, force: true });
  }
});

test('A7 护栏：合成基准不得写进真机索引目录；--cleanup 与 --keep 互斥', async () => {
  const realIndexDir = join(ROOT, 'cache', 'index');
  const before = existsSync(realIndexDir) ? statSync(join(realIndexDir, 'index.db')).mtimeMs : null;

  // 合成基准指向 cache/index：必须在构建之前拒绝，且真机索引目录原样不动
  const refused = await execFileAsync(
    process.execPath,
    [REPORT_SCRIPT, '--synthetic', '12', '--index-dir', realIndexDir, '--cleanup'],
    { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 },
  ).then(
    (result) => ({ code: 0, stdout: result.stdout }),
    (error) => ({ code: typeof error.code === 'number' ? error.code : -1, stdout: String(error.stdout ?? '') }),
  );
  assert.equal(refused.code, 2, '应被拒绝并以退出码 2 结束');
  assert.match(refused.stdout, /默认真机索引目录/u);
  if (before !== null) {
    assert.equal(statSync(join(realIndexDir, 'index.db')).mtimeMs, before, '真机索引必须原样不动');
  }

  // --cleanup 与 --keep 互斥
  const benchDir = join(tempDir('zotero-mcp-bench-keep-'), 'index');
  try {
    const conflict = await execFileAsync(
      process.execPath,
      [REPORT_SCRIPT, '--synthetic', '12', '--index-dir', benchDir, '--cleanup', '--keep'],
      { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 },
    ).then(
      (result) => ({ code: 0, stdout: result.stdout }),
      (error) => ({ code: typeof error.code === 'number' ? error.code : -1, stdout: String(error.stdout ?? '') }),
    );
    assert.equal(conflict.code, 2, '互斥参数应被拒绝');
    assert.match(conflict.stdout, /互斥/u);
    assert.equal(existsSync(benchDir), true, '被拒绝时不得删除任何目录');
  } finally {
    rmSync(join(benchDir, '..'), { recursive: true, force: true });
  }
});

// ── Q1：词表选项、模型选择与输出形状校验（change · chinese-semantic-index） ──

test('Q1 分词选项：cased 保留大小写、cjk 逐字切分，缺省行为不变', () => {
  // 缺省（uncased + 逐字切分 CJK）：既有英文模型的行为，不得改变
  assert.deepEqual(basicTokenize('Hello World'), ['hello', 'world']);
  assert.deepEqual(basicTokenize('冰川侵蚀'), ['冰', '川', '侵', '蚀']);
  // cased：保留大小写（中文/多语种 BertTokenizer 的 do_lower_case=false）
  assert.deepEqual(basicTokenize('Hello World', { cased: true }), ['Hello', 'World']);
  assert.deepEqual(basicTokenize('Hello', { cased: true }), ['Hello']);
  // cjk=false：不再逐字切分（中日韩字符留在同一个词里）
  assert.deepEqual(basicTokenize('冰川侵蚀', { cjk: false }), ['冰川侵蚀']);
  // 中文标点仍单独成词
  assert.deepEqual(basicTokenize('冰川，侵蚀'), ['冰', '川', '，', '侵', '蚀']);
});

test('Q1 模型选择：别名与 id 均可解析，未知值必须可读拒绝（不回落缺省）', () => {
  assert.equal(resolveModelSpec('default').id, DEFAULT_MODEL.id);
  assert.equal(resolveModelSpec('english').id, DEFAULT_MODEL.id);
  assert.equal(resolveModelSpec('chinese').id, 'bge-small-zh-v1.5-quantized');
  assert.equal(resolveModelSpec(CHINESE_MODEL.id).id, CHINESE_MODEL.id);
  assert.equal(resolveModelSpec(undefined, {}).id, DEFAULT_MODEL.id, '未设置时保持缺省');
  assert.equal(resolveModelSpec(undefined, { ZOTERO_MCP_INDEX_MODEL: 'zh' }).id, CHINESE_MODEL.id);
  assert.throws(() => resolveModelSpec('no-such-model'), /未知的语义模型/u);
  // 注册表内容：中文模型在册，且维度/词表选项与上游 tokenizer_config 一致
  assert.equal(MODEL_REGISTRY[CHINESE_MODEL.id]?.dim, 512);
  assert.deepEqual(CHINESE_MODEL.tokenizer, { cased: true, cjk: true });
  // 多语种模型现在**在册**：XLM-R 系（SentencePiece unigram 分词器，dim 384）；别名 multilingual / multi
  assert.equal(MODEL_REGISTRY[MULTILINGUAL_MODEL.id]?.dim, 384);
  assert.equal(MULTILINGUAL_MODEL.tokenizerKind, 'unigram');
  assert.equal(resolveModelSpec('multilingual').id, MULTILINGUAL_MODEL.id);
  assert.equal(resolveModelSpec('multi').id, MULTILINGUAL_MODEL.id);
  // 被排除的是**上游只导出 MLM 头**的那些：mBERT 首输出是 logits，不能当句子编码器
  assert.equal(MODEL_REGISTRY['bert-base-multilingual-cased'], undefined, 'mBERT 上游只有 MLM 头，不得在册');
  assert.equal(MODEL_REGISTRY['distilbert-base-multilingual-cased'], undefined, '该模型上游无 ONNX，不得在册');
});

test('Q1 输出形状校验：MLM 头导出必须被拒，优先取序列级输出', () => {
  // 真机实测：Xenova/bert-base-multilingual-cased 的第一个输出是 logits [1, seq, 119547]
  assert.equal(pickSequenceOutputName(['logits'], () => [1, 9, 119547], 768), null, 'MLM 头必须被拒绝');
  assert.equal(pickSequenceOutputName(['last_hidden_state'], () => [1, 9, 768], 768), 'last_hidden_state');
  assert.equal(
    pickSequenceOutputName(['pooler_output', 'last_hidden_state'], (name) => (name === 'pooler_output' ? [1, 768] : [1, 9, 768]), 768),
    'last_hidden_state',
    '二维池化输出不能取代序列级输出',
  );
  assert.equal(pickSequenceOutputName(['last_hidden_state'], () => [1, 9, 384], 768), null, '维度不符必须拒绝');
  assert.equal(pickSequenceOutputName([], () => null, 768), null);
});

test('Q1 索引与模型不匹配：状态必须报「需重建」而不是混用', { skip: VOCAB_READY ? false : '本机没有模型词表缓存' }, async () => {
  const corpus = syntheticServer(2);
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: { fulltext: corpus.fulltext }, fulltextContentMap: corpus.content, fulltextPages: corpus.pages });
  const indexDir = tempDir('zotero-mcp-index-q1-');
  try {
    await buildIndex({ baseUrl: fake.url, indexDir, embedder: fakeEmbedder(32), downloadModel: false });
    // 用缺省模型查状态：索引是 fake-ngram(32) 建的 → 必须报需重建
    const mismatched = indexStatus({ indexDir, model: DEFAULT_MODEL.id });
    assert.equal(mismatched.degraded, true);
    assert.match(String(mismatched.reason), /另一个模型|重建/u);
    assert.equal(mismatched.modelId, 'fake-ngram');
  } finally {
    await fake.close();
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test('Q1 同维不同模型：搜索路径也必须报「需重建」，不得静默复用旧索引', { skip: VOCAB_READY ? false : '本机没有模型词表缓存' }, async () => {
  const corpus = syntheticServer(2);
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: { fulltext: corpus.fulltext }, fulltextContentMap: corpus.content, fulltextPages: corpus.pages });
  const indexDir = tempDir('zotero-mcp-index-samedim-');
  try {
    await buildIndex({ baseUrl: fake.url, indexDir, embedder: fakeEmbedder(32), downloadModel: false });
    // 维度相同（32）但 model_id 不同的检索器：必须降级并给「需重建」的可读原因，
    // 绝不能返回旧索引的命中（多语种模型与缺省英文模型同为 384 维，正是这条路径）
    const result = await semanticSearch('冰川', {
      indexDir,
      embedder: { ...fakeEmbedder(32), modelId: 'fake-ngram-2' },
    });
    assert.equal(result.degraded, true, '同维不同模型必须降级，不得静默复用旧索引');
    assert.match(String(result.reason), /另一个模型|重建/u);
    assert.equal(result.hits.length, 0);
  } finally {
    await fake.close();
    rmSync(indexDir, { recursive: true, force: true });
  }
});

test('水位单调：库未变的增量 update 不得把 watermark 写回 0', { skip: VOCAB_READY ? false : '本机没有模型词表缓存' }, async () => {
  const corpus = syntheticServer(3);
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: { fulltext: corpus.fulltext }, fulltextContentMap: corpus.content, fulltextPages: corpus.pages });
  const indexDir = tempDir('zotero-mcp-index-watermark-');
  try {
    const options = { baseUrl: fake.url, indexDir, embedder: fakeEmbedder(), downloadModel: false };
    const build = await buildIndex(options);
    assert.equal(build.action, 'build');
    const afterBuild = readIndexStatus(indexDir).watermark;
    assert.ok(afterBuild > 0, `build 后水位应大于 0，实际 ${afterBuild}`);

    // 库未变的增量：清单为空、零嵌入，且**水位不得倒退**（此前会写成 0，导致下一轮退化为全量清单扫描）
    const noop = await updateIndex({ ...options, indexDir });
    assert.equal(noop.manifestItems, 0, '水位之后没有变化项');
    assert.equal(noop.embeddedChunks, 0, '内容未变时不得再嵌入');
    const afterNoop = readIndexStatus(indexDir).watermark;
    assert.equal(afterNoop, afterBuild, '清单为空时水位必须保持不变，不得写回 0');

    // 反证：内容真的变化时水位必须前进（单调但不等同于「永不变化」）
    const target = 'SYN002';
    corpus.content[target] = `${corpus.content[target]}

新增段落：冰芯气泡记录。`;
    corpus.fulltext[target] = 42;
    const changedFake = await startFakeZotero({ mode: 'ok', port: 0, library: { fulltext: corpus.fulltext }, fulltextContentMap: corpus.content, fulltextPages: corpus.pages });
    try {
      const changed = await updateIndex({ ...options, baseUrl: changedFake.url });
      assert.equal(changed.changedItems, 1);
      const afterChange = readIndexStatus(indexDir).watermark;
      assert.equal(afterChange, 42, '新水位应取变化条目的版本');
      assert.ok(afterChange >= afterBuild, '水位必须单调不减');
    } finally {
      await changedFake.close();
    }
  } finally {
    await fake.close();
    rmSync(indexDir, { recursive: true, force: true });
  }
});
