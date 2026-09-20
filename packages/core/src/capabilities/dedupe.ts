/**
 * 重复候选聚类（M3 change 6，只读）。
 *
 * 两段式 G1 的第一段：把条目集合归一化成「候选簇 + 主记录建议」。
 * - 强键：DOI / ISBN / PMID 归一化后精确匹配；
 * - 弱键：同 `itemType` + 年份差不超过容差 + 首作者姓 Jaro-Winkler ≥ 阈值 + 标题归一化后
 *   Jaro-Winkler ≥ 阈值，四项同时成立才成簇（宁可漏报，不可误报）。
 *
 * 本模块是**纯读**：只做计算，不发任何请求；也没有任何写入路径。
 */

import type { ItemEnvelope } from './read.ts';

/** 弱键默认阈值（标题与首作者姓共用）。 */
export const DEFAULT_TITLE_THRESHOLD = 0.9;
/** 弱键默认年份容差。 */
export const DEFAULT_YEAR_TOLERANCE = 1;
/** 首作者姓的默认阈值（与路线图 G1 一致）。 */
export const DEFAULT_AUTHOR_THRESHOLD = 0.9;

export type StrongKeyType = 'doi' | 'isbn' | 'pmid';
export type ClusterMatchType = StrongKeyType | 'weak';

export interface DedupeCandidate {
  key: string;
  title: string | null;
  year: string | null;
  creators: string[];
  itemType: string | null;
  attachmentCount: number;
  /** 该条目下 PDF 附件的注释总数（建议主记录排序依据之一）。 */
  annotationCount: number;
  collectionCount: number;
  /** 字段完整度：标题 / DOI / 年份 / 作者 齐备数（0–4）。 */
  completeness: number;
}

export interface DedupeCluster {
  matchType: ClusterMatchType;
  matchKey: string;
  items: DedupeCandidate[];
  /** 建议主记录：附件最多、其次注释最多、再次集合最多、再按字段完整度，最后 key 升序。 */
  suggestedPrimary: string;
  /** 命中理由（强键取值或弱键各项依据）。 */
  reasons: string[];
  confidence: 'strong' | 'weak';
}

export interface DedupeOptions {
  /** 标题 / 作者姓的 Jaro-Winkler 阈值（0.5–1.0）。 */
  threshold?: number;
  /** 首作者姓阈值，默认与 threshold 解耦（路线图固定 0.9）。 */
  authorThreshold?: number;
  /** 年份容差（0–3）。 */
  yearTolerance?: number;
  /** 是否启用弱键聚类，默认 true。 */
  includeWeakKeys?: boolean;
  /** 可选：附件数（调用方读取；纯函数不自行请求）。 */
  attachmentCounts?: Map<string, number>;
  /** 可选：注释数。 */
  annotationCounts?: Map<string, number>;
}

function checkOptions(options: DedupeOptions): {
  threshold: number;
  authorThreshold: number;
  yearTolerance: number;
  includeWeakKeys: boolean;
} {
  const threshold = options.threshold ?? DEFAULT_TITLE_THRESHOLD;
  const authorThreshold = options.authorThreshold ?? DEFAULT_AUTHOR_THRESHOLD;
  const yearTolerance = options.yearTolerance ?? DEFAULT_YEAR_TOLERANCE;
  if (!Number.isFinite(threshold) || threshold < 0.5 || threshold > 1) {
    throw new Error(`threshold 必须在 0.5 与 1.0 之间，收到：${String(options.threshold)}`);
  }
  if (!Number.isFinite(authorThreshold) || authorThreshold < 0.5 || authorThreshold > 1) {
    throw new Error(`authorThreshold 必须在 0.5 与 1.0 之间，收到：${String(options.authorThreshold)}`);
  }
  if (!Number.isInteger(yearTolerance) || yearTolerance < 0 || yearTolerance > 3) {
    throw new Error(`yearTolerance 必须是 0 到 3 的整数，收到：${String(options.yearTolerance)}`);
  }
  return { threshold, authorThreshold, yearTolerance, includeWeakKeys: options.includeWeakKeys !== false };
}

/** 归一化强键：DOI / ISBN / PMID。 */
export function normalizeStrongKey(type: StrongKeyType, raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (type === 'doi') {
    const stripped = value
      .replace(/^https?:\/\/(dx\.)?doi\.org\//iu, '')
      .replace(/^doi:\s*/iu, '')
      .trim()
      .toLowerCase();
    return stripped.length === 0 ? null : stripped;
  }
  if (type === 'isbn') {
    const digits = value.replace(/[^0-9Xx]/gu, '').toUpperCase();
    return digits.length === 0 ? null : digits;
  }
  const digits = value.replace(/[^0-9]/gu, '');
  return digits.length === 0 ? null : digits;
}

/** 条目的第一个可用强键。 */
export function firstStrongKey(data: Record<string, unknown>): { type: StrongKeyType; key: string } | null {
  const doi = data['DOI'];
  if (typeof doi === 'string') {
    const normalized = normalizeStrongKey('doi', doi);
    if (normalized !== null) return { type: 'doi', key: normalized };
  }
  const isbn = data['ISBN'];
  if (typeof isbn === 'string') {
    const normalized = normalizeStrongKey('isbn', isbn);
    if (normalized !== null) return { type: 'isbn', key: normalized };
  }
  const pmid = data['PMID'];
  if (typeof pmid === 'string') {
    const normalized = normalizeStrongKey('pmid', pmid);
    if (normalized !== null) return { type: 'pmid', key: normalized };
  }
  return null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** 归一化标题：去变音符号、小写、去标点、去首部冠词、折叠空白。 */
export function normalizeTitle(value: string): string {
  const stripped = value
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9\u4e00-\u9fff]+/gu, ' ')
    .trim();
  return stripped.replace(/^(the|a|an)\s+/u, '').replaceAll(/\s+/gu, ' ').trim();
}

/** 首作者姓（归一化）；无作者时返回 null。 */
export function firstAuthorSurname(data: Record<string, unknown>): string | null {
  const creators = data['creators'];
  if (!Array.isArray(creators) || creators.length === 0) return null;
  const first = creators[0];
  if (typeof first !== 'object' || first === null) return null;
  const record = first as Record<string, unknown>;
  const lastName = asString(record['lastName']);
  if (lastName !== null && lastName.trim().length > 0) {
    return lastName
      .normalize('NFKD')
      .replaceAll(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replaceAll(/[^a-z0-9\u4e00-\u9fff]+/gu, '')
      .trim();
  }
  const literal = asString(record['name']);
  if (literal === null || literal.trim().length === 0) return null;
  const parts = literal.trim().split(/\s+/u);
  const surname = parts[parts.length - 1] ?? '';
  return surname
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9\u4e00-\u9fff]+/gu, '')
    .trim();
}

/** 从 Zotero 的 date 字段解析年份；解析不出返回 null。 */
export function parseYear(value: unknown): number | null {
  const text = asString(value);
  if (text === null) return null;
  const match = /(\d{4})/u.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) ? year : null;
}

/** Jaro-Winkler 相似度（前缀权重 0.1，最长前缀 4）。 */
export function jaroWinkler(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const matchWindow = Math.max(0, Math.floor(Math.max(left.length, right.length) / 2) - 1);
  const leftMatches = new Array<boolean>(left.length).fill(false);
  const rightMatches = new Array<boolean>(right.length).fill(false);
  let matches = 0;
  for (let index = 0; index < left.length; index += 1) {
    const start = Math.max(0, index - matchWindow);
    const end = Math.min(index + matchWindow + 1, right.length);
    for (let cursor = start; cursor < end; cursor += 1) {
      if (rightMatches[cursor] === true || left[index] !== right[cursor]) continue;
      leftMatches[index] = true;
      rightMatches[cursor] = true;
      matches += 1;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let cursor = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (leftMatches[index] !== true) continue;
    while (rightMatches[cursor] !== true) cursor += 1;
    if (left[index] !== right[cursor]) transpositions += 1;
    cursor += 1;
  }
  const jaro = (matches / left.length + matches / right.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  const maxPrefix = Math.min(4, Math.min(left.length, right.length));
  while (prefix < maxPrefix && left[prefix] === right[prefix]) prefix += 1;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function creatorsOf(data: Record<string, unknown>): string[] {
  const creators = data['creators'];
  if (!Array.isArray(creators)) return [];
  return creators
    .map((creator) => {
      if (typeof creator !== 'object' || creator === null) return '';
      const record = creator as Record<string, unknown>;
      const name = asString(record['name']);
      if (name !== null) return name;
      const last = asString(record['lastName']) ?? '';
      const first = asString(record['firstName']) ?? '';
      return `${last}${last.length > 0 && first.length > 0 ? ', ' : ''}${first}`.trim();
    })
    .filter((entry) => entry.length > 0);
}

/** 把条目信封转成候选（纯计算，不请求）。 */
export function toDedupeCandidate(envelope: ItemEnvelope, options: DedupeOptions = {}): DedupeCandidate {
  const data = envelope.data;
  const title = asString(data['title']);
  const doi = asString(data['DOI']);
  const creators = creatorsOf(data);
  const completeness =
    (title !== null && title.length > 0 ? 1 : 0) +
    (doi !== null && doi.length > 0 ? 1 : 0) +
    (parseYear(data['date']) !== null ? 1 : 0) +
    (creators.length > 0 ? 1 : 0);
  return {
    key: envelope.key,
    title,
    year: (() => {
      const year = parseYear(data['date']);
      return year === null ? null : String(year);
    })(),
    creators,
    itemType: asString(data['itemType']),
    attachmentCount: options.attachmentCounts?.get(envelope.key) ?? 0,
    annotationCount: options.annotationCounts?.get(envelope.key) ?? 0,
    collectionCount: Array.isArray(data['collections']) ? (data['collections'] as unknown[]).length : 0,
    completeness,
  };
}

/** 主记录排序：附件 → 注释 → 集合 → 字段完整度 → key 升序。 */
export function pickPrimary(items: DedupeCandidate[]): string {
  const ranked = [...items].sort((left, right) => {
    if (right.attachmentCount !== left.attachmentCount) return right.attachmentCount - left.attachmentCount;
    if (right.annotationCount !== left.annotationCount) return right.annotationCount - left.annotationCount;
    if (right.collectionCount !== left.collectionCount) return right.collectionCount - left.collectionCount;
    if (right.completeness !== left.completeness) return right.completeness - left.completeness;
    return left.key.localeCompare(right.key);
  });
  return ranked[0]?.key ?? '';
}

export interface WeakMatchResult {
  matched: boolean;
  /** 成立或失败的原因（含降级说明）。 */
  reasons: string[];
  /** 被跳过的条件（缺失字段导致的降级）。 */
  degraded: string[];
}

/** 弱键判定：同 itemType + 年份容差 + 首作者姓阈值 + 标题阈值，四项同时成立。 */
export function weakKeyMatch(
  left: ItemEnvelope,
  right: ItemEnvelope,
  options: DedupeOptions = {},
): WeakMatchResult {
  const { threshold, authorThreshold, yearTolerance } = checkOptions(options);
  const reasons: string[] = [];
  const degraded: string[] = [];

  const leftType = asString(left.data['itemType']);
  const rightType = asString(right.data['itemType']);
  if (leftType === null || rightType === null || leftType !== rightType) {
    return { matched: false, reasons: [`itemType 不同（${leftType ?? '未知'} vs ${rightType ?? '未知'}）`], degraded };
  }
  reasons.push(`itemType=${leftType}`);

  const leftTitle = normalizeTitle(asString(left.data['title']) ?? '');
  const rightTitle = normalizeTitle(asString(right.data['title']) ?? '');
  if (leftTitle.length === 0 || rightTitle.length === 0) {
    return { matched: false, reasons: ['标题缺失或归一化后为空，不参与弱键匹配'], degraded: ['title'] };
  }
  const titleScore = jaroWinkler(leftTitle, rightTitle);
  if (titleScore < threshold) {
    return { matched: false, reasons: [`标题相似度 ${titleScore.toFixed(3)} < ${threshold}`], degraded };
  }
  reasons.push(`标题相似度 ${titleScore.toFixed(3)} ≥ ${threshold}`);

  const leftYear = parseYear(left.data['date']);
  const rightYear = parseYear(right.data['date']);
  if (leftYear === null || rightYear === null) {
    degraded.push('year');
    reasons.push('年份缺失，跳过年份条件');
  } else if (Math.abs(leftYear - rightYear) > yearTolerance) {
    return { matched: false, reasons: [`年份相差 ${Math.abs(leftYear - rightYear)} 年 > 容差 ${yearTolerance}`], degraded };
  } else {
    reasons.push(`年份相差 ${Math.abs(leftYear - rightYear)} ≤ ${yearTolerance}`);
  }

  const leftAuthor = firstAuthorSurname(left.data);
  const rightAuthor = firstAuthorSurname(right.data);
  if (leftAuthor === null || rightAuthor === null || leftAuthor.length === 0 || rightAuthor.length === 0) {
    degraded.push('author');
    reasons.push('首作者缺失，跳过作者条件');
  } else {
    const authorScore = jaroWinkler(leftAuthor, rightAuthor);
    if (authorScore < authorThreshold) {
      return { matched: false, reasons: [`首作者姓相似度 ${authorScore.toFixed(3)} < ${authorThreshold}`], degraded };
    }
    reasons.push(`首作者姓相似度 ${authorScore.toFixed(3)} ≥ ${authorThreshold}`);
  }

  return { matched: true, reasons, degraded };
}

/**
 * 需要两两比较的位置对：同一 `itemType` 且年份落在容差窗口内；
 * 年份缺失的条目与该 `itemType` 的全部条目比较（否则会因分桶而漏报）。
 */
function comparisonPairs(items: ItemEnvelope[], yearTolerance: number): [number, number][] {
  const bucketSize = Math.max(1, yearTolerance + 1);
  const blocks = new Map<string, number[]>();
  const unknownByType = new Map<string, number[]>();
  for (const [position, item] of items.entries()) {
    if (normalizeTitle(asString(item.data['title']) ?? '').length === 0) continue;
    const itemType = asString(item.data['itemType']) ?? 'unknown';
    const year = parseYear(item.data['date']);
    if (year === null) {
      unknownByType.set(itemType, [...(unknownByType.get(itemType) ?? []), position]);
      continue;
    }
    const bucket = Math.floor(year / bucketSize);
    for (let offset = -1; offset <= 1; offset += 1) {
      const key = `${itemType}|${bucket + offset}`;
      blocks.set(key, [...(blocks.get(key) ?? []), position]);
    }
  }
  const pairs: [number, number][] = [];
  const seen = new Set<string>();
  const push = (left: number, right: number): void => {
    if (left === right) return;
    const id = left < right ? `${left}|${right}` : `${right}|${left}`;
    if (seen.has(id)) return;
    seen.add(id);
    pairs.push(left < right ? [left, right] : [right, left]);
  };
  for (const positions of blocks.values()) {
    for (let left = 0; left < positions.length; left += 1) {
      for (let right = left + 1; right < positions.length; right += 1) {
        push(positions[left] as number, positions[right] as number);
      }
    }
  }
  for (const [itemType, unknownPositions] of unknownByType) {
    for (const position of unknownPositions) {
      for (const [key, positions] of blocks) {
        if (!key.startsWith(`${itemType}|`)) continue;
        for (const other of positions) push(position, other);
      }
    }
  }
  return pairs;
}

export interface RejectedPair {
  pair: [string, string];
  reasons: string[];
  degraded: string[];
}

/**
 * 被拒对诊断：列出被比较过但未成簇的弱键对与失败原因
 * （spec「工具面」要求弱键判定失败的原因在结果中可查）。
 */
export function explainRejectedPairs(
  items: ItemEnvelope[],
  options: DedupeOptions = {},
  limit = 20,
): { pairs: RejectedPair[]; comparedPairs: number; truncated: boolean } {
  const { yearTolerance } = checkOptions(options);
  const all = comparisonPairs(items, yearTolerance);
  const rejected: RejectedPair[] = [];
  for (const [left, right] of all) {
    const outcome = weakKeyMatch(items[left] as ItemEnvelope, items[right] as ItemEnvelope, options);
    if (outcome.matched) continue;
    rejected.push({
      pair: [(items[left] as ItemEnvelope).key, (items[right] as ItemEnvelope).key],
      reasons: outcome.reasons,
      degraded: outcome.degraded,
    });
  }
  return { pairs: rejected.slice(0, limit), comparedPairs: all.length, truncated: rejected.length > limit };
}

const STRONG_RANK: Record<ClusterMatchType, number> = { doi: 3, isbn: 2, pmid: 1, weak: 0 };

/**
 * 聚类：强键精确匹配优先，弱键按 itemType + 年份分桶后两两比较（避免全量 O(n²)）。
 * 返回的簇只包含成员数 > 1 的候选组。
 */
export function clusterItems(items: ItemEnvelope[], options: DedupeOptions = {}): DedupeCluster[] {
  const { includeWeakKeys } = checkOptions(options);
  const index = new Map(items.map((item, position) => [item.key, position]));
  const parent = items.map((_, position) => position);
  const find = (position: number): number => {
    let root = position;
    while (parent[root] !== root) root = parent[root] as number;
    let cursor = position;
    while (parent[cursor] !== cursor) {
      const next = parent[cursor] as number;
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  const reasons = new Map<number, Set<string>>();
  const strongTypes = new Map<number, Set<StrongKeyType>>();
  const addReason = (position: number, reason: string): void => {
    const bucket = reasons.get(position) ?? new Set<string>();
    bucket.add(reason);
    reasons.set(position, bucket);
  };
  const addStrongType = (position: number, type: StrongKeyType): void => {
    const bucket = strongTypes.get(position) ?? new Set<StrongKeyType>();
    bucket.add(type);
    strongTypes.set(position, bucket);
  };

  // 1) 强键分组（同时记住每个位置所属的组，簇的 matchKey 必须来自本簇成员）
  const strongGroups = new Map<string, number[]>();
  const strongGroupOf = new Map<number, string>();
  for (const [position, item] of items.entries()) {
    const strong = firstStrongKey(item.data);
    if (strong === null) continue;
    const groupId = `${strong.type}:${strong.key}`;
    strongGroups.set(groupId, [...(strongGroups.get(groupId) ?? []), position]);
    strongGroupOf.set(position, groupId);
  }
  for (const [groupId, positions] of strongGroups) {
    if (positions.length < 2) continue;
    for (const position of positions.slice(1)) union(positions[0] as number, position);
    for (const position of positions) {
      addReason(position, `强键 ${groupId}`);
      addStrongType(position, groupId.split(':')[0] as StrongKeyType);
    }
  }

  // 2) 弱键两两比较（比较对由 comparisonPairs 生成，年份缺失的条目与该 itemType 全量比较）
  if (includeWeakKeys) {
    const { yearTolerance } = checkOptions(options);
    const compared = new Set<string>();
    const compare = (left: number, right: number): void => {
      const pairId = left < right ? `${left}|${right}` : `${right}|${left}`;
      if (compared.has(pairId)) return;
      compared.add(pairId);
      const outcome = weakKeyMatch(items[left] as ItemEnvelope, items[right] as ItemEnvelope, options);
      if (!outcome.matched) return;
      union(left, right);
      addReason(left, `弱键 ${outcome.reasons.join('；')}`);
      addReason(right, `弱键 ${outcome.reasons.join('；')}`);
    };
    for (const [left, right] of comparisonPairs(items, yearTolerance)) compare(left, right);
  }

  // 3) 组装簇
  const groups = new Map<number, number[]>();
  for (let position = 0; position < items.length; position += 1) {
    const root = find(position);
    groups.set(root, [...(groups.get(root) ?? []), position]);
  }

  const clusters: DedupeCluster[] = [];
  for (const positions of groups.values()) {
    if (positions.length < 2) continue;
    const members = positions.map((position) => items[position] as ItemEnvelope);
    const candidates = members.map((envelope) => toDedupeCandidate(envelope, options));
    const types = new Set<StrongKeyType>();
    for (const position of positions) {
      for (const type of strongTypes.get(position) ?? []) types.add(type);
    }
    const sortedTypes = [...types].sort((left, right) => STRONG_RANK[right] - STRONG_RANK[left]);
    const matchType: ClusterMatchType = sortedTypes[0] ?? 'weak';
    const clusterReasons = new Set<string>();
    for (const position of positions) {
      for (const reason of reasons.get(position) ?? []) clusterReasons.add(reason);
    }
    const primary = pickPrimary(candidates);
    // 本簇的 matchKey 必须来自本簇成员：优先建议主记录所属的强键组，其次按成员顺序取第一个同类型组
    const ownStrongGroup = ((): string | null => {
      if (matchType === 'weak') return null;
      const primaryPosition = positions[candidates.findIndex((candidate) => candidate.key === primary)];
      const preferred = primaryPosition === undefined ? undefined : strongGroupOf.get(primaryPosition);
      if (preferred !== undefined && preferred.startsWith(`${matchType}:`)) return preferred;
      for (const position of positions) {
        const groupId = strongGroupOf.get(position);
        if (groupId !== undefined && groupId.startsWith(`${matchType}:`)) return groupId;
      }
      return null;
    })();
    clusters.push({
      matchType,
      matchKey:
        matchType === 'weak'
          ? normalizeTitle(asString(members[0]?.data['title']) ?? '')
          : (ownStrongGroup ?? `${matchType}:unknown`).split(':').slice(1).join(':'),
      items: candidates,
      suggestedPrimary: primary,
      reasons: [...clusterReasons].sort(),
      confidence: matchType === 'weak' ? 'weak' : 'strong',
    });
  }
  clusters.sort((left, right) => (left.items[0]?.key ?? '').localeCompare(right.items[0]?.key ?? ''));
  void index;
  return clusters;
}

export interface DedupeLabels {
  /** 真实重复分组：每组 key 互为重复。 */
  duplicateGroups: string[][];
}

export interface DedupeMetrics {
  sampleSize: number;
  predictedPairs: number;
  labeledDuplicatePairs: number;
  labeledNonDuplicatePairs: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  falsePositiveRate: number;
  falsePositiveExamples: { pair: [string, string]; cluster: string }[];
  falseNegativeExamples: [string, string][];
}

function pairId(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

/**
 * 标注样本评估。
 * 准确率 = 正确聚出的重复对 / 全部聚出的条目对；召回率 = 正确聚出的重复对 / 标注重复对；
 * 误报率 = 被误聚的非重复对 / 全部非重复对。
 */
export function evaluateClustering(
  clusters: DedupeCluster[],
  keys: string[],
  labels: DedupeLabels,
): DedupeMetrics {
  const sample = new Set(keys);
  const predicted = new Map<string, string>();
  for (const cluster of clusters) {
    const members = cluster.items.map((item) => item.key).filter((key) => sample.has(key));
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        predicted.set(pairId(members[left] as string, members[right] as string), cluster.matchType);
      }
    }
  }
  const labeled = new Set<string>();
  for (const group of labels.duplicateGroups) {
    const members = group.filter((key) => sample.has(key));
    for (let left = 0; left < members.length; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        labeled.add(pairId(members[left] as string, members[right] as string));
      }
    }
  }
  const totalPairs = (sample.size * (sample.size - 1)) / 2;
  const truePositives = [...predicted.keys()].filter((id) => labeled.has(id)).length;
  const falsePositiveIds = [...predicted.keys()].filter((id) => !labeled.has(id));
  const falseNegativeIds = [...labeled].filter((id) => !predicted.has(id));
  const labeledNonDuplicatePairs = totalPairs - labeled.size;
  return {
    sampleSize: sample.size,
    predictedPairs: predicted.size,
    labeledDuplicatePairs: labeled.size,
    labeledNonDuplicatePairs,
    truePositives,
    falsePositives: falsePositiveIds.length,
    falseNegatives: falseNegativeIds.length,
    precision: predicted.size === 0 ? 1 : truePositives / predicted.size,
    recall: labeled.size === 0 ? 1 : truePositives / labeled.size,
    falsePositiveRate: labeledNonDuplicatePairs === 0 ? 0 : falsePositiveIds.length / labeledNonDuplicatePairs,
    falsePositiveExamples: falsePositiveIds.map((id) => ({
      pair: id.split('|') as [string, string],
      cluster: predicted.get(id) ?? 'unknown',
    })),
    falseNegativeExamples: falseNegativeIds.map((id) => id.split('|') as [string, string]),
  };
}
