/**
 * 受控真机证据契约测试（docs/evidence/）。
 *
 * 两条独立验证线：
 *   1. 结构完整：README、两份机读 JSON、两支真机探针都在，JSON 可解析，关键字段齐备，
 *      且 `live-write-demo.json` 里的每个数字都能自洽对上（21 = 3 × 7、两个计划的计数与 key）；
 *   2. **脱敏可证伪**：证据文件里不出现字段 before/after 值、不出现条目正文，也不出现任何凭证形态。
 *
 * 本测试只读仓库内文件，不需要 Zotero、不访问网络、不写任何东西。
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const EVIDENCE_DIR = join(ROOT, 'docs', 'evidence');

function readJson(name) {
  return JSON.parse(readFileSync(join(EVIDENCE_DIR, name), 'utf8'));
}

test('A1 受控证据结构完整且数字自洽', () => {
  assert.equal(existsSync(EVIDENCE_DIR), true, 'docs/evidence/ 必须存在');
  for (const name of ['README.md', 'live-write-demo.json', 'rollback-defect.json']) {
    assert.equal(existsSync(join(EVIDENCE_DIR, name)), true, `缺少 ${name}`);
  }
  for (const probe of ['rollback-semantics-probe.mjs', 'body-version-probe.mjs']) {
    const path = join(EVIDENCE_DIR, 'probes', probe);
    assert.equal(existsSync(path), true, `缺少真机探针 ${probe}`);
    const source = readFileSync(path, 'utf8');
    assert.match(source, /真机探针/u, `${probe} 必须标明是真机探针`);
    assert.match(source, /需要 Zotero 在运行/u, `${probe} 必须写明真机前提`);
    assert.doesNotMatch(source, /file:\/\/\/[A-Za-z]:/u, `${probe} 不得残留本机绝对 file:// import`);
  }

  const demo = readJson('live-write-demo.json');
  assert.equal(demo.schema, 'zotero-mcp.live-evidence.v1');
  assert.equal(demo.plans.length, 2);
  const [createPlan, updatePlan] = demo.plans;
  assert.equal(createPlan.authorizeCount, 1);
  assert.equal(updatePlan.authorizeCount, 1);
  assert.equal(createPlan.createdKeys.length, 3);
  assert.deepEqual(createPlan.rolledBackCreatedKeys, createPlan.createdKeys);
  assert.equal(updatePlan.submittedKeys.length, 3);
  assert.deepEqual(updatePlan.rolledBackKeys, updatePlan.submittedKeys);

  // 21 处字段变更的推导必须自洽：updated 行数 × 每行字段数
  const fieldChanges = demo.derivation.fieldChangeCount;
  assert.equal(fieldChanges.value, 21);
  assert.match(fieldChanges.formula, /3 条条目 × 7 个字段/u);
  assert.equal(updatePlan.auditStatusCounts.updated, 3);
  assert.equal(updatePlan.auditStatusCounts.rolled_back ?? updatePlan.auditStatusCounts['rolled-back'], 3);
  assert.equal(createPlan.auditStatusCounts['rolled-back-created'], 3);

  const defect = readJson('rollback-defect.json');
  assert.equal(defect.schema, 'zotero-mcp.live-evidence.v1');
  assert.match(defect.rootCause.liveErrorText, /item version mismatch/u);
  assert.match(defect.fix.where, /write-pipeline\.ts/u);
  assert.match(defect.offlineFalsification.command, /test-name-pattern/u);
  assert.match(defect.offlineFalsification.result, /变红.*回绿|撤销.*恢复/u);
  assert.equal(typeof defect.liveReproduction.requires, 'string');
});

test('A2 受控证据已脱敏（可证伪）', () => {
  const files = ['README.md', 'live-write-demo.json', 'rollback-defect.json'];
  for (const name of files) {
    const text = readFileSync(join(EVIDENCE_DIR, name), 'utf8');
    // 不得出现字段级 before/after 值：JSON 键形态与常见写法都挡掉
    assert.doesNotMatch(text, /"before"\s*:/u, `${name} 不得含字段 before 值`);
    assert.doesNotMatch(text, /"after"\s*:/u, `${name} 不得含字段 after 值`);
    // 不得出现凭证形态（token / api key 赋值）
    assert.doesNotMatch(text, /ZOTERO_MCP_PLUGIN_TOKEN|api[_-]?key\s*[:=]\s*["'][A-Za-z0-9]{8,}/iu, `${name} 不得含凭证`);
    // 不得出现真实文献标题（本仓库真机库里的既有文献）
    assert.doesNotMatch(text, /glacier erosion|sea ice extent/u, `${name} 不得含正文`);
  }

  // 正向对照（本机存在审计流水时）：原始流水确实含字段 before/after 键——证明上面的断言不是恒真
  const auditPath = join(ROOT, '.audit', 'audit.jsonl');
  if (existsSync(auditPath)) {
    const raw = readFileSync(auditPath, 'utf8');
    assert.match(raw, /"before"/u, '本机审计流水应含字段级键，用来对照「脱敏断言不是恒真」');
  }

  const demo = readJson('live-write-demo.json');
  assert.deepEqual(demo.redaction.excludes, ['字段 before/after 值', '条目正文', '注释正文', '任何凭证']);
  assert.deepEqual(demo.redaction.includes, ['planId', 'item key', 'counts', 'status', 'timestamps', 'channel', 'serverId']);
});
