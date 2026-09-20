/**
 * Local API 的 zod 契约层。
 *
 * 契约先行：M1 起的通道客户端、Router + Policy、工具面与 Zotero 插件侧
 * 都从这里取类型与校验规则；JSON Schema 由 zod 自带能力导出，不引入额外依赖。
 */

import { z } from 'zod';
import { ZOTERO_ERROR_CODES } from './errors.ts';

/** 响应头缺失时的占位值：缺失不等于异常，探针要能继续给出结论。 */
export const UNKNOWN_HEADER_VALUE = 'unknown';

/** 需要解析的三个 Local API 响应头（HTTP 头名小写）。 */
export const ZOTERO_HEADER_NAMES = {
  apiVersion: 'zotero-api-version',
  serverId: 'zotero-server-id',
  schemaVersion: 'zotero-schema-version',
} as const;

export const zoteroHeadersSchema = z.object({
  apiVersion: z.string().min(1),
  serverId: z.string().min(1),
  schemaVersion: z.string().min(1),
});

export const zoteroErrorCodeSchema = z.enum(ZOTERO_ERROR_CODES);

export const probeResultSchema = z.object({
  /** 23119 是否有服务响应。 */
  reachable: z.boolean(),
  /** 探测请求实际得到的 HTTP 状态码；连接失败为 null。 */
  statusCode: z.number().int().nullable(),
  apiVersion: z.string().min(1),
  serverId: z.string().min(1),
  schemaVersion: z.string().min(1),
  /** 是否具备写入条件（本地 API 可达且已取得 serverID）。 */
  writeAvailable: z.boolean(),
  errorCode: zoteroErrorCodeSchema.nullable(),
  reason: z.string().nullable(),
  /** 按 serverID 分区的缓存路径；未取得 serverID 时为 null。 */
  cachePath: z.string().nullable(),
  nextSteps: z.array(z.string()),
  /** 实际探测的完整 URL。 */
  target: z.string(),
  probedAt: z.string(),
});

export type ZoteroHeaders = z.infer<typeof zoteroHeadersSchema>;
export type ProbeResult = z.infer<typeof probeResultSchema>;
export type ZoteroErrorCodeValue = z.infer<typeof zoteroErrorCodeSchema>;

/** 从响应头解析 Zotero 元信息；缺失一律返回 unknown，不抛异常。 */
export function readZoteroHeaders(headers: Headers): ZoteroHeaders {
  const read = (name: string): string => {
    const value = headers.get(name);
    return value === null || value.trim().length === 0 ? UNKNOWN_HEADER_VALUE : value.trim();
  };
  return {
    apiVersion: read(ZOTERO_HEADER_NAMES.apiVersion),
    serverId: read(ZOTERO_HEADER_NAMES.serverId),
    schemaVersion: read(ZOTERO_HEADER_NAMES.schemaVersion),
  };
}

/** 需要与插件侧共享的契约（key 即导出文件名）。 */
export const JSON_SCHEMA_EXPORTS = {
  'probe-result': probeResultSchema,
  'zotero-headers': zoteroHeadersSchema,
} as const;

export type JsonSchemaExportName = keyof typeof JSON_SCHEMA_EXPORTS;

/** 用 zod 自带能力导出 JSON Schema（draft 2020-12）。 */
export function exportJsonSchemas(): Record<JsonSchemaExportName, unknown> {
  const exported = {} as Record<JsonSchemaExportName, unknown>;
  for (const name of Object.keys(JSON_SCHEMA_EXPORTS) as JsonSchemaExportName[]) {
    exported[name] = z.toJSONSchema(JSON_SCHEMA_EXPORTS[name], { target: 'draft-2020-12' });
  }
  return exported;
}
