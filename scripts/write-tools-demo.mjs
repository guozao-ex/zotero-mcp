#!/usr/bin/env node
/**
 * 写 / 整理工具的真机最小闭环演示（`npm run demo:tools`，M2 change 5 验收 A9）。
 *
 * - 默认 dry-run：只读，打印计划与影响面，退出码 0，**不发出任何写请求**；
 * - `--apply`：真机闭环 —— 新建 1 条一次性测试条目 → 改字段 → 新建笔记 → 移入垃圾箱 → 彻底删除，
 *   结束时校验库回到演示前状态、既有条目逐条未被改动；中途失败时尽力清理测试条目。
 * - 数据安全：只创建一次性测试条目；写前快照、回读校验与审计 JSONL 全部由写安全管线生成。
 * - 目标地址经 `ZOTERO_MCP_BASE_URL` 解析，因此契约测试可把它指向假服务器验证「dry-run 不写库」。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  applyPlan,
  buildAddNotePlan,
  buildCreateItemPlan,
  buildDeleteItemsPlan,
  buildUpdateItemPlan,
  fetchAllTopItems,
  getItems,
  isWriteEnabled,
  previewPlan,
  probeLocalApi,
  resolveAuditDir,
  resolveBaseUrl,
} from '../packages/core/src/index.ts';

const apply = process.argv.includes('--apply');
const baseUrl = resolveBaseUrl();
const channel = { baseUrl };
const DEMO_TITLE = 'zotero-mcp demo:tools 一次性测试条目';
const DEMO_TAG = 'zotero-mcp-demo';
const DEMO_FIELD = 'zotero-mcp demo:tools 更新字段';

function ok(text) {
  console.log(`✔ ${text}`);
}
function bad(text) {
  console.log(`✘ ${text}`);
}

/**
 * 运行时授权：整个演示只向 Zotero 申请一次 key 并复用（等价于在弹窗里选「始终允许」），
 * 避免每个计划都弹窗（弹窗授权限流 5 次/分钟，且会打扰用户）。
 */
let authorizedKey = null;
async function authorizeOnce(serverId) {
  if (authorizedKey !== null) return authorizedKey;
  console.log('正在请求运行时授权（Zotero 会弹窗，请选择 Allow；建议选「始终允许」）…');
  const response = await fetch(`${baseUrl}/api/local/authorize`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'zotero-api-version': '3',
      'zotero-server-id': serverId,
    },
    body: JSON.stringify({ appName: 'zotero-mcp' }),
  });
  const body = await response.json().catch(() => null);
  const key = body === null ? undefined : body.key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`授权未返回可用 key（HTTP ${response.status}）：${JSON.stringify(body)}`);
  }
  authorizedKey = key;
  console.log(`已取得授权 key；remember=${String(body.remember)}（本次演示复用该 key，不再重复弹窗）`);
  if (body.remember !== true) {
    console.log('提示：Zotero 未记住本次授权。若后续步骤返回 401，请在弹窗中选择「始终允许」后重跑演示。');
  }
  return authorizedKey;
}

/** 比较用的条目指纹：忽略系统维护的时间戳字段。 */
function fingerprint(envelope) {
  const data = { ...(envelope.data ?? {}) };
  delete data.dateModified; // 系统时间戳字段不参与比对
  return JSON.stringify(data);
}

console.log('写 / 整理工具真机闭环演示（change 5 · m2-write-tools）');
console.log(`目标本地 API：${baseUrl}`);
console.log(`模式：${apply ? '--apply（真实写入，会触发 Zotero 授权弹窗）' : 'dry-run（只读预览，不写库）'}`);
console.log(
  `写开关 ZOTERO_MCP_WRITE=${process.env['ZOTERO_MCP_WRITE'] ?? '(未设置)'} → ${isWriteEnabled() ? 'on' : 'off'}`,
);
console.log('');

const probe = await probeLocalApi(channel);
if (!probe.reachable || !probe.writeAvailable) {
  console.log(`本地 API 不可写：${probe.reason ?? '未知原因'}`);
  if (apply) {
    bad('--apply 需要可写的本地 API：请在 Zotero Settings → Advanced 勾选本地 API 后重试。');
    process.exitCode = 1;
  } else {
    ok('dry-run 未发出任何写请求，退出码 0。');
    process.exitCode = 0;
  }
} else {
  console.log(`本地 API 可用：HTTP ${probe.statusCode}，serverID=${probe.serverId}`);
  const baseline = await fetchAllTopItems(channel);
  const baselineByKey = new Map(baseline.map((envelope) => [envelope.key, fingerprint(envelope)]));
  console.log(`库内顶层条目：${baseline.length} 条（演示只新建一次性测试条目，不改动既有条目）`);
  console.log('');

  // ① 计划：新建一次性测试条目
  const createPlan = buildCreateItemPlan({
    itemType: 'journalArticle',
    fields: {
      title: DEMO_TITLE,
      extra: 'created by npm run demo:tools',
      date: '2026',
      publicationTitle: 'zotero-mcp demo',
      tags: [{ tag: DEMO_TAG }],
    },
    creators: [{ firstName: 'Demo', lastName: 'Author' }],
  });
  console.log('① 新建测试条目（dry-run 计划）');
  console.log(previewPlan(createPlan));
  console.log('');

  console.log('闭环步骤（--apply 时执行，全部经写安全管线：一次授权 → 写前快照 → 写入 → 回读校验 → 审计）：');
  console.log('  1. zotero_create_item   新建一次性测试条目（journalArticle + 标签）');
  console.log('  2. zotero_update_item   改字段 extra，并回读校验');
  console.log('  3. zotero_add_note      在该条目下新建笔记');
  console.log('  4. zotero_delete_items  移入垃圾箱（permanent=false，可从垃圾箱恢复）');
  console.log('  5. zotero_delete_items  彻底删除（permanent=true + confirm="DELETE"）');
  console.log('  6. 复核：库回到演示前状态，既有条目逐条未被改动');
  console.log('');

  if (!apply) {
    console.log(`影响面：新建 1 条（${DEMO_TITLE}），改动 0 条既有条目，最终不留残留。`);
    ok('dry-run 完成：未写入任何数据，未发出任何写请求。加 --apply 才会真实提交（会触发授权弹窗）。');
    process.exitCode = 0;
  } else if (!isWriteEnabled()) {
    bad('写开关未开启：请设置 ZOTERO_MCP_WRITE=on 后重跑 --apply（默认只读，拒绝一切写入）。');
    process.exitCode = 1;
  } else {
    let createdKey = null;
    let failed = false;
    try {
      // ① 新建
      const created = await applyPlan(createPlan, { ...channel, write: true, authorizeImpl: () => authorizeOnce(probe.serverId) });
      createdKey = created.createdKeys[0] ?? null;
      if (createdKey === null || created.operations.some((operation) => operation.status === 'failed')) {
        throw new Error(`新建未成功：${JSON.stringify(created.operations)}`);
      }
      ok(`新建条目 ${createdKey}（授权 ${created.authorizeCount} 次；快照 ${created.snapshotPath}；审计 ${created.auditPath}）`);

      // ② 改字段
      const updatePlan = await buildUpdateItemPlan({
        ...channel,
        keys: [createdKey],
        fields: { extra: DEMO_FIELD },
      });
      console.log(previewPlan(updatePlan));
      const updated = await applyPlan(updatePlan, { ...channel, write: true, confirm: 'OVERWRITE', authorizeImpl: () => authorizeOnce(probe.serverId) });
      const [afterUpdate] = await getItems({ ...channel, keys: [createdKey] });
      if (afterUpdate?.data['extra'] !== DEMO_FIELD) throw new Error('字段更新回读校验失败');
      ok(`字段更新生效：extra → ${JSON.stringify(DEMO_FIELD)}（写入 ${updated.submittedKeys.length} 条，回读校验通过）`);

      // ③ 新建笔记
      const notePlan = await buildAddNotePlan({ ...channel, parentKey: createdKey, content: 'demo:tools 往返测试笔记' });
      const noted = await applyPlan(notePlan.plan, { ...channel, write: true, authorizeImpl: () => authorizeOnce(probe.serverId) });
      const [withNotes] = await getItems({ ...channel, keys: [createdKey], include: ['notes'] });
      const noteCount = withNotes?.notes.length ?? 0;
      if (noteCount === 0) throw new Error('笔记回读校验失败（条目下没有笔记子项）');
      ok(`笔记已创建：${noted.createdKeys.join(', ')}（子项 ${noteCount} 条）`);

      // ④ 移入垃圾箱
      const trashPlan = await buildDeleteItemsPlan({ ...channel, keys: [createdKey] });
      const trashed = await applyPlan(trashPlan, { ...channel, write: true, authorizeImpl: () => authorizeOnce(probe.serverId) });
      const trashList = await fetch(`${baseUrl}/api/users/0/items/trash?limit=100`, {
        headers: { accept: 'application/json' },
      }).then((response) => response.json());
      const inTrash = Array.isArray(trashList) && trashList.some((entry) => entry.key === createdKey);
      if (!inTrash) throw new Error('移入垃圾箱回读校验失败（/items/trash 中找不到测试条目）');
      ok(`已移入垃圾箱：${createdKey}（操作 ${trashed.operations.map((operation) => operation.kind).join(', ')}）`);

      // ⑤ 彻底删除
      const purgePlan = await buildDeleteItemsPlan({ ...channel, keys: [createdKey], permanent: true });
      const purged = await applyPlan(purgePlan, { ...channel, write: true, confirm: 'DELETE', authorizeImpl: () => authorizeOnce(probe.serverId) });
      const remaining = await fetch(`${baseUrl}/api/users/0/items/${createdKey}`, {
        headers: { accept: 'application/json' },
      });
      if (remaining.status !== 404) throw new Error(`彻底删除回读校验失败（条目仍存在，HTTP ${remaining.status}）`);
      createdKey = null;
      ok(`彻底删除完成：${purged.operations.map((operation) => operation.kind).join(' → ')}`);

      // ⑥ 复核
      const after = await fetchAllTopItems(channel);
      const afterByKey = new Map(after.map((envelope) => [envelope.key, fingerprint(envelope)]));
      const changed = [...baselineByKey].filter(([key, print]) => afterByKey.get(key) !== print);
      const added = [...afterByKey.keys()].filter((key) => !baselineByKey.has(key));
      if (changed.length > 0) throw new Error(`既有条目被改动：${changed.map(([key]) => key).join(', ')}`);
      if (added.length > 0) throw new Error(`库中出现新增条目：${added.join(', ')}`);
      ok(`库已回到演示前状态：顶层条目 ${baseline.length} 条，既有条目逐条未被改动`);
    } catch (error) {
      failed = true;
      bad(error instanceof Error ? error.message : String(error));
      // 清理范围：已登记的 key + 本次计划快照里登记过的创建对象
      // （创建已提交但回读校验失败时也会写进快照，避免在库里留下一次性测试条目）
      const cleanupKeys = new Set(createdKey === null ? [] : [createdKey]);
      try {
        const snapshotPath = join(resolveAuditDir(), 'snapshots', `${createPlan.id}.json`);
        if (existsSync(snapshotPath)) {
          const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
          for (const entry of snapshot.created ?? []) {
            if (typeof entry?.key === 'string' && entry.key.length > 0) cleanupKeys.add(entry.key);
          }
        }
      } catch {
        // 快照不可读：只清理已登记的 key
      }
      for (const key of cleanupKeys) {
        console.log(`尝试清理测试条目 ${key} …`);
        try {
          const cleanupPlan = await buildDeleteItemsPlan({ ...channel, keys: [key], permanent: true });
          await applyPlan(cleanupPlan, {
            ...channel,
            write: true,
            confirm: 'DELETE',
            authorizeImpl: () => authorizeOnce(probe.serverId),
          });
          ok(`测试条目 ${key} 已清理。`);
        } catch (cleanupError) {
          bad(
            `清理失败，请手工删除测试条目 ${key}：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
      }
      createdKey = null;
    }
    process.exitCode = failed ? 1 : 0;
  }
}
