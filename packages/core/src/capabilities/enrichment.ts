/**
 * 元数据补全与学术情报（G8，M3 change 8）。
 *
 * 给定库内条目，按 DOI（缺失时回退标题检索）级联外部学术 API，取回四类情报：
 *   - 引用数与影响力：OpenAlex `cited_by_count`、Semantic Scholar `citationCount` / `influentialCitationCount`；
 *   - 撤稿标记：OpenAlex `is_retracted`、Crossref `updated-by` / `update-to`、PubMed `pubtype`；
 *   - OA 级联：Unpaywall → Semantic Scholar `openAccessPdf` → arXiv → PMC；
 *   - 期刊缩写：Crossref `short-container-title` > OpenAlex 期刊缩写 > PubMed `source`。
 *
 * 纪律（与 brief「约束与不变量」逐条对应）：
 * - 每个外呼都带 `mailto` 标识：Crossref / OpenAlex 用 `mailto=` query，Unpaywall / PubMed 用
 *   `email=`（PubMed 另带 `tool=`），Semantic Scholar 与 arXiv 用带 `mailto` 的 `User-Agent`；
 * - 按主机限速（默认相邻请求 ≥ 1000 ms，Semantic Scholar 更保守），每请求都有超时，
 *   单源失败 / 超时 / 限流都不得中断其他源，失败原因记入来源尝试清单；
 * - 「源 + 目标」命中缓存即不再外呼：缓存按源分文件、带 TTL，目录复用 `resolveCacheDir()`；
 * - 补全本身**只读**：不写库、不产生审计；写入由调用方经写安全管线完成；
 * - 凭证只进不出：`ZOTERO_MCP_S2_API_KEY` 只出现在请求头，绝不进入 URL、结果、计划、快照与审计；
 * - 降级不臆造数据：拿不到的情报一律留空，全源拿不到时状态为 `needs-enrichment` 且只写同名标签。
 *
 * 真机实测（2026-09-18）：Crossref 撤稿标记在原始记录上是 `updated-by`（指向撤稿通知），
 * 在撤稿通知记录上是 `update-to`（指向被撤原文）；Semantic Scholar Graph 当前不接受
 * `isRetracted` 字段（`Unrecognized or unsupported fields`），因此不作为信号来源；
 * Unpaywall 对未收录 DOI 返回 404，不算整条失败，必须继续下一源。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveCacheDir } from '../paths.ts';
import { jaroWinkler, normalizeTitle } from './dedupe.ts';
import { makeChangePlan, readItemEnvelope } from './write-pipeline.ts';
import { DEFAULT_CROSSREF_MAILTO } from './write-tools.ts';
import type { ChannelOptions, ItemEnvelope } from './read.ts';
import type { ChangePlan, FieldChange, PlanOperation } from './write-pipeline.ts';

// ── 常量与枚举 ──────────────────────────────────────────────────────────

/** 源清单（规格固定）。 */
export const ENRICH_SOURCES = ['openalex', 'semanticscholar', 'crossref', 'unpaywall', 'pubmed', 'arxiv'] as const;
export type EnrichSource = (typeof ENRICH_SOURCES)[number];

export const ENRICH_MODES = ['metadata', 'retractions'] as const;
export type EnrichMode = (typeof ENRICH_MODES)[number];

/** 撤稿信号源：Semantic Scholar 的 `isRetracted` 在上游当前不可用，不得作为信号来源。 */
export const RETRACTION_SOURCES: readonly EnrichSource[] = ['openalex', 'crossref', 'pubmed'];

/** 无 DOI 时按标题回退解析的采纳阈值（Jaro-Winkler）。 */
export const DOI_TITLE_THRESHOLD = 0.8;

/** 按主机限速：同一主机相邻两次外呼的最小间隔（毫秒）。 */
export const DEFAULT_ENRICH_MIN_INTERVAL_MS = 1000;
/** Semantic Scholar 无 key 时走公共池，限速更保守。 */
export const DEFAULT_ENRICH_S2_MIN_INTERVAL_MS = 3000;
export const DEFAULT_ENRICH_TIMEOUT_MS = 15_000;
export const DEFAULT_ENRICH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 缓存子目录名（位于 `ZOTERO_MCP_CACHE_DIR` 之下，按源分文件）。 */
export const ENRICH_CACHE_DIRNAME = 'enrichment';

/** 标签约定（与既有标签合并，只增不减）。 */
export const RETRACTED_TAG = 'retracted';
export const OPEN_ACCESS_TAG = 'open-access';
export const NEEDS_ENRICHMENT_TAG = 'needs-enrichment';

/** `extra` 托管块的起止标记（块内由本能力维护，块外逐字保留）。 */
export const ENRICHMENT_BLOCK_START = '<!-- zotero-mcp:enrichment:start -->';
export const ENRICHMENT_BLOCK_END = '<!-- zotero-mcp:enrichment:end -->';

/** OA 级联顺序（规格固定）；`pmc` 不是独立外呼源，而是由 PMCID 推导出的 PMC 全文入口。 */
export const OA_CASCADE = ['unpaywall', 'semanticscholar', 'arxiv', 'pmc'] as const;
export type OaCascadeSource = (typeof OA_CASCADE)[number];

export const DEFAULT_ENRICH_MAILTO = DEFAULT_CROSSREF_MAILTO;

const SOURCE_HOSTS: Record<EnrichSource, string> = {
  openalex: 'api.openalex.org',
  semanticscholar: 'api.semanticscholar.org',
  crossref: 'api.crossref.org',
  unpaywall: 'api.unpaywall.org',
  pubmed: 'eutils.ncbi.nlm.nih.gov',
  arxiv: 'export.arxiv.org',
};

/** Semantic Scholar 只请求需要的字段（`isRetracted` 上游不可用，不得出现）。 */
const S2_FIELDS = 'citationCount,influentialCitationCount,openAccessPdf,externalIds,title';
const USER_AGENT_PRODUCT = 'zotero-mcp/0.1';

// ── 环境解析 ────────────────────────────────────────────────────────────

function envNonNegativeNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** 外呼礼貌池邮箱：显式参数 > `ZOTERO_MCP_CROSSREF_MAILTO` > 默认值。 */
export function resolveEnrichMailto(override?: string): string {
  const value = override ?? process.env['ZOTERO_MCP_CROSSREF_MAILTO'] ?? DEFAULT_ENRICH_MAILTO;
  return value.trim().length === 0 ? DEFAULT_ENRICH_MAILTO : value.trim();
}

/** 每个请求都带 `mailto`：S2 / arXiv 无对应 query 参数，用 User-Agent 承载。 */
export function enrichUserAgent(mailto: string): string {
  return `${USER_AGENT_PRODUCT} (mailto:${mailto})`;
}

/** Semantic Scholar 可选令牌：只进请求头，绝不进 URL。 */
function s2ApiKey(): string | null {
  const raw = process.env['ZOTERO_MCP_S2_API_KEY'];
  if (raw === undefined) return null;
  const value = raw.trim();
  return value.length === 0 ? null : value;
}

export function resolveEnrichMinIntervalMs(override?: number): number {
  return override ?? envNonNegativeNumber('ZOTERO_MCP_ENRICH_MIN_INTERVAL_MS', DEFAULT_ENRICH_MIN_INTERVAL_MS);
}

export function resolveEnrichS2MinIntervalMs(override?: number): number {
  return override ?? envNonNegativeNumber('ZOTERO_MCP_ENRICH_S2_MIN_INTERVAL_MS', DEFAULT_ENRICH_S2_MIN_INTERVAL_MS);
}

export function resolveEnrichTimeoutMs(override?: number): number {
  return override ?? envNonNegativeNumber('ZOTERO_MCP_ENRICH_TIMEOUT_MS', DEFAULT_ENRICH_TIMEOUT_MS);
}

export function resolveEnrichCacheTtlMs(override?: number): number {
  return override ?? envNonNegativeNumber('ZOTERO_MCP_ENRICH_CACHE_TTL_MS', DEFAULT_ENRICH_CACHE_TTL_MS);
}

// ── 纯工具函数 ──────────────────────────────────────────────────────────

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 去掉 DOI 的 URL 前缀与尾随标点。 */
export function stripDoi(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const cleaned = raw
    .trim()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//iu, '')
    .replace(/^doi:\s*/iu, '')
    .replace(/[.,;]+$/u, '')
    .trim();
  return cleaned.length === 0 ? null : cleaned;
}

/** DOI 比较（大小写无关）。 */
export function sameDoi(left: string | null, right: string | null): boolean {
  if (left === null || right === null) return false;
  return left.toLowerCase() === right.toLowerCase();
}

/** PMC id 归一成裸数字（上游可能给 `PMC5426675`、数字或 URL）。 */
export function normalizePmcId(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const match = /(\d{3,9})/u.exec(raw.replace(/^PMC/iu, ' '));
  return match?.[1] ?? null;
}

/** PMC 全文入口（OA 级联的最后一级）。 */
export function pmcArticleUrl(pmcId: string): string {
  return `https://www.ncbi.nlm.nih.gov/pmc/articles/PMC${pmcId}/`;
}

export function decodeXmlEntities(text: string): string {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

// ── 源响应 → 归一化情报（纯函数，离线可测） ─────────────────────────────

/** 单个源为一条条目贡献的情报；映射是纯函数，绝不发请求。 */
export interface SourceIntel {
  source: EnrichSource;
  doi: string | null;
  citedByCount: number | null;
  citationCount: number | null;
  influentialCitationCount: number | null;
  retracted: boolean;
  retractionLabel: string | null;
  retractionDoi: string | null;
  journalName: string | null;
  journalAbbreviation: string | null;
  pmcId: string | null;
  oaUrl: string | null;
  oaLicense: string | null;
  oaStatus: string | null;
}

function emptyIntel(source: EnrichSource): SourceIntel {
  return {
    source,
    doi: null,
    citedByCount: null,
    citationCount: null,
    influentialCitationCount: null,
    retracted: false,
    retractionLabel: null,
    retractionDoi: null,
    journalName: null,
    journalAbbreviation: null,
    pmcId: null,
    oaUrl: null,
    oaLicense: null,
    oaStatus: null,
  };
}

function firstArrayString(value: unknown): string | null {
  for (const entry of asArray(value)) {
    const text = asString(entry);
    if (text !== null) return text;
  }
  return asString(value);
}

/** OpenAlex work → 情报（引用数 / 撤稿 / 期刊缩写 / PMCID）。 */
export function mapOpenAlexWork(work: unknown): SourceIntel {
  const intel = emptyIntel('openalex');
  const record = asRecord(work);
  if (record === null) return intel;
  intel.doi = stripDoi(asString(record['doi']));
  intel.citedByCount = asNumber(record['cited_by_count']);
  intel.retracted = record['is_retracted'] === true;
  const ids = asRecord(record['ids']);
  intel.pmcId = ids === null ? null : normalizePmcId(asString(ids['pmcid']));
  const location = asRecord(record['primary_location']);
  const source = location === null ? null : asRecord(location['source']);
  if (source !== null) {
    intel.journalName = asString(source['display_name']);
    intel.journalAbbreviation = asString(source['abbreviated_title']);
  }
  return intel;
}

/** Semantic Scholar Graph paper → 情报（引用数 / 影响力 / OA PDF / PMCID）。 */
export function mapSemanticScholarPaper(paper: unknown): SourceIntel {
  const intel = emptyIntel('semanticscholar');
  const record = asRecord(paper);
  if (record === null) return intel;
  intel.citationCount = asNumber(record['citationCount']);
  intel.influentialCitationCount = asNumber(record['influentialCitationCount']);
  const pdf = asRecord(record['openAccessPdf']);
  if (pdf !== null) {
    intel.oaUrl = asString(pdf['url']);
    intel.oaLicense = asString(pdf['license']);
  }
  const external = asRecord(record['externalIds']);
  if (external !== null) {
    intel.doi = stripDoi(asString(external['DOI']));
    intel.pmcId = normalizePmcId(asString(external['PubMedCentral']));
  }
  return intel;
}

/**
 * Crossref work → 情报（期刊缩写 / 撤稿）。
 *
 * 真机语义：被撤稿的原始记录在 `updated-by` 里带 `type: "retraction"` 的条目，
 * 其 `DOI` 是撤稿通知 DOI；撤稿通知记录本身在 `update-to` 里指向被撤原文。
 */
export function mapCrossrefEnrichment(work: unknown): SourceIntel {
  const intel = emptyIntel('crossref');
  const record = asRecord(work);
  if (record === null) return intel;
  intel.doi = stripDoi(asString(record['DOI']));
  intel.journalName = firstArrayString(record['container-title']);
  intel.journalAbbreviation = firstArrayString(record['short-container-title']);
  for (const entry of asArray(record['updated-by'])) {
    const row = asRecord(entry);
    if (row === null || asString(row['type']) !== 'retraction') continue;
    intel.retracted = true;
    intel.retractionLabel = asString(row['label']) ?? asString(row['type']);
    intel.retractionDoi = stripDoi(asString(row['DOI']));
    break;
  }
  if (!intel.retracted) {
    for (const entry of asArray(record['update-to'])) {
      const row = asRecord(entry);
      if (row === null || asString(row['type']) !== 'retraction') continue;
      intel.retracted = true;
      intel.retractionLabel = asString(row['label']) ?? asString(row['type']);
      // 本记录就是撤稿通知，通知 DOI 即它自己的 DOI
      intel.retractionDoi = intel.doi;
      break;
    }
  }
  return intel;
}

/** Unpaywall 记录 → 情报（OA 级联第一级）。未收录（404）由调用方映射为 miss。 */
export function mapUnpaywallRecord(record: unknown): SourceIntel {
  const intel = emptyIntel('unpaywall');
  const body = asRecord(record);
  if (body === null) return intel;
  intel.doi = stripDoi(asString(body['doi']));
  intel.oaStatus = asString(body['oa_status']);
  if (body['is_oa'] !== true) return intel;
  const best = asRecord(body['best_oa_location']);
  if (best === null) return intel;
  intel.oaUrl = asString(best['url_for_pdf']) ?? asString(best['url']) ?? asString(best['url_for_landing_page']);
  intel.oaLicense = asString(best['license']);
  return intel;
}

/** PubMed esummary → 情报（撤稿 pubtype / 期刊缩写 source / PMCID）。 */
export function mapPubmedEsummary(summary: unknown): SourceIntel {
  const intel = emptyIntel('pubmed');
  const record = asRecord(summary);
  if (record === null) return intel;
  const pubtypes = asArray(record['pubtype'])
    .map((entry) => asString(entry))
    .filter((entry): entry is string => entry !== null);
  const retractedType = pubtypes.find((entry) => /retracted publication/iu.test(entry));
  if (retractedType !== undefined) {
    intel.retracted = true;
    intel.retractionLabel = retractedType;
  }
  intel.journalAbbreviation = asString(record['source']);
  for (const entry of asArray(record['articleids'])) {
    const row = asRecord(entry);
    if (row === null) continue;
    const idtype = asString(row['idtype']);
    if (idtype === 'doi' && intel.doi === null) intel.doi = stripDoi(asString(row['value']));
    if (idtype === 'pmc' && intel.pmcId === null) intel.pmcId = normalizePmcId(asString(row['value']));
  }
  return intel;
}

export interface ArxivEntry {
  /** 规范化后的 abs 页地址（https）。 */
  id: string;
  title: string;
  doi: string | null;
  pdfUrl: string | null;
  license: string | null;
}

function attrOf(tag: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'u').exec(tag);
  return match?.[1] === undefined ? null : decodeXmlEntities(match[1]);
}

/** arXiv Atom feed → 条目列表（不引入 XML 依赖，只用正则解析受控结构）。 */
export function parseArxivFeed(xml: string): { totalResults: number; entries: ArxivEntry[] } {
  const totalRaw = /<opensearch:totalResults[^>]*>(\d+)<\/opensearch:totalResults>/u.exec(xml)?.[1];
  const entries: ArxivEntry[] = [];
  for (const match of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/gu)) {
    const body = match[1] ?? '';
    const rawId = (/<id>([^<]+)<\/id>/u.exec(body)?.[1] ?? '').trim();
    if (rawId.length === 0) continue;
    const title = decodeXmlEntities((/<title>([\s\S]*?)<\/title>/u.exec(body)?.[1] ?? '').replaceAll(/\s+/gu, ' ').trim());
    const doi = asString(/<arxiv:doi[^>]*>([^<]*)<\/arxiv:doi>/u.exec(body)?.[1]);
    let pdfUrl: string | null = null;
    let license: string | null = null;
    for (const link of body.matchAll(/<link\b[^>]*>/gu)) {
      const tag = link[0];
      const rel = attrOf(tag, 'rel');
      const href = attrOf(tag, 'href');
      if (href === null) continue;
      if (rel === 'related' && attrOf(tag, 'title') === 'pdf') pdfUrl = href;
      if (rel === 'license') license = href;
    }
    entries.push({ id: rawId.replace(/^http:/u, 'https:'), title, doi, pdfUrl, license });
  }
  return { totalResults: totalRaw === undefined ? entries.length : Number.parseInt(totalRaw, 10), entries };
}

/** arXiv 条目 → 情报（OA 级联第三级）。 */
export function mapArxivEntry(entry: ArxivEntry): SourceIntel {
  const intel = emptyIntel('arxiv');
  intel.doi = stripDoi(entry.doi);
  intel.oaUrl = entry.id;
  intel.oaLicense = entry.license;
  intel.oaStatus = 'preprint';
  return intel;
}

// ── 情报合并（级联与优先级） ────────────────────────────────────────────

/** 合并后的补全情报：每个字段都标注实际命中的源。 */
export interface EnrichmentIntel {
  doi: string | null;
  citedByCount: number | null;
  citationCount: number | null;
  influentialCitationCount: number | null;
  retracted: boolean;
  retractionSources: EnrichSource[];
  retractionLabel: string | null;
  retractionDoi: string | null;
  journalAbbreviation: string | null;
  journalAbbreviationSource: EnrichSource | null;
  openAccess: { source: OaCascadeSource; url: string; license: string | null; status: string | null } | null;
  pmcId: string | null;
}

/** 期刊缩写优先级：Crossref `short-container-title` > OpenAlex > PubMed `source`。 */
const ABBREVIATION_PRIORITY: readonly EnrichSource[] = ['crossref', 'openalex', 'pubmed'];

function pickOpenAccess(list: readonly SourceIntel[]): EnrichmentIntel['openAccess'] {
  for (const step of OA_CASCADE) {
    if (step === 'pmc') {
      const pmcId = list.map((entry) => entry.pmcId).find((value) => value !== null) ?? null;
      if (pmcId !== null) return { source: 'pmc', url: pmcArticleUrl(pmcId), license: null, status: 'pmc' };
      continue;
    }
    const hit = list.find((entry) => entry.source === step && entry.oaUrl !== null);
    if (hit !== undefined && hit.oaUrl !== null) {
      return { source: step, url: hit.oaUrl, license: hit.oaLicense, status: hit.oaStatus };
    }
  }
  return null;
}

export function mergeIntel(list: readonly SourceIntel[]): EnrichmentIntel {
  const find = (source: EnrichSource): SourceIntel | undefined => list.find((entry) => entry.source === source);
  const openalex = find('openalex');
  const s2 = find('semanticscholar');
  const retractedEntries = list.filter((entry) => entry.retracted);
  const abbrevSource = ABBREVIATION_PRIORITY.map((source) => find(source)).find(
    (entry) => entry !== undefined && entry.journalAbbreviation !== null,
  );
  return {
    doi: list.map((entry) => entry.doi).find((value) => value !== null) ?? null,
    citedByCount: openalex?.citedByCount ?? null,
    citationCount: s2?.citationCount ?? null,
    influentialCitationCount: s2?.influentialCitationCount ?? null,
    retracted: retractedEntries.length > 0,
    retractionSources: retractedEntries.map((entry) => entry.source),
    retractionLabel: retractedEntries.map((entry) => entry.retractionLabel).find((value) => value !== null) ?? null,
    retractionDoi: retractedEntries.map((entry) => entry.retractionDoi).find((value) => value !== null) ?? null,
    journalAbbreviation: abbrevSource?.journalAbbreviation ?? null,
    journalAbbreviationSource: abbrevSource?.source ?? null,
    openAccess: pickOpenAccess(list),
    pmcId: list.map((entry) => entry.pmcId).find((value) => value !== null) ?? null,
  };
}

// ── extra 托管块 ────────────────────────────────────────────────────────

/** 托管块正文行（只依赖情报本身，因此可用于幂等比较）。 */
export function enrichmentBlockLines(intel: EnrichmentIntel): string[] {
  const lines: string[] = [];
  if (intel.citedByCount !== null) lines.push(`cited-by: ${intel.citedByCount} · openalex`);
  if (intel.citationCount !== null) lines.push(`citations: ${intel.citationCount} · semanticscholar`);
  if (intel.influentialCitationCount !== null) {
    lines.push(`influential-citations: ${intel.influentialCitationCount} · semanticscholar`);
  }
  if (intel.journalAbbreviation !== null) {
    lines.push(
      `journal-abbreviation: ${intel.journalAbbreviation}${intel.journalAbbreviationSource === null ? '' : ` · ${intel.journalAbbreviationSource}`}`,
    );
  }
  if (intel.openAccess !== null) {
    const license = intel.openAccess.license === null ? '' : ` · ${intel.openAccess.license}`;
    lines.push(`open-access: ${intel.openAccess.status ?? 'yes'} · ${intel.openAccess.url}${license} · ${intel.openAccess.source}`);
  }
  if (intel.retracted) {
    const notice = intel.retractionDoi === null ? '' : ` · notice ${intel.retractionDoi}`;
    lines.push(`retracted: yes · ${intel.retractionSources.join(', ')}${notice}`);
  }
  return lines;
}

export function renderEnrichmentBlock(lines: readonly string[], generatedAt: string): string {
  return [ENRICHMENT_BLOCK_START, `zotero-mcp enrichment · ${generatedAt}`, ...lines, ENRICHMENT_BLOCK_END].join('\n');
}

export interface EnrichmentBlockInfo {
  /** 块在原文中的起止下标（含标记）。 */
  start: number;
  end: number;
  block: string;
  /** 块正文行（不含生成日期行）。 */
  lines: string[];
}

/** 提取 `extra` 中的托管块；不存在（或标记不成对）时返回 null。 */
export function extractEnrichmentBlock(extra: string | null | undefined): EnrichmentBlockInfo | null {
  if (extra === null || extra === undefined) return null;
  const start = extra.indexOf(ENRICHMENT_BLOCK_START);
  if (start < 0) return null;
  const endMarker = extra.indexOf(ENRICHMENT_BLOCK_END, start);
  if (endMarker < 0) return null;
  const end = endMarker + ENRICHMENT_BLOCK_END.length;
  const block = extra.slice(start, end);
  const inner = block.slice(ENRICHMENT_BLOCK_START.length, block.length - ENRICHMENT_BLOCK_END.length);
  const lines = inner
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^zotero-mcp enrichment ·/u.test(line));
  return { start, end, block, lines };
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

/**
 * 把情报写进 `extra`：只替换自己的托管块，块外文本逐字保留。
 *
 * 幂等：块正文与本次情报一致时**原样返回**（不产生文本增量，因此也不产生写操作）。
 * 新情报为空（例如只剩降级路径）时同样原样返回，绝不删除用户已有文本。
 */
export function applyEnrichmentBlock(
  extra: string | null | undefined,
  intel: EnrichmentIntel,
  generatedAt: string,
): string {
  const lines = enrichmentBlockLines(intel);
  const current = extra ?? '';
  const existing = extractEnrichmentBlock(current);
  if (existing !== null) {
    if (sameLines(existing.lines, lines)) return current;
    if (lines.length === 0) return current;
    return `${current.slice(0, existing.start)}${renderEnrichmentBlock(lines, generatedAt)}${current.slice(existing.end)}`;
  }
  if (lines.length === 0) return current;
  const block = renderEnrichmentBlock(lines, generatedAt);
  if (current.trim().length === 0) return block;
  return `${current}${current.endsWith('\n') ? '' : '\n'}${block}`;
}

// ── 缓存 ────────────────────────────────────────────────────────────────

interface CacheEntry {
  cachedAt: number;
  payload: unknown;
}

/** 缓存文件路径：`<cacheDir>/enrichment/<source>/<hash>.json`（按源分文件）。 */
export function enrichCachePath(cacheDir: string, source: EnrichSource, target: string): string {
  const hash = createHash('sha1').update(`${source}\u0000${target}`).digest('hex').slice(0, 20);
  return join(cacheDir, ENRICH_CACHE_DIRNAME, source, `${hash}.json`);
}

// ── 注入点（测试与离线固件用） ───────────────────────────────────────────

export interface EnrichIO {
  fetchImpl: typeof fetch;
  /** 单调时钟（毫秒）：限速与缓存 TTL 共用，便于测试注入虚拟时钟。 */
  now(): number;
  sleep(ms: number): Promise<void>;
  readCache(path: string): Promise<string | null>;
  writeCache(path: string, text: string): Promise<void>;
}

export type EnrichIOOverrides = Partial<EnrichIO>;

function defaultIo(): EnrichIO {
  return {
    fetchImpl: fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async readCache(path) {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
    async writeCache(path, text) {
      try {
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, text, 'utf8');
      } catch {
        // 缓存写失败不影响补全本身（只是下一次会重新外呼）
      }
    },
  };
}

// ── 外呼 ────────────────────────────────────────────────────────────────

export interface EnrichmentCall {
  source: EnrichSource;
  host: string;
  /** 完整请求 URL；Crossref / OpenAlex 带 `mailto=`，Unpaywall / PubMed 带 `email=`。 */
  url: string;
  /** 本次请求携带的 `mailto` 标识（S2 / arXiv 在 User-Agent 里）。 */
  mailto: string;
  at: number;
}

export type SourceAttemptStatus = 'hit' | 'miss' | 'failed';

export interface SourceAttempt {
  source: EnrichSource;
  status: SourceAttemptStatus;
  /** `hit` 为 null；否则写明未命中或失败原因。 */
  reason: string | null;
  /** 是否来自缓存（命中缓存时不得再外呼）。 */
  cached: boolean;
}

interface SourceOutcome {
  status: SourceAttemptStatus;
  reason: string | null;
  intel: SourceIntel | null;
}

function outcome(status: SourceAttemptStatus, reason: string | null, intel: SourceIntel | null): SourceOutcome {
  return { status, reason, intel };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function httpError(status: number, message: string): Error {
  const error = new Error(message);
  (error as Error & { status?: number }).status = status;
  return error;
}

function statusOf(error: unknown): number | null {
  const value = (error as { status?: unknown } | null)?.status;
  return typeof value === 'number' ? value : null;
}

interface EnrichContext {
  io: EnrichIO;
  mailto: string;
  timeoutMs: number;
  minIntervalMs: number;
  s2MinIntervalMs: number;
  cacheDir: string;
  cacheTtlMs: number;
  calls: EnrichmentCall[];
  /** 每个主机的上次外呼时刻（限速用）。 */
  lastCallAt: Map<string, number>;
  s2Key: string | null;
}

/** 按主机限速：同一主机相邻两次外呼的间隔不低于配置值。 */
async function rateLimit(ctx: EnrichContext, source: EnrichSource): Promise<void> {
  const host = SOURCE_HOSTS[source];
  const minInterval = source === 'semanticscholar' ? ctx.s2MinIntervalMs : ctx.minIntervalMs;
  const previous = ctx.lastCallAt.get(host);
  if (previous !== undefined) {
    const elapsed = ctx.io.now() - previous;
    if (elapsed < minInterval) await ctx.io.sleep(minInterval - elapsed);
  }
  ctx.lastCallAt.set(host, ctx.io.now());
}

interface RawResponse {
  status: number;
  ok: boolean;
  json: unknown;
  text: string;
}

/** 一次外呼：限速 → 记日志 → 超时 fetch；非 2xx 抛带 status 的错误。 */
async function requestSource(
  ctx: EnrichContext,
  source: EnrichSource,
  url: string,
  options: { accept: string; apiKeyHeader?: string | null; jsonBody?: unknown; method?: string } = { accept: 'application/json' },
): Promise<RawResponse> {
  await rateLimit(ctx, source);
  ctx.calls.push({ source, host: SOURCE_HOSTS[source], url, mailto: ctx.mailto, at: ctx.io.now() });
  const headers: Record<string, string> = {
    accept: options.accept,
    // 所有请求都带含 mailto 的 User-Agent；S2 / arXiv 没有可用的 query 参数，靠它承载标识
    'user-agent': enrichUserAgent(ctx.mailto),
  };
  if (options.apiKeyHeader !== null && options.apiKeyHeader !== undefined) {
    // 令牌只进请求头：不写 URL、不写结果、不写计划、不写快照与审计
    headers['x-api-key'] = options.apiKeyHeader;
  }
  if (options.jsonBody !== undefined) headers['content-type'] = 'application/json';
  let response: Response;
  try {
    response = await ctx.io.fetchImpl(url, {
      method: options.method ?? 'GET',
      headers,
      ...(options.jsonBody === undefined ? {} : { body: JSON.stringify(options.jsonBody) }),
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
  } catch (error) {
    throw httpError(0, `外呼失败：${errorMessage(error)}`);
  }
  const text = await response.text();
  let json: unknown = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (!response.ok) throw httpError(response.status, `HTTP ${response.status}`);
  return { status: response.status, ok: true, json, text };
}

// ── 条目补全 ────────────────────────────────────────────────────────────

export interface EnrichExisting {
  extra: string | null;
  journalAbbreviation: string | null;
  tags: string[];
}

export interface EnrichmentWriteSet {
  /** 只含确实发生变化的字段（无变化时为空）。 */
  fields: Record<string, unknown>;
  /** 合并后的目标标签数组（原有标签只增不减）。 */
  tags: string[];
  /** 被跳过的字段与原因（例如 `journalAbbreviation` 原值非空）。 */
  skipped: { field: string; reason: string }[];
  changed: boolean;
}

export interface EnrichDoiFallback {
  attempted: boolean;
  accepted: boolean;
  similarity: number | null;
  reason: string | null;
}

export interface EnrichmentItemResult {
  key: string;
  title: string | null;
  status: 'enriched' | 'partial' | 'needs-enrichment';
  mode: EnrichMode;
  doi: string | null;
  /** DOI 来源：条目字段或 OpenAlex 标题回退；未解析出 DOI 时为 null。 */
  doiSource: 'field' | 'title-fallback' | null;
  doiSimilarity: number | null;
  doiFallback: EnrichDoiFallback;
  enabledSources: EnrichSource[];
  attempts: SourceAttempt[];
  intel: EnrichmentIntel;
  existing: EnrichExisting;
  /** 将写入的字段（`extra` / `journalAbbreviation`）。 */
  fields: Record<string, unknown>;
  /** 将写入的标签（合并后）。 */
  tags: string[];
  skipped: { field: string; reason: string }[];
  calls: EnrichmentCall[];
}

export interface EnrichOptions extends ChannelOptions {
  keys: string[];
  sources?: readonly EnrichSource[];
  mode?: EnrichMode;
  cacheDir?: string;
  cacheTtlMs?: number;
  minIntervalMs?: number;
  s2MinIntervalMs?: number;
  timeoutMs?: number;
  mailto?: string;
  /** 覆盖外呼、时钟、缓存（测试与离线固件用）。 */
  io?: EnrichIOOverrides;
}

export interface EnrichmentReport {
  mode: EnrichMode;
  sources: EnrichSource[];
  generatedAt: string;
  items: EnrichmentItemResult[];
  calls: EnrichmentCall[];
}

function channelOf(options: ChannelOptions): ChannelOptions {
  return {
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs,
  };
}

function tagsOf(envelope: ItemEnvelope): string[] {
  const tags = envelope.data['tags'];
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => (typeof tag === 'string' ? tag : (tag as { tag?: unknown } | null)?.tag))
    .filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
}

function isUsableTitle(title: string | null): boolean {
  if (title === null) return false;
  const cleaned = title.trim();
  return cleaned.length >= 6 && /\s/u.test(cleaned);
}

/** 在 OpenAlex 检索结果里挑与查询标题最相似的候选，相似度不低于阈值才采纳。 */
export function pickDoiByTitle(
  title: string,
  works: readonly unknown[],
  threshold = DOI_TITLE_THRESHOLD,
): { doi: string; score: number; title: string | null } | null {
  const target = normalizeTitle(title);
  if (target.length === 0) return null;
  let best: { doi: string; score: number; title: string | null } | null = null;
  for (const entry of works) {
    const record = asRecord(entry);
    if (record === null) continue;
    const candidateTitle = asString(record['display_name']);
    const doi = stripDoi(asString(record['doi']));
    if (candidateTitle === null || doi === null) continue;
    const score = jaroWinkler(target, normalizeTitle(candidateTitle));
    if (best === null || score > best.score) best = { doi, score, title: candidateTitle };
  }
  return best !== null && best.score >= threshold ? best : null;
}

/**
 * 单源的一次外呼：`target` 是缓存键的「目标」部分，`run` 返回可序列化的原始载荷。
 * 解析统一走 `replayOutcome`，因此「缓存重放」与「实时解析」永远走同一段代码。
 */
interface SourcePayload {
  /** 缓存目标（源 + 目标）。 */
  target: string;
  run: () => Promise<unknown>;
}

function missFor(source: EnrichSource, reason: string): SourceOutcome {
  return outcome('miss', reason, null);
}

function failedFor(reason: string): SourceOutcome {
  return outcome('failed', reason, null);
}

/** 把 HTTP 错误映射成 miss（404 未收录）或 failed（限流 / 超时 / 服务端错误）。 */
function outcomeFromError(source: EnrichSource, error: unknown): SourceOutcome {
  const status = statusOf(error);
  if (status === 404) return missFor(source, '未收录（HTTP 404）');
  return failedFor(errorMessage(error));
}

const SOURCE_DEADLINE = { accept: 'application/json' };

/** 各源的具体外呼与解析；DOI 缺失时一律记为 miss（不臆造 DOI）。 */
function sourcePayload(ctx: EnrichContext, source: EnrichSource, doi: string | null): SourcePayload | null {
  if (doi === null) return null;
  const mailto = ctx.mailto;
  const target = `doi:${doi}`;
  switch (source) {
    case 'openalex':
      return {
        target,
        run: async () =>
          (
            await requestSource(
              ctx,
              source,
              `https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?mailto=${encodeURIComponent(mailto)}`,
              SOURCE_DEADLINE,
            )
          ).json,
      };
    case 'semanticscholar':
      return {
        target,
        run: async () =>
          (
            await requestSource(
              ctx,
              source,
              `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=${S2_FIELDS}`,
              { ...SOURCE_DEADLINE, apiKeyHeader: ctx.s2Key },
            )
          ).json,
      };
    case 'crossref':
      return {
        target,
        run: async () =>
          (
            await requestSource(
              ctx,
              source,
              `https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(mailto)}`,
              SOURCE_DEADLINE,
            )
          ).json,
      };
    case 'unpaywall':
      return {
        target,
        run: async () =>
          (
            await requestSource(
              ctx,
              source,
              `https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${encodeURIComponent(mailto)}`,
              SOURCE_DEADLINE,
            )
          ).json,
      };
    case 'pubmed':
      return {
        target,
        run: async () => {
          const search = await requestSource(
            ctx,
            source,
            `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(`${doi}[DOI]`)}&retmode=json&tool=zotero-mcp&email=${encodeURIComponent(mailto)}`,
            SOURCE_DEADLINE,
          );
          const pmid =
            asArray(asRecord(asRecord(search.json)?.['esearchresult'])?.['idlist'])
              .map((entry) => asString(entry))
              .filter((entry): entry is string => entry !== null)[0] ?? null;
          if (pmid === null) return { pmid: null, summary: null };
          const summary = await requestSource(
            ctx,
            source,
            `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json&tool=zotero-mcp&email=${encodeURIComponent(mailto)}`,
            SOURCE_DEADLINE,
          );
          return { pmid, summary: asRecord(asRecord(summary.json)?.['result'])?.[pmid] ?? null };
        },
      };
    case 'arxiv':
      return {
        target,
        run: async () =>
          (
            await requestSource(
              ctx,
              source,
              `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`doi:"${doi}"`)}&max_results=1`,
              { accept: 'application/atom+xml' },
            )
          ).text,
      };
    default: {
      const exhaustive: never = source;
      throw new Error(`未知来源：${String(exhaustive)}`);
    }
  }
}

/** 带缓存的外呼：命中缓存时直接返回缓存载荷，不再外呼。 */
async function cachedPayload(
  ctx: EnrichContext,
  source: EnrichSource,
  target: string,
  run: () => Promise<unknown>,
): Promise<{ payload: unknown; cached: boolean; error: unknown }> {
  const path = enrichCachePath(ctx.cacheDir, source, target);
  const cachedText = await ctx.io.readCache(path);
  if (cachedText !== null) {
    try {
      const entry = JSON.parse(cachedText) as CacheEntry;
      if (typeof entry.cachedAt === 'number' && ctx.io.now() - entry.cachedAt <= ctx.cacheTtlMs) {
        return { payload: entry.payload, cached: true, error: null };
      }
    } catch {
      // 缓存损坏当作未命中
    }
  }
  try {
    const payload = await run();
    await ctx.io.writeCache(path, JSON.stringify({ cachedAt: ctx.io.now(), payload } satisfies CacheEntry));
    return { payload, cached: false, error: null };
  } catch (error) {
    return { payload: null, cached: false, error };
  }
}

/**
 * 执行单源（带缓存）：命中缓存时不再外呼，情报与首次保持一致。
 * 单源失败 / 超时 / 限流只影响本源，其他源继续。
 */
async function runSourceWithCache(
  ctx: EnrichContext,
  source: EnrichSource,
  payload: SourcePayload,
  expectDoi: string | null,
): Promise<SourceAttempt & { intel: SourceIntel | null }> {
  const attempt = await cachedPayload(ctx, source, payload.target, payload.run);
  if (attempt.error !== null) {
    const failed = outcomeFromError(source, attempt.error);
    return { source, status: failed.status, reason: failed.reason, cached: false, intel: null };
  }
  const parsed = replayOutcome(source, attempt.payload, expectDoi);
  return { source, status: parsed.status, reason: parsed.reason, cached: attempt.cached, intel: parsed.intel };
}

/** 解析原始载荷（实时响应与缓存重放共用同一段代码，避免两套语义漂移）。 */
function replayOutcome(source: EnrichSource, cached: unknown, expectDoi: string | null = null): SourceOutcome {
  switch (source) {
    case 'openalex': {
      const record = asRecord(cached);
      if (record === null || asString(record['id']) === null) return missFor(source, `OpenAlex 未收录该 DOI`);
      return outcome('hit', null, mapOpenAlexWork(record));
    }
    case 'semanticscholar': {
      const record = asRecord(cached);
      if (record === null || asString(record['paperId']) === null) {
        return missFor(source, `Semantic Scholar 未收录该 DOI`);
      }
      return outcome('hit', null, mapSemanticScholarPaper(record));
    }
    case 'crossref': {
      const record = asRecord(asRecord(cached)?.['message']);
      if (record === null) return missFor(source, `Crossref 未收录该 DOI`);
      return outcome('hit', null, mapCrossrefEnrichment(record));
    }
    case 'unpaywall': {
      if (asRecord(cached) === null) return missFor(source, `Unpaywall 未返回记录`);
      return outcome('hit', null, mapUnpaywallRecord(cached));
    }
    case 'pubmed': {
      const record = asRecord(cached);
      const summary = record === null ? null : record['summary'];
      if (asRecord(summary) === null) return missFor(source, `PubMed 未收录该 DOI`);
      return outcome('hit', null, mapPubmedEsummary(summary));
    }
    case 'arxiv': {
      const feed = parseArxivFeed(typeof cached === 'string' ? cached : '');
      const entry = feed.entries.find((item) => expectDoi === null || sameDoi(stripDoi(item.doi), expectDoi)) ?? null;
      if (entry === null) return missFor(source, `arXiv 未收录该 DOI`);
      return outcome('hit', null, mapArxivEntry(entry));
    }
    default: {
      const exhaustive: never = source;
      throw new Error(`未知来源：${String(exhaustive)}`);
    }
  }
}

/**
 * 计算「将写入的字段与标签」。
 *
 * - `needs-enrichment`：只写同名标签，不写任何字段（降级不臆造数据）；
 * - 其余：`extra` 托管块（替换而不是追加；情报无变化则不产生字段）、
 *   `journalAbbreviation` 只在原值为空时写、标签与既有标签合并且只增不减。
 */
export function enrichmentWriteSet(
  existing: EnrichExisting,
  status: EnrichmentItemResult['status'],
  intel: EnrichmentIntel,
  generatedAt: string,
): EnrichmentWriteSet {
  const skipped: { field: string; reason: string }[] = [];
  const tags = [...existing.tags];
  if (status === 'needs-enrichment') {
    if (!tags.includes(NEEDS_ENRICHMENT_TAG)) tags.push(NEEDS_ENRICHMENT_TAG);
    return { fields: {}, tags, skipped, changed: tags.length !== existing.tags.length };
  }
  const fields: Record<string, unknown> = {};
  const beforeExtra = existing.extra ?? '';
  const afterExtra = applyEnrichmentBlock(beforeExtra, intel, generatedAt);
  if (afterExtra.length > 0 && afterExtra !== beforeExtra) fields['extra'] = afterExtra;
  const beforeAbbreviation = existing.journalAbbreviation?.trim() ?? '';
  if (intel.journalAbbreviation !== null && intel.journalAbbreviation.length > 0) {
    if (beforeAbbreviation.length === 0) {
      fields['journalAbbreviation'] = intel.journalAbbreviation;
    } else if (beforeAbbreviation !== intel.journalAbbreviation) {
      skipped.push({ field: 'journalAbbreviation', reason: `原值非空（${beforeAbbreviation}），按不覆盖原则跳过` });
    }
  }
  if (intel.retracted && !tags.includes(RETRACTED_TAG)) tags.push(RETRACTED_TAG);
  if (intel.openAccess !== null && !tags.includes(OPEN_ACCESS_TAG)) tags.push(OPEN_ACCESS_TAG);
  return { fields, tags, skipped, changed: Object.keys(fields).length > 0 || tags.length !== existing.tags.length };
}

function buildContext(options: EnrichOptions): EnrichContext {
  // `fetchImpl` 走通道惯例（测试指向假服务器 / 固件），`io` 可进一步覆盖外呼、时钟与缓存
  const io: EnrichIO = {
    ...defaultIo(),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.io ?? {}),
  };
  return {
    io,
    mailto: resolveEnrichMailto(options.mailto),
    timeoutMs: resolveEnrichTimeoutMs(options.timeoutMs),
    minIntervalMs: resolveEnrichMinIntervalMs(options.minIntervalMs),
    s2MinIntervalMs: resolveEnrichS2MinIntervalMs(options.s2MinIntervalMs),
    cacheDir: resolveCacheDir(options.cacheDir),
    cacheTtlMs: resolveEnrichCacheTtlMs(options.cacheTtlMs),
    calls: [],
    lastCallAt: new Map(),
    s2Key: s2ApiKey(),
  };
}

function generatedOn(ctx: EnrichContext): string {
  return new Date(ctx.io.now()).toISOString().slice(0, 10);
}

function readableSources(sources: readonly EnrichSource[]): string {
  return sources.length === 0 ? '无' : sources.join(' / ');
}

/** 逐条补全：DOI 解析 → 逐源外呼（带缓存与限速）→ 合并情报 → 计算将写入的字段与标签。 */
export async function enrichItems(options: EnrichOptions): Promise<EnrichmentReport> {
  const keys = [...new Set(options.keys.map((key) => key.trim()).filter((key) => key.length > 0))];
  if (keys.length === 0) throw new Error('keys 不能为空（补全按显式 key 白名单工作，禁止全库扫描）');
  const mode: EnrichMode = options.mode ?? 'metadata';
  if (!ENRICH_MODES.includes(mode)) throw new Error(`未知 mode：${String(mode)}（可选 ${ENRICH_MODES.join(' / ')}）`);
  const requested = options.sources === undefined || options.sources.length === 0 ? [...ENRICH_SOURCES] : [...new Set(options.sources)];
  for (const source of requested) {
    if (!ENRICH_SOURCES.includes(source)) throw new Error(`未知来源：${String(source)}（可选 ${ENRICH_SOURCES.join(' / ')}）`);
  }
  const enabled = mode === 'retractions' ? requested.filter((source) => RETRACTION_SOURCES.includes(source)) : requested;
  if (enabled.length === 0) {
    throw new Error(`mode=retractions 只使用撤稿信号源（${readableSources(RETRACTION_SOURCES)}），当前 sources 不含其中任何一个`);
  }
  const ctx = buildContext(options);
  const generatedAt = generatedOn(ctx);
  const items: EnrichmentItemResult[] = [];
  for (const key of keys) {
    const envelope = await readItemEnvelope(channelOf(options), key);
    if (envelope === null) throw new Error(`条目不存在或不可读写：${key}`);
    items.push(await enrichOne(ctx, options, key, envelope, enabled, mode, generatedAt));
  }
  return { mode, sources: enabled, generatedAt, items, calls: ctx.calls };
}

async function enrichOne(
  ctx: EnrichContext,
  options: EnrichOptions,
  key: string,
  envelope: ItemEnvelope,
  enabled: readonly EnrichSource[],
  mode: EnrichMode,
  generatedAt: string,
): Promise<EnrichmentItemResult> {
  const title = asString(envelope.data['title']);
  const callStart = ctx.calls.length;
  let doi = stripDoi(asString(envelope.data['DOI']));
  let doiSource: EnrichmentItemResult['doiSource'] = doi === null ? null : 'field';
  let doiSimilarity: number | null = null;
  const fallback: EnrichDoiFallback = { attempted: false, accepted: false, similarity: null, reason: null };

  // DOI 回退：条目字段为空时用标题在 OpenAlex 检索，Jaro-Winkler ≥ 0.8 才采纳
  if (doi === null && enabled.includes('openalex')) {
    fallback.attempted = true;
    if (!isUsableTitle(title)) {
      fallback.reason = '标题缺失或不可用于检索，跳过标题回退';
    } else {
      const query = title ?? '';
      const searchUrl = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=5&mailto=${encodeURIComponent(ctx.mailto)}`;
      const attempt = await cachedPayload(ctx, 'openalex', `title:${normalizeTitle(query)}`, async () =>
        (await requestSource(ctx, 'openalex', searchUrl, SOURCE_DEADLINE)).json,
      );
      if (attempt.error !== null) {
        fallback.reason = `标题回退检索失败：${errorMessage(attempt.error)}`;
      } else {
        const best = pickDoiByTitle(query, asArray(asRecord(attempt.payload)?.['results']));
        if (best === null) {
          fallback.reason = `标题回退未采纳：最佳候选相似度低于 ${DOI_TITLE_THRESHOLD}`;
        } else {
          doi = best.doi;
          doiSource = 'title-fallback';
          doiSimilarity = best.score;
          fallback.accepted = true;
          fallback.similarity = best.score;
        }
      }
    }
  } else if (doi === null) {
    fallback.reason = 'openalex 未启用，无法按标题回退解析 DOI';
  }

  const attempts: SourceAttempt[] = [];
  const intelList: SourceIntel[] = [];
  for (const source of enabled) {
    const payload = sourcePayload(ctx, source, doi);
    if (payload === null) {
      attempts.push({ source, status: 'miss', reason: '没有可用的 DOI（标题回退未解析出候选）', cached: false });
      continue;
    }
    const result = await runSourceWithCache(ctx, source, payload, doi);
    attempts.push({ source, status: result.status, reason: result.reason, cached: result.cached });
    if (result.intel !== null) intelList.push(result.intel);
  }
  const intel = mergeIntel(intelList);
  const hitCount = attempts.filter((attempt) => attempt.status === 'hit').length;
  const status: EnrichmentItemResult['status'] =
    hitCount === 0 ? 'needs-enrichment' : hitCount === attempts.length ? 'enriched' : 'partial';

  const existing: EnrichExisting = {
    extra: asString(envelope.data['extra']),
    journalAbbreviation: asString(envelope.data['journalAbbreviation']),
    tags: tagsOf(envelope),
  };
  const writeSet = enrichmentWriteSet(existing, status, intel, generatedAt);
  return {
    key,
    title,
    status,
    mode,
    doi,
    doiSource,
    doiSimilarity,
    doiFallback: fallback,
    enabledSources: [...enabled],
    attempts,
    intel,
    existing,
    fields: writeSet.fields,
    tags: writeSet.tags,
    skipped: writeSet.skipped,
    calls: ctx.calls.slice(callStart),
  };
}

// ── 计划编译 ────────────────────────────────────────────────────────────

export interface BuildEnrichmentPlanOptions {
  now?: () => Date;
}

/**
 * 把补全结果编译成 `ChangePlan`。
 *
 * 写入只走写安全管线；计划本身**不覆盖任何既有非空值**（`extra` 只替换自己的托管块、
 * `journalAbbreviation` 只补空、标签只增不减），因此 `destructive=false`、不需要 `OVERWRITE`。
 * 无变化的条目不产生操作（幂等：无变化 = 零操作）。
 */
export function buildEnrichmentPlan(
  results: readonly EnrichmentItemResult[],
  options: BuildEnrichmentPlanOptions = {},
): ChangePlan {
  const operations: PlanOperation[] = [];
  const changes: FieldChange[] = [];
  for (const result of results) {
    const fields: Record<string, unknown> = { ...result.fields };
    for (const [field, after] of Object.entries(result.fields)) {
      const before = field === 'extra' ? result.existing.extra : result.existing.journalAbbreviation;
      changes.push({ key: result.key, field, before, after });
    }
    if (result.tags.length !== result.existing.tags.length || result.tags.some((tag, index) => tag !== result.existing.tags[index])) {
      fields['tags'] = result.tags.map((tag) => ({ tag }));
      changes.push({ key: result.key, field: 'tags', before: result.existing.tags, after: result.tags });
    }
    if (Object.keys(fields).length === 0) continue;
    operations.push({ kind: 'patch', key: result.key, fields });
  }
  const degraded = results.filter((result) => result.status === 'needs-enrichment').length;
  const details = [`${operations.length} 条将写入`];
  if (degraded > 0) details.push(`${degraded} 条降级为 ${NEEDS_ENRICHMENT_TAG}`);
  const parts = [`补全 ${results.length} 条条目的学术情报（${details.join('，')}）`];
  return makeChangePlan({
    targetKeys: results.map((result) => result.key),
    changes,
    operations,
    summary: parts.join('，'),
    destructive: false,
    confirmKeyword: null,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}
