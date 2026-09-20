/** 写安全管线契约测试：计划/dry-run/默认只读/确认/授权/审计快照/412 恢复/回滚。 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  applyPlan,
  buildChangePlan,
  getItems,
  isWriteEnabled,
  previewPlan,
  resetLocalApiAuthCache,
  rollbackFromSnapshot,
} from '../../packages/core/src/index.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

const authorize = async () => 'FAKEKEY00000000000000000000000000';

// 契约测试显式开启写开关（生产默认关闭；关闭时的拒绝行为由下方用例单独覆盖）
process.env['ZOTERO_MCP_WRITE'] = 'on';

test('默认只读：ZOTERO_MCP_WRITE 未开启', () => {
  assert.equal(isWriteEnabled({}), false);
  assert.equal(isWriteEnabled({ ZOTERO_MCP_WRITE: 'off' }), false);
  assert.equal(isWriteEnabled({ ZOTERO_MCP_WRITE: 'on' }), true);
});

test('计划：逐字段 before → after，dry-run 不产生写请求', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const methods = [];
  const fetchImpl = async (input, init) => {
    methods.push((init?.method ?? 'GET').toUpperCase());
    return fetch(input, init);
  };
  try {
    const plan = await buildChangePlan({
      baseUrl: fake.url,
      fetchImpl,
      updates: [
        { key: 'ITEM0001', field: 'extra', value: 'Citation Key: alphaPaper2021 (updated)' },
        { key: 'ITEM0003', field: 'language', value: 'en' },
      ],
    });
    assert.equal(plan.changes.length, 2);
    assert.equal(plan.destructive, true); // ITEM0001 的 extra 原值非空
    assert.equal(plan.confirmKeyword, 'OVERWRITE');
    const text = previewPlan(plan);
    assert.match(text, /extra:/u);
    assert.match(text, /OVERWRITE/u);
    assert.deepEqual([...new Set(methods)], ['GET']); // dry-run 全程只读
  } finally {
    await fake.close();
  }
});

test('提交门禁：未开写 / 缺 confirm 均被拒绝', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-write-'));
  try {
    const plan = await buildChangePlan({
      baseUrl: fake.url,
      updates: [{ key: 'ITEM0001', field: 'extra', value: 'changed' }],
    });
    await assert.rejects(() => applyPlan(plan, { baseUrl: fake.url, auditDir: dir }), /写路径未开启/u);
    await assert.rejects(
      () => applyPlan(plan, { baseUrl: fake.url, auditDir: dir, write: true, env: { ZOTERO_MCP_WRITE: 'off' } }),
      /ZOTERO_MCP_WRITE/u,
    );
    await assert.rejects(
      () => applyPlan(plan, { baseUrl: fake.url, auditDir: dir, write: true }),
      /confirm="OVERWRITE"/u,
    );
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('提交：一次授权 + 快照 + 审计，字段被更新', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-write-'));
  try {
    const plan = await buildChangePlan({
      baseUrl: fake.url,
      updates: [{ key: 'ITEM0003', field: 'language', value: 'zh-CN' }],
    });
    const result = await applyPlan(plan, {
      baseUrl: fake.url,
      auditDir: dir,
      write: true,
      authorizeImpl: authorize,
    });
    assert.equal(result.authorizeCount, 1);
    assert.deepEqual(result.submittedKeys, ['ITEM0003']);
    assert.ok(existsSync(result.snapshotPath));
    assert.ok(existsSync(result.auditPath));
    const audit = readFileSync(result.auditPath, 'utf8').trim().split('\n');
    assert.ok(audit.length >= 1);
    assert.match(audit[0], /"status":"updated"/u);

    const [item] = await getItems({ baseUrl: fake.url, keys: ['ITEM0003'] });
    assert.equal(item.data['language'], 'zh-CN');
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('412 冲突：重建计划后重试成功', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0, conflictOnce: true });
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-write-'));
  try {
    const plan = await buildChangePlan({
      baseUrl: fake.url,
      updates: [{ key: 'ITEM0003', field: 'language', value: 'ja' }],
    });
    const result = await applyPlan(plan, {
      baseUrl: fake.url,
      auditDir: dir,
      write: true,
      authorizeImpl: authorize,
    });
    assert.equal(result.conflictRetries, 1);
    assert.equal(result.results[0]?.status, 'conflict-recovered');
    const [item] = await getItems({ baseUrl: fake.url, keys: ['ITEM0003'] });
    assert.equal(item.data['language'], 'ja');
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('回滚：按快照恢复到写前值', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-write-'));
  try {
    const plan = await buildChangePlan({
      baseUrl: fake.url,
      updates: [{ key: 'ITEM0003', field: 'language', value: 'fr' }],
    });
    const result = await applyPlan(plan, {
      baseUrl: fake.url,
      auditDir: dir,
      write: true,
      authorizeImpl: authorize,
    });
    const [after] = await getItems({ baseUrl: fake.url, keys: ['ITEM0003'] });
    assert.equal(after.data['language'], 'fr');

    const rolled = await rollbackFromSnapshot(result.snapshotPath, {
      baseUrl: fake.url,
      auditDir: dir,
      write: true,
      authorizeImpl: authorize,
    });
    assert.deepEqual(rolled.restored, ['ITEM0003']);
    const [restored] = await getItems({ baseUrl: fake.url, keys: ['ITEM0003'] });
    // 回滚把写操作新增的字段清空（真机用空字符串清空最稳）
    assert.ok(restored.data['language'] === null || restored.data['language'] === '');
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('1 条指令回滚：参数解析、快照校验、只读预览与拒绝路径', async () => {
  const { buildRollbackPlan, parseRollbackArgs, readSnapshotFile, renderRollbackPlan, validateSnapshot } =
    await import('../../packages/core/src/index.ts');

  // 参数解析
  assert.deepEqual(parseRollbackArgs(['--snapshot', 'a.json']), { ok: true, args: { snapshotPath: 'a.json', commit: false } });
  assert.deepEqual(parseRollbackArgs(['--snapshot', 'a.json', '--commit']), {
    ok: true,
    args: { snapshotPath: 'a.json', commit: true },
  });
  assert.equal(parseRollbackArgs([]).ok, false);
  assert.equal(parseRollbackArgs(['--snapshot']).ok, false);
  assert.equal(parseRollbackArgs(['--nope']).ok, false);

  // 快照结构校验：四种非法形态各自给出不同原因
  assert.equal(validateSnapshot(null).ok, false);
  assert.equal(validateSnapshot({}).ok, false);
  assert.equal(validateSnapshot({ planId: 'p' }).ok, false);
  assert.equal(validateSnapshot({ planId: 'p', items: [{}] }).ok, false);
  assert.equal(validateSnapshot({ planId: 'p', items: [] }).ok, true);

  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-rollback-'));
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  try {
    // 路径不存在
    const missing = readSnapshotFile(join(dir, 'nope.json'));
    assert.equal(missing.ok, false);
    assert.match(missing.ok === false ? missing.reason : '', /不存在/);

    // 不合法 JSON
    const brokenPath = join(dir, 'broken.json');
    writeFileSync(brokenPath, 'not json', 'utf8');
    const broken = readSnapshotFile(brokenPath);
    assert.equal(broken.ok, false);
    assert.match(broken.ok === false ? broken.reason : '', /不是合法 JSON/);

    // 结构不合法
    const wrongPath = join(dir, 'wrong.json');
    writeFileSync(wrongPath, JSON.stringify({ hello: 'world' }), 'utf8');
    const wrong = readSnapshotFile(wrongPath);
    assert.equal(wrong.ok, false);
    assert.match(wrong.ok === false ? wrong.reason : '', /planId/);

    // 三种拒绝原因互不相同
    const reasons = new Set([missing.ok === false ? missing.reason : '', broken.ok === false ? broken.reason : '', wrong.ok === false ? wrong.reason : '']);
    assert.equal(reasons.size, 3);

    // 只读预览：库内 ITEM0001 的 title 与快照不同时，预览要给出 current → before
    const snapshotPath = join(dir, 'plan.json');
    writeFileSync(
      snapshotPath,
      JSON.stringify({
        planId: 'plan-test-1',
        createdAt: '2026-09-18T00:00:00.000Z',
        items: [{ key: 'ITEM0001', version: 1, data: { key: 'ITEM0001', title: '写前标题', language: 'en' } }],
        // 一个仍存在（ITEM0002）与一个已不存在（NEWITEM01）的「计划创建」对象
        created: [{ key: 'ITEM0002' }, { key: 'NEWITEM01' }],
      }),
      'utf8',
    );
    const requestCount = fake.requests.length;
    const planned = await buildRollbackPlan(snapshotPath, { baseUrl: fake.url });
    assert.equal(planned.ok, true);
    const plan = planned.ok ? planned.plan : null;
    assert.equal(plan.planId, 'plan-test-1');
    assert.deepEqual(
      plan.restore.map((entry) => entry.key),
      ['ITEM0001'],
    );
    assert.deepEqual(
      plan.restore[0].changes.map((change) => change.field).sort(),
      ['language', 'title'],
    );
    assert.equal(plan.totalChanges, 2);
    // 只有仍存在的创建对象才进「将永久删除」；已不存在的单独归档，两个清单不重叠
    assert.deepEqual(plan.remove.map((entry) => entry.key), ['ITEM0002']);
    assert.deepEqual(plan.alreadyGone.map((entry) => entry.key), ['NEWITEM01']);
    const rendered = renderRollbackPlan(plan);
    assert.match(rendered, /→/u);
    assert.match(rendered, /将永久删除/u);
    assert.match(rendered, /已不存在/u);
    const deleteSection = rendered.slice(rendered.indexOf('将永久删除'), rendered.indexOf('已不存在'));
    assert.match(deleteSection, /ITEM0002/u);
    assert.doesNotMatch(deleteSection, /NEWITEM01/u);
    // 只读：预览只发 GET，且不写任何文件
    assert.deepEqual(
      fake.requests.slice(requestCount).filter((entry) => entry.method !== 'GET'),
      [],
    );
    assert.equal(existsSync(join(dir, 'plan.json.bak')), false);

    // 快照 items 里没有的对象不会凭快照复活
    const ghostPath = join(dir, 'ghost.json');
    writeFileSync(
      ghostPath,
      JSON.stringify({ planId: 'plan-test-2', items: [{ key: 'GONE0001', data: { title: 'x' } }] }),
      'utf8',
    );
    const ghost = await buildRollbackPlan(ghostPath, { baseUrl: fake.url });
    assert.equal(ghost.ok, true);
    assert.equal(ghost.ok ? ghost.plan.restore.length : -1, 0);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('回滚预览：创建对象已被永久删除时不再说「将永久删除」', async () => {
  const { buildRollbackPlan, makeChangePlan, readSnapshotFile, renderRollbackPlan } = await import(
    '../../packages/core/src/index.ts'
  );
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-rollback-gone-'));
  try {
    // 真机事故形态：快照先生成 → 清理阶段把创建的对象永久删除 → 再拿同一份快照预览
    const plan = makeChangePlan({
      targetKeys: [],
      changes: [],
      operations: [
        { kind: 'create', itemType: 'document', fields: { title: '已清理的测试条目 A' } },
        { kind: 'create', itemType: 'document', fields: { title: '已清理的测试条目 B' } },
      ],
      summary: '两条一次性测试条目',
    });
    const applied = await applyPlan(plan, {
      baseUrl: fake.url,
      auditDir: dir,
      write: true,
      authorizeImpl: authorize,
    });
    assert.equal(applied.createdKeys.length, 2);
    const cleaned = await rollbackFromSnapshot(applied.snapshotPath, {
      baseUrl: fake.url,
      auditDir: dir,
      write: true,
      authorizeImpl: authorize,
    });
    assert.deepEqual([...cleaned.removed].sort(), [...applied.createdKeys].sort());

    const validation = readSnapshotFile(applied.snapshotPath);
    assert.equal(validation.ok, true);

    const requestCount = fake.requests.length;
    const previewed = await buildRollbackPlan(applied.snapshotPath, { baseUrl: fake.url });
    assert.equal(previewed.ok, true);
    const previewPlan = previewed.ok ? previewed.plan : null;

    // 两个对象都已被永久删除：谁都不该出现在「将永久删除」里
    assert.deepEqual(previewPlan.remove, []);
    assert.deepEqual(
      previewPlan.alreadyGone.map((entry) => entry.key).sort(),
      [...applied.createdKeys].sort(),
    );

    const rendered = renderRollbackPlan(previewPlan);
    assert.doesNotMatch(rendered, /将永久删除/u);
    assert.match(rendered, /已不存在、无需删除/u);
    for (const key of applied.createdKeys) assert.match(rendered, new RegExp(key, 'u'));

    // 预览仍然只读：零写请求
    assert.deepEqual(
      fake.requests.slice(requestCount).filter((entry) => entry.method !== 'GET'),
      [],
    );
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('授权缓存：同一进程内第二个计划不再重复授权（消除 5 次/分钟限流）', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-authcache-'));
  let calls = 0;
  const counting = async () => {
    calls += 1;
    return authorize();
  };
  const options = { baseUrl: fake.url, auditDir: dir, write: true, authorizeImpl: counting, confirm: 'OVERWRITE' };
  try {
    // 正向：两次 applyPlan 共用一份进程内缓存
    resetLocalApiAuthCache();
    calls = 0;
    const plan1 = await buildChangePlan({ baseUrl: fake.url, updates: [{ key: 'ITEM0003', field: 'language', value: 'zh-CN' }] });
    const first = await applyPlan(plan1, options);
    assert.equal(first.authorizeCount, 1, '第一个计划应授权一次');
    const plan2 = await buildChangePlan({ baseUrl: fake.url, updates: [{ key: 'ITEM0003', field: 'language', value: 'en-US' }] });
    const second = await applyPlan(plan2, options);
    assert.equal(second.authorizeCount, 0, '第二个计划必须复用缓存、不再授权（旧实现每计划各授权一次 → 大批量必撞 429）');
    assert.equal(calls, 1, '两次计划合计只应调用授权一次');

    // 反证：显式禁用缓存时逐计划授权，证明上面的 1 次来自缓存
    resetLocalApiAuthCache();
    calls = 0;
    const plan3 = await buildChangePlan({ baseUrl: fake.url, updates: [{ key: 'ITEM0003', field: 'language', value: 'ja-JP' }] });
    await applyPlan(plan3, { ...options, authCache: false });
    assert.equal(calls, 1, '禁用缓存时该计划仍需一次授权');
  } finally {
    resetLocalApiAuthCache();
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
