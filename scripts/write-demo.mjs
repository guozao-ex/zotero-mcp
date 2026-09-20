#!/usr/bin/env node
/**
 * 真机写入 + 回滚演示（路线图 M2 退出条件：≥20 个字段变更 + 回滚）。
 *
 * **只动一次性测试条目**：脚本自己创建测试条目、在它们身上做字段覆盖、再回滚并清理，
 * 既有文献全程只读（数据安全铁律：真机演示不得改动既有条目）。
 *
 *   1. 记录基线（既有顶层条目的 key/version/字段指纹）；
 *   2. 计划 A：创建 3 条一次性测试条目（一次授权）；
 *   3. 计划 B：对它们做 21 处字段覆盖（7 字段 × 3 条，一次授权）→ 回读校验 → 按快照回滚；
 *   4. 清理：回滚计划 A 的快照（永久删除这 3 条测试条目）；
 *   5. 复核基线未变，并打印每次授权的次数、快照与审计路径。
 *
 * 计划 A / 计划 B 各自带一条**可证伪**的 `authorizeCount === 1` 断言：不满足即走既有失败
 * 路径把退出码置为非零（不能只把授权次数打印出来当证据）。
 *
 * 默认只做 dry-run 预览（零写请求）；加 --apply 才真实提交，会触发 Zotero 授权弹窗
 * （共 4 次：创建、覆盖、回滚覆盖、清理），请在弹框里点 Allow。
 * `--fake` 用内置假服务器离线演练同一流程（不碰真实库）。
 *
 * 通道地址走统一解析（显式 > `ZOTERO_MCP_BASE_URL` > 默认回环地址），因此可以指向
 * 任意回环端口上的服务。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyPlan,
  buildChangePlan,
  getItems,
  isWriteEnabled,
  makeChangePlan,
  previewPlan,
  resolveAuditDir,
  resolveBaseUrl,
  rollbackFromSnapshot,
} from '../packages/core/src/index.ts';
import { startFakeZotero } from './fake-zotero.mjs';

const apply = process.argv.includes('--apply');
const useFake = process.argv.includes('--fake');
const FIELDS = ['extra', 'language', 'rights', 'shortTitle', 'place', 'publisher', 'series'];
const TEST_ITEM_COUNT = 3;
const STAMP = `zotero-mcp-write-demo-${Date.now()}`;

let fake = null;
let auditDir = resolveAuditDir();
let temporaryAudit = null;

if (useFake) {
  fake = await startFakeZotero({ mode: 'ok', port: 0 });
  temporaryAudit = mkdtempSync(join(tmpdir(), 'zotero-mcp-demo-audit-'));
  auditDir = temporaryAudit;
  process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
}

const baseUrl = resolveBaseUrl();
const channel = { baseUrl };
const env = { ...process.env, ZOTERO_MCP_WRITE: 'on' };

async function topLevel() {
  const response = await fetch(`${baseUrl}/api/users/0/items/top?limit=100`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`GET /items/top 返回 HTTP ${response.status}`);
  return await response.json();
}

function fingerprint(items) {
  return items
    .map((item) => `${item.key}@v${item.version}:${JSON.stringify(item.data)}`)
    .sort()
    .join('|');
}

console.log(`基地址：${baseUrl}`);
console.log(`审计目录：${auditDir}`);
console.log(`写开关 ZOTERO_MCP_WRITE=${process.env.ZOTERO_MCP_WRITE ?? '(未设置)'} → ${isWriteEnabled(env) ? 'on' : 'off'}`);
console.log(`字段：${FIELDS.join(', ')}（每条约 ${FIELDS.length} 处变更，共 ${FIELDS.length * TEST_ITEM_COUNT} 处）`);
console.log('');

const baseline = await topLevel();
const baselineFingerprint = fingerprint(baseline);
console.log(`基线：既有顶层条目 ${baseline.length} 条（本演示全程只读它们）`);

const createPlan = makeChangePlan({
  targetKeys: [],
  changes: [],
  operations: Array.from({ length: TEST_ITEM_COUNT }, (_, index) => ({
    kind: 'create',
    itemType: 'journalArticle',
    fields: {
      title: `${STAMP} #${index + 1}`,
      date: '2026',
      extra: STAMP,
      publicationTitle: 'Zotero MCP Write Demo',
    },
  })),
  summary: `新建 ${TEST_ITEM_COUNT} 条一次性测试条目`,
  destructive: false,
});

if (!apply) {
  console.log('计划 A（创建一次性测试条目）：');
  console.log(previewPlan(createPlan));
  const sample = baseline[0];
  if (sample !== undefined) {
    const updateDry = await buildChangePlan({
      ...channel,
      updates: FIELDS.map((field) => ({ key: sample.key, field, value: `mcp-demo-${field}` })),
    });
    console.log('');
    console.log(`计划 B 形态（字段覆盖；这里只读地拿既有条目 ${sample.key} 演示一处 diff，正式提交在创建之后对新条目做）：`);
    console.log(previewPlan(updateDry));
  }
  console.log('');
  console.log('dry-run 完成：未写入任何数据。加 --apply 才会真实提交（会触发 Zotero 授权弹窗）。');
} else {
  if (!isWriteEnabled(env)) {
    console.error('默认只读：ZOTERO_MCP_WRITE 未设置为 on，已拒绝写入（库未被改动）。');
    process.exit(1);
  }

  let created = [];
  let cleanupA = null;
  let failed = false;
  try {
    // ── 计划 A：创建一次性测试条目 ─────────────────────────────────────────
    const applied = await applyPlan(createPlan, { ...channel, write: true, auditDir, env });
    created = applied.createdKeys;
    cleanupA = async () => await rollbackFromSnapshot(applied.snapshotPath, { ...channel, write: true, auditDir, env });
    console.log('');
    console.log(`计划 A 提交：授权 ${applied.authorizeCount} 次，新建 ${created.length} 条（${created.join(', ')}）`);
    console.log(`  快照：${applied.snapshotPath}`);
    if (created.length !== TEST_ITEM_COUNT) throw new Error(`期望新建 ${TEST_ITEM_COUNT} 条，实际 ${created.length} 条`);
    if (applied.authorizeCount !== 1) throw new Error(`计划 A 期望 1 次授权，实际 ${applied.authorizeCount} 次`);

    // ── 计划 B：21 处字段覆盖（一次授权）────────────────────────────────────
    const updates = created.flatMap((key) =>
      FIELDS.map((field) => ({ key, field, value: field === 'extra' ? `${STAMP}-updated` : `mcp-demo-${field}` })),
    );
    const updatePlan = await buildChangePlan({ ...channel, updates });
    const updated = await applyPlan(updatePlan, {
      ...channel,
      write: true,
      auditDir,
      env,
      ...(updatePlan.confirmKeyword === null ? {} : { confirm: updatePlan.confirmKeyword }),
    });
    console.log('');
    console.log(`计划 B 提交：授权 ${updated.authorizeCount} 次，写入 ${updated.submittedKeys.length} 条，字段变更 ${updatePlan.changes.length} 处`);
    console.log(`  快照：${updated.snapshotPath}`);
    console.log(`  审计：${updated.auditPath}`);
    if (updated.authorizeCount !== 1) throw new Error(`计划 B 期望 1 次授权，实际 ${updated.authorizeCount} 次`);

    const after = await getItems({ ...channel, keys: created });
    const written = after.every((item) => item.data['language'] === 'mcp-demo-language');
    console.log(`写入校验：${written ? '✔ 字段已更新' : '✘ 字段未按预期更新'}`);

    // ── 回滚计划 B：回到创建后的状态 ───────────────────────────────────────
    const rolled = await rollbackFromSnapshot(updated.snapshotPath, { ...channel, write: true, auditDir, env });
    const restoredItems = await getItems({ ...channel, keys: rolled.restored });
    const restored = restoredItems.every((item) => {
      const value = item.data['language'] ?? null;
      return value === null || value === '';
    });
    console.log(`回滚校验：${restored ? '✔ 已恢复到写前状态' : '✘ 与写前状态不一致'}（回滚 ${rolled.restored.length} 条）`);
    if (!written || !restored) failed = true;
  } catch (error) {
    failed = true;
    console.error(`演示失败：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (created.length > 0 && cleanupA !== null) {
      try {
        const cleaned = await cleanupA();
        console.log('');
        console.log(`清理：永久删除测试条目 ${cleaned.removed.length} 条（${cleaned.removed.join(', ')}）`);
      } catch (error) {
        failed = true;
        console.error(`清理失败（请检查库内是否残留 ${created.join(', ')}）：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const finalTop = await topLevel();
  const unchanged = fingerprint(finalTop) === baselineFingerprint;
  console.log('');
  console.log(`库回到演示前状态：${unchanged ? '✔ 顶层条目逐条一致' : '✘ 与演示前不一致'}（顶层 ${finalTop.length} 条）`);
  if (failed || !unchanged) process.exitCode = 1;
}

if (fake !== null) await fake.close();
if (temporaryAudit !== null) rmSync(temporaryAudit, { recursive: true, force: true });
