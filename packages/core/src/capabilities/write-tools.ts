/**
 * 写 / 整理工具面（M2 change 5）：把「用户意图」编译成 `ChangePlan`。
 *
 * 约束（与 brief「约束与不变量」逐条对应）：
 * - 工具层不自行发写请求：所有提交都交给 `applyPlan`（默认只读、一次授权、写前快照、
 *   逐条写入、写后回读校验、审计 JSONL）；
 * - 范围白名单：每个操作只作用于显式传入的 keys / 集合 key，禁止全库批量；
 * - 破坏性操作（永久删除、标签重命名、覆盖已有值）必须携带 confirm 关键字；
 * - 标识符导入只支持 `mode=identifier`（DOI / ISBN / PMID），解析失败给出可读原因且不写库。
 */

import { existsSync } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';

import { toPosixPath } from '../paths.ts';
import { LIBRARY_PREFIX, fetchAnnotationChildren, getItems, toAnnotationDetail } from './read.ts';
import {
  DELETE_KEYWORD,
  buildChangePlan,
  makeChangePlan,
  readItemEnvelope,
  readTrashKeySet,
} from './write-pipeline.ts';
import { requestLocalApi } from '../channels/local-api.ts';
import { requestTranslationItems } from '../channels/translation-server.ts';
import { DEFAULT_TRANSLATION_SERVER_URL } from '../channels/translation-server.ts';
import type { AnnotationDetail, ChannelOptions, ItemEnvelope } from './read.ts';
import type { ChangePlan, FieldChange, PlanOperation, UpdateIntent } from './write-pipeline.ts';

/** 写工具公开名单（工具面 11–18）。 */
export const WRITE_TOOL_NAMES = [
  'zotero_create_item',
  'zotero_update_item',
  'zotero_delete_items',
  'zotero_manage_collections',
  'zotero_manage_tags',
  'zotero_attach_file',
  'zotero_add_note',
  'zotero_add_items',
] as const;

/** 创建时不允许出现在 fields 里的结构性字段（由 Zotero 维护）。 */
const READONLY_FIELDS = new Set(['key', 'version', 'dateAdded', 'dateModified']);

function channelOf(options: ChannelOptions): ChannelOptions {
  return {
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs,
  };
}

function uniqueKeys(keys: readonly string[] | undefined, what: string): string[] {
  const cleaned = [...new Set((keys ?? []).map((key) => key.trim()).filter((key) => key.length > 0))];
  if (cleaned.length === 0) throw new Error(`${what}不能为空（写工具按显式 key 白名单工作，禁止全库批量）`);
  return cleaned;
}

function sanitizeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields ?? {})) {
    if (READONLY_FIELDS.has(field)) continue;
    out[field] = value;
  }
  return out;
}

function tagsOf(envelope: ItemEnvelope): string[] {
  const tags = envelope.data['tags'];
  if (!Array.isArray(tags)) return [];
  return tags
    .map((tag) => (typeof tag === 'string' ? tag : (tag as { tag?: unknown } | null)?.tag))
    .filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
}

function asTagPayload(tags: string[]): { tag: string }[] {
  return tags.map((tag) => ({ tag }));
}

function collectionsOf(envelope: ItemEnvelope): string[] {
  const collections = envelope.data['collections'];
  return Array.isArray(collections) ? collections.filter((key): key is string => typeof key === 'string') : [];
}

async function requireEnvelopes(options: ChannelOptions, keys: string[]): Promise<Map<string, ItemEnvelope>> {
  const found = new Map<string, ItemEnvelope>();
  for (const key of keys) {
    const envelope = await readItemEnvelope(channelOf(options), key);
    if (envelope === null) throw new Error(`条目不存在或不可读写：${key}`);
    found.set(key, envelope);
  }
  return found;
}

/** 条目是否已在垃圾箱：`data.deleted` 与 `/items/trash` 两路信号取或。 */
async function isTrashed(options: ChannelOptions, envelope: ItemEnvelope, trashKeys: Set<string> | null): Promise<boolean> {
  const deleted = envelope.data['deleted'];
  if (deleted === 1 || deleted === true || deleted === '1') return true;
  return trashKeys !== null && trashKeys.has(envelope.key);
}

function patchChange(key: string, field: string, before: unknown, after: unknown): FieldChange {
  return { key, field, before, after };
}

// ── 工具 11：新建条目 ────────────────────────────────────────────────────

export interface CreatorInput {
  creatorType?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface CreateItemOptions {
  itemType: string;
  fields?: Record<string, unknown>;
  creators?: CreatorInput[];
  collections?: string[];
  now?: () => Date;
}

function normalizeCreator(creator: CreatorInput): Record<string, unknown> {
  const out: Record<string, unknown> = { creatorType: creator.creatorType ?? 'author' };
  if (typeof creator.name === 'string' && creator.name.length > 0) out['name'] = creator.name;
  if (typeof creator.firstName === 'string') out['firstName'] = creator.firstName;
  if (typeof creator.lastName === 'string') out['lastName'] = creator.lastName;
  return out;
}

/** 新建条目：纯计划构造（不读库），提交由写管线负责。 */
export function buildCreateItemPlan(options: CreateItemOptions): ChangePlan {
  const itemType = options.itemType.trim();
  if (itemType.length === 0) throw new Error('itemType 不能为空');
  const fields = sanitizeFields(options.fields);
  if (options.creators !== undefined && options.creators.length > 0) {
    fields['creators'] = options.creators.map(normalizeCreator);
  }
  if (options.collections !== undefined && options.collections.length > 0) {
    fields['collections'] = [...new Set(options.collections)];
  }
  const typeField = fields['itemType'];
  if (typeof typeField === 'string' && typeField !== itemType) {
    throw new Error(`fields.itemType（${typeField}）与 itemType（${itemType}）冲突`);
  }
  const fieldNames = Object.keys(fields);
  return makeChangePlan({
    targetKeys: [],
    changes: [],
    operations: [{ kind: 'create', itemType, fields }],
    summary: `新建 1 条 ${itemType}（${fieldNames.length} 个字段：${fieldNames.slice(0, 8).join(', ') || '无'}）`,
    destructive: false,
    confirmKeyword: null,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

// ── 工具 12：更新条目 ────────────────────────────────────────────────────

export interface UpdateItemOptions extends ChannelOptions {
  updates?: UpdateIntent[];
  /** 便捷形式：把同一组字段应用到多个 key。 */
  keys?: string[];
  fields?: Record<string, unknown>;
  now?: () => Date;
}

/** 更新条目：复用 change 4 的计划构造（逐字段 before → after diff），再补上 operations。 */
export async function buildUpdateItemPlan(options: UpdateItemOptions): Promise<ChangePlan> {
  let updates = options.updates ?? [];
  if (updates.length === 0) {
    const keys = uniqueKeys(options.keys, 'keys');
    const fields = sanitizeFields(options.fields);
    if (Object.keys(fields).length === 0) throw new Error('必须提供 updates，或提供 keys + fields');
    updates = keys.flatMap((key) => Object.entries(fields).map(([field, value]) => ({ key, field, value })));
  }
  const plan = await buildChangePlan({
    ...channelOf(options),
    updates,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const byKey = new Map<string, Record<string, unknown>>();
  for (const change of plan.changes) {
    byKey.set(change.key, { ...(byKey.get(change.key) ?? {}), [change.field]: change.after });
  }
  return {
    ...plan,
    operations: [...byKey].map(([key, fields]) => ({ kind: 'patch' as const, key, fields })),
  };
}

// ── 工具 13：删除（默认进垃圾箱） ────────────────────────────────────────

export interface DeleteItemsOptions extends ChannelOptions {
  keys: string[];
  permanent?: boolean;
  now?: () => Date;
}

/**
 * 删除计划：默认只移入垃圾箱；`permanent=true` 时先确认在垃圾箱再彻底删除
 *（真机语义：对垃圾箱中的条目再次 DELETE 才是永久删除）。
 */
export async function buildDeleteItemsPlan(options: DeleteItemsOptions): Promise<ChangePlan> {
  const keys = uniqueKeys(options.keys, 'keys');
  const permanent = options.permanent === true;
  const envelopes = await requireEnvelopes(options, keys);
  const trashKeys = permanent ? await readTrashKeySet(channelOf(options)) : null;
  const operations: PlanOperation[] = [];
  for (const key of keys) {
    const envelope = envelopes.get(key) as ItemEnvelope;
    if (permanent) {
      if (!(await isTrashed(options, envelope, trashKeys))) operations.push({ kind: 'trash', key });
      operations.push({ kind: 'delete', key });
    } else {
      operations.push({ kind: 'trash', key });
    }
  }
  return makeChangePlan({
    targetKeys: keys,
    changes: [],
    operations,
    summary: permanent
      ? `永久删除 ${keys.length} 条条目（先移入垃圾箱再彻底删除，需 confirm="${DELETE_KEYWORD}"）`
      : `把 ${keys.length} 条条目移入垃圾箱（可从垃圾箱恢复）`,
    destructive: permanent,
    confirmKeyword: permanent ? DELETE_KEYWORD : null,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

// ── 工具 14：集合管理 ────────────────────────────────────────────────────

export const COLLECTION_ACTIONS = ['create', 'rename', 'addItems', 'removeItems'] as const;
export type CollectionAction = (typeof COLLECTION_ACTIONS)[number];

export interface ManageCollectionsOptions extends ChannelOptions {
  action: CollectionAction;
  name?: string;
  collectionKey?: string;
  parentCollection?: string;
  keys?: string[];
  now?: () => Date;
}

async function readCollectionEnvelope(options: ChannelOptions, key: string): Promise<ItemEnvelope> {
  const response = await requestLocalApi({ ...channelOf(options), path: `${LIBRARY_PREFIX}/collections/${key}` });
  const body = response.body as ItemEnvelope | null;
  if (body === null || typeof body !== 'object') throw new Error(`集合不存在：${key}`);
  return body;
}

/** 集合整理：create / rename / addItems / removeItems（成员关系是条目的 collections 数组）。 */
export async function buildManageCollectionsPlan(options: ManageCollectionsOptions): Promise<ChangePlan> {
  const now = options.now;
  switch (options.action) {
    case 'create': {
      const name = options.name?.trim() ?? '';
      if (name.length === 0) throw new Error('action=create 必须提供 name');
      const parent = options.parentCollection?.trim();
      return makeChangePlan({
        targetKeys: [],
        changes: [],
        operations: [{ kind: 'collection-create', name, ...(parent === undefined || parent.length === 0 ? {} : { parentCollection: parent }) }],
        summary: `新建集合「${name}」`,
        destructive: false,
        confirmKeyword: null,
        ...(now === undefined ? {} : { now }),
      });
    }
    case 'rename': {
      const key = options.collectionKey?.trim() ?? '';
      const name = options.name?.trim() ?? '';
      if (key.length === 0) throw new Error('action=rename 必须提供 collectionKey');
      if (name.length === 0) throw new Error('action=rename 必须提供 name');
      await readCollectionEnvelope(options, key);
      return makeChangePlan({
        targetKeys: [],
        changes: [],
        operations: [{ kind: 'collection-rename', key, name }],
        summary: `集合 ${key} 重命名为「${name}」`,
        destructive: false,
        confirmKeyword: null,
        ...(now === undefined ? {} : { now }),
      });
    }
    case 'addItems':
    case 'removeItems': {
      const collectionKey = options.collectionKey?.trim() ?? '';
      if (collectionKey.length === 0) throw new Error(`action=${options.action} 必须提供 collectionKey`);
      const keys = uniqueKeys(options.keys, 'keys');
      await readCollectionEnvelope(options, collectionKey);
      const envelopes = await requireEnvelopes(options, keys);
      const operations: PlanOperation[] = [];
      const changes: FieldChange[] = [];
      for (const key of keys) {
        const envelope = envelopes.get(key) as ItemEnvelope;
        const before = collectionsOf(envelope);
        const after =
          options.action === 'addItems'
            ? [...new Set([...before, collectionKey])]
            : before.filter((entry) => entry !== collectionKey);
        if (JSON.stringify(before) === JSON.stringify(after)) continue;
        operations.push({ kind: 'patch', key, fields: { collections: after } });
        changes.push(patchChange(key, 'collections', before, after));
      }
      return makeChangePlan({
        targetKeys: keys,
        changes,
        operations,
        summary:
          options.action === 'addItems'
            ? `把 ${operations.length} 条条目加入集合 ${collectionKey}`
            : `把 ${operations.length} 条条目移出集合 ${collectionKey}`,
        destructive: false,
        confirmKeyword: null,
        ...(now === undefined ? {} : { now }),
      });
    }
    default: {
      const exhaustive: never = options.action;
      throw new Error(`非法 action：${String(exhaustive)}（可选 ${COLLECTION_ACTIONS.join(' / ')}）`);
    }
  }
}

// ── 工具 15：标签管理 ────────────────────────────────────────────────────

export const TAG_ACTIONS = ['add', 'remove', 'rename'] as const;
export type TagAction = (typeof TAG_ACTIONS)[number];

export interface ManageTagsOptions extends ChannelOptions {
  action: TagAction;
  tags?: string[];
  keys?: string[];
  from?: string;
  to?: string;
  now?: () => Date;
}

async function itemsWithTag(options: ChannelOptions, tag: string): Promise<ItemEnvelope[]> {
  const response = await requestLocalApi({
    ...channelOf(options),
    path: `${LIBRARY_PREFIX}/items/top?tag=${encodeURIComponent(tag)}&limit=100`,
  });
  return Array.isArray(response.body) ? (response.body as ItemEnvelope[]) : [];
}

/** 标签整理：add / remove / rename（标签是条目 tags 数组的属性；重命名属于破坏性操作）。 */
export async function buildManageTagsPlan(options: ManageTagsOptions): Promise<ChangePlan> {
  const now = options.now;
  const tags = [...new Set((options.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0))];
  const scopedKeys = options.keys === undefined ? undefined : uniqueKeys(options.keys, 'keys');
  if (options.action === 'add' || options.action === 'remove') {
    if (tags.length === 0) throw new Error(`action=${options.action} 必须提供 tags`);
    const keys = uniqueKeys(scopedKeys, 'keys');
    const envelopes = await requireEnvelopes(options, keys);
    const operations: PlanOperation[] = [];
    const changes: FieldChange[] = [];
    for (const key of keys) {
      const envelope = envelopes.get(key) as ItemEnvelope;
      const before = tagsOf(envelope);
      const after =
        options.action === 'add'
          ? [...new Set([...before, ...tags])]
          : before.filter((tag) => !tags.includes(tag));
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      operations.push({ kind: 'patch', key, fields: { tags: asTagPayload(after) } });
      changes.push(patchChange(key, 'tags', before, after));
    }
    return makeChangePlan({
      targetKeys: keys,
      changes,
      operations,
      summary:
        options.action === 'add'
          ? `为 ${operations.length} 条条目添加标签 ${tags.join(', ')}`
          : `从 ${operations.length} 条条目移除标签 ${tags.join(', ')}`,
      destructive: false,
      confirmKeyword: null,
      ...(now === undefined ? {} : { now }),
    });
  }

  // rename：范围 = 显式 keys（若有）∩ 实际使用该标签的条目
  const from = options.from?.trim() ?? '';
  const to = options.to?.trim() ?? '';
  if (from.length === 0 || to.length === 0) throw new Error('action=rename 必须提供 from 与 to');
  const holders = await itemsWithTag(options, from);
  const allowed = scopedKeys === undefined ? null : new Set(scopedKeys);
  const targets = holders.filter((envelope) => allowed === null || allowed.has(envelope.key));
  if (targets.length === 0) {
    throw new Error(`没有任何条目使用标签「${from}」${allowed === null ? '' : '（在当前 keys 范围内）'}，无需重命名`);
  }
  const operations: PlanOperation[] = [];
  const changes: FieldChange[] = [];
  for (const envelope of targets) {
    const before = tagsOf(envelope);
    const after = [...new Set(before.map((tag) => (tag === from ? to : tag)))];
    operations.push({ kind: 'patch', key: envelope.key, fields: { tags: asTagPayload(after) } });
    changes.push(patchChange(envelope.key, 'tags', before, after));
  }
  return makeChangePlan({
    targetKeys: targets.map((envelope) => envelope.key),
    changes,
    operations,
    summary: `把标签「${from}」重命名为「${to}」，涉及 ${operations.length} 条条目（需确认）`,
    destructive: true,
    ...(now === undefined ? {} : { now }),
  });
}

// ── 工具 16：附件（linked / 复用已有附件） ───────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.epub': 'application/epub+zip',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.djvu': 'image/vnd.djvu',
};

export function contentTypeForPath(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export interface AttachFileOptions extends ChannelOptions {
  parentKey: string;
  mode?: 'linked';
  path: string;
  title?: string;
  /** 复用已有附件（同路径）：默认开启，命中时不再新建。 */
  reuseExisting?: boolean;
  now?: () => Date;
}

export interface AttachFilePlanResult {
  plan: ChangePlan | null;
  reused: { key: string; title: string | null; path: string } | null;
}

/** 附件挂载：本轮只支持 linked 附件；同路径已存在时直接复用（不重复建附件）。 */
export async function buildAttachFilePlan(options: AttachFileOptions): Promise<AttachFilePlanResult> {
  const parentKey = options.parentKey?.trim() ?? '';
  if (parentKey.length === 0) throw new Error('parentKey 不能为空');
  if (options.mode !== undefined && options.mode !== 'linked') {
    throw new Error(`本轮只支持 mode=linked（附件文件字节上传属后续 change），收到：${options.mode}`);
  }
  const path = options.path?.trim() ?? '';
  if (path.length === 0) throw new Error('path 不能为空');
  if (!isAbsolute(path)) throw new Error(`linked 附件必须使用绝对路径：${path}`);
  if (!existsSync(path)) throw new Error(`文件不存在或不可读：${path}`);

  await requireEnvelopes(options, [parentKey]);
  const childrenResponse = await requestLocalApi({
    ...channelOf(options),
    path: `${LIBRARY_PREFIX}/items/${parentKey}/children?limit=100`,
  });
  const children = Array.isArray(childrenResponse.body) ? (childrenResponse.body as ItemEnvelope[]) : [];
  const wanted = toPosixPath(path).toLowerCase();
  const existing = children.find((child) => {
    if (child.data['itemType'] !== 'attachment') return false;
    const childPath = child.data['path'];
    return typeof childPath === 'string' && toPosixPath(childPath).toLowerCase() === wanted;
  });
  if (existing !== undefined && options.reuseExisting !== false) {
    const title = existing.data['title'];
    return {
      plan: null,
      reused: { key: existing.key, title: typeof title === 'string' ? title : null, path },
    };
  }

  const fields: Record<string, unknown> = {
    linkMode: 'linked_file',
    path: toPosixPath(path),
    title: options.title?.trim() || basename(path),
    contentType: contentTypeForPath(path),
    parentItem: parentKey,
  };
  const plan = makeChangePlan({
    targetKeys: [],
    changes: [],
    operations: [{ kind: 'create', itemType: 'attachment', fields }],
    summary: `在条目 ${parentKey} 下挂载 linked 附件 ${basename(path)}`,
    destructive: false,
    confirmKeyword: null,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { plan, reused: null };
}

// ── 工具 17：笔记 ────────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

/** 纯文本包成 <p>；看起来已经是 HTML 的内容原样保留（Zotero 笔记是 HTML 片段）。 */
export function normalizeNoteHtml(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length === 0) throw new Error('笔记内容不能为空');
  if (/<[a-z][\s\S]*>/iu.test(trimmed)) return trimmed;
  return `<p>${escapeHtml(trimmed).replaceAll('\n', '<br/>')}</p>`;
}

export interface AddNoteOptions extends ChannelOptions {
  parentKey?: string;
  /** 更新既有笔记时传入；缺省表示在 parentKey 下新建笔记。 */
  noteKey?: string;
  /** 未开 `fromAnnotations` 时必填：笔记内容（HTML 片段或纯文本）。 */
  content?: string;
  /** 由目标的注释拼出结构化 note（含 `zotero://open-pdf` 深链接）；只用于新建笔记。 */
  fromAnnotations?: boolean;
  now?: () => Date;
}

export interface AddNotePlanResult {
  plan: ChangePlan;
  mode: 'create' | 'update' | 'from-annotations';
  targetKey: string | null;
  /** `from-annotations` 模式下实际写入 note 的深链接（调用方据此核对条数）。 */
  deepLinks?: string[];
}

/** `fromAnnotations` 模式下注释放不进 note 时的可读原因。 */
function annotationsNoteReason(target: string, detail: string): string {
  return `${detail}（目标 ${target}，fromAnnotations=true）`;
}

/**
 * 把注释按页码排序：`annotationPosition.pageIndex` 升序（0-based，与 Zotero 内部口径一致），
 * 缺页码或不可解析的排在最后，同页码内保持读层返回顺序（稳定排序）。
 */
function sortAnnotations(annotations: AnnotationDetail[]): AnnotationDetail[] {
  const pageIndexOf = (annotation: AnnotationDetail): number | null => {
    const position = annotation.position;
    if (position !== null && typeof position === 'object' && !Array.isArray(position)) {
      const pageIndex = (position as Record<string, unknown>)['pageIndex'];
      if (typeof pageIndex === 'number' && Number.isFinite(pageIndex)) return pageIndex;
    }
    if (typeof position === 'string' && position.length > 0) {
      try {
        const parsed = JSON.parse(position) as Record<string, unknown>;
        const pageIndex = parsed['pageIndex'];
        if (typeof pageIndex === 'number' && Number.isFinite(pageIndex)) return pageIndex;
      } catch {
        return null;
      }
    }
    return null;
  };
  return annotations
    .map((annotation, index) => ({ annotation, index, pageIndex: pageIndexOf(annotation) }))
    .sort((left, right) => {
      const leftKey = left.pageIndex ?? Number.POSITIVE_INFINITY;
      const rightKey = right.pageIndex ?? Number.POSITIVE_INFINITY;
      if (leftKey !== rightKey) return leftKey - rightKey;
      return left.index - right.index;
    })
    .map((entry) => entry.annotation);
}

/**
 * 读目标的注释，覆盖两种形态：
 *   1. 目标是父条目：走既有 `getItems(include=annotations)`（它已收集 PDF 附件下的注释）；
 *   2. 目标自身就是 PDF 附件：注释是它的直接子项，`include=annotations` 不覆盖这一形态，
 *      因此补一次子项读取并只保留 `itemType=annotation`。
 * 两路结果按注释 key 去重。
 */
export async function collectTargetAnnotations(
  options: ChannelOptions,
  targetKey: string,
): Promise<AnnotationDetail[]> {
  const [detail] = await getItems({ ...channelOf(options), keys: [targetKey], include: ['annotations'] });
  if (detail === undefined) throw new Error(`条目不存在：${targetKey}`);
  const collected = [...detail.annotations];
  const seen = new Set(collected.map((annotation) => annotation.key));
  // 目标自身就是附件时，注释是它的直接子项——必须带 itemType=annotation 过滤（真机不带过滤不返回注释）
  for (const child of await fetchAnnotationChildren(targetKey, channelOf(options))) {
    if (child.data['itemType'] !== 'annotation') continue;
    if (seen.has(child.key)) continue;
    seen.add(child.key);
    collected.push(toAnnotationDetail(child, targetKey));
  }
  return sortAnnotations(collected);
}

/** 把注释拼成结构化 note：每条注释一个段落，段落内恰好一个深链接。 */
export function renderAnnotationsNote(annotations: AnnotationDetail[]): string {
  const parts: string[] = [`<h1>注释清单（${annotations.length} 条）</h1>`];
  for (const annotation of annotations) {
    const type = annotation.annotationType ?? 'annotation';
    const page = annotation.pageLabel === null || annotation.pageLabel.length === 0 ? '无页码' : `第 ${annotation.pageLabel} 页`;
    const linkText = `${page} · ${type}`;
    // href 里的深链接保持原样（只挡掉可能打断属性的双引号）：`&` 被转义成 `&amp;` 会让复制出来的
    // 链接失效，也会与读层 deepLink 不再是逐字一致；参数值本身已由 URLSearchParams 百分号编码。
    const href = annotation.deepLink.replaceAll('"', '&quot;');
    const segments: string[] = [`<a href="${href}">${escapeHtml(linkText)}</a>`];
    if (annotation.text !== null && annotation.text.length > 0) segments.push(`「${escapeHtml(annotation.text)}」`);
    if (annotation.comment !== null && annotation.comment.length > 0) segments.push(`批注：${escapeHtml(annotation.comment)}`);
    if (annotation.color !== null && annotation.color.length > 0) segments.push(`颜色：${escapeHtml(annotation.color)}`);
    parts.push(`<p>${segments.join(' ')}</p>`);
  }
  return parts.join('');
}

/** 笔记：在父条目下新建、更新既有笔记，或由注释拼出结构化 note。 */
export async function buildAddNotePlan(options: AddNoteOptions): Promise<AddNotePlanResult> {
  if (options.fromAnnotations === true) {
    const parentKey = options.parentKey?.trim() ?? '';
    if (parentKey.length === 0) {
      throw new Error('fromAnnotations=true 时必须提供 parentKey（注释挂在目标条目下）');
    }
    if (options.content !== undefined) {
      throw new Error('fromAnnotations=true 与 content 互斥：请只给其中之一');
    }
    const noteKey = options.noteKey?.trim();
    if (noteKey !== undefined && noteKey.length > 0) {
      throw new Error('fromAnnotations=true 只用于新建笔记；更新既有笔记请用 noteKey + content');
    }
    const annotations = await collectTargetAnnotations(channelOf(options), parentKey);
    if (annotations.length === 0) {
      throw new Error(annotationsNoteReason(parentKey, '目标下没有任何注释，未写入 note'));
    }
    const plan = makeChangePlan({
      targetKeys: [],
      changes: [],
      operations: [
        { kind: 'create', itemType: 'note', fields: { note: renderAnnotationsNote(annotations), parentItem: parentKey } },
      ],
      summary: `在条目 ${parentKey} 下由 ${annotations.length} 条注释新建 note`,
      destructive: false,
      confirmKeyword: null,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return { plan, mode: 'from-annotations', targetKey: null, deepLinks: annotations.map((annotation) => annotation.deepLink) };
  }

  if (options.content === undefined) {
    throw new Error('缺少 content：新建或更新笔记必须提供 content（由注释生成时请用 fromAnnotations=true）');
  }
  const note = normalizeNoteHtml(options.content);
  const noteKey = options.noteKey?.trim();
  if (noteKey !== undefined && noteKey.length > 0) {
    const envelope = await readItemEnvelope(channelOf(options), noteKey);
    if (envelope === null) throw new Error(`笔记不存在：${noteKey}`);
    if (envelope.data['itemType'] !== 'note') throw new Error(`目标不是笔记条目：${noteKey}`);
    const before = envelope.data['note'] ?? null;
    const plan = makeChangePlan({
      targetKeys: [noteKey],
      changes: [patchChange(noteKey, 'note', before, note)],
      operations: [{ kind: 'patch', key: noteKey, fields: { note } }],
      summary: `更新笔记 ${noteKey}`,
      destructive: false,
      confirmKeyword: null,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    return { plan, mode: 'update', targetKey: noteKey };
  }

  const parentKey = options.parentKey?.trim() ?? '';
  if (parentKey.length === 0) throw new Error('新建笔记必须提供 parentKey（更新既有笔记时用 noteKey）');
  await requireEnvelopes(options, [parentKey]);
  const plan = makeChangePlan({
    targetKeys: [],
    changes: [],
    operations: [{ kind: 'create', itemType: 'note', fields: { note, parentItem: parentKey } }],
    summary: `在条目 ${parentKey} 下新建笔记`,
    destructive: false,
    confirmKeyword: null,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { plan, mode: 'create', targetKey: null };
}

// ── 工具 18：按标识符导入（DOI / ISBN / PMID） ───────────────────────────

export type IdentifierKind = 'doi' | 'isbn' | 'pmid';
export type IdentifierSource = 'translation-server' | 'crossref' | 'openlibrary' | 'pubmed';

export interface ResolvedRecord {
  itemType: string;
  fields: Record<string, unknown>;
}

export interface IdentifierResolution {
  identifier: string;
  kind: IdentifierKind;
  source: IdentifierSource;
  records: ResolvedRecord[];
  /** 解析过程中被尝试过的通道与失败原因（成功通道之前的失败也保留，便于排查）。 */
  attempts: { source: IdentifierSource; ok: boolean; reason: string | null }[];
}

/** @deprecated 使用 channels/translation-server.ts 的 DEFAULT_TRANSLATION_SERVER_URL；这里保留兼容别名。 */
export const DEFAULT_TRANSLATION_SERVER = DEFAULT_TRANSLATION_SERVER_URL;
export const DEFAULT_CROSSREF_MAILTO = 'zotero-mcp@localhost';

/** 归一化并推断标识符类型；无法识别时给出可读原因。 */
export function detectIdentifierKind(identifier: string, hint: 'auto' | IdentifierKind = 'auto'): IdentifierKind {
  const raw = identifier.trim();
  if (raw.length === 0) throw new Error('identifier 不能为空');
  if (hint !== 'auto') return hint;
  const lower = raw.toLowerCase();
  if (lower.startsWith('pmid:') || lower.startsWith('pmid ')) return 'pmid';
  if (lower.startsWith('isbn:') || lower.startsWith('isbn ')) return 'isbn';
  if (lower.startsWith('doi:') || lower.includes('doi.org/')) return 'doi';
  if (/^10\.\d{4,9}\/\S+$/u.test(raw)) return 'doi';
  if (/^\d{1,8}$/u.test(raw)) return 'pmid';
  const isbn = raw.replaceAll(/[-\s]/gu, '');
  if (/^\d{9}[\dxX]$/u.test(isbn) || /^\d{13}$/u.test(isbn)) return 'isbn';
  throw new Error(`无法识别的标识符：${raw}（支持 DOI / ISBN / PMID，或用 identifierType 显式指定）`);
}

/** 归一化标识符本体（去掉 doi: / URL 前缀，ISBN 去掉连字符）。 */
export function normalizeIdentifier(identifier: string, kind: IdentifierKind): string {
  const raw = identifier.trim();
  if (kind === 'doi') {
    return raw
      .replace(/^doi:\s*/iu, '')
      .replace(/^https?:\/\/(dx\.)?doi\.org\//iu, '')
      .trim();
  }
  if (kind === 'isbn') {
    return raw.replace(/^isbn[:\s]*/iu, '').replaceAll(/[-\s]/gu, '');
  }
  return raw.replace(/^pmid[:\s]*/iu, '').trim();
}

function stripJats(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.replaceAll(/<[^>]+>/gu, ' ').replaceAll(/\s+/gu, ' ').trim();
}

function dateFromParts(parts: unknown): string | null {
  if (!Array.isArray(parts) || !Array.isArray(parts[0])) return null;
  const [year, month, day] = parts[0] as (number | undefined)[];
  if (typeof year !== 'number') return null;
  const pad = (value: number | undefined): string => (typeof value === 'number' ? String(value).padStart(2, '0') : '');
  return [String(year), pad(month), pad(day)].filter((part) => part.length > 0).join('-');
}

function creatorsFromCrossref(authors: unknown): Record<string, unknown>[] {
  if (!Array.isArray(authors)) return [];
  const out: Record<string, unknown>[] = [];
  for (const author of authors) {
    const record = (author ?? {}) as Record<string, unknown>;
    const family = typeof record['family'] === 'string' ? record['family'] : undefined;
    const given = typeof record['given'] === 'string' ? record['given'] : undefined;
    const literal = typeof record['name'] === 'string' ? record['name'] : undefined;
    if (family === undefined && literal === undefined) continue;
    out.push({
      creatorType: 'author',
      ...(literal === undefined ? {} : { name: literal }),
      ...(family === undefined ? {} : { lastName: family }),
      ...(given === undefined ? {} : { firstName: given }),
    });
  }
  return out;
}

/** Crossref `message` → Zotero journalArticle（纯函数，离线可测）。 */
export function mapCrossrefWork(message: unknown): ResolvedRecord {
  const record = (message ?? {}) as Record<string, unknown>;
  const title = Array.isArray(record['title']) ? record['title'][0] : record['title'];
  const container = Array.isArray(record['container-title']) ? record['container-title'][0] : record['container-title'];
  const issn = Array.isArray(record['ISSN']) ? record['ISSN'][0] : record['ISSN'];
  const fields: Record<string, unknown> = {
    title: typeof title === 'string' ? title : '',
    DOI: typeof record['DOI'] === 'string' ? record['DOI'] : '',
  };
  const date = dateFromParts((record['issued'] as Record<string, unknown> | undefined)?.['date-parts']);
  if (date !== null) fields['date'] = date;
  if (typeof container === 'string') fields['publicationTitle'] = container;
  for (const [source, target] of [
    ['volume', 'volume'],
    ['issue', 'issue'],
    ['page', 'pages'],
    ['publisher', 'publisher'],
    ['language', 'language'],
    ['URL', 'url'],
  ] as const) {
    const value = record[source];
    if (typeof value === 'string' && value.length > 0) fields[target] = value;
  }
  if (typeof issn === 'string') fields['ISSN'] = issn;
  const abstract = stripJats(record['abstract']);
  if (abstract !== null && abstract.length > 0) fields['abstractNote'] = abstract;
  const creators = creatorsFromCrossref(record['author']);
  if (creators.length > 0) fields['creators'] = creators;
  return { itemType: 'journalArticle', fields };
}

/** OpenLibrary ISBN 记录 → Zotero book（纯函数，离线可测）。 */
export function mapOpenLibraryBook(book: unknown, authorNames: string[] = []): ResolvedRecord {
  const record = (book ?? {}) as Record<string, unknown>;
  const fields: Record<string, unknown> = {
    title: typeof record['title'] === 'string' ? record['title'] : '',
    ISBN: typeof record['isbn_13'] === 'string' ? record['isbn_13'] : typeof record['isbn_10'] === 'string' ? record['isbn_10'] : '',
  };
  if (typeof record['publish_date'] === 'string') fields['date'] = record['publish_date'];
  const publishers = record['publishers'];
  if (Array.isArray(publishers) && typeof publishers[0] === 'string') fields['publisher'] = publishers[0];
  if (typeof record['number_of_pages'] === 'number') fields['numPages'] = String(record['number_of_pages']);
  if (Array.isArray(record['subjects']) && typeof record['subjects'][0] === 'string') {
    fields['tags'] = (record['subjects'] as string[]).slice(0, 8).map((tag) => ({ tag }));
  }
  const creators = authorNames
    .filter((name) => name.length > 0)
    .map((name) => {
      const parts = name.trim().split(/\s+/u);
      const lastName = parts.length > 1 ? parts[parts.length - 1] : name;
      const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
      return { creatorType: 'author', lastName, firstName };
    });
  if (creators.length > 0) fields['creators'] = creators;
  return { itemType: 'book', fields };
}

/** PubMed esummary → Zotero journalArticle（纯函数，离线可测）。 */
export function mapPubmedSummary(summary: unknown): ResolvedRecord {
  const record = (summary ?? {}) as Record<string, unknown>;
  const fields: Record<string, unknown> = {
    title: typeof record['title'] === 'string' ? record['title'].replaceAll(/\s+/gu, ' ').trim() : '',
  };
  if (typeof record['source'] === 'string') fields['publicationTitle'] = record['source'];
  if (typeof record['pubdate'] === 'string') fields['date'] = record['pubdate'];
  if (typeof record['volume'] === 'string') fields['volume'] = record['volume'];
  if (typeof record['issue'] === 'string') fields['issue'] = record['issue'];
  if (typeof record['pages'] === 'string') fields['pages'] = record['pages'];
  const articleIds = record['articleids'];
  if (Array.isArray(articleIds)) {
    const doi = articleIds.find((entry) => (entry as Record<string, unknown>)['idtype'] === 'doi');
    const value = doi === undefined ? undefined : (doi as Record<string, unknown>)['value'];
    if (typeof value === 'string') fields['DOI'] = value;
  }
  const authors = record['authors'];
  if (Array.isArray(authors)) {
    const creators = authors
      .map((author) => (typeof (author as Record<string, unknown>)['name'] === 'string' ? String((author as Record<string, unknown>)['name']) : null))
      .filter((name): name is string => name !== null)
      .map((name) => {
        const parts = name.trim().split(/\s+/u);
        const lastName = parts.length > 1 ? parts[parts.length - 1] : name;
        const firstName = parts.length > 1 ? parts.slice(0, -1).join(' ') : '';
        return { creatorType: 'author', lastName, firstName };
      });
    if (creators.length > 0) fields['creators'] = creators;
  }
  return { itemType: 'journalArticle', fields };
}

export interface ResolveIdentifierOptions {
  identifier: string;
  identifierType?: 'auto' | IdentifierKind;
  translationServerUrl?: string;
  /** 远程 translation-server 的令牌（缺省读 ZOTERO_MCP_TRANSLATION_TOKEN）；不会出现在结果里。 */
  translationToken?: string;
  mailto?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function timeoutFetch(fetchImpl: typeof fetch, timeoutMs: number): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

async function tryTranslationServer(
  options: ResolveIdentifierOptions,
  identifier: string,
): Promise<ResolvedRecord[]> {
  // 端点/令牌/超时的解析与错误分类统一由 channels/translation-server.ts 负责
  const { items } = await requestTranslationItems({
    ...(options.translationServerUrl === undefined ? {} : { baseUrl: options.translationServerUrl }),
    ...(options.translationToken === undefined ? {} : { token: options.translationToken }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    body: identifier,
    path: '/search',
  });
  return items.map((entry) => {
    const { itemType, ...rest } = entry;
    return {
      itemType: typeof itemType === 'string' ? itemType : 'document',
      fields: sanitizeFields(rest),
    };
  });
}

async function tryCrossref(options: ResolveIdentifierOptions, doi: string): Promise<ResolvedRecord[]> {
  const mailto = options.mailto ?? process.env['ZOTERO_MCP_CROSSREF_MAILTO'] ?? DEFAULT_CROSSREF_MAILTO;
  const fetchImpl = timeoutFetch(options.fetchImpl ?? fetch, options.timeoutMs ?? 15_000);
  const response = await fetchImpl(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${encodeURIComponent(mailto)}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { message?: unknown };
  const record = mapCrossrefWork(body.message);
  if (typeof record.fields['title'] !== 'string' || record.fields['title'].length === 0) {
    throw new Error('Crossref 未返回标题');
  }
  return [record];
}

async function tryOpenLibrary(options: ResolveIdentifierOptions, isbn: string): Promise<ResolvedRecord[]> {
  const fetchImpl = timeoutFetch(options.fetchImpl ?? fetch, options.timeoutMs ?? 15_000);
  const response = await fetchImpl(`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const book = (await response.json()) as Record<string, unknown>;
  const authorRefs = Array.isArray(book['authors']) ? book['authors'] : [];
  const names: string[] = [];
  for (const ref of authorRefs.slice(0, 3)) {
    const key = (ref as Record<string, unknown>)['key'];
    if (typeof key !== 'string') continue;
    try {
      const authorResponse = await fetchImpl(`https://openlibrary.org${key}.json`, { headers: { accept: 'application/json' } });
      if (!authorResponse.ok) continue;
      const author = (await authorResponse.json()) as { name?: unknown };
      if (typeof author.name === 'string') names.push(author.name);
    } catch {
      // 作者名取不到不算失败：书名与 ISBN 已经足够建条目
    }
  }
  const record = mapOpenLibraryBook(book, names);
  if (typeof record.fields['title'] !== 'string' || record.fields['title'].length === 0) {
    throw new Error('OpenLibrary 未返回标题');
  }
  return [record];
}

async function tryPubmed(options: ResolveIdentifierOptions, pmid: string): Promise<ResolvedRecord[]> {
  const mailto = options.mailto ?? process.env['ZOTERO_MCP_CROSSREF_MAILTO'] ?? DEFAULT_CROSSREF_MAILTO;
  const fetchImpl = timeoutFetch(options.fetchImpl ?? fetch, options.timeoutMs ?? 15_000);
  const response = await fetchImpl(
    `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${encodeURIComponent(pmid)}&retmode=json&tool=zotero-mcp&email=${encodeURIComponent(mailto)}`,
    { headers: { accept: 'application/json' } },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { result?: Record<string, unknown> };
  const summary = body.result?.[pmid];
  if (summary === undefined) throw new Error('PubMed 未返回该 PMID 的记录');
  const record = mapPubmedSummary(summary);
  if (typeof record.fields['title'] !== 'string' || record.fields['title'].length === 0) {
    throw new Error('PubMed 未返回标题');
  }
  return [record];
}

/**
 * 标识符 → 条目元数据：优先本地 translation-server（容器隔离，端口 1969），
 * 不可用时按类型回退直连 Crossref / OpenLibrary / PubMed；全部失败时给出可读原因。
 * 解析阶段只发 GET/POST 到外部元数据源，不触碰 Zotero 写路径（失败即不写库）。
 */
export async function resolveIdentifier(options: ResolveIdentifierOptions): Promise<IdentifierResolution> {
  const kind = detectIdentifierKind(options.identifier, options.identifierType ?? 'auto');
  const identifier = normalizeIdentifier(options.identifier, kind);
  if (identifier.length === 0) throw new Error(`标识符为空：${options.identifier}`);
  const attempts: IdentifierResolution['attempts'] = [];
  const channel = (source: IdentifierSource, run: () => Promise<ResolvedRecord[]>): (() => Promise<ResolvedRecord[]>) => {
    return async () => {
      try {
        const records = await run();
        attempts.push({ source, ok: records.length > 0, reason: records.length > 0 ? null : '未返回任何记录' });
        return records;
      } catch (error) {
        attempts.push({ source, ok: false, reason: error instanceof Error ? error.message : String(error) });
        return [];
      }
    };
  };

  const fallback: Record<IdentifierKind, [IdentifierSource, () => Promise<ResolvedRecord[]>]> = {
    doi: ['crossref', channel('crossref', () => tryCrossref(options, identifier))],
    isbn: ['openlibrary', channel('openlibrary', () => tryOpenLibrary(options, identifier))],
    pmid: ['pubmed', channel('pubmed', () => tryPubmed(options, identifier))],
  };

  const records = await channel('translation-server', () => tryTranslationServer(options, identifier))();
  if (records.length > 0) {
    return { identifier, kind, source: 'translation-server', records, attempts };
  }
  const [fallbackSource, runFallback] = fallback[kind];
  const fallbackRecords = await runFallback();
  if (fallbackRecords.length > 0) {
    return { identifier, kind, source: fallbackSource, records: fallbackRecords, attempts };
  }
  const detail = attempts.map((attempt) => `${attempt.source}: ${attempt.reason ?? '未知原因'}`).join('；');
  throw new Error(
    `标识符解析失败（${kind}=${identifier}），未写入任何数据。通道尝试：${detail}。` +
      `可启动本地 translation-server（docker run -p 1969:1969 zotero/translation-server）后重试。`,
  );
}

export interface AddItemsOptions extends ChannelOptions {
  mode: 'identifier';
  identifier: string;
  identifierType?: 'auto' | IdentifierKind;
  translationServerUrl?: string;
  translationToken?: string;
  mailto?: string;
  now?: () => Date;
}

export interface AddItemsPlanResult {
  plan: ChangePlan;
  resolution: IdentifierResolution;
}

/** 按标识符导入：解析成功才构造创建计划；解析失败直接抛出（不写库）。 */
export async function buildAddItemsPlan(options: AddItemsOptions): Promise<AddItemsPlanResult> {
  if (options.mode !== 'identifier') {
    throw new Error(`本轮只支持 mode=identifier（doi / isbn / pmid）；mode=${String(options.mode)} 属后续 change`);
  }
  const resolution = await resolveIdentifier({
    identifier: options.identifier,
    ...(options.identifierType === undefined ? {} : { identifierType: options.identifierType }),
    ...(options.translationServerUrl === undefined ? {} : { translationServerUrl: options.translationServerUrl }),
    ...(options.translationToken === undefined ? {} : { translationToken: options.translationToken }),
    ...(options.mailto === undefined ? {} : { mailto: options.mailto }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const operations: PlanOperation[] = resolution.records.map((record) => ({
    kind: 'create',
    itemType: record.itemType,
    fields: record.fields,
    source: resolution.source,
  }));
  const plan = makeChangePlan({
    targetKeys: [],
    changes: [],
    operations,
    summary: `按 ${resolution.kind} 新建 ${operations.length} 条条目（通道：${resolution.source}）`,
    destructive: false,
    confirmKeyword: null,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { plan, resolution };
}
