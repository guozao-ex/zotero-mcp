/**
 * Local API 错误分类与处理策略。
 *
 * 这里的每一条策略都与路线图「写安全与硬约束 → 错误码语义」表逐条对应，
 * M1 起的通道客户端、Router + Policy 与工具面都必须复用本模块，不再各自定义。
 */

export const ZOTERO_ERROR_CODES = [
  'connection-refused',
  'local-api-disabled',
  'write-unauthorized',
  'version-conflict',
  'missing-server-id',
  'rate-limited',
  'http-error',
] as const;

export type ZoteroErrorCode = (typeof ZOTERO_ERROR_CODES)[number];

export interface ZoteroErrorStrategy {
  /** 处理策略文本（与路线图一致）。 */
  readonly strategy: string;
  /** 修正输入或等待窗口后，是否允许重试同一请求。 */
  readonly retryable: boolean;
  /** 面向用户的下一步提示。 */
  readonly nextSteps: readonly string[];
}

export const LOCAL_API_SETTINGS_HINT =
  '在 Zotero 的 Settings → Advanced 勾选「Allow other applications on this computer to communicate with Zotero」';

export const ERROR_STRATEGIES: Readonly<Record<ZoteroErrorCode, ZoteroErrorStrategy>> = {
  'connection-refused': {
    strategy: 'Zotero 未运行或 23119 无监听：启动 Zotero 后重试，不改变请求内容',
    retryable: true,
    nextSteps: ['启动 Zotero 桌面版', '确认本地 API 开关已勾选后重新探测'],
  },
  'local-api-disabled': {
    strategy: '明确提示用户开启本地 API，不重试',
    retryable: false,
    nextSteps: [LOCAL_API_SETTINGS_HINT],
  },
  'write-unauthorized': {
    strategy: '重新走一次运行时授权，复用已生成的 ChangePlan，不重建计划',
    retryable: true,
    nextSteps: ['在 Zotero 授权弹窗中选择 Allow（建议 Always Allow）', '复用当前 ChangePlan 重新提交，不重建计划'],
  },
  'version-conflict': {
    strategy: '重新拉取对象 → 重新生成计划 → 重新 dry-run，绝不盲目重试',
    retryable: false,
    nextSteps: ['重新拉取受影响对象的当前版本', '重建 ChangePlan 并重新 dry-run 预览'],
  },
  'missing-server-id': {
    strategy: '注入缓存的 serverID 后重试一次',
    retryable: true,
    nextSteps: ['运行 node scripts/probe.mjs 取得 serverID', '写请求统一携带 Zotero-Server-ID'],
  },
  'rate-limited': {
    strategy: '停止写会话，等待窗口恢复；写操作聚合后再提交',
    retryable: true,
    nextSteps: ['暂停写入（授权弹窗限流为 5 次/分钟）', '把待写变更聚合成一次授权 + 批量提交'],
  },
  'http-error': {
    strategy: '记录状态码与响应体，交由上层决定',
    retryable: false,
    nextSteps: ['核对 Zotero 版本与本地 API 文档', '保留原始响应用于排查'],
  },
};

/** 通道层向上抛出的统一错误：错误码稳定，策略与提示可直接展示给用户。 */
export class ZoteroChannelError extends Error {
  readonly code: ZoteroErrorCode;
  readonly status: number | null;
  readonly strategy: string;
  readonly retryable: boolean;
  readonly nextSteps: readonly string[];
  readonly url: string | null;

  constructor(
    code: ZoteroErrorCode,
    message: string,
    options: { status?: number | null; url?: string | null; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ZoteroChannelError';
    this.code = code;
    this.status = options.status ?? null;
    this.url = options.url ?? null;
    const strategy = ERROR_STRATEGIES[code];
    this.strategy = strategy.strategy;
    this.retryable = strategy.retryable;
    this.nextSteps = strategy.nextSteps;
  }
}

/** 把 HTTP 状态码映射为稳定错误码；未知状态归入 `http-error`。 */
export function classifyStatus(status: number): ZoteroErrorCode {
  switch (status) {
    case 401:
      return 'write-unauthorized';
    case 403:
      return 'local-api-disabled';
    case 412:
      return 'version-conflict';
    case 428:
      return 'missing-server-id';
    case 429:
      return 'rate-limited';
    default:
      return 'http-error';
  }
}

/** 把 fetch 抛出的底层错误映射为稳定错误码。 */
export function classifyFetchError(error: unknown): ZoteroErrorCode {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND') {
    return 'connection-refused';
  }
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'connection-refused';
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/fetch failed|ECONNREFUSED|connect/i.test(message)) {
    return 'connection-refused';
  }
  return 'http-error';
}

export interface ZoteroErrorDescriptor {
  readonly code: ZoteroErrorCode;
  readonly status: number | null;
  readonly message: string;
  readonly strategy: string;
  readonly retryable: boolean;
  readonly nextSteps: readonly string[];
}

/** 组合错误码、状态码与可读信息，便于 CLI 与工具面直接输出。 */
export function describeError(
  code: ZoteroErrorCode,
  options: { status?: number | null; message?: string } = {},
): ZoteroErrorDescriptor {
  const strategy = ERROR_STRATEGIES[code];
  const status = options.status ?? null;
  return {
    code,
    status,
    message: options.message ?? (status === null ? code : `HTTP ${status} → ${code}`),
    strategy: strategy.strategy,
    retryable: strategy.retryable,
    nextSteps: strategy.nextSteps,
  };
}
