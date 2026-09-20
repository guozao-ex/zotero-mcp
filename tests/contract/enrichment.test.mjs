/**
 * 元数据补全契约测试（change 8 · m3-metadata-enrichment）。
 *
 * 覆盖 A1–A14 中可在离线环境验证的部分：源映射（纯函数）、DOI 标题回退阈值、撤稿三源、
 * OA 级联顺序、mailto 与主机限速、缓存命中零外呼、降级为 needs-enrichment、extra 幂等与
 * 块外逐字保留、journalAbbreviation 不覆盖、标签合并、写安全管线（默认只读零请求）、
 * 凭证只进不出、报告只读、演示闭环与工具面计数。
 *
 * 全部走假服务器 + 注入的外呼桩 + 临时目录，不触真实库、不写真实 .audit、不外呼真实网络。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  DOI_TITLE_THRESHOLD,
  ENRICH_SOURCES,
  ENRICHMENT_BLOCK_END,
  ENRICHMENT_BLOCK_START,
  applyEnrichmentBlock,
  applyPlan,
  buildEnrichmentPlan,
  enrichCachePath,
  enrichItems,
  enrichmentBlockLines,
  enrichmentWriteSet,
  extractEnrichmentBlock,
  getItems,
  makeChangePlan,
  mapArxivEntry,
  mapCrossrefEnrichment,
  mapOpenAlexWork,
  mapPubmedEsummary,
  mapSemanticScholarPaper,
  mapUnpaywallRecord,
  mergeIntel,
  parseArxivFeed,
  pickDoiByTitle,
  previewPlan,
  stripDoi,
} from '../../packages/core/src/index.ts';
import { createServer } from '../../packages/mcp-server/src/server.ts';
import { ALL_TOOLS, TOOL_NAMES } from '../../packages/mcp-server/src/tools.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPORT_SCRIPT = join(ROOT, 'scripts', 'enrich-report.mjs');
const DEMO_SCRIPT = join(ROOT, 'scripts', 'enrich-demo.mjs');
const S2_KEY = 'S2SECRETKEY0000000000000000000000';
/** 原始 fetch（桩与全局替换都要以它为出口，避免自递归）。 */
const realFetch = globalThis.fetch;

const ALPHA_DOI = '10.1000/alpha.enriched';
const BETA_DOI = '10.1000/beta.retracted';

// ── 测试脚手架 ──────────────────────────────────────────────────────────

async function connectPair() {
  const server = createServer();
  const client = new Client({ name: 'enrichment-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

/** 固定的虚拟时钟：`sleep` 推进虚拟时间，让限速断言既确定又不真实等待。 */
function virtualClock(start = Date.parse('2026-09-18T00:00:00Z')) {
  const state = { now: start, sleeps: [] };
  return {
    state,
    now: () => state.now,
    sleep: async (ms) => {
      state.sleeps.push(ms);
      state.now += ms;
    },
  };
}

function memoryCache() {
  const store = new Map();
  return {
    store,
    readCache: async (path) => store.get(path) ?? null,
    writeCache: async (path, text) => {
      store.set(path, text);
    },
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * 外呼桩：按主机分发，记录每个请求的 URL、请求头与方法。
 *
 * 回环地址一律转发给真实 fetch（即假 Zotero 服务器），且不计入 `calls`——
 * 这样同一个 `fetchImpl` 既能读库又能离线外呼，而 `calls` 只统计外部学术 API。
 * 未注册的外部主机一律 404（等价于「该源没有这条记录」）。
 */
function externalStub(handlers, calls) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : (input.url ?? String(input));
    const parsed = new URL(url);
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') return realFetch(input, init);
    calls.push({ url, host: parsed.hostname, method: (init.method ?? 'GET').toUpperCase(), headers: init.headers ?? {} });
    const handler = handlers[parsed.hostname];
    if (handler === undefined) return json(404, { error: `no stub for ${parsed.hostname}` });
    return handler(parsed, url);
  };
}

/** 临时替换全局 fetch：让 MCP 工具层（不传 fetchImpl）也走离线桩。 */
async function withGlobalFetch(impl, run) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const ARXIV_FEED = (doi) =>
  `<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom"><opensearch:totalResults>1</opensearch:totalResults><entry><id>http://arxiv.org/abs/2103.00001v2</id><title>Alpha</title><link href="https://arxiv.org/abs/2103.00001v2" rel="alternate"/><link href="https://arxiv.org/pdf/2103.00001v2" rel="related" title="pdf"/><arxiv:doi>${doi}</arxiv:doi></entry></feed>`;

/** 源 → 桩的默认响应（全部命中，供正向路径复用）。 */
function allSourcesHit(overrides = {}) {
  return {
    'api.openalex.org': () =>
      json(200, {
        id: 'https://openalex.org/W1',
        doi: `https://doi.org/${ALPHA_DOI}`,
        display_name: 'Alpha',
        cited_by_count: 128,
        is_retracted: false,
        ids: { pmcid: 'PMC9000001' },
        primary_location: { source: { display_name: 'Journal of Reproducible Pipelines', abbreviated_title: 'J. Reprod. Pipelines' } },
      }),
    'api.semanticscholar.org': () =>
      json(200, {
        paperId: 'S2PAPER0001',
        citationCount: 121,
        influentialCitationCount: 9,
        openAccessPdf: { url: 'https://example.org/alpha.pdf', license: 'CC-BY-4.0' },
        externalIds: { DOI: ALPHA_DOI, PubMedCentral: '9000001' },
      }),
    'api.crossref.org': () =>
      json(200, {
        message: { DOI: ALPHA_DOI, 'short-container-title': ['J. Reprod. Pipelines'], 'container-title': ['Journal of Reproducible Pipelines'] },
      }),
    'api.unpaywall.org': () =>
      json(200, {
        doi: ALPHA_DOI,
        is_oa: true,
        oa_status: 'gold',
        best_oa_location: { url: 'https://example.org/alpha', url_for_pdf: 'https://example.org/alpha.pdf', license: 'cc-by' },
      }),
    'eutils.ncbi.nlm.nih.gov': (parsed) =>
      parsed.pathname.includes('esummary')
        ? json(200, {
            result: {
              '9000001': { source: 'J Reprod Pipelines', pubtype: ['Journal Article'], articleids: [{ idtype: 'doi', value: ALPHA_DOI }] },
            },
          })
        : json(200, { esearchresult: { idlist: ['9000001'] } }),
    'export.arxiv.org': () => new Response(ARXIV_FEED(ALPHA_DOI), { status: 200 }),
    ...overrides,
  };
}

const LIBRARY_ALPHA = {
  items: [
    {
      key: 'ITEM0001',
      version: 1,
      data: { itemType: 'journalArticle', title: 'Alpha paper', DOI: ALPHA_DOI, extra: 'Citation Key: alpha', tags: [{ tag: 'alpha' }] },
    },
  ],
  children: {},
};

/** 起假服务器 + 临时缓存目录，并把外呼桩接到 enrichment 的 io 上；结束后完整恢复。 */
async function withFake(fn, options = {}) {
  const fake = await startFakeZotero({ mode: 'ok', port: 0, ...options });
  const cacheDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-enrich-cache-'));
  // 审计与快照一律落到临时目录：契约测试绝不污染仓库真实 .audit/（写工具测试的既有约定）
  const auditDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-enrich-audit-'));
  const previous = {
    base: process.env['ZOTERO_MCP_BASE_URL'],
    write: process.env['ZOTERO_MCP_WRITE'],
    cache: process.env['ZOTERO_MCP_CACHE_DIR'],
    audit: process.env['ZOTERO_MCP_AUDIT_DIR'],
    s2: process.env['ZOTERO_MCP_S2_API_KEY'],
  };
  process.env['ZOTERO_MCP_CACHE_DIR'] = cacheDir;
  process.env['ZOTERO_MCP_AUDIT_DIR'] = auditDir;
  process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
  const { client, server } = await connectPair();
  try {
    return await fn({ fake, client, server, cacheDir, auditDir, baseUrl: fake.url });
  } finally {
    await client.close();
    await server.close();
    await fake.close();
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('ZOTERO_MCP_BASE_URL', previous.base);
    restore('ZOTERO_MCP_WRITE', previous.write);
    restore('ZOTERO_MCP_CACHE_DIR', previous.cache);
    restore('ZOTERO_MCP_AUDIT_DIR', previous.audit);
    restore('ZOTERO_MCP_S2_API_KEY', previous.s2);
    rmSync(cacheDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
  }
}

/** 仓库真实 .audit/audit.jsonl 的行数（用于自证契约测试没有污染真实审计）。 */
function repoAuditLineCount() {
  const path = join(ROOT, '.audit', 'audit.jsonl');
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8')
    .trim()
    .split(String.fromCharCode(10))
    .filter((line) => line.length > 0).length;
}

function nonGetRequests(fake) {
  return fake.requests.filter((request) => request.method !== 'GET');
}

// ── 纯函数：源映射、级联与块渲染 ────────────────────────────────────────

test('A1 源映射：引用数 / 影响力 / 期刊缩写各自标注命中的源（纯函数）', () => {
  const openalex = mapOpenAlexWork({
    id: 'https://openalex.org/W1',
    doi: `https://doi.org/${ALPHA_DOI}`,
    cited_by_count: 128,
    is_retracted: false,
    ids: { pmcid: 'PMC9000001' },
    primary_location: { source: { display_name: 'Journal of Reproducible Pipelines', abbreviated_title: 'J. Reprod. Pipelines' } },
  });
  assert.equal(openalex.citedByCount, 128);
  assert.equal(openalex.doi, ALPHA_DOI);
  assert.equal(openalex.pmcId, '9000001');
  const s2 = mapSemanticScholarPaper({
    paperId: 'x',
    citationCount: 121,
    influentialCitationCount: 9,
    openAccessPdf: { url: 'https://example.org/a.pdf', license: 'CC-BY-4.0' },
    externalIds: { DOI: ALPHA_DOI, PubMedCentral: '9000001' },
  });
  assert.equal(s2.citationCount, 121);
  assert.equal(s2.influentialCitationCount, 9);
  const crossref = mapCrossrefEnrichment({
    DOI: ALPHA_DOI,
    'short-container-title': ['J. Reprod. Pipelines'],
    'container-title': ['Journal of Reproducible Pipelines'],
  });
  assert.equal(crossref.journalAbbreviation, 'J. Reprod. Pipelines');
  const merged = mergeIntel([
    openalex,
    s2,
    crossref,
    mapUnpaywallRecord({ doi: ALPHA_DOI, is_oa: true, oa_status: 'gold', best_oa_location: { url: 'https://example.org/a', license: 'cc-by' } }),
  ]);
  assert.equal(merged.citedByCount, 128);
  assert.equal(merged.influentialCitationCount, 9);
  assert.equal(merged.journalAbbreviation, 'J. Reprod. Pipelines');
  assert.equal(merged.journalAbbreviationSource, 'crossref');
  assert.equal(merged.openAccess?.source, 'unpaywall');
  const lines = enrichmentBlockLines(merged);
  assert.ok(lines.some((line) => line === 'cited-by: 128 · openalex'));
  assert.ok(lines.some((line) => line === 'influential-citations: 9 · semanticscholar'));
  assert.ok(lines.some((line) => line.startsWith('journal-abbreviation: J. Reprod. Pipelines · crossref')));
  // 缩写优先级：Crossref > OpenAlex > PubMed
  assert.equal(mergeIntel([mapOpenAlexWork({ primary_location: { source: { abbreviated_title: 'OA-ABBR' } } }), mapPubmedEsummary({ source: 'PUBMED-ABBR' }), mapCrossrefEnrichment({ 'short-container-title': ['CR-ABBR'] })]).journalAbbreviation, 'CR-ABBR');
  assert.equal(mergeIntel([mapOpenAlexWork({ primary_location: { source: { abbreviated_title: 'OA-ABBR' } } }), mapPubmedEsummary({ source: 'PUBMED-ABBR' })]).journalAbbreviation, 'OA-ABBR');
  assert.equal(mergeIntel([mapPubmedEsummary({ source: 'PUBMED-ABBR' })]).journalAbbreviation, 'PUBMED-ABBR');
});

test('A2 OA 级联顺序：Unpaywall → S2 openAccessPdf → arXiv → PMC（404 继续下一源）', () => {
  const noOaUnpaywall = mapUnpaywallRecord({ doi: ALPHA_DOI, is_oa: false, best_oa_location: null });
  const s2Pdf = mapSemanticScholarPaper({ paperId: 'x', openAccessPdf: { url: 'https://example.org/s2.pdf' }, externalIds: {} });
  const s2NoPdf = mapSemanticScholarPaper({ paperId: 'x', openAccessPdf: null, externalIds: {} });
  const arxiv = mapArxivEntry({ id: 'https://arxiv.org/abs/2103.00001v2', title: 'Alpha', doi: ALPHA_DOI, pdfUrl: null, license: 'http://arxiv.org/licenses/nonexclusive-distrib/1.0/' });
  const pmcOnly = mapSemanticScholarPaper({ paperId: 'x', openAccessPdf: null, externalIds: { PubMedCentral: '9000001' } });
  assert.deepEqual(mergeIntel([noOaUnpaywall, s2Pdf]).openAccess, { source: 'semanticscholar', url: 'https://example.org/s2.pdf', license: null, status: null });
  assert.equal(mergeIntel([noOaUnpaywall, s2NoPdf, arxiv]).openAccess?.source, 'arxiv');
  assert.equal(mergeIntel([noOaUnpaywall, pmcOnly]).openAccess?.source, 'pmc');
  assert.equal(mergeIntel([noOaUnpaywall, pmcOnly]).openAccess?.url, 'https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9000001/');
  assert.equal(mergeIntel([noOaUnpaywall]).openAccess, null);
  // Unpaywall 有 OA 时优先于其他源
  const unpaywallOa = mapUnpaywallRecord({ doi: ALPHA_DOI, is_oa: true, oa_status: 'gold', best_oa_location: { url: 'https://example.org/up', license: 'cc-by' } });
  assert.equal(mergeIntel([unpaywallOa, s2Pdf, arxiv]).openAccess?.source, 'unpaywall');
});

test('A11 撤稿三源：OpenAlex is_retracted / Crossref updated-by 与 update-to / PubMed pubtype', () => {
  assert.equal(mapOpenAlexWork({ id: 'x', is_retracted: true }).retracted, true);
  assert.equal(mapOpenAlexWork({ id: 'x', is_retracted: false }).retracted, false);
  // 原始记录：updated-by 指向撤稿通知
  const original = mapCrossrefEnrichment({ DOI: BETA_DOI, 'updated-by': [{ DOI: '10.1000/beta.notice', type: 'retraction', label: 'Retraction' }] });
  assert.equal(original.retracted, true);
  assert.equal(original.retractionDoi, '10.1000/beta.notice');
  // 通知记录：update-to 指向被撤原文，通知 DOI 即自身
  const notice = mapCrossrefEnrichment({ DOI: '10.1000/beta.notice', 'update-to': [{ DOI: BETA_DOI, type: 'retraction', label: 'Retraction' }] });
  assert.equal(notice.retracted, true);
  assert.equal(notice.retractionDoi, '10.1000/beta.notice');
  // 非撤稿的 correction 不算撤稿
  assert.equal(mapCrossrefEnrichment({ DOI: BETA_DOI, 'updated-by': [{ DOI: '10.1000/x', type: 'correction' }] }).retracted, false);
  assert.equal(mapPubmedEsummary({ pubtype: ['Journal Article', 'Retracted Publication'] }).retracted, true);
  assert.equal(mapPubmedEsummary({ pubtype: ['Journal Article'] }).retracted, false);
  const merged = mergeIntel([
    mapOpenAlexWork({ id: 'x', is_retracted: true }),
    mapCrossrefEnrichment({ DOI: BETA_DOI, 'updated-by': [{ DOI: '10.1000/beta.notice', type: 'retraction' }] }),
    mapPubmedEsummary({ pubtype: ['Retracted Publication'], title: 'Beta' }),
  ]);
  assert.equal(merged.retracted, true);
  assert.deepEqual([...merged.retractionSources].sort(), ['crossref', 'openalex', 'pubmed']);
  assert.equal(merged.retractionDoi, '10.1000/beta.notice');
  assert.ok(enrichmentBlockLines(merged).some((line) => line.includes('retracted: yes')));
  // 没有撤稿信号时不写标签
  assert.equal(mergeIntel([mapOpenAlexWork({ id: 'x', is_retracted: false })]).retracted, false);
});

test('A10 标题回退阈值：Jaro-Winkler ≥ 0.8 才采纳，且不臆造 DOI（纯函数）', () => {
  const works = [
    { display_name: 'Attention is all you need', doi: 'https://doi.org/10.1000/attn' },
    { display_name: 'A totally different paper about glaciers', doi: 'https://doi.org/10.1000/glacier' },
  ];
  const hit = pickDoiByTitle('Attention is all you need', works);
  assert.equal(hit?.doi, '10.1000/attn');
  assert.ok(hit.score >= DOI_TITLE_THRESHOLD);
  assert.equal(pickDoiByTitle('Epsilon notes without a resolvable identifier', works), null);
  assert.equal(pickDoiByTitle('', works), null);
  assert.equal(pickDoiByTitle('Attention is all you need', [{ display_name: 'Attention is all you need' }]), null, '候选缺 DOI 时不得臆造');
});

test('缓存路径按源分文件；arXiv 解析与 DOI 归一化', () => {
  const path = enrichCachePath('/tmp/cache-root', 'crossref', `doi:${ALPHA_DOI}`);
  assert.ok(path.includes(join('enrichment', 'crossref')), path);
  assert.ok(path.endsWith('.json'));
  assert.notEqual(enrichCachePath('/tmp/cache-root', 'openalex', `doi:${ALPHA_DOI}`), path, '不同源必须落在不同文件');
  const feed = parseArxivFeed(
    `<feed><opensearch:totalResults>1</opensearch:totalResults><entry><id>http://arxiv.org/abs/2103.00001v2</id><title>Alpha &amp; Beta</title><link href="https://arxiv.org/pdf/2103.00001v2" rel="related" title="pdf"/><link href="http://arxiv.org/licenses/nonexclusive-distrib/1.0/" rel="license"/><arxiv:doi>${ALPHA_DOI}</arxiv:doi></entry></feed>`,
  );
  assert.equal(feed.totalResults, 1);
  assert.equal(feed.entries[0].title, 'Alpha & Beta');
  assert.equal(feed.entries[0].id, 'https://arxiv.org/abs/2103.00001v2');
  assert.equal(feed.entries[0].license, 'http://arxiv.org/licenses/nonexclusive-distrib/1.0/');
  assert.equal(stripDoi('https://doi.org/10.1000/X.'), '10.1000/X');
  assert.equal(stripDoi('doi: 10.1000/Y'), '10.1000/Y');
});

test('A13 extra 托管块：块外逐字保留、重复补全不追加、journalAbbreviation 不覆盖', () => {
  const intel = mergeIntel([mapOpenAlexWork({ id: 'x', cited_by_count: 10 }), mapSemanticScholarPaper({ paperId: 'y', citationCount: 9, influentialCitationCount: 2 })]);
  const lines = enrichmentBlockLines(intel);
  const first = applyEnrichmentBlock('Citation Key: alpha\n用户手写第二行', intel, '2026-09-18');
  assert.ok(first.startsWith('Citation Key: alpha\n用户手写第二行\n'));
  assert.ok(first.includes(ENRICHMENT_BLOCK_START) && first.includes(ENRICHMENT_BLOCK_END));
  assert.deepEqual(extractEnrichmentBlock(first).lines, lines);
  // 幂等：同一情报（即使换了日期）必须原样返回
  assert.equal(applyEnrichmentBlock(first, intel, '2027-01-01'), first);
  const existing = { extra: first, journalAbbreviation: 'BCAS_CH', tags: ['alpha'] };
  const unchanged = enrichmentWriteSet(existing, 'enriched', intel, '2026-09-18');
  assert.deepEqual(Object.keys(unchanged.fields), [], '无变化时必须零字段');
  assert.equal(unchanged.changed, false);
  // 情报变化：只替换块内内容，块外文本仍逐字保留
  const changed = applyEnrichmentBlock(first, mergeIntel([mapOpenAlexWork({ id: 'x', cited_by_count: 11 })]), '2026-09-19');
  assert.ok(changed.startsWith('Citation Key: alpha\n用户手写第二行\n'));
  assert.equal(changed.match(/zotero-mcp:enrichment:start/gu).length, 1, '块只能有一个');
  assert.ok(changed.includes('cited-by: 11'));
  assert.ok(!changed.includes('cited-by: 10'));
  // 空情报不改动既有文本
  assert.equal(applyEnrichmentBlock('纯用户文本', mergeIntel([]), '2026-09-18'), '纯用户文本');
  assert.equal(applyEnrichmentBlock(null, mergeIntel([]), '2026-09-18'), '');
  // journalAbbreviation 非空时跳过并记录原因
  const skipped = enrichmentWriteSet({ extra: first, journalAbbreviation: 'BCAS_CH', tags: [] }, 'enriched', mergeIntel([mapCrossrefEnrichment({ 'short-container-title': ['OTHER'] })]), '2026-09-18');
  assert.deepEqual(skipped.skipped, [{ field: 'journalAbbreviation', reason: '原值非空（BCAS_CH），按不覆盖原则跳过' }]);
  assert.equal(skipped.fields.journalAbbreviation, undefined);
});

// ── 端到端：外呼纪律、缓存、降级、回退 ──────────────────────────────────

test('A8 外呼一律带 mailto 标识并按主机限速', async () => {
  await withFake(
    async ({ baseUrl }) => {
      const calls = [];
      const clock = virtualClock();
      const report = await enrichItems({
        baseUrl,
        keys: ['ITEM0001'],
        fetchImpl: externalStub(allSourcesHit(), calls),
        io: { ...clock, ...memoryCache() },
        minIntervalMs: 1000,
        s2MinIntervalMs: 3000,
      });
      assert.equal(report.items[0].status, 'enriched');
      assert.equal(calls.length, 7, '6 个源 + PubMed 的第二次外呼');
      for (const call of calls) assert.ok(String(call.headers['user-agent']).includes('mailto:'), `User-Agent 必须带 mailto：${call.url}`);
      const urls = calls.map((call) => call.url);
      assert.ok(urls.some((url) => url.includes('api.crossref.org') && url.includes('mailto=')), 'Crossref 必须带 mailto= query');
      assert.ok(urls.some((url) => url.includes('api.openalex.org') && url.includes('mailto=')), 'OpenAlex 必须带 mailto= query');
      assert.ok(urls.some((url) => url.includes('api.unpaywall.org') && url.includes('email=')), 'Unpaywall 必须带 email=');
      assert.ok(urls.some((url) => url.includes('eutils.ncbi.nlm.nih.gov') && url.includes('email=') && url.includes('tool=')), 'PubMed 必须带 email= 与 tool=');
      for (const entry of report.items[0].calls) assert.ok(entry.mailto.length > 0, '结果里的外呼日志必须保留 mailto');
      // 限速：同一主机相邻两次外呼的时间差不低于配置的最小间隔
      const log = report.items[0].calls;
      for (let index = 1; index < log.length; index += 1) {
        if (log[index].host !== log[index - 1].host) continue;
        assert.ok(log[index].at - log[index - 1].at >= 1000, `同主机间隔不足：${log[index].host} ${log[index].at - log[index - 1].at}ms`);
      }
      assert.ok(clock.state.sleeps.some((ms) => ms > 0), '限速必须真实等待过');
      assert.equal(log.filter((entry) => entry.source === 'semanticscholar').length, 1);
    },
    { library: LIBRARY_ALPHA },
  );
});

test('A9 命中缓存时零外呼，缓存按源分文件落在配置目录并带 TTL', async () => {
  await withFake(
    async ({ baseUrl, cacheDir }) => {
      const clock = virtualClock();
      const cache = memoryCache();
      const first = [];
      const firstReport = await enrichItems({ baseUrl, keys: ['ITEM0001'], fetchImpl: externalStub(allSourcesHit(), first), io: { ...clock, ...cache }, minIntervalMs: 0, s2MinIntervalMs: 0 });
      assert.ok(first.length > 0, '首次必须外呼');
      assert.ok(cache.store.size >= ENRICH_SOURCES.length, `缓存必须按源分文件：${cache.store.size}`);
      for (const [path, text] of cache.store) {
        assert.ok(path.startsWith(join(cacheDir, 'enrichment')), path);
        assert.equal(typeof JSON.parse(text).cachedAt, 'number', '缓存必须带写入时间（TTL 依据）');
      }
      const second = [];
      const secondReport = await enrichItems({ baseUrl, keys: ['ITEM0001'], fetchImpl: externalStub(allSourcesHit(), second), io: { ...clock, ...cache }, minIntervalMs: 0, s2MinIntervalMs: 0 });
      assert.equal(second.length, 0, '第二次必须零外呼');
      assert.deepEqual(secondReport.items[0].intel, firstReport.items[0].intel, '缓存复现的情报必须与首次一致');
      assert.ok(secondReport.items[0].attempts.every((attempt) => attempt.cached), '第二次每个源都必须标记为缓存命中');
      const expired = [];
      await enrichItems({ baseUrl, keys: ['ITEM0001'], fetchImpl: externalStub(allSourcesHit(), expired), io: { ...virtualClock(Date.parse('2027-09-18T00:00:00Z')), ...cache }, minIntervalMs: 0, s2MinIntervalMs: 0 });
      assert.ok(expired.length > 0, 'TTL 过期后必须重新外呼');
    },
    { library: LIBRARY_ALPHA },
  );
});

test('A12 全源失败降级为 needs-enrichment：只写同名标签、不写字段、零非 GET', async () => {
  await withFake(
    async ({ fake, baseUrl }) => {
      const failing = externalStub(
        {
          'api.openalex.org': () => json(503, { error: 'down' }),
          'api.semanticscholar.org': () => json(429, { error: 'rate limited' }),
          'api.crossref.org': () => json(500, { error: 'boom' }),
          'api.unpaywall.org': () => json(502, { error: 'bad gateway' }),
          'eutils.ncbi.nlm.nih.gov': () => json(500, { error: 'boom' }),
          'export.arxiv.org': () => json(503, { error: 'down' }),
        },
        [],
      );
      const report = await enrichItems({ baseUrl, keys: ['ITEM0001'], fetchImpl: failing, io: { ...virtualClock(), ...memoryCache() } });
      const item = report.items[0];
      assert.equal(item.status, 'needs-enrichment');
      assert.deepEqual(Object.keys(item.fields), [], '降级不得写入任何字段');
      assert.ok(item.tags.includes('needs-enrichment'));
      assert.equal(item.intel.citedByCount, null);
      assert.equal(item.intel.openAccess, null);
      assert.ok(item.attempts.every((attempt) => attempt.status === 'failed' && attempt.reason !== null), '失败原因必须记入来源尝试清单');
      const plan = buildEnrichmentPlan(report.items);
      assert.equal(plan.destructive, false);
      assert.equal(plan.confirmKeyword, null);
      assert.equal(plan.operations.length, 1);
      assert.deepEqual(plan.operations[0].fields, { tags: [{ tag: 'alpha' }, { tag: 'needs-enrichment' }] });
      assert.equal(nonGetRequests(fake).length, 0, '补全本身不得发出任何非 GET 请求');
    },
    { library: LIBRARY_ALPHA },
  );
});

test('A10 无 DOI 条目：回退命中则标注来源与相似度；低于阈值则如实记为未解析', async () => {
  const library = {
    children: {},
    items: [{ key: 'ITEM0002', version: 1, data: { itemType: 'journalArticle', title: 'Gamma preprint on scalable enrichment cascades', tags: [] } }],
  };
  await withFake(
    async ({ baseUrl }) => {
      const clock = virtualClock();
      const calls = [];
      const hitStub = externalStub(
        allSourcesHit({
          'api.openalex.org': (parsed) =>
            parsed.pathname === '/works'
              ? json(200, { results: [{ display_name: 'Gamma preprint on scalable enrichment cascades', doi: `https://doi.org/${ALPHA_DOI}` }] })
              : json(200, { id: 'https://openalex.org/W1', doi: `https://doi.org/${ALPHA_DOI}`, cited_by_count: 3, primary_location: { source: {} } }),
        }),
        calls,
      );
      const hit = await enrichItems({ baseUrl, keys: ['ITEM0002'], fetchImpl: hitStub, io: { ...clock, ...memoryCache() } });
      const hitItem = hit.items[0];
      assert.equal(hitItem.doiSource, 'title-fallback');
      assert.equal(hitItem.doi, ALPHA_DOI);
      assert.ok(hitItem.doiSimilarity >= DOI_TITLE_THRESHOLD);
      assert.equal(hitItem.doiFallback.accepted, true);
      assert.ok(hitItem.calls.some((entry) => entry.url.includes('api.openalex.org/works?search=')), '回退检索必须出现在外呼日志里');

      const missCalls = [];
      const missStub = externalStub(
        {
          'api.openalex.org': (parsed) =>
            parsed.pathname === '/works'
              ? json(200, { results: [{ display_name: 'Quantum chromodynamics in heavy-ion collisions', doi: 'https://doi.org/10.1000/other' }] })
              : json(404, { error: 'not found' }),
        },
        missCalls,
      );
      const miss = await enrichItems({ baseUrl, keys: ['ITEM0002'], fetchImpl: missStub, io: { ...virtualClock(), ...memoryCache() } });
      const missItem = miss.items[0];
      assert.equal(missItem.doi, null, '不采纳时不得臆造 DOI');
      assert.equal(missItem.doiSource, null);
      assert.equal(missItem.doiFallback.accepted, false);
      assert.equal(missItem.status, 'needs-enrichment');
      assert.deepEqual(Object.keys(missItem.fields), [], '不采纳时必须不写任何由候选推导的字段');
      assert.equal(missCalls.filter((call) => !call.url.includes('/works?search=')).length, 0, '没有 DOI 时不得外呼其他源');
    },
    { library },
  );
});

// ── 工具面与默认只读 ────────────────────────────────────────────────────

test('A6/A15 工具面：公开工具清单与 write-tools 口径一致，zotero_enrich 契约完备且受默认只读总闸约束', async () => {
  await withFake(
    async ({ fake, client }) => {
      assert.equal(ALL_TOOLS.length, 24);
      assert.equal(TOOL_NAMES.length, 24);
      const { tools } = await client.listTools();
      assert.equal(tools.length, 24);
      const enrich = tools.find((tool) => tool.name === 'zotero_enrich');
      assert.ok(enrich, '缺少 zotero_enrich');
      const schema = enrich.inputSchema;
      assert.deepEqual(schema.properties.mode.enum, ['metadata', 'retractions']);
      assert.deepEqual(schema.properties.sources.items.enum, [...ENRICH_SOURCES]);
      assert.ok(schema.properties.dryRun, '必须有 dryRun 参数');
      assert.ok(schema.properties.keys);
      assert.deepEqual([...schema.required].sort(), ['keys', 'mode']);
      // 默认只读：dryRun=false 且 ZOTERO_MCP_WRITE 未设置 → 拒绝且零请求（含零读请求）
      delete process.env['ZOTERO_MCP_WRITE'];
      const result = await client.callTool({ name: 'zotero_enrich', arguments: { mode: 'metadata', keys: ['ITEM0001'], dryRun: false } });
      assert.equal(result.isError, true);
      assert.match(String(result.content[0].text), /默认只读|ZOTERO_MCP_WRITE/u);
      assert.equal(fake.requests.length, 0, '被拒绝时假服务器必须收到零请求');
      // 默认 dry-run：正常返回计划与逐条情报，且没有任何写请求
      // （工具层走全局 fetch，这里临时替换成离线桩，保证测试不依赖真实外呼）
      const calls = [];
      const preview = await withGlobalFetch(externalStub(allSourcesHit(), calls), () =>
        client.callTool({ name: 'zotero_enrich', arguments: { mode: 'metadata', keys: ['ITEM0001'] } }),
      );
      assert.equal(preview.isError, undefined);
      const body = JSON.parse(String(preview.content[0].text));
      assert.equal(body.dryRun, true);
      assert.equal(body.writeEnabled, false);
      assert.equal(body.items.length, 1);
      assert.equal(body.items[0].status, 'enriched');
      assert.ok(body.calls.length > 0);
      assert.equal(body.calls.every((call) => typeof call.mailto === 'string' && call.mailto.length > 0), true);
      assert.ok(calls.length > 0, 'dry-run 必须真实外呼（否则情报无从谈起）');
      assert.equal(nonGetRequests(fake).length, 0);
    },
    { library: LIBRARY_ALPHA },
  );
});

test('A4/A14 默认只读零请求且凭证只进不出：S2 key 只出现在请求头', async () => {
  await withFake(
    async ({ fake, client, baseUrl, cacheDir }) => {
      process.env['ZOTERO_MCP_S2_API_KEY'] = S2_KEY;
      delete process.env['ZOTERO_MCP_WRITE'];
      const rejected = await client.callTool({ name: 'zotero_enrich', arguments: { mode: 'metadata', keys: ['ITEM0001'], dryRun: false } });
      assert.equal(rejected.isError, true);
      assert.equal(fake.requests.length, 0);
      assert.ok(!String(rejected.content[0].text).includes(S2_KEY));
      const calls = [];
      const report = await enrichItems({ baseUrl, keys: ['ITEM0001'], fetchImpl: externalStub(allSourcesHit(), calls), io: { ...virtualClock(), ...memoryCache() }, cacheDir });
      const s2Calls = calls.filter((call) => call.host === 'api.semanticscholar.org');
      assert.equal(s2Calls.length, 1);
      assert.equal(s2Calls[0].headers['x-api-key'], S2_KEY, 'key 必须只出现在请求头');
      assert.ok(!s2Calls[0].url.includes(S2_KEY), 'key 绝不能出现在 URL');
      assert.ok(!JSON.stringify(report).includes(S2_KEY), 'key 绝不能出现在结果里');
      assert.ok(!JSON.stringify(buildEnrichmentPlan(report.items)).includes(S2_KEY), 'key 绝不能出现在计划里');
      assert.ok(!JSON.stringify(report.items[0].calls).includes(S2_KEY), 'key 绝不能出现在外呼日志里');
      delete process.env['ZOTERO_MCP_S2_API_KEY'];
      const publicCalls = [];
      await enrichItems({ baseUrl, keys: ['ITEM0001'], fetchImpl: externalStub(allSourcesHit(), publicCalls), io: { ...virtualClock(), ...memoryCache() }, cacheDir });
      assert.equal(publicCalls.find((call) => call.host === 'api.semanticscholar.org')?.headers['x-api-key'], undefined, '未配置 key 时走公共池');
    },
    { library: LIBRARY_ALPHA },
  );
});

test('A3 补全写入经写安全管线：一次授权 → 写前快照 → 逐条 PATCH → 回读校验 → 审计 JSONL', async () => {
  await withFake(
    async ({ fake, baseUrl, auditDir, cacheDir }) => {
      process.env['ZOTERO_MCP_WRITE'] = 'on';
      process.env['ZOTERO_MCP_AUDIT_DIR'] = auditDir;
      const report = await enrichItems({ baseUrl, keys: ['ITEM0001'], fetchImpl: externalStub(allSourcesHit(), []), io: { ...virtualClock(), ...memoryCache() }, cacheDir });
      const plan = buildEnrichmentPlan(report.items);
      assert.equal(nonGetRequests(fake).length, 0, '编译计划阶段不得有任何写请求');
      const repoAuditBefore = repoAuditLineCount();
      const result = await applyPlan(plan, { baseUrl, auditDir, write: true });
      assert.equal(result.authorizeCount, 1, '一个计划只授权一次');
      assert.ok(result.auditPath.startsWith(auditDir), `审计必须落在临时目录：${result.auditPath}`);
      assert.ok(result.snapshotPath.startsWith(auditDir), `快照必须落在临时目录：${result.snapshotPath}`);
      assert.equal(repoAuditLineCount(), repoAuditBefore, '契约测试不得污染仓库真实 .audit/audit.jsonl');
      const [after] = await getItems({ baseUrl, keys: ['ITEM0001'] });
      assert.ok(String(after.data.extra).includes(ENRICHMENT_BLOCK_START));
      assert.ok(String(after.data.extra).startsWith('Citation Key: alpha'), '块外文本必须逐字保留');
      assert.equal(after.data.journalAbbreviation, 'J. Reprod. Pipelines');
      assert.deepEqual(after.data.tags.map((tag) => tag.tag ?? tag), ['alpha', 'open-access']);
      assert.ok(existsSync(result.snapshotPath), '必须有写前快照');
      assert.equal(JSON.parse(readFileSync(result.snapshotPath, 'utf8')).items.length, 1, '快照必须含受影响条目的写入前状态');
      const audit = readFileSync(result.auditPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(audit.length >= 1, '必须有审计 JSONL');
      assert.ok(!readFileSync(result.auditPath, 'utf8').includes(S2_KEY));
      // 幂等：把写入后的状态当作现状再补全一次 → 零操作
      const second = await enrichItems({ baseUrl, keys: ['ITEM0001'], fetchImpl: externalStub(allSourcesHit(), []), io: { ...virtualClock(Date.parse('2026-09-19T00:00:00Z')), ...memoryCache() }, cacheDir });
      const secondPlan = buildEnrichmentPlan(second.items);
      assert.deepEqual(secondPlan.operations, [], '同一情报的第二次补全必须零操作');
      assert.equal(previewPlan(secondPlan).includes('OVERWRITE'), false);
    },
    { library: LIBRARY_ALPHA },
  );
});

test('A2/A11 端到端：OA 级联与撤稿标记写进计划', async () => {
  await withFake(
    async ({ baseUrl }) => {
      const fetchImpl = externalStub(
        allSourcesHit({
          'api.unpaywall.org': () => json(404, { error: 'DOI not found' }),
          'api.openalex.org': () =>
            json(200, {
              id: 'https://openalex.org/W2',
              doi: `https://doi.org/${BETA_DOI}`,
              cited_by_count: 2963,
              is_retracted: true,
              ids: {},
              primary_location: { source: { display_name: 'The Lancet', abbreviated_title: null } },
            }),
          'api.semanticscholar.org': () => json(200, { paperId: 'S2P', citationCount: 1, influentialCitationCount: 0, openAccessPdf: null, externalIds: { DOI: BETA_DOI } }),
          'api.crossref.org': () =>
            json(200, { message: { DOI: BETA_DOI, 'short-container-title': ['Lancet'], 'updated-by': [{ DOI: '10.1000/beta.notice', type: 'retraction', label: 'Retraction' }] } }),
          'eutils.ncbi.nlm.nih.gov': (parsed) =>
            parsed.pathname.includes('esummary')
              ? json(200, { result: { '9000001': { source: 'Lancet', pubtype: ['Journal Article', 'Retracted Publication'], articleids: [] } } })
              : json(200, { esearchresult: { idlist: ['9000001'] } }),
          'export.arxiv.org': () => new Response('<feed><opensearch:totalResults>0</opensearch:totalResults></feed>', { status: 200 }),
        }),
        [],
      );
      const report = await enrichItems({ baseUrl, keys: ['ITEM0004'], fetchImpl, io: { ...virtualClock(), ...memoryCache() } });
      const item = report.items[0];
      assert.equal(item.intel.retracted, true);
      assert.deepEqual([...item.intel.retractionSources].sort(), ['crossref', 'openalex', 'pubmed']);
      assert.equal(item.intel.retractionDoi, '10.1000/beta.notice');
      assert.equal(item.intel.openAccess, null, '全部 OA 源未命中不得伪造 OA');
      assert.ok(item.tags.includes('retracted'));
      assert.ok(!item.tags.includes('open-access'));
      assert.ok(item.fields.extra.includes('retracted: yes'));
      assert.ok(item.fields.extra.includes('10.1000/beta.notice'), 'extra 托管块必须写明撤稿通知 DOI');
      assert.ok(item.fields.extra.includes('cited-by: 2963'), '引用数与撤稿可以同时写入');
    },
    { library: { children: {}, items: [{ key: 'ITEM0004', version: 1, data: { itemType: 'journalArticle', title: 'Beta paper', DOI: BETA_DOI, tags: [{ tag: 'beta' }] } }] } },
  );
});

test('非撤稿条目不得写 retracted 标签；本能力不使用破坏性确认', async () => {
  await withFake(
    async ({ baseUrl }) => {
      const report = await enrichItems({ baseUrl, keys: ['ITEM0001'], fetchImpl: externalStub(allSourcesHit(), []), io: { ...virtualClock(), ...memoryCache() } });
      const item = report.items[0];
      assert.equal(item.intel.retracted, false);
      assert.ok(!item.tags.includes('retracted'));
      const plan = buildEnrichmentPlan(report.items);
      assert.equal(plan.destructive, false);
      assert.equal(plan.confirmKeyword, null);
      // 管线不因本能力而放宽：手工构造的破坏性计划仍然需要确认
      const destructive = makeChangePlan({
        targetKeys: ['ITEM0001'],
        changes: [{ key: 'ITEM0001', field: 'extra', before: 'x', after: 'y' }],
        operations: [{ kind: 'patch', key: 'ITEM0001', fields: { extra: 'y' } }],
        summary: 'x',
      });
      assert.equal(destructive.destructive, true);
      assert.equal(destructive.confirmKeyword, 'OVERWRITE');
    },
    { library: LIBRARY_ALPHA },
  );
});

// ── 报告与演示脚本 ──────────────────────────────────────────────────────

test('A5 报告只读：--fixtures 确定性、退出码 0、零写请求、不产生审计与快照', async () => {
  const auditProbe = mkdtempSync(join(tmpdir(), 'zotero-mcp-enrich-report-'));
  try {
    const env = { ...process.env, ZOTERO_MCP_AUDIT_DIR: auditProbe };
    delete env['ZOTERO_MCP_WRITE'];
    const run = (extraEnv = {}) => execFileAsync(process.execPath, [REPORT_SCRIPT, '--fixtures'], { cwd: ROOT, env: { ...env, ...extraEnv }, maxBuffer: 8 * 1024 * 1024 });
    const first = await run();
    const second = await run();
    assert.equal(first.stdout, second.stdout, '两次 --fixtures 输出必须完全一致（可复现）');
    const out = second.stdout;
    assert.match(out, /元数据补全报告（只读）/u);
    assert.match(out, /enriched/u);
    assert.match(out, /needs-enrichment/u);
    assert.match(out, /将写入的字段：/u);
    assert.match(out, /将写入的标签：/u);
    assert.match(out, /mailto=zotero-mcp@localhost/u, '外呼日志必须保留 mailto');
    assert.match(out, /写请求：0 次/u);
    assert.ok(!out.includes(S2_KEY));
    assert.equal(existsSync(join(auditProbe, 'audit.jsonl')), false, '报告不得产生审计');
    assert.equal(existsSync(join(auditProbe, 'snapshots')), false, '报告不得产生快照');
    // fixtures 模式不得回环访问真实库：把 baseUrl 指向不可达地址也必须成功
    const offline = await run({ ZOTERO_MCP_BASE_URL: 'http://127.0.0.1:1' });
    assert.equal(offline.stdout, first.stdout);
  } finally {
    rmSync(auditProbe, { recursive: true, force: true });
  }
});

test('A7 演示：默认 dry-run 零写请求；--apply 在假服务器上完成一次性条目闭环并留证据', async () => {
  const auditProbe = mkdtempSync(join(tmpdir(), 'zotero-mcp-enrich-demo-'));
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  try {
    const env = {
      ...process.env,
      ZOTERO_MCP_BASE_URL: fake.url,
      ZOTERO_MCP_AUDIT_DIR: auditProbe,
      ZOTERO_MCP_WRITE: 'on',
      ZOTERO_MCP_CACHE_DIR: join(auditProbe, 'cache'),
    };
    const baseline = fake.requests.length;
    const dry = await execFileAsync(process.execPath, [DEMO_SCRIPT, '--fixtures'], { cwd: ROOT, env, maxBuffer: 8 * 1024 * 1024 });
    assert.match(dry.stdout, /dry-run 完成/u);
    assert.equal(fake.requests.slice(baseline).filter((request) => request.method !== 'GET').length, 0, '默认 dry-run 不得发出任何写请求');
    assert.equal(existsSync(join(auditProbe, 'audit.jsonl')), false, 'dry-run 不得产生审计');

    const applied = await execFileAsync(process.execPath, [DEMO_SCRIPT, '--apply', '--fixtures'], { cwd: ROOT, env, maxBuffer: 8 * 1024 * 1024 });
    assert.match(applied.stdout, /补全结果：enriched/u);
    assert.match(applied.stdout, /回读通过：extra 含托管块且块外文本逐字保留/u);
    assert.match(applied.stdout, /幂等通过/u);
    assert.match(applied.stdout, /已移入垃圾箱/u);
    assert.match(applied.stdout, /彻底删除完成/u);
    assert.match(applied.stdout, /库已回到演示前状态/u);
    assert.ok(existsSync(join(auditProbe, 'audit.jsonl')), '必须留下审计 JSONL');
    assert.ok(readdirSync(join(auditProbe, 'snapshots')).length >= 3, '必须有创建 / 补全 / 删除的写前快照');
    const evidenceFile = readdirSync(auditProbe).find((name) => name.startsWith('enrich-demo-') && name.endsWith('.json'));
    assert.ok(evidenceFile, '必须有可独立核对的证据文件');
    const evidence = JSON.parse(readFileSync(join(auditProbe, evidenceFile), 'utf8'));
    assert.equal(evidence.ok, true);
    assert.equal(evidence.cleanup.added, 0);
    assert.equal(evidence.cleanup.changedExisting, 0);
    assert.deepEqual(evidence.cleanup.libraryKeys, ['ITEM0001', 'ITEM0002', 'ITEM0003']);
    assert.equal(evidence.readback.outsideTextPreserved, true);
    assert.ok(evidence.readback.extra.includes(ENRICHMENT_BLOCK_START));
    assert.deepEqual(evidence.idempotent, { operations: 0, status: 'enriched' });
    assert.ok(evidence.enrichment.calls.every((call) => typeof call.mailto === 'string' && call.mailto.length > 0));
    assert.ok(!readFileSync(join(auditProbe, 'audit.jsonl'), 'utf8').includes(S2_KEY));
  } finally {
    await fake.close();
    rmSync(auditProbe, { recursive: true, force: true });
  }
});
