/**
 * 插件通道客户端（M4 change 11）。
 *
 * MCP 侧调用薄插件在 Zotero 自带 HTTP 服务器上暴露的六个端点：
 *   - `GET  /zoteromcp/health`         插件与同步状态
 *   - `POST /zoteromcp/sync`           触发一次后台同步，回报 `{running, lastSync}` 供轮询
 *   - `POST /zoteromcp/select-items`   让主窗口选中条目
 *   - `POST /zoteromcp/merge`          请求合并（执行前必弹确认框）
 *   - `POST /zoteromcp/recognize-pdf`  就地补全元数据
 *   - `POST /zoteromcp/annotations`    写入注释（**默认关闭**，需打开插件 pref）
 *
 * 与插件侧的契约（见 `packages/zotero-plugin/src/plugin.js`）：
 *   - 每个请求都带 `X-ZoteroMCP-Token`；写类请求带 `Content-Type: application/json`；
 *   - token 解析顺序：`ZOTERO_MCP_PLUGIN_TOKEN` 环境变量 > `<Zotero 数据目录>/zoteromcp-token.txt`，
 *     数据目录取 `ZOTERO_MCP_DATA_DIR`，缺省 `~/Zotero`；
 *   - **七种**失败必须区分并各自给出可读提示：端点不存在（404，插件未安装或版本过旧）、未授权（401）、
 *     HTTP 服务器未开启（连接失败）、token 未配置（本地无 token）、注释写入被关闭（403，
 *     插件 pref `extensions.zoteromcp.enableAnnotations` 未打开）、写入被 Zotero 拒绝（500
 *     `annotation-save-failed`，见 change `web-api-write-fallback`）、端点自身出错（插件端 5xx）；
 *   - 降级一律带 `pluginAvailable: false`，绝不返回看起来成功的空结果；
 *   - token 只出现在请求头，绝不进入结果、审计或日志。
 *
 * `revealDeepLink()` 是纯函数，**不依赖插件**：插件不可用时 `mode=reveal` 依然可用。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { assertLoopbackUrl } from '../paths.ts';
import type { ChannelOptions } from './read.ts';

/** 插件端点路径（与插件侧注册的键名逐字一致）。 */
export const PLUGIN_ENDPOINTS = [
  '/zoteromcp/health',
  '/zoteromcp/sync',
  '/zoteromcp/select-items',
  '/zoteromcp/merge',
  '/zoteromcp/recognize-pdf',
  '/zoteromcp/annotations',
] as const;
export type PluginEndpoint = (typeof PLUGIN_ENDPOINTS)[number];

/** 共享 token 文件名（位于 Zotero 数据目录下）。 */
export const PLUGIN_TOKEN_FILENAME = 'zoteromcp-token.txt';
/** 认证请求头名（插件侧按小写读取）。 */
export const PLUGIN_TOKEN_HEADER = 'X-ZoteroMCP-Token';
export const PLUGIN_CLIENT_MODES = ['health', 'sync', 'reveal', 'recognize'] as const;
export type PluginClientMode = (typeof PLUGIN_CLIENT_MODES)[number];

/** 插件不可用的原因（七种，含注释写入端点默认关闭）；都不代表插件本身缺失。 */
export type PluginUnavailableReason =
  | 'endpoint-missing'
  | 'unauthorized'
  | 'http-server-disabled'
  | 'token-not-configured'
  | 'annotations-disabled'
  | 'write-denied'
  | 'endpoint-error';

export const PLUGIN_HINTS: Record<PluginUnavailableReason, string> = {
  'endpoint-missing': '插件未安装或版本过旧：请运行 npm run plugin:build 生成 .xpi，并在 Zotero 里「工具 → 插件 → 齿轮 → 从文件安装插件」后重启 Zotero。',
  unauthorized: '共享 token 不匹配：请检查 <Zotero 数据目录>/zoteromcp-token.txt 与 MCP 侧读到的是同一个 token（也可用 ZOTERO_MCP_PLUGIN_TOKEN 显式指定）。',
  'http-server-disabled': 'Zotero 自带的 HTTP 服务器不可达：请确认 Zotero 正在运行，且未关闭 httpServer（默认端口 23119）。',
  'token-not-configured': '本地没有可用的共享 token：请把 token 写入 <Zotero 数据目录>/zoteromcp-token.txt，或设置 ZOTERO_MCP_PLUGIN_TOKEN。',
  'annotations-disabled':
    '注释写入端点默认关闭（fail-closed）：请在 Zotero「设置 → 高级 → 配置编辑器」把 extensions.zoteromcp.enableAnnotations 设为 true 并重启 Zotero。',
  'write-denied':
    '插件端点在写入时被 Zotero 内部 API 拒绝（不是插件缺失，也不是 token 问题）：常见原因是附件不是 PDF、附件不在当前库、或 Zotero 版本与插件调用的内部 API 不兼容。注意：请求**已经发到插件**却被拒，属真实失败，回退链会停在插件这一级并如实回报（不会改走 Web API 通道继续写）。',
  'endpoint-error': '插件端点在处理请求时出错（HTTP 5xx）：插件本身在，属于运行期故障——请看 Zotero 的调试输出（Help → Debug Output Logging）里以 Zotero MCP Channel 开头的日志，而不是重装插件。',
};

export interface PluginUnavailable {
  pluginAvailable: false;
  reason: PluginUnavailableReason;
  hint: string;
  detail: string | null;
}

export interface PluginAvailable {
  pluginAvailable: true;
  reason: null;
  hint: null;
}

export type PluginStatus = PluginAvailable | PluginUnavailable;

/**
 * Zotero 数据目录：显式参数 > 注入的 env / `process.env` 的 `ZOTERO_MCP_DATA_DIR` > `~/Zotero`。
 *
 * `env` 参数供测试与 CLI 注入：只给 `env` 而不给 `override` 时也要认，否则凭证路径会回落到
 * 真实数据目录，隔离不完整（独立只读验收第二轮的风险 3）。
 */
export function resolveDataDir(override?: string, env: NodeJS.ProcessEnv = process.env): string {
  const configured = override ?? env['ZOTERO_MCP_DATA_DIR'] ?? process.env['ZOTERO_MCP_DATA_DIR'];
  if (configured !== undefined && configured.trim().length > 0) {
    return isAbsolute(configured) ? configured : join(process.cwd(), configured);
  }
  return join(homedir(), 'Zotero');
}

export function pluginTokenPath(dataDir?: string): string {
  return join(resolveDataDir(dataDir), PLUGIN_TOKEN_FILENAME);
}

/**
 * 读取共享 token：环境变量优先，其次数据目录下的 token 文件。
 * 返回 null 表示「本地没有可用 token」，调用方必须据此降级（不得发出无 token 的请求）。
 */
export function readPluginToken(options: { dataDir?: string; env?: NodeJS.ProcessEnv } = {}): string | null {
  const env = options.env ?? process.env;
  const fromEnv = env['ZOTERO_MCP_PLUGIN_TOKEN'];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return fromEnv.trim();
  try {
    const raw = readFileSync(pluginTokenPath(options.dataDir), 'utf8');
    const token = raw.replace(/[\r\n]+$/u, '');
    return token.trim().length === 0 ? null : token;
  } catch {
    return null;
  }
}

// ── 深链接（不依赖插件） ────────────────────────────────────────────────

export interface PluginAnnotationSpec {
  /** 注释类型（highlight / underline / note / image / ink）。 */
  type: string;
  /** 位置：`pageIndex`（0-based）与 PDF 坐标矩形。 */
  position: { pageIndex: number; rects: number[][] };
  /** 高亮正文（highlight / underline 用）。 */
  text?: string;
  comment?: string;
  color?: string;
  pageLabel?: string;
  sortIndex?: string;
  /** 可显式指定注释 key（缺省由插件生成）。 */
  key?: string;
}

export interface PluginAnnotationsResult {
  pluginAvailable: true;
  attachmentKey: string;
  created: { key: string; type: string; pageLabel: string | null }[];
}

/**
 * 通过插件写入注释（`POST /zoteromcp/annotations`）。
 *
 * 插件侧**默认关闭**：未在 Zotero 里打开 `extensions.zoteromcp.enableAnnotations` 时返回
 * `reason='annotations-disabled'`（fail-closed），调用方据此提示开启方法，而不是当成插件缺失。
 */
export async function requestPluginAnnotations(
  options: PluginCallOptions & { attachmentKey: string; annotations: PluginAnnotationSpec[] },
): Promise<PluginAnnotationsResult | PluginUnavailable> {
  const { status, body } = await callPlugin('/zoteromcp/annotations', 'POST', options, {
    attachmentKey: options.attachmentKey,
    annotations: options.annotations,
  });
  if (!status.pluginAvailable) return status;
  const created = Array.isArray(body?.['created']) ? (body['created'] as PluginAnnotationsResult['created']) : [];
  return { pluginAvailable: true, attachmentKey: options.attachmentKey, created };
}

export interface RevealDeepLinkOptions {
  key: string;
  /** 1-based 页码；与 Zotero 深链接口径一致。 */
  page?: number;
  annotation?: string;
  groupId?: string;
}

const KEY_PATTERN = /^[A-Za-z0-9]{1,32}$/u;

/** 生成 `zotero://` 深链接（纯函数，不依赖插件）。 */
export function revealDeepLink(options: RevealDeepLinkOptions): string {
  const key = options.key?.trim() ?? '';
  if (key.length === 0) throw new Error('key 不能为空');
  if (!KEY_PATTERN.test(key)) throw new Error(`条目 key 格式非法：${key}`);
  const library = options.groupId === undefined ? 'library' : `groups/${options.groupId}`;
  if (options.page === undefined) return `zotero://select/${library}/items/${key}`;
  if (!Number.isInteger(options.page) || options.page < 1) {
    throw new Error(`page 必须是 1 起的正整数（Zotero 深链接口径为 1-based），收到：${String(options.page)}`);
  }
  const annotation = options.annotation === undefined ? '' : `&annotation=${encodeURIComponent(options.annotation)}`;
  return `zotero://open-pdf/${library}/items/${key}?page=${options.page}${annotation}`;
}

// ── 端点调用 ────────────────────────────────────────────────────────────

export interface PluginCallOptions extends ChannelOptions {
  /** 显式覆盖 token（缺省按环境变量与 token 文件解析）。 */
  token?: string;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}

interface PluginCallResult {
  status: PluginStatus;
  /** 端点返回的 JSON 体；不可用时为 null。 */
  body: Record<string, unknown> | null;
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

/** 一次插件端点调用：先解决 token，再区分六种失败（含 403 注释写入被关闭），最后解析 JSON。 */
async function callPlugin(
  endpoint: PluginEndpoint,
  method: 'GET' | 'POST',
  options: PluginCallOptions,
  body?: Record<string, unknown>,
): Promise<PluginCallResult> {
  const token = options.token ?? readPluginToken({ ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }), ...(options.env === undefined ? {} : { env: options.env }) });
  if (token === null) {
    return { status: { pluginAvailable: false, reason: 'token-not-configured', hint: PLUGIN_HINTS['token-not-configured'], detail: null }, body: null };
  }
  const baseUrl = options.baseUrl ?? process.env['ZOTERO_MCP_BASE_URL'] ?? 'http://127.0.0.1:23119';
  assertLoopbackUrl(baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${baseUrl.replace(/\/$/u, '')}${endpoint}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        accept: 'application/json',
        [PLUGIN_TOKEN_HEADER]: token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    // 连接被拒 / 超时：Zotero 没运行或 HTTP 服务器未开启
    return {
      status: { pluginAvailable: false, reason: 'http-server-disabled', hint: PLUGIN_HINTS['http-server-disabled'], detail: detailOf(error) },
      body: null,
    };
  }
  if (response.status === 404) {
    return { status: { pluginAvailable: false, reason: 'endpoint-missing', hint: PLUGIN_HINTS['endpoint-missing'], detail: `HTTP 404（${endpoint}）` }, body: null };
  }
  if (response.status === 401) {
    return { status: { pluginAvailable: false, reason: 'unauthorized', hint: PLUGIN_HINTS.unauthorized, detail: `HTTP 401（${endpoint}）` }, body: null };
  }
  if (response.status === 403) {
    // 注释写入端点默认关闭：把插件的开关说明透传给调用方（而不是笼统的「不可用」）
    return {
      status: {
        pluginAvailable: false,
        reason: 'annotations-disabled',
        hint: PLUGIN_HINTS['annotations-disabled'],
        detail: `HTTP 403（${endpoint}）`,
      },
      body: null,
    };
  }
  const text = await response.text();
  let parsed: Record<string, unknown> | null = null;
  if (text.length > 0) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  if (response.status >= 500) {
    // 插件在，但端点自己出错了：必须与 404（插件未安装）区分开，否则会把人引向错误的排查方向。
    // 两个例外：① 插件明确回报的「token 未配置」是配置问题；② `annotation-save-failed` 是**写入被拒**
    // （附件类型/库/内部 API 不兼容），回退链要据此把这一级判为「真实失败」而不是「插件缺失」。
    const reason: PluginUnavailableReason =
      parsed?.['error'] === 'token-not-configured'
        ? 'token-not-configured'
        : parsed?.['error'] === 'annotation-save-failed'
          ? 'write-denied'
          : 'endpoint-error';
    return { status: { pluginAvailable: false, reason, hint: PLUGIN_HINTS[reason], detail: `HTTP ${response.status}（${endpoint}）` }, body: parsed };
  }
  if (!response.ok) {
    return { status: { pluginAvailable: false, reason: 'endpoint-missing', hint: PLUGIN_HINTS['endpoint-missing'], detail: `HTTP ${response.status}（${endpoint}）` }, body: parsed };
  }
  return { status: { pluginAvailable: true, reason: null, hint: null }, body: parsed };
}

export type PluginHealthResult = PluginStatus & {
  plugin: { id: string; version: string } | null;
  endpoints: string[];
  sync: { enabled: boolean; running: boolean; lastSync: string | null } | null;
  /** 插件自述的 HTTP 服务器信息（至少含端口）；插件未上报或不可用时为 null。 */
  httpServer: Record<string, unknown> | null;
};

export async function pluginHealth(options: PluginCallOptions = {}): Promise<PluginHealthResult> {
  const { status, body } = await callPlugin('/zoteromcp/health', 'GET', options);
  if (!status.pluginAvailable) {
    return { ...status, plugin: null, endpoints: [], sync: null, httpServer: null };
  }
  const plugin = body?.['plugin'];
  const sync = body?.['sync'];
  const httpServer = body?.['httpServer'];
  return {
    httpServer: typeof httpServer === 'object' && httpServer !== null && !Array.isArray(httpServer) ? (httpServer as Record<string, unknown>) : null,
    ...status,
    plugin:
      typeof plugin === 'object' && plugin !== null
        ? { id: String((plugin as Record<string, unknown>)['id'] ?? ''), version: String((plugin as Record<string, unknown>)['version'] ?? '') }
        : null,
    endpoints: Array.isArray(body?.['endpoints']) ? (body?.['endpoints'] as unknown[]).map((entry) => String(entry)) : [],
    sync:
      typeof sync === 'object' && sync !== null
        ? {
            enabled: (sync as Record<string, unknown>)['enabled'] === true,
            running: (sync as Record<string, unknown>)['running'] === true,
            lastSync: typeof (sync as Record<string, unknown>)['lastSync'] === 'string' ? ((sync as Record<string, unknown>)['lastSync'] as string) : null,
          }
        : null,
  };
}

export type PluginSyncResult = PluginStatus & {
  running: boolean;
  lastSync: string | null;
  started: boolean;
  syncEnabled: boolean;
  note: string | null;
};

export async function pluginSync(options: PluginCallOptions = {}): Promise<PluginSyncResult> {
  const { status, body } = await callPlugin('/zoteromcp/sync', 'POST', options, {});
  if (!status.pluginAvailable) {
    return {
      ...status,
      running: false,
      lastSync: null,
      started: false,
      syncEnabled: false,
      note: '插件不可用：已降级为「等待自动同步」，未触发任何同步，也未产生任何写入。',
    };
  }
  return {
    ...status,
    running: body?.['running'] === true,
    lastSync: typeof body?.['lastSync'] === 'string' ? (body['lastSync'] as string) : null,
    started: body?.['started'] === true,
    syncEnabled: body?.['enabled'] === true,
    note: typeof body?.['reason'] === 'string' ? (body['reason'] as string) : null,
  };
}

export type PluginSelectResult = PluginStatus & {
  selected: boolean;
  key: string;
  note: string | null;
};

/** 让主窗口选中条目；插件不可用或主窗口不可用时如实降级（不报错）。 */
export async function pluginSelectItems(key: string, options: PluginCallOptions = {}): Promise<PluginSelectResult> {
  const { status, body } = await callPlugin('/zoteromcp/select-items', 'POST', options, { key });
  if (!status.pluginAvailable) {
    return { ...status, selected: false, key, note: '插件不可用或主窗口不可用：已降级为深链接文本，请自行打开。' };
  }
  const ok = body?.['ok'] === true;
  return {
    ...status,
    selected: ok,
    key,
    note: ok ? null : `选中未生效：${String(body?.['error'] ?? 'unknown')}`,
  };
}
