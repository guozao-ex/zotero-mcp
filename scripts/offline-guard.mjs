/**
 * 进程级禁网守卫（路线图成功标准 1 的可重跑证据）。
 *
 * 用 `node --import ./scripts/offline-guard.mjs <入口>` 预加载：把 `globalThis.fetch`
 * 换成只放行**回环地址**的版本，任何指向非回环主机的请求都会在发出之前被拒绝并记账。
 *
 * 这是**进程级禁网替身**，不是物理断网：它证明「核心路径不需要非回环网络」，
 * 但不能证明网卡被拔掉时的行为。脚本与报告都必须如实这样表述。
 */

import { appendFileSync } from 'node:fs';

import { isLoopbackUrl } from '../packages/core/src/paths.ts';

/**
 * 被拦截的非回环请求。因为守卫跑在**子进程**里，除了内存里的清单，还按
 * `ZOTERO_MCP_OFFLINE_LOG` 指定的文件逐条追加，供父进程核对（正常应为空文件）。
 */
export const blockedRequests = [];

function record(url) {
  blockedRequests.push(url);
  const logPath = process.env['ZOTERO_MCP_OFFLINE_LOG'];
  if (logPath !== undefined && logPath.length > 0) {
    try {
      appendFileSync(logPath, `${url}${String.fromCharCode(10)}`, 'utf8');
    } catch {
      // 记账失败不应影响被验证的进程
    }
  }
}

const realFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input?.url ?? input);
  let loopback = false;
  try {
    loopback = isLoopbackUrl(url);
  } catch {
    loopback = false;
  }
  if (!loopback) {
    record(url);
    throw new Error(`进程级禁网：拒绝非回环请求 ${url}`);
  }
  return await realFetch(input, init);
};

// 供验证脚本通过全局句柄读取被拦截清单（子进程边界之外也能看到）
globalThis.__offlineGuard = { blockedRequests };
