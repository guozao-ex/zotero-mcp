/**
 * Local API 通道客户端（M0 范围：探测与请求错误映射）。
 *
 * 只做三件事：把请求发到回环地址、把响应头解析成契约、把状态码与网络错误
 * 映射成稳定错误码。读工具、写管线与 Router + Policy 都在后续 change 里基于它构建。
 */

import {
  classifyFetchError,
  classifyStatus,
  describeError,
  ZoteroChannelError,
} from '../errors.ts';
import { assertLoopbackUrl, resolveBaseUrl, serverCachePath } from '../paths.ts';
import {
  probeResultSchema,
  readZoteroHeaders,
  UNKNOWN_HEADER_VALUE,
} from '../schema.ts';
import type { ProbeResult, ZoteroHeaders } from '../schema.ts';

/** 启动探测用的只读端点（与路线图「启动探测」伪码一致）。 */
export const PROBE_PATH = '/api/users/0/items?limit=1';

export const DEFAULT_PROBE_TIMEOUT_MS = 3000;

export interface ProbeOptions {
  /** 本地 API 根地址，必须是回环地址。 */
  baseUrl?: string;
  /** 探测超时（毫秒）。 */
  timeoutMs?: number;
  /** 缓存根目录；默认取环境变量或当前目录下的 cache/。 */
  cacheDir?: string;
  /** 便于测试注入的 fetch 实现。 */
  fetchImpl?: typeof fetch;
  /** 探测端点，默认为 PROBE_PATH。 */
  probePath?: string;
}

function joinUrl(baseUrl: string, path: string): string {
  const trimmed = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return path.startsWith('/') ? `${trimmed}${path}` : `${trimmed}/${path}`;
}

/**
 * 探测本机 Local API：
 * - 连接失败 → reachable=false、cachePath=null（不产生缓存路径，也不写缓存）；
 * - 403 → 本地 API 未开启，给出设置路径提示；
 * - 200 → 解析三个响应头，按 serverID 分区给出 cachePath。
 */
export async function probeLocalApi(options: ProbeOptions = {}): Promise<ProbeResult> {
  // 走统一解析：显式参数 > ZOTERO_MCP_BASE_URL > 默认回环地址（非回环一律拒绝）
  const baseUrl = resolveBaseUrl(options.baseUrl);
  assertLoopbackUrl(baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const target = joinUrl(baseUrl, options.probePath ?? PROBE_PATH);
  const probedAt = new Date().toISOString();
  const unknownHeaders: ZoteroHeaders = {
    apiVersion: UNKNOWN_HEADER_VALUE,
    serverId: UNKNOWN_HEADER_VALUE,
    schemaVersion: UNKNOWN_HEADER_VALUE,
  };

  try {
    const response = await fetchImpl(target, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const headers = readZoteroHeaders(response.headers);

    if (response.status === 403) {
      return probeResultSchema.parse({
        ...unknownHeaders,
        ...headers,
        reachable: true,
        statusCode: 403,
        writeAvailable: false,
        errorCode: 'local-api-disabled',
        reason: '本地 API 未开启（HTTP 403）',
        cachePath: null,
        nextSteps: [...describeError('local-api-disabled', { status: 403 }).nextSteps],
        target,
        probedAt,
      });
    }

    if (response.ok) {
      const withServerId = headers.serverId !== UNKNOWN_HEADER_VALUE;
      return probeResultSchema.parse({
        ...unknownHeaders,
        ...headers,
        reachable: true,
        statusCode: response.status,
        writeAvailable: withServerId,
        errorCode: withServerId ? null : 'http-error',
        reason: withServerId ? null : '响应缺少 Zotero-Server-ID：读可用，但写请求会得到 428',
        cachePath: serverCachePath(headers.serverId, options.cacheDir),
        nextSteps: withServerId ? [] : [...describeError('missing-server-id').nextSteps],
        target,
        probedAt,
      });
    }

    const code = classifyStatus(response.status);
    return probeResultSchema.parse({
      ...unknownHeaders,
      ...headers,
      reachable: true,
      statusCode: response.status,
      writeAvailable: false,
      errorCode: code,
      reason: `本地 API 返回 HTTP ${response.status}`,
      cachePath: null,
      nextSteps: [...describeError(code, { status: response.status }).nextSteps],
      target,
      probedAt,
    });
  } catch (error) {
    const code = classifyFetchError(error);
    return probeResultSchema.parse({
      ...unknownHeaders,
      reachable: false,
      statusCode: null,
      writeAvailable: false,
      errorCode: code,
      reason:
        code === 'connection-refused'
          ? 'Zotero 未运行，或 23119 端口没有服务监听'
          : `探测失败：${error instanceof Error ? error.message : String(error)}`,
      cachePath: null,
      nextSteps: [...describeError(code).nextSteps],
      target,
      probedAt,
    });
  }
}

export interface LocalApiRequestOptions {
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  baseUrl?: string;
  headers?: Record<string, string>;
  body?: unknown;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface LocalApiResponse {
  status: number;
  headers: ZoteroHeaders;
  body: unknown;
  /** `Total-Results` 响应头；本地 API 无 Web 式分页元数据，用它判断分页。 */
  totalResults: number | null;
  /** `Last-Modified-Version`：库级版本，创建类写请求的版本前提。缺失为 null。 */
  lastModifiedVersion: number | null;
}

/**
 * 发起一次 Local API 请求：2xx 返回结构化响应，其余状态一律抛出
 * `ZoteroChannelError`（错误码由状态码映射），供上层按策略处理。
 */
export async function requestLocalApi(options: LocalApiRequestOptions): Promise<LocalApiResponse> {
  // 走统一解析：显式参数 > ZOTERO_MCP_BASE_URL > 默认回环地址（非回环一律拒绝）
  const baseUrl = resolveBaseUrl(options.baseUrl);
  assertLoopbackUrl(baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const target = joinUrl(baseUrl, options.path);
  const method = options.method ?? 'GET';

  let response: Response;
  try {
    response = await fetchImpl(target, {
      method,
      headers: {
        accept: 'application/json',
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const code = classifyFetchError(error);
    throw new ZoteroChannelError(code, `请求失败：${target}`, { url: target, cause: error });
  }

  const headers = readZoteroHeaders(response.headers);
  if (!response.ok) {
    const code = classifyStatus(response.status);
    // 把响应体带进错误信息：412 的 "found <version>" 是重试所需的关键信息
    const responseBody = (await response.text()).slice(0, 300);
    throw new ZoteroChannelError(
      code,
      `${method} ${target} 返回 HTTP ${response.status}${responseBody.length > 0 ? `：${responseBody}` : ''}`,
      { status: response.status, url: target },
    );
  }

  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const totalHeader = response.headers.get('total-results');
  const totalResults =
    totalHeader === null || !/^\d+$/.test(totalHeader.trim()) ? null : Number.parseInt(totalHeader, 10);
  const versionHeader = response.headers.get('last-modified-version');
  const lastModifiedVersion =
    versionHeader === null || !/^\d+$/.test(versionHeader.trim()) ? null : Number.parseInt(versionHeader, 10);
  return { status: response.status, headers, body, totalResults, lastModifiedVersion };
}

/** 导出接口返回的是格式化文本（非 JSON），单独提供纯文本读取。 */
export async function requestLocalText(
  options: LocalApiRequestOptions,
): Promise<{ status: number; headers: ZoteroHeaders; body: string }> {
  // 走统一解析：显式参数 > ZOTERO_MCP_BASE_URL > 默认回环地址（非回环一律拒绝）
  const baseUrl = resolveBaseUrl(options.baseUrl);
  assertLoopbackUrl(baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = joinUrl(baseUrl, options.path);
  const method = options.method ?? 'GET';

  let response: Response;
  try {
    response = await fetchImpl(target, {
      method,
      headers: { accept: 'text/plain, application/json', ...options.headers },
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ZoteroChannelError(classifyFetchError(error), `请求失败：${target}`, { url: target, cause: error });
  }
  const headers = readZoteroHeaders(response.headers);
  if (!response.ok) {
    throw new ZoteroChannelError(classifyStatus(response.status), `${method} ${target} 返回 HTTP ${response.status}`, {
      status: response.status,
      url: target,
    });
  }
  return { status: response.status, headers, body: await response.text() };
}

/** 把 `/items/<key>/file` 的 302 Location（file:// URL）解析为本地路径。 */
export function fileUrlToPath(fileUrl: string): string {
  if (!fileUrl.startsWith('file://')) {
    throw new Error(`不是 file:// URL：${fileUrl}`);
  }
  const decoded = decodeURIComponent(fileUrl.slice('file://'.length));
  // Windows 形式 file:///C:/... → /C:/... → C:/...
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}

/**
 * 经 `/items/<key>/file` 取本地文件路径：本地 API 返回 302，Location 指向 file://。
 * 用 redirect: 'manual' 拿到未跟随的原始响应。
 */
export async function resolveItemFilePath(
  options: Omit<LocalApiRequestOptions, 'path'> & { key: string },
): Promise<{ path: string; status: number; source: 'redirect-302' | 'body' }> {
  // 走统一解析：显式参数 > ZOTERO_MCP_BASE_URL > 默认回环地址（非回环一律拒绝）
  const baseUrl = resolveBaseUrl(options.baseUrl);
  assertLoopbackUrl(baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const target = joinUrl(baseUrl, `/api/users/0/items/${options.key}/file`);
  const response = await fetchImpl(target, {
    method: 'GET',
    redirect: 'manual',
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
  });
  const location = response.headers.get('location');
  if (response.status >= 300 && response.status < 400 && location !== null) {
    return { path: fileUrlToPath(location), status: response.status, source: 'redirect-302' };
  }
  if (response.ok) {
    const text = (await response.text()).trim();
    if (text.startsWith('file://')) {
      return { path: fileUrlToPath(text), status: response.status, source: 'body' };
    }
    throw new ZoteroChannelError('http-error', `附件未返回 file:// 路径：${target}`, {
      status: response.status,
      url: target,
    });
  }
  throw new ZoteroChannelError(classifyStatus(response.status), `GET ${target} 返回 HTTP ${response.status}`, {
    status: response.status,
    url: target,
  });
}
