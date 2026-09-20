/**
 * 重复项合并与客户端识别（M4 change 13）。
 *
 * MCP 侧不自己迁移字段：合并交给薄插件的 `/zoteromcp/merge`（它调用 Zotero 自己的
 * `mergeItems.mjs`），识别交给 `/zoteromcp/recognize-pdf`（Zotero 自己的识别器）。
 * 这里负责四件事：
 *   1. **计划**：读全部参与条目的完整 JSON，给出影响面与快照路径（默认 dry-run，零写请求）；
 *   2. **门禁**：`ZOTERO_MCP_WRITE=on` + `confirm="MERGE"`（合并）/ `confirm="OVERWRITE"`（识别）；
 *   3. **快照先于写入**：把参与条目的完整 JSON 落到 `ZOTERO_MCP_AUDIT_DIR/snapshots/`；
 *   4. **写后核对**：回读主记录、确认被合并条目进了垃圾箱，并把结论写进审计 JSONL。
 *
 * 插件不可用时降级为「候选清单 + 人工合并指引」，绝不假装成功；合并只把被合并条目移入
 * 垃圾箱（可用 Zotero 的撤销或从垃圾箱恢复），本模块不包含任何永久删除路径。
 */

import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveAuditDir, resolveBaseUrl } from '../paths.ts';
import { LIBRARY_PREFIX, getItems } from './read.ts';
import { requestLocalApi, probeLocalApi } from '../channels/local-api.ts';
import { assertWriteEnabled } from './write-pipeline.ts';
import { PLUGIN_TOKEN_HEADER, pluginTokenPath, readPluginToken } from './client-channel.ts';
import type { ChannelOptions, ItemDetail } from './read.ts';
import type { PluginUnavailableReason } from './client-channel.ts';

export const MERGE_CONFIRM_KEYWORD = 'MERGE';
export const RECOGNIZE_CONFIRM_KEYWORD = 'OVERWRITE';

/**
 * 计划阶段要读全的子项面。
 *
 * 只写 `children` 是不够的：读层的 `notes` / `attachments` / `annotations` 都要显式请求才会
 * 落进 `ItemDetail`，否则快照里的子项计数与影响面会一律为 0（看起来「没有东西要迁移」），
 * 而 `targets.isPdf` 也会恒为假。影响面是这份计划的**主要产出**，必须真实。
 */
const PLAN_INCLUDE = ['children', 'attachments', 'annotations', 'notes', 'collections', 'tags'] as const;

/** 合并/识别端点路径（与插件侧逐字一致）。 */
export const MERGE_ENDPOINT = '/zoteromcp/merge';
export const RECOGNIZE_ENDPOINT = '/zoteromcp/recognize-pdf';

export interface MergeOptions extends ChannelOptions {
  primaryKey: string;
  mergeKeys: string[];
  auditDir?: string;
  token?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface MergeItemSnapshot {
  key: string;
  itemType: string | null;
  data: Record<string, unknown>;
  childCounts: { attachments: number; notes: number; annotations: number };
}

export interface MergePlan {
  planId: string;
  primaryKey: string;
  mergeKeys: string[];
  /** 插件是否可用；false 时只输出候选与人工指引。 */
  pluginAvailable: boolean;
  reason: PluginUnavailableReason | null;
  hint: string | null;
  guide: string | null;
  snapshot: MergeItemSnapshot[];
  /** 快照将落在这里（dry-run 时尚未写入）。 */
  snapshotPath: string;
  impacts: {
    totalItems: number;
    attachments: number;
    notes: number;
    annotations: number;
    collections: string[];
    tags: string[];
  };
  summary: string;
}

function planId(now: () => Date, size: number): string {
  const stamp = now().toISOString().replace(/[^0-9]/gu, '').slice(0, 14);
  return `merge-${stamp}-${size}-${Math.random().toString(16).slice(2, 6)}`;
}

function channelOf(options: ChannelOptions): ChannelOptions {
  return {
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs,
  };
}

function toSnapshot(item: ItemDetail): MergeItemSnapshot {
  return {
    key: item.key,
    itemType: item.itemType,
    data: item.data,
    childCounts: {
      attachments: item.attachments.length,
      notes: item.notes.length,
      annotations: item.annotations.length,
    },
  };
}

/** 插件可用性探测只关心通道参数（token / 地址 / 超时），与具体条目无关。 */
interface PluginAvailabilityOptions extends ChannelOptions {
  token?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** 校验并归一化合并参数：主记录不得出现在待合并列表里，列表不得为空或重复。 */
export function normalizeMergeKeys(primaryKey: string, mergeKeys: readonly string[]): { primaryKey: string; mergeKeys: string[] } {
  const primary = primaryKey?.trim() ?? '';
  if (primary.length === 0) throw new Error('primaryKey 不能为空');
  const keys = [...new Set(mergeKeys.map((key) => key.trim()).filter((key) => key.length > 0))];
  if (keys.length === 0) throw new Error('mergeKeys 不能为空（合并只按显式白名单工作）');
  if (keys.includes(primary)) throw new Error(`primaryKey 不能出现在 mergeKeys 里：${primary}`);
  for (const key of keys) {
    if (!/^[A-Za-z0-9]{1,32}$/u.test(key)) throw new Error(`条目 key 格式非法：${key}`);
  }
  return { primaryKey: primary, mergeKeys: keys };
}

async function pluginAvailability(options: PluginAvailabilityOptions): Promise<{ available: boolean; reason: PluginUnavailableReason | null; hint: string | null }> {
  const token = options.token ?? readPluginToken({ ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }), ...(options.env === undefined ? {} : { env: options.env }) });
  if (token === null) {
    return { available: false, reason: 'token-not-configured', hint: '本地没有可用的共享 token：请写入 <Zotero 数据目录>/zoteromcp-token.txt 或设置 ZOTERO_MCP_PLUGIN_TOKEN。' };
  }
  const baseUrl = options.baseUrl ?? process.env['ZOTERO_MCP_BASE_URL'] ?? 'http://127.0.0.1:23119';
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/u, '')}/zoteromcp/health`, {
      method: 'GET',
      headers: { accept: 'application/json', [PLUGIN_TOKEN_HEADER]: token },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    if (response.status === 404) return { available: false, reason: 'endpoint-missing', hint: '插件未安装或版本过旧：请重新构建并安装 .xpi 后重启 Zotero。' };
    if (response.status === 401) return { available: false, reason: 'unauthorized', hint: '共享 token 不匹配。' };
    if (response.status >= 500) return { available: false, reason: 'endpoint-error', hint: '插件端点在处理请求时出错（HTTP 5xx），请看 Zotero 的调试输出。' };
    if (!response.ok) return { available: false, reason: 'endpoint-missing', hint: `插件端点返回 HTTP ${response.status}。` };
    const body = (await response.json()) as { endpoints?: unknown };
    const endpoints = Array.isArray(body.endpoints) ? body.endpoints.map((entry) => String(entry)) : [];
    if (!endpoints.includes(MERGE_ENDPOINT) && !endpoints.includes(RECOGNIZE_ENDPOINT)) {
      return { available: false, reason: 'endpoint-missing', hint: '已安装的插件版本不含合并 / 识别端点：请重新构建并安装新版本。' };
    }
    return { available: true, reason: null, hint: null };
  } catch (error) {
    return {
      available: false,
      reason: 'http-server-disabled',
      hint: `Zotero 的 HTTP 服务器不可达（${error instanceof Error ? error.message : String(error)}）：请确认 Zotero 正在运行。`,
    };
  }
}

/** 生成合并计划（只读：仅对本地 API 与插件发 GET）。 */
export async function buildMergePlan(options: MergeOptions): Promise<MergePlan> {
  const { primaryKey, mergeKeys } = normalizeMergeKeys(options.primaryKey, options.mergeKeys);
  const now = options.now ?? (() => new Date());
  const auditDir = options.auditDir ?? resolveAuditDir();
  const keys = [primaryKey, ...mergeKeys];
  const details = await getItems({ ...channelOf(options), keys, include: [...PLAN_INCLUDE] });
  if (details.length !== keys.length) {
    const found = new Set(details.map((item) => item.key));
    throw new Error(`有条目读不到：${keys.filter((key) => !found.has(key)).join(', ')}`);
  }
  const availability = await pluginAvailability(options);
  const id = planId(now, keys.length);
  const impacts = {
    totalItems: keys.length,
    attachments: details.reduce((sum, item) => sum + item.attachments.length, 0),
    notes: details.reduce((sum, item) => sum + item.notes.length, 0),
    annotations: details.reduce((sum, item) => sum + item.annotations.length, 0),
    collections: [...new Set(details.flatMap((item) => item.collections))],
    tags: [...new Set(details.flatMap((item) => item.tags))],
  };
  return {
    planId: id,
    primaryKey,
    mergeKeys,
    pluginAvailable: availability.available,
    reason: availability.reason,
    hint: availability.hint,
    guide: availability.available
      ? null
      : `插件不可用（${String(availability.reason)}）：请在 Zotero 里用「重复项」面板人工合并 ${primaryKey} ← ${mergeKeys.join('、')}；本工具不会执行合并。`,
    snapshot: details.map(toSnapshot),
    snapshotPath: join(auditDir, 'snapshots', `${id}-merge.json`),
    impacts,
    summary: `合并 ${mergeKeys.length} 条到 ${primaryKey}（附件 ${impacts.attachments} · 笔记 ${impacts.notes} · 注释 ${impacts.annotations} · 集合 ${impacts.collections.length} · 标签 ${impacts.tags.length}）`,
  };
}

async function audit(auditDir: string, entry: Record<string, unknown>): Promise<string> {
  const path = join(auditDir, 'audit.jsonl');
  await mkdir(auditDir, { recursive: true });
  await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), channel: 'plugin', ...entry })}\n`, 'utf8');
  return path;
}

export interface MergeApplyOptions extends ChannelOptions {
  write?: boolean;
  confirm?: string;
  auditDir?: string;
  token?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface MergeApplyResult {
  planId: string;
  applied: boolean;
  snapshotPath: string | null;
  auditPath: string | null;
  primaryKey: string;
  mergedKeys: string[];
  trashedKeys: string[];
  pluginAvailable: boolean;
  reason: string | null;
  notes: string[];
}

/** 提交合并：门禁 → 快照落盘 → 插件执行（插件侧还会弹确认框）→ 回读与审计。 */
export async function applyMerge(plan: MergePlan, options: MergeApplyOptions): Promise<MergeApplyResult> {
  if (options.write !== true) throw new Error('写路径未开启：请显式传入 write=true 后再提交合并');
  assertWriteEnabled(options.env ?? process.env);
  if (options.confirm !== MERGE_CONFIRM_KEYWORD) {
    throw new Error(`合并是破坏性操作，必须携带 confirm="${MERGE_CONFIRM_KEYWORD}"`);
  }
  if (!plan.pluginAvailable) {
    return {
      planId: plan.planId,
      applied: false,
      snapshotPath: null,
      auditPath: null,
      primaryKey: plan.primaryKey,
      mergedKeys: plan.mergeKeys,
      trashedKeys: [],
      pluginAvailable: false,
      reason: plan.reason,
      notes: [plan.guide ?? '插件不可用，未执行合并。'],
    };
  }
  const token = options.token ?? readPluginToken({ ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }), ...(options.env === undefined ? {} : { env: options.env }) });
  if (token === null) throw new Error('本地没有可用的共享 token，未执行合并');
  const auditDir = options.auditDir ?? resolveAuditDir();
  // 非回环地址在发请求之前就被拒绝：这里是**写**路径，插件 token 属于凭证，
  // 一次都不允许被发往非回环主机（纵深防御；工具面到不了这里，但库函数是公开的）。
  const baseUrl = resolveBaseUrl(options.baseUrl).replace(/\/$/u, '');

  // 快照先于写入：即使合并被用户取消或失败，快照也必须留下
  await mkdir(join(auditDir, 'snapshots'), { recursive: true });
  await writeFile(plan.snapshotPath, `${JSON.stringify({ planId: plan.planId, createdAt: new Date().toISOString(), kind: 'merge', primaryKey: plan.primaryKey, mergeKeys: plan.mergeKeys, items: plan.snapshot }, null, 2)}\n`, 'utf8');

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${baseUrl}${MERGE_ENDPOINT}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', [PLUGIN_TOKEN_HEADER]: token },
    body: JSON.stringify({ primaryKey: plan.primaryKey, mergeKeys: plan.mergeKeys }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
  });
  const text = await response.text();
  const body = text.length === 0 ? null : (JSON.parse(text) as Record<string, unknown>);
  if (response.status === 409) {
    const auditPath = await audit(auditDir, { planId: plan.planId, op: 'merge', status: 'cancelled-by-user', primaryKey: plan.primaryKey, mergeKeys: plan.mergeKeys, snapshotPath: plan.snapshotPath, executed: false });
    return { planId: plan.planId, applied: false, snapshotPath: plan.snapshotPath, auditPath, primaryKey: plan.primaryKey, mergedKeys: plan.mergeKeys, trashedKeys: [], pluginAvailable: true, reason: 'cancelled-by-user', notes: ['你在 Zotero 的确认框里取消了合并：库内条目保持原状，快照仍已保留。'] };
  }
  if (!response.ok) {
    const reason = String(body?.['error'] ?? `HTTP ${response.status}`);
    const auditPath = await audit(auditDir, { planId: plan.planId, op: 'merge', status: 'failed', reason, primaryKey: plan.primaryKey, mergeKeys: plan.mergeKeys, snapshotPath: plan.snapshotPath, executed: false });
    return { planId: plan.planId, applied: false, snapshotPath: plan.snapshotPath, auditPath, primaryKey: plan.primaryKey, mergedKeys: plan.mergeKeys, trashedKeys: [], pluginAvailable: true, reason, notes: [`合并未执行：${reason}`] };
  }

  // 写后核对：主记录仍在、被合并条目已进垃圾箱
  const notes: string[] = [];
  const after = await getItems({ ...channelOf(options), keys: [plan.primaryKey] });
  if (after.length !== 1) notes.push(`主记录回读失败：${plan.primaryKey} 读不到`);
  const trash = await requestLocalApi({ ...channelOf(options), path: `${LIBRARY_PREFIX}/items/trash?limit=100` });
  const trashKeys = new Set(Array.isArray(trash.body) ? (trash.body as { key?: unknown }[]).map((entry) => String(entry.key)) : []);
  const trashedKeys = plan.mergeKeys.filter((key) => trashKeys.has(key));
  const notTrashed = plan.mergeKeys.filter((key) => !trashKeys.has(key));
  if (notTrashed.length > 0) notes.push(`以下条目未出现在垃圾箱（请人工核对）：${notTrashed.join(', ')}`);
  const auditPath = await audit(auditDir, {
    planId: plan.planId,
    op: 'merge',
    status: notes.length === 0 ? 'merged' : 'merged-with-notes',
    primaryKey: plan.primaryKey,
    mergeKeys: plan.mergeKeys,
    trashedKeys,
    snapshotPath: plan.snapshotPath,
    executed: true,
    notes,
  });
  return { planId: plan.planId, applied: true, snapshotPath: plan.snapshotPath, auditPath, primaryKey: plan.primaryKey, mergedKeys: plan.mergeKeys, trashedKeys, pluginAvailable: true, reason: null, notes };
}

export interface RecognizeOptions extends ChannelOptions {
  keys: string[];
  auditDir?: string;
  token?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface RecognizePlan {
  planId: string;
  keys: string[];
  pluginAvailable: boolean;
  reason: PluginUnavailableReason | null;
  hint: string | null;
  guide: string | null;
  targets: { key: string; itemType: string | null; title: string | null; isPdf: boolean }[];
  snapshot: MergeItemSnapshot[];
  snapshotPath: string;
  summary: string;
}

/**
 * 这个条目是不是插件识别器能处理的 PDF？
 *
 * 插件的 `canRecognize` 要求的是**顶层 PDF / EPUB 附件**，因此条目自身就是 PDF 附件时必须是真
 * ——只看子附件会让「计划说不能识别、插件其实能识别」这种最典型的用法报 false。
 * 带 PDF 子附件的父条目（另一种用法）沿用既有语义，同样为真。
 */
export function isRecognizablePdf(item: ItemDetail): boolean {
  if (item.itemType === 'attachment') return item.data['contentType'] === 'application/pdf';
  return item.attachments.some((child) => child.isPdf);
}

/** 生成识别计划（只读）。 */
export async function buildRecognizePlan(options: RecognizeOptions): Promise<RecognizePlan> {
  const keys = [...new Set(options.keys.map((key) => key.trim()).filter((key) => key.length > 0))];
  if (keys.length === 0) throw new Error('keys 不能为空（识别只按显式白名单工作）');
  const now = options.now ?? (() => new Date());
  const auditDir = options.auditDir ?? resolveAuditDir();
  const details = await getItems({ ...channelOf(options), keys, include: [...PLAN_INCLUDE] });
  if (details.length !== keys.length) {
    const found = new Set(details.map((item) => item.key));
    throw new Error(`有条目读不到：${keys.filter((key) => !found.has(key)).join(', ')}`);
  }
  const availability = await pluginAvailability(options);
  const id = planId(now, keys.length).replace('merge-', 'recognize-');
  return {
    planId: id,
    keys,
    pluginAvailable: availability.available,
    reason: availability.reason,
    hint: availability.hint,
    guide: availability.available ? null : `插件不可用（${String(availability.reason)}）：无法调用 Zotero 的识别器；可改用 zotero_add_items(mode=pdf) 的四级链或人工补全。`,
    targets: details.map((item) => ({ key: item.key, itemType: item.itemType, title: item.title, isPdf: isRecognizablePdf(item) })),
    snapshot: details.map(toSnapshot),
    snapshotPath: join(auditDir, 'snapshots', `${id}.json`),
    summary: `对 ${keys.length} 个条目调用 Zotero 识别器（写入需要 confirm="${RECOGNIZE_CONFIRM_KEYWORD}"）`,
  };
}

export interface RecognizeApplyOptions extends ChannelOptions {
  write?: boolean;
  confirm?: string;
  auditDir?: string;
  token?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface RecognizeApplyResult {
  planId: string;
  applied: boolean;
  snapshotPath: string | null;
  auditPath: string | null;
  pluginAvailable: boolean;
  reason: string | null;
  results: { key: string; ok: boolean; recognized: boolean; reason?: string; before?: Record<string, unknown>; after?: Record<string, unknown> }[];
  notes: string[];
}

/** 提交识别：门禁 → 快照落盘 → 插件执行 → 逐条 before/after 与审计。 */
export async function applyRecognize(plan: RecognizePlan, options: RecognizeApplyOptions): Promise<RecognizeApplyResult> {
  if (options.write !== true) throw new Error('写路径未开启：请显式传入 write=true 后再提交识别');
  assertWriteEnabled(options.env ?? process.env);
  if (options.confirm !== RECOGNIZE_CONFIRM_KEYWORD) {
    throw new Error(`识别会就地改写元数据，必须携带 confirm="${RECOGNIZE_CONFIRM_KEYWORD}"`);
  }
  if (!plan.pluginAvailable) {
    return { planId: plan.planId, applied: false, snapshotPath: null, auditPath: null, pluginAvailable: false, reason: plan.reason, results: [], notes: [plan.guide ?? '插件不可用，未执行识别。'] };
  }
  const token = options.token ?? readPluginToken({ ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }), ...(options.env === undefined ? {} : { env: options.env }) });
  if (token === null) throw new Error('本地没有可用的共享 token，未执行识别');
  const auditDir = options.auditDir ?? resolveAuditDir();
  // 与 applyMerge 同一道门：非回环地址下不落快照、不写审计、不发请求。
  const baseUrl = resolveBaseUrl(options.baseUrl).replace(/\/$/u, '');

  await mkdir(join(auditDir, 'snapshots'), { recursive: true });
  await writeFile(plan.snapshotPath, `${JSON.stringify({ planId: plan.planId, createdAt: new Date().toISOString(), kind: 'recognize', keys: plan.keys, items: plan.snapshot }, null, 2)}\n`, 'utf8');

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${baseUrl}${RECOGNIZE_ENDPOINT}`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json', [PLUGIN_TOKEN_HEADER]: token },
    body: JSON.stringify({ keys: plan.keys }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
  });
  const text = await response.text();
  const body = text.length === 0 ? null : (JSON.parse(text) as Record<string, unknown>);
  const results = Array.isArray(body?.['results']) ? (body?.['results'] as RecognizeApplyResult['results']) : [];
  const auditPath = await audit(auditDir, {
    planId: plan.planId,
    op: 'recognize',
    status: response.ok ? 'recognized' : 'failed',
    keys: plan.keys,
    recognized: results.filter((entry) => entry.recognized).map((entry) => entry.key),
    snapshotPath: plan.snapshotPath,
    executed: response.ok,
  });
  return {
    planId: plan.planId,
    applied: response.ok,
    snapshotPath: plan.snapshotPath,
    auditPath,
    pluginAvailable: true,
    reason: response.ok ? null : String(body?.['error'] ?? `HTTP ${response.status}`),
    results,
    notes: response.ok ? [] : [`识别未完成：HTTP ${response.status}`],
  };
}

/** token 文件路径（透出给工具层做提示，不泄露 token 本身）。 */
export const pluginTokenFile = pluginTokenPath;
export { readPluginToken, PLUGIN_TOKEN_HEADER };
