/**
 * 注释写入四级回退通道契约测试（change `web-api-write-fallback`）。
 *
 * 覆盖 brief 的 A1–A11 与 A14（A12 真机取证、A13 文档口径由 Runtime / Verifier 单独核对）：
 *   - A1 只读探测与计划：零写请求、零审计、零快照；
 *   - A2 未配置云端凭证时默认路径零外呼、`pluginSync` 文案逐字不变、verify:offline 仍通过；
 *   - A3 插件可用时优先走插件，不碰 Local API 与云端；
 *   - A4 插件缺失 → Local API 写（真机重点：带 `Zotero-Server-ID` + `Zotero-API-Key`、写后回读）；
 *   - A5 Local API 不可用 → 云端 Web API 写（`Zotero-API-Key` + `Zotero-API-Version: 3`）；
 *   - A6 三级全不可用 → `sync-fallback`，审计里没有任何成功记录；
 *   - A7 部分失败不静默（换级原因与失败原因都可见）；
 *   - A8 幂等：同一注释重复提交不产生第二次写请求；
 *   - A9 默认只读总闸与缺 confirm 都在发请求之前拒绝；
 *   - A10 写前快照 + 审计留痕，且审计里不出现 API Key；
 *   - A11 凭证不出现在结果、审计、快照与错误消息里。
 *
 * 全程不访问网络、不写真实库、不写真实 `.audit`（一律指向临时目录）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  ANNOTATION_WRITE_CONFIRM_KEYWORD,
  WEB_API_KEY_ENV,
  WEB_API_LIBRARY_ENV,
  applyAnnotationWrite,
  maskApiKey,
  planAnnotationWrite,
  pluginSync,
  probeChannels,
  resolveWebApiConfig,
  summarizeWebApiConfig,
  webApiCredentialsPath,
} from '../../packages/core/src/index.ts';
import { createServer as createMcpServer } from '../../packages/mcp-server/src/server.ts';
import { ALL_TOOLS, GATED_TOOL_NAME_SET, TOOL_NAMES } from '../../packages/mcp-server/src/tools.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

const execFileAsync = promisify(execFile);

const ATTACHMENT = 'ATT00001'; // 假服务器固件：ITEM0001 下的 PDF 附件，已有一条注释 ANNO0001
const CLOUD_SENTINEL_KEY = 'SENTINEL-CLOUD-KEY-0123456789';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 一个可控的云端 Web API 替身：记录请求，按脚本返回。 */
async function startCloudStub(options = {}) {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    if (options.failWith !== undefined) {
      res.writeHead(options.failWith, { 'content-type': 'application/json' });
      // echoSentinelInError：模拟「上游在错误体里回显凭证」的形态（回归 A11 用）
      res.end(
        JSON.stringify(
          options.echoSentinelInError === true
            ? { error: `Forbidden: invalid API key ${CLOUD_SENTINEL_KEY}` }
            : { error: 'stub failure' },
        ),
      );
      return;
    }
    if (Array.isArray(options.failPerItemMessages)) {
      // 逐条返回不同的失败文本（用于验证排障文本不被过度清洗）
      res.writeHead(200, { 'content-type': 'application/json' });
      const failed = {};
      options.failPerItemMessages.forEach((message, index) => { failed[index] = { code: 400, message }; });
      res.end(JSON.stringify({ successful: {}, unchanged: {}, failed }));
      return;
    }
    if (options.failPerItemWithSentinel === true) {
      // 真机批量写以 HTTP 200 + 逐条 failed 汇报错误
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ successful: {}, unchanged: {}, failed: { 0: { code: 400, message: 'Forbidden: invalid API key ' + CLOUD_SENTINEL_KEY } } }));
      return;
    }
    const parsed = body.length === 0 ? [] : JSON.parse(body);
    const created = {};
    (Array.isArray(parsed) ? parsed : []).forEach((entry, index) => {
      created[index] = { key: `CLOUD${String(index).padStart(3, '0')}`, version: 1 };
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ successful: created, success: created, unchanged: {}, failed: {} }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 一个「不提供 Zotero-Server-ID、也不服务条目」的 Local API 替身：用于验证写请求头的硬约束。 */
async function startNoServerIdStub() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    // 只有根路径有响应（故意不带 zotero-server-id）；条目读取按真机「条目不存在」返回 404
    if (url.pathname === '/api/') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Zotero API is running' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Item not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

const HIGHLIGHT = { type: 'highlight', pageIndex: 4, rects: [[10, 20, 110, 40]], text: '回退通道取证', comment: 'web-api-write-fallback' };

/**
 * 隔离的进程环境：清掉所有可能影响通道判定的变量，并指向临时目录。
 *
 * ⚠️ 必须显式给出 `ZOTERO_MCP_PLUGIN_TOKEN`：否则 `readPluginToken` 会回落到
 * `<数据目录>/zoteromcp-token.txt`，而**本机真的装了插件、真的在 23119 上跑着 Zotero**，
 * 会让「插件不可用」的用例在开发机上假失败、在 CI 上通过（不可复现）。
 */
function isolatedEnv(overrides = {}) {
  return {
    ZOTERO_MCP_PLUGIN_TOKEN: 'test-token',
    ZOTERO_MCP_DATA_DIR: tempDir('zotero-mcp-data-'),
    ...overrides,
  };
}

/** 取一个确定没有服务监听的回环地址：让「插件通道不可用」是确定性的，而不是碰巧本机没装插件。 */
async function closedPortUrl() {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

/** 一个「插件端点不存在」的替身：所有请求都 404（真机上就是插件未安装）。 */
async function startPluginMissingStub() {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ── A1 / A9：只读计划与写总闸 ────────────────────────────────────────────

test('A1 只读：计划不产生任何写请求、不写审计与快照', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const auditDir = tempDir('zotero-mcp-annot-audit-');
  try {
    const plan = await planAnnotationWrite({
      baseUrl: fake.url,
      attachmentKey: ATTACHMENT,
      annotations: [HIGHLIGHT],
      env: isolatedEnv(),
      auditDir,
    });
    assert.equal(plan.attachmentKey, ATTACHMENT);
    assert.equal(plan.parentItem, 'ITEM0001');
    assert.equal(plan.items.length, 1);
    assert.deepEqual(
      plan.channels.map((entry) => entry.channel),
      ['plugin', 'local-api', 'web-api'],
      '逐级探测结论必须按回退顺序给出',
    );
    // 只读：全部请求都是 GET
    assert.ok(fake.requests.length > 0, '计划需要读附件与既有注释');
    assert.deepEqual(
      fake.requests.filter((request) => request.method !== 'GET'),
      [],
      '计划阶段不得发出任何写请求',
    );
    assert.deepEqual(readdirSync(auditDir), [], '计划阶段不得写审计或快照');
  } finally {
    await fake.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test('A9 默认只读总闸：write 未显式开启或缺 confirm 时在发请求之前拒绝', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const auditDir = tempDir('zotero-mcp-annot-gate-');
  try {
    const plan = await planAnnotationWrite({
      baseUrl: fake.url,
      attachmentKey: ATTACHMENT,
      annotations: [HIGHLIGHT],
      env: isolatedEnv(),
    });
    const before = fake.requests.length;
    await assert.rejects(
      () => applyAnnotationWrite(plan, { baseUrl: fake.url, auditDir, env: isolatedEnv() }),
      /write=true/u,
    );
    await assert.rejects(
      () => applyAnnotationWrite(plan, { baseUrl: fake.url, auditDir, env: isolatedEnv(), write: true, confirm: 'NOPE' }),
      new RegExp(`confirm="${ANNOTATION_WRITE_CONFIRM_KEYWORD}"`, 'u'),
    );
    assert.equal(fake.requests.length, before, '被拒绝的提交不得发出任何请求');
    assert.deepEqual(readdirSync(auditDir), [], '被拒绝的提交不得写审计或快照');
  } finally {
    await fake.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});

// ── A2：默认路径逐字不变、零外呼 ─────────────────────────────────────────

test('A2 未配置云端凭证：解析结果为「未配置」，且不触发任何网络请求', async () => {
  const config = resolveWebApiConfig({ env: isolatedEnv(), dataDir: tempDir('zotero-mcp-nocred-') });
  assert.equal(config.configured, false);
  assert.match(config.reason, /未配置云端凭证/u);
  // 提示里只允许出现路径与字段名，不得出现任何凭证内容
  assert.match(config.credentialsPath, /zoteromcp-web-api\.json$/u);

  const summary = summarizeWebApiConfig(config);
  assert.deepEqual(summary, { configured: false, library: null, maskedKey: null, reason: config.reason });
});

test('A2 半配置按未配置处理（fail-closed，不猜测库）', async () => {
  const dataDir = tempDir('zotero-mcp-halfcred-');
  const credentialsPath = webApiCredentialsPath(dataDir);
  writeFileSync(credentialsPath, JSON.stringify({ apiKey: 'ONLY-KEY-NO-LIBRARY' }), 'utf8');
  const fromFile = resolveWebApiConfig({ env: isolatedEnv(), dataDir });
  assert.equal(fromFile.configured, false);
  assert.match(fromFile.reason, /library/u);

  const envOnlyKey = resolveWebApiConfig({ env: isolatedEnv({ [WEB_API_KEY_ENV]: 'ONLY-KEY' }), dataDir });
  assert.equal(envOnlyKey.configured, false, '环境变量半配置不得回落到文件');

  const badLibrary = resolveWebApiConfig({ env: isolatedEnv({ [WEB_API_KEY_ENV]: 'K', [WEB_API_LIBRARY_ENV]: 'not-a-library' }), dataDir });
  assert.equal(badLibrary.configured, false);
  assert.match(badLibrary.reason, /users\//u);
});

test('A2 未配置时 pluginSync 的降级文案逐字不变', async () => {
  // 用一个确定没有服务监听的地址：真机 23119 上跑着装了插件的 Zotero，用它做「插件不可用」的用例不可复现
  const url = await closedPortUrl();
  const result = await pluginSync({ baseUrl: url, token: 'test-token', env: isolatedEnv() });
  assert.equal(result.pluginAvailable, false);
  assert.equal(result.syncEnabled, false);
  assert.equal(
    result.note,
    '插件不可用：已降级为「等待自动同步」，未触发任何同步，也未产生任何写入。',
    '既有降级文案必须逐字不变',
  );
});

// ── A3：插件优先 ─────────────────────────────────────────────────────────

test('A3 插件可用时优先走插件，且不碰 Local API 与云端', async () => {
  const written = [];
  // 真机上插件端点与 Local API **共用同一个 origin**（都在 127.0.0.1:23119 上，只是路径前缀不同），
  // 因此这里用一个同时实现 `/zoteromcp/*` 与 `/api/*` 的替身，避免「把 baseUrl 指到插件服务器后
  // 附件读不到」这种测试脚手架造成的假失败。
  const plugin = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const headers = { 'zotero-server-id': 'PLUGIN01', 'zotero-api-version': '3' };
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    if (req.url === '/zoteromcp/health') {
      send(200, { plugin: { id: 'zotero-mcp@test', version: '1.0.0' }, endpoints: [], sync: { enabled: true }, httpServer: { port: 23119 } });
      return;
    }
    if (req.url === '/zoteromcp/annotations') {
      written.push({ url: req.url, body });
      send(200, { created: [{ key: 'PLUGIN001', type: 'highlight', pageLabel: '5' }] });
      return;
    }
    if (req.url === '/api/') {
      send(200, { message: 'Zotero API is running' });
      return;
    }
    if (req.url === '/api/users/0/items/ATT00001') {
      send(200, {
        key: 'ATT00001',
        version: 1,
        data: { key: 'ATT00001', version: 1, itemType: 'attachment', contentType: 'application/pdf', title: 'Full Text PDF', parentItem: 'ITEM0001' },
      });
      return;
    }
    if (req.url === '/api/users/0/items?itemKey=PLUGIN001&limit=50') {
      send(200, [{ key: 'PLUGIN001', version: 9, data: { key: 'PLUGIN001', itemType: 'annotation', annotationType: 'highlight', parentItem: 'ATT00001' } }]);
      return;
    }
    if (String(req.url).startsWith('/api/users/0/items/ATT00001/children')) {
      send(200, []);
      return;
    }
    send(404, { error: `no stub for ${req.url}` });
  });
  await new Promise((resolve) => plugin.listen(0, '127.0.0.1', resolve));
  const pluginUrl = `http://127.0.0.1:${plugin.address().port}`;

  const cloud = await startCloudStub();
  const auditDir = tempDir('zotero-mcp-annot-plugin-');
  try {
    const options = {
      baseUrl: pluginUrl,
      token: 'test-token',
      env: isolatedEnv({ [WEB_API_KEY_ENV]: CLOUD_SENTINEL_KEY, [WEB_API_LIBRARY_ENV]: 'users/12345' }),
      webBaseUrl: cloud.url,
      webFetchImpl: fetch,
      auditDir,
    };
    const plan = await planAnnotationWrite({ ...options, attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT] });
    assert.equal(plan.pluginStatus.pluginAvailable, true);
    assert.equal(plan.selectedChannel, 'plugin', '插件可用时必须选择插件通道');

    const result = await applyAnnotationWrite(plan, { ...options, write: true, confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD });
    assert.equal(result.channel, 'plugin');
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].key, 'PLUGIN001');
    assert.equal(written.length, 1, '只允许调用插件端点一次');
    assert.deepEqual(cloud.requests, [], '插件成功后不得触碰云端通道');
    // 回退链上后两级都必须是「上一级已成功」
    for (const channel of ['local-api', 'web-api']) {
      const attempt = result.attempts.find((entry) => entry.channel === channel);
      assert.equal(attempt?.outcome, 'not-attempted');
    }
  } finally {
    await new Promise((resolve) => plugin.close(resolve));
    await cloud.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});

// ── A4：插件缺失 → Local API 写 ──────────────────────────────────────────

test('A4 插件缺失时经本机 Local API 写成功，且带上 Server-ID 与 API key', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const auditDir = tempDir('zotero-mcp-annot-local-');
  try {
    const plan = await planAnnotationWrite({
      baseUrl: fake.url,
      attachmentKey: ATTACHMENT,
      annotations: [HIGHLIGHT],
      env: isolatedEnv({ ZOTERO_MCP_PLUGIN_TOKEN: '' }),
      localApiKey: 'LOCALKEY0000000000000000000000000',
    });
    assert.equal(plan.pluginStatus.pluginAvailable, false, '没有 token 时插件通道必须判为不可用');
    assert.equal(plan.selectedChannel, 'local-api', '插件不可用时必须落到 Local API 级');

    const result = await applyAnnotationWrite(plan, {
      baseUrl: fake.url,
      env: isolatedEnv({ ZOTERO_MCP_PLUGIN_TOKEN: '' }),
      localApiKey: 'LOCALKEY0000000000000000000000000',
      write: true,
      confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD,
      auditDir,
    });
    assert.equal(result.channel, 'local-api');
    assert.equal(result.created.length, 1);
    assert.match(result.created[0].key, /^[A-Z0-9]+$/u);

    const write = fake.requests.find((request) => request.method === 'POST' && request.url === '/api/users/0/items');
    assert.ok(write !== undefined, '必须向 Local API 的 /items 发一次数组体 POST');
    assert.equal(write.headers['zotero-server-id'], 'FAKE0001', '写请求必须带 Zotero-Server-ID（真机缺它会被 428 拒绝）');
    assert.equal(write.headers['zotero-api-key'], 'LOCALKEY0000000000000000000000000');
    const payload = JSON.parse(write.body);
    assert.ok(Array.isArray(payload), '真机要求数组体');
    assert.equal(payload[0].itemType, 'annotation');
    assert.equal(payload[0].parentItem, ATTACHMENT);
    assert.equal(typeof payload[0].annotationPosition, 'string', 'annotationPosition 必须是 JSON 字符串');
    assert.equal(JSON.parse(payload[0].annotationPosition).pageIndex, 4);
    // 真机回归（2026-09-20 实测）：itemAnnotations.sortIndex 是 NOT NULL，
    // 缺 annotationSortIndex 会以 NOT NULL constraint failed 直接拒写。
    assert.equal(typeof payload[0].annotationSortIndex, 'string', 'annotationSortIndex 必须给出');
    assert.match(payload[0].annotationSortIndex, /^\d{5}\|\d{6}\|\d{5}$/u, 'sortIndex 格式必须与真机校验一致');
    assert.equal(payload[0].annotationSortIndex, '00004|000000|00040', '缺省兜底口径：页码 | 0 | rects[0][3]');

    // 写后回读：读回结果里必须能找到新建的注释
    assert.ok(Array.isArray(result.readBack), '必须做写后回读校验');
    const readBackKeys = result.readBack.map((entry) => entry.key);
    assert.ok(readBackKeys.includes(result.created[0].key));
  } finally {
    await fake.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test('A4 Local API 不提供 Zotero-Server-ID 时该级判为不可用（不得盲写）', async () => {  const stub = await startNoServerIdStub();
  const pluginMissing = await startPluginMissingStub();
  try {
    const probe = await probeChannels({ baseUrl: stub.url, env: isolatedEnv() });
    assert.equal(probe.localApi.reachable, false);
    assert.match(probe.localApi.reason, /Zotero-Server-ID/u);

    // 该级被判为不可用后，回退链必须继续往下走（而不是停在 Local API 上）
    const plan = await planAnnotationWrite({
      baseUrl: stub.url,
      attachmentKey: ATTACHMENT,
      annotations: [HIGHLIGHT],
      env: isolatedEnv(),
    });
    const localEntry = plan.channels.find((entry) => entry.channel === 'local-api');
    assert.equal(localEntry?.available, false);
    assert.match(String(localEntry?.reason), /Zotero-Server-ID|附件/u);
    assert.equal(plan.selectedChannel, 'sync-fallback', '没有任何可用通道时必须如实降级');
    assert.equal(
      stub.requests.some((request) => request.method !== 'GET'),
      false,
      '该级不可用时不得发出任何写请求',
    );
    // 插件通道确实不可用时计划里也要如实写出来
    assert.match(plan.notes.join('\n'), /插件通道不可用/u);
  } finally {
    await stub.close();
    await pluginMissing.close();
  }
});

// ── A5：Local API 不可用 → 云端 Web API ──────────────────────────────────

/** 用真机语义制造「Local API 写被拒」：读可用（能拿 Server-ID），但任何写都返回 401。 */
async function startLocalWriteDenied(options = {}) {
  return startFakeZotero({ mode: 'unauthorized', port: 0, ...options });
}

test('A5 Local API 写被拒时经云端 Web API 写，并带 API key 与版本头', async () => {
  const fake = await startLocalWriteDenied();
  const cloud = await startCloudStub();
  const auditDir = tempDir('zotero-mcp-annot-cloud-');
  const env = isolatedEnv({
    ZOTERO_MCP_PLUGIN_TOKEN: '',
    [WEB_API_KEY_ENV]: CLOUD_SENTINEL_KEY,
    [WEB_API_LIBRARY_ENV]: 'users/12345',
  });
  try {
    const options = { baseUrl: fake.url, env, webBaseUrl: cloud.url, webFetchImpl: fetch, auditDir };
    const plan = await planAnnotationWrite({ ...options, attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT] });
    assert.equal(plan.webApi.configured, true);
    // 读通道可用（能拿 Server-ID），因此计划里 Local API 仍是「可用」；写被拒只能在提交时暴露
    assert.equal(plan.channels.find((entry) => entry.channel === 'local-api')?.available, true);

    const result = await applyAnnotationWrite(plan, { ...options, write: true, confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD });
    assert.equal(result.channel, 'web-api', 'Local API 写被拒后必须换到云端一级');
    assert.equal(cloud.requests.length, 1);
    const request = cloud.requests[0];
    assert.equal(request.url, '/users/12345/items');
    assert.equal(request.headers['zotero-api-key'], CLOUD_SENTINEL_KEY);
    assert.equal(request.headers['zotero-api-version'], '3');
    const payload = JSON.parse(request.body);
    assert.ok(Array.isArray(payload));
    assert.equal(payload[0].itemType, 'annotation');
    assert.equal(typeof payload[0].annotationPosition, 'string');
    // 换级原因必须在结果里可见（本地 API 的真实失败原因，而不是笼统的「不可用」）
    const localAttempt = result.attempts.find((entry) => entry.channel === 'local-api');
    assert.equal(localAttempt?.outcome, 'skipped');
    assert.match(String(localAttempt?.reason), /授权|401|本地 API/u);
  } finally {
    await fake.close();
    await cloud.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});

// ── A6：三级全不可用 ─────────────────────────────────────────────────────

test('A6 三级都不可用时如实 sync-fallback，审计里没有任何成功记录', async () => {
  const fake = await startFakeZotero({ mode: 'api-disabled', port: 0 });
  const auditDir = tempDir('zotero-mcp-annot-fallback-');
  try {
    const options = { baseUrl: fake.url, env: isolatedEnv({ ZOTERO_MCP_PLUGIN_TOKEN: '' }), auditDir };
    const plan = await planAnnotationWrite({ ...options, attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT] });
    assert.equal(plan.selectedChannel, 'sync-fallback', '三级都不可用时计划就必须如实标成降级');
    assert.equal(plan.channels.every((entry) => entry.available === false), true);
    assert.match(plan.notes.join('\n'), /本地 API 未开启/u);

    const result = await applyAnnotationWrite(plan, { ...options, write: true, confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD });
    assert.equal(result.channel, 'sync-fallback');
    assert.equal(result.syncEnabled, false);
    assert.equal(result.created.length, 0);
    assert.match(String(result.note), /等待自动同步/u);
    for (const item of result.items) assert.notEqual(item.status, 'created');

    const audit = readFileSync(join(auditDir, 'audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.ok(audit.length >= 1, '必须留下审计');
    assert.equal(audit.every((entry) => entry.channel === 'sync-fallback'), true);
    assert.equal(audit.every((entry) => Array.isArray(entry.created) && entry.created.length === 0), true, '审计里不得出现任何创建成功');
    // 库内不得有新增注释
    const created = fake.requests.filter((request) => request.method === 'POST' && request.url === '/api/users/0/items');
    assert.deepEqual(created, [], '降级路径不得发出创建请求');
  } finally {
    await fake.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});

// ── A7：部分失败不静默 ───────────────────────────────────────────────────

test('A7 云端写入失败时如实回报失败原因，不得返回成功', async () => {
  const fake = await startLocalWriteDenied();
  const cloud = await startCloudStub({ failWith: 403 });
  const auditDir = tempDir('zotero-mcp-annot-cloudfail-');
  const env = isolatedEnv({ ZOTERO_MCP_PLUGIN_TOKEN: '', [WEB_API_KEY_ENV]: CLOUD_SENTINEL_KEY, [WEB_API_LIBRARY_ENV]: 'users/12345' });
  try {
    const options = { baseUrl: fake.url, env, webBaseUrl: cloud.url, webFetchImpl: fetch, auditDir };
    const plan = await planAnnotationWrite({ ...options, attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT] });
    const result = await applyAnnotationWrite(plan, { ...options, write: true, confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD });
    assert.equal(result.created.length, 0, '云端失败时不得报告任何创建成功');
    const webAttempt = result.attempts.find((entry) => entry.channel === 'web-api');
    assert.equal(webAttempt?.outcome, 'failed');
    assert.match(String(webAttempt?.reason), /HTTP 403/u);
    assert.equal(result.items.every((item) => item.status !== 'created'), true, '失败不得被写成成功');
    // 两级失败原因都要在结果里可见（不能只留最后一个）
    assert.match(String(result.attempts.find((entry) => entry.channel === 'local-api')?.reason), /授权|401|本地 API/u);
    assert.match(String(result.attempts.find((entry) => entry.channel === 'plugin')?.reason), /插件/u);
  } finally {
    await fake.close();
    await cloud.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});

// ── A8：幂等 ─────────────────────────────────────────────────────────────

test('A8 幂等：同一注释重复提交不产生第二次写请求', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const auditDir = tempDir('zotero-mcp-annot-idem-');
  const env = isolatedEnv({ ZOTERO_MCP_PLUGIN_TOKEN: '' });
  const options = { baseUrl: fake.url, env, localApiKey: 'LOCALKEY0000000000000000000000000', auditDir };
  try {
    const first = await planAnnotationWrite({ ...options, attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT] });
    const applied = await applyAnnotationWrite(first, { ...options, write: true, confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD });
    assert.equal(applied.created.length, 1);
    const postsAfterFirst = fake.requests.filter((request) => request.method === 'POST' && request.url === '/api/users/0/items').length;
    assert.equal(postsAfterFirst, 1);

    // 再提交同一条：必须靠幂等判重跳过，且不再发写请求
    const second = await planAnnotationWrite({ ...options, attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT] });
    assert.equal(second.duplicates.length, 1, '计划阶段就要标出重复项');
    assert.equal(second.duplicates[0].existingKey, applied.created[0].key);
    const again = await applyAnnotationWrite(second, { ...options, write: true, confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD });
    assert.equal(again.created.length, 0);
    assert.equal(again.items[0].status, 'skipped-duplicate');
    assert.equal(again.items[0].key, applied.created[0].key);
    assert.equal(
      fake.requests.filter((request) => request.method === 'POST' && request.url === '/api/users/0/items').length,
      postsAfterFirst,
      '重复提交不得产生第二次写请求',
    );
  } finally {
    await fake.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});

// ── A10 / A11：留痕与凭证边界 ────────────────────────────────────────────

test('A10/A11 写入留下快照与审计，且云端 key 不出现在结果、审计、快照里', async () => {
  const fake = await startLocalWriteDenied();
  const cloud = await startCloudStub();
  const auditDir = tempDir('zotero-mcp-annot-audit2-');
  const env = isolatedEnv({ ZOTERO_MCP_PLUGIN_TOKEN: '', [WEB_API_KEY_ENV]: CLOUD_SENTINEL_KEY, [WEB_API_LIBRARY_ENV]: 'users/12345' });
  try {
    const options = { baseUrl: fake.url, env, webBaseUrl: cloud.url, webFetchImpl: fetch, auditDir };
    const plan = await planAnnotationWrite({ ...options, attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT] });
    const result = await applyAnnotationWrite(plan, { ...options, write: true, confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD });
    assert.equal(result.channel, 'web-api');

    const auditRaw = readFileSync(join(auditDir, 'audit.jsonl'), 'utf8');
    const snapshots = readdirSync(join(auditDir, 'snapshots'));
    assert.ok(snapshots.length >= 1, '必须留下写前快照');
    const snapshotRaw = readFileSync(join(auditDir, 'snapshots', snapshots[0]), 'utf8');
    const resultRaw = JSON.stringify(result);

    for (const [label, raw] of [['审计', auditRaw], ['快照', snapshotRaw], ['工具结果', resultRaw]]) {
      assert.equal(raw.includes(CLOUD_SENTINEL_KEY), false, `${label}里不得出现云端 API key`);
      assert.match(raw, /annotation-write|planId|ATT00001/u, `${label}里应能看出附件与计划`);
    }
    // 审计里能看到所用通道
    assert.match(auditRaw, /"channel":"web-api"/u);
    // 计划里只出现掩码
    assert.match(JSON.stringify(plan.webApi), /SENT/u);
    assert.equal(JSON.stringify(plan.webApi).includes(CLOUD_SENTINEL_KEY), false);
    assert.equal(maskApiKey(CLOUD_SENTINEL_KEY), 'SENT…(长度 29)');
  } finally {
    await fake.close();
    await cloud.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});

// ── 工具面 ───────────────────────────────────────────────────────────────

test('工具面：zotero_attach_annotations 注册且受默认只读总闸约束，dry-run 零写请求', async () => {
  assert.equal(ALL_TOOLS.length, 24);
  assert.equal(TOOL_NAMES.length, 24);
  assert.ok(TOOL_NAMES.includes('zotero_attach_annotations'));
  assert.equal(GATED_TOOL_NAME_SET.has('zotero_attach_annotations'), true, '注释写入必须受默认只读总闸约束');

  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const auditDir = tempDir('zotero-mcp-annot-tool-');
  const previous = {
    base: process.env['ZOTERO_MCP_BASE_URL'],
    audit: process.env['ZOTERO_MCP_AUDIT_DIR'],
    write: process.env['ZOTERO_MCP_WRITE'],
    token: process.env['ZOTERO_MCP_PLUGIN_TOKEN'],
    data: process.env['ZOTERO_MCP_DATA_DIR'],
    key: process.env[WEB_API_KEY_ENV],
    library: process.env[WEB_API_LIBRARY_ENV],
  };
  process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
  process.env['ZOTERO_MCP_AUDIT_DIR'] = auditDir;
  process.env['ZOTERO_MCP_DATA_DIR'] = tempDir('zotero-mcp-tool-data-');
  // 必须显式给 token：否则会读本机 <数据目录>/zoteromcp-token.txt，而本机真的装了插件，
  // 「缺 confirm 时不得发出任何请求」这类断言就会因为插件可用而失败（开发机上不可复现）。
  process.env['ZOTERO_MCP_PLUGIN_TOKEN'] = 'test-token';
  delete process.env['ZOTERO_MCP_WRITE'];
  delete process.env[WEB_API_KEY_ENV];
  delete process.env[WEB_API_LIBRARY_ENV];
  const server = createMcpServer();
  const client = new Client({ name: 'annot-channel-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const parse = (result) => JSON.parse(String(result.content[0]?.text ?? 'null'));
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 24);
    const tool = tools.find((entry) => entry.name === 'zotero_attach_annotations');
    assert.ok(tool !== undefined);
    assert.deepEqual(tool.inputSchema.required, ['attachmentKey', 'annotations']);
    assert.deepEqual(tool.inputSchema.properties.annotations.maxItems, 50);

    const readsOnly = fake.requests.length;
    const dry = parse(await client.callTool({ name: 'zotero_attach_annotations', arguments: { attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT] } }));
    assert.equal(dry.dryRun, true);
    assert.equal(dry.selectedChannel, 'local-api');
    assert.equal(dry.writeEnabled, false, '未设 ZOTERO_MCP_WRITE 时写开关必须是关的');
    assert.deepEqual(
      fake.requests.slice(readsOnly).filter((request) => request.method !== 'GET'),
      [],
      'dry-run 不得发出写请求',
    );
    assert.deepEqual(readdirSync(auditDir), [], 'dry-run 不得写审计或快照');

    // 写总闸：dryRun=false 且未开 ZOTERO_MCP_WRITE → 在任何请求之前拒绝
    const readsBeforeGate = fake.requests.length;
    const rejected = await client.callTool({ name: 'zotero_attach_annotations', arguments: { attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT], dryRun: false, confirm: 'WRITE' } });
    assert.equal(rejected.isError, true, '未开写开关时必须拒绝');
    assert.deepEqual(fake.requests.slice(readsBeforeGate), [], '被总闸拦下时不得发出任何请求（连读计划都不生成）');

    // 开写开关但缺 confirm → 同样先拒绝（这一次计划会生成，但绝不允许发出任何请求）
    process.env['ZOTERO_MCP_WRITE'] = 'on';
    const gateUrl = fake.url;
    const readsBeforeConfirm = fake.requests.length;
    const noConfirm = await client.callTool({ name: 'zotero_attach_annotations', arguments: { attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT], dryRun: false } });
    assert.equal(noConfirm.isError, true, '缺 confirm 时必须拒绝');
    assert.deepEqual(
      fake.requests.slice(readsBeforeConfirm).filter((request) => request.method !== 'GET'),
      [],
      `缺 confirm 时不得发出任何写请求（base=${gateUrl}）`,
    );

    // 开写开关 + 正确 confirm → 走 Local API 落库
    const applied = parse(
      await client.callTool({ name: 'zotero_attach_annotations', arguments: { attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT], dryRun: false, confirm: 'WRITE' } }),
    );
    assert.equal(applied.dryRun, false);
    assert.equal(applied.channel, 'local-api');
    assert.equal(applied.created.length, 1);
  } finally {
    await client.close();
    await server.close();
    const restore = (name, value) => (value === undefined ? delete process.env[name] : (process.env[name] = value));
    restore('ZOTERO_MCP_BASE_URL', previous.base);
    restore('ZOTERO_MCP_AUDIT_DIR', previous.audit);
    restore('ZOTERO_MCP_WRITE', previous.write);
    restore('ZOTERO_MCP_PLUGIN_TOKEN', previous.token);
    restore('ZOTERO_MCP_DATA_DIR', previous.data);
    restore(WEB_API_KEY_ENV, previous.key);
    restore(WEB_API_LIBRARY_ENV, previous.library);
    await fake.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});

// ── 第二轮验收发现的同类回显面：200 + failed[].message ────────────────────

test('A16 回归②：200 + failed[].message 回显凭证时也必须被白名单化（不得进结果/审计/快照）', async () => {
  const fake = await startLocalWriteDenied();
  // 真机批量写正是以「HTTP 200 + 逐条 failed」汇报错误，所以这条路径必须与错误体同等对待
  const perItemEcho = await startCloudStub({ failPerItemWithSentinel: true });
  const auditDir = tempDir('zotero-mcp-annot-peritemleak-');
  const env = isolatedEnv({ ZOTERO_MCP_PLUGIN_TOKEN: '', [WEB_API_KEY_ENV]: CLOUD_SENTINEL_KEY, [WEB_API_LIBRARY_ENV]: 'users/12345' });
  try {
    const options = { baseUrl: fake.url, env, webBaseUrl: perItemEcho.url, webFetchImpl: fetch, auditDir };
    const plan = await planAnnotationWrite({ ...options, attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT] });
    const result = await applyAnnotationWrite(plan, { ...options, write: true, confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD });

    assert.equal(result.created.length, 0, '逐条 failed 时不得报告创建成功');
    assert.ok(result.failed.length > 0, '必须如实回报逐条失败');
    const snapshots = readdirSync(join(auditDir, 'snapshots'));
    const auditRaw = readFileSync(join(auditDir, 'audit.jsonl'), 'utf8');
    const snapshotRaw = snapshots.map((name) => readFileSync(join(auditDir, 'snapshots', name), 'utf8')).join(String.fromCharCode(10));
    for (const [label, raw] of [['审计', auditRaw], ['快照', snapshotRaw], ['工具结果', JSON.stringify(result)], ['计划', JSON.stringify(plan)]]) {
      assert.equal(raw.includes(CLOUD_SENTINEL_KEY), false, label + '里不得出现云端 API key（failed[].message 回显面）');
    }
    // 仍然要给出可用的失败信息：保留排障文字，只抹掉像凭证的片段（不是整串丢弃）
    assert.match(String(result.failed[0].reason), /Forbidden|HTTP 400/u);
    assert.match(String(result.failed[0].reason), /[已省略]/u, '可疑片段必须被替换掉');
  } finally {
    await fake.close();
    await perItemEcho.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});

// ── 插件级「没写进去」的失败允许降级（第二轮风险 6） ────────────────────────

test('A7 回归②：插件端点消失（不可达）时允许降级到 Local API，而不是停在插件级', async () => {
  // 同一个 origin 同时服务 /zoteromcp/* 与 /api/*（真机上插件与 Local API 共用 23119）：
  // health 恒 200（计划阶段判为可用），但注释端点在提交时返回 404（端点消失 = 不可达）。
  const written = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const headers = { 'zotero-server-id': 'HYBRID01', 'zotero-api-version': '3' };
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    if (req.url === '/zoteromcp/health') {
      send(200, { plugin: { id: 'zotero-mcp@test', version: '1.0.0' }, endpoints: [], sync: { enabled: true }, httpServer: { port: 23119 } });
      return;
    }
    if (req.url === '/zoteromcp/annotations') {
      written.push(req.url);
      send(404, { error: 'Endpoint not found' });
      return;
    }
    if (req.url === '/api/') {
      send(200, { message: 'Zotero API is running' });
      return;
    }
    if (req.url === '/api/users/0/items/ATT00001') {
      send(200, { key: 'ATT00001', version: 1, data: { key: 'ATT00001', version: 1, itemType: 'attachment', contentType: 'application/pdf', title: 'Full Text PDF', parentItem: 'ITEM0001' } });
      return;
    }
    if (String(req.url).startsWith('/api/users/0/items/ATT00001/children')) {
      send(200, []);
      return;
    }
    if (req.url === '/api/users/0/items' && req.method === 'POST') {
      send(200, { successful: { 0: { key: 'FALLBACK01', version: 1 } }, success: {}, unchanged: {}, failed: {} });
      return;
    }
    if (String(req.url).startsWith('/api/users/0/items?itemKey=')) {
      send(200, [{ key: 'FALLBACK01', version: 1, data: { key: 'FALLBACK01', itemType: 'annotation', annotationType: 'highlight', parentItem: 'ATT00001' } }]);
      return;
    }
    send(404, { error: 'no stub for ' + String(req.url) });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + String(server.address().port);

  const auditDir = tempDir('zotero-mcp-annot-pluginskip-');
  const env = isolatedEnv();
  try {
    const options = { baseUrl: url, env, localApiKey: 'LOCALKEY0000000000000000000000000', auditDir };
    const plan = await planAnnotationWrite({ ...options, attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT] });
    assert.equal(plan.pluginStatus.pluginAvailable, true, '计划阶段插件应判为可用');

    const result = await applyAnnotationWrite(plan, { ...options, write: true, confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD });
    assert.equal(written.length, 1, '插件端点应当被尝试过一次');
    assert.equal(result.channel, 'local-api', '插件不可达时应当降级，而不是停在插件级');
    assert.equal(result.created.length, 1);
    const pluginAttempt = result.attempts.find((entry) => entry.channel === 'plugin');
    assert.equal(pluginAttempt?.outcome, 'skipped', '不可达的插件级必须记为 skipped（可跳过），不是 failed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(auditDir, { recursive: true, force: true });
  }
});

// ── 第三轮验收发现：过度清洗与插件级 skippable 判定 ────────────────────────

test('A19 回归③：真实排障文本必须原样保留（单引号/逗号不得触发整段丢弃）', async () => {
  // 逐条驱动：让 Local API 写被拒（unauthorized），迫使回退到云端替身，
  // 云端以「200 + failed[0].message」返回一条真实排障文本；断言它被原样保留。
  const messages = [
    "Invalid sortIndex 'not-a-sort-index'",
    'Library has been modified since specified version (expected 1, found 42)',
    'Parent item ABCD2345 not found',
    'annotation-save-failed',
  ];
  for (const message of messages) {
    const fake = await startLocalWriteDenied();
    const cloud = await startCloudStub({ failPerItemMessages: [message] });
    const auditDir = tempDir('zotero-mcp-annot-diagnostics-');
    const env = isolatedEnv({ ZOTERO_MCP_PLUGIN_TOKEN: '', [WEB_API_KEY_ENV]: CLOUD_SENTINEL_KEY, [WEB_API_LIBRARY_ENV]: 'users/12345' });
    try {
      const options = { baseUrl: fake.url, env, webBaseUrl: cloud.url, webFetchImpl: fetch, auditDir };
      const plan = await planAnnotationWrite({ ...options, attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT] });
      const result = await applyAnnotationWrite(plan, { ...options, write: true, confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD });
      assert.equal(result.failed.length, 1, '应当如实回报一条失败：' + JSON.stringify(result.failed));
      assert.equal(
        result.failed[0].reason,
        message,
        '真实排障文本必须原样保留（不得因单引号/逗号被整段丢弃）：' + JSON.stringify(result.failed[0].reason),
      );
    } finally {
      await fake.close();
      await cloud.close();
      rmSync(auditDir, { recursive: true, force: true });
    }
  }
});
test('A20 回归③：插件写入被拒必须停止降级；插件不可达才允许降级', async () => {
  const base = await startFakeZotero({ mode: 'ok', port: 0 });
  const auditDir = tempDir('zotero-mcp-annot-pluginbranch-');
  const env = isolatedEnv();

  /** 同一 origin 同时服务插件与 Local API（真机上二者共用 23119）。 */
  const startHybrid = async (annotationsStatus, annotationsBody) => {
    const annotCalls = [];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const headers = { 'zotero-server-id': 'HYBRID02', 'zotero-api-version': '3' };
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(payload));
      };
      const url = req.url ?? '/';
      if (url === '/zoteromcp/health') {
        send(200, { plugin: { id: 'zotero-mcp@test', version: '1.0.0' }, endpoints: [], sync: { enabled: true }, httpServer: { port: 23119 } });
        return;
      }
      if (url === '/zoteromcp/annotations') {
        annotCalls.push(url);
        send(annotationsStatus, annotationsBody);
        return;
      }
      if (url === '/api/') {
        send(200, { message: 'Zotero API is running' });
        return;
      }
      if (url === `/api/users/0/items/${ATTACHMENT}`) {
        send(200, { key: ATTACHMENT, version: 1, data: { key: ATTACHMENT, version: 1, itemType: 'attachment', contentType: 'application/pdf', title: 'Full Text PDF', parentItem: 'ITEM0001' } });
        return;
      }
      if (url.startsWith(`/api/users/0/items/${ATTACHMENT}/children`)) {
        send(200, []);
        return;
      }
      if (url === '/api/users/0/items' && req.method === 'POST') {
        send(200, { successful: { 0: { key: 'HYBRIDNEW1', version: 1 } }, success: {}, unchanged: {}, failed: {} });
        return;
      }
      if (url.startsWith('/api/users/0/items?itemKey=')) {
        send(200, [{ key: 'HYBRIDNEW1', version: 1, data: { key: 'HYBRIDNEW1', itemType: 'annotation', annotationType: 'highlight', parentItem: ATTACHMENT } }]);
        return;
      }
      send(404, { error: 'no stub for ' + url });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      url: 'http://127.0.0.1:' + String(server.address().port),
      annotCalls,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  };

  try {
    // ① 插件请求已发出、被 Zotero 拒（500 annotation-save-failed）→ 属真实失败，停在该级
    const denied = await startHybrid(500, { ok: false, error: 'annotation-save-failed' });
    const deniedOptions = { baseUrl: denied.url, env, localApiKey: 'LOCALKEY0000000000000000000000000', auditDir };
    const deniedPlan = await planAnnotationWrite({ ...deniedOptions, attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT] });
    const deniedResult = await applyAnnotationWrite(deniedPlan, { ...deniedOptions, write: true, confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD });
    assert.equal(deniedResult.channel, 'plugin', '插件写入被拒必须停在该级');
    assert.equal(deniedResult.ok, false);
    assert.equal(deniedResult.syncEnabled, false);
    assert.equal(deniedResult.attempts.find((entry) => entry.channel === 'plugin')?.outcome, 'failed');
    assert.equal(deniedResult.attempts.find((entry) => entry.channel === 'local-api')?.outcome, 'not-attempted', '不得降级到 Local API');
    assert.equal(deniedResult.created.length, 0, '不得报告创建成功');
    await denied.close();

    // ② 插件端点不存在（没写进去）→ 允许降级，并如实记为 skipped
    const missing = await startHybrid(404, { error: 'Endpoint not found' });
    const missingOptions = { baseUrl: missing.url, env, localApiKey: 'LOCALKEY0000000000000000000000000', auditDir };
    const missingPlan = await planAnnotationWrite({ ...missingOptions, attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT] });
    const missingResult = await applyAnnotationWrite(missingPlan, { ...missingOptions, write: true, confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD });
    assert.equal(missingResult.channel, 'local-api', '端点不存在时必须降级');
    assert.equal(missingResult.attempts.find((entry) => entry.channel === 'plugin')?.outcome, 'skipped');
    assert.equal(missingResult.created.length, 1);
    await missing.close();
  } finally {
    await base.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});

// ── 真机回归：annotationSortIndex 是 NOT NULL ─────────────────────────────

test('A4 真机回归：注释载荷缺 annotationSortIndex 会被假服务器按真机语义拒绝', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  try {
    const response = await fetch(`${fake.url}/api/users/0/items`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'zotero-server-id': 'FAKE0001',
        'zotero-api-key': 'K',
      },
      body: JSON.stringify([
        {
          itemType: 'annotation',
          parentItem: ATTACHMENT,
          annotationType: 'highlight',
          annotationPosition: '{"pageIndex":0,"rects":[[1,2,3,4]]}',
          // 故意不给 annotationSortIndex：真机会以 NOT NULL constraint failed 拒写
        },
      ]),
    });
    const body = await response.json();
    assert.equal(response.status, 200, '真机是逐条 failed（批次仍 200）');
    assert.ok(body.failed['0'], '缺 sortIndex 必须逐条判 failed');
    assert.match(String(body.failed['0'].message), /sortIndex/u, '失败原因必须指向 sortIndex');
    assert.equal(body.successful['0'], undefined, '不得报告创建成功');

    // 格式非法同样拒绝（真机 sortIndex 校验是 /^\d{5}\|\d{6}\|\d{5}$/）
    const bad = await fetch(`${fake.url}/api/users/0/items`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'zotero-server-id': 'FAKE0001', 'zotero-api-key': 'K' },
      body: JSON.stringify([
        {
          itemType: 'annotation',
          parentItem: ATTACHMENT,
          annotationType: 'highlight',
          annotationSortIndex: 'not-a-sort-index',
          annotationPosition: '{"pageIndex":0,"rects":[[1,2,3,4]]}',
        },
      ]),
    });
    const badBody = await bad.json();
    assert.match(String(badBody.failed['0']?.message), /Invalid sortIndex/u);
  } finally {
    await fake.close();
  }
});

// ── 独立只读验收发现的两个缺陷：回归断言 ─────────────────────────────────

test('A11 回归：云端错误体回显凭证时，reason 必须只取安全摘要（不进结果/审计/快照）', async () => {
  const fake = await startLocalWriteDenied();
  // 关键：让替身的 403 错误体**回显**哨兵 key（上游常见形态）
  const echoing = await startCloudStub({ failWith: 403, echoSentinelInError: true });
  const auditDir = tempDir('zotero-mcp-annot-echoleak-');
  const env = isolatedEnv({ ZOTERO_MCP_PLUGIN_TOKEN: '', [WEB_API_KEY_ENV]: CLOUD_SENTINEL_KEY, [WEB_API_LIBRARY_ENV]: 'users/12345' });
  try {
    const options = { baseUrl: fake.url, env, webBaseUrl: echoing.url, webFetchImpl: fetch, auditDir };
    const plan = await planAnnotationWrite({ ...options, attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT] });
    const result = await applyAnnotationWrite(plan, { ...options, write: true, confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD });

    const webAttempt = result.attempts.find((entry) => entry.channel === 'web-api');
    assert.equal(webAttempt?.outcome, 'failed');
    assert.match(String(webAttempt?.reason), /HTTP 403/u, '仍要给出状态码');
    assert.equal(
      String(webAttempt?.reason).includes(CLOUD_SENTINEL_KEY),
      false,
      'reason 绝不能回显上游错误体里的凭证',
    );

    const auditRaw = readFileSync(join(auditDir, 'audit.jsonl'), 'utf8');
    const snapshots = readdirSync(join(auditDir, 'snapshots'));
    const snapshotRaw = snapshots.map((name) => readFileSync(join(auditDir, 'snapshots', name), 'utf8')).join('\n');
    for (const [label, raw] of [['审计', auditRaw], ['快照', snapshotRaw], ['工具结果', JSON.stringify(result)], ['计划', JSON.stringify(plan)]]) {
      assert.equal(raw.includes(CLOUD_SENTINEL_KEY), false, `${label}里不得出现云端 API key`);
    }
  } finally {
    await fake.close();
    await echoing.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test('A29 回归：凭证文件名必须在 .gitignore 内（且 git check-ignore 真的命中）', async () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const ignored = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(
    ignored,
    /^zoteromcp-web-api\.json$/mu,
    '.gitignore 必须列出凭证文件名（代码与文档都声称它已被忽略）',
  );
  const { stdout, stderr } = await execFileAsync('git', ['check-ignore', '-v', 'zoteromcp-web-api.json'], { cwd: root }).then(
    (result) => result,
    (error) => ({ stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }),
  );
  assert.match(stdout, /zoteromcp-web-api\.json/u, `git check-ignore 必须命中该文件名（stderr: ${stderr}）`);
});

test('A7 回归：真实失败时 ok/syncEnabled 必须为 false（只看 channel 不得误读成成功）', async () => {
  const fake = await startLocalWriteDenied();
  const auditDir = tempDir('zotero-mcp-annot-okflag-');
  const env = isolatedEnv({ ZOTERO_MCP_PLUGIN_TOKEN: '' });
  try {
    const options = { baseUrl: fake.url, env, localApiKey: 'LOCALKEY0000000000000000000000000', auditDir };
    const plan = await planAnnotationWrite({ ...options, attachmentKey: ATTACHMENT, annotations: [HIGHLIGHT] });
    const result = await applyAnnotationWrite(plan, { ...options, write: true, confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD });
    assert.equal(result.created.length, 0);
    assert.equal(result.ok, false, '零创建时 ok 必须为 false');
    assert.equal(result.syncEnabled, false, '真实失败不得报成「已同步」');
    assert.equal(result.channel, 'local-api', 'channel 仍是实际尝试的通道（如实）');
    assert.equal(result.items[0].status, 'failed');
  } finally {
    await fake.close();
    rmSync(auditDir, { recursive: true, force: true });
  }
});
