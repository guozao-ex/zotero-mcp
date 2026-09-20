/**
 * 写安全管线（M2）：计划 → dry-run → 审批 → 一次授权 → 版本前置提交 → 审计 → 快照 → 回滚。
 *
 * 设计约束（与路线图「写安全与硬约束」逐条对应）：
 * - 默认只读：ZOTERO_MCP_WRITE 未显式开启时拒绝一切写入；
 * - 破坏性操作（覆盖已有非空值、永久删除）需要 confirm 关键字；
 * - 同一计划只做一次运行时授权；
 * - 每个写请求带 Zotero-Server-ID 与 If-Unmodified-Since-Version；
 * - 提交前写快照、提交后写审计，回滚只依赖快照与审计。
 *
 * 这里是**唯一**的写路径实现：字段更新（patch）与条目/集合的创建、垃圾箱与永久删除
 * 共用同一段门禁、授权、快照、审计与回读校验代码；工具层只负责把意图编译成 ChangePlan。
 *
 * 真机实测（Zotero 10.0.2 本地 API，2026-09-18）：
 * - `POST /items` 与 `POST /collections` 的 body 必须是 JSON 数组，对象体得到 400；
 *   新 key 在 `successful["0"].key`（对象形）；
 * - 库级版本每次写入后递增，写请求的版本前提必须**每次重读**，412 用响应里的 found 版本重试；
 * - `PATCH /items/<key>` `{"deleted":1}` 才是「移入垃圾箱」，`DELETE /items/<key>` 是永久删除。
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ZoteroChannelError, classifyStatus } from '../errors.ts';
import { requestLocalApi } from '../channels/local-api.ts';
import {
  deleteRememberedKey,
  getRememberedKey,
  localApiKeyStorePath,
  putRememberedKey,
} from './local-api-key-store.ts';
import { DEFAULT_AUDIT_DIRNAME } from '../paths.ts';
import { LIBRARY_PREFIX, getItems } from './read.ts';
import { probeLocalApi } from '../channels/local-api.ts';
import type { ChannelOptions, ItemEnvelope } from './read.ts';

export const DEFAULT_AUDIT_DIR = DEFAULT_AUDIT_DIRNAME;
export const MAX_WRITE_BATCH = 50;
/** 运行时授权端点（本地 API）。 */
export const AUTHORIZE_PATH = '/api/local/authorize';

/** 写后回读的重试次数（含首次）：本地 API 在刚写完的瞬间可能还读不到该对象。 */
const READBACK_ATTEMPTS = 3;

/** 写后回读重试的退避基数（毫秒）：第 n 次重试等待 n × 该值。 */
const READBACK_DELAY_MS = 150;

/**
 * 写后回读的统一语义（四处共用：新建条目 / patch / 新建集合 / 集合重命名）。
 *
 * - `null`（读不到）时按短退避**有界重试**——本地 API 在刚写完的瞬间可能还看不到该对象；
 * - 返回 `reason` 区分「读不到（missing）」与「读到了但内容不符（mismatch）」，
 *   调用方据此给出**不同文案**，并统一用 `http-error`（不再误用 `write-unauthorized`）。
 */
async function readBackChecked(
  read: () => Promise<ItemEnvelope | null>,
  acceptable: (envelope: ItemEnvelope) => boolean,
): Promise<{ ok: true; envelope: ItemEnvelope } | { ok: false; reason: 'missing' | 'mismatch'; envelope: ItemEnvelope | null }> {
  let latest = await read();
  for (let attempt = 1; latest === null && attempt < READBACK_ATTEMPTS; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, READBACK_DELAY_MS * attempt));
    latest = await read();
  }
  if (latest === null) return { ok: false, reason: 'missing', envelope: null };
  if (!acceptable(latest)) return { ok: false, reason: 'mismatch', envelope: latest };
  return { ok: true, envelope: latest };
}
/** 授权时向 Zotero 声明的应用名（真机要求 appName 必填）。 */
export const AUTHORIZE_APP_NAME = 'zotero-mcp';
/** 授权需要用户在 Zotero 弹窗里点确认，超时要比普通请求长得多。 */
export const AUTHORIZE_TIMEOUT_MS = 120_000;

/** 回滚时不参与「清空」判断的结构性字段。 */
const STRUCTURAL_FIELDS = new Set([
  'key', 'version', 'itemType', 'creators', 'tags', 'collections', 'relations', 'dateAdded', 'dateModified',
]);

/** 覆盖已有非空值时需要的确认关键字。 */
export const OVERWRITE_KEYWORD = 'OVERWRITE';
/** 永久删除需要的确认关键字。 */
export const DELETE_KEYWORD = 'DELETE';

export interface FieldChange {
  key: string;
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * 计划中的单个操作。
 *
 * - `patch`：字段更新（逐条 PATCH，版本前置）；
 * - `create`：新建条目（POST /items，版本前提用库级版本）；
 * - `trash` / `delete`：移入垃圾箱 / 从垃圾箱彻底删除；
 * - `collection-create` / `collection-rename`：集合创建与重命名。
 */
export type PlanOperation =
  | { kind: 'patch'; key: string; fields: Record<string, unknown> }
  | { kind: 'create'; itemType: string; fields: Record<string, unknown>; source?: string }
  | { kind: 'trash'; key: string }
  | { kind: 'delete'; key: string }
  | { kind: 'collection-create'; name: string; parentCollection?: string }
  | { kind: 'collection-rename'; key: string; name: string };

export interface ChangePlan {
  id: string;
  createdAt: string;
  targetKeys: string[];
  changes: FieldChange[];
  destructive: boolean;
  confirmKeyword: string | null;
  summary: string;
  /** 非字段类操作；缺省时由 `changes` 推导为逐条 patch（兼容 change 4 的计划）。 */
  operations?: PlanOperation[];
  /** 计划构建时读到的库级版本（本地 API 的 Last-Modified-Version），创建类请求的版本前提。 */
  libraryVersion?: number | null;
}

export interface ApplyResult {
  planId: string;
  /** key 的来源（审计口径，不记 key 本身）：memory＝进程内缓存 / file＝落盘复用 / authorize＝本轮新授权。 */
  authSource?: 'memory' | 'file' | 'authorize';
  /** 本轮是否拿到「永久授权」（remember:true）。 */
  remembered?: boolean;
  /** 一次性授权（remember:false）时的提示：下次写入仍会弹窗，请在弹窗里选 Always Allow。 */
  authNotice?: string;
  authorizeCount: number;
  submittedKeys: string[];
  conflictRetries: number;
  auditPath: string;
  snapshotPath: string;
  results: { key: string; status: 'updated' | 'conflict-recovered' | 'failed'; version: number | null }[];
  /** 本次新建的条目 key（写入结果、快照与审计三处都会出现）。 */
  createdKeys: string[];
  /** 每个操作的执行结论（含创建 / 删除 / 集合）。 */
  operations: { kind: PlanOperation['kind']; key: string | null; status: 'applied' | 'conflict-recovered' | 'failed' }[];
  libraryVersion: number | null;
}

export interface UpdateIntent {
  key: string;
  field: string;
  value: unknown;
}

/** 写开关：只有显式开启（on/true/1）才允许写入。 */
export function isWriteEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = (env['ZOTERO_MCP_WRITE'] ?? '').trim().toLowerCase();
  return value === 'on' || value === 'true' || value === '1';
}

/** 写开关总闸：未开启时给出可读拒绝。工具层与管线共用同一段文案。 */
export function assertWriteEnabled(env: NodeJS.ProcessEnv = process.env): void {
  if (!isWriteEnabled(env)) {
    throw new Error(
      '默认只读：ZOTERO_MCP_WRITE 未设置为 on，已拒绝写入。请设置 ZOTERO_MCP_WRITE=on 并重启 MCP 服务器后，再以 dryRun=false 提交。',
    );
  }
}

function auditPaths(auditDir: string): { dir: string; audit: string; snapshots: string } {
  const dir = auditDir;
  return { dir, audit: join(dir, 'audit.jsonl'), snapshots: join(dir, 'snapshots') };
}

/** 只取通道相关的可选字段，避免把 env / write 等执行选项透传到 HTTP 层。 */
function channelOf(options: ChannelOptions): ChannelOptions {
  return {
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs,
  };
}

/**
 * 计划 ID（也是快照文件名）。
 *
 * 时间戳只到秒，同一秒内的多个计划会撞名并互相覆盖快照（真机演示实测到），
 * 因此追加一段随机后缀，保证「回滚只依赖快照」这条不变量成立。
 */
function planId(createdAt: string, size: number): string {
  const stamp = createdAt.replace(/[^0-9]/gu, '').slice(0, 14);
  const unique = Math.random().toString(16).slice(2, 6);
  return `plan-${stamp}-${size}-${unique}`;
}

/** 由字段变更构造计划（change 4 的入口保持不变）。 */
export async function buildChangePlan(
  options: ChannelOptions & { updates: UpdateIntent[]; now?: () => Date },
): Promise<ChangePlan> {
  const targetKeys = [...new Set(options.updates.map((update) => update.key))];
  if (targetKeys.length === 0) throw new Error('updates 不能为空');
  const items = await getItems({ ...channelOf(options), keys: targetKeys });
  const byKey = new Map(items.map((item) => [item.key, item]));
  const changes: FieldChange[] = [];
  for (const update of options.updates) {
    const item = byKey.get(update.key);
    if (item === undefined) continue;
    const before = (item as unknown as { data?: Record<string, unknown> }).data?.[update.field] ?? null;
    if (JSON.stringify(before) === JSON.stringify(update.value)) continue; // 无变化不入计划
    changes.push({ key: update.key, field: update.field, before, after: update.value });
  }
  const destructive = changes.some((change) => change.before !== null && change.before !== '');
  const createdAt = (options.now?.() ?? new Date()).toISOString();
  return {
    id: planId(createdAt, targetKeys.length),
    createdAt,
    targetKeys,
    changes,
    destructive,
    confirmKeyword: destructive ? OVERWRITE_KEYWORD : null,
    summary: `${changes.length} 处字段变更，涉及 ${targetKeys.length} 个条目${destructive ? '（含覆盖已有值，需确认）' : ''}`,
  };
}

export interface PlanShell {
  targetKeys: string[];
  changes: FieldChange[];
  operations: PlanOperation[];
  summary: string;
  destructive?: boolean;
  confirmKeyword?: string | null;
  libraryVersion?: number | null;
  now?: () => Date;
}

/** 供写工具构造计划：把操作清单与字段 diff 组装成 ChangePlan。 */
export function makeChangePlan(shell: PlanShell): ChangePlan {
  const createdAt = (shell.now?.() ?? new Date()).toISOString();
  const targetKeys = [...new Set(shell.targetKeys)];
  const destructive = shell.destructive ?? shell.changes.some((change) => change.before !== null && change.before !== '');
  return {
    id: planId(createdAt, Math.max(targetKeys.length, shell.operations.length, 1)),
    createdAt,
    targetKeys,
    changes: shell.changes,
    destructive,
    confirmKeyword: shell.confirmKeyword ?? (destructive ? OVERWRITE_KEYWORD : null),
    summary: shell.summary,
    operations: shell.operations,
    libraryVersion: shell.libraryVersion ?? null,
  };
}

function describeOperation(operation: PlanOperation): string {
  switch (operation.kind) {
    case 'patch':
      return `${operation.key}：${Object.keys(operation.fields).join(', ')}`;
    case 'create':
      return `新建 ${operation.itemType}（${Object.keys(operation.fields).slice(0, 6).join(', ') || '仅必备字段'}）`;
    case 'trash':
      return `${operation.key} → 垃圾箱`;
    case 'delete':
      return `${operation.key} → 永久删除`;
    case 'collection-create':
      return `新建集合「${operation.name}」${operation.parentCollection === undefined ? '' : `（父集合 ${operation.parentCollection}）`}`;
    case 'collection-rename':
      return `集合 ${operation.key} 重命名为「${operation.name}」`;
    default:
      return '未知操作';
  }
}

/** 人类可读 diff（dry-run 输出，不落盘）。 */
export function previewPlan(plan: ChangePlan): string {
  const lines = [`计划 ${plan.id} · ${plan.summary}`];
  const byKey = new Map<string, FieldChange[]>();
  for (const change of plan.changes) {
    byKey.set(change.key, [...(byKey.get(change.key) ?? []), change]);
  }
  for (const [key, changes] of byKey) {
    lines.push(`  ${key}`);
    for (const change of changes) {
      lines.push(`    ${change.field}: ${JSON.stringify(change.before)} → ${JSON.stringify(change.after)}`);
    }
  }
  for (const operation of plan.operations ?? []) {
    if (operation.kind === 'patch') continue; // patch 已由逐字段 diff 渲染
    lines.push(`  [${operation.kind}] ${describeOperation(operation)}`);
  }
  if (plan.destructive) lines.push(`  注意：需要 confirm="${plan.confirmKeyword}" 才能提交`);
  return lines.join('\n');
}

export interface ApplyOptions extends ChannelOptions {
  /** 便于测试注入的环境变量（默认 process.env）。 */
  env?: NodeJS.ProcessEnv;
  /** 必须显式为 true 才写入；默认只做预览。 */
  write?: boolean;
  confirm?: string;
  auditDir?: string;
  /**
   * 注入授权函数（测试用），默认走 POST /api/local/authorize。
   * 返回 `string` 视为 `remember:false`（一次性）；返回对象可显式给出 `remember`。
   */
  authorizeImpl?: () => Promise<string | { key: string; remember: boolean }>;
  /** 覆盖「已记住的写授权」落盘路径（默认 <ZOTERO_MCP_DATA_DIR>/zoteromcp-local-api-key.json）。 */
  localApiKeyStorePath?: string;
  /**
   * 是否复用**进程内**授权缓存（默认 true）。
   * Zotero 对同一个 `Zotero-Server-ID` 返回同一个 key，因此同一进程内的多个计划只需授权一次；
   * 测试若要逐用例隔离授权计数，可显式置 `false`。
   */
  authCache?: boolean;
  /**
   * 是否读写「已记住的写授权」落盘文件（默认 true）。
   * 与 authCache 分开：前者是**跨进程**复用（0 次弹窗的关键），后者只是同一进程内的内存缓存。
   */
  keyStore?: boolean;
}

/**
 * 进程内授权缓存，键为 `baseUrl|serverId`。
 *
 * 为什么需要：写管线单次提交最多 50 个对象，一次大批量操作必然拆成多个计划，而旧实现**每个计划开头都无条件**
 * 调一次 `POST /api/local/authorize`；Zotero 对该端点限流 **5 次/分钟**，超限返回 429（2026-09-20 清理 408 个
 * 对象时实际踩到：9 个计划 → 9 次授权 → 429，整批写卡死）。缓存后同一进程只授权一次，
 * 且 key 被服务端拒绝时仍会重新授权一次并刷新缓存。
 */
const LOCAL_API_AUTH_CACHE = new Map<string, string>();

/** 仅供测试：清空进程内授权缓存。 */
export function resetLocalApiAuthCache(): void {
  LOCAL_API_AUTH_CACHE.clear();
}

async function requestAuthorize(
  options: ApplyOptions,
  serverId?: string,
): Promise<{ key: string; remember: boolean }> {
  if (options.authorizeImpl !== undefined) {
    const injected = await options.authorizeImpl();
    return typeof injected === 'string' ? { key: injected, remember: false } : injected;
  }
  const response = await requestLocalApi({
    ...channelOf(options),
    timeoutMs: AUTHORIZE_TIMEOUT_MS,
    path: AUTHORIZE_PATH,
    method: 'POST',
    headers: {
      'zotero-api-version': '3',
      ...(serverId === undefined || serverId === 'unknown' ? {} : { 'zotero-server-id': serverId }),
    },
    body: { appName: AUTHORIZE_APP_NAME },
  });
  const body = response.body as { key?: unknown; remember?: unknown } | null;
  const key = body?.key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new ZoteroChannelError('write-unauthorized', '授权未返回可用 key', { status: response.status });
  }
  // `remember:true`（使用者点了 “Always Allow”）的 key 才值得落盘复用；一次性 key 存了必 401。
  return { key, remember: body?.remember === true };
}

/** 读单个条目信封；404 返回 null（删除后的存在性校验依赖它）。写工具层复用该读取。 */
export async function readItemEnvelope(options: ChannelOptions, key: string): Promise<ItemEnvelope | null> {
  try {
    const response = await requestLocalApi({ ...channelOf(options), path: `${LIBRARY_PREFIX}/items/${key}` });
    const body = response.body;
    if (Array.isArray(body)) return (body[0] as ItemEnvelope | undefined) ?? null;
    return (body as ItemEnvelope | null) ?? null;
  } catch (error) {
    if (error instanceof ZoteroChannelError && error.status === 404) return null;
    throw error;
  }
}

async function readCollection(options: ChannelOptions, key: string): Promise<ItemEnvelope | null> {
  try {
    const response = await requestLocalApi({ ...channelOf(options), path: `${LIBRARY_PREFIX}/collections/${key}` });
    return (response.body as ItemEnvelope | null) ?? null;
  } catch (error) {
    if (error instanceof ZoteroChannelError && error.status === 404) return null;
    throw error;
  }
}

/** 库级版本：创建/集合写入的版本前提（本地 API 用 Last-Modified-Version 报数）。 */
async function readLibraryVersion(options: ChannelOptions): Promise<number | null> {
  const response = await requestLocalApi({ ...channelOf(options), path: `${LIBRARY_PREFIX}/items?limit=1` });
  return response.lastModifiedVersion;
}

/** 垃圾箱里的 key 集合；端点不可用时返回 null（回退到 `data.deleted` 判断）。 */

export async function readTrashKeySet(options: ChannelOptions): Promise<Set<string> | null> {
  try {
    const response = await requestLocalApi({ ...channelOf(options), path: `${LIBRARY_PREFIX}/items/trash?limit=100` });
    if (!Array.isArray(response.body)) return null;
    return new Set((response.body as ItemEnvelope[]).map((entry) => entry.key));
  } catch {
    return null;
  }
}

function isTrashed(envelope: ItemEnvelope | null): boolean {
  if (envelope === null) return false;
  const deleted = envelope.data['deleted'];
  return deleted === 1 || deleted === true || deleted === '1';
}

/**
 * 判断条目是否已在垃圾箱。
 *
 * 真机语义：`/items/<key>` 不一定回填 `data.deleted`，权威来源是 `/items/trash`；
 * 两个信号取「或」，避免把已在垃圾箱的条目误判为未删除。
 */
async function isInTrash(options: ChannelOptions, envelope: ItemEnvelope | null): Promise<boolean> {
  if (envelope === null) return false;
  if (isTrashed(envelope)) return true;
  const trashKeys = await readTrashKeySet(options);
  return trashKeys !== null && trashKeys.has(envelope.key);
}

function normalizeValue(value: unknown): unknown {
  if (value === '' || value === undefined || value === null) return null;
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * 键序无关的规范化 JSON。
 *
 * 真机在创建／更新后会重排嵌套对象的字段顺序（例如 `creators` 从
 * `{creatorType, firstName, lastName}` 变成 `{firstName, lastName, creatorType}`），
 * 直接 `JSON.stringify` 比对会把成功的写入误判为失败，因此比对前先按 key 排序。
 */
function stableStringify(value: unknown): string {
  const normalized = normalizeValue(value);
  if (Array.isArray(normalized)) {
    return `[${normalized.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (typeof normalized === 'object' && normalized !== null) {
    const record = normalized as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(normalized ?? null);
}

function matchesFields(data: Record<string, unknown>, fields: Record<string, unknown>): boolean {
  return Object.entries(fields).every(([field, expected]) => stableStringify(data[field]) === stableStringify(expected));
}

/**
 * 从 POST /items 或 /collections 的响应里取新对象 key。
 *
 * 真机响应形如 `{"successful":{"0":{"key":"KMM9F5V8","version":43,…}},"success":{…}}`，
 * 即 `successful["0"]` 是**对象**而不是字符串；同时兼容字符串形与顶层 `key`。
 */
function extractCreatedKey(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  for (const field of ['successful', 'success']) {
    const map = record[field];
    if (typeof map !== 'object' || map === null) continue;
    for (const value of Object.values(map as Record<string, unknown>)) {
      if (typeof value === 'string' && value.length > 0) return value;
      if (typeof value === 'object' && value !== null) {
        const key = (value as Record<string, unknown>)['key'];
        if (typeof key === 'string' && key.length > 0) return key;
      }
    }
  }
  const single = record['key'];
  return typeof single === 'string' && single.length > 0 ? single : null;
}

/**
 * 解析创建操作字段里的 `@created:<n>` 占位符：替换为同一计划内第 n 个已创建对象的 key。
 *
 * 用途：`mode=pdf` 导入时先建条目、再把 PDF 作为 linked 附件挂到新条目下，
 * 而父条目 key 只有在执行时才知道；占位符让「条目 + 附件」共用一次授权与一份快照。
 */
export function resolveCreatedRefs(
  fields: Record<string, unknown>,
  createdSequence: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value === 'string' && value.startsWith('@created:')) {
      const index = Number(value.slice('@created:'.length));
      const createdKey = Number.isInteger(index) ? createdSequence[index] : undefined;
      if (createdKey === undefined) {
        throw new Error(`计划引用了尚不存在的创建对象：${value}（当前已创建 ${createdSequence.length} 个）`);
      }
      out[field] = createdKey;
    } else {
      out[field] = value;
    }
  }
  return out;
}

/** 把 `changes` 折成逐条 patch 操作（change 4 的计划没有 `operations` 字段）。 */
function operationsFromChanges(plan: ChangePlan): PlanOperation[] {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const change of plan.changes) {
    byKey.set(change.key, { ...(byKey.get(change.key) ?? {}), [change.field]: change.after });
  }
  return [...byKey].map(([key, fields]) => ({ kind: 'patch' as const, key, fields }));
}

/**
 * 提交计划：门禁 → 授权一次 → 写前快照 → 逐操作提交（版本前置 + 回读校验）→ 审计 → 快照回填。
 *
 * 真机结论（Zotero 10.0.2）：批量 `POST /items`（数组体）会被判为 unchanged 而不生效，
 * 字段更新必须逐条 `PATCH /items/<key>`；`POST /items`（单对象体）用于新建条目。
 */
export async function applyPlan(plan: ChangePlan, options: ApplyOptions = {}): Promise<ApplyResult> {
  if (options.write !== true) {
    throw new Error('写路径未开启：请显式传入 write=true（或设置 ZOTERO_MCP_WRITE=on）后再提交计划');
  }
  // 环境开关是操作者的总闸：即使调用方传 write=true，ZOTERO_MCP_WRITE 未开启也必须拒绝。
  assertWriteEnabled(options.env ?? process.env);
  if (plan.destructive && options.confirm !== plan.confirmKeyword) {
    throw new Error(`该计划覆盖已有值，必须携带 confirm="${plan.confirmKeyword}"`);
  }
  const operations = (plan.operations ?? operationsFromChanges(plan)) as PlanOperation[];
  // 永久删除是破坏性操作里最不可逆的一种：只要计划里含 delete，就必须携带 DELETE 关键字，
  // 不依赖调用方是否正确设置 destructive / confirmKeyword（防御手工构造的计划）。
  if (operations.some((operation) => operation.kind === 'delete') && options.confirm !== DELETE_KEYWORD) {
    throw new Error(`永久删除条目必须携带 confirm="${DELETE_KEYWORD}"`);
  }
  if (operations.length === 0) throw new Error('计划不包含任何操作（无变化或目标不存在）');
  if (operations.length > MAX_WRITE_BATCH) {
    throw new Error(`一次提交最多 ${MAX_WRITE_BATCH} 个对象，当前 ${operations.length} 个`);
  }

  const auditDir = options.auditDir ?? DEFAULT_AUDIT_DIR;
  const paths = auditPaths(auditDir);
  await mkdir(paths.snapshots, { recursive: true });

  // 写请求必须携带 Zotero-Server-ID（缺失会得到 428）；启动探测一次并复用。
  const probe = await probeLocalApi(channelOf(options));
  const serverId = probe.serverId;
  if (!probe.writeAvailable) {
    throw new ZoteroChannelError('local-api-disabled', `本地 API 不可写：${probe.reason ?? '未知原因'}`, {
      status: probe.statusCode,
    });
  }

  // 创建类操作没有对象版本，版本前提用库级版本（Last-Modified-Version）；只有真需要时才多读一次。
  const needsLibraryVersion = operations.some(
    (operation) => operation.kind === 'create' || operation.kind === 'collection-create' || operation.kind === 'collection-rename',
  );
  const libraryVersion = needsLibraryVersion ? await readLibraryVersion(options) : null;

  // 快照：受影响对象的完整 JSON（回滚的唯一依据）
  const snapshotKeys = [
    ...new Set(
      operations.flatMap((operation) =>
        operation.kind === 'patch' || operation.kind === 'trash' || operation.kind === 'delete' ? [operation.key] : [],
      ),
    ),
  ];
  const snapshotItems = snapshotKeys.length === 0 ? [] : await getItems({ ...channelOf(options), keys: snapshotKeys });
  const snapshotCollections: ItemEnvelope[] = [];
  for (const key of [
    ...new Set(operations.flatMap((operation) => (operation.kind === 'collection-rename' ? [operation.key] : []))),
  ]) {
    const collection = await readCollection(options, key);
    if (collection !== null) snapshotCollections.push(collection);
  }
  const snapshotPath = join(paths.snapshots, `${plan.id}.json`);
  const snapshot: {
    planId: string;
    createdAt: string;
    libraryVersion: number | null;
    operations: PlanOperation[];
    items: unknown[];
    collections: ItemEnvelope[];
    created: { key: string; kind: PlanOperation['kind']; source?: string }[];
  } = {
    planId: plan.id,
    createdAt: plan.createdAt,
    libraryVersion,
    operations,
    items: snapshotItems,
    collections: snapshotCollections,
    created: [],
  };
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');

  // 授权 key 按 (baseUrl, serverId) 在**进程内**复用：Zotero 对同一个 Server-ID 返回同一个 key，
  // 所以同一进程内的多个计划只需授权一次（旧实现每个计划都无条件授权，会撞上 5 次/分钟的限流 429）；
  // 仅在 key 被拒（401）时重新授权一次并刷新缓存。
  const authCacheKey = `${options.baseUrl ?? ''}|${serverId}`;
  const useAuthCache = options.authCache !== false;
  const useKeyStore = options.keyStore !== false;
  const keyStorePath = options.localApiKeyStorePath ?? localApiKeyStorePath(options.env ?? process.env);
  let authorizeCount = 0;
  /** 本轮写用的 key 来自哪里（审计用；不记 key 本身）。 */
  let authSource: 'memory' | 'file' | 'authorize' = 'authorize';
  /** 授权是否为「永久」（remember:true）。 */
  let remembered = false;
  /** 一次性授权时的使用者提示（库层不打印，交给调用方）。 */
  let authNotice: string | null = null;
  // 显式标注为 string（空串＝尚未拿到 key）：闭包里 TS 无法保留 `string | undefined` 的收窄。
  let key: string = useAuthCache ? (LOCAL_API_AUTH_CACHE.get(authCacheKey) ?? '') : '';
  if (key !== '') {
    authSource = 'memory';
  } else if (useKeyStore) {
    // 落盘层：只有 remember:true 的 key 会被存进来（见 local-api-key-store 的读取过滤）。
    const stored = getRememberedKey(serverId ?? '', keyStorePath);
    if (stored !== null) {
      key = stored;
      authSource = 'file';
      LOCAL_API_AUTH_CACHE.set(authCacheKey, key);
    }
  }
  if (key === '') {
    const authorized = await requestAuthorize(options, serverId);
    authorizeCount += 1;
    key = authorized.key;
    remembered = authorized.remember;
    authSource = 'authorize';
    if (useAuthCache) LOCAL_API_AUTH_CACHE.set(authCacheKey, key);
    if (authorized.remember && useKeyStore) {
      putRememberedKey(serverId ?? '', key, { path: keyStorePath });
    } else {
      authNotice = '本次是一次性授权（remember=false）：下次写入仍会弹窗——请在弹窗里选「Always Allow」';
    }
  }

  /** 同一计划内已成功创建的对象 key（按创建顺序），供后续操作引用。 */
  const createdSequence: string[] = [];
  const results: ApplyResult['results'] = [];
  const operationResults: ApplyResult['operations'] = [];
  const createdKeys: string[] = [];
  /** 已提交但尚未通过回读校验的新建对象：仍写入快照，便于失败后清理或回滚。 */
  const provisionalCreated: { key: string; kind: PlanOperation['kind'] }[] = [];
  let conflictRetries = 0;

  /** 401 时重新授权一次并复用同一个操作（不重建计划）。 */
  const withAuth = async <T>(run: (apiKey: string) => Promise<T>): Promise<T> => {
    try {
      return await run(key);
    } catch (error) {
      const code = error instanceof ZoteroChannelError ? error.code : classifyStatus(0);
      if (code === 'write-unauthorized') {
        // key 被撤销/失效：先作废该 server ID 的分区，再重新授权一次（有界，不循环）。
        if (useKeyStore) deleteRememberedKey(serverId ?? '', keyStorePath);
        const refreshed = await requestAuthorize(options, serverId);
        key = refreshed.key;
        remembered = refreshed.remember;
        authSource = 'authorize';
        authorizeCount += 1;
        if (useAuthCache) LOCAL_API_AUTH_CACHE.set(authCacheKey, refreshed.key);
        if (refreshed.remember && useKeyStore) {
          putRememberedKey(serverId ?? '', refreshed.key, { path: keyStorePath });
        } else {
          authNotice = '本次是一次性授权（remember=false）：下次写入仍会弹窗——请在弹窗里选「Always Allow」';
        }
        return run(refreshed.key);
      }
      if (code === 'version-conflict') {
        // 412 的语义是「客户端在跟另一个 Zotero 实例说话」——只有探测到的实例 ID 确实不同，
        // 才作废分区；否则普通的版本竞争会误删 remembered key，白白让使用者再点一次弹窗。
        try {
          const probed = await probeLocalApi({ ...channelOf(options) });
          if (probed.serverId !== undefined && probed.serverId !== 'unknown' && probed.serverId !== serverId) {
            deleteRememberedKey(serverId ?? '', keyStorePath);
            LOCAL_API_AUTH_CACHE.delete(authCacheKey);
          }
        } catch {
          // 探测失败时保守处理：不动落盘的 key
        }
      }
      throw error;
    }
  };

  const appendAudit = async (entry: Record<string, unknown>): Promise<void> => {
    await appendFile(paths.audit, `${JSON.stringify({ ts: new Date().toISOString(), planId: plan.id, channel: 'local-api', serverId, ...entry })}
`, 'utf8');
  };

  const patchOne = async (itemKey: string, fields: Record<string, unknown>, apiKey: string, versionOverride?: number): Promise<void> => {
    const envelope = await readItemEnvelope(options, itemKey);
    const version = versionOverride ?? envelope?.version ?? 1;
    await requestLocalApi({
      ...channelOf(options),
      path: `${LIBRARY_PREFIX}/items/${itemKey}`,
      method: 'PATCH',
      headers: {
        'Zotero-API-Key': apiKey,
        'Zotero-Server-ID': serverId,
        'Zotero-API-Version': '3',
        // 版本前提是必需的（缺失会得到 428）；优先用 412 响应里的真实版本
        'If-Unmodified-Since-Version': String(version),
      },
      body: fields,
    });
  };

  const runPatch = async (operation: Extract<PlanOperation, { kind: 'patch' }>): Promise<{ status: 'updated' | 'conflict-recovered'; version: number | null }> => {
    let status: 'updated' | 'conflict-recovered' = 'updated';
    await withAuth(async (apiKey) => {
      try {
        await patchOne(operation.key, operation.fields, apiKey);
      } catch (error) {
        const code = error instanceof ZoteroChannelError ? error.code : classifyStatus(0);
        if (code !== 'version-conflict') throw error;
        // 本地 API 的版本报数可能滞后；412 响应体里的 found <version> 才是真实版本
        const found = /found (\d+)/u.exec(error instanceof Error ? error.message : '')?.[1];
        await patchOne(operation.key, operation.fields, apiKey, found === undefined ? undefined : Number(found));
        status = 'conflict-recovered';
      }
    });
    const checked = await readBackChecked(
      () => readItemEnvelope(options, operation.key),
      (envelope) => matchesFields(envelope.data, operation.fields),
    );
    if (!checked.ok) {
      throw new ZoteroChannelError(
        'http-error',
        checked.reason === 'missing'
          ? `写入未生效：回读校验失败（已重试 ${READBACK_ATTEMPTS} 次仍读不到）：${operation.key}`
          : `写入未生效：回读内容与提交不符：${operation.key}`,
      );
    }
    return { status, version: checked.envelope.version ?? null };
  };

  /** 库级版本在每个创建 / 集合写请求前重读：真机每次写入都会推进 Last-Modified-Version。 */
  const freshLibraryVersion = async (): Promise<number> => (await readLibraryVersion(options)) ?? libraryVersion ?? 1;

  /** 412 表示库版本已被上一次写入推进：用响应里的 found 版本重试一次，不盲目重发。 */
  const withFreshVersion = async <T>(run: (version: number) => Promise<T>): Promise<T> => {
    const version = await freshLibraryVersion();
    try {
      return await run(version);
    } catch (error) {
      const code = error instanceof ZoteroChannelError ? error.code : classifyStatus(0);
      const found = /found (\d+)/u.exec(error instanceof Error ? error.message : '')?.[1];
      if (code !== 'version-conflict' || found === undefined) throw error;
      return run(Number(found));
    }
  };

  const runCreate = async (operation: Extract<PlanOperation, { kind: 'create' }>): Promise<string> => {
    // 真机硬约束：POST /items 的 body 必须是 JSON 数组，对象体会得到
    // 400 Uploaded data must be a JSON array（本地 API 与 Web API 的单对象语义不同）。
    const payload = [{ itemType: operation.itemType, ...operation.fields }];
    const response = await withAuth(async (apiKey) =>
      withFreshVersion((version) =>
        requestLocalApi({
          ...channelOf(options),
          path: `${LIBRARY_PREFIX}/items`,
          method: 'POST',
          headers: {
            'Zotero-API-Key': apiKey,
            'Zotero-Server-ID': serverId,
            'Zotero-API-Version': '3',
            'If-Unmodified-Since-Version': String(version),
          },
          body: payload,
        }),
      ),
    );
    const created = extractCreatedKey(response.body);
    if (created === null) {
      throw new ZoteroChannelError('http-error', `新建条目未返回 key：${JSON.stringify(response.body).slice(0, 200)}`);
    }
    // 先登记：即使回读校验失败，调用方也能按快照清理这个已经写进库的对象
    provisionalCreated.push({ key: created, kind: operation.kind });
    // 回读校验：本地 API 在**刚创建后的瞬间**可能还读不到该条目（真机实测 2026-09-20：连续创建
    // 8 个父条目 + 8 个附件，16 个**全部**报「回读校验失败」，而只读 GET 证明条目都在库中）。
    // 因此「读不到（null）」按短退避**有界重试**，仍读不到才判失败；失败一律 fail-closed。
    const checked = await readBackChecked(
      () => readItemEnvelope(options, created),
      (envelope) => envelope.data['itemType'] === operation.itemType && matchesFields(envelope.data, operation.fields),
    );
    if (!checked.ok) {
      throw new ZoteroChannelError(
        'http-error',
        checked.reason === 'missing'
          ? `新建条目回读校验失败（已重试 ${READBACK_ATTEMPTS} 次仍读不到）：${created}`
          : `新建条目回读内容与提交不符：${created}（itemType=${String(checked.envelope?.data['itemType'])}，期望 ${operation.itemType}）`,
      );
    }
    return created;
  };

  const deleteItem = async (itemKey: string, apiKey: string, versionOverride?: number): Promise<void> => {
    const envelope = await readItemEnvelope(options, itemKey);
    const version = versionOverride ?? envelope?.version ?? 1;
    await requestLocalApi({
      ...channelOf(options),
      path: `${LIBRARY_PREFIX}/items/${itemKey}`,
      method: 'DELETE',
      headers: {
        'Zotero-API-Key': apiKey,
        'Zotero-Server-ID': serverId,
        'Zotero-API-Version': '3',
        'If-Unmodified-Since-Version': String(version),
      },
    });
  };

  /**
   * 进垃圾箱。
   *
   * 真机实测：`DELETE /items/<key>` 会**直接永久删除**（之后 GET 返回 404，且不出现在 /items/trash）；
   * 真正等价于「移入垃圾箱」的是 `PATCH /items/<key>` `{"deleted":1}` —— 之后条目出现在
   * `/items/trash`、从 `/items/top` 消失，`GET /items/<key>` 仍返回 200 且 `deleted=true`。
   */
  const trashItem = async (itemKey: string, apiKey: string, versionOverride?: number): Promise<void> => {
    const envelope = await readItemEnvelope(options, itemKey);
    const version = versionOverride ?? envelope?.version ?? 1;
    await requestLocalApi({
      ...channelOf(options),
      path: `${LIBRARY_PREFIX}/items/${itemKey}`,
      method: 'PATCH',
      headers: {
        'Zotero-API-Key': apiKey,
        'Zotero-Server-ID': serverId,
        'Zotero-API-Version': '3',
        'If-Unmodified-Since-Version': String(version),
      },
      body: { deleted: 1 },
    });
  };

  const runTrash = async (itemKey: string): Promise<void> => {
    if (await isInTrash(options, await readItemEnvelope(options, itemKey))) return; // 已在垃圾箱：幂等
    await withAuth(async (apiKey) => {
      try {
        await trashItem(itemKey, apiKey);
      } catch (error) {
        const code = error instanceof ZoteroChannelError ? error.code : classifyStatus(0);
        if (code !== 'version-conflict') throw error;
        const found = /found (\d+)/u.exec(error instanceof Error ? error.message : '')?.[1];
        await trashItem(itemKey, apiKey, found === undefined ? undefined : Number(found));
      }
    });
    const after = await readItemEnvelope(options, itemKey);
    if (!isTrashed(after)) {
      const trashKeys = await readTrashKeySet(options);
      if (trashKeys === null || !trashKeys.has(itemKey)) {
        throw new ZoteroChannelError('http-error', `移入垃圾箱未生效（回读校验失败）：${itemKey}`);
      }
    }
  };

  const runDelete = async (itemKey: string): Promise<void> => {
    // 真机 DELETE 本身就是永久删除（不会进垃圾箱）；垃圾箱中的条目也用同一条路径彻底移除。
    await withAuth(async (apiKey) => {
      try {
        await deleteItem(itemKey, apiKey);
      } catch (error) {
        const code = error instanceof ZoteroChannelError ? error.code : classifyStatus(0);
        if (code !== 'version-conflict') throw error;
        const found = /found (\d+)/u.exec(error instanceof Error ? error.message : '')?.[1];
        await deleteItem(itemKey, apiKey, found === undefined ? undefined : Number(found));
      }
    });
    if ((await readItemEnvelope(options, itemKey)) !== null) {
      throw new ZoteroChannelError('http-error', `永久删除未生效（回读校验失败）：${itemKey}`);
    }
  };

  const runCollectionCreate = async (operation: Extract<PlanOperation, { kind: 'collection-create' }>): Promise<string> => {
    // 与 POST /items 相同：真机要求数组体（对象体会得到 400 Uploaded data must be a JSON array）。
    const payload = [
      {
        name: operation.name,
        ...(operation.parentCollection === undefined ? {} : { parentCollection: operation.parentCollection }),
      },
    ];
    const response = await withAuth(async (apiKey) =>
      withFreshVersion((version) =>
        requestLocalApi({
          ...channelOf(options),
          path: `${LIBRARY_PREFIX}/collections`,
          method: 'POST',
          headers: {
            'Zotero-API-Key': apiKey,
            'Zotero-Server-ID': serverId,
            'Zotero-API-Version': '3',
            'If-Unmodified-Since-Version': String(version),
          },
          body: payload,
        }),
      ),
    );
    const created = extractCreatedKey(response.body);
    if (created === null) {
      throw new ZoteroChannelError('http-error', `新建集合未返回 key：${JSON.stringify(response.body).slice(0, 200)}`);
    }
    const checked = await readBackChecked(
      () => readCollection(options, created),
      (envelope) => envelope.data['name'] === operation.name,
    );
    if (!checked.ok) {
      throw new ZoteroChannelError(
        'http-error',
        checked.reason === 'missing'
          ? `新建集合回读校验失败（已重试 ${READBACK_ATTEMPTS} 次仍读不到）：${created}`
          : `新建集合回读内容与提交不符：${created}`,
      );
    }
    return created;
  };

  const runCollectionRename = async (operation: Extract<PlanOperation, { kind: 'collection-rename' }>): Promise<void> => {
    const patchName = async (apiKey: string, version: number): Promise<void> => {
      await requestLocalApi({
        ...channelOf(options),
        path: `${LIBRARY_PREFIX}/collections/${operation.key}`,
        method: 'PATCH',
        headers: {
          'Zotero-API-Key': apiKey,
          'Zotero-Server-ID': serverId,
          'Zotero-API-Version': '3',
          'If-Unmodified-Since-Version': String(version),
        },
        body: { name: operation.name },
      });
    };
    const start = await readCollection(options, operation.key);
    if (start === null) throw new Error(`集合不存在：${operation.key}`);
    await withAuth(async (apiKey) => {
      try {
        await patchName(apiKey, start.version ?? libraryVersion ?? 1);
      } catch (error) {
        const code = error instanceof ZoteroChannelError ? error.code : classifyStatus(0);
        const found = /found (\d+)/u.exec(error instanceof Error ? error.message : '')?.[1];
        if (code !== 'version-conflict' || found === undefined) throw error;
        await patchName(apiKey, Number(found));
      }
    });
    const checked = await readBackChecked(
      () => readCollection(options, operation.key),
      (envelope) => envelope.data['name'] === operation.name,
    );
    if (!checked.ok) {
      throw new ZoteroChannelError(
        'http-error',
        checked.reason === 'missing'
          ? `集合重命名回读校验失败（已重试 ${READBACK_ATTEMPTS} 次仍读不到）：${operation.key}`
          : `集合重命名回读内容与提交不符：${operation.key}`,
      );
    }
  };

  for (const operation of operations) {
    const changeFields = plan.changes.filter((change) => operation.kind === 'patch' && change.key === operation.key);
    const auditFields =
      changeFields.length > 0
        ? changeFields
        : operation.kind === 'patch'
          ? Object.entries(operation.fields).map(([field, after]) => ({ field, after }))
          : undefined;
    try {
      switch (operation.kind) {
        case 'patch': {
          const outcome = await runPatch(operation);
          results.push({ key: operation.key, status: outcome.status, version: outcome.version });
          operationResults.push({
            kind: operation.kind,
            key: operation.key,
            status: outcome.status === 'conflict-recovered' ? 'conflict-recovered' : 'applied',
          });
          if (outcome.status === 'conflict-recovered') conflictRetries += 1;
          await appendAudit({ key: operation.key, op: operation.kind, status: outcome.status, authorizeCount, fields: auditFields });
          break;
        }
        case 'create': {
          // 支持在字段里用 "@created:<n>" 引用同一计划内第 n 个已创建对象的 key
          // （典型用法：先建条目、再把它作为 linked 附件的 parentItem）
          const resolvedOperation = { ...operation, fields: resolveCreatedRefs(operation.fields, createdSequence) };
          const created = await runCreate(resolvedOperation);
          createdSequence.push(created);
          createdKeys.push(created);
          snapshot.created.push({
            key: created,
            kind: operation.kind,
            ...(operation.source === undefined ? {} : { source: operation.source }),
          });
          operationResults.push({ kind: operation.kind, key: created, status: 'applied' });
          await appendAudit({
            key: created,
            op: operation.kind,
            status: 'created',
            authorizeCount,
            itemType: operation.itemType,
            source: operation.source ?? null,
            fields: auditFields,
          });
          break;
        }
        case 'trash': {
          await runTrash(operation.key);
          operationResults.push({ kind: operation.kind, key: operation.key, status: 'applied' });
          await appendAudit({ key: operation.key, op: operation.kind, status: 'trashed', authorizeCount });
          break;
        }
        case 'delete': {
          await runDelete(operation.key);
          operationResults.push({ kind: operation.kind, key: operation.key, status: 'applied' });
          await appendAudit({ key: operation.key, op: operation.kind, status: 'deleted', authorizeCount });
          break;
        }
        case 'collection-create': {
          const created = await runCollectionCreate(operation);
          operationResults.push({ kind: operation.kind, key: created, status: 'applied' });
          await appendAudit({ key: created, op: operation.kind, status: 'collection-created', authorizeCount, name: operation.name });
          break;
        }
        case 'collection-rename': {
          await runCollectionRename(operation);
          operationResults.push({ kind: operation.kind, key: operation.key, status: 'applied' });
          await appendAudit({ key: operation.key, op: operation.kind, status: 'collection-renamed', authorizeCount, name: operation.name });
          break;
        }
        default: {
          const exhaustive: never = operation;
          throw new Error(`未知操作：${JSON.stringify(exhaustive)}`);
        }
      }
    } catch (error) {
      const failedKey =
        operation.kind === 'patch' || operation.kind === 'trash' || operation.kind === 'delete' ? operation.key : null;
      if (operation.kind === 'patch') results.push({ key: operation.key, status: 'failed', version: null });
      operationResults.push({ kind: operation.kind, key: failedKey, status: 'failed' });
      await appendAudit({
        key: failedKey,
        op: operation.kind,
        status: 'failed',
        authorizeCount,
        error: error instanceof Error ? error.message : String(error),
        // 错误码一并入审计：此前只记 message，导致「码是否准确」只能靠文案与源码推断、无法运行时直读或回放核对。
        // 非通道错误（普通 Error）显式记 null，便于区分「不是通道错误」与「字段缺失」。
        code: error instanceof ZoteroChannelError ? error.code : null,
        fields: auditFields,
      });
    }
  }

  // 快照回填：新建条目的 key 必须在快照中可查（回滚依据），审计只追加不回填。
  // 未通过回读校验的创建同样登记（source 标记为 create-unverified），失败后仍可据此清理。
  for (const entry of provisionalCreated) {
    if (!snapshot.created.some((created) => created.key === entry.key)) {
      snapshot.created.push({ key: entry.key, kind: entry.kind, source: 'create-unverified' });
    }
  }
  if (snapshot.created.length > 0) {
    await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
  }

  // 计划级汇总行：把授权次数写进审计，便于回放与核对
  await appendAudit({
    key: null,
    status: 'plan-summary',
    authorizeCount,
    // key 来自哪里（memory / file / authorize）与是否为永久授权——**只记来源，绝不记 key 本身**
    authSource,
    remembered,
    conflictRetries,
    created: createdKeys,
    submitted: results.filter((entry) => entry.status !== 'failed').map((entry) => entry.key),
    failed: operationResults.filter((entry) => entry.status === 'failed').map((entry) => entry.key),
  });

  return {
    planId: plan.id,
    authorizeCount,
    authSource,
    remembered,
    ...(authNotice === null ? {} : { authNotice }),
    submittedKeys: results.filter((entry) => entry.status !== 'failed').map((entry) => entry.key),
    conflictRetries,
    auditPath: paths.audit,
    snapshotPath,
    results,
    createdKeys,
    operations: operationResults,
    libraryVersion,
  };
}

/**
 * 按快照回滚：把受影响对象的字段写回写前值，并清理本次新建的对象，同时记录审计。
 *
 * 回填的 `created` 列表会被**永久删除**（新建条目的逆操作就是删除它自己）；
 * 字段回滚仍然逐条 PATCH + 版本前提 + 412 用真实版本重试。
 */
export async function rollbackFromSnapshot(
  snapshotPath: string,
  options: ApplyOptions = {},
): Promise<{ restored: string[]; removed: string[]; auditPath: string }> {
  if (options.write !== true) {
    throw new Error('回滚同样需要 write=true（属于写操作）');
  }
  assertWriteEnabled(options.env ?? process.env);
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
    planId: string;
    items: { key: string; version: number; data?: Record<string, unknown> }[];
    created?: { key: string }[];
  };
  const auditDir = options.auditDir ?? DEFAULT_AUDIT_DIR;
  const paths = auditPaths(auditDir);
  await mkdir(paths.dir, { recursive: true });
  const probe = await probeLocalApi(channelOf(options));
  const serverId = probe.serverId;
  // 与 applyPlan 同源的三层解析：进程内内存 → 落盘（仅 remembered） → 授权；
  // 回滚同样是写路径，必须复用同一份已授权 key，否则会平白多弹一次窗。
  const rollbackStorePath = localApiKeyStorePath(options.env ?? process.env);
  const rollbackCacheKey = ((options.baseUrl ?? '') + '|' + serverId);
  let key: string = LOCAL_API_AUTH_CACHE.get(rollbackCacheKey) ?? getRememberedKey(serverId ?? '', rollbackStorePath) ?? '';
  if (key === '') {
    const authorized = await requestAuthorize(options, serverId);
    key = authorized.key;
    LOCAL_API_AUTH_CACHE.set(rollbackCacheKey, key);
    if (authorized.remember) putRememberedKey(serverId ?? '', key, { path: rollbackStorePath });
  }
  const restored: string[] = [];
  const removed: string[] = [];

  const writeItem = async (itemKey: string, payload: Record<string, unknown>, version: number | null): Promise<void> => {
    let current = version;
    let ok = false;
    for (let attempt = 1; attempt <= 4 && !ok; attempt += 1) {
      try {
        await requestLocalApi({
          ...channelOf(options),
          path: `${LIBRARY_PREFIX}/items/${itemKey}`,
          method: 'PATCH',
          headers: {
            'Zotero-API-Key': key,
            'Zotero-Server-ID': serverId,
            'Zotero-API-Version': '3',
            'If-Unmodified-Since-Version': String(current ?? 1),
          },
          body: payload,
        });
        ok = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        const found = /found (\d+)/u.exec(message)?.[1];
        if (found !== undefined) current = Number(found);
        else if (attempt >= 2) throw error;
      }
    }
    if (!ok) throw new ZoteroChannelError('http-error', `回滚失败：${itemKey}`);
  };

  // 回滚必须与写入走同一条被真机验证过的路径：逐条 PATCH + 版本前提 + 412 用真实版本重试。
  // （批量 POST /items 会被 Zotero 判为 unchanged，不生效；这是实测结论。）
  for (const item of snapshot.items ?? []) {
    const original = item.data ?? {};
    const current = await readItemEnvelope(options, item.key);
    const extras = Object.keys(current?.data ?? {}).filter(
      (field) => !(field in original) && !STRUCTURAL_FIELDS.has(field),
    );
    // 真机实测（Zotero 10.0.3）：PATCH body 里若带 `version`，真机会**同时**按它做版本前提校验，
    // 报 `item version mismatch: expected <body.version>, found <item.version>`；此时只靠 header
    // 推进版本无法恢复（body 里的旧版本始终冲突）→ 必须把结构性字段（version / key）从 body 里去掉，
    // body 只留字段映射，版本前提一律走 `If-Unmodified-Since-Version` 头。
    const payload = { ...original, ...Object.fromEntries(extras.map((field) => [field, ''])) };
    delete payload['version'];
    delete payload['key'];
    await writeItem(item.key, payload, current?.version ?? null);
    restored.push(item.key);
    await appendFile(
      paths.audit,
      `${JSON.stringify({ ts: new Date().toISOString(), planId: snapshot.planId, channel: 'local-api', serverId, key: item.key, status: 'rolled-back' })}
`,
      'utf8',
    );
  }

  // 新建对象的回滚 = 永久删除（先确认在垃圾箱，再删除）。
  for (const created of snapshot.created ?? []) {
    const envelope = await readItemEnvelope(options, created.key);
    if (envelope === null) continue; // 已经不存在：幂等
    if (!(await isInTrash(options, envelope))) {
      await requestLocalApi({
        ...channelOf(options),
        path: `${LIBRARY_PREFIX}/items/${created.key}`,
        method: 'DELETE',
        headers: {
          'Zotero-API-Key': key,
          'Zotero-Server-ID': serverId,
          'Zotero-API-Version': '3',
          'If-Unmodified-Since-Version': String(envelope.version ?? 1),
        },
      });
    }
    const trashedEnvelope = await readItemEnvelope(options, created.key);
    if (trashedEnvelope !== null) {
      await requestLocalApi({
        ...channelOf(options),
        path: `${LIBRARY_PREFIX}/items/${created.key}`,
        method: 'DELETE',
        headers: {
          'Zotero-API-Key': key,
          'Zotero-Server-ID': serverId,
          'Zotero-API-Version': '3',
          'If-Unmodified-Since-Version': String(trashedEnvelope.version ?? 1),
        },
      });
    }
    if ((await readItemEnvelope(options, created.key)) !== null) {
      throw new ZoteroChannelError('http-error', `回滚失败（新建条目未删除）：${created.key}`);
    }
    removed.push(created.key);
    await appendFile(
      paths.audit,
      `${JSON.stringify({ ts: new Date().toISOString(), planId: snapshot.planId, channel: 'local-api', serverId, key: created.key, status: 'rolled-back-created' })}
`,
      'utf8',
    );
  }

  return { restored, removed, auditPath: paths.audit };
}
