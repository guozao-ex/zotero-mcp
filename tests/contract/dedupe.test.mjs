/**
 * 重复候选聚类契约测试（change 6 · m3-dedupe-clustering）。
 *
 * 覆盖 A1–A12 中可离线验证的部分：强键 + 弱键聚类、干扰项排除、主记录建议稳定性、
 * 标注语料指标、工具面参数与统计、聚类与报告全程只读。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  clusterItems,
  evaluateClustering,
  explainRejectedPairs,
  findDuplicateCandidates,
  firstAuthorSurname,
  jaroWinkler,
  normalizeTitle,
  parseYear,
  weakKeyMatch,
} from '../../packages/core/src/index.ts';
import { createServer } from '../../packages/mcp-server/src/server.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CORPUS_PATH = join(ROOT, 'tests', 'fixtures', 'dedupe-corpus.json');
const REPORT_SCRIPT = join(ROOT, 'scripts', 'dedupe-report.mjs');

const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
const corpusKeys = corpus.items.map((item) => item.key);

function clusterOf(clusters, key) {
  return clusters.find((cluster) => cluster.items.some((item) => item.key === key));
}

async function connectPair() {
  const server = createServer();
  const client = new Client({ name: 'dedupe-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function parseResult(result) {
  return JSON.parse(String(result.content[0]?.text ?? 'null'));
}

test('归一化与相似度：标题、年份、首作者与 Jaro-Winkler', () => {
  assert.equal(normalizeTitle('The Glacier Runoff: A Study!'), 'glacier runoff a study');
  assert.equal(normalizeTitle('Müller  Glacier — Runoff'), 'muller glacier runoff');
  assert.equal(parseYear('2021-03-01'), 2021);
  assert.equal(parseYear('Spring 1999'), 1999);
  assert.equal(parseYear('no year'), null);
  assert.equal(
    firstAuthorSurname({ creators: [{ creatorType: 'author', firstName: 'Ada', lastName: 'Lovelace' }] }),
    'lovelace',
  );
  assert.equal(firstAuthorSurname({ creators: [{ creatorType: 'author', name: 'World Health Organization' }] }), 'organization');
  assert.equal(firstAuthorSurname({}), null);
  assert.equal(jaroWinkler('glacier', 'glacier'), 1);
  assert.equal(jaroWinkler('', 'glacier'), 0);
  assert.ok(jaroWinkler('modelling', 'modeling') > 0.9);
  assert.equal(jaroWinkler('abc', 'xyz'), 0);
  assert.ok(jaroWinkler('ocean circulation variability', 'ocean heat transport and climate') < 0.9);
});

test('A1/A7 弱键候选聚类：标题相近、年份差 1、首作者相同 → 同簇且理由完整', () => {
  const clusters = clusterItems(corpus.items);
  const weakClusters = clusters.filter((cluster) => cluster.matchType === 'weak');
  assert.equal(weakClusters.length, 3, '语料里有 3 组弱键重复');
  const typo = clusterOf(clusters, 'CORP0007');
  assert.ok(typo, 'CORP0007/CORP0008 应成簇');
  assert.deepEqual(
    typo.items.map((item) => item.key).sort(),
    ['CORP0007', 'CORP0008'],
  );
  assert.equal(typo.confidence, 'weak');
  const reasons = typo.reasons.join(' ');
  assert.match(reasons, /标题相似度/u);
  assert.match(reasons, /年份相差 1 ≤ 1/u);
  assert.match(reasons, /首作者姓相似度/u);

  const degraded = clusterOf(clusters, 'CORP0012');
  assert.ok(degraded, '年份缺失的 CORP0012 仍应与 CORP0011 成簇（降级）');
  assert.match(degraded.reasons.join(' '), /年份缺失/u);
});

test('A2/A8 干扰项不被聚簇：itemType / 首作者 / 年份 / 标题任一不符即不合并', () => {
  const clusters = clusterItems(corpus.items);
  const pairs = new Set(
    clusters.flatMap((cluster) => {
      const keys = cluster.items.map((item) => item.key);
      const out = [];
      for (let left = 0; left < keys.length; left += 1) {
        for (let right = left + 1; right < keys.length; right += 1) {
          out.push(`${keys[left]}|${keys[right]}`);
        }
      }
      return out;
    }),
  );
  const sameCluster = (left, right) => pairs.has(`${left}|${right}`) || pairs.has(`${right}|${left}`);
  assert.equal(sameCluster('CORP0011', 'CORP0013'), false, 'itemType 不同不得合并');
  assert.equal(sameCluster('CORP0011', 'CORP0014'), false, '首作者不同不得合并');
  assert.equal(sameCluster('CORP0018', 'CORP0019'), false, '年份超出容差不得合并');
  assert.equal(sameCluster('CORP0016', 'CORP0017'), false, '标题不相似不得合并');
  assert.equal(sameCluster('CORP0020', 'CORP0011'), false, '无关条目不得合并');

  // 失败原因可查
  const byKey = new Map(corpus.items.map((item) => [item.key, item]));
  const authorMismatch = weakKeyMatch(byKey.get('CORP0011'), byKey.get('CORP0014'));
  assert.equal(authorMismatch.matched, false);
  assert.match(authorMismatch.reasons.join(' '), /首作者姓相似度/u);
  const yearMismatch = weakKeyMatch(byKey.get('CORP0018'), byKey.get('CORP0019'));
  assert.equal(yearMismatch.matched, false);
  assert.match(yearMismatch.reasons.join(' '), /年份相差/u);
  const typeMismatch = weakKeyMatch(byKey.get('CORP0011'), byKey.get('CORP0013'));
  assert.equal(typeMismatch.matched, false);
  assert.match(typeMismatch.reasons.join(' '), /itemType 不同/u);
});

test('A3/A9 主记录建议唯一且稳定：附件 → 注释 → 集合 → 完整度 → key', () => {
  const first = clusterItems(corpus.items);
  const second = clusterItems(corpus.items);
  assert.deepEqual(
    first.map((cluster) => `${cluster.matchType}:${cluster.suggestedPrimary}`),
    second.map((cluster) => `${cluster.matchType}:${cluster.suggestedPrimary}`),
    '同一批输入两次运行结果必须一致',
  );
  for (const cluster of first) {
    assert.equal(typeof cluster.suggestedPrimary, 'string');
    assert.ok(cluster.items.some((item) => item.key === cluster.suggestedPrimary), '主记录必须在簇内');
  }

  // 附件/注释更多者优先
  const withCounts = clusterItems(corpus.items, {
    attachmentCounts: new Map([['CORP0002', 2]]),
    annotationCounts: new Map([['CORP0002', 5]]),
  });
  const doiCluster = withCounts.find((cluster) => cluster.matchType === 'doi');
  assert.equal(doiCluster?.suggestedPrimary, 'CORP0002');
});

test('A4/A10 标注语料指标：准确率 100%、召回率 100%、误报 0', () => {
  const clusters = clusterItems(corpus.items);
  const metrics = evaluateClustering(clusters, corpusKeys, { duplicateGroups: corpus.duplicateGroups });
  assert.equal(metrics.sampleSize, 20);
  assert.equal(metrics.labeledDuplicatePairs, 6);
  assert.equal(metrics.truePositives, 6);
  assert.equal(metrics.falsePositives, 0);
  assert.equal(metrics.falseNegatives, 0);
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.recall, 1);
  assert.equal(metrics.falsePositiveRate, 0);
  assert.ok(metrics.labeledNonDuplicatePairs >= 100, '非重复对数量应覆盖全部样本对');
});

test('A4/A10 报告脚本生成确定性产物并只发 GET', async () => {
  const { stdout } = await execFileAsync(process.execPath, [REPORT_SCRIPT], { cwd: ROOT });
  assert.match(stdout, /docs\/DEDUPE_REPORT\.md/u);
  assert.match(stdout, /准确率 100\.0%/u);
  const report = readFileSync(join(ROOT, 'docs', 'DEDUPE_REPORT.md'), 'utf8');
  assert.match(report, /准确率/u);
  assert.match(report, /召回率/u);
  assert.match(report, /误报率/u);
  assert.match(report, /CORP0001 \+ CORP0002/u);
});

test('A5/A11 工具面：返回簇与统计，参数可调、越界被拒', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: { items: corpus.items } });
  const previous = process.env['ZOTERO_MCP_BASE_URL'];
  process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
  const { client, server } = await connectPair();
  try {
    const result = await client.callTool({ name: 'zotero_find_duplicates', arguments: {} });
    assert.notEqual(result.isError, true, String(result.content[0]?.text ?? ''));
    const payload = parseResult(result);
    assert.equal(payload.stats.totalItems, 20, '统计必须包含被扫描的条目总数');
    assert.equal(payload.stats.clusters, 6);
    assert.equal(payload.stats.weakClusters, 3);
    assert.equal(payload.stats.strongClusters, 3);
    assert.equal(payload.stats.candidateItems, 12);

    const explained = parseResult(
      await client.callTool({ name: 'zotero_find_duplicates', arguments: { explain: true } }),
    );
    assert.ok(explained.rejected, 'explain=true 时必须附带被拒对诊断');
    assert.ok(explained.rejected.comparedPairs > 0);
    assert.ok(explained.rejected.pairs.length > 0, '被拒对里应有弱键失败的对');
    assert.ok(
      explained.rejected.pairs.every((entry) => Array.isArray(entry.pair) && entry.reasons.length > 0),
      '每个被拒对都要给出失败原因',
    );
    assert.ok(
      explained.rejected.pairs.some((entry) => entry.reasons.join(' ').includes('itemType 不同') || entry.reasons.join(' ').includes('相似度')),
      '失败原因应包含具体条件',
    );

    // 只读：全部请求都是 GET，且未产生审计目录
    assert.ok(fake.requests.length > 0);
    assert.deepEqual(
      fake.requests.filter((request) => request.method !== 'GET'),
      [],
    );

    const strongOnly = parseResult(
      await client.callTool({ name: 'zotero_find_duplicates', arguments: { includeWeakKeys: false } }),
    );
    assert.equal(strongOnly.stats.clusters, 3);
    assert.equal(strongOnly.stats.weakClusters, 0);

    const strict = parseResult(
      await client.callTool({ name: 'zotero_find_duplicates', arguments: { threshold: 0.999 } }),
    );
    assert.equal(strict.stats.weakClusters, 2, '阈值提高到 0.999 时只保留标题完全相同的弱键簇');

    const rejected = await client.callTool({ name: 'zotero_find_duplicates', arguments: { threshold: 0.2 } });
    assert.equal(rejected.isError, true, '越界阈值必须在调用前被拒绝');
    const negativeTolerance = await client.callTool({
      name: 'zotero_find_duplicates',
      arguments: { yearTolerance: -1 },
    });
    assert.equal(negativeTolerance.isError, true, '负容差必须在调用前被拒绝');
  } finally {
    await client.close();
    await server.close();
    await fake.close();
    if (previous === undefined) delete process.env['ZOTERO_MCP_BASE_URL'];
    else process.env['ZOTERO_MCP_BASE_URL'] = previous;
  }
});

test('A6/A11/A12 只读保证：findDuplicateCandidates 与 live 报告全程 GET', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: { items: corpus.items } });
  const auditDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-dedupe-'));
  const previous = {
    base: process.env['ZOTERO_MCP_BASE_URL'],
    audit: process.env['ZOTERO_MCP_AUDIT_DIR'],
  };
  process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
  process.env['ZOTERO_MCP_AUDIT_DIR'] = auditDir;
  try {
    const clusters = await findDuplicateCandidates({ baseUrl: fake.url });
    assert.equal(clusters.length, 6);
    assert.deepEqual(
      fake.requests.filter((request) => request.method !== 'GET'),
      [],
      '聚类不得发出任何非 GET 请求',
    );
    assert.ok(!existsSync(join(auditDir, 'audit.jsonl')), '聚类不得产生审计文件');
    assert.ok(!existsSync(join(auditDir, 'snapshots')), '聚类不得产生快照目录');

    const { stdout } = await execFileAsync(process.execPath, [REPORT_SCRIPT, '--live'], {
      cwd: ROOT,
      env: { ...process.env, ZOTERO_MCP_BASE_URL: fake.url, ZOTERO_MCP_AUDIT_DIR: auditDir },
    });
    assert.match(stdout, /真实库只读扫描/u);
    assert.match(stdout, /方法：GET/u);
    const before = fake.requests.filter((request) => request.method !== 'GET');
    assert.deepEqual(before, [], 'live 报告同样不得发出非 GET 请求');
  } finally {
    await fake.close();
    if (previous.base === undefined) delete process.env['ZOTERO_MCP_BASE_URL'];
    else process.env['ZOTERO_MCP_BASE_URL'] = previous.base;
    if (previous.audit === undefined) delete process.env['ZOTERO_MCP_AUDIT_DIR'];
    else process.env['ZOTERO_MCP_AUDIT_DIR'] = previous.audit;
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test('A1 回归：同库多组同类型强键时，每簇的 matchKey 必须来自本簇成员', () => {
  const make = (key, doi, title, author) => ({
    key,
    version: 1,
    data: {
      itemType: 'journalArticle',
      title,
      DOI: doi,
      date: '2019',
      creators: [{ creatorType: 'author', lastName: author }],
    },
  });
  const items = [
    make('DUP0001', '10.1000/alpha', 'Alpha paper on glacier mass balance', 'Alpha'),
    make('DUP0002', 'https://doi.org/10.1000/ALPHA', 'Alpha paper on glacier mass balance', 'Alpha'),
    make('DUP0003', '10.5555/beta', 'Beta study of Arctic sea ice drift', 'Beta'),
    make('DUP0004', '10.5555/beta', 'Beta study of Arctic sea ice drift', 'Beta'),
  ];
  const clusters = clusterItems(items);
  assert.equal(clusters.length, 2, '两组强键重复应各自成簇');
  const alpha = clusters.find((cluster) => cluster.items.some((item) => item.key === 'DUP0001'));
  const beta = clusters.find((cluster) => cluster.items.some((item) => item.key === 'DUP0003'));
  assert.equal(alpha?.matchType, 'doi');
  assert.equal(alpha?.matchKey, '10.1000/alpha');
  assert.equal(beta?.matchType, 'doi');
  assert.equal(beta?.matchKey, '10.5555/beta', '第二组簇的 matchKey 必须是它自己的 DOI');
  assert.ok(beta?.reasons.some((reason) => reason.includes('10.5555/beta')));

  // 被拒对诊断：不相同主题的两组之间仍应有可查的拒绝原因
  const rejected = explainRejectedPairs(items);
  assert.ok(rejected.comparedPairs >= 1);
});
