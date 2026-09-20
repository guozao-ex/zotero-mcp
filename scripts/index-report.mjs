#!/usr/bin/env node
/**
 * 语义索引报告（`npm run report:index`）。
 *
 * 两种模式，都**只读文库**：
 *   - 缺省（真机）：对当前 Zotero 库建/更索引，打印逐阶段耗时、条目与分块计数，再跑几条样例查询
 *     给出段落级命中（含 `itemKey`、字符区间、页码与估算标记）。
 *   - `--synthetic <N>`：用假本地 API 现场生成 N 篇合成语料再索引，用于复现路线图 M5 的
 *     「1000 篇增量索引 < 5 分钟」口径（真机库只有十几篇，且不允许为了压测往真实库灌数据）。
 *
 * 写入只发生在本地缓存（`cache/index`、`cache/models`）；不写文库、不写审计、不写快照。
 *
 * 基准磁盘收尾：`--synthetic` 缺省把索引建在系统临时目录并在结束时删除；用 `--index-dir <dir>`
 * 复用基准目录时会**保留**它（合成 1000 篇的索引库是上百 MB 量级），跑完想自收尾就加 `--cleanup`：
 * 删除目标目录并打印释放的体积。护栏：目标等于默认真机索引目录（`cache/index`）时拒绝删除；
 * `--cleanup` 与 `--keep` 互斥。不带 `--cleanup` 时行为与加它之前逐字一致。
 */

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { buildIndex, indexStatus, semanticSearch, updateIndex } from '../packages/indexer/src/index.ts';
import { startFakeZotero } from './fake-zotero.mjs';

const NEWLINE_PAIR = String.fromCharCode(10) + String.fromCharCode(10);

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (argv[index + 1] ?? true);
};

/**
 * 合成语料：N 篇附件。
 *
 * 密度按**典型论文**取：每篇约 20 段、每段约 500 token（恰好一块），即约 20 个分块 / 篇。
 * 这个数字是公开可核对的：报告会打印分块数与均摊耗时，读者可以按自己的库密度换算。
 */
function syntheticCorpus(count) {
  const topics = [
    'glacier erosion and cirque landforms in high mountain regions',
    'sea ice extent decline in the Arctic observed by satellite remote sensing',
    'ice core bubble records reconstruct atmospheric carbon dioxide over 800 kyr',
    'transformer self-attention replaces recurrence for long-range dependency modelling',
    'quantized inference compresses weights to int8 for local CPU deployment',
    'approximate nearest neighbour indexes answer million-scale vector queries',
    '冰川侵蚀作用与冰蚀形貌研究进展，冰斗与刃脊是典型组合',
    '海冰范围在北极夏季持续退缩，遥感记录显示每十年减少约百分之十三',
  ];
  const PARAGRAPHS_PER_ITEM = 20;
  const fulltext = {};
  const content = {};
  const pages = {};
  for (let index = 0; index < count; index += 1) {
    const key = `SYN${String(index).padStart(5, '0')}`;
    const paragraphs = [];
    for (let paragraph = 0; paragraph < PARAGRAPHS_PER_ITEM; paragraph += 1) {
      const topic = topics[(index + paragraph) % topics.length];
      // 重复到接近 500 token：略低于模型上限，使每段恰好落成一个分块
      paragraphs.push(`[${key}-${paragraph}] ${Array.from({ length: 38 }, () => topic).join('. ')}.`);
    }
    content[key] = paragraphs.join(NEWLINE_PAIR);
    fulltext[key] = index + 1;
    pages[key] = PARAGRAPHS_PER_ITEM;
  }
  return { fulltext, content, pages };
}

function say(line) {
  console.log(line);
}

/** 目录体积（字节）；目录不存在或读不到时返回 0。 */
function directorySize(dir) {
  let total = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += statSync(full).size;
        } catch {
          // 读不到就跳过：体积只用于打印，不影响删除
        }
      }
    }
  };
  walk(dir);
  return total;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

const syntheticArg = flag('synthetic', null);
const isSynthetic = syntheticArg !== null && syntheticArg !== false;
const keep = argv.includes('--keep');

let server = null;
const cleanup = [];
const options = { downloadModel: flag('no-download', false) !== true };

if (isSynthetic) {
  const count = Number(syntheticArg) || 1000;
  const reuseDir = flag('index-dir', null);
  // 前置护栏（比在清理阶段更早）：合成基准绝不允许写进默认真机索引目录——那样会先把你的真实索引
  // 覆盖掉，再谈删不删已经晚了。宁可在这里拒绝。
  const realIndexDir = indexStatus().dir;
  if (reuseDir !== null && reuseDir !== false && resolve(String(reuseDir)) === resolve(String(realIndexDir))) {
    say(`拒绝：--index-dir 指向默认真机索引目录（${realIndexDir}），合成基准会覆盖你的真实索引。`);
    say('请换一个基准目录（例如 /tmp/… 或 .audit/…），或省略 --index-dir 让它用系统临时目录。');
    process.exit(2);
  }
  const corpus = syntheticCorpus(count);
  server = await startFakeZotero({ mode: 'ok', port: 0, library: { fulltext: corpus.fulltext }, fulltextContentMap: corpus.content, fulltextPages: corpus.pages });
  options.baseUrl = server.url;
  options.indexDir = reuseDir === null || reuseDir === false ? mkdtempSync(join(tmpdir(), 'zotero-mcp-index-synthetic-')) : String(reuseDir);
  options.modelsDir = flag('models', undefined);
  cleanup.push(() => server?.close());
  if (!keep && (reuseDir === null || reuseDir === false)) cleanup.push(() => rmSync(options.indexDir, { recursive: true, force: true }));
  say(`合成语料：${count} 篇（假本地 API ${server.url}）`);
} else {
  say('真机模式：对当前 Zotero 库建/更索引（只读文库）');
}

say(`索引目录：${options.indexDir ?? indexStatus().dir}`);
say(`模型目录：${options.modelsDir ?? '(缺省 cache/models)'}`);

const before = indexStatus({ ...(options.indexDir === undefined ? {} : { indexDir: options.indexDir }), ...(options.modelsDir === undefined ? {} : { modelsDir: options.modelsDir }) });
say(`索引现状：${before.exists ? `${before.items} 条目 / ${before.chunks} 分块（模型 ${before.modelId}，水位 ${before.watermark}）` : '不存在'}`);
// 当前选择（ZOTERO_MCP_INDEX_MODEL / --model）与索引里的模型是否一致：不一致必须显式说清，
// 因为这个脚本的缺省行为会**按当前选择重建/更新索引**（它不是只读报告）。
say(`索引模型：${before.modelId ?? '(无)'} dim=${before.dim ?? '?'}｜当前选择：${before.model.modelId} dim=${before.model.dim}`);
if (before.degraded && before.reason !== null) {
  say(`索引状态：⚠️ ${before.reason}`);
  if (String(before.reason).includes('另一个模型')) say('  → 需重建：下面会按当前选择的模型整库重建（这是本脚本缺省行为）。');
} else {
  say('索引状态：✔ 可用（与当前选择一致）');
}
say(`模型资产：${before.model.available ? '已就绪' : `缺失（${before.model.reason ?? '未知原因'}）`}`);
if (!before.model.available && before.model.reason !== null) say('  → 需要重建时先跑一次 build/update 以下载模型。');

const started = Date.now();
const action = before.exists && before.chunks > 0 ? 'update' : 'build';
const report = action === 'build' ? await buildIndex(options) : await updateIndex(options);
const wall = Date.now() - started;

say('');
say(`== ${action} 完成（${(wall / 1000).toFixed(1)}s 墙钟）==`);
say(`条目：读取 ${report.manifestItems}，重嵌 ${report.changedItems}，跳过 ${report.skippedItems}，清理 ${report.removedItems}`);
say(`分块：本轮嵌入 ${report.embeddedChunks}，索引内共 ${report.totalChunks}`);
say(
  `逐阶段耗时（ms）：清单 ${report.timings.manifestMs} · 取正文 ${report.timings.fetchMs} · 分块 ${report.timings.chunkMs} · 嵌入 ${report.timings.embedMs} · 写库 ${report.timings.storeMs} · 合计 ${report.timings.totalMs}`,
);
if (isSynthetic) {
  const perChunk = report.timings.embedMs / Math.max(1, report.embeddedChunks);
  say(
    `首次全量（仅作换算参考，不设硬上限）：${(report.timings.totalMs / 1000).toFixed(1)}s / ${report.manifestItems} 篇 / ${report.embeddedChunks} 块，嵌入均摊 ${perChunk.toFixed(1)}ms/块`,
  );
}

// 增量更新：紧接着再跑一次 update。库未变时必须零嵌入，且总耗时就是「5 分钟口径」的核对对象
const incrementalStarted = Date.now();
const again = await updateIndex(options);
const incrementalMs = Date.now() - incrementalStarted;
say(
  `增量更新：重嵌 ${again.changedItems} 条目 / ${again.embeddedChunks} 分块（库未变时应为 0 / 0），跳过 ${again.skippedItems}，耗时 ${(incrementalMs / 1000).toFixed(1)}s`,
);
if (isSynthetic) {
  const withinBudget = incrementalMs < 5 * 60 * 1000;
  say(`5 分钟口径（增量更新）：${withinBudget ? '通过' : '未通过'}（清单 ${again.timings.manifestMs}ms · 取正文 ${again.timings.fetchMs}ms · 嵌入 ${again.timings.embedMs}ms）`);
}

const queries = flag('query') ? [String(flag('query'))] : ['ice core carbon dioxide record', 'quantized inference on CPU', '冰川侵蚀与冰蚀形貌'];
for (const query of queries) {
  const result = await semanticSearch(query, {
    ...(options.indexDir === undefined ? {} : { indexDir: options.indexDir }),
    ...(options.modelsDir === undefined ? {} : { modelsDir: options.modelsDir }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    limit: 3,
  });
  say('');
  say(`查询「${query}」：degraded=${result.degraded}${result.reason === null ? '' : `（${result.reason}）`}`);
  for (const hit of result.hits) {
    const label = hit.pageLabel === null ? '页码未知' : `第 ${hit.pageLabel} 页${hit.pageLabelEstimated ? '(估算)' : ''}`;
    say(`  ${hit.score.toFixed(4)}  ${hit.itemKey}  ${label}  字符区间 [${hit.charRange.start}, ${hit.charRange.end})  ${hit.text.slice(0, 36).replace(/\s+/gu, ' ')}…`);
  }
}

if (!isSynthetic) {
  say('');
  say(`提示：真机库只有十几篇，5 分钟口径请用 npm run report:index -- --synthetic 1000 复现。`);
}

// --cleanup：基准跑完自行收尾（合成模式的临时目录本来就会自动清理；显式 --index-dir 的复用目录
// 只有带了这个开关才会删）。护栏：宁可拒绝也不删默认真机索引目录，且删除前必须打印路径与体积。
const wantsCleanup = argv.includes('--cleanup');
if (wantsCleanup) {
  say('');
  if (keep) {
    say('--cleanup 与 --keep 互斥：请只给其中之一（未删除任何目录）。');
    process.exitCode = 2;
  } else {
    const realIndexDir = indexStatus().dir;
    const target = options.indexDir ?? realIndexDir;
    if (resolve(String(target)) === resolve(String(realIndexDir))) {
      say(`拒绝 --cleanup：${target} 是默认的真机索引目录（cache/index），删它会丢掉本机索引。`);
      say('如需清理基准目录，请显式传 --index-dir <基准目录> --cleanup。');
      process.exitCode = 2;
    } else {
      const freed = directorySize(target);
      rmSync(target, { recursive: true, force: true });
      say(`--cleanup：已删除 ${target}（释放 ${formatBytes(freed)}）。`);
    }
  }
}

for (const step of cleanup.reverse()) await step();
void createHash;
