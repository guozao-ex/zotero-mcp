#!/usr/bin/env node
/**
 * translation-server 通道探针（只读）。
 *
 * 用法：
 *   node scripts/probe-translation.mjs                     # 默认端点 + 默认探活标识符
 *   node scripts/probe-translation.mjs --identifier 10.1000/xyz
 *   node scripts/probe-translation.mjs --url https://example.com/article   # 额外演示 /web
 *   node scripts/probe-translation.mjs --allow-missing     # 端点不可达时也返回退出码 0
 *
 * 端点/令牌/超时分别来自 `ZOTERO_MCP_TRANSLATION_SERVER` / `ZOTERO_MCP_TRANSLATION_TOKEN` /
 * `ZOTERO_MCP_TRANSLATION_TIMEOUT_MS`；令牌只以「是否已配置」的形式呈现，绝不回显。
 */

import {
  probeTranslationServer,
  requestTranslationItems,
} from '../packages/core/src/index.ts';

const argv = process.argv.slice(2);
const allowMissing = argv.includes('--allow-missing');
const valueOf = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
};
const identifier = valueOf('--identifier');
const webUrl = valueOf('--url');

console.log('translation-server 通道检查');
const probe = await probeTranslationServer(identifier === undefined ? {} : { probeIdentifier: identifier });
console.log(`  端点：${probe.url}`);
console.log(`  令牌：${probe.tokenConfigured ? '已配置（值不显示）' : '未配置'}`);
console.log(`  超时：${probe.timeoutMs}ms`);
console.log(
  `  服务可达：${probe.serverReachable ? '是' : '否'}` +
    `${probe.serverStatus === null ? '' : `（HTTP ${probe.serverStatus}）`}　耗时：${probe.serverLatencyMs}ms`,
);
console.log(
  `  解析可用：${probe.resolveAvailable ? '是' : '否'}` +
    `${probe.status === null ? '' : `（HTTP ${probe.status}）`}　耗时：${probe.latencyMs}ms`,
);
console.log(`  可达：${probe.reachable ? '是' : '否'}`);

if (!probe.reachable) {
  console.log(`  原因：[${probe.error?.kind ?? 'unknown'}] ${probe.error?.message ?? '未知原因'}`);
  if (probe.serverReachable && !probe.resolveAvailable) {
    console.log('  注意：服务是活的，但解析不可用（令牌不对、上游被限流或缺依赖都可能）——通道仍会按降级处理。');
  }
  console.log('');
  console.log('端点不可达时的处理：');
  console.log('  · 本机部署：docker compose -f deploy/translation-server/docker-compose.yml up -d');
  console.log('  · 云端部署：见 docs/DEPLOY_REMOTE.md（并把端点与令牌写进环境变量）');
  console.log('  · 暂不部署：标识符解析会自动回退直连 Crossref / OpenLibrary / PubMed，功能不受阻');
  process.exitCode = allowMissing ? 0 : 1;
} else {
  console.log(`  标识符解析：${identifier ?? '10.2307/4486062'} 探活成功（通道 translation-server）`);
  console.log('  说明：可达性探测只发 GET（无副作用）；解析探活用一次只读 POST /search，不写库。');
  if (webUrl !== undefined) {
    try {
      const web = await requestTranslationItems({ body: webUrl, path: '/web' });
      const first = web.items[0] ?? {};
      console.log(`  /web 解析：${web.items.length} 条，首条标题 ${String(first['title'] ?? '（无标题）')}`);
    } catch (error) {
      console.log(`  /web 解析失败：${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
