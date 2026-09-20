/**
 * 路径与回环约束。
 *
 * Local API 的版本号是「本机」的：Zotero 10+ 的 version / Last-Modified-Version / ?since=
 * 与 Web API 完全无关，因此缓存必须按 serverID 分区，避免不同库之间串用版本号。
 */

import { isAbsolute, join, resolve } from 'node:path';

/** 本地 API 默认地址（只允许回环）。 */
export const DEFAULT_LOCAL_API_BASE = 'http://127.0.0.1:23119';

/** 默认缓存目录名（相对当前工作目录）。 */
export const DEFAULT_CACHE_DIRNAME = 'cache';

/** 默认审计目录名（相对当前工作目录）：快照 + 审计 JSONL 的落点。 */
export const DEFAULT_AUDIT_DIRNAME = '.audit';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 判断 URL 是否指向回环地址。 */
export function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return LOOPBACK_HOSTNAMES.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** 非回环地址直接拒绝：本地 API 读请求免认证，暴露即文库泄露。 */
export function assertLoopbackUrl(url: string): void {
  if (!isLoopbackUrl(url)) {
    throw new Error(`只允许访问回环地址，收到：${url}`);
  }
}

/** 统一把路径分隔符规范为 POSIX，便于跨平台比对与展示。 */
export function toPosixPath(path: string): string {
  return path.replaceAll('\\', '/');
}

/**
 * 解析通道基地址：显式参数 > 环境变量 ZOTERO_MCP_BASE_URL > 默认回环地址。
 * 非回环地址一律拒绝。
 */
export function resolveBaseUrl(override?: string): string {
  const value = override ?? process.env['ZOTERO_MCP_BASE_URL'] ?? DEFAULT_LOCAL_API_BASE;
  assertLoopbackUrl(value);
  return value;
}

/** 解析超时毫秒数：显式参数 > 环境变量 ZOTERO_MCP_TIMEOUT_MS > undefined（由调用方使用默认值）。 */
export function resolveTimeoutMs(override?: number): number | undefined {
  if (override !== undefined) return override;
  const raw = process.env['ZOTERO_MCP_TIMEOUT_MS'];
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** 解析缓存根目录：显式参数 > 环境变量 ZOTERO_MCP_CACHE_DIR > 当前目录下的 cache/。 */
export function resolveCacheDir(cacheDir?: string): string {
  const configured = cacheDir ?? process.env['ZOTERO_MCP_CACHE_DIR'] ?? DEFAULT_CACHE_DIRNAME;
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

/** 解析审计目录：显式参数 > 环境变量 ZOTERO_MCP_AUDIT_DIR > 当前目录下的 .audit/。 */
export function resolveAuditDir(auditDir?: string): string {
  const configured = auditDir ?? process.env['ZOTERO_MCP_AUDIT_DIR'] ?? DEFAULT_AUDIT_DIRNAME;
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

/**
 * 按 serverID 分区的缓存路径；未取得 serverID 时返回 null。
 * 该函数只计算路径，不创建目录。
 */
export function serverCachePath(serverId: string | null | undefined, cacheDir?: string): string | null {
  if (serverId === null || serverId === undefined || serverId.length === 0 || serverId === 'unknown') {
    return null;
  }
  return toPosixPath(join(resolveCacheDir(cacheDir), serverId));
}
