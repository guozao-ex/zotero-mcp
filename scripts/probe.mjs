#!/usr/bin/env node
/**
 * 环境探针：确认本机 Zotero 本地 API 的可用性与写入条件。
 *
 * 退出码：
 *   0  探测本身成功（无论 Zotero 是否可用）
 *   1  探测失败（参数错误或内部异常）
 *   2  --strict 且当前环境不可用（Zotero 未运行，或本地 API 未开启/不可写）
 */

import { DEFAULT_LOCAL_API_BASE, DEFAULT_PROBE_TIMEOUT_MS, probeLocalApi } from '../packages/core/src/index.ts';

const USAGE = `用法：node scripts/probe.mjs [选项]

选项：
  --json               输出机器可读的单个 JSON 对象
  --strict             环境不可用时以退出码 2 结束
  --url <url>          本地 API 根地址（只允许回环地址，默认 ${DEFAULT_LOCAL_API_BASE}）
  --timeout <ms>       探测超时毫秒数（默认 ${DEFAULT_PROBE_TIMEOUT_MS}）
  --cache-dir <path>   缓存根目录（默认环境变量 ZOTERO_MCP_CACHE_DIR 或 ./cache）
  -h, --help           显示本帮助

退出码：0 探测成功；1 参数或内部错误；2 --strict 且环境不可用`;

function parseArgs(argv) {
  const options = { json: false, strict: false, url: undefined, timeoutMs: undefined, cacheDir: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--url') options.url = argv[++index];
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++index]);
    else if (arg === '--cache-dir') options.cacheDir = argv[++index];
    else throw new Error(`未知参数：${arg}`);
  }
  if (options.url !== undefined && options.url.length === 0) throw new Error('--url 需要非空值');
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error('--timeout 需要正数毫秒值');
  }
  return options;
}

const OK = '✓';
const NG = '✗';

function printHuman(result) {
  const line = (label, value) => console.log(`  ${label.padEnd(14, ' ')}${value}`);
  console.log('Zotero 本地 API 探测');
  line('目标', result.target);
  line('可达', `${result.reachable ? OK : NG} ${result.reachable ? '是' : '否'}`);
  line('HTTP 状态', result.statusCode === null ? '—' : String(result.statusCode));
  line('serverID', result.serverId);
  line('schemaVersion', result.schemaVersion);
  line('API 版本', result.apiVersion);
  line('可写', `${result.writeAvailable ? OK : NG} ${result.writeAvailable ? '是' : '否'}`);
  line('缓存路径', result.cachePath ?? '—');
  line('原因', result.reason ?? '—');
  if (result.nextSteps.length > 0) {
    console.log('  下一步');
    for (const step of result.nextSteps) console.log(`    - ${step}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const result = await probeLocalApi({
    baseUrl: options.url,
    timeoutMs: options.timeoutMs,
    cacheDir: options.cacheDir,
  });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  if (options.strict && (!result.reachable || !result.writeAvailable)) return 2;
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`探针失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
