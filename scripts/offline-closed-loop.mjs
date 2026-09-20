#!/usr/bin/env node
/**
 * 禁网下的读写闭环（供 `npm run verify:offline` 在进程级禁网守卫下执行）。
 *
 * 全程只访问回环地址上的假服务器：
 *   读 → dry-run 预览 diff → 一次授权提交 → 回读校验 → 按快照回滚 → 回读校验
 * 审计与快照落在临时目录，跑完清理，不碰仓库的 `.audit`。
 *
 * 输出一行 JSON 供父进程核对。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyPlan,
  buildChangePlan,
  getItems,
  previewPlan,
  rollbackFromSnapshot,
} from '../packages/core/src/index.ts';
import { startFakeZotero } from './fake-zotero.mjs';

const auditDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-offline-audit-'));
const env = { ...process.env, ZOTERO_MCP_WRITE: 'on' };
const summary = { ok: false, steps: [] };
let fake = null;

try {
  fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const channel = { baseUrl: fake.url };

  const before = await getItems({ ...channel, keys: ['ITEM0001', 'ITEM0003'] });
  summary.steps.push({ name: '读（GET）', detail: `${before.length} 条` });

  const plan = await buildChangePlan({
    ...channel,
    updates: [
      { key: 'ITEM0001', field: 'title', value: 'offline-loop-title' },
      { key: 'ITEM0003', field: 'title', value: 'offline-loop-title' },
    ],
  });
  const preview = previewPlan(plan);
  summary.steps.push({ name: 'dry-run 预览', detail: preview.split(String.fromCharCode(10))[0] ?? '' });

  const applied = await applyPlan(plan, {
    ...channel,
    write: true,
    auditDir,
    env,
    ...(plan.confirmKeyword === undefined ? {} : { confirm: plan.confirmKeyword }),
  });
  summary.steps.push({
    name: '一次授权提交',
    detail: `authorizeCount=${applied.authorizeCount}，写入 ${applied.submittedKeys.length} 条`,
  });

  const after = await getItems({ ...channel, keys: applied.submittedKeys });
  const written = after.every((item) => item.data['title'] === 'offline-loop-title');
  summary.steps.push({ name: '回读校验', detail: written ? '字段已更新' : '字段未按预期更新' });

  const rolled = await rollbackFromSnapshot(applied.snapshotPath, { ...channel, write: true, auditDir, env });
  const restoredItems = await getItems({ ...channel, keys: rolled.restored });
  const restored = restoredItems.every((item) => {
    const baseline = before.find((entry) => entry.key === item.key);
    return item.data['title'] === baseline?.data['title'];
  });
  summary.steps.push({ name: '回滚 + 回读校验', detail: restored ? `已恢复 ${rolled.restored.length} 条` : '与写前不一致' });

  const nonGet = fake.requests.filter((entry) => entry.method !== 'GET').length;
  summary.steps.push({ name: '零外呼', detail: `${fake.requests.length} 次请求全部命中回环假服务器` });

  summary.ok = written && restored && applied.authorizeCount === 1 && nonGet > 0;
  summary.authorizeCount = applied.authorizeCount;
  summary.nonGetRequests = nonGet;
} catch (error) {
  summary.error = error instanceof Error ? error.message : String(error);
} finally {
  if (fake !== null) await fake.close();
  rmSync(auditDir, { recursive: true, force: true });
}

console.log(JSON.stringify(summary));
process.exitCode = summary.ok ? 0 : 1;
