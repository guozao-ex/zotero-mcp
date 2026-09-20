#!/usr/bin/env node
/**
 * 去重报告（只读）：对标注语料计算准确率 / 召回率 / 误报率，生成 `docs/DEDUPE_REPORT.md`。
 *
 * - 默认只跑离线标注语料（确定性产物，不受库内容漂移影响）；
 * - `--live` 额外对真实库做只读扫描并打印簇与请求方法统计（全程 GET，不写库）；
 * - 本脚本不调用写管线、不产生审计或快照。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_TITLE_THRESHOLD,
  DEFAULT_YEAR_TOLERANCE,
  clusterItems,
  evaluateClustering,
  findDuplicateCandidates,
  resolveBaseUrl,
} from '../packages/core/src/index.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CORPUS_PATH = join(ROOT, 'tests', 'fixtures', 'dedupe-corpus.json');
const REPORT_PATH = join(ROOT, 'docs', 'DEDUPE_REPORT.md');
const live = process.argv.includes('--live');
const thresholdArg = process.argv.indexOf('--threshold');
const threshold = thresholdArg >= 0 ? Number(process.argv[thresholdArg + 1]) : DEFAULT_TITLE_THRESHOLD;

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
const keys = corpus.items.map((item) => item.key);
const clusters = clusterItems(corpus.items, { threshold });
const metrics = evaluateClustering(clusters, keys, { duplicateGroups: corpus.duplicateGroups });

const percent = (value) => `${(value * 100).toFixed(1)}%`;
const lines = [];
lines.push('# 去重候选聚类报告');
lines.push('');
lines.push('> 本文件由 `npm run report:dedupe` 生成，请勿手工编辑。判定规则：同 `itemType` + 年份相差不超过容差 +');
lines.push('> 首作者姓 Jaro-Winkler ≥ 0.9 + 标题归一化后 Jaro-Winkler ≥ 阈值，四项同时成立才聚为一簇。');
lines.push('');
lines.push('## 标注语料');
lines.push('');
lines.push(`- 语料：\`tests/fixtures/dedupe-corpus.json\`（${metrics.sampleSize} 篇条目）`);
lines.push(`- 标注重复对：**${metrics.labeledDuplicatePairs}** 对；标注非重复对：**${metrics.labeledNonDuplicatePairs}** 对`);
lines.push(`- 标题阈值：${threshold}；年份容差：${DEFAULT_YEAR_TOLERANCE}`);
lines.push('');
lines.push('## 指标');
lines.push('');
lines.push('| 指标 | 值 |');
lines.push('| --- | --- |');
lines.push(`| 准确率（正确聚出的重复对 / 全部聚出的条目对） | **${percent(metrics.precision)}** (${metrics.truePositives}/${metrics.predictedPairs}) |`);
lines.push(`| 召回率（正确聚出的重复对 / 标注重复对） | **${percent(metrics.recall)}** (${metrics.truePositives}/${metrics.labeledDuplicatePairs}) |`);
lines.push(`| 误报率（被误聚的非重复对 / 全部非重复对） | **${percent(metrics.falsePositiveRate)}** (${metrics.falsePositives}/${metrics.labeledNonDuplicatePairs}) |`);
lines.push(`| 漏报数 | ${metrics.falseNegatives} |`);
lines.push('');
lines.push('## 聚类结果');
lines.push('');
lines.push(`- 簇数：**${clusters.length}** 个（强键 ${clusters.filter((cluster) => cluster.confidence === 'strong').length} 个 / 弱键 ${clusters.filter((cluster) => cluster.confidence === 'weak').length} 个）；参与条目 ${new Set(clusters.flatMap((cluster) => cluster.items.map((item) => item.key))).size} 篇`);
lines.push('');
lines.push('| 簇 | 类型 | 成员 | 建议主记录 | 命中理由 |');
lines.push('| --- | --- | --- | --- | --- |');
for (const cluster of clusters) {
  lines.push(
    `| ${cluster.items.map((item) => item.key).join(' + ')} | ${cluster.matchType} | ${cluster.items.length} | ${cluster.suggestedPrimary} | ${cluster.reasons.join('；')} |`,
  );
}
lines.push('');
lines.push('## 误报与漏报明细');
lines.push('');
if (metrics.falsePositives === 0) {
  lines.push('- 误报：无。');
} else {
  for (const example of metrics.falsePositiveExamples) {
    lines.push(`- 误报：${example.pair.join(' + ')}（簇类型 ${example.cluster}）`);
  }
}
if (metrics.falseNegatives === 0) {
  lines.push('- 漏报：无。');
} else {
  for (const pair of metrics.falseNegativeExamples) lines.push(`- 漏报：${pair.join(' + ')}`);
}
lines.push('');
lines.push('## 只读保证');
lines.push('');
lines.push('- 聚类是纯计算：只读取条目信封，不发出任何写请求，也不产生审计或快照。');
lines.push('- 合并执行（工具 19 与薄插件通道）属 M4 change 10，本报告只给候选簇与人工合并指引。');
lines.push('');
lines.push('## 已知边界');
lines.push('');
lines.push('- 年份或首作者缺失时按规格降级（跳过该项条件并在命中理由中标明），因此「年份缺失」的记录可能同时与多个年份相近的记录成簇；这是降级的已知代价。');
lines.push('- 聚类是并查集连通分量：若 A—B 与 B—C 分别命中（例如 B 缺年份），A 与 C 会被链式并入同一簇；这是「候选簇」的预期语义，人工核对时以簇内命中理由为准。');
lines.push('- 真实库当前样本量很小（3 篇无重复文献），`--live` 只用于人工核对，不参与指标计算。');
lines.push('');

mkdirSync(join(ROOT, 'docs'), { recursive: true });
writeFileSync(REPORT_PATH, `${lines.join('\n')}\n`, 'utf8');
console.log(`已生成 docs/DEDUPE_REPORT.md`);
console.log(
  `标注语料 ${metrics.sampleSize} 篇 · 簇 ${clusters.length} 个 · 准确率 ${percent(metrics.precision)} · 召回率 ${percent(metrics.recall)} · 误报率 ${percent(metrics.falsePositiveRate)}`,
);

if (live) {
  const baseUrl = resolveBaseUrl();
  const requests = [];
  const fetchImpl = async (input, init) => {
    requests.push((init?.method ?? 'GET').toUpperCase());
    return fetch(input, init);
  };
  console.log('');
  console.log(`真实库只读扫描：${baseUrl}`);
  const liveClusters = await findDuplicateCandidates({ baseUrl, fetchImpl, threshold });
  console.log(`簇 ${liveClusters.length} 个；请求 ${requests.length} 次，方法：${[...new Set(requests)].join(', ')}`);
  for (const cluster of liveClusters) {
    console.log(` - ${cluster.matchType} ${cluster.items.map((item) => item.key).join(' + ')} → 建议主记录 ${cluster.suggestedPrimary}`);
  }
  const nonGet = requests.filter((method) => method !== 'GET');
  if (nonGet.length > 0) {
    console.error(`✘ 出现非 GET 请求：${nonGet.join(', ')}`);
    process.exitCode = 1;
  }
}
