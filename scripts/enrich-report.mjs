#!/usr/bin/env node
/**
 * 元数据补全报告（只读）。
 *
 * 用法：
 *   npm run report:enrichment                # 等价于 --fixtures：离线固件、确定性、退出码 0
 *   npm run report:enrichment -- --live      # 对真实库条目做只读预览（只发 GET）
 *   npm run report:enrichment -- --json      # 机器可读输出
 *   npm run report:enrichment -- --mode retractions --sources openalex,crossref
 *
 * 只读保证：
 * - 不调用写安全管线、不产生审计与快照、不写任何文件；外部源只做查询，绝不写入数据；
 * - `--live` 对 Zotero 本地 API 只发 GET，脚本结束时校验「零个非 GET 请求」；
 * - 输出保留 `mailto` 标识，但绝不输出任何凭证（脚本会自检输出里不出现配置的 S2 令牌）。
 */

import {
  ENRICH_SOURCES,
  RETRACTION_SOURCES,
  enrichItems,
  resolveBaseUrl,
  resolveCacheDir,
} from '../packages/core/src/index.ts';
import { createFixedClock, createFixtureFetch, createMemoryCache, loadEnrichmentFixtures } from './enrich-fixtures.mjs';

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const valueOf = (name, fallback = null) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback;
};

const live = hasFlag('--live');
const jsonOutput = hasFlag('--json');
const mode = valueOf('--mode', 'metadata');
const limit = Number(valueOf('--limit', '10'));
const sourcesArg = valueOf('--sources');
const sources =
  sourcesArg === null
    ? [...ENRICH_SOURCES]
    : sourcesArg
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
const keysArg = valueOf('--keys');
const requests = [];
const zoteroBaseUrl = resolveBaseUrl();

function describeAttempt(attempt) {
  const mark = attempt.status === 'hit' ? '✔' : attempt.status === 'miss' ? '○' : '✘';
  const cache = attempt.cached ? '（缓存）' : '';
  const reason = attempt.reason === null ? '' : ` — ${attempt.reason}`;
  return `${mark} ${attempt.source}：${attempt.status}${cache}${reason}`;
}

function describeIntel(intel) {
  const parts = [];
  if (intel.citedByCount !== null) parts.push(`cited-by ${intel.citedByCount}（openalex）`);
  if (intel.citationCount !== null) parts.push(`citations ${intel.citationCount}（semanticscholar）`);
  if (intel.influentialCitationCount !== null) parts.push(`influential ${intel.influentialCitationCount}（semanticscholar）`);
  if (intel.journalAbbreviation !== null) parts.push(`journalAbbreviation ${intel.journalAbbreviation}（${intel.journalAbbreviationSource}）`);
  if (intel.openAccess !== null) {
    parts.push(`open-access ${intel.openAccess.status ?? 'yes'} · ${intel.openAccess.url} · 许可 ${intel.openAccess.license ?? '未标注'}（${intel.openAccess.source}）`);
  }
  if (intel.retracted) {
    parts.push(`retracted（${intel.retractionSources.join(' / ')}${intel.retractionDoi === null ? '' : ` · 撤稿通知 DOI ${intel.retractionDoi}`}）`);
  }
  return parts.length === 0 ? '无' : parts.join('；');
}

async function run() {
  const fixture = live ? null : loadEnrichmentFixtures();
  const clock = live ? null : createFixedClock(Date.parse(`${fixture.generatedAt}T00:00:00Z`));
  const cache = live ? null : createMemoryCache();
  const fetchImpl = live
    ? async (input, init) => {
        const url = typeof input === 'string' ? input : input.url ?? String(input);
        requests.push({ method: (init?.method ?? 'GET').toUpperCase(), url });
        return fetch(input, init);
      }
    : createFixtureFetch(fixture, { requests });

  let keys;
  if (keysArg !== null) {
    keys = keysArg.split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
  } else if (live) {
    const response = await fetchImpl(`${zoteroBaseUrl}/api/users/0/items/top?limit=${Number.isFinite(limit) ? limit : 10}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`读取真实库失败：HTTP ${response.status}`);
    const items = await response.json();
    keys = (Array.isArray(items) ? items : []).map((item) => item.key);
  } else {
    keys = fixture.library.items.map((item) => item.key);
  }

  const report = await enrichItems({
    keys,
    mode,
    sources,
    fetchImpl,
    ...(live
      ? { baseUrl: zoteroBaseUrl, cacheDir: resolveCacheDir() }
      : { cacheDir: '/offline-fixtures', io: { fetchImpl, ...clock, ...cache } }),
  });

  const lines = [];
  lines.push('元数据补全报告（只读）');
  lines.push('');
  lines.push(`数据来源：${live ? `真实库 ${zoteroBaseUrl}（只读预览）` : '仓库内固件 tests/fixtures/enrichment-fixtures.json（离线、确定性）'}`);
  lines.push(`模式：${report.mode}（${report.mode === 'retractions' ? `撤稿信号源 ${RETRACTION_SOURCES.join(' / ')}` : '全部四类情报'}）`);
  lines.push(`启用源：${report.sources.join(' / ')}`);
  lines.push(`条目：${report.items.length} 条 · 生成日期：${report.generatedAt}`);
  lines.push('');
  for (const item of report.items) {
    lines.push(`## ${item.key} · ${item.status}`);
    lines.push(`标题：${item.title ?? '（无）'}`);
    const doiSource =
      item.doiSource === 'field' ? '条目 DOI 字段' : item.doiSource === 'title-fallback' ? `标题回退（相似度 ${item.doiSimilarity?.toFixed(3)}）` : null;
    lines.push(`DOI：${item.doi === null ? '（未解析）' : `${item.doi}（${doiSource}）`}`);
    if (item.doiFallback.attempted) lines.push(`标题回退：${item.doiFallback.accepted ? '已采纳' : '未采纳'}${item.doiFallback.reason === null ? '' : ` — ${item.doiFallback.reason}`}`);
    lines.push('来源尝试：');
    for (const attempt of item.attempts) lines.push(`  ${describeAttempt(attempt)}`);
    lines.push(`情报：${describeIntel(item.intel)}`);
    const fields = Object.keys(item.fields);
    lines.push(`将写入的字段：${fields.length === 0 ? '无' : fields.join(', ')}`);
    lines.push(`将写入的标签：${item.tags.length === 0 ? '无' : item.tags.join(', ')}`);
    for (const skip of item.skipped) lines.push(`跳过的字段：${skip.field} — ${skip.reason}`);
    lines.push(`外呼日志（${item.calls.length} 次）：`);
    for (const call of item.calls) lines.push(`  - ${call.source} · ${call.host} · mailto=${call.mailto} · ${call.url}`);
    lines.push('');
  }
  const byStatus = (status) => report.items.filter((item) => item.status === status).length;
  lines.push('## 汇总');
  lines.push('');
  lines.push(`- enriched：${byStatus('enriched')} 条 · partial：${byStatus('partial')} 条 · needs-enrichment：${byStatus('needs-enrichment')} 条`);
  lines.push(`- 外呼合计：${report.calls.length} 次（每条都带 mailto 标识：${report.calls.every((call) => call.mailto.length > 0) ? '是' : '否'}）`);
  lines.push(`- 写请求：0 次（本报告不进入写安全管线，不产生审计与快照）`);

  const text = lines.join('\n');
  const s2Key = (process.env['ZOTERO_MCP_S2_API_KEY'] ?? '').trim();
  const zoteroWrites = requests.filter((entry) => entry.url.startsWith(zoteroBaseUrl) && entry.method !== 'GET');
  if (s2Key.length > 0 && text.includes(s2Key)) {
    console.error('✘ 输出里出现了 ZOTERO_MCP_S2_API_KEY，已中止（凭证只进不出）。');
    process.exitCode = 1;
    return;
  }
  if (zoteroWrites.length > 0) {
    console.error(`✘ 出现对 Zotero 的非 GET 请求：${zoteroWrites.map((entry) => entry.method).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          mode: report.mode,
          sources: report.sources,
          generatedAt: report.generatedAt,
          items: report.items.map((item) => ({
            key: item.key,
            status: item.status,
            doi: item.doi,
            doiSource: item.doiSource,
            attempts: item.attempts,
            intel: item.intel,
            fields: Object.keys(item.fields),
            tags: item.tags,
            skipped: item.skipped,
            calls: item.calls,
          })),
          calls: report.calls.length,
          writeRequests: 0,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(text);
  }
  if (live) {
    console.log('');
    console.log(`只读校验：Zotero 请求 ${requests.filter((entry) => entry.url.startsWith(zoteroBaseUrl)).length} 次，非 GET 请求 0 次。`);
  }
}

await run();
