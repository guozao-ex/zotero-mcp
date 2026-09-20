/**
 * translation-server 通道客户端（G2 的 L3）。
 *
 * Zotero translation-server 是独立进程/容器运行的元数据解析服务（AGPL，进程隔离、不并入本仓库）：
 * - `POST /search`：body 是标识符（DOI / ISBN / PMID / arXiv），返回 Zotero 条目数组；
 * - `POST /web`：body 是 URL，返回 Zotero 条目数组。
 *
 * 本模块把它当**可远程部署**的一等通道：
 * - 端点：显式参数 > `ZOTERO_MCP_TRANSLATION_SERVER` > `http://127.0.0.1:1969`；
 * - 令牌：`ZOTERO_MCP_TRANSLATION_TOKEN` → 请求头 `X-ZoteroMCP-Token`（默认不发送）；
 * - 超时：`ZOTERO_MCP_TRANSLATION_TIMEOUT_MS`（默认 15000 毫秒）。
 *
 * 安全约定：令牌只从环境变量或显式参数读取，绝不出现在返回值、错误消息或日志里。
 */

/** 默认端点：本机 translation-server（容器或源码直跑都会监听 1969）。 */
export const DEFAULT_TRANSLATION_SERVER_URL = 'http://127.0.0.1:1969';
/** 默认超时（毫秒）。 */
export const DEFAULT_TRANSLATION_TIMEOUT_MS = 15_000;
/** 令牌请求头（与路线图插件通道同名，便于统一网关策略）。 */
export const TRANSLATION_TOKEN_HEADER = 'X-ZoteroMCP-Token';

export type TranslationErrorKind =
  | 'unreachable'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'upstream-error'
  | 'invalid-response';

export interface TranslationChannelError {
  kind: TranslationErrorKind;
  /** 可读原因（不含令牌）。 */
  message: string;
  status: number | null;
}

export class TranslationServerError extends Error {
  readonly kind: TranslationErrorKind;
  readonly status: number | null;

  constructor(kind: TranslationErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'TranslationServerError';
    this.kind = kind;
    this.status = status;
  }
}

export interface TranslationServerOptions {
  /** 端点；缺省时读环境变量，再缺省用本机默认值。 */
  baseUrl?: string;
  /** 令牌；缺省时读环境变量；未配置即不发送令牌头。 */
  token?: string;
  /** 超时毫秒；缺省时读环境变量。 */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** 解析端点（归一化尾部斜杠）。 */
export function resolveTranslationServerUrl(override?: string): string {
  const raw = (override ?? process.env['ZOTERO_MCP_TRANSLATION_SERVER'] ?? DEFAULT_TRANSLATION_SERVER_URL).trim();
  const trimmed = raw.replace(/\/+$/u, '');
  return trimmed.length === 0 ? DEFAULT_TRANSLATION_SERVER_URL : trimmed;
}

/** 解析令牌；未配置返回 null（调用方据此决定是否发送令牌头）。 */
export function resolveTranslationToken(override?: string): string | null {
  const raw = override ?? process.env['ZOTERO_MCP_TRANSLATION_TOKEN'];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function resolveTranslationTimeoutMs(override?: number): number {
  // 显式参数与环境变量走同一套校验：只接受正整数，非法值回落到默认超时
  if (override !== undefined && Number.isFinite(override) && override > 0) return Math.floor(override);
  return readPositiveInt(process.env['ZOTERO_MCP_TRANSLATION_TIMEOUT_MS'], DEFAULT_TRANSLATION_TIMEOUT_MS);
}

function classifyStatus(status: number): TranslationErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'upstream-error';
  return 'invalid-response';
}

function classifyFetchError(error: unknown): TranslationErrorKind {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  return 'unreachable';
}

/** 令牌被回显时的替换占位符。 */
export const REDACTED_TOKEN = '***';

/**
 * 深度脱敏：上游如果把自己的请求头（含令牌）回显进元数据字段，
 * 该值会顺着解析结果进入 ChangePlan、写前快照、dry-run 工具结果与条目字段。
 * 因此在通道出口就把命中的令牌替换掉，凭据绝不进入任何持久化路径。
 */
export function redactTranslationToken(value: unknown, token: string | null | undefined): unknown {
  if (token === null || token === undefined || token.length === 0) return value;
  if (typeof value === 'string') {
    return value.includes(token) ? value.split(token).join(REDACTED_TOKEN) : value;
  }
  if (Array.isArray(value)) return value.map((entry) => redactTranslationToken(entry, token));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const safeKey = key.includes(token) ? key.split(token).join(REDACTED_TOKEN) : key;
      out[safeKey] = redactTranslationToken(entry, token);
    }
    return out;
  }
  return value;
}

export interface TranslationRequestOptions extends TranslationServerOptions {
  /** 请求体：标识符或 URL。 */
  body: string;
  /** 端点路径：`/search` 或 `/web`。 */
  path?: '/search' | '/web';
}

/** 调用 translation-server 并把响应解析成 Zotero 条目数组（原始对象）。 */
export async function requestTranslationItems(
  options: TranslationRequestOptions,
): Promise<{ items: Record<string, unknown>[]; status: number; url: string }> {
  const baseUrl = resolveTranslationServerUrl(options.baseUrl);
  const token = resolveTranslationToken(options.token);
  const timeoutMs = resolveTranslationTimeoutMs(options.timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;
  const path = options.path ?? '/search';
  const url = `${baseUrl}${path}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        accept: 'application/json',
        ...(token === null ? {} : { [TRANSLATION_TOKEN_HEADER]: token }),
      },
      body: options.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const kind = classifyFetchError(error);
    throw new TranslationServerError(
      kind,
      kind === 'timeout'
        ? `translation-server 超时（${timeoutMs}ms）：${url}`
        : `translation-server 不可达：${url}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }

  if (!response.ok) {
    const kind = classifyStatus(response.status);
    // 只回显状态与端点：响应体可能回显请求内容，不放进错误消息
    throw new TranslationServerError(
      kind,
      `translation-server 返回 HTTP ${response.status}：${url}`,
      response.status,
    );
  }

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TranslationServerError('invalid-response', `translation-server 返回的不是 JSON：${url}`);
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const items = list
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    // 令牌脱敏必须发生在解析出口：任何回显都不会流进计划、快照、审计或条目字段
    .map((entry) => redactTranslationToken(entry, token) as Record<string, unknown>);
  if (items.length === 0) {
    throw new TranslationServerError('invalid-response', `translation-server 未返回任何条目：${url}`);
  }
  return { items, status: response.status, url };
}

export interface TranslationProbeResult {
  url: string;
  /** 通道整体可用（= 服务可达且解析可用）。 */
  reachable: boolean;
  /** 服务可达：HTTP 服务有响应（任何状态码都算可达，404 也算）。 */
  serverReachable: boolean;
  serverStatus: number | null;
  /** 可达性探测耗时（毫秒）。 */
  serverLatencyMs: number;
  /** 解析可用：`POST /search` 能返回条目。 */
  resolveAvailable: boolean;
  /** 解析探测的 HTTP 状态与耗时。 */
  status: number | null;
  latencyMs: number;
  /** 是否配置了令牌（**不返回令牌本身**）。 */
  tokenConfigured: boolean;
  timeoutMs: number;
  error: TranslationChannelError | null;
}

/**
 * 只读可达性探测：对端点发一次 GET。
 *
 * translation-server 没有 GET 健康端点，GET 会得到 404；**有响应即说明服务可达**，
 * 这样「服务是否活着」与「解析是否可用」就是两个独立信号，不会把 404 误判成服务不可用。
 */
async function probeReachability(
  baseUrl: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ reachable: boolean; status: number | null; latencyMs: number; error: TranslationChannelError | null }> {
  const started = Date.now();
  try {
    const response = await fetchImpl(baseUrl, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { reachable: true, status: response.status, latencyMs: Date.now() - started, error: null };
  } catch (error) {
    const kind = classifyFetchError(error);
    return {
      reachable: false,
      status: null,
      latencyMs: Date.now() - started,
      error: {
        kind,
        message:
          kind === 'timeout'
            ? `可达性探测超时（${timeoutMs}ms）：${baseUrl}`
            : `translation-server 不可达：${baseUrl}（${error instanceof Error ? error.message : String(error)}）`,
        status: null,
      },
    };
  }
}

/**
 * 只读健康检查（无副作用）：
 * 1) 先对端点发一次 GET 判断「服务可达」（任何状态码都算可达）；
 * 2) 再用一个稳定的公开 DOI 做一次解析式探活，判断「解析可用」。
 *
 * 两步都不写库、不产生审计；端点不可达时返回 reachable=false 与可读原因，不抛异常。
 */
export async function probeTranslationServer(
  options: TranslationServerOptions & { probeIdentifier?: string } = {},
): Promise<TranslationProbeResult> {
  const baseUrl = resolveTranslationServerUrl(options.baseUrl);
  const token = resolveTranslationToken(options.token);
  const timeoutMs = resolveTranslationTimeoutMs(options.timeoutMs);
  const identifier = options.probeIdentifier ?? '10.2307/4486062';
  const fetchImpl = options.fetchImpl ?? fetch;

  const server = await probeReachability(baseUrl, fetchImpl, timeoutMs);
  if (!server.reachable) {
    return {
      url: baseUrl,
      reachable: false,
      serverReachable: false,
      serverStatus: null,
      serverLatencyMs: server.latencyMs,
      resolveAvailable: false,
      status: null,
      latencyMs: 0,
      tokenConfigured: token !== null,
      timeoutMs,
      error: server.error,
    };
  }

  const started = Date.now();
  try {
    const result = await requestTranslationItems({ ...options, body: identifier, path: '/search' });
    return {
      url: baseUrl,
      reachable: true,
      serverReachable: true,
      serverStatus: server.status,
      serverLatencyMs: server.latencyMs,
      resolveAvailable: true,
      status: result.status,
      latencyMs: Date.now() - started,
      tokenConfigured: token !== null,
      timeoutMs,
      error: null,
    };
  } catch (error) {
    const kind = error instanceof TranslationServerError ? error.kind : 'unreachable';
    const status = error instanceof TranslationServerError ? error.status : null;
    return {
      url: baseUrl,
      reachable: false,
      serverReachable: true,
      serverStatus: server.status,
      serverLatencyMs: server.latencyMs,
      resolveAvailable: false,
      status,
      latencyMs: Date.now() - started,
      tokenConfigured: token !== null,
      timeoutMs,
      error: {
        kind,
        message: error instanceof Error ? error.message : String(error),
        status,
      },
    };
  }
}
