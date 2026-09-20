#!/usr/bin/env node
/**
 * 元数据补全的真机闭环演示（`npm run demo:enrich`，M3 change 8 验收 A7）。
 *
 * - 默认 dry-run：只读，打印计划与影响面，退出码 0，**不发出任何写请求**；
 * - `--apply`：一次性条目闭环 —— 新建测试条目（带真实 DOI）→ 真实补全并写入 `extra` 与标签
 *   → 回读核对 → 移入垃圾箱 → 彻底删除 → 复核库回到演示前状态、既有条目逐条未被改动；
 * - `--fixtures`：外部学术 API 走仓库内离线固件（便于在假服务器上复现整个闭环），
 *   Zotero 侧仍走 `ZOTERO_MCP_BASE_URL`；不加该参数时真实外呼 OpenAlex / Crossref / S2 / Unpaywall / PubMed / arXiv；
 * - `--doi <doi>`：覆盖演示用的 DOI（默认一篇真实的金 OA 论文）。
 * - 数据安全：只创建一次性测试条目；写前快照、回读校验与审计 JSONL 全部由写安全管线生成；
 *   结束时把可独立核对的证据写进 `ZOTERO_MCP_AUDIT_DIR/enrich-demo-<planId>.json`。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  applyPlan,
  buildCreateItemPlan,
  buildDeleteItemsPlan,
  buildEnrichmentPlan,
  enrichItems,
  fetchAllTopItems,
  getItems,
  isWriteEnabled,
  previewPlan,
  probeLocalApi,
  resolveAuditDir,
  resolveBaseUrl,
} from '../packages/core/src/index.ts';
import { createFixtureFetch, loadEnrichmentFixtures } from './enrich-fixtures.mjs';

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const fixtures = argv.includes('--fixtures');
const doiArgIndex = argv.indexOf('--doi');
const DEMO_DOI =
  doiArgIndex >= 0 && argv[doiArgIndex + 1] !== undefined
    ? argv[doiArgIndex + 1]
    : fixtures
      ? '10.1000/alpha.enriched'
      : '10.1371/journal.pone.0177459';
const baseUrl = resolveBaseUrl();
const auditDir = resolveAuditDir();
const DEMO_TITLE = 'zotero-mcp demo:enrich 一次性测试条目';
const DEMO_TAG = 'zotero-mcp-demo';
const DEMO_EXTRA = 'created by npm run demo:enrich（这一行属于用户手写文本，补全必须逐字保留）';

function ok(text) {
  console.log(`✔ ${text}`);
}
function bad(text) {
  console.log(`✘ ${text}`);
}

/** 运行时授权：整个演示只申请一次 key 并复用，避免重复弹窗。 */
let authorizedKey = null;
async function authorizeOnce(serverId) {
  if (authorizedKey !== null) return authorizedKey;
  console.log('正在请求运行时授权（Zotero 会弹窗，请选择 Allow；建议选「始终允许」）…');
  const response = await fetch(`${baseUrl}/api/local/authorize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'zotero-api-version': '3', 'zotero-server-id': serverId },
    body: JSON.stringify({ appName: 'zotero-mcp' }),
  });
  const body = await response.json().catch(() => null);
  const key = body === null ? undefined : body.key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error(`授权未返回可用 key（HTTP ${response.status}）：${JSON.stringify(body)}`);
  }
  authorizedKey = key;
  console.log(`已取得授权 key；remember=${String(body.remember)}（本次演示复用该 key，不再重复弹窗）`);
  return authorizedKey;
}

function fingerprint(envelope) {
  const data = { ...(envelope.data ?? {}) };
  delete data.dateModified;
  return JSON.stringify(data);
}

console.log('元数据补全真机闭环演示（change 8 · m3-metadata-enrichment）');
console.log(`目标本地 API：${baseUrl}`);
console.log(`模式：${apply ? '--apply（真实写入，会触发 Zotero 授权弹窗）' : 'dry-run（只读预览，不写库）'}`);
console.log(`外部学术 API：${fixtures ? '仓库内离线固件（--fixtures）' : '真实外呼（带 mailto + 主机限速 + 本地缓存）'}`);
console.log(`演示 DOI：${DEMO_DOI}`);
console.log(`写开关 ZOTERO_MCP_WRITE=${process.env['ZOTERO_MCP_WRITE'] ?? '(未设置)'} → ${isWriteEnabled() ? 'on' : 'off'}`);
console.log('');

const probe = await probeLocalApi({ baseUrl });
if (!probe.reachable || (!apply && !probe.writeAvailable)) {
  console.log(`本地 API 不可用：${probe.reason ?? '未知原因'}`);
  if (apply) {
    bad('--apply 需要可写的本地 API：请在 Zotero Settings → Advanced 勾选本地 API 后重试。');
    process.exitCode = 1;
  } else {
    ok('dry-run 未发出任何写请求，退出码 0。');
    process.exitCode = 0;
  }
} else {
  console.log(`本地 API 可用：HTTP ${probe.statusCode}，serverID=${probe.serverId}`);
  const externalFetch = fixtures ? createFixtureFetch(loadEnrichmentFixtures()) : fetch;
  const fetchImpl = async (input, init) => {
    const url = typeof input === 'string' ? input : (input.url ?? String(input));
    return url.startsWith(baseUrl) ? fetch(input, init) : externalFetch(input, init);
  };

  const baseline = await fetchAllTopItems({ baseUrl });
  const baselineByKey = new Map(baseline.map((envelope) => [envelope.key, fingerprint(envelope)]));
  console.log(`库内顶层条目：${baseline.length} 条（演示只新建一次性测试条目，不改动既有条目）`);
  console.log('');

  const createPlan = buildCreateItemPlan({
    itemType: 'journalArticle',
    fields: {
      title: DEMO_TITLE,
      DOI: DEMO_DOI,
      date: '2026',
      publicationTitle: 'zotero-mcp demo',
      extra: DEMO_EXTRA,
      tags: [{ tag: DEMO_TAG }],
    },
    creators: [{ firstName: 'Demo', lastName: 'Author' }],
  });
  console.log('① 新建一次性测试条目（dry-run 计划）');
  console.log(previewPlan(createPlan));
  console.log('');
  console.log('闭环步骤（--apply 时执行，全部经写安全管线：一次授权 → 写前快照 → 写入 → 回读校验 → 审计）：');
  console.log('  1. zotero_create_item 新建一次性测试条目（含真实 DOI 与一行用户手写 extra）');
  console.log('  2. zotero_enrich      真实补全该 DOI，把情报写进 extra 托管块与标签（只补空 journalAbbreviation）');
  console.log('  3. 回读核对           extra 托管块、块外文本逐字保留、标签合并与 journalAbbreviation 结论');
  console.log('  4. zotero_delete_items 移入垃圾箱（可从垃圾箱恢复）');
  console.log('  5. zotero_delete_items 彻底删除（permanent=true + confirm="DELETE"）');
  console.log('  6. 复核               库回到演示前状态，既有条目逐条未被改动');
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
    const evidence = {
      schema: 'zotero-mcp.enrich-demo.v1',
      at: new Date().toISOString(),
      baseUrl,
      externalSources: fixtures ? 'offline-fixtures' : 'live',
      demoDoi: DEMO_DOI,
      auditDir,
      baselineTopItems: baseline.length,
      plans: {},
      enrichment: null,
      readback: null,
      cleanup: null,
    };
    try {
      // ① 新建
      const created = await applyPlan(createPlan, { baseUrl, auditDir, write: true, authorizeImpl: () => authorizeOnce(probe.serverId) });
      createdKey = created.createdKeys[0] ?? null;
      if (createdKey === null || created.operations.some((operation) => operation.status === 'failed')) {
        throw new Error(`新建未成功：${JSON.stringify(created.operations)}`);
      }
      evidence.plans.create = { planId: createPlan.id, snapshotPath: created.snapshotPath, auditPath: created.auditPath };
      ok(`新建条目 ${createdKey}（授权 ${created.authorizeCount} 次；快照 ${created.snapshotPath}；审计 ${created.auditPath}）`);

      // ② 真实补全（读外部源 → 编译计划 → 经写安全管线提交）
      const report = await enrichItems({
        baseUrl,
        keys: [createdKey],
        fetchImpl,
        ...(fixtures ? { cacheDir: join(auditDir, 'enrich-demo-cache') } : {}),
      });
      const item = report.items[0];
      if (item === undefined) throw new Error('补全未返回任何条目结果');
      console.log(
        `   补全结果：${item.status} · 命中 ${item.attempts.filter((attempt) => attempt.status === 'hit').map((attempt) => attempt.source).join(', ') || '无'}`,
      );
      console.log(`   情报：${JSON.stringify(item.intel)}`);
      console.log(`   外呼 ${item.calls.length} 次（每条都带 mailto=${item.calls[0]?.mailto ?? '—'}）`);
      const enrichPlan = buildEnrichmentPlan(report.items);
      console.log(previewPlan(enrichPlan));
      if (enrichPlan.operations === undefined || enrichPlan.operations.length === 0) {
        throw new Error('补全没有产生任何写入操作：无法核对「补全写入」这一环');
      }
      const enriched = await applyPlan(enrichPlan, { baseUrl, auditDir, write: true, authorizeImpl: () => authorizeOnce(probe.serverId) });
      if (enriched.operations.some((operation) => operation.status === 'failed')) {
        throw new Error(`补全写入失败：${JSON.stringify(enriched.operations)}`);
      }
      evidence.plans.enrich = { planId: enrichPlan.id, snapshotPath: enriched.snapshotPath, auditPath: enriched.auditPath };
      evidence.enrichment = {
        status: item.status,
        doi: item.doi,
        doiSource: item.doiSource,
        hits: item.attempts.filter((attempt) => attempt.status === 'hit').map((attempt) => attempt.source),
        attempts: item.attempts,
        intel: item.intel,
        plannedFields: Object.keys(item.fields),
        plannedTags: item.tags,
        skipped: item.skipped,
        calls: item.calls,
      };
      ok(`补全写入完成：${Object.keys(item.fields).join(', ') || '（无字段）'}（授权 ${enriched.authorizeCount} 次）`);

      // ③ 回读核对
      const [after] = await getItems({ baseUrl, keys: [createdKey] });
      if (after === undefined) throw new Error('回读失败：条目不存在');
      const extraAfter = typeof after.data['extra'] === 'string' ? after.data['extra'] : '';
      const tagsAfter = Array.isArray(after.data['tags'])
        ? after.data['tags'].map((tag) => (typeof tag === 'string' ? tag : tag?.tag)).filter((tag) => typeof tag === 'string')
        : [];
      if (!extraAfter.includes('<!-- zotero-mcp:enrichment:start -->') || !extraAfter.includes('<!-- zotero-mcp:enrichment:end -->')) {
        throw new Error(`extra 回读校验失败：托管块缺失（${extraAfter}）`);
      }
      if (!extraAfter.includes(DEMO_EXTRA)) {
        throw new Error('extra 回读校验失败：块外用户手写文本没有逐字保留');
      }
      if (!tagsAfter.includes(DEMO_TAG)) throw new Error('标签回读校验失败：原有标签丢失');
      for (const tag of item.tags) {
        if (!tagsAfter.includes(tag)) throw new Error(`标签回读校验失败：缺少 ${tag}`);
      }
      evidence.readback = {
        extra: extraAfter,
        journalAbbreviation: after.data['journalAbbreviation'] ?? null,
        tags: tagsAfter,
        outsideTextPreserved: extraAfter.includes(DEMO_EXTRA),
      };
      ok(`回读通过：extra 含托管块且块外文本逐字保留；journalAbbreviation=${JSON.stringify(after.data['journalAbbreviation'] ?? null)}；标签 ${tagsAfter.join(', ')}`);

      // ④ 幂等：同一情报再补全一次不应产生任何操作
      const again = await enrichItems({
        baseUrl,
        keys: [createdKey],
        fetchImpl,
        ...(fixtures ? { cacheDir: join(auditDir, 'enrich-demo-cache') } : {}),
      });
      const againPlan = buildEnrichmentPlan(again.items);
      if ((againPlan.operations ?? []).length !== 0) {
        throw new Error(`幂等校验失败：第二次补全仍产生 ${againPlan.operations?.length} 个操作`);
      }
      evidence.idempotent = { operations: 0, status: again.items[0]?.status ?? null };
      ok('幂等通过：第二次补全对同一情报产生 0 个操作');

      // ⑤ 移入垃圾箱
      const trashPlan = await buildDeleteItemsPlan({ baseUrl, keys: [createdKey] });
      const trashed = await applyPlan(trashPlan, { baseUrl, auditDir, write: true, authorizeImpl: () => authorizeOnce(probe.serverId) });
      const trashList = await fetch(`${baseUrl}/api/users/0/items/trash?limit=100`, { headers: { accept: 'application/json' } })
        .then((response) => response.json());
      const inTrash = Array.isArray(trashList) && trashList.some((entry) => entry.key === createdKey);
      if (!inTrash) throw new Error('移入垃圾箱回读校验失败（/items/trash 中找不到测试条目）');
      evidence.plans.trash = { planId: trashPlan.id, snapshotPath: trashed.snapshotPath };
      ok(`已移入垃圾箱：${createdKey}（操作 ${trashed.operations.map((operation) => operation.kind).join(', ')}）`);

      // ⑥ 彻底删除
      const purgePlan = await buildDeleteItemsPlan({ baseUrl, keys: [createdKey], permanent: true });
      const purged = await applyPlan(purgePlan, { baseUrl, auditDir, write: true, confirm: 'DELETE', authorizeImpl: () => authorizeOnce(probe.serverId) });
      const remaining = await fetch(`${baseUrl}/api/users/0/items/${createdKey}`, { headers: { accept: 'application/json' } });
      if (remaining.status !== 404) throw new Error(`彻底删除回读校验失败（条目仍存在，HTTP ${remaining.status}）`);
      evidence.plans.purge = { planId: purgePlan.id, snapshotPath: purged.snapshotPath };
      createdKey = null;
      ok(`彻底删除完成：${purged.operations.map((operation) => operation.kind).join(' → ')}`);

      // ⑦ 复核
      const afterAll = await fetchAllTopItems({ baseUrl });
      const afterByKey = new Map(afterAll.map((envelope) => [envelope.key, fingerprint(envelope)]));
      const changed = [...baselineByKey].filter(([key, print]) => afterByKey.get(key) !== print);
      const added = [...afterByKey.keys()].filter((key) => !baselineByKey.has(key));
      if (changed.length > 0) throw new Error(`既有条目被改动：${changed.map(([key]) => key).join(', ')}`);
      if (added.length > 0) throw new Error(`库中出现新增条目：${added.join(', ')}`);
      evidence.cleanup = { topItems: afterAll.length, changedExisting: changed.length, added: added.length, libraryKeys: [...afterByKey.keys()] };
      ok(`库已回到演示前状态：顶层条目 ${afterAll.length} 条，既有条目逐条未被改动`);
    } catch (error) {
      failed = true;
      bad(error instanceof Error ? error.message : String(error));
      const cleanupKeys = new Set(createdKey === null ? [] : [createdKey]);
      for (const plan of [createPlan]) {
        try {
          const snapshotPath = join(auditDir, 'snapshots', `${plan.id}.json`);
          if (!existsSync(snapshotPath)) continue;
          const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
          for (const entry of snapshot.created ?? []) {
            if (typeof entry?.key === 'string' && entry.key.length > 0) cleanupKeys.add(entry.key);
          }
        } catch {
          // 快照不可读：只清理已登记的 key
        }
      }
      for (const key of cleanupKeys) {
        console.log(`尝试清理测试条目 ${key} …`);
        try {
          const cleanupPlan = await buildDeleteItemsPlan({ baseUrl, keys: [key], permanent: true });
          await applyPlan(cleanupPlan, { baseUrl, auditDir, write: true, confirm: 'DELETE', authorizeImpl: () => authorizeOnce(probe.serverId) });
          ok(`测试条目 ${key} 已清理。`);
        } catch (cleanupError) {
          bad(`清理失败，请手工删除测试条目 ${key}：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
        }
      }
      createdKey = null;
    }
    try {
      const evidencePath = join(auditDir, `enrich-demo-${createPlan.id}.json`);
      writeFileSync(evidencePath, `${JSON.stringify({ ...evidence, ok: !failed }, null, 2)}\n`, 'utf8');
      console.log('');
      console.log(`证据文件：${evidencePath}`);
      console.log(`审计 JSONL：${join(auditDir, 'audit.jsonl')} · 写前快照：${join(auditDir, 'snapshots')}`);
    } catch (error) {
      bad(`证据文件写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
    process.exitCode = failed ? 1 : 0;
  }
}
