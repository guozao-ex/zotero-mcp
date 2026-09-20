/**
 * 云端 Web API 通道配置（change `web-api-write-fallback`）。
 *
 * 路线图 G3 的降级要「未装插件时改走 Web API 写」，而成功标准 1 是「断网可用、零 API Key」。
 * 两者的调和办法：**云端通道默认不存在**，只有用户显式配置时才成为回退链的一级。
 *
 * 凭证来源（按优先级）：
 *   1. 环境变量 `ZOTERO_MCP_WEB_API_KEY` + `ZOTERO_MCP_WEB_API_LIBRARY`；
 *   2. `<Zotero 数据目录>/zoteromcp-web-api.json`，形如
 *      `{ "apiKey": "…", "library": "users/1234567" }`（`groups/<id>` 亦可）。
 *
 * 不变量：
 *   - **未配置时零外呼**：本模块只读环境变量与本地文件，绝不发请求；
 *   - **半配置不算配置**：缺 key 或缺 library 一律按「未配置」处理并给出可读原因
 *     （fail-closed，不做「有 key 但不知道写哪个库」的猜测）；
 *   - **绝不回显 key**：返回值里只允许出现来源标识与掩码，完整 key 只存在于闭包内部。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveDataDir } from './client-channel.ts';

/** 云端 Web API 基础地址（与 `api.zotero.org` 一致，便于测试注入替身）。 */
export const DEFAULT_WEB_API_BASE = 'https://api.zotero.org';

/** 凭证文件名（位于 Zotero 数据目录下；该文件名必须在 `.gitignore` 内）。 */
export const WEB_API_CREDENTIALS_FILENAME = 'zoteromcp-web-api.json';

export const WEB_API_KEY_ENV = 'ZOTERO_MCP_WEB_API_KEY';
export const WEB_API_LIBRARY_ENV = 'ZOTERO_MCP_WEB_API_LIBRARY';

/** 库前缀：`users/<id>` 或 `groups/<id>`。 */
export type WebApiLibrary = `users/${string}` | `groups/${string}`;

export interface WebApiConfigured {
  configured: true;
  /** 完整 key：只在进程内传递，**绝不**进入结果、审计或日志。 */
  apiKey: string;
  library: WebApiLibrary;
  /** 来源标识（`env` / `file`），用于如实回报「配置从哪来」。 */
  source: 'env' | 'file';
  /** 掩码形式（前 4 位 + 长度），可在结果里安全展示。 */
  maskedKey: string;
}

export interface WebApiNotConfigured {
  configured: false;
  /** 为什么算「未配置」（可读原因，不含任何 key 内容）。 */
  reason: string;
  /** 配置文件路径（供提示用户放哪里），不表示该文件存在。 */
  credentialsPath: string;
}

export type WebApiConfig = WebApiConfigured | WebApiNotConfigured;

export interface WebApiConfigOptions {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
}

/** key 掩码：前 4 位 + 总长度。key 短于 8 位时不展示任何前缀。 */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return '(空)';
  if (trimmed.length < 8) return `(已配置，长度 ${trimmed.length})`;
  return `${trimmed.slice(0, 4)}…(长度 ${trimmed.length})`;
}

export function webApiCredentialsPath(dataDir?: string, env?: NodeJS.ProcessEnv): string {
  return join(resolveDataDir(dataDir, env), WEB_API_CREDENTIALS_FILENAME);
}

const LIBRARY_PATTERN = /^(users|groups)\/[A-Za-z0-9]+$/u;

function asLibrary(value: unknown): WebApiLibrary | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return LIBRARY_PATTERN.test(trimmed) ? (trimmed as WebApiLibrary) : null;
}

function configured(apiKey: string, library: WebApiLibrary, source: 'env' | 'file'): WebApiConfigured {
  return { configured: true, apiKey, library, source, maskedKey: maskApiKey(apiKey) };
}

function notConfigured(reason: string, credentialsPath: string): WebApiNotConfigured {
  return { configured: false, reason, credentialsPath };
}

/**
 * 解析云端 Web API 配置。
 *
 * 只读环境变量与本地文件；**任何情况下都不发网络请求**，因此「未配置」不会带来任何外呼。
 */
export function resolveWebApiConfig(options: WebApiConfigOptions = {}): WebApiConfig {
  const env = options.env ?? process.env;
  // env 一路透传：只注入 env 时也要用它的 ZOTERO_MCP_DATA_DIR，否则凭证路径会回落到真实数据目录
  const credentialsPath = webApiCredentialsPath(options.dataDir, env);

  const envKey = (env[WEB_API_KEY_ENV] ?? '').trim();
  const envLibrary = asLibrary(env[WEB_API_LIBRARY_ENV]);
  if (envKey.length > 0 || (env[WEB_API_LIBRARY_ENV] ?? '').trim().length > 0) {
    // 环境变量一旦出现就按环境变量口径判定：半配置是错误配置，不是「回落到文件」
    if (envKey.length === 0) {
      return notConfigured(`环境变量 ${WEB_API_KEY_ENV} 为空：云端通道未启用`, credentialsPath);
    }
    if (envLibrary === null) {
      return notConfigured(
        `环境变量 ${WEB_API_LIBRARY_ENV} 缺失或非法（需形如 users/<id> 或 groups/<id>）：云端通道未启用`,
        credentialsPath,
      );
    }
    return configured(envKey, envLibrary, 'env');
  }

  let raw: string;
  try {
    raw = readFileSync(credentialsPath, 'utf8');
  } catch {
    return notConfigured(
      `未配置云端凭证（既无 ${WEB_API_KEY_ENV} 环境变量，也没有 ${credentialsPath}）：云端通道未启用`,
      credentialsPath,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return notConfigured(`云端凭证文件不是合法 JSON：${credentialsPath}（内容未被回显）`, credentialsPath);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return notConfigured(`云端凭证文件应为 JSON 对象：${credentialsPath}（内容未被回显）`, credentialsPath);
  }

  const record = parsed as Record<string, unknown>;
  const fileKey = typeof record['apiKey'] === 'string' ? record['apiKey'].trim() : '';
  const fileLibrary = asLibrary(record['library']);
  if (fileKey.length === 0) {
    return notConfigured(`云端凭证文件缺少 apiKey 字段：${credentialsPath}（内容未被回显）`, credentialsPath);
  }
  if (fileLibrary === null) {
    return notConfigured(
      `云端凭证文件的 library 字段缺失或非法（需形如 users/<id> 或 groups/<id>）：${credentialsPath}`,
      credentialsPath,
    );
  }
  return configured(fileKey, fileLibrary, 'file');
}

/**
 * 生成配置说明（供工具结果与 CLI 打印）。**只含路径与字段名，不含任何凭证内容**。
 */
export function webApiSetupHint(config: WebApiNotConfigured): string {
  return [
    `云端 Web API 通道未启用：${config.reason}`,
    '启用方法（二选一）：',
    `  1. 环境变量：${WEB_API_KEY_ENV}=<你的 zotero.org API Key>、${WEB_API_LIBRARY_ENV}=users/<你的 userID>（组库用 groups/<组ID>）；`,
    `  2. 本地文件：把 {"apiKey":"<你的 API Key>","library":"users/<你的 userID>"} 写入 ${config.credentialsPath}（该文件名已在 .gitignore 内）。`,
    '注意：未配置时默认路径不会向 api.zotero.org 发出任何请求；凭证不要写进仓库，也不要贴进对话。',
  ].join('\n');
}
