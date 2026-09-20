/**
 * 重复项合并与客户端识别契约测试（change 13 · m4-plugin-merge-recognize）。
 *
 * 四条独立验证线：
 *   1. MCP 侧编排：真跑 `zotero_merge_duplicates` 与 `zotero_client(mode=recognize)`，验
 *      dry-run 零写请求、双重门禁（缺 confirm / 未开写都在**发请求之前**拒绝）、快照先于写入、
 *      写后回读主记录与垃圾箱核对、审计 JSONL 留痕、插件不可用降级；
 *   2. 插件端点：把与 `npm run plugin:build` 同源同参构建出的 bundle 放进 vm 沙箱配假 Zotero 全局，验「用户取消 →
 *      409 且不合并」「主窗口不可用 → 503 且不问确认」「跨库 → 400」「确认后调用 Zotero 自己的
 *      `mergeItems`」与识别端点的逐条 before → after；
 *   3. 工具面：公开工具清单、合并工具的参数与默认只读总闸、`mode=recognize` 的写参数齐备；
 *   4. 隔离自证：全部写路径的审计目录都在临时目录，仓库 `.audit` 逐文件不变。
 *
 * 关键是真机语义：本地 API（`/api/...`）与插件端点（`/zoteromcp/*`）在 Zotero 里由**同一个**
 * HTTP 服务器托管，所以这里也把「假 Zotero 本地 API」与「假插件」装到同一个端口上。
 *
 * 全程不访问网络、不触碰真实 Zotero 库、不写真实 .audit。
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  MERGE_CONFIRM_KEYWORD,
  PLUGIN_CLIENT_MODES,
  PLUGIN_ENDPOINTS,
  PLUGIN_TOKEN_HEADER,
  RECOGNIZE_CONFIRM_KEYWORD,
  buildMergePlan,
  isRecognizablePdf,
  normalizeMergeKeys,
} from '../../packages/core/src/index.ts';
import { createServer as createMcpServer } from '../../packages/mcp-server/src/server.ts';
import { ALL_TOOLS, GATED_TOOL_NAME_SET, TOOL_NAMES } from '../../packages/mcp-server/src/tools.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';
import { PLUGIN_SRC, bundle } from '../../scripts/plugin-build.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TOKEN = 'merge-token-abc';
/** 真机写请求的授权形态：一次 authorize 拿到的 key（假服务器只要求头存在）。 */
const FAKE_API_KEY = 'FAKEKEY00000000000000000000000000';

// ── 隔离自证：仓库 .audit 必须逐字节不变 ─────────────────────────────────

function auditFingerprint() {
  const root = join(ROOT, '.audit');
  const entries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries.push(`${relative(ROOT, full)}:${statSync(full).size}`);
    }
  };
  if (existsSync(root)) walk(root);
  return entries.sort().join('\n');
}

function snapshotFiles(dir) {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

// ── 假服务器：本地 API + 插件端点同端口 ─────────────────────────────────

function forwardHeaders(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)) continue;
    out[key] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/**
 * 起「假 Zotero 本地 API + 假插件端点」。
 *
 * `pluginMode`：`ok` / `endpoint-missing`（全部 /zoteromcp/* 404）/ `endpoint-error`（500）/
 * `cancel`（合并端点返回 409，模拟用户在 Zotero 确认框里点了取消）。
 * `onMerge`：合并端点在响应前执行的回调（测试用它回读「此刻快照是否已落盘」）。
 */
async function startCombinedFake(options = {}) {
  const zotero = await startFakeZotero(options.zotero ?? {});
  const pluginMode = options.pluginMode ?? 'ok';
  const token = options.token ?? TOKEN;
  const pluginRequests = [];
  const state = { mergeBodies: [], recognizeBodies: [], snapshotFilesAtMerge: null, snapshotFilesAtRecognize: null, trashed: [] };

  /** 假插件模拟 Zotero 自己的合并：把被合并条目移入垃圾箱（真机由 mergeItems 完成）。 */
  async function trashItem(key) {
    const info = await (await fetch(`${zotero.url}/api/users/0/items/${key}`)).json();
    const response = await fetch(`${zotero.url}/api/users/0/items/${key}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${FAKE_API_KEY}`,
        'zotero-server-id': zotero.serverId,
        'if-unmodified-since-version': String(info.version),
      },
      body: JSON.stringify({ deleted: 1 }),
    });
    assert.equal(response.status, 204, `假插件未能把 ${key} 移入垃圾箱：HTTP ${response.status}`);
    state.trashed.push(key);
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      void (async () => {
        if (!url.pathname.startsWith('/zoteromcp/')) {
          // 本地 API：原样转发（真机上两者由同一个 HTTP 服务器托管）
          const upstream = await fetch(`${zotero.url}${req.url}`, {
            method: req.method,
            headers: forwardHeaders(req.headers),
            ...(req.method === 'GET' || req.method === 'HEAD' ? {} : { body }),
          });
          const buffer = Buffer.from(await upstream.arrayBuffer());
          res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
          res.end(buffer);
          return;
        }
        pluginRequests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
        const send = (status, payload) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        };
        if (pluginMode === 'endpoint-missing') return send(404, { error: 'Not found' });
        if (pluginMode === 'endpoint-error') return send(500, { ok: false, error: 'endpoint-failed' });
        if (req.headers[PLUGIN_TOKEN_HEADER.toLowerCase()] !== token) return send(401, { ok: false, error: 'unauthorized' });
        if (url.pathname === '/zoteromcp/health' && req.method === 'GET') {
          return send(200, {
            ok: true,
            plugin: { id: 'zotero-mcp@guozao-ex.github.io', version: '1.1.0' },
            endpoints: [...PLUGIN_ENDPOINTS],
            sync: { enabled: false, running: false, lastSync: null, lastSyncError: null },
            httpServer: { port: 23119 },
          });
        }
        if (url.pathname === '/zoteromcp/merge' && req.method === 'POST') {
          const parsed = body.length > 0 ? JSON.parse(body) : {};
          state.mergeBodies.push(parsed);
          state.snapshotFilesAtMerge = snapshotFiles(options.snapshotsDir ?? '');
          await options.onMerge?.(parsed);
          if (pluginMode === 'cancel') {
            return send(409, { ok: false, error: 'cancelled-by-user', primaryKey: parsed.primaryKey, mergeKeys: parsed.mergeKeys });
          }
          for (const key of parsed.mergeKeys ?? []) await trashItem(key);
          return send(200, { ok: true, primaryKey: parsed.primaryKey, mergedKeys: parsed.mergeKeys, trashedKeys: parsed.mergeKeys });
        }
        if (url.pathname === '/zoteromcp/recognize-pdf' && req.method === 'POST') {
          const parsed = body.length > 0 ? JSON.parse(body) : {};
          state.recognizeBodies.push(parsed);
          // 与 merge 侧同强度：抓「插件收到请求的那一刻」快照目录里已有哪些文件
          state.snapshotFilesAtRecognize = snapshotFiles(options.snapshotsDir ?? '');
          const results = (parsed.keys ?? []).map((key, index) =>
            index === 0
              ? {
                  key,
                  ok: true,
                  recognized: true,
                  before: { title: '', creators: '', date: '', DOI: '', publicationTitle: '' },
                  after: { title: 'Recognized title', creators: 'Ada Author', date: '2021', DOI: '10.1000/alpha', publicationTitle: 'Journal of Tests' },
                }
              : { key, ok: true, recognized: false, reason: 'can-recognize-false', before: { title: 'Note' }, after: { title: 'Note' } },
          );
          return send(200, { ok: results.every((entry) => entry.ok), results });
        }
        return send(404, { error: 'Not found' });
      })().catch((error) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(error) }));
      });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    pluginRequests,
    state,
    zotero,
    mergeRequests: () => pluginRequests.filter((entry) => entry.path === '/zoteromcp/merge'),
    close: () =>
      new Promise((resolve) => {
        server.close(() => void zotero.close().then(resolve));
      }),
  };
}

async function connectPair() {
  const server = createMcpServer();
  const client = new Client({ name: 'merge-duplicates-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function parseResult(result) {
  return JSON.parse(String(result.content[0]?.text ?? 'null'));
}

/** 起「临时数据目录 + 临时审计目录 + 假服务器 + MCP 客户端」，结束后完整恢复环境并自证隔离。 */
async function withMergeEnv(fn, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-merge-'));
  const auditDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-merge-audit-'));
  const snapshotsDir = join(auditDir, 'snapshots');
  writeFileSync(join(dataDir, 'zoteromcp-token.txt'), `${options.token ?? TOKEN}\n`, 'utf8');
  const before = auditFingerprint();
  const fake = await startCombinedFake({ ...options, snapshotsDir });
  const previous = {
    data: process.env['ZOTERO_MCP_DATA_DIR'],
    token: process.env['ZOTERO_MCP_PLUGIN_TOKEN'],
    base: process.env['ZOTERO_MCP_BASE_URL'],
    audit: process.env['ZOTERO_MCP_AUDIT_DIR'],
    write: process.env['ZOTERO_MCP_WRITE'],
  };
  process.env['ZOTERO_MCP_DATA_DIR'] = dataDir;
  delete process.env['ZOTERO_MCP_PLUGIN_TOKEN'];
  process.env['ZOTERO_MCP_AUDIT_DIR'] = auditDir;
  process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
  if (options.write === true) process.env['ZOTERO_MCP_WRITE'] = 'on';
  else delete process.env['ZOTERO_MCP_WRITE'];
  const { client, server } = await connectPair();
  try {
    return await fn({ client, server, fake, dataDir, auditDir, snapshotsDir });
  } finally {
    await client.close();
    await server.close();
    await fake.close();
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('ZOTERO_MCP_DATA_DIR', previous.data);
    restore('ZOTERO_MCP_PLUGIN_TOKEN', previous.token);
    restore('ZOTERO_MCP_BASE_URL', previous.base);
    restore('ZOTERO_MCP_AUDIT_DIR', previous.audit);
    restore('ZOTERO_MCP_WRITE', previous.write);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
    assert.equal(auditFingerprint(), before, '契约测试绝不能改动仓库真实 .audit（写路径必须指向临时目录）');
  }
}

function readAudit(auditDir) {
  const path = join(auditDir, 'audit.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// ── 1. MCP 侧编排：计划与门禁 ───────────────────────────────────────────

test('合并计划：默认 dry-run 只发读请求，给出影响面与快照路径但不落盘、不写审计', async () => {
  await withMergeEnv(async ({ client, fake, auditDir }) => {
    const result = parseResult(
      await client.callTool({ name: 'zotero_merge_duplicates', arguments: { primaryKey: 'ITEM0001', mergeKeys: ['ITEM0002'] } }),
    );
    assert.equal(result.dryRun, true);
    assert.equal(result.pluginAvailable, true);
    assert.equal(result.writeEnabled, false);
    // 影响面必须真实（曾经只请求 children，导致子项计数恒为 0 而看起来「没有东西要迁移」）
    assert.deepEqual(result.impacts, {
      totalItems: 2,
      attachments: 2,
      notes: 1,
      annotations: 1,
      collections: ['COLL0001'],
      tags: ['alpha'],
    });
    assert.match(result.summary, /合并 1 条到 ITEM0001/u);
    assert.ok(result.snapshotPath.endsWith('-merge.json'), `快照路径形态不对：${result.snapshotPath}`);
    assert.ok(result.snapshotPath.includes('snapshots'), '快照必须落在 snapshots 子目录');
    // dry-run 只是「承诺」快照路径：此刻既没有快照，也没有审计
    assert.equal(existsSync(result.snapshotPath), false, 'dry-run 不得写快照');
    assert.deepEqual(snapshotFiles(join(auditDir, 'snapshots')), []);
    assert.deepEqual(readAudit(auditDir), []);
    // 只发读请求：对本地 API 与插件一律 GET
    assert.ok(fake.zotero.requests.length > 0);
    for (const entry of fake.zotero.requests) assert.equal(entry.method, 'GET', `计划阶段出现非 GET 请求：${entry.path}`);
    for (const entry of fake.pluginRequests) assert.equal(entry.method, 'GET', `计划阶段对插件出现非 GET 请求：${entry.path}`);
    assert.ok(!JSON.stringify(result).includes(TOKEN), 'token 绝不能出现在工具结果里');
  });
});

test('门禁：未开写时 dryRun=false 连计划都不生成（零请求）', async () => {
  await withMergeEnv(
    async ({ client, fake, auditDir }) => {
      const refused = await client.callTool({
        name: 'zotero_merge_duplicates',
        arguments: { primaryKey: 'ITEM0001', mergeKeys: ['ITEM0002'], dryRun: false, confirm: MERGE_CONFIRM_KEYWORD },
      });
      assert.equal(refused.isError, true);
      assert.match(String(refused.content[0].text), /ZOTERO_MCP_WRITE/u);
      assert.equal(fake.zotero.requests.length, 0, '被总闸拦下时不得对本地 API 发任何请求');
      assert.equal(fake.pluginRequests.length, 0, '被总闸拦下时不得对插件发任何请求');
      assert.deepEqual(readAudit(auditDir), []);
    },
    { write: false },
  );
});

test('门禁：开写但缺 confirm 时在任何请求之前拒绝，且零写请求', async () => {
  await withMergeEnv(
    async ({ client, fake, auditDir }) => {
      const refused = await client.callTool({
        name: 'zotero_merge_duplicates',
        arguments: { primaryKey: 'ITEM0001', mergeKeys: ['ITEM0002'], dryRun: false },
      });
      assert.equal(refused.isError, true);
      assert.match(String(refused.content[0].text), /confirm="MERGE"/u, '拒绝理由必须写明缺 confirm');
      assert.equal(fake.zotero.requests.length, 0, '缺 confirm 必须在生成计划之前就拒绝');
      assert.deepEqual(snapshotFiles(join(auditDir, 'snapshots')), [], '被拒绝时不得写快照');
      assert.deepEqual(readAudit(auditDir), [], '被拒绝时不得写审计');
    },
    { write: true },
  );
});

// ── 2. MCP 侧编排：提交与写后核对 ───────────────────────────────────────

test('提交合并：快照先落盘 → 插件执行 → 回读主记录 + 核对垃圾箱 + 审计留痕', async () => {
  await withMergeEnv(
    async ({ client, fake, auditDir }) => {
      const result = parseResult(
        await client.callTool({
          name: 'zotero_merge_duplicates',
          arguments: { primaryKey: 'ITEM0001', mergeKeys: ['ITEM0002'], dryRun: false, confirm: MERGE_CONFIRM_KEYWORD },
        }),
      );
      assert.equal(result.dryRun, false);
      assert.equal(result.applied, true);
      assert.deepEqual(result.mergedKeys, ['ITEM0002']);
      assert.deepEqual(result.trashedKeys, ['ITEM0002'], '必须核对被合并条目确实进了垃圾箱');
      assert.deepEqual(result.notes, [], '回读与垃圾箱核对都通过时不应有告警');
      // 快照先于写入：插件收到合并请求时，快照文件必须已经在盘上
      assert.deepEqual(fake.state.snapshotFilesAtMerge, [`${result.planId}-merge.json`], '快照必须先于插件调用落盘');
      assert.equal(existsSync(result.snapshotPath), true);
      const snapshot = JSON.parse(readFileSync(result.snapshotPath, 'utf8'));
      assert.equal(snapshot.kind, 'merge');
      assert.equal(snapshot.primaryKey, 'ITEM0001');
      assert.deepEqual(snapshot.mergeKeys, ['ITEM0002']);
      assert.deepEqual(snapshot.items.map((entry) => entry.key), ['ITEM0001', 'ITEM0002']);
      const primary = snapshot.items[0];
      assert.equal(primary.data.title, 'Alpha paper', '快照必须含完整条目 JSON（键序无关）');
      assert.deepEqual(primary.childCounts, { attachments: 1, notes: 1, annotations: 1 });
      assert.deepEqual(snapshot.items[1].childCounts, { attachments: 1, notes: 0, annotations: 0 });
      // 请求形态：token 只在请求头
      assert.equal(fake.mergeRequests().length, 1);
      const request = fake.mergeRequests()[0];
      assert.equal(request.headers[PLUGIN_TOKEN_HEADER.toLowerCase()], TOKEN);
      assert.deepEqual(JSON.parse(request.body), { primaryKey: 'ITEM0001', mergeKeys: ['ITEM0002'] });
      assert.ok(!request.body.includes(TOKEN));
      // 写后真实状态：主记录仍在、被合并条目已在垃圾箱且不在 /items 列表里
      const merge = await (await fetch(`${fake.zotero.url}/api/users/0/items/ITEM0001`)).json();
      assert.equal(merge.key, 'ITEM0001');
      const trash = await (await fetch(`${fake.zotero.url}/api/users/0/items/trash`)).json();
      assert.deepEqual(trash.map((entry) => entry.key).filter((key) => key === 'ITEM0002'), ['ITEM0002']);
      const top = await (await fetch(`${fake.zotero.url}/api/users/0/items`)).json();
      assert.ok(!top.some((entry) => entry.key === 'ITEM0002'), '被合并条目不得再出现在条目列表');
      assert.ok(!top.some((entry) => entry.key === 'ITEM0001' && entry.data.title !== 'Alpha paper'), '未参与合并的主记录字段不得改写');
      // 审计
      const records = readAudit(auditDir);
      assert.equal(records.length, 1);
      assert.equal(records[0].op, 'merge');
      assert.equal(records[0].status, 'merged');
      assert.equal(records[0].executed, true);
      assert.deepEqual(records[0].trashedKeys, ['ITEM0002']);
      assert.equal(records[0].snapshotPath, result.snapshotPath);
      assert.ok(!JSON.stringify(records).includes(TOKEN), '审计里绝不能出现 token');
    },
    { write: true },
  );
});

test('用户取消：409 → 不合并、条目原状、快照保留且审计写明未执行', async () => {
  await withMergeEnv(
    async ({ client, fake, auditDir, snapshotsDir }) => {
      const result = parseResult(
        await client.callTool({
          name: 'zotero_merge_duplicates',
          arguments: { primaryKey: 'ITEM0001', mergeKeys: ['ITEM0002'], dryRun: false, confirm: MERGE_CONFIRM_KEYWORD },
        }),
      );
      assert.equal(result.applied, false);
      assert.equal(result.reason, 'cancelled-by-user');
      assert.deepEqual(result.trashedKeys, []);
      assert.match(result.notes.join(' '), /取消/u);
      // 库内条目保持原状
      assert.deepEqual(fake.state.trashed, []);
      const trash = await (await fetch(`${fake.zotero.url}/api/users/0/items/trash`)).json();
      assert.deepEqual(trash, [], '取消后不得有任何条目进垃圾箱');
      const item = await (await fetch(`${fake.zotero.url}/api/users/0/items/ITEM0002`)).json();
      assert.equal(item.data.title, 'Alpha paper (duplicate)', '被合并条目必须完好');
      // 快照仍保留（用户取消不是「什么都没发生」的证据缺口）
      assert.deepEqual(snapshotFiles(snapshotsDir), [`${result.planId}-merge.json`]);
      const records = readAudit(auditDir);
      assert.equal(records.length, 1);
      assert.equal(records[0].status, 'cancelled-by-user');
      assert.equal(records[0].executed, false);
    },
    { write: true, pluginMode: 'cancel' },
  );
});

test('插件不可用：只给候选与人工指引，零写请求、无快照无审计；识别同样降级', async () => {
  await withMergeEnv(
    async ({ client, fake, auditDir }) => {
      const planned = parseResult(
        await client.callTool({ name: 'zotero_merge_duplicates', arguments: { primaryKey: 'ITEM0001', mergeKeys: ['ITEM0002'] } }),
      );
      assert.equal(planned.pluginAvailable, false);
      assert.equal(planned.reason, 'endpoint-missing');
      assert.match(planned.guide, /人工合并/u, '插件不可用时必须给出人工合并指引');
      assert.deepEqual(planned.mergeKeys, ['ITEM0002'], '降级结果里仍要给出被合并条目清单');
      assert.ok(planned.hint.length > 0);

      // 即使带 confirm 提交：降级路径同样不合并
      const submitted = parseResult(
        await client.callTool({
          name: 'zotero_merge_duplicates',
          arguments: { primaryKey: 'ITEM0001', mergeKeys: ['ITEM0002'], dryRun: false, confirm: MERGE_CONFIRM_KEYWORD },
        }),
      );
      assert.equal(submitted.applied, false);
      assert.equal(submitted.pluginAvailable, false);
      assert.equal(submitted.snapshotPath, null);
      // 识别同样降级
      const recognize = parseResult(await client.callTool({ name: 'zotero_client', arguments: { mode: 'recognize', keys: ['ITEM0001'] } }));
      assert.equal(recognize.pluginAvailable, false);
      assert.equal(recognize.reason, 'endpoint-missing');
      assert.match(recognize.guide, /识别器/u);

      assert.deepEqual(fake.state.mergeBodies, [], '降级时不得调用合并端点');
      assert.deepEqual(snapshotFiles(join(auditDir, 'snapshots')), [], '降级不得写快照');
      assert.deepEqual(readAudit(auditDir), [], '降级不得写审计');
      for (const entry of fake.zotero.requests) assert.equal(entry.method, 'GET', '降级路径同样只读');
    },
    { write: true, pluginMode: 'endpoint-missing' },
  );
});

// ── 3. MCP 侧编排：客户端识别 ───────────────────────────────────────────

test('识别：默认只出计划；写入需要 confirm="OVERWRITE"，并逐条给出 before → after', async () => {
  await withMergeEnv(
    async ({ client, fake, auditDir }) => {
      const planned = parseResult(await client.callTool({ name: 'zotero_client', arguments: { mode: 'recognize', keys: ['ITEM0001', 'ITEM0002'] } }));
      assert.equal(planned.dryRun, true);
      assert.equal(planned.pluginAvailable, true);
      assert.deepEqual(planned.targets.map((entry) => entry.key), ['ITEM0001', 'ITEM0002']);
      assert.equal(planned.targets[0].isPdf, true, 'targets 必须如实反映条目是否带 PDF 附件');
      assert.equal(planned.targets[1].isPdf, true);
      // 顶层 PDF 附件是插件 canRecognize 唯一接受的形态，不带 PDF 的条目才是 false
      const mixed = parseResult(await client.callTool({ name: 'zotero_client', arguments: { mode: 'recognize', keys: ['ATT00001', 'ITEM0003'] } }));
      assert.equal(mixed.targets.find((entry) => entry.key === 'ATT00001')?.isPdf, true, '顶层 PDF 附件必须报 isPdf: true');
      assert.equal(mixed.targets.find((entry) => entry.key === 'ITEM0003')?.isPdf, false, '不带 PDF 的条目必须报 isPdf: false');
      assert.ok(planned.snapshotPath.includes('recognize-'));
      assert.deepEqual(fake.state.recognizeBodies, [], '默认只读：不得调用识别端点');

      // 缺 confirm：在任何请求之前拒绝
      const requestsAfterPlan = fake.zotero.requests.length;
      const refused = await client.callTool({ name: 'zotero_client', arguments: { mode: 'recognize', keys: ['ITEM0001'], dryRun: false } });
      assert.equal(refused.isError, true);
      assert.match(String(refused.content[0].text), /confirm="OVERWRITE"/u);
      assert.equal(fake.zotero.requests.length, requestsAfterPlan, '缺 confirm 时不得再发任何请求');

      const applied = parseResult(
        await client.callTool({
          name: 'zotero_client',
          arguments: { mode: 'recognize', keys: ['ITEM0001', 'ITEM0002'], dryRun: false, confirm: RECOGNIZE_CONFIRM_KEYWORD },
        }),
      );
      assert.equal(applied.dryRun, false);
      assert.equal(applied.applied, true);
      assert.equal(applied.results.length, 2);
      assert.equal(applied.results[0].recognized, true);
      assert.deepEqual(applied.results[0].before, { title: '', creators: '', date: '', DOI: '', publicationTitle: '' });
      assert.equal(applied.results[0].after.title, 'Recognized title');
      assert.equal(applied.results[1].recognized, false);
      assert.equal(applied.results[1].reason, 'can-recognize-false', '不可识别条目必须如实回报');
      // 快照先于写入
      assert.deepEqual(fake.state.snapshotFilesAtRecognize, [`${applied.planId}.json`], '快照必须先于识别请求落盘（与合并侧等强度）');
      const records = readAudit(auditDir);
      assert.equal(records.length, 1);
      assert.equal(records[0].op, 'recognize');
      assert.equal(records[0].status, 'recognized');
      assert.deepEqual(records[0].recognized, ['ITEM0001']);
      assert.equal(fake.state.recognizeBodies.length, 1);
      assert.deepEqual(fake.state.recognizeBodies[0], { keys: ['ITEM0001', 'ITEM0002'] });
      assert.ok(!JSON.stringify(applied).includes(TOKEN));
    },
    { write: true },
  );
});

test('识别：未开写时 dryRun=false 连计划都不生成（零请求）', async () => {
  await withMergeEnv(
    async ({ client, fake }) => {
      const refused = await client.callTool({
        name: 'zotero_client',
        arguments: { mode: 'recognize', keys: ['ITEM0001'], dryRun: false, confirm: RECOGNIZE_CONFIRM_KEYWORD },
      });
      assert.equal(refused.isError, true);
      assert.match(String(refused.content[0].text), /ZOTERO_MCP_WRITE/u);
      assert.equal(fake.zotero.requests.length, 0);
      assert.equal(fake.pluginRequests.length, 0);
    },
    { write: false },
  );
});

// ── 4. 参数白名单（纯函数） ─────────────────────────────────────────────

test('识别目标口径：顶层 PDF 附件必须算「可识别」，旧口径在这里必然为假', () => {
  // 反证前提：插件的 canRecognize 只接受顶层 PDF / EPUB 附件，而这类附件的子附件是空的
  // —— 旧实现只看 item.attachments，对它们必然返回 false。
  assert.equal(isRecognizablePdf({ itemType: 'attachment', data: { contentType: 'application/pdf' }, attachments: [] }), true);
  // 反证前提：旧实现（只看子附件）对同一个输入必然返回 false —— 上面那条断言在旧实现下会失败
  assert.equal(
    { itemType: 'attachment', data: { contentType: 'application/pdf' }, attachments: [] }.attachments.some((child) => child.isPdf),
    false,
    '旧口径对顶层 PDF 附件必然为假（本次修正的正是这一点）',
  );
  // 非 PDF 附件、带 PDF 子附件的父条目、两者都不是的条目
  assert.equal(isRecognizablePdf({ itemType: 'attachment', data: { contentType: 'text/html' }, attachments: [] }), false);
  assert.equal(isRecognizablePdf({ itemType: 'journalArticle', data: {}, attachments: [{ isPdf: true }] }), true);
  assert.equal(isRecognizablePdf({ itemType: 'book', data: {}, attachments: [] }), false);
});

test('合并参数白名单：空列表、自合并、非法 key 一律拒绝，重复 key 去重', () => {
  assert.deepEqual(normalizeMergeKeys('AAAA1111', ['BBBB2222', ' BBBB2222 ', 'CCCC3333']), {
    primaryKey: 'AAAA1111',
    mergeKeys: ['BBBB2222', 'CCCC3333'],
  });
  assert.throws(() => normalizeMergeKeys('', ['BBBB2222']), /primaryKey 不能为空/u);
  assert.throws(() => normalizeMergeKeys('AAAA1111', []), /mergeKeys 不能为空/u);
  assert.throws(() => normalizeMergeKeys('AAAA1111', ['  ']), /mergeKeys 不能为空/u);
  assert.throws(() => normalizeMergeKeys('AAAA1111', ['AAAA1111']), /不能出现在 mergeKeys/u);
  assert.throws(() => normalizeMergeKeys('AAAA1111', ['bad key!']), /key 格式非法/u);
});

// ── 5. 工具面 ───────────────────────────────────────────────────────────

test('工具面：公开工具清单与 write-tools 口径一致，合并工具参数齐备且受默认只读总闸约束', async () => {
  assert.equal(ALL_TOOLS.length, 24);
  assert.equal(TOOL_NAMES.length, 24);
  assert.ok(GATED_TOOL_NAME_SET.has('zotero_merge_duplicates'), '合并是破坏性操作，必须受默认只读总闸约束');
  await withMergeEnv(async ({ client }) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 24);
    const merge = tools.find((entry) => entry.name === 'zotero_merge_duplicates');
    assert.ok(merge, '缺少 zotero_merge_duplicates');
    assert.deepEqual(Object.keys(merge.inputSchema.properties).sort(), ['confirm', 'dryRun', 'mergeKeys', 'primaryKey']);
    assert.deepEqual([...merge.inputSchema.required].sort(), ['mergeKeys', 'primaryKey']);
    const clientTool = tools.find((entry) => entry.name === 'zotero_client');
    assert.deepEqual(clientTool.inputSchema.properties.mode.enum, [...PLUGIN_CLIENT_MODES]);
    // 写路径的参数必须在 schema 里声明，否则客户端传来的 confirm 会被协议层丢掉
    assert.ok(clientTool.inputSchema.properties.confirm, 'zotero_client 必须声明 confirm，否则 mode=recognize 的写路径不可达');
    assert.ok(clientTool.inputSchema.properties.dryRun, 'zotero_client 必须声明 dryRun');
    // 非法参数在协议层就被拒
    const missing = await client.callTool({ name: 'zotero_merge_duplicates', arguments: { primaryKey: 'ITEM0001' } });
    assert.equal(missing.isError, true);
    const noKeys = await client.callTool({ name: 'zotero_client', arguments: { mode: 'recognize' } });
    assert.equal(noKeys.isError, true);
    assert.match(String(noKeys.content[0].text), /必须提供 keys/u);
  });
});

// ── 6. 插件端点（vm 沙箱 + 假 Zotero 全局） ─────────────────────────────

let built = null;
/**
 * 构建一次并缓存。
 *
 * 用与 `npm run plugin:build` **同一个打包函数与同一份入口**，但输出到本进程自己的临时
 * 目录：`main()` 会先清空共享的 `build/plugin/`，与 `plugin-channel.test.mjs` 并行时会互删产物。
 * 打包产物本身（XPI 结构、manifest、可复现性）由 `plugin-channel.test.mjs` 覆盖。
 */
async function buildOnce() {
  if (built === null) {
    const stage = mkdtempSync(join(tmpdir(), 'zotero-mcp-plugin-stage-'));
    built = readFileSync(await bundle(PLUGIN_SRC, stage), 'utf8');
  }
  return built;
}

/**
 * 假 Zotero 全局 + vm 沙箱。
 *
 * `items` 是 key → 条目桩；条目桩带 `libraryID`（跨库判定）与可变的 `fields`（识别前后对照）。
 */
function sandboxPlugin(bundleSource, options = {}) {
  const endpoints = {};
  const mergeItemsCalls = [];
  const recognizeCalls = [];
  const state = { prompts: [], promptAnswer: options.promptAnswer !== false };
  const items = new Map(
    Object.entries(
      options.items ?? {
        AAAA1111: { libraryID: 1, fields: { title: 'Primary', date: '2020', DOI: '10.1/a' } },
        BBBB2222: { libraryID: 1, fields: { title: 'Duplicate', date: '', DOI: '' } },
        CCCC3333: { libraryID: 2, fields: { title: 'Other library', date: '', DOI: '' } },
      },
    ).map(([key, spec]) => {
      const fields = { ...(spec.fields ?? {}) };
      return [key, { key, id: key.length, libraryID: spec.libraryID, fields, getField: (field) => fields[field] ?? '' }];
    }),
  );
  const Zotero = {
    debug: () => {},
    DataDirectory: { dir: 'D:/fake/zotero-data' },
    Prefs: { get: () => 23119 },
    Server: { Endpoints: endpoints },
    Libraries: { userLibraryID: 1 },
    Items: { getByLibraryAndKeyAsync: async (_libraryID, key) => items.get(key) ?? null },
    getMainWindow: () => (options.noMainWindow === true ? null : { focus: () => {} }),
    RecognizeDocument: {
      canRecognize: (item) => options.canRecognize?.(item) !== false,
      recognizeItems: async (list) => {
        // 跨 realm 断言要当心：一律用宿主的 Array.from 展开，得到宿主数组
        recognizeCalls.push(Array.from(list, (item) => item.key));
        for (const item of list) Object.assign(item.fields, options.recognizedFields ?? {});
      },
    },
    ...(options.Zotero ?? {}),
  };
  const sandbox = {
    console,
    Zotero,
    PathUtils: { join: (a, b) => `${String(a).replace(/\/$/u, '')}/${b}` },
    IOUtils: { readUTF8: async () => options.token ?? TOKEN },
    Services: {
      scriptloader: { loadSubScript: () => {} },
      prompt: {
        confirm: (window, title, message) => {
          state.prompts.push({ title, message, window });
          return state.promptAnswer;
        },
      },
    },
    ChromeUtils: {
      importESModule: (spec) => {
        if (options.mergeModuleThrows === true) throw new Error(`no such module: ${spec}`);
        return {
          mergeItems: async (primary, others) => {
            mergeItemsCalls.push({ primaryKey: primary.key, otherKeys: Array.from(others, (item) => item.key) });
            for (const item of others) items.delete(item.key);
          },
        };
      },
    },
    setTimeout,
    clearTimeout,
    ...(options.globals ?? {}),
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bundleSource, sandbox, { filename: 'channel.js' });
  return { sandbox, bundle: sandbox.ZoteroMCPChannel, endpoints, state, items, mergeItemsCalls, recognizeCalls };
}

async function startSandbox(options = {}) {
  const sandbox = sandboxPlugin(await buildOnce(), options);
  const instance = sandbox.bundle.create({ id: 'zotero-mcp@test', version: '1.1.0', rootURI: 'file:///plugin/' });
  await instance.startup();
  return {
    ...sandbox,
    merge: new sandbox.endpoints['/zoteromcp/merge'](),
    recognize: new sandbox.endpoints['/zoteromcp/recognize-pdf'](),
  };
}

const MERGE_BODY = { primaryKey: 'AAAA1111', mergeKeys: ['BBBB2222'] };
const AUTH = { 'x-zoteromcp-token': TOKEN };

test('插件合并端点：确认后调用 Zotero 自己的 mergeItems，缺 token 一律 401', async () => {
  const plugin = await startSandbox();
  assert.equal((await plugin.merge.init({ method: 'POST', headers: {}, data: MERGE_BODY }))[0], 401);
  assert.deepEqual(plugin.mergeItemsCalls, []);
  const response = await plugin.merge.init({ method: 'POST', headers: AUTH, data: MERGE_BODY });
  assert.equal(response[0], 200);
  const body = JSON.parse(response[2]);
  assert.deepEqual(body, { ok: true, primaryKey: 'AAAA1111', mergedKeys: ['BBBB2222'], trashedKeys: ['BBBB2222'] });
  assert.deepEqual(plugin.mergeItemsCalls, [{ primaryKey: 'AAAA1111', otherKeys: ['BBBB2222'] }], '必须交给 Zotero 自己的实现');
  // 确认框文案要含主记录与将被合并的 key
  assert.equal(plugin.state.prompts.length, 1);
  assert.match(plugin.state.prompts[0].message, /BBBB2222/u);
  assert.match(plugin.state.prompts[0].message, /AAAA1111/u);
  assert.match(plugin.state.prompts[0].message, /垃圾箱/u, '必须如实告知被合并条目进垃圾箱');
});

test('插件合并端点：用户在确认框取消 → 409 且不做任何合并', async () => {
  const plugin = await startSandbox({ promptAnswer: false });
  const response = await plugin.merge.init({ method: 'POST', headers: AUTH, data: MERGE_BODY });
  assert.equal(response[0], 409);
  assert.equal(JSON.parse(response[2]).error, 'cancelled-by-user');
  assert.deepEqual(plugin.mergeItemsCalls, [], '取消后绝不能执行合并');
  assert.deepEqual([...plugin.items.keys()].sort(), ['AAAA1111', 'BBBB2222', 'CCCC3333'], '取消后被合并条目必须完好');
});

test('插件合并端点：主窗口不可用时 503 且不弹确认、不合并', async () => {
  const plugin = await startSandbox({ noMainWindow: true });
  const response = await plugin.merge.init({ method: 'POST', headers: AUTH, data: MERGE_BODY });
  assert.equal(response[0], 503);
  assert.equal(JSON.parse(response[2]).error, 'main-window-unavailable');
  assert.deepEqual(plugin.state.prompts, [], '没有主窗口就没有可确认的对象，不得弹出确认框');
  assert.deepEqual(plugin.mergeItemsCalls, []);
  assert.deepEqual([...plugin.items.keys()].sort(), ['AAAA1111', 'BBBB2222', 'CCCC3333']);
});

test('插件合并端点：参数白名单与跨库拒绝都在确认之前', async () => {
  const plugin = await startSandbox();
  const cases = [
    [{}, 400, 'primary-key-required'],
    [{ primaryKey: 'AAAA1111', mergeKeys: [] }, 400, 'merge-keys-required'],
    [{ primaryKey: 'AAAA1111', mergeKeys: ['AAAA1111'] }, 400, 'primary-in-merge-keys'],
    [{ primaryKey: 'AAAA1111', mergeKeys: ['BBBB2222', 'BBBB2222'] }, 400, 'duplicate-merge-keys'],
    [{ primaryKey: 'AAAA1111', mergeKeys: ['NOPE0000'] }, 404, 'item-not-found'],
    [{ primaryKey: 'AAAA1111', mergeKeys: ['CCCC3333'] }, 400, 'cross-library'],
  ];
  for (const [data, status, error] of cases) {
    const response = await plugin.merge.init({ method: 'POST', headers: AUTH, data });
    assert.equal(response[0], status, `${JSON.stringify(data)} 的响应状态不对`);
    assert.equal(JSON.parse(response[2]).error, error);
  }
  assert.deepEqual(plugin.state.prompts, [], '参数被拒时不得骚扰用户');
  assert.deepEqual(plugin.mergeItemsCalls, []);
});

test('插件合并端点：Zotero 合并实现抛错时如实回报 500，不假装成功', async () => {
  const plugin = await startSandbox({ mergeModuleThrows: true });
  const response = await plugin.merge.init({ method: 'POST', headers: AUTH, data: MERGE_BODY });
  assert.equal(response[0], 500);
  const body = JSON.parse(response[2]);
  assert.equal(body.error, 'endpoint-failed');
  assert.match(String(body.reason), /no such module/u);
});

test('插件识别端点：逐条回报 before → after，不可识别条目如实回报', async () => {
  const plugin = await startSandbox({
    recognizedFields: { title: 'Recognized title', date: '2021', DOI: '10.1000/alpha' },
    canRecognize: (item) => item.key !== 'BBBB2222',
  });
  const empty = await plugin.recognize.init({ method: 'POST', headers: AUTH, data: {} });
  assert.equal(empty[0], 400);
  assert.equal(JSON.parse(empty[2]).error, 'keys-required');

  const response = await plugin.recognize.init({ method: 'POST', headers: AUTH, data: { keys: ['AAAA1111', 'BBBB2222', 'NOPE0000'] } });
  assert.equal(response[0], 200);
  const body = JSON.parse(response[2]);
  assert.equal(body.results.length, 3);
  assert.equal(body.results[0].recognized, true);
  assert.equal(body.results[0].before.title, 'Primary');
  assert.equal(body.results[0].after.title, 'Recognized title');
  assert.equal(body.results[1].recognized, false);
  assert.equal(body.results[1].reason, 'can-recognize-false', '不可识别必须如实回报原因');
  assert.equal(body.results[1].before.title, 'Duplicate');
  assert.equal(body.results[1].after.title, 'Duplicate', '不可识别条目不得被盗改');
  assert.equal(body.results[2].ok, false);
  assert.equal(body.results[2].reason, 'item-not-found');
  assert.deepEqual(plugin.recognizeCalls, [['AAAA1111']], '只有可识别条目才交给 Zotero 的识别器');
});

test('插件端点：健康清单与工具面口径一致（6 个端点，含合并与识别）', async () => {
  const plugin = await startSandbox();
  const health = new plugin.endpoints['/zoteromcp/health']();
  const response = await health.init({ method: 'GET', headers: AUTH, data: null });
  assert.equal(response[0], 200);
  const body = JSON.parse(response[2]);
  assert.deepEqual([...body.endpoints].sort(), [...PLUGIN_ENDPOINTS].sort());
  assert.ok(body.endpoints.includes('/zoteromcp/merge'));
  assert.ok(body.endpoints.includes('/zoteromcp/recognize-pdf'));
  assert.deepEqual([...new plugin.endpoints['/zoteromcp/merge']().supportedMethods], ['POST']);
  assert.deepEqual([...new plugin.endpoints['/zoteromcp/recognize-pdf']().supportedDataTypes], ['application/json']);
});

// ── 7. 计划函数直调（不经协议层） ───────────────────────────────────────

test('buildMergePlan 只用显式 key 且读不到条目时报错', async () => {
  const fake = await startCombinedFake({});
  const auditDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-merge-plan-'));
  const base = { baseUrl: fake.url, token: TOKEN, auditDir, env: {} };
  try {
    await assert.rejects(() => buildMergePlan({ ...base, primaryKey: 'NOPE0000', mergeKeys: ['ITEM0001'] }), /有条目读不到/u);
    const plan = await buildMergePlan({ ...base, primaryKey: 'ITEM0001', mergeKeys: ['ITEM0002'] });
    assert.deepEqual(plan.snapshot.map((entry) => entry.key), ['ITEM0001', 'ITEM0002']);
    assert.equal(plan.snapshot[0].data.title, 'Alpha paper');
    assert.deepEqual(plan.impacts.collections, ['COLL0001']);
    assert.equal(plan.pluginAvailable, true);
    assert.equal(plan.snapshotPath.startsWith(auditDir), true, '快照路径必须落在审计目录下');
    assert.deepEqual(snapshotFiles(join(auditDir, 'snapshots')), [], '计划阶段不得写快照');
  } finally {
    rmSync(auditDir, { recursive: true, force: true });
    await fake.close();
  }
});

// ── 8. 回环纵深防御：两条写路径都不把插件 token 发往非回环主机 ──────────

test('applyMerge / applyRecognize 对非回环 baseUrl 零请求零副作用', async () => {
  const { applyMerge, applyRecognize } = await import('../../packages/core/src/index.ts');
  const auditDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-merge-loopback-'));
  const env = { ...process.env, ZOTERO_MCP_WRITE: 'on' };
  const nonLoopback = 'http://192.0.2.10:23119';
  const otherToken = process.env['ZOTERO_MCP_PLUGIN_TOKEN'];
  delete process.env['ZOTERO_MCP_PLUGIN_TOKEN'];
  try {
    // 手工构造的计划：绕过计划函数（工具面到不了这里），直接把 pluginAvailable 置为 true。
    // 这正是 T1 描述的纵深防御缺口——调用方给一个非回环地址，凭证就会跟着 POST 出去。
    const sent = [];
    const fetchImpl = async (input, init) => {
      sent.push({ url: String(input), headers: init?.headers ?? {} });
      throw new Error('非回环地址不应发出任何请求');
    };
    const mergePlan = {
      planId: 'merge-loopback-test',
      primaryKey: 'ITEM0001',
      mergeKeys: ['ITEM0002'],
      pluginAvailable: true,
      reason: null,
      hint: null,
      guide: null,
      snapshot: [],
      snapshotPath: join(auditDir, 'snapshots', 'merge-loopback-test-merge.json'),
      impacts: { totalItems: 2, attachments: 0, notes: 0, annotations: 0, collections: [], tags: [] },
      summary: '非回环用例',
    };
    const recognizePlan = {
      planId: 'recognize-loopback-test',
      keys: ['ITEM0001'],
      pluginAvailable: true,
      reason: null,
      hint: null,
      guide: null,
      targets: [{ key: 'ITEM0001', itemType: 'journalArticle', title: 'Alpha paper', isPdf: false }],
      snapshot: [],
      snapshotPath: join(auditDir, 'snapshots', 'recognize-loopback-test-recognize.json'),
      summary: '非回环用例',
    };

    await assert.rejects(
      () =>
        applyMerge(mergePlan, {
          write: true,
          confirm: MERGE_CONFIRM_KEYWORD,
          token: TOKEN,
          baseUrl: nonLoopback,
          fetchImpl,
          auditDir,
          env,
        }),
      /只允许访问回环地址/u,
    );
    await assert.rejects(
      () =>
        applyRecognize(recognizePlan, {
          write: true,
          confirm: RECOGNIZE_CONFIRM_KEYWORD,
          token: TOKEN,
          baseUrl: nonLoopback,
          fetchImpl,
          auditDir,
          env,
        }),
      /只允许访问回环地址/u,
    );

    assert.deepEqual(sent, [], '非回环地址下一次请求都不许发出（凭证不许出网）');
    assert.deepEqual(snapshotFiles(join(auditDir, 'snapshots')), [], '被拒绝时不许落写前快照');
    assert.equal(existsSync(join(auditDir, 'audit.jsonl')), false, '被拒绝时不许追加审计');
  } finally {
    if (otherToken !== undefined) process.env['ZOTERO_MCP_PLUGIN_TOKEN'] = otherToken;
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test('回环 baseUrl 下两条写路径的既有行为不变', async () => {
  const { buildMergePlan, applyMerge } = await import('../../packages/core/src/index.ts');
  const fake = await startCombinedFake({});
  const auditDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-merge-loopback-ok-'));
  try {
    // 回环地址：与改动前逐字一致的提交路径（计划 → 快照 → 插件 → 回读 → 审计）
    const plan = await buildMergePlan({ baseUrl: fake.url, token: TOKEN, auditDir, env: {}, primaryKey: 'ITEM0001', mergeKeys: ['ITEM0002'] });
    assert.equal(plan.pluginAvailable, true);
    const applied = await applyMerge(plan, {
      write: true,
      confirm: MERGE_CONFIRM_KEYWORD,
      token: TOKEN,
      baseUrl: fake.url,
      auditDir,
      env: { ...process.env, ZOTERO_MCP_WRITE: 'on' },
    });
    assert.equal(applied.applied, true);
    assert.equal(applied.primaryKey, 'ITEM0001');
    assert.deepEqual(applied.trashedKeys, ['ITEM0002']);
    assert.deepEqual(snapshotFiles(join(auditDir, 'snapshots')), [`${applied.planId}-merge.json`]);
    assert.deepEqual(fake.state.mergeBodies.map((body) => body.primaryKey), ['ITEM0001']);
  } finally {
    rmSync(auditDir, { recursive: true, force: true });
    await fake.close();
  }
});
