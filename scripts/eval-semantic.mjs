#!/usr/bin/env node
/**
 * 语义检索评测入口（Q1 中文语义质量）。
 *
 *   npm run eval:semantic                                   # 用内置中英查询集，评测当前模型与索引
 *   npm run eval:semantic -- --queries <file.json>          # 自定义查询集
 *   ZOTERO_MCP_INDEX_MODEL=chinese npm run eval:semantic    # 换模型（索引需同模型重建）
 *
 * 每条查询输出：top-3（itemKey / 分数 / 段落片段）、是否命中期望条目、以及该查询在**当前模型词表**下的
 * `[UNK]` 比例——后者正是「中文为什么检索不到」的量化说明：英文 MiniLM 的词表只收录部分汉字。
 *
 * 只读：不建索引、不下载模型、不写库。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dedupeHitsByItem } from './lib/semantic-eval-hits.mjs';
import { join } from 'node:path';

import { inspectModel, modelDir, resolveModelSpec } from '../packages/indexer/src/embedder.ts';
import { createTokenizer } from '../packages/indexer/src/tokenizer.ts';
import { createUnigramTokenizer } from '../packages/indexer/src/tokenizer-unigram.ts';
import { defaultModelsDir, indexStatus, resolveIndexDir, semanticSearch } from '../packages/indexer/src/index.ts';

/**
 * 内置查询集。注意：索引里的 `itemKey` 是**附件 key**（分块从附件全文来），不是顶层条目 key——
 * 因此这里的期望值是附件 key（例如中文条目 KCYL5BT7 的 PDF 是 VB5XMKWL）。
 */
const BUILTIN_QUERIES = [
  // —— 中文正例（期望命中中文冰川侵蚀论文 VB5XMKWL）
  { query: '新元古代冰川侵蚀作用与冰蚀形貌', expect: 'VB5XMKWL', lang: 'zh' },
  { query: '冰川侵蚀地貌研究进展', expect: 'VB5XMKWL', lang: 'zh' },
  { query: '冰蚀形貌 冰川作用', expect: 'VB5XMKWL', lang: 'zh' },
  { query: '冰川侵蚀与气候变化的联系', expect: 'VB5XMKWL', lang: 'zh' },
  { query: '冰蚀地貌的形成机制与影响因素', expect: 'VB5XMKWL', lang: 'zh' },
  // —— 中文跨语言正例（中文查询 → 英文文献）
  { query: '海冰细菌的冰核活性', expect: 'HJ32SMX8', expectNot: 'VB5XMKWL', lang: 'zh' },
  { query: '海冰模型中的波浪与冰相互作用', expect: '73XDRV8R', expectNot: 'VB5XMKWL', lang: 'zh' },
  { query: '新疆的冰川径流模拟', expect: 'LBQVM3HE', expectNot: 'VB5XMKWL', lang: 'zh' },
  // —— 英文回归集（保持原有）
  { query: 'ice nucleation spectra of sea-ice bacteria', expect: 'HJ32SMX8', lang: 'en' },
  { query: 'wave-ice interactions in the neXtSIM sea-ice model', expect: '73XDRV8R', lang: 'en' },
  { query: 'shear margin melting transient ice discharge', expect: 'FL7QGGAX', lang: 'en' },
  { query: 'glacier runoff simulation Xinjiang', expect: 'LBQVM3HE', lang: 'en' },
];

const argv = process.argv.slice(2);
const valueOf = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : argv[index + 1] ?? null;
};

const queriesArg = valueOf('queries');
const indexDir = valueOf('index-dir') ?? resolveIndexDir();
const modelsDir = valueOf('models-dir') ?? defaultModelsDir();
const limit = Number(valueOf('limit') ?? '3');
const asJson = argv.includes('--json');

let spec;
try {
  spec = resolveModelSpec(valueOf('model') ?? undefined);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

const queries = queriesArg === null ? BUILTIN_QUERIES : JSON.parse(readFileSync(queriesArg, 'utf8'));
if (!Array.isArray(queries) || queries.length === 0) {
  console.error('查询集必须是非空数组：[{ "query": "…", "expect": "ITEMKEY", "lang": "zh" }]');
  process.exit(2);
}

const status = indexStatus({ indexDir, modelsDir, model: spec.id });
if (!existsSync(indexDir)) {
  console.error(`索引不存在（${indexDir}）：请先建索引（MCP 工具 zotero_index(action=build)，或本地跑 npm run report:index）。`);
  process.exit(1);
}
if (status.degraded) {
  console.error(`索引不可用：${status.reason ?? '未知原因'}`);
  process.exit(1);
}

const modelStatus = inspectModel(modelsDir, spec);
if (!modelStatus.available) {
  console.error(`模型不可用（${spec.id}）：${modelStatus.reason ?? '未知原因'}（缺少资产时先跑一次建索引以下载）`);
  process.exit(1);
}

// 词表：用来量化查询在当前模型下的 [UNK] 比例
// BERT 系读 `vocab.txt`（WordPiece）；XLM-R 系读 `tokenizer.json`（SentencePiece unigram，Viterbi）
const tokenizer =
  spec.tokenizerKind === 'unigram'
    ? createUnigramTokenizer(readFileSync(join(modelDir(modelsDir, spec), 'tokenizer.json'), 'utf8'), {})
    : createTokenizer(readFileSync(join(modelDir(modelsDir, spec), 'vocab.txt'), 'utf8'), {
        cased: spec.tokenizer?.cased === true,
        cjk: spec.tokenizer?.cjk !== false,
      });
const unkId = tokenizer.vocab.get('[UNK]') ?? tokenizer.vocab.get('<unk>');
const unkRatio = (text) => {
  const ids = tokenizer.encode(text).ids;
  const content = ids.slice(1, -1); // 去掉 [CLS] / [SEP]
  if (content.length === 0) return { tokens: 0, unk: 0, ratio: 0 };
  const unk = content.filter((id) => id === unkId).length;
  return { tokens: content.length, unk, ratio: unk / content.length };
};

const results = [];
const startedAt = Date.now();
for (const entry of queries) {
  const search = await semanticSearch(entry.query, { limit, indexDir, modelsDir, model: spec.id });
  if (search.degraded) {
    console.error(`检索降级：${search.reason ?? '未知原因'}`);
    process.exit(1);
  }
  // 段落级检索会返回同一附件的多个分块：命中判定按**条目级**算——
  // 每篇只占一个名次，且**显式取该篇的最高分块**（不依赖 search.hits 的排序）。
  const hits = dedupeHitsByItem(search.hits);
  const keys = hits.map((hit) => hit.itemKey);
  const unk = unkRatio(entry.query);
  results.push({
    query: entry.query,
    lang: entry.lang ?? null,
    expect: entry.expect ?? null,
    expectNot: entry.expectNot ?? null,
    // 负例/近似干扰：**不允许**被点名的无关条目排到第一
    negViolation: entry.expectNot === undefined ? null : keys[0] === entry.expectNot,
    topKeys: keys,
    top1Hit: entry.expect === null ? null : keys[0] === entry.expect,
    topNHit: entry.expect === null ? null : keys.includes(entry.expect),
    unk,
    hits: hits.map((hit) => ({ itemKey: hit.itemKey, score: Number(Number(hit.score).toFixed(4)), snippet: String(hit.text ?? '').slice(0, 60) })),
  });
}
const elapsedMs = Date.now() - startedAt;

const scored = results.filter((entry) => entry.expect !== null);
const top1 = scored.filter((entry) => entry.top1Hit === true).length;
const topN = scored.filter((entry) => entry.topNHit === true).length;
const zh = scored.filter((entry) => entry.lang === 'zh');
const en = scored.filter((entry) => entry.lang === 'en');
const avgUnk = (list) => (list.length === 0 ? 0 : list.reduce((sum, entry) => sum + entry.unk.ratio, 0) / list.length);
const summary = {
  model: { id: spec.id, dim: spec.dim },
  indexDir,
  queries: results.length,
  top1: `${top1}/${scored.length}`,
  topN: `${topN}/${scored.length}`,
  zhTop1: `${zh.filter((entry) => entry.top1Hit === true).length}/${zh.length}`,
  zhAvgUnkRatio: Number(avgUnk(zh).toFixed(3)),
  enTop1: `${en.filter((entry) => entry.top1Hit === true).length}/${en.length}`,
  enAvgUnkRatio: Number(avgUnk(en).toFixed(3)),
  // 负例/近似干扰（追加字段，既有字段保持不变）：被点名条目被排到第一的次数
  neg: {
    total: results.filter((entry) => entry.negViolation !== null).length,
    violations: results.filter((entry) => entry.negViolation === true).length,
  },
  elapsedMs,
};

if (asJson) {
  console.log(JSON.stringify({ summary, results }, null, 2));
} else {
  console.log(`语义检索评测 · 模型 ${spec.id}（dim ${spec.dim}）· 索引 ${indexDir}`);
  console.log('');
  for (const entry of results) {
    const mark = entry.expect === null ? '·' : entry.topNHit === true ? (entry.top1Hit === true ? '✔' : '≈') : '✖';
    const unkText = entry.unk.tokens === 0 ? 'n/a' : `${entry.unk.unk}/${entry.unk.tokens}=${(entry.unk.ratio * 100).toFixed(0)}%`;
    console.log(`${mark} [${entry.lang ?? '?'}] ${entry.query}`);
    console.log(`    期望 ${entry.expect ?? '(无)'} · 实际 top-${entry.topKeys.length}: ${entry.topKeys.join(', ') || '(无命中)'} · [UNK] ${unkText}`);
    for (const hit of entry.hits) console.log(`      ${hit.score.toFixed(4)}  ${hit.itemKey}  ${hit.snippet}`);
  }
  console.log('');
  console.log(`汇总：top-1 ${summary.top1}｜top-${limit} ${summary.topN}｜中文 top-1 ${summary.zhTop1}（平均 [UNK] ${(summary.zhAvgUnkRatio * 100).toFixed(0)}%）｜英文 top-1 ${summary.enTop1}（平均 [UNK] ${(summary.enAvgUnkRatio * 100).toFixed(0)}%）｜负例违规 ${summary.neg.violations}/${summary.neg.total}｜耗时 ${elapsedMs} ms`);
}

const failed = (scored.length > 0 && topN < scored.length) || summary.neg.violations > 0;
process.exitCode = failed ? 1 : 0;
