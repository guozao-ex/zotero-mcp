#!/usr/bin/env node
/**
 * 回填注释页标签（写路径）——G2 真导入后的补丁。
 *
 * 用法：
 *   npm run backfill:annotation-labels -- --from <源附件/条目> --to <目标附件/条目>            # dry-run（零写请求）
 *   ZOTERO_MCP_WRITE=on npm run backfill:annotation-labels -- --from <源> --to <目标> --write  # 真写（会弹授权确认）
 *
 * 匹配规则：**正文 + 页索引（annotationPosition.pageIndex）**；匹配不到、源无页标签、目标已是同值都会逐条打印。
 * 真写走既有写安全管线（Zotero-Server-ID、If-Unmodified-Since-Version、授权、审计、失败关闭），
 * 覆盖已有值的计划需要确认关键词 OVERWRITE（本脚本在 --write 时自动带上，因为它只回填「空或不同」的标签）。
 */

import { LABEL_BACKFILL_CONFIRM, applyAnnotationLabelBackfill, planAnnotationLabelBackfill, probeLocalApi } from '../packages/core/src/index.ts';

async function main() {
const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : argv[index + 1] ?? null;
};
const from = value('from');
const to = value('to');
const write = argv.includes('--write');
const confirm = value('confirm');
const auditDir = value('audit-dir');

if (from === null || to === null) {
  console.error('用法：npm run backfill:annotation-labels -- --from <源附件或条目> --to <目标附件或条目> [--write] [--audit-dir <dir>]');
  return 2;
}

const probe = await probeLocalApi();
if (!probe.reachable) {
  console.error(`本地 API 不可用：${probe.reason ?? '未知原因'}（请启动 Zotero 并确认允许其它应用通信）`);
  return 1;
}

const backfill = await planAnnotationLabelBackfill({ from, to });
console.log('注释页标签回填计划（按「正文 + 页索引」匹配）');
console.log(`  源附件：${backfill.fromAttachmentKey}`);
console.log(`  目标附件：${backfill.toAttachmentKey}`);
console.log(`  待回填：${backfill.pairs.length} 条`);
for (const pair of backfill.pairs) {
  console.log(`    ${pair.targetKey}  第${pair.pageIndex + 1}页  "${pair.before ?? ''}" → "${pair.after}"   正文：${pair.text}`);
}
for (const item of backfill.unchanged) console.log(`  · 跳过 ${item.targetKey}：${item.reason}`);
for (const item of backfill.unmatched) console.log(`  · 跳过源注释 ${item.sourceKey}：${item.reason}`);
console.log(`  计划 id：${backfill.plan.id}${backfill.plan.destructive ? `（覆盖已有值，确认关键词 ${backfill.plan.confirmKeyword}）` : ''}`);

if (backfill.plan.destructive && confirm !== LABEL_BACKFILL_CONFIRM) {
  console.error('');
  console.error(`该计划会**覆盖目标已有的非空页标签**（${backfill.plan.confirmKeyword} 是确认关键词）。`);
  console.error(`如确认要覆盖，请显式加上 --confirm ${backfill.plan.confirmKeyword} 后重跑。`);
  return 1;
}

if (!write) {
  console.log('');
  console.log('这是 dry-run：未发出任何写请求。要真写请加 --write（并确保 ZOTERO_MCP_WRITE=on）。');
  if (backfill.plan.destructive) console.log(`注意：该计划为破坏性（覆盖已有值），真写时还需 --confirm ${backfill.plan.confirmKeyword}。`);
  return 0;
}

const result = await applyAnnotationLabelBackfill(backfill, {
  write: true,
  confirm: confirm ?? '',
  ...(auditDir === null ? {} : { auditDir }),
});
console.log('');
console.log(`已回填 ${backfill.pairs.length} 条注释页标签（计划 ${backfill.plan.id}）`);
console.log(`  审计：${result.auditPath}`);
console.log(`  快照：${result.snapshotPath}`);
console.log(`  授权次数：${result.authorizeCount}｜版本冲突重试：${result.conflictRetries}`);
for (const entry of result.results) console.log(`  ${entry.status === 'updated' ? '✔' : '✖'} ${entry.key} ${entry.status}（version ${entry.version ?? '?'}）`);
  return 0;
}

process.exitCode = await main();
