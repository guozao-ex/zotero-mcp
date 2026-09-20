#!/usr/bin/env node
/**
 * 离线固件加载器（G8 元数据补全）。
 *
 * 把 `tests/fixtures/enrichment-fixtures.json` 变成一个可控的 `fetch` 实现：
 * - 回环地址（127.0.0.1 / localhost）当作 Zotero 本地 API，按 key 返回固件条目；
 * - 外部主机按 DOI / 标题匹配固件记录，逐源返回预置状态码与载荷。
 *
 * 用途：`npm run report:enrichment --fixtures` 的确定性离线运行，以及契约测试的可复现输入。
 * 本模块只读固件与返回内存响应，绝不做真实网络访问、绝不写库。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FIXTURE_PATH = fileURLToPath(new URL('../tests/fixtures/enrichment-fixtures.json', import.meta.url));

export function loadEnrichmentFixtures(path = FIXTURE_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function responseOf(spec, fallbackBody = '{}') {
  const status = typeof spec?.status === 'number' ? spec.status : 200;
  const body = spec?.body === undefined ? fallbackBody : spec.body;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': typeof body === 'string' ? 'application/atom+xml' : 'application/json' },
  });
}

/** 按 URL 里的 DOI / 标题找到固件记录（先 DOI，再标题）。 */
function findRecord(fixture, decodedUrl) {
  const byDoi = fixture.records.find((record) => typeof record.doi === 'string' && decodedUrl.includes(record.doi));
  if (byDoi !== undefined) return byDoi;
  return fixture.records.find((record) => typeof record.title === 'string' && decodedUrl.includes(record.title)) ?? null;
}

/** PubMed esummary 的 URL 只带 PMID：按固件里的 esearch 结果反查记录。 */
function findRecordByPmid(fixture, pmid) {
  return (
    fixture.records.find((record) =>
      (record.sources?.pubmed?.esearch?.body?.esearchresult?.idlist ?? []).includes(pmid),
    ) ?? null
  );
}

/**
 * 构造固件 fetch。
 * @param {object} fixture loadEnrichmentFixtures() 的结果
 * @param {{requests?: object[]}} [options] 传入数组可收集每次请求（断言「零外呼」用）
 */
export function createFixtureFetch(fixture, options = {}) {
  const requests = options.requests ?? [];
  return async function fixtureFetch(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url ?? String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    requests.push({ method, url });
    const parsed = new URL(url);
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') {
      const match = /\/items\/([^/?]+)/u.exec(parsed.pathname);
      if (match === null) return new Response(JSON.stringify({ error: 'unsupported path' }), { status: 404 });
      const item = fixture.library.items.find((entry) => entry.key === match[1]);
      if (item === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
      return new Response(JSON.stringify(item), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const decoded = decodeURIComponent(url);
    const host = parsed.hostname;
    if (host === 'eutils.ncbi.nlm.nih.gov') {
      const isSummary = parsed.pathname.includes('esummary');
      const pmid = parsed.searchParams.get('id');
      const record = isSummary && pmid !== null ? findRecordByPmid(fixture, pmid) : findRecord(fixture, decoded);
      if (record === null) return new Response(JSON.stringify({ error: 'no pubmed fixture' }), { status: 404 });
      const spec = isSummary ? record.sources.pubmed?.esummary : record.sources.pubmed?.esearch;
      if (spec === undefined) return new Response(JSON.stringify({ error: 'no pubmed fixture' }), { status: 404 });
      return responseOf(spec);
    }
    const record = findRecord(fixture, decoded);
    if (record === null) return new Response(JSON.stringify({ error: 'no fixture record' }), { status: 404 });
    if (host === 'api.openalex.org' && parsed.pathname === '/works') {
      return responseOf(record.titleSearch ?? { status: 404, body: { error: 'no title fixture' } });
    }
    if (host === 'api.openalex.org') return responseOf(record.sources.openalex);
    if (host === 'api.semanticscholar.org') return responseOf(record.sources.semanticscholar);
    if (host === 'api.crossref.org') return responseOf(record.sources.crossref);
    if (host === 'api.unpaywall.org') return responseOf(record.sources.unpaywall);
    if (host === 'export.arxiv.org') return responseOf(record.sources.arxiv, '');
    return new Response(JSON.stringify({ error: `unexpected host ${host}` }), { status: 404 });
  };
}

/** 内存缓存（离线运行用：不落盘、结果与运行次数无关）。 */
export function createMemoryCache() {
  const store = new Map();
  return {
    store,
    readCache: async (path) => (store.has(path) ? store.get(path) : null),
    writeCache: async (path, text) => {
      store.set(path, text);
    },
  };
}

/**
 * 固定时钟（离线运行用）：`sleep` 推进虚拟时间，因此限速不产生真实等待，
 * 且同一份输入永远产出同一份报告。
 */
export function createFixedClock(startMs = Date.parse('2026-09-18T00:00:00Z')) {
  const state = { now: startMs };
  return {
    now: () => state.now,
    sleep: async (ms) => {
      state.now += ms;
    },
  };
}
