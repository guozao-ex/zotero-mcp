/**
 * 回滚入口（路线图成功标准 5：误操作可在 1 条指令内回滚）。
 *
 * 这里只做**纯逻辑与只读预览**：解析参数、校验快照结构、读回库内现状并算出
 * 「哪些对象会被写回写前值、哪些字段会变、哪些对象会被永久删除」。
 * 真正的提交复用写管线的 `rollbackFromSnapshot`（一次授权 + 审计 + 版本前置）。
 */

import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';

import { getItems } from './read.ts';
import { readItemEnvelope } from './write-pipeline.ts';
import type { ChannelOptions } from './read.ts';

export interface RollbackSnapshot {
  planId: string;
  createdAt?: string;
  kind?: string;
  items: { key: string; itemType?: string; data?: Record<string, unknown> }[];
  created?: { key: string }[];
}

export type SnapshotValidation =
  | { ok: true; snapshot: RollbackSnapshot }
  | { ok: false; reason: string };

/** 校验快照结构：只接受 `{ planId, items[] }` 形态，其余一律拒绝而不是猜。 */
export function validateSnapshot(raw: unknown): SnapshotValidation {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: '快照根节点必须是一个对象' };
  }
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate['planId'] !== 'string' || candidate['planId'].length === 0) {
    return { ok: false, reason: '快照缺少 planId' };
  }
  if (!Array.isArray(candidate['items'])) {
    return { ok: false, reason: '快照缺少 items 数组' };
  }
  const items: RollbackSnapshot['items'] = [];
  for (const entry of candidate['items'] as unknown[]) {
    if (entry === null || typeof entry !== 'object' || typeof (entry as Record<string, unknown>)['key'] !== 'string') {
      return { ok: false, reason: '快照 items 里的条目必须含字符串 key' };
    }
    const record = entry as Record<string, unknown>;
    items.push({
      key: record['key'] as string,
      ...(typeof record['itemType'] === 'string' ? { itemType: record['itemType'] } : {}),
      ...(record['data'] !== undefined && record['data'] !== null && typeof record['data'] === 'object'
        ? { data: record['data'] as Record<string, unknown> }
        : {}),
    });
  }
  const created = Array.isArray(candidate['created'])
    ? (candidate['created'] as unknown[])
        .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
        .filter((entry) => typeof entry['key'] === 'string')
        .map((entry) => ({ key: entry['key'] as string }))
    : [];
  return {
    ok: true,
    snapshot: {
      planId: candidate['planId'],
      ...(typeof candidate['createdAt'] === 'string' ? { createdAt: candidate['createdAt'] } : {}),
      ...(typeof candidate['kind'] === 'string' ? { kind: candidate['kind'] } : {}),
      items,
      created,
    },
  };
}

/** 从磁盘读取并校验快照；文件不存在与结构不合法给出不同的可读原因。 */
export function readSnapshotFile(path: string): SnapshotValidation {
  if (!existsSync(path)) return { ok: false, reason: `快照文件不存在：${path}` };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (error) {
    return { ok: false, reason: `快照不是合法 JSON：${(error as Error).message}` };
  }
  return validateSnapshot(raw);
}

export interface RollbackFieldChange {
  field: string;
  /** 快照里的写前值（回滚会写回它）。 */
  before: unknown;
  /** 库内当前值。 */
  current: unknown;
}

export interface RollbackPlan {
  planId: string;
  snapshotPath: string;
  createdAt: string | null;
  kind: string | null;
  /** 会被写回写前值的对象（只列出确实有差异的字段）。 */
  restore: { key: string; title: string | null; changes: RollbackFieldChange[] }[];
  /** 计划创建、读现状后仍存在，回滚时将**永久删除**的对象。 */
  remove: { key: string; title: string | null }[];
  /** 计划创建、但库内已不存在的对象：回滚会跳过它们（提交路径同样是幂等跳过）。 */
  alreadyGone: { key: string }[];
  totalChanges: number;
}

/** 快照里不参与差异比较的字段（版本与系统维护时间必然变）。 */
const VOLATILE_FIELDS = new Set(['version', 'dateModified', 'dateAdded', 'key', 'itemType']);

function titleOf(data: Record<string, unknown> | undefined): string | null {
  const title = data?.['title'];
  return typeof title === 'string' && title.length > 0 ? title : null;
}

function comparable(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/**
 * 只读地构造回滚预览：读快照 + 逐条 GET 库内现状，算出将恢复的字段与将删除的对象。
 * 全过程只发 GET，不写库。
 */
export async function buildRollbackPlan(
  snapshotPath: string,
  options: ChannelOptions & { validation?: SnapshotValidation } = {},
): Promise<{ ok: true; plan: RollbackPlan } | { ok: false; reason: string }> {
  const validation = options.validation ?? readSnapshotFile(snapshotPath);
  if (!validation.ok) return { ok: false, reason: validation.reason };
  const snapshot = validation.snapshot;
  const channel: ChannelOptions = {};
  if (options.baseUrl !== undefined) channel.baseUrl = options.baseUrl;
  if (options.fetchImpl !== undefined) channel.fetchImpl = options.fetchImpl;
  if (options.timeoutMs !== undefined) channel.timeoutMs = options.timeoutMs;

  const keys = snapshot.items.map((item) => item.key);
  const current = keys.length === 0 ? [] : await getItems({ ...channel, keys });
  const currentByKey = new Map(current.map((item) => [item.key, item.data as Record<string, unknown>]));

  const restore: RollbackPlan['restore'] = [];
  let totalChanges = 0;
  for (const item of snapshot.items) {
    const before = item.data ?? {};
    const now = currentByKey.get(item.key);
    if (now === undefined) continue; // 已不存在（例如已被删除）：回滚不会凭快照复活它
    const changes: RollbackFieldChange[] = [];
    for (const [field, value] of Object.entries(before)) {
      if (VOLATILE_FIELDS.has(field)) continue;
      if (comparable(value) !== comparable(now[field])) {
        changes.push({ field, before: value ?? null, current: now[field] ?? null });
      }
    }
    if (changes.length > 0) {
      totalChanges += changes.length;
      restore.push({ key: item.key, title: titleOf(now) ?? titleOf(before), changes });
    }
  }

  // 「计划创建」的对象要读一次现状再下结论：提交路径（rollbackFromSnapshot）对读不到的对象
  // 是幂等跳过的，预览若一律列成「将永久删除」，就会把早已删除的对象说成会被删除。
  // 这里刻意复用提交路径的同一个原语（readItemEnvelope），保证两处对「还在不在」判断同源。
  const remove: RollbackPlan['remove'] = [];
  const alreadyGone: RollbackPlan['alreadyGone'] = [];
  for (const entry of snapshot.created ?? []) {
    const envelope = await readItemEnvelope(channel, entry.key);
    if (envelope === null) {
      alreadyGone.push({ key: entry.key });
      continue;
    }
    remove.push({ key: entry.key, title: titleOf(envelope.data as Record<string, unknown>) });
  }

  return {
    ok: true,
    plan: {
      planId: snapshot.planId,
      snapshotPath,
      createdAt: snapshot.createdAt ?? null,
      kind: snapshot.kind ?? null,
      restore,
      remove,
      alreadyGone,
      totalChanges,
    },
  };
}

/** 人类可读的回滚预览。 */
export function renderRollbackPlan(plan: RollbackPlan): string {
  const lines: string[] = [];
  lines.push(`回滚预览（快照 ${plan.snapshotPath}）`);
  lines.push(`  计划：${plan.planId}${plan.kind === null ? '' : `（${plan.kind}）`}${plan.createdAt === null ? '' : `　生成于 ${plan.createdAt}`}`);
  lines.push(`  将写回写前值的对象：${plan.restore.length} 条；字段变更 ${plan.totalChanges} 处`);
  for (const item of plan.restore) {
    lines.push(`    • ${item.key}${item.title === null ? '' : `　${item.title}`}`);
    for (const change of item.changes) {
      lines.push(`        ${change.field}: ${JSON.stringify(change.current)} → ${JSON.stringify(change.before)}`);
    }
  }
  if (plan.remove.length > 0) {
    lines.push(`  将永久删除的对象（本计划创建）：${plan.remove.length} 条`);
    for (const item of plan.remove) {
      lines.push(`    • ${item.key}${item.title === null ? '' : `　${item.title}`}`);
    }
  }
  if (plan.alreadyGone.length > 0) {
    lines.push(`  已不存在、无需删除的对象（本计划创建，回滚会跳过）：${plan.alreadyGone.length} 条`);
    for (const item of plan.alreadyGone) {
      lines.push(`    • ${item.key}`);
    }
  }
  if (plan.restore.length === 0 && plan.remove.length === 0) {
    lines.push('  结论：库内现状与快照一致，无需回滚。');
  }
  return lines.join('\n');
}

export interface RollbackArgs {
  snapshotPath: string;
  commit: boolean;
}

/** 解析 CLI 参数；缺 `--snapshot` 或出现未知参数一律拒绝。 */
export function parseRollbackArgs(argv: string[]): { ok: true; args: RollbackArgs } | { ok: false; reason: string } {
  let snapshotPath = '';
  let commit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--snapshot') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return { ok: false, reason: '--snapshot 需要一个文件路径' };
      snapshotPath = value;
      index += 1;
      continue;
    }
    if (token === '--commit') {
      commit = true;
      continue;
    }
    return { ok: false, reason: `未知参数：${token}（用法：npm run rollback -- --snapshot <file> [--commit]）` };
  }
  if (snapshotPath.length === 0) {
    return { ok: false, reason: '必须提供 --snapshot <file>（用法：npm run rollback -- --snapshot <file> [--commit]）' };
  }
  return { ok: true, args: { snapshotPath, commit } };
}
