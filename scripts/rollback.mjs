#!/usr/bin/env node
/**
 * 1 条指令回滚（路线图成功标准 5）。
 *
 *   npm run rollback -- --snapshot .audit/snapshots/<planId>.json           # 预览（默认，只读）
 *   ZOTERO_MCP_WRITE=on npm run rollback -- --snapshot <file> --commit      # 真正回滚（一次授权 + 审计）
 *
 * 预览只发 GET：打印将写回写前值的对象与字段差异、以及将被永久删除的「本计划创建」对象。
 * 提交复用写管线的 `rollbackFromSnapshot`，因此同样受写总闸约束并写审计。
 */

import {
  buildRollbackPlan,
  isWriteEnabled,
  parseRollbackArgs,
  renderRollbackPlan,
  resolveAuditDir,
  rollbackFromSnapshot,
} from '../packages/core/src/index.ts';

async function main() {
  const parsed = parseRollbackArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`参数错误：${parsed.reason}`);
    return 2;
  }
  const { snapshotPath, commit } = parsed.args;

  let planned;
  try {
    planned = await buildRollbackPlan(snapshotPath);
  } catch (error) {
    console.error(`无法回滚：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!planned.ok) {
    console.error(`无法回滚：${planned.reason}`);
    return 1;
  }
  console.log(renderRollbackPlan(planned.plan));
  console.log('');

  if (!commit) {
    console.log(`预览完成：未写入任何数据。写开关 ZOTERO_MCP_WRITE=${process.env.ZOTERO_MCP_WRITE ?? '(未设置)'}。`);
    console.log('加 --commit（且 ZOTERO_MCP_WRITE=on）才会真正回滚。');
    return 0;
  }

  if (!isWriteEnabled()) {
    console.error('默认只读：ZOTERO_MCP_WRITE 未设置为 on，已拒绝回滚（库未被改动）。');
    return 1;
  }

  try {
    const result = await rollbackFromSnapshot(snapshotPath, { write: true, auditDir: resolveAuditDir() });
    console.log(
      `回滚完成：写回 ${result.restored.length} 条${result.restored.length > 0 ? `（${result.restored.join(', ')}）` : ''}，永久删除 ${result.removed.length} 条${result.removed.length > 0 ? `（${result.removed.join(', ')}）` : ''}`,
    );
    console.log(`  审计：${result.auditPath}`);
    return 0;
  } catch (error) {
    console.error(`回滚失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// 不用 process.exit()：带着未关闭的 fetch/undici 句柄退出会在 Windows 上打出
// 无意义的 libuv 断言噪音；设置 exitCode 让进程自然结束即可。
process.exitCode = await main();
