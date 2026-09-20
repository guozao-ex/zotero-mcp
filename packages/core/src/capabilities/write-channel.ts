/**
 * 注释写入的四级回退通道（change `web-api-write-fallback`，路线图 G3 降级的前半句）。
 *
 *   ① 插件端点   `127.0.0.1:23119/zoteromcp/annotations`（既有能力，默认需打开 pref）
 *   ② 本机 Local API 写  `127.0.0.1:23119/api/…`（Zotero 10+ 官方写入通道，运行时授权，免云凭证、可断网）
 *   ③ 云端 Web API 写    `https://api.zotero.org/<library>/items`（**必须显式配置**才存在）
 *   ④ 提示等待自动同步（不写库，如实降级）
 *
 * 三条硬约束（brief 的「约束与不变量」）：
 *   - **默认关闭、默认零外呼**：未配置云端凭证时，进程内不得出现任何指向 `api.zotero.org` 的请求；
 *   - **换级要留痕**：只有「未配置 / 不可达」才算可跳过；`401/403/404/412` 与网络错误是**真实失败**，
 *     换级时原因必须出现在结果里，绝不静默改写成成功；
 *   - **凭证不出本机**：本地 token 与云端 API key 都只从文件/环境读，绝不回到结果、审计或日志里。
 *
 * 写入安全语义与既有写管线一致：默认只读（`write` 必须显式为 true）、`confirm` 关键词、写前快照、
 * 审计 JSONL、写后回读校验、失败关闭。注释没有业务主键，因此幂等按
 * 「类型 + 位置字符串 + 正文 + 批注」四元组判重。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { requestLocalApi } from '../channels/local-api.ts';
import { ZoteroChannelError } from '../errors.ts';
import { resolveAuditDir, resolveBaseUrl } from '../paths.ts';
import {
  DEFAULT_WEB_API_BASE,
  resolveWebApiConfig,
  webApiSetupHint,
  type WebApiConfig,
} from './channel-config.ts';
import {
  PLUGIN_CLIENT_MODES,
  PLUGIN_ENDPOINTS,
  pluginHealth,
  readPluginToken,
  requestPluginAnnotations,
  type PluginAnnotationSpec,
  type PluginCallOptions,
  type PluginStatus,
  type PluginUnavailableReason,
} from './client-channel.ts';
import { AUTHORIZE_APP_NAME, AUTHORIZE_PATH, AUTHORIZE_TIMEOUT_MS } from './write-pipeline.ts';
import type { ChannelOptions } from './read.ts';

export const ANNOTATION_WRITE_CONFIRM_KEYWORD = 'WRITE';
export const MAX_ANNOTATIONS = 50;

/** 本地库前缀：Local API 只服务本机登录用户，`0` 与真实 id 等价（真机实测）。 */
export const LOCAL_LIBRARY_PREFIX = '/api/users/0';

/** 可用的写通道；`sync-fallback` 表示「不写库，提示等待同步」。 */
export type WriteChannelId = 'plugin' | 'local-api' | 'web-api' | 'sync-fallback';

/** 单级通道能否使用，以及不能用的可读原因。 */
export interface ChannelAvailability {
  channel: Exclude<WriteChannelId, 'sync-fallback'>;
  available: boolean;
  reason: string | null;
  /** 不可用时，「不可达 / 未配置」这类可以跳到下一级的原因。 */
  skippable: boolean;
}

export interface AnnotationPlanItem {
  type: string;
  pageIndex: number;
  rects: number[][];
  text: string;
  comment: string;
  color: string;
  pageLabel: string | null;
  /** 注释面板排序键；缺省时按 `position` 兜底生成（**不能为 null**，见 `defaultAnnotationSortIndex`）。 */
  sortIndex: string | null;
}

export interface AnnotationWritePlan {
  planId: string;
  createdAt: string;
  attachmentKey: string;
  /** 附件的父条目 key（有则写出，用于结果可读性与人工核对）。 */
  parentItem: string | null;
  attachmentTitle: string | null;
  items: AnnotationPlanItem[];
  /** 逐级探测结论（顺序即回退顺序）。 */
  channels: ChannelAvailability[];
  /** 计划将使用的通道；全部不可用时为 `sync-fallback`。 */
  selectedChannel: WriteChannelId;
  /** 已存在、因此会被跳过的注释（幂等）。 */
  duplicates: { index: number; existingKey: string; channel: null }[];
  /** 计划级说明（例如「插件不可用」的可读提示）。 */
  notes: string[];
  pluginStatus: PluginStatus & { reason: PluginUnavailableReason | null; hint: string | null };
  webApi: { configured: boolean; reason: string | null; maskedKey: string | null; library: string | null };
}

export interface AnnotationWriteResultItem {
  index: number;
  status: 'created' | 'skipped-duplicate' | 'failed';
  key: string | null;
  channel: WriteChannelId | null;
  reason: string | null;
}

export interface AnnotationWriteResult {
  planId: string;
  channel: WriteChannelId;
  /** 是否**全部**条目都落地（created 或已存在而跳过）。真实失败与降级都为 false。 */
  ok: boolean;
  /** 实际尝试过的通道（按顺序），以及每一级的结论。 */
  attempts: { channel: WriteChannelId; outcome: 'success' | 'failed' | 'skipped' | 'not-attempted'; reason: string | null }[];
  created: { index: number; key: string; type: string; pageLabel: string | null }[];
  skipped: { index: number; key: string; reason: string }[];
  failed: { index: number; reason: string }[];
  items: AnnotationWriteResultItem[];
  syncEnabled: boolean;
  note: string | null;
  auditPath: string | null;
  snapshotPath: string | null;
  /** 逐条注释的完整读回结果（写后校验用），无写回读时为 null。 */
  readBack: unknown | null;
}

export interface AnnotationWriteOptions extends PluginCallOptions {
  /** 注入云端 fetch（测试用替身），缺省用全局 fetch。 */
  webFetchImpl?: typeof fetch;
  /** 云端 Web API 基础地址覆盖（测试用）。 */
  webBaseUrl?: string;
  /** 注入配置（测试用），缺省按环境变量与本地文件解析。 */
  webConfig?: WebApiConfig;
  /** 审计目录（缺省 `ZOTERO_MCP_AUDIT_DIR`）。 */
  auditDir?: string;
  /** 注入本地 API key（测试用）；缺省经 `POST /api/local/authorize` 现取。 */
  localApiKey?: string;
}

function channelOf(options: ChannelOptions): ChannelOptions {
  return {
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    timeoutMs: options.timeoutMs,
  };
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把注入的插件通道参数收敛成 PluginCallOptions（避免把 web/api 选项透传到插件层）。 */
function pluginOptionsOf(options: AnnotationWriteOptions): PluginCallOptions {
  return {
    ...channelOf(options),
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    ...(options.env === undefined ? {} : { env: options.env }),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function planIdOf(createdAt: string, size: number): string {
  const stamp = createdAt.replace(/[^0-9]/gu, '').slice(0, 14);
  const unique = Math.random().toString(16).slice(2, 6);
  return `annot-${stamp}-${size}-${unique}`;
}

// ── 只读探测与计划 ──────────────────────────────────────────────────────

/** 调用方提交的注释（可选字段缺省时由 `normalizeItem` 补齐）。 */
export interface AnnotationInputItem {
  type: string;
  pageIndex: number;
  rects: number[][];
  text?: string;
  comment?: string;
  color?: string;
  pageLabel?: string;
  sortIndex?: string;
}

export interface PlanAnnotationWriteInput extends AnnotationWriteOptions {
  attachmentKey: string;
  annotations: AnnotationInputItem[];
}

/**
 * 注释的 `sortIndex`：Zotero 的校验是 `/^\d{5}\|\d{6}\|\d{5}$/`（`data/item.js` 的 `sortIndex` 分支），
 * 格式与 PDF worker 一致：`页码(5) | 字符偏移(6) | 距页顶(5)`。
 *
 * **真机实测（Zotero 10.0.3，2026-09-20）**：经 Local API 写入时若不给 `annotationSortIndex`，
 * 真机会在 `REPLACE INTO itemAnnotations` 上抛
 * `NOT NULL constraint failed: itemAnnotations.sortIndex`——也就是**写不进去**。
 * （插件路径早先也撞过同一处：`saveFromJSON` 缺 sortIndex 会抛 `Invalid sortIndex`。）
 * 因此这里与插件侧 `defaultSortIndex()` 用同一套兜底口径：页码取 `pageIndex`，字符偏移留 0
 * （准确值需要 PDF 文本与 worker），距页顶取 `rects[0][3]`——只影响注释面板里的排序，
 * 不影响高亮落位与可见性；调用方可用 `sortIndex` 覆盖。
 */
export function defaultAnnotationSortIndex(position: { pageIndex: number; rects: number[][] }): string {
  const pageIndex = Number.isInteger(position.pageIndex) ? Math.max(0, position.pageIndex) : 0;
  const firstRect = Array.isArray(position.rects) ? position.rects[0] : undefined;
  const rawTop = Array.isArray(firstRect) ? firstRect[3] : 0;
  const top = Number.isFinite(rawTop) ? Math.max(0, Math.floor(rawTop as number)) : 0;
  return [String(pageIndex).slice(0, 5).padStart(5, '0'), '000000', String(top).slice(0, 5).padStart(5, '0')].join('|');
}

function normalizeItem(raw: AnnotationInputItem): AnnotationPlanItem {
  return {
    type: raw.type,
    pageIndex: raw.pageIndex,
    rects: raw.rects,
    text: raw.text ?? '',
    comment: raw.comment ?? '',
    color: raw.color ?? '#ffd400',
    pageLabel: raw.pageLabel ?? null,
    sortIndex: raw.sortIndex ?? null,
  };
}

interface ExistingAnnotation {
  key: string;
  type: string;
  position: string;
  text: string;
  comment: string;
}

/**
 * 读目标附件下的既有注释（只看创建所需的五个字段）；读不到时返回 null（调用方据此如实说明）。
 *
 * ⚠️ **必须带 `itemType=annotation` 过滤**：真机（Zotero 10.0.3 实测）不带过滤的 `/children`
 * **不返回注释子项**，只返回附件与笔记；漏掉过滤会让幂等判重永远认为「没有重复」。
 */
async function readExistingAnnotations(
  options: AnnotationWriteOptions,
  attachmentKey: string,
): Promise<ExistingAnnotation[] | null> {
  try {
    const response = await requestLocalApi({
      ...channelOf(options),
      path: `${LOCAL_LIBRARY_PREFIX}/items/${attachmentKey}/children?itemType=annotation&limit=100`,
    });
    const raw = Array.isArray(response.body) ? response.body : [];
    const out: ExistingAnnotation[] = [];
    for (const entry of raw) {
      const data = (entry as { data?: Record<string, unknown> } | null)?.data;
      if (data === undefined || data === null) continue;
      if (data['itemType'] !== 'annotation') continue;
      const key = typeof data['key'] === 'string' ? data['key'] : '';
      if (key.length === 0) continue;
      out.push({
        key,
        type: typeof data['annotationType'] === 'string' ? data['annotationType'] : '',
        position: typeof data['annotationPosition'] === 'string' ? data['annotationPosition'] : '',
        text: typeof data['annotationText'] === 'string' ? data['annotationText'] : '',
        comment: typeof data['annotationComment'] === 'string' ? data['annotationComment'] : '',
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** 幂等判重：类型 + 位置字符串 + 正文 + 批注四元组逐字相同即视为同一条注释。 */
function matchDuplicate(existing: ExistingAnnotation[], item: AnnotationPlanItem): string | null {
  const position = JSON.stringify({ pageIndex: item.pageIndex, rects: item.rects });
  for (const entry of existing) {
    if (entry.type !== item.type) continue;
    if (entry.position !== position) continue;
    if (entry.text !== item.text) continue;
    if (entry.comment !== item.comment) continue;
    return entry.key;
  }
  return null;
}

/** 探测插件通道（只读 health，不触发任何动作）。 */
async function probePluginChannel(
  options: AnnotationWriteOptions,
): Promise<{ status: PluginStatus & { reason: PluginUnavailableReason | null; hint: string | null }; availability: ChannelAvailability }> {
  const health = await pluginHealth(pluginOptionsOf(options));
  const status = { pluginAvailable: health.pluginAvailable, reason: health.reason, hint: health.hint } as PluginStatus & {
    reason: PluginUnavailableReason | null;
    hint: string | null;
  };
  if (health.pluginAvailable) {
    return { status, availability: { channel: 'plugin', available: true, reason: null, skippable: false } };
  }
  return {
    status,
    availability: {
      channel: 'plugin',
      available: false,
      reason: `${health.reason}: ${health.hint ?? ''}`.trim(),
      // 插件这一级的全部失败都允许往后走：缺插件、缺 token、服务未开、写入被关，都是「这条通道没法用」
      skippable: true,
    },
  };
}

export interface LocalApiProbe {
  reachable: boolean;
  serverId: string | null;
  reason: string | null;
}

/**
 * 探测 Local API：只读 `GET /api/`（拿 `Zotero-Server-ID`）。
 *
 * 注意「可达」与「可写」是两件事：拿到 Server-ID 才算可写（真机缺它的写请求会被 428 拒绝）；
 * 而 403 表示本地 API 未开启，必须如实回报状态码，不能笼统说成「缺少 Server-ID」。
 */
export async function probeLocalWriteChannel(options: AnnotationWriteOptions = {}): Promise<LocalApiProbe> {
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = `${baseUrl.replace(/\/$/u, '')}/api/`;
  try {
    const response = await fetchImpl(target, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
    });
    const serverId = response.headers.get('zotero-server-id');
    if (!response.ok) {
      return {
        reachable: false,
        serverId: null,
        reason:
          response.status === 403
            ? `本地 API 未开启（HTTP 403）：请在 Zotero「设置 → 高级」勾选允许其它应用与本机 Zotero 通信`
            : `Local API 返回 HTTP ${response.status}（${target}）`,
      };
    }
    if (serverId === null || serverId.trim().length === 0) {
      return { reachable: false, serverId: null, reason: `Local API 响应缺少 Zotero-Server-ID（${target}）` };
    }
    return { reachable: true, serverId: serverId.trim(), reason: null };
  } catch (error) {
    return { reachable: false, serverId: null, reason: `Local API 不可达：${detailOf(error)}` };
  }
}

/**
 * 产出注释写入计划：**只读**（GET + 读本地文件/环境变量），零写请求、零审计、零快照。
 */
export async function planAnnotationWrite(input: PlanAnnotationWriteInput): Promise<AnnotationWritePlan> {
  const attachmentKey = input.attachmentKey.trim();
  if (attachmentKey.length === 0) throw new Error('attachmentKey 不能为空');
  if (input.annotations.length === 0) throw new Error('annotations 不能为空');
  if (input.annotations.length > MAX_ANNOTATIONS) {
    throw new Error(`一次最多提交 ${MAX_ANNOTATIONS} 条注释，当前 ${input.annotations.length} 条`);
  }

  const createdAt = nowIso();
  const items = input.annotations.map((raw) => normalizeItem(raw));
  const notes: string[] = [];

  const plugin = await probePluginChannel(input);
  const local = await probeLocalWriteChannel(input);
  const webConfig = input.webConfig ?? resolveWebApiConfig({ env: input.env, ...(input.dataDir === undefined ? {} : { dataDir: input.dataDir }) });

  const attachmentRead = await readAttachment(input, attachmentKey);
  const attachment = attachmentRead.attachment;
  if (attachment === null) {
    // 读不到附件**不直接失败**：这通常正是「插件没装 + 本地 API 被关」这类真实降级场景的诊断信息。
    // 判定放在后面——只要能读到附件的通道可用，附件读不到就是硬错误；全都读不到就如实降级。
    notes.push(attachmentRead.reason ?? `读不到目标附件 ${attachmentKey} 的元数据：无法确认它是 PDF 附件。`);
  }

  // Local API 的「可用」有两个条件：① `GET /api/` 能拿到 Zotero-Server-ID（否则写请求会被 428 拒绝）；
  // ② 它真的能读到那个附件（`api-disabled` 模式下根路径仍返回 200，但 `/api/users/0/...` 一律 403，
  //    只看根路径会误判成「可用」，随后在写入时才失败——那会让计划失去诊断价值）。
  let localReason = local.reason;
  let localAvailable = local.reachable;
  if (localAvailable && attachment === null && attachmentRead.status !== null) {
    localAvailable = false;
    localReason =
      attachmentRead.status === 403
        ? '本地 API 未开启（HTTP 403）：请在 Zotero「设置 → 高级」勾选允许其它应用与本机 Zotero 通信'
        : `本地 API 读不到附件（HTTP ${attachmentRead.status}）：${attachmentRead.reason ?? '原因未知'}`;
  }

  const channels: ChannelAvailability[] = [plugin.availability];
  channels.push(
    localAvailable
      ? { channel: 'local-api', available: true, reason: null, skippable: false }
      : { channel: 'local-api', available: false, reason: localReason, skippable: true },
  );
  channels.push(
    webConfig.configured
      ? { channel: 'web-api', available: true, reason: null, skippable: false }
      : { channel: 'web-api', available: false, reason: webConfig.reason, skippable: true },
  );

  const existing = await readExistingAnnotations(input, attachmentKey);
  if (existing === null) {
    notes.push('无法读回目标附件下既有注释：本次不做幂等判重（重复提交会真的创建新注释）。');
  }
  const duplicates: AnnotationWritePlan['duplicates'] = [];
  if (existing !== null) {
    items.forEach((item, index) => {
      const match = matchDuplicate(existing, item);
      if (match !== null) duplicates.push({ index, existingKey: match, channel: null });
    });
  }

  // 只有「能读到附件」的通道才算真正可用：云端通道写的是云端库，本机读不到附件不代表云端不可用，
  // 因此附件读不到时把 Local API 与**插件**这一级判为不可用（插件也只能操作本机库），云保持不变。
  const finalChannels: ChannelAvailability[] =
    attachment === null ? channels.map((entry) => (entry.channel === 'plugin' && entry.available ? { ...entry, available: false, reason: '读不到目标附件：无法确认它是本机库里的 PDF 附件', skippable: true } : entry)) : channels;
  const selected = finalChannels.find((entry) => entry.available);
  const selectedChannel: WriteChannelId = selected === undefined ? 'sync-fallback' : selected.channel;

  if (attachment === null && selectedChannel !== 'sync-fallback' && selectedChannel !== 'web-api') {
    // 还有能读附件的本机通道 → 附件读不到就是硬错误（不能盲写到一个未知/非 PDF 的目标上）
    throw new Error(
      `附件不存在或不可读：${attachmentKey}（必须是本地库里的 PDF 附件；本地 API 不可读时无法写注释，` +
        `当前可用通道：${selectedChannel}）`,
    );
  }

  if (plugin.status.pluginAvailable !== true) {
    notes.push(`插件通道不可用：${plugin.status.reason} —— ${plugin.status.hint ?? ''}`.trim());
  }
  if (selectedChannel === 'sync-fallback') {
    notes.push('四级回退全部不可用：本次不会写入任何注释，将如实降级为「等待自动同步」。');
  }
  for (const entry of finalChannels) {
    if (entry.available) continue;
    // 插件「装了但不适用于这个目标」的细节已经在 pluginStatus 里给出，避免重复
    if (entry.channel === 'plugin' && plugin.status.pluginAvailable) continue;
    if (entry.reason !== null && !notes.includes(entry.reason)) notes.push(entry.reason);
  }
  if (webConfig.configured) notes.push(webConfigSetupHintLine(webConfig));

  return {
    planId: planIdOf(createdAt, items.length),
    createdAt,
    attachmentKey,
    parentItem: attachment?.parentItem ?? null,
    attachmentTitle: attachment?.title ?? null,
    items,
    channels: finalChannels,
    selectedChannel,
    duplicates,
    notes,
    pluginStatus: plugin.status,
    webApi: webConfig.configured
      ? { configured: true, reason: null, maskedKey: webConfig.maskedKey, library: webConfig.library }
      : { configured: false, reason: webConfig.reason, maskedKey: null, library: null },
  };
}

function webConfigSetupHintLine(config: WebApiConfig): string {
  return config.configured
    ? `云端通道已配置（来源 ${config.source}，key ${config.maskedKey}，库 ${config.library}）。`
    : `云端通道未启用：${config.reason}（启用方法见 docs/WEB_API_FALLBACK.md）`;
}

interface AttachmentInfo {
  key: string;
  parentItem: string | null;
  title: string | null;
}

interface AttachmentReadResult {
  attachment: AttachmentInfo | null;
  /** HTTP 状态码（连接失败等无状态时为 null）。 */
  status: number | null;
  /** 读失败时的可读原因。 */
  reason: string | null;
}

async function readAttachment(options: AnnotationWriteOptions, key: string): Promise<AttachmentReadResult> {
  try {
    const response = await requestLocalApi({ ...channelOf(options), path: `${LOCAL_LIBRARY_PREFIX}/items/${key}` });
    const raw = response.body;
    const envelope = (Array.isArray(raw) ? raw[0] : raw) as { data?: Record<string, unknown> } | null;
    const data = envelope?.data;
    if (data === undefined || data === null) {
      return { attachment: null, status: response.status, reason: `条目 ${key} 没有可读的 data 字段` };
    }
    if (data['itemType'] !== 'attachment') {
      return {
        attachment: null,
        status: response.status,
        reason: `条目 ${key} 不是附件（itemType=${String(data['itemType'])}）：注释只能挂在 PDF 附件下`,
      };
    }
    return {
      attachment: {
        key,
        parentItem: typeof data['parentItem'] === 'string' ? data['parentItem'] : null,
        title: typeof data['title'] === 'string' ? data['title'] : null,
      },
      status: response.status,
      reason: null,
    };
  } catch (error) {
    const status = error instanceof ZoteroChannelError ? (error.status ?? null) : null;
    return { attachment: null, status, reason: `读不到附件 ${key}：${detailOf(error)}` };
  }
}

// ── 提交 ────────────────────────────────────────────────────────────────

export interface ApplyAnnotationWriteOptions extends AnnotationWriteOptions {
  /** 必须显式为 true 才写入；缺省只做预览。 */
  write?: boolean;
  confirm?: string;
}

function auditPaths(auditDir: string): { audit: string; snapshots: string } {
  return { audit: join(auditDir, 'audit.jsonl'), snapshots: join(auditDir, 'snapshots') };
}

/** 写前快照：目标附件与计划的操作，落盘后返回路径（失败也不影响「已经尝试过」的事实）。 */
async function writeSnapshot(
  auditDir: string,
  plan: AnnotationWritePlan,
  extra: Record<string, unknown>,
): Promise<string> {
  const paths = auditPaths(auditDir);
  await mkdir(paths.snapshots, { recursive: true });
  const snapshotPath = join(paths.snapshots, `${plan.planId}.json`);
  const snapshot = {
    planId: plan.planId,
    createdAt: plan.createdAt,
    kind: 'annotation-write',
    attachmentKey: plan.attachmentKey,
    parentItem: plan.parentItem,
    items: plan.items,
    channels: plan.channels,
    selectedChannel: plan.selectedChannel,
    duplicates: plan.duplicates,
    created: [],
    ...extra,
  };
  await writeFile(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf8');
  return snapshotPath;
}

async function appendAudit(auditDir: string, entry: Record<string, unknown>): Promise<string> {
  const paths = auditPaths(auditDir);
  await mkdir(auditDir, { recursive: true });
  await writeFile(paths.audit, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', flag: 'a' });
  return paths.audit;
}

/** 必须显式为 true 才写入；缺 confirm 或 confirm 不等于 WRITE 时，在发任何请求之前拒绝。 */
function assertWritable(options: ApplyAnnotationWriteOptions): void {
  if (options.write !== true) {
    throw new Error('注释写入必须显式指定 write=true（缺省只读预览，不发出任何写请求）');
  }
  if (options.confirm !== ANNOTATION_WRITE_CONFIRM_KEYWORD) {
    throw new Error(`注释写入必须携带 confirm="${ANNOTATION_WRITE_CONFIRM_KEYWORD}"`);
  }
}

interface ChannelWriteOutcome {
  ok: boolean;
  reason: string | null;
  /**
   * 失败是否允许跳到下一级。
   *
   * **true**：这一级压根没能把请求发出去（未配置 / 不可达 / 未授权 / 上一级已成功）。
   * **false**：请求真的发出去了却被拒（HTTP 4xx/5xx、服务器逐条 failed）——这是**真实失败**，
   * 必须如实停在这一级，绝不能静默降级成「等待同步」让调用方以为只是没写而已。
   */
  skippable: boolean;
  /** 仍然无法判定成功的条目（写入已发出但回读不到）。 */
  created: { index: number; key: string; type: string; pageLabel: string | null }[];
  /** 服务器明确回报失败的下标。 */
  failed: { index: number; reason: string }[];
  /** 跳过的重复项。 */
  skipped: { index: number; key: string; reason: string }[];
  readBack: unknown | null;
}

function emptyOutcome(reason: string | null, skippable: boolean): ChannelWriteOutcome {
  return { ok: false, reason, skippable, created: [], failed: [], skipped: [], readBack: null };
}

/**
 * 从上游错误响应体里只取**结构化的错误标识**，绝不回显响应体原文。
 *
 * 原因（独立只读验收 A11/A29 复现）：上游在错误体里回显凭证是常见形态（例如
 * `{"error":"Forbidden: invalid API key <KEY>"}`）。此前把响应体前 200 字符拼进 `reason`，
 * 该 key 会顺着 `reason` 进入工具结果、审计 JSONL 与快照 —— 凭证泄漏。
 * 现在只接受一个短的、形如错误码的 `error` / `code` / `errorCode` 字段
 * （限字母数字与 `._-`，≤64 字符），其余一律丢弃。
 */
function safeErrorHint(rawBody: string): string | null {
  if (rawBody.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  for (const field of ['error', 'code', 'errorCode'] as const) {
    const value = record[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > 64) continue;
    if (!/^[A-Za-z0-9._-]+$/u.test(trimmed)) continue;
    return trimmed;
  }
  return null;
}

/** 网络层错误的**安全**摘要：只保留错误码/错误名，不含 URL 与错误消息（都可能带凭证或查询串）。 */
function safeNetworkReason(error: unknown): string {
  for (const candidate of [(error as { code?: unknown } | null)?.code, (error as { cause?: { code?: unknown } } | null)?.cause?.code]) {
    if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 64 && /^[A-Za-z0-9._-]+$/u.test(candidate)) {
      return `网络错误 ${candidate}`;
    }
  }
  return error instanceof Error ? `网络错误 ${error.name}` : '网络错误';
}

/** 从 `successful` / `success` 里按数组下标取新对象 key（兼容对象形与字符串形，与写管线同口径）。 */
function extractCreatedKey(batch: Record<string, unknown>, index: number): string | null {
  for (const containerName of ['successful', 'success'] as const) {
    const container = batch[containerName];
    if (typeof container !== 'object' || container === null || Array.isArray(container)) continue;
    const value = (container as Record<string, unknown>)[String(index)];
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'object' && value !== null) {
      const key = (value as Record<string, unknown>)['key'];
      if (typeof key === 'string' && key.length > 0) return key;
    }
  }
  return null;
}

function extractFailures(batch: Record<string, unknown>): { index: number; message: string }[] {
  const container = batch['failed'];
  if (typeof container !== 'object' || container === null || Array.isArray(container)) return [];
  const out: { index: number; message: string }[] = [];
  for (const [rawIndex, value] of Object.entries(container as Record<string, unknown>)) {
    const index = Number.parseInt(rawIndex, 10);
    if (Number.isNaN(index)) continue;
    // 逐条失败也是**上游给出的文本**，与错误响应体同等对待：只保留「像错误码 / 像一句技术原因」的部分。
    // 否则上游在 message 里回显凭证时，会顺着 failed[].reason 进工具结果、审计与快照
    // （独立只读验收第二轮以「200 + failed[].message 回显哨兵」复现过）。
    const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
    const raw = record !== null && typeof record['message'] === 'string' ? (record['message'] as string) : null;
    const code = record !== null && typeof record['code'] === 'number' ? `HTTP ${String(record['code'])}` : null;
    out.push({ index, message: sanitizeUpstreamText(raw, code) });
  }
  return out;
}

/**
 * 把上游给出的自由文本收敛成**可安全回显**的形态。
 *
 * 难点在于：凭证本身长得就像普通文本（例如 `SENTINEL-CLOUD-KEY-0123456789` 只由字母、数字与短横
 * 组成），所以**字符白名单挡不住它**——第一轮验收就是这么漏过去的。真正的判据是「像不像凭证」，
 * 因此这里做**令牌级**判定：
 *
 *   1. 整串必须是「中英文 + 数字 + 空格 + `._-:/|()[]`」，否则整串丢弃（挡掉 JSON 片段、URL、引号内容）；
 *   2. 长度 > 120 整串丢弃（不把大段上游正文搬进结果）；
 *   3. 逐令牌（以 `[A-Za-z0-9._-]` 组成的词）判定，命中任一条即替换为 `[已省略]`：
 *      · 去掉 `._-` 后含 **10 位以上连续数字**（覆盖 `…-0123456789` 这类带前缀的 key）；
 *      · 去掉 `._-` 后长度 ≥ 16 且**同时含字母与数字**（覆盖 `FAKEKEY0000…`、`P9NiFoyLeZu2bZNvvuQPDWsd`）。
 *
 * 保留下来的都是有排障价值的普通文本：状态码、`annotation-save-failed`、
 * `NOT NULL constraint failed: itemAnnotations.sortIndex`、`Parent item ABCD2345 not found` 等。
 */
function sanitizeUpstreamText(raw: string | null, fallback: string | null): string {
  if (raw === null) return fallback ?? '服务器未给出原因';
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback ?? '服务器未给出原因';
  if (trimmed.length > 120) return fallback ?? '上游返回了过长的失败信息（已省略）';
  // 字符面要覆盖真实排障文本里常见的标点（单/双引号、逗号、感叹号、问号、分号、星号、井号、加号、等号、百分号），
  // 否则 `Invalid sortIndex 'x'`（单引号）与 `(expected 1, found 42)`（逗号）会被整段丢掉——
  // 那是第三轮验收实测到的过度清洗。这里仍然挡掉花括号、尖括号、反斜杠与裸控制字符
  // （带花括号的 JSON 片段、转义串会被整段丢弃）。注意：**不含花括号**的 JSON 片段与 URL 形态
  // 不在这一层的拦截范围内，它们靠下面的令牌级抹除兜住凭证（实测 `?key=<哨兵>` 只会剩下 `?key=[已省略]`）。
  if (!/^[\p{Script=Han}A-Za-z0-9 .,;:!?'"`*#+%=_\-/|()[\]]+$/u.test(trimmed)) {
    return fallback ?? '上游返回了含不可信字符的失败信息（已省略）';
  }
  return trimmed
    .split(/([A-Za-z0-9][A-Za-z0-9._-]*)/u)
    .map((part) => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part)) return part;
      const compact = part.replace(/[._-]/gu, '');
      if (/\d{10,}/u.test(compact)) return '[已省略]';
      if (compact.length >= 16 && /\d/u.test(compact) && /[A-Za-z]/u.test(compact)) return '[已省略]';
      return part;
    })
    .join('');
}

/** 构造写请求体：数组体 + `annotationPosition` 为 JSON 字符串（真机口径）。 */
function payloadFor(plan: AnnotationWritePlan, attachmentKey: string, indexes: number[]): Record<string, unknown>[] {
  return indexes.map((index) => {
    const item = plan.items[index] as AnnotationPlanItem;
    return {
      itemType: 'annotation',
      parentItem: attachmentKey,
      annotationType: item.type,
      ...(item.type === 'highlight' || item.type === 'underline' ? { annotationText: item.text } : {}),
      annotationComment: item.comment,
      annotationColor: item.color,
      ...(item.pageLabel === null ? {} : { annotationPageLabel: item.pageLabel }),
      // sortIndex 是 NOT NULL：真机缺它会抛 "NOT NULL constraint failed: itemAnnotations.sortIndex"
      // （2026-09-20 真机实测），因此必须兜底，不能省略。
      annotationSortIndex: item.sortIndex ?? defaultAnnotationSortIndex({ pageIndex: item.pageIndex, rects: item.rects }),
      annotationPosition: JSON.stringify({ pageIndex: item.pageIndex, rects: item.rects }),
    };
  });
}

/** ② 本机 Local API 写。 */
async function writeViaLocalApi(
  plan: AnnotationWritePlan,
  options: AnnotationWriteOptions,
): Promise<ChannelWriteOutcome> {
  const existing = await readExistingAnnotations(options, plan.attachmentKey);
  const skip = new Map<number, string>();
  if (existing !== null) {
    plan.items.forEach((item, index) => {
      const match = matchDuplicate(existing, item);
      if (match !== null) skip.set(index, match);
    });
  }
  const indexes = plan.items.map((_, index) => index).filter((index) => !skip.has(index));
  const skipped = [...skip.entries()].map(([index, key]) => ({ index, key, reason: '已存在相同注释（幂等跳过）' }));

  if (indexes.length === 0) {
    return { ok: true, reason: null, skippable: false, created: [], failed: [], skipped, readBack: null };
  }

  const probe = await probeLocalWriteChannel(options);
  if (!probe.reachable || probe.serverId === null) {
    return { ok: false, reason: probe.reason ?? 'Local API 不可达', skippable: true, created: [], failed: [], skipped, readBack: null };
  }

  let key: string | null = null;
  if (options.localApiKey !== undefined) {
    key = options.localApiKey;
  } else {
    try {
      const authorized = await requestLocalApi({
        ...channelOf(options),
        timeoutMs: AUTHORIZE_TIMEOUT_MS,
        path: AUTHORIZE_PATH,
        method: 'POST',
        headers: { 'zotero-api-version': '3', 'zotero-server-id': probe.serverId },
        body: { appName: AUTHORIZE_APP_NAME },
      });
      const granted = (authorized.body as { key?: unknown } | null)?.key;
      if (typeof granted !== 'string' || granted.length === 0) {
        return { ok: false, reason: '本地 API 授权未返回可用 key', skippable: true, created: [], failed: [], skipped, readBack: null };
      }
      key = granted;
    } catch (error) {
      return {
        ok: false,
        reason: `本地 API 授权失败：${detailOf(error)}`,
        skippable: true,
        created: [],
        failed: [],
        skipped,
        readBack: null,
      };
    }
  }

  const payload = payloadFor(plan, plan.attachmentKey, indexes);
  let batch: Record<string, unknown>;
  try {
    const response = await requestLocalApi({
      ...channelOf(options),
      path: `${LOCAL_LIBRARY_PREFIX}/items`,
      method: 'POST',
      headers: {
        'zotero-api-version': '3',
        'zotero-server-id': probe.serverId,
        'zotero-api-key': key,
      },
      body: payload,
    });
    batch = (response.body ?? {}) as Record<string, unknown>;
  } catch (error) {
    // 只回报安全摘要（同上）；本地 API 的错误文案本身不含 token
    return { ok: false, reason: `Local API 写入失败（${error instanceof ZoteroChannelError ? `HTTP ${String(error.status ?? '?')}` : safeNetworkReason(error)}）`, skippable: false, created: [], failed: [], skipped, readBack: null };
  }

  const created: ChannelWriteOutcome['created'] = [];
  const failed: ChannelWriteOutcome['failed'] = [];
  indexes.forEach((index, position) => {
    const createdKey = extractCreatedKey(batch, position);
    if (createdKey !== null) {
      created.push({ index, key: createdKey, type: plan.items[index]!.type, pageLabel: plan.items[index]!.pageLabel });
    }
  });
  for (const failure of extractFailures(batch)) {
    const index = indexes[failure.index];
    if (index === undefined) continue;
    failed.push({ index, reason: failure.message });
  }
  if (created.length === 0 && failed.length === 0) {
    return { ok: false, reason: 'Local API 未回报任何创建成功或失败', skippable: false, created: [], failed: [], skipped, readBack: null };
  }

  const readBack = created.length === 0 ? null : await readBackAnnotations(options, created.map((entry) => entry.key));
  return { ok: created.length > 0, reason: null, skippable: false, created, failed, skipped, readBack };
}

/** ③ 云端 Web API 写。 */
async function writeViaWebApi(
  plan: AnnotationWritePlan,
  options: AnnotationWriteOptions,
  config: WebApiConfig,
): Promise<ChannelWriteOutcome> {
  if (!config.configured) {
    return { ok: false, reason: config.reason, skippable: true, created: [], failed: [], skipped: [], readBack: null };
  }
  const base = (options.webBaseUrl ?? DEFAULT_WEB_API_BASE).replace(/\/$/u, '');
  const fetchImpl = options.webFetchImpl ?? options.fetchImpl ?? fetch;
  const existing = await readExistingAnnotations(options, plan.attachmentKey);
  const skip = new Map<number, string>();
  if (existing !== null) {
    plan.items.forEach((item, index) => {
      const match = matchDuplicate(existing, item);
      if (match !== null) skip.set(index, match);
    });
  }
  const indexes = plan.items.map((_, index) => index).filter((index) => !skip.has(index));
  const skipped = [...skip.entries()].map(([index, key]) => ({ index, key, reason: '已存在相同注释（幂等跳过）' }));
  if (indexes.length === 0) {
    return { ok: true, reason: null, skippable: false, created: [], failed: [], skipped, readBack: null };
  }

  const url = `${base}/${config.library}/items`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'zotero-api-key': config.apiKey,
        'zotero-api-version': '3',
      },
      body: JSON.stringify(payloadFor(plan, plan.attachmentKey, indexes)),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (error) {
    // 只回报安全摘要：错误消息可能带 URL / 查询串 / 凭证
    return { ok: false, reason: `云端 Web API 请求失败（${safeNetworkReason(error)}）`, skippable: false, created: [], failed: [], skipped, readBack: null };
  }

  const text = await response.text();
  const hint = safeErrorHint(text);
  if (!response.ok) {
    // 只回报状态码与（白名单化的）错误码：响应体原文一律不回显（见 safeErrorHint 的注释）
    return {
      ok: false,
      // 绝不回显响应体原文：上游可能在错误体里回显凭证（见 safeErrorHint 的注释）
      reason: `云端 Web API 返回 HTTP ${response.status}${hint === null ? '' : `（${hint}）`}`,
      skippable: false,
      created: [],
      failed: [],
      skipped,
      readBack: null,
    };
  }
  let batch: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) batch = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, reason: '云端 Web API 响应不是合法 JSON 对象', skippable: false, created: [], failed: [], skipped, readBack: null };
  }

  const created: ChannelWriteOutcome['created'] = [];
  const failed: ChannelWriteOutcome['failed'] = [];
  indexes.forEach((index, position) => {
    const createdKey = extractCreatedKey(batch, position);
    if (createdKey !== null) {
      created.push({ index, key: createdKey, type: plan.items[index]!.type, pageLabel: plan.items[index]!.pageLabel });
    }
  });
  for (const failure of extractFailures(batch)) {
    const index = indexes[failure.index];
    if (index === undefined) continue;
    failed.push({ index, reason: failure.message });
  }
  if (created.length === 0 && failed.length === 0) {
    return { ok: false, reason: '云端 Web API 未回报任何创建成功或失败', skippable: false, created: [], failed: [], skipped, readBack: null };
  }
  const readBack = created.length === 0 ? null : await readBackAnnotations(options, created.map((entry) => entry.key));
  return { ok: created.length > 0, reason: null, skippable: false, created, failed, skipped, readBack };
}

/** 写后回读校验：按 key 读回条目（本地 API）；读不到时如实返回 null。 */
async function readBackAnnotations(options: AnnotationWriteOptions, keys: string[]): Promise<unknown | null> {
  if (keys.length === 0) return null;
  try {
    const response = await requestLocalApi({
      ...channelOf(options),
      path: `${LOCAL_LIBRARY_PREFIX}/items?itemKey=${keys.join(',')}&limit=50`,
    });
    return response.body ?? null;
  } catch {
    return null;
  }
}

/**
 * 按回退链提交注释写入。
 *
 * - `write` 必须显式为 true 且 `confirm="WRITE"`，否则**在发出任何请求之前**拒绝；
 * - 逐级尝试，每级结论（成功 / 失败 / 跳过）都进结果；
 * - 全部不可用时返回 `sync-fallback`（不写库、审计里没有成功记录）。
 */
export async function applyAnnotationWrite(
  plan: AnnotationWritePlan,
  options: ApplyAnnotationWriteOptions = {},
): Promise<AnnotationWriteResult> {
  assertWritable(options);
  const auditDir = options.auditDir ?? resolveAuditDir();
  const attempts: AnnotationWriteResult['attempts'] = [];
  // 注入的 dataDir 必须一路带着走：否则凭证路径会回落到真实 <Zotero 数据目录>，
  // 测试/CLI 的 env 注入隔离就不完整（独立只读验收的非阻断风险第 4 条）。
  const dataDir = options.dataDir;
  const resolveWebConfig = (): WebApiConfig =>
    resolveWebApiConfig({ env: options.env, ...(dataDir === undefined ? {} : { dataDir }) });
  const webConfig = options.webConfig ?? resolveWebConfig();

  const snapshotPath = await writeSnapshot(auditDir, plan, {
    cloudConfigured: webConfig.configured,
    pluginStatus: { pluginAvailable: plan.pluginStatus.pluginAvailable, reason: plan.pluginStatus.reason },
  });

  let channel: WriteChannelId = 'sync-fallback';
  let outcome: ChannelWriteOutcome = emptyOutcome(null, true);
  let note: string | null = null;
  /** 一旦某一级是「真实失败」（请求发出去了却被拒），就停在那里，不再往后降级。 */
  let halted = false;

  const verdictOf = (id: Exclude<WriteChannelId, 'sync-fallback'>): ChannelAvailability | undefined =>
    plan.channels.find((entry) => entry.channel === id);

  // ① 插件端点
  const pluginVerdict = verdictOf('plugin');
  if (plan.pluginStatus.pluginAvailable && pluginVerdict?.available === true) {
    const built = await writeViaPlugin(plan, options);
    if (built.ok) {
      attempts.push({ channel: 'plugin', outcome: 'success', reason: null });
      channel = 'plugin';
      outcome = built;
    } else if (built.skippable) {
      // 这一级压根没写进去（端点消失 / 不可达 / 未授权）：允许降级，但原因必须留痕
      attempts.push({ channel: 'plugin', outcome: 'skipped', reason: built.reason });
    } else {
      attempts.push({ channel: 'plugin', outcome: 'failed', reason: built.reason });
      channel = 'plugin';
      outcome = built;
      halted = true;
      note = `插件通道写入失败：${built.reason ?? '未知原因'}`;
    }
  } else {
    attempts.push({
      channel: 'plugin',
      outcome: 'skipped',
      reason: pluginVerdict?.reason ?? `插件不可用：${plan.pluginStatus.reason ?? '未知原因'}`,
    });
  }

  // ② 本机 Local API 写：只按**计划的判定**尝试（计划不可用时连请求都不发，避免在一级已经
  //    被诊断为不可用的情况下仍然打出 403 写请求）
  if (channel === 'sync-fallback') {
    const localVerdict = verdictOf('local-api');
    if (localVerdict?.available === true) {
      const built = await writeViaLocalApi(plan, options);
      if (built.ok) {
        attempts.push({ channel: 'local-api', outcome: 'success', reason: null });
        channel = 'local-api';
        outcome = built;
      } else if (built.skippable) {
        // 这一级压根没写进去（未授权 / 不可达）：允许换到云端一级，但原因必须留痕
        attempts.push({ channel: 'local-api', outcome: 'skipped', reason: built.reason });
      } else {
        attempts.push({ channel: 'local-api', outcome: 'failed', reason: built.reason ?? '部分条目未创建' });
        channel = 'local-api';
        outcome = built;
        halted = true;
      }
    } else {
      attempts.push({ channel: 'local-api', outcome: 'skipped', reason: localVerdict?.reason ?? 'Local API 不可用' });
    }
  } else {
    attempts.push({ channel: 'local-api', outcome: 'not-attempted', reason: halted ? '插件级写入真实失败，已停止降级' : '上一级已成功' });
  }

  // ③ 云端 Web API 写
  if (channel === 'sync-fallback') {
    const webVerdict = verdictOf('web-api');
    if (webVerdict?.available === true) {
      const built = await writeViaWebApi(plan, options, webConfig);
      if (built.ok) {
        attempts.push({ channel: 'web-api', outcome: 'success', reason: null });
        channel = 'web-api';
        outcome = built;
      } else if (built.skippable) {
        attempts.push({ channel: 'web-api', outcome: 'skipped', reason: built.reason });
      } else {
        attempts.push({ channel: 'web-api', outcome: 'failed', reason: built.reason ?? '部分条目未创建' });
        channel = 'web-api';
        outcome = built;
        halted = true;
      }
    } else {
      attempts.push({ channel: 'web-api', outcome: 'skipped', reason: webVerdict?.reason ?? '云端 Web API 未启用' });
    }
  } else {
    attempts.push({ channel: 'web-api', outcome: 'not-attempted', reason: halted ? '上一级写入真实失败，已停止降级' : '上一级已成功' });
  }

  // ④ 如实降级
  if (channel === 'sync-fallback') {
    attempts.push({ channel: 'sync-fallback', outcome: 'not-attempted', reason: null });
    note = '插件端点与两条 Web API 通道都不可用：已降级为「等待自动同步」，未写入任何注释。';
  }

  const items: AnnotationWriteResultItem[] = plan.items.map((_, index) => {
    const created = outcome.created.find((entry) => entry.index === index);
    if (created !== undefined) return { index, status: 'created', key: created.key, channel, reason: null };
    const skippedEntry = outcome.skipped.find((entry) => entry.index === index);
    const duplicateEntry = plan.duplicates.find((entry) => entry.index === index);
    if (skippedEntry !== undefined || duplicateEntry !== undefined) {
      return {
        index,
        status: 'skipped-duplicate',
        key: skippedEntry?.key ?? duplicateEntry?.existingKey ?? null,
        channel,
        reason: '已存在相同注释（幂等跳过）',
      };
    }
    const failed = outcome.failed.find((entry) => entry.index === index);
    if (failed !== undefined) return { index, status: 'failed', key: null, channel, reason: failed.reason };
    return {
      index,
      status: 'failed',
      key: null,
      channel: null,
      reason: note ?? '未创建：所有通道都不可用',
    };
  });

  const auditPath = await appendAudit(auditDir, {
    at: nowIso(),
    kind: 'annotation-write',
    planId: plan.planId,
    channel,
    attachmentKey: plan.attachmentKey,
    created: outcome.created,
    skipped: outcome.skipped,
    failed: outcome.failed,
    attempts,
    cloudConfigured: webConfig.configured,
    snapshotPath,
  });

  // 快照补写实际结果（快照既记录「打算做什么」，也记录「实际创建了什么」）
  await writeSnapshot(auditDir, plan, {
    cloudConfigured: webConfig.configured,
    attemptedAt: nowIso(),
    channel,
    created: outcome.created,
    skipped: outcome.skipped,
    failed: outcome.failed,
    attempts,
  });

  // 「是否真的落地」：失败路径必须为 false。只看 channel 会把「本地级已被拒」误读成写入成功
  // （独立只读验收的非阻断风险第 1 条）。
  const settled = items.every((item) => item.status === 'created' || item.status === 'skipped-duplicate');

  return {
    planId: plan.planId,
    channel,
    ok: channel !== 'sync-fallback' && settled,
    syncEnabled: channel !== 'sync-fallback' && settled,
    attempts,
    created: outcome.created.map((entry) => ({ index: entry.index, key: entry.key, type: entry.type, pageLabel: entry.pageLabel })),
    skipped: outcome.skipped,
    failed: outcome.failed,
    items,
    note,
    auditPath,
    snapshotPath,
    readBack: outcome.readBack,
  };
}

/** ① 插件端点写（复用既有 `requestPluginAnnotations`，不重复实现端点契约）。 */
async function writeViaPlugin(plan: AnnotationWritePlan, options: AnnotationWriteOptions): Promise<ChannelWriteOutcome> {
  const specs: PluginAnnotationSpec[] = plan.items.map((item) => ({
    type: item.type,
    position: { pageIndex: item.pageIndex, rects: item.rects },
    ...(item.text.length === 0 ? {} : { text: item.text }),
    ...(item.comment.length === 0 ? {} : { comment: item.comment }),
    color: item.color,
    ...(item.pageLabel === null ? {} : { pageLabel: item.pageLabel }),
  }));
  const result = await requestPluginAnnotations({
    ...pluginOptionsOf(options),
    attachmentKey: plan.attachmentKey,
    annotations: specs,
  });
  if (result.pluginAvailable !== true) {
    // 「没写进去」（端点消失 / 不可达 / 未授权 / 写入开关关着）才是可跳过的；
    // `write-denied`（请求已到插件、被 Zotero 内部 API 拒）与`endpoint-error`（插件出错了）
    // 属**真实失败**，必须停在这一级如实回报，不得继续降级到 Web API 通道
    // （否则会把「写失败了」变成「换个通道偷偷写成功」）。
    const skippable = result.reason !== 'write-denied' && result.reason !== 'endpoint-error';
    return {
      ok: false,
      reason: `${result.reason}: ${result.hint}`,
      skippable,
      created: [],
      failed: [],
      skipped: [],
      readBack: null,
    };
  }
  const created: ChannelWriteOutcome['created'] = result.created.map((entry, index) => ({
    index,
    key: entry.key,
    type: entry.type,
    pageLabel: entry.pageLabel,
  }));
  const readBack = created.length === 0 ? null : await readBackAnnotations(options, created.map((entry) => entry.key));
  return { ok: true, reason: null, skippable: false, created, failed: [], skipped: [], readBack };
}

/** 供工具层与 CLI 复用的通道摘要（结果里只出现掩码与来源，绝不出现凭证）。 */
export function summarizeWebApiConfig(config: WebApiConfig): { configured: boolean; library: string | null; maskedKey: string | null; reason: string | null } {
  return config.configured
    ? { configured: true, library: config.library, maskedKey: config.maskedKey, reason: null }
    : { configured: false, library: null, maskedKey: null, reason: config.reason };
}

/** 探测结论（供 CLI 只读打印）。 */
export interface ChannelProbeSummary {
  plugin: { available: boolean; reason: string | null; hint: string | null };
  localApi: LocalApiProbe;
  webApi: { configured: boolean; library: string | null; maskedKey: string | null; reason: string | null };
  tokenConfigured: boolean;
  endpoints: readonly string[];
  modes: readonly string[];
}

export async function probeChannels(options: AnnotationWriteOptions = {}): Promise<ChannelProbeSummary> {
  const plugin = await pluginHealth(pluginOptionsOf(options));
  const localApi = await probeLocalWriteChannel(options);
  const webApi = summarizeWebApiConfig(
    options.webConfig ?? resolveWebApiConfig({ env: options.env, ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }) }),
  );
  return {
    plugin: { available: plugin.pluginAvailable, reason: plugin.reason, hint: plugin.hint },
    localApi,
    webApi,
    tokenConfigured: readPluginToken(pluginOptionsOf(options)) !== null,
    endpoints: PLUGIN_ENDPOINTS,
    modes: PLUGIN_CLIENT_MODES,
  };
}
