/**
 * 插件通道契约测试（change 11 · m4-plugin-channel）。
 *
 * 三条独立验证线：
 *   1. 插件包：真的跑 `npm run plugin:build`，再解包校验 ZIP 结构，并把打包出来的 bundle
 *      放进 vm 沙箱、用假 Zotero 全局跑 `startup` / `shutdown` 与六个端点的 `init`；
 *   2. MCP 侧客户端：对可控的假插件服务器验证正常路径与七种失败降级；
 *   3. 工具面与依赖面：`zotero_client` 的契约、公开工具计数、依赖清单与 XPI 内容。
 *
 * 全程不访问网络、不触碰真实 Zotero 库、不写真实 .audit。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  PLUGIN_CLIENT_MODES,
  PLUGIN_ENDPOINTS,
  PLUGIN_TOKEN_HEADER,
  pluginHealth,
  pluginSelectItems,
  pluginSync,
  readPluginToken,
  requestPluginAnnotations,
  resolveDataDir,
  revealDeepLink,
} from '../../packages/core/src/index.ts';
import { createServer as createMcpServer } from '../../packages/mcp-server/src/server.ts';
import { ALL_TOOLS, TOOL_NAMES } from '../../packages/mcp-server/src/tools.ts';
import { main as buildPlugin, validateManifest, writeZip, crc32 } from '../../scripts/plugin-build.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

// ── 脚手架 ──────────────────────────────────────────────────────────────

/** 极简 ZIP 读取器（只依赖 zlib），用来真正解包构建产物。 */
function readZipEntries(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'ZIP 缺少 EOCD');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, '中央目录签名不对');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? inflateRawSync(payload) : Buffer.from(payload));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** 假 Zotero 全局 + vm 沙箱：用来跑打包后的插件 bundle。 */
function sandboxPlugin(bundleSource, overrides = {}) {
  const endpoints = {};
  const state = { syncCalls: 0, selectedItems: [], tokenFile: 'token-abc-123', tokenReads: 0 };
  const Zotero = {
    debug: () => {},
    DataDirectory: { dir: 'D:/fake/zotero-data' },
    Prefs: { get: () => 23119 },
    Server: { Endpoints: endpoints },
    Sync: {
      Runner: {
        enabled: true,
        syncInProgress: false,
        backgroundSync: false,
        lastSyncStatus: '',
        sync: () => {
          state.syncCalls += 1;
          return Promise.resolve();
        },
      },
      Data: { Local: { getLastSyncTime: () => new Date('2026-09-18T10:00:00.000Z') } },
    },
    Items: { getByLibraryAndKeyAsync: async (_libraryID, key) => (key === 'KNOWNKEY01' ? { id: 4242 } : null) },
    Libraries: { userLibraryID: 1 },
    getMainWindow: () => ({ ZoteroPane: { selectItems: async (ids) => void state.selectedItems.push(...ids) }, focus: () => {} }),
    ...overrides.Zotero,
  };
  const sandbox = {
    console,
    Zotero,
    PathUtils: { join: (a, b) => `${String(a).replace(/\/$/u, '')}/${b}` },
    IOUtils: {
      readUTF8: async () => {
        state.tokenReads += 1;
        if (state.tokenFile === null) throw new Error('file not found');
        return state.tokenFile;
      },
    },
    Services: { scriptloader: { loadSubScript: () => {} } },
    setTimeout,
    clearTimeout,
    ...overrides.globals,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(bundleSource, sandbox, { filename: 'channel.js' });
  return { sandbox, bundle: sandbox.ZoteroMCPChannel, endpoints, state };
}

const TOKEN = 'token-abc-123';

/** 可控的假插件服务器：支持正常路径与三种服务端失败模式。 */
async function startFakePlugin(options = {}) {
  const mode = options.mode ?? 'ok';
  const token = options.token ?? TOKEN;
  const requests = [];
  const state = { syncStarted: 0, running: false, lastSync: null, selected: [] };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, path: url.pathname, headers: req.headers, body });
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (mode === 'endpoint-missing') return send(404, { error: 'Not found' });
      if (mode === 'token-not-configured') return send(503, { ok: false, error: 'token-not-configured' });
      if (mode === 'endpoint-error') return send(500, { ok: false, error: 'endpoint-failed' });
      // 写入被 Zotero 内部 API 拒绝（第七种失败）：与「插件出错」必须区分
      if (mode === 'write-denied') return send(500, { ok: false, error: 'annotation-save-failed' });
      if (req.headers[PLUGIN_TOKEN_HEADER.toLowerCase()] !== token) return send(401, { ok: false, error: 'unauthorized' });
      if (url.pathname === '/zoteromcp/annotations' && req.method === 'POST') {
        // 与真插件同一契约：默认关闭 → 403 + 开启方法
        if (options.annotationsEnabled !== true) {
          return send(403, {
            ok: false,
            error: 'annotations-disabled',
            hint: '注释写入默认关闭：请在 Zotero「设置 → 高级 → 配置编辑器」把 extensions.zoteromcp.enableAnnotations 设为 true 后重启 Zotero',
          });
        }
        const parsedBody = JSON.parse(body.length > 0 ? body : '{}');
        state.annotations = Array.isArray(parsedBody.annotations) ? parsedBody.annotations : [];
        return send(200, { ok: true, attachmentKey: parsedBody.attachmentKey, created: state.annotations.map((_entry, index) => ({ key: `ANNO${index + 1}`, type: 'highlight', pageLabel: '1' })) });
      }
      if (url.pathname === '/zoteromcp/health' && req.method === 'GET') {
        return send(200, {
          ok: true,
          plugin: { id: 'zotero-mcp@guozao-ex.github.io', version: '1.0.0' },
          endpoints: [...PLUGIN_ENDPOINTS],
          sync: { enabled: true, running: state.running, lastSync: state.lastSync },
          httpServer: { port: 23119 },
        });
      }
      if (url.pathname === '/zoteromcp/sync' && req.method === 'POST') {
        const fresh = state.lastSync !== null && Date.now() - Date.parse(state.lastSync) < 10_000;
        if (state.running || fresh) {
          // 与真插件同一契约：进行中或刚同步过时只回报状态，不重复触发
          return send(200, {
            ok: true,
            started: false,
            reason: state.running ? '同步已在进行中，复用本次会话' : '刚刚同步过，本次只回报状态',
            enabled: true,
            running: state.running,
            lastSync: state.lastSync,
          });
        }
        state.running = true;
        state.syncStarted += 1;
        // 用真实定时器模拟一次很短的同步，便于断言「轮询到完成」
        setTimeout(() => {
          state.running = false;
          // 真机上 getLastSyncTime() 会更新为「刚刚」，这里保持一致（否则轮询窗口判定会失真）
          state.lastSync = new Date().toISOString();
        }, options.syncDurationMs ?? 60);
        return send(200, { ok: true, started: true, enabled: true, running: state.running, lastSync: state.lastSync });
      }
      if (url.pathname === '/zoteromcp/select-items' && req.method === 'POST') {
        const parsed = body.length > 0 ? JSON.parse(body) : {};
        state.selected.push(parsed.key);
        return send(200, { ok: true, key: parsed.key, itemID: 4242 });
      }
      return send(404, { error: 'Not found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function connectPair() {
  const server = createMcpServer();
  const client = new Client({ name: 'plugin-channel-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function parseResult(result) {
  return JSON.parse(String(result.content[0]?.text ?? 'null'));
}

/** 起「临时数据目录 + 假插件 + MCP 客户端」，结束后完整恢复环境。 */
async function withPluginEnv(fn, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-plugin-'));
  const auditDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-plugin-audit-'));
  if (options.tokenFile !== false) writeFileSync(join(dataDir, 'zoteromcp-token.txt'), `${options.tokenFile ?? TOKEN}\n`, 'utf8');
  const plugin = options.server === null ? null : await startFakePlugin(options.server ?? {});
  const previous = {
    data: process.env['ZOTERO_MCP_DATA_DIR'],
    token: process.env['ZOTERO_MCP_PLUGIN_TOKEN'],
    base: process.env['ZOTERO_MCP_BASE_URL'],
    audit: process.env['ZOTERO_MCP_AUDIT_DIR'],
  };
  process.env['ZOTERO_MCP_DATA_DIR'] = dataDir;
  delete process.env['ZOTERO_MCP_PLUGIN_TOKEN'];
  process.env['ZOTERO_MCP_AUDIT_DIR'] = auditDir;
  if (options.baseUrl !== undefined) process.env['ZOTERO_MCP_BASE_URL'] = options.baseUrl;
  else if (plugin !== null) process.env['ZOTERO_MCP_BASE_URL'] = plugin.url;
  const { client, server } = await connectPair();
  try {
    return await fn({ client, server, plugin, dataDir, auditDir });
  } finally {
    await client.close();
    await server.close();
    await plugin?.close();
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('ZOTERO_MCP_DATA_DIR', previous.data);
    restore('ZOTERO_MCP_PLUGIN_TOKEN', previous.token);
    restore('ZOTERO_MCP_BASE_URL', previous.base);
    restore('ZOTERO_MCP_AUDIT_DIR', previous.audit);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
  }
}

let built = null;
/** 构建一次并缓存（构建本身确定性，多测复用）。 */
async function buildOnce() {
  if (built === null) {
    const result = await buildPlugin();
    built = { ...result, entries: readZipEntries(readFileSync(result.xpiPath)) };
  }
  return built;
}

// ── 1. 插件包结构与端点生命周期 ─────────────────────────────────────────

test('插件包结构与端点生命周期：XPI 结构合法，startup 注册、shutdown 清理', async () => {
  const result = await buildOnce();
  const names = [...result.entries.keys()].sort();
  assert.deepEqual(names, ['bootstrap.js', 'content/channel.js', 'manifest.json'], '包根即插件根目录，不得多套一层');
  const manifest = JSON.parse(result.entries.get('manifest.json').toString('utf8'));
  assert.equal(manifest.manifest_version, 2);
  assert.match(manifest.applications.zotero.id, /^[^@\s]+@[^@\s]+$/u);
  assert.equal(manifest.applications.zotero.strict_max_version, '10.0.*');
  // 内联后的主逻辑是经典脚本（loadSubScript 只能加载经典脚本），且含工具箱
  const bundle = result.entries.get('content/channel.js').toString('utf8');
  assert.ok(!/^\s*import\s/mu.test(bundle), 'bundle 不得残留 ESM import');
  assert.ok(!/^\s*export\s/mu.test(bundle), 'bundle 不得残留 ESM export');
  assert.ok(!bundle.includes('import('), 'bundle 不得残留动态 import');

  const { bundle: plugin, endpoints, state } = sandboxPlugin(bundle);
  assert.ok(plugin, 'bundle 必须导出 ZoteroMCPChannel');
  assert.deepEqual(Object.keys(endpoints), [], '创建实例时不应注册任何端点');
  const instance = plugin.create({ id: 'zotero-mcp@test', version: '9.9.9', rootURI: 'file:///plugin/' });
  await instance.startup();
  assert.deepEqual(Object.keys(endpoints).sort(), [...PLUGIN_ENDPOINTS].sort());
  // 不覆盖他人端点：再放一个别人的路由，shutdown 后必须仍在
  endpoints['/otherplugin/thing'] = function () {};
  instance.shutdown();
  assert.deepEqual(Object.keys(endpoints), ['/otherplugin/thing'], 'shutdown 只能删除自己注册的端点');
  assert.equal(state.syncCalls, 0, '注册与卸载都不得触发同步');
});

test('端点契约：方法/Content-Type 声明正确，init 按 token 与输入返回', async () => {
  const result = await buildOnce();
  const { bundle: plugin, endpoints, state } = sandboxPlugin(result.entries.get('content/channel.js').toString('utf8'));
  const instance = plugin.create({ id: 'zotero-mcp@test', version: '1.0.0', rootURI: 'file:///plugin/' });
  await instance.startup();

  const health = new endpoints['/zoteromcp/health']();
  const sync = new endpoints['/zoteromcp/sync']();
  const select = new endpoints['/zoteromcp/select-items']();
  assert.deepEqual([...health.supportedMethods], ['GET']);
  assert.deepEqual([...sync.supportedMethods], ['POST']);
  assert.deepEqual([...select.supportedMethods], ['POST']);
  assert.deepEqual([...sync.supportedDataTypes], ['application/json']);
  assert.deepEqual([...select.supportedDataTypes], ['application/json']);
  const merge = new endpoints['/zoteromcp/merge']();
  const recognize = new endpoints['/zoteromcp/recognize-pdf']();
  assert.deepEqual([...merge.supportedMethods], ['POST']);
  assert.deepEqual([...recognize.supportedMethods], ['POST']);
  assert.deepEqual([...merge.supportedDataTypes], ['application/json']);
  assert.deepEqual([...recognize.supportedDataTypes], ['application/json']);
  const annotations = new endpoints['/zoteromcp/annotations']();
  assert.deepEqual([...annotations.supportedMethods], ['POST']);
  assert.deepEqual([...annotations.supportedDataTypes], ['application/json']);
  for (const endpoint of [health, sync, select, merge, recognize, annotations]) {
    assert.equal(endpoint.allowRequestsFromUnsafeWebContent, undefined, '不得放行浏览器发起的请求');
  }

  const ok = await health.init({ method: 'GET', headers: { 'x-zoteromcp-token': TOKEN }, data: null });
  assert.equal(ok[0], 200);
  assert.equal(ok[1], 'application/json');
  const body = JSON.parse(ok[2]);
  assert.equal(body.ok, true);
  assert.equal(body.plugin.version, '1.0.0');
  assert.deepEqual([...body.endpoints], [...PLUGIN_ENDPOINTS]);
  assert.equal(body.sync.enabled, true);
  assert.equal(body.sync.running, false);

  const badKey = await select.init({ method: 'POST', headers: { 'x-zoteromcp-token': TOKEN }, data: {} });
  assert.equal(badKey[0], 400, '缺 key 必须 400');
  assert.equal(JSON.parse(badKey[2]).error, 'key-required');
  const selected = await select.init({ method: 'POST', headers: { 'x-zoteromcp-token': TOKEN }, data: { key: 'KNOWNKEY01' } });
  assert.equal(selected[0], 200);
  assert.deepEqual(state.selectedItems, [4242]);
  const missing = await select.init({ method: 'POST', headers: { 'x-zoteromcp-token': TOKEN }, data: { key: 'NOPE0001' } });
  assert.equal(missing[0], 404);

  // 合并端点：参数白名单校验（沙箱没有真条目，先验参数门禁）
  assert.equal((await merge.init({ method: 'POST', headers: { 'x-zoteromcp-token': TOKEN }, data: {} }))[0], 400);
  assert.equal((await merge.init({ method: 'POST', headers: { 'x-zoteromcp-token': TOKEN }, data: { primaryKey: 'A', mergeKeys: [] } }))[0], 400);
  const selfMerge = await merge.init({ method: 'POST', headers: { 'x-zoteromcp-token': TOKEN }, data: { primaryKey: 'A', mergeKeys: ['A'] } });
  assert.equal(selfMerge[0], 400, 'primaryKey 不得出现在 mergeKeys 里');
  assert.equal(JSON.parse(selfMerge[2]).error, 'primary-in-merge-keys');
  const dupMerge = await merge.init({ method: 'POST', headers: { 'x-zoteromcp-token': TOKEN }, data: { primaryKey: 'A', mergeKeys: ['B', 'B'] } });
  assert.equal(dupMerge[0], 400, '重复 key 必须被拒绝');
  // 识别端点：keys 必填
  const noKeys = await recognize.init({ method: 'POST', headers: { 'x-zoteromcp-token': TOKEN }, data: {} });
  assert.equal(noKeys[0], 400);
  assert.equal(JSON.parse(noKeys[2]).error, 'keys-required');
});

test('无 token 或错 token 一律拒绝且无副作用；token 文件缺失时拒绝服务', async () => {
  const result = await buildOnce();
  const { bundle: plugin, endpoints, state } = sandboxPlugin(result.entries.get('content/channel.js').toString('utf8'));
  const instance = plugin.create({ id: 'zotero-mcp@test', version: '1.0.0', rootURI: 'file:///plugin/' });
  await instance.startup();
  const sync = new endpoints['/zoteromcp/sync']();
  const select = new endpoints['/zoteromcp/select-items']();

  for (const headers of [{}, { 'x-zoteromcp-token': '' }, { 'x-zoteromcp-token': 'wrong-token' }]) {
    const response = await sync.init({ method: 'POST', headers, data: {} });
    assert.equal(response[0], 401, `token 不匹配必须 401：${JSON.stringify(headers)}`);
    assert.deepEqual(JSON.parse(response[2]), { ok: false, error: 'unauthorized' }, '拒绝响应不得泄露任何状态');
    const selectResponse = await select.init({ method: 'POST', headers, data: { key: 'KNOWNKEY01' } });
    assert.equal(selectResponse[0], 401);
  }
  assert.equal(state.syncCalls, 0, '被拒绝的请求不得触发同步');
  assert.deepEqual(state.selectedItems, [], '被拒绝的请求不得改变选中状态');

  // token 文件缺失：拒绝服务而不是放行
  state.tokenFile = null;
  const noFile = await sync.init({ method: 'POST', headers: { 'x-zoteromcp-token': TOKEN }, data: {} });
  assert.equal(noFile[0], 503);
  assert.equal(JSON.parse(noFile[2]).error, 'token-not-configured');
  state.tokenFile = '';
  const emptyFile = await sync.init({ method: 'POST', headers: { 'x-zoteromcp-token': TOKEN }, data: {} });
  assert.equal(emptyFile[0], 503, '空 token 文件同样拒绝服务');
  assert.equal(state.syncCalls, 0);

  // 常量时间比较的行为契约
  assert.equal(plugin.tokenMatches('abc', 'abc'), true);
  assert.equal(plugin.tokenMatches('abc', 'abd'), false);
  assert.equal(plugin.tokenMatches('abc', 'abcd'), false);
  assert.equal(plugin.tokenMatches('', ''), false);
  assert.equal(plugin.tokenMatches('abc', undefined), false);
});

// ── 2. 同步语义 ─────────────────────────────────────────────────────────

test('同步端点：触发一次并回报 running/lastSync 供轮询，已同步中不重复触发', async () => {
  const result = await buildOnce();
  const { bundle: plugin, endpoints, state } = sandboxPlugin(result.entries.get('content/channel.js').toString('utf8'));
  const instance = plugin.create({ id: 'zotero-mcp@test', version: '1.0.0', rootURI: 'file:///plugin/' });
  await instance.startup();
  const sync = new endpoints['/zoteromcp/sync']();
  const first = await sync.init({ method: 'POST', headers: { 'x-zoteromcp-token': TOKEN }, data: {} });
  assert.equal(first[0], 200);
  const firstBody = JSON.parse(first[2]);
  assert.equal(firstBody.started, true);
  assert.equal(state.syncCalls, 1);
  assert.equal(firstBody.lastSync, '2026-09-18T10:00:00.000Z', 'lastSync 必须来自 Zotero.Sync.Data.Local.getLastSyncTime');
  // 同步进行中：如实回报状态，不重复触发
  state.syncCalls = 0;
  const runningSandbox = sandboxPlugin(result.entries.get('content/channel.js').toString('utf8'), {
    Zotero: { Sync: { Runner: { enabled: true, syncInProgress: true, sync: () => Promise.resolve() }, Data: { Local: { getLastSyncTime: () => false } } } },
  });
  const runningInstance = runningSandbox.bundle.create({ id: 'x', version: '1.0.0', rootURI: 'file:///p/' });
  await runningInstance.startup();
  const runningSync = new runningSandbox.endpoints['/zoteromcp/sync']();
  const during = await runningSync.init({ method: 'POST', headers: { 'x-zoteromcp-token': TOKEN }, data: {} });
  const duringBody = JSON.parse(during[2]);
  assert.equal(duringBody.running, true);
  assert.equal(duringBody.started, false);
  assert.equal(duringBody.lastSync, null, 'getLastSyncTime 返回 false 时必须报 null 而不是瞎编时间');
  assert.equal(runningSandbox.state.syncCalls, 0, '已在同步中不得重复触发');
  // 同步未启用
  const disabledSandbox = sandboxPlugin(result.entries.get('content/channel.js').toString('utf8'), {
    Zotero: { Sync: { Runner: { enabled: false, syncInProgress: false, sync: () => Promise.resolve() }, Data: { Local: { getLastSyncTime: () => false } } } },
  });
  const disabledInstance = disabledSandbox.bundle.create({ id: 'x', version: '1.0.0', rootURI: 'file:///p/' });
  await disabledInstance.startup();
  const disabled = await new disabledSandbox.endpoints['/zoteromcp/sync']().init({ method: 'POST', headers: { 'x-zoteromcp-token': TOKEN }, data: {} });
  assert.equal(JSON.parse(disabled[2]).error, 'sync-disabled');
  assert.equal(disabledSandbox.state.syncCalls, 0);
});

test('同步时间读取失败时端点仍返回 200，lastSync 如实为 null', async () => {
  const result = await buildOnce();
  const source = result.entries.get('content/channel.js').toString('utf8');
  const broken = sandboxPlugin(source, {
    Zotero: {
      Sync: {
        Runner: { enabled: true, syncInProgress: false, sync: () => Promise.resolve() },
        Data: { Local: { getLastSyncTime: () => { throw new Error('Last sync time not ready'); } } },
      },
    },
  });
  const instance = broken.bundle.create({ id: 'zotero-mcp@test', version: '1.0.0', rootURI: 'file:///plugin/' });
  await instance.startup();
  const health = await new broken.endpoints['/zoteromcp/health']().init({ method: 'GET', headers: { 'x-zoteromcp-token': TOKEN }, data: null });
  assert.equal(health[0], 200, '同步时间读不到不得让端点 500');
  const body = JSON.parse(health[2]);
  assert.equal(body.sync.lastSync, null);
  assert.equal(body.sync.enabled, true);
  assert.match(String(body.sync.lastSyncError), /Last sync time/u, '失败原因要如实带上');
  const sync = await new broken.endpoints['/zoteromcp/sync']().init({ method: 'POST', headers: { 'x-zoteromcp-token': TOKEN }, data: {} });
  assert.equal(sync[0], 200, 'sync 端点同样不得因为该瞬态失败');
  assert.equal(JSON.parse(sync[2]).lastSync, null);
});

test('MCP 侧 sync 可轮询到完成：running true → false 且 lastSync 更新', async () => {
  await withPluginEnv(
    async ({ plugin }) => {
      const first = await pluginSync({ baseUrl: plugin.url });
      assert.equal(first.pluginAvailable, true);
      assert.equal(first.started, true);
      assert.equal(first.running, true, '刚触发时应处于运行中');
      assert.equal(first.syncEnabled, true);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const second = await pluginSync({ baseUrl: plugin.url });
      assert.equal(second.running, false);
      assert.ok(
        Number.isFinite(Date.parse(second.lastSync)) && Math.abs(Date.now() - Date.parse(second.lastSync)) < 5000,
        `lastSync 必须是刚刚完成的时刻，收到 ${String(second.lastSync)}`,
      );
      assert.equal(second.started, false, '轮询窗口内不得重复触发');
      assert.equal(plugin.state.syncStarted, 1, '轮询不得重复触发同步');
      // 请求头与请求体形态
      const syncRequests = plugin.requests.filter((entry) => entry.path === '/zoteromcp/sync');
      assert.ok(syncRequests.length >= 2);
      for (const entry of syncRequests) {
        assert.equal(entry.method, 'POST');
        assert.equal(entry.headers['content-type'], 'application/json');
        assert.equal(entry.headers[PLUGIN_TOKEN_HEADER.toLowerCase()], TOKEN);
        assert.ok(!entry.path.includes(TOKEN) && !entry.body.includes(TOKEN), 'token 绝不能进 URL 或请求体');
      }
    },
    { server: { syncDurationMs: 60 } },
  );
});

// ── 3. 深链接 ───────────────────────────────────────────────────────────

test('深链接格式正确、页码按 1-based 校验，且插件缺失时仍可用', async () => {
  assert.equal(revealDeepLink({ key: 'ABCD1234' }), 'zotero://select/library/items/ABCD1234');
  assert.equal(revealDeepLink({ key: 'ABCD1234', page: 7 }), 'zotero://open-pdf/library/items/ABCD1234?page=7');
  assert.equal(
    revealDeepLink({ key: 'ABCD1234', page: 7, annotation: 'ANNO9999' }),
    'zotero://open-pdf/library/items/ABCD1234?page=7&annotation=ANNO9999',
  );
  assert.equal(revealDeepLink({ key: 'ABCD1234', groupId: '12345' }), 'zotero://select/groups/12345/items/ABCD1234');
  for (const page of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => revealDeepLink({ key: 'ABCD1234', page }), /1 起的正整数/u);
  }
  assert.throws(() => revealDeepLink({ key: '' }), /key 不能为空/u);
  assert.throws(() => revealDeepLink({ key: 'bad key!' }), /key 格式非法/u);

  // 插件缺失（端点 404）时 reveal 仍然可用
  await withPluginEnv(
    async ({ client }) => {
      const result = parseResult(
        await client.callTool({ name: 'zotero_client', arguments: { mode: 'reveal', key: 'ABCD1234', page: 3 } }),
      );
      assert.equal(result.deepLink, 'zotero://open-pdf/library/items/ABCD1234?page=3');
      assert.equal(result.pluginAvailable, false);
      assert.equal(result.reason, 'endpoint-missing');
      assert.ok(result.note.length > 0, '必须给出可读提示');
      assert.equal(result.selected, false);
    },
    { server: { mode: 'endpoint-missing' } },
  );
});

test('插件可用时 reveal 让 Zotero 选中条目', async () => {
  await withPluginEnv(async ({ client, plugin }) => {
    const result = parseResult(await client.callTool({ name: 'zotero_client', arguments: { mode: 'reveal', key: 'KNOWNKEY01' } }));
    assert.equal(result.deepLink, 'zotero://select/library/items/KNOWNKEY01');
    assert.equal(result.pluginAvailable, true);
    assert.equal(result.selected, true);
    assert.deepEqual(plugin.state.selected, ['KNOWNKEY01']);
  });
});

// ── 4. 七种失败降级 ─────────────────────────────────────────────────────

test('七种失败各自降级且零写入：404 / 401 / 连接失败 / token 未配置 / 注释写入被关闭(403) / 写入被拒(500 annotation-save-failed) / 端点 5xx', async () => {
  const reasons = [];
  // ① 端点不存在
  await withPluginEnv(
    async ({ client, auditDir }) => {
      const health = parseResult(await client.callTool({ name: 'zotero_client', arguments: { mode: 'health' } }));
      assert.equal(health.pluginAvailable, false);
      assert.equal(health.reason, 'endpoint-missing');
      assert.equal(health.endpoints.length, 0);
      assert.equal(readdirSyncSafe(auditDir).length, 0, '降级不得产生审计或快照');
      reasons.push(health.reason);
    },
    { server: { mode: 'endpoint-missing' } },
  );
  // ② token 不匹配
  await withPluginEnv(
    async ({ client, auditDir }) => {
      const health = parseResult(await client.callTool({ name: 'zotero_client', arguments: { mode: 'health' } }));
      assert.equal(health.pluginAvailable, false);
      assert.equal(health.reason, 'unauthorized');
      assert.equal(readdirSyncSafe(auditDir).length, 0, '降级不得产生审计或快照');
      reasons.push(health.reason);
    },
    { server: { mode: 'ok', token: 'a-different-token' } },
  );
  // ③ HTTP 服务器不可达（用一个已关闭的端口）
  const dead = await startFakePlugin({});
  const deadUrl = dead.url;
  await dead.close();
  await withPluginEnv(
    async ({ client, auditDir }) => {
      const sync = parseResult(await client.callTool({ name: 'zotero_client', arguments: { mode: 'sync' } }));
      assert.equal(sync.pluginAvailable, false);
      assert.equal(sync.reason, 'http-server-disabled');
      assert.equal(sync.running, false);
      assert.match(sync.note, /等待自动同步/u);
      assert.equal(readdirSyncSafe(auditDir).length, 0, '降级不得产生审计或快照');
      reasons.push(sync.reason);
    },
    { server: null, baseUrl: deadUrl },
  );
  // ④ 本地没有 token
  await withPluginEnv(
    async ({ client, auditDir }) => {
      const health = parseResult(await client.callTool({ name: 'zotero_client', arguments: { mode: 'health' } }));
      assert.equal(health.pluginAvailable, false);
      assert.equal(health.reason, 'token-not-configured');
      assert.equal(readdirSyncSafe(auditDir).length, 0, '降级不得产生审计或快照');
      reasons.push(health.reason);
    },
    { tokenFile: false },
  );
  // ⑤ 插件端 5xx：必须与 404 区分，不能误报成「插件未安装」
  await withPluginEnv(
    async ({ client, auditDir }) => {
      const health = parseResult(await client.callTool({ name: 'zotero_client', arguments: { mode: 'health' } }));
      assert.equal(health.pluginAvailable, false);
      assert.equal(health.reason, 'endpoint-error');
      assert.equal(readdirSyncSafe(auditDir).length, 0, '降级不得产生审计或快照');
      assert.notEqual(health.reason, 'endpoint-missing', '插件出错不得被误报成插件未安装');
      assert.match(health.hint, /5xx|出错/u);
      reasons.push(health.reason);
    },
    { server: { mode: 'endpoint-error' } },
  );
  // ⑥ 注释写入被关闭（403）：这一种只在注释端点上出现（pref 未打开），
  //    与故障类失败必须区分开——它是**正常拒绝**，提示要给出开启方法。
  await withPluginEnv(
    async ({ auditDir }) => {
      const annotations = await requestPluginAnnotations({
        attachmentKey: 'ATT00001',
        annotations: [{ type: 'highlight', text: 'x', position: { pageIndex: 0, rects: [[1, 2, 3, 4]] } }],
      });
      assert.equal(annotations.pluginAvailable, false);
      assert.equal(annotations.reason, 'annotations-disabled');
      assert.match(annotations.hint, /extensions\.zoteromcp\.enableAnnotations/u);
      assert.notEqual(annotations.reason, 'unauthorized', '默认关闭不得被误报成 token 不匹配');
      assert.equal(readdirSyncSafe(auditDir).length, 0, '降级不得产生审计或快照');
      reasons.push(annotations.reason);
    },
    { server: { mode: 'ok', annotationsEnabled: false } },
  );
  // ⑦ 写入被 Zotero 内部 API 拒绝（500 annotation-save-failed）：回退链必须把这一级判为**真实失败**，
  //    不能与「插件出错」混为一谈（它在实现里映射为 write-denied）。
  await withPluginEnv(
    async ({ auditDir }) => {
      const annotations = await requestPluginAnnotations({
        attachmentKey: 'ATT00001',
        annotations: [{ type: 'highlight', text: 'x', position: { pageIndex: 0, rects: [[1, 2, 3, 4]] } }],
      });
      assert.equal(annotations.pluginAvailable, false);
      assert.equal(annotations.reason, 'write-denied');
      assert.match(annotations.hint, /写入/u);
      assert.notEqual(annotations.reason, 'endpoint-error', '写入被拒不得被误报成端点故障');
      assert.equal(readdirSyncSafe(auditDir).length, 0, '降级不得产生审计或快照');
      reasons.push(annotations.reason);
    },
    { server: { mode: 'write-denied', annotationsEnabled: true } },
  );
  assert.deepEqual(
    [...new Set(reasons)].sort(),
    [
      'annotations-disabled',
      'endpoint-error',
      'endpoint-missing',
      'http-server-disabled',
      'token-not-configured',
      'unauthorized',
      'write-denied',
    ],
    '七种原因必须互不相同',
  );
});

test('token 解析顺序：环境变量优先于文件；目录可用 ZOTERO_MCP_DATA_DIR 覆盖', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-token-'));
  try {
    writeFileSync(join(dataDir, 'zoteromcp-token.txt'), 'from-file\n', 'utf8');
    assert.equal(readPluginToken({ dataDir, env: {} }), 'from-file');
    assert.equal(readPluginToken({ dataDir, env: { ZOTERO_MCP_PLUGIN_TOKEN: 'from-env' } }), 'from-env');
    assert.equal(readPluginToken({ dataDir: join(dataDir, 'missing'), env: {} }), null);
    assert.equal(resolveDataDir(dataDir), dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

// ── 5. 工具面与依赖面 ───────────────────────────────────────────────────

test('工具面：公开工具清单与 write-tools 口径一致，zotero_client 契约完备且 reveal 缺 key 被拒', async () => {
  assert.equal(ALL_TOOLS.length, 24);
  assert.equal(TOOL_NAMES.length, 24);
  await withPluginEnv(async ({ client, plugin }) => {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 24);
    const tool = tools.find((entry) => entry.name === 'zotero_client');
    assert.ok(tool, '缺少 zotero_client');
    assert.deepEqual(tool.inputSchema.properties.mode.enum, [...PLUGIN_CLIENT_MODES]);
    for (const field of ['key', 'page', 'annotation']) assert.ok(tool.inputSchema.properties[field], `缺少参数 ${field}`);
    assert.deepEqual(tool.inputSchema.required, ['mode']);
    const refused = await client.callTool({ name: 'zotero_client', arguments: { mode: 'reveal' } });
    assert.equal(refused.isError, true);
    assert.match(String(refused.content[0].text), /必须提供 key/u);
    // health 正常路径
    const health = parseResult(await client.callTool({ name: 'zotero_client', arguments: { mode: 'health' } }));
    assert.equal(health.pluginAvailable, true);
    assert.equal(health.plugin.version, '1.0.0');
    assert.equal(health.sync.enabled, true);
    assert.equal(health.httpServer.port, 23119, '插件的 HTTP 服务器信息必须透传到工具结果');
    // token 不得出现在任何返回内容里
    assert.ok(!JSON.stringify(health).includes(TOKEN), 'token 绝不能出现在工具结果里');
    assert.ok(plugin.requests.every((entry) => !JSON.stringify(entry.body).includes(TOKEN)));
  });
});

test('依赖面与许可：运行期只多 zotero-plugin-toolkit，构建期只多 esbuild，XPI 内联工具箱', async () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.dependencies).filter((name) => name === 'zotero-plugin-toolkit'), ['zotero-plugin-toolkit']);
  assert.equal(pkg.dependencies['zotero-plugin-toolkit'].startsWith('^5.'), true);
  assert.equal(pkg.devDependencies['esbuild'] !== undefined, true);
  assert.equal(pkg.devDependencies['zotero-plugin-scaffold'], undefined, '不得引入额外脚手架');
  const toolkit = JSON.parse(readFileSync(join(ROOT, 'node_modules', 'zotero-plugin-toolkit', 'package.json'), 'utf8'));
  assert.equal(toolkit.license, 'MIT');
  const result = await buildOnce();
  const bundle = result.entries.get('content/channel.js').toString('utf8');
  assert.ok(bundle.includes('ZoteroToolkit'), 'XPI 内必须已内联工具箱');
  assert.ok(!/from\s+["']zotero-plugin-toolkit/u.test(bundle), 'XPI 内不得残留对第三方包的引用');
  assert.ok(!bundle.includes('fetch("https://'), '不得有任何从网络加载依赖的逻辑');
});

test('构建脚本：manifest 校验拒绝非法结构，ZIP 写入器自洽（CRC 与往返）', async () => {
  const base = JSON.parse(readFileSync(join(ROOT, 'packages', 'zotero-plugin', 'manifest.json'), 'utf8'));
  assert.equal(validateManifest(base).name, base.name);
  const cases = [
    [{ ...base, manifest_version: 3 }, /manifest_version/u],
    [{ ...base, applications: undefined }, /applications\.zotero/u],
    [{ ...base, applications: { zotero: { ...base.applications.zotero, id: 'not-an-id' } } }, /id 非法/u],
    [{ ...base, applications: { zotero: { ...base.applications.zotero, strict_max_version: '8.*' } } }, /覆盖 Zotero 10/u],
  ];
  for (const [manifest, pattern] of cases) {
    assert.throws(() => validateManifest(manifest), pattern);
  }
  // ZIP：自写写入器的 CRC 与解包往返
  const payload = Buffer.from('hello zotero plugin', 'utf8');
  assert.equal(typeof crc32(payload), 'number');
  assert.equal(crc32(Buffer.from('', 'utf8')), 0, '空内容的 CRC32 为 0');
  const zip = writeZip(new Map([['a.txt', payload], ['b/c.txt', Buffer.from('x'.repeat(5000), 'utf8')]]));
  const entries = readZipEntries(zip);
  assert.equal(entries.get('a.txt').toString('utf8'), 'hello zotero plugin');
  assert.equal(entries.get('b/c.txt').length, 5000);
  // 同一输入两次构建字节一致
  const again = writeZip(new Map([['a.txt', payload], ['b/c.txt', Buffer.from('x'.repeat(5000), 'utf8')]]));
  assert.ok(zip.equals(again), 'ZIP 输出必须确定可复现');
});

test('构建产物确定可复现，且 npm run plugin:build 可直接跑通', async () => {
  const first = await buildOnce();
  const { stdout } = await execFileAsync(process.execPath, [join(ROOT, 'scripts', 'plugin-build.mjs')], { cwd: ROOT });
  assert.match(stdout, /插件：Zotero MCP Channel/u);
  assert.match(stdout, /从文件安装插件/u);
  const second = readFileSync(first.xpiPath);
  assert.equal(second.length, first.bytes);
  assert.ok(readZipEntries(second).has('manifest.json'));
});

function readdirSyncSafe(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

// ── G1：注释写入端点（change · plugin-annotation-endpoint） ──

test('G1 注释端点：默认关闭（fail-closed），开启后经 saveFromJSON 创建并补 key + loadPrimaryData', async () => {
  const calls = { saveFromJSON: [], loadPrimaryData: 0, generatedKeys: 0 };
  const prefs = { 'extensions.zoteromcp.enableAnnotations': false };
  const attachment = {
    id: 777,
    key: 'ATT00001',
    isAttachment: () => true,
    attachmentContentType: 'application/pdf',
  };
  const overrides = {
    Zotero: {
      Prefs: { get: (name) => (name in prefs ? prefs[name] : 23119) },
      Items: { getByLibraryAndKeyAsync: async (_libraryID, key) => (key === 'ATT00001' ? attachment : null) },
      DataObjectUtilities: {
        generateKey: () => {
          calls.generatedKeys += 1;
          return 'ANNOGEN01';
        },
      },
      Annotations: {
        saveFromJSON: async (target, json) => {
          calls.saveFromJSON.push({ targetKey: target.key, json });
          return {
            key: json.key,
            annotationType: json.type,
            annotationPageLabel: json.pageLabel ?? null,
            loadPrimaryData: async () => {
              calls.loadPrimaryData += 1;
            },
          };
        },
      },
    },
  };
  // 用真实构建产物：先 startup 注册端点，再从 Endpoints 表里取构造器（与真机同一路径）
  const built = await buildOnce();
  const { bundle: plugin, endpoints } = sandboxPlugin(built.entries.get('content/channel.js').toString('utf8'), overrides);
  const instance0 = plugin.create({ id: 'zotero-mcp@test', version: '9.9.9', rootURI: 'file:///plugin/' });
  await instance0.startup();
  const Endpoint = endpoints['/zoteromcp/annotations'];
  assert.ok(Endpoint, '必须注册 /zoteromcp/annotations');

  const payload = {
    attachmentKey: 'ATT00001',
    annotations: [{ type: 'highlight', text: '高亮文字', comment: '', color: '#ffd400', position: { pageIndex: 0, rects: [[72, 500, 540, 520]] } }],
  };

  // ① 默认关闭：403 + 可读的开启方法，且不调用任何写入 API
  {
    const instance = new Endpoint();
    instance.plugin = {};
    const [status, , raw] = await instance.init({ headers: { 'x-zoteromcp-token': 'token-abc-123' }, data: payload });
    const body = JSON.parse(raw);
    assert.equal(status, 403);
    assert.equal(body.error, 'annotations-disabled');
    assert.match(body.hint, /extensions\.zoteromcp\.enableAnnotations/u);
    assert.equal(calls.saveFromJSON.length, 0, '默认关闭时绝不能调用写入 API');
  }

  // ② 打开开关：创建成功、补 key、调用 loadPrimaryData
  prefs['extensions.zoteromcp.enableAnnotations'] = true;
  {
    const instance = new Endpoint();
    instance.plugin = {};
    const [status, , raw] = await instance.init({ headers: { 'x-zoteromcp-token': 'token-abc-123' }, data: payload });
    const body = JSON.parse(raw);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.created.length, 1);
    assert.equal(body.created[0].key, 'ANNOGEN01');
    assert.equal(calls.generatedKeys, 1, '没有给 key 时必须自己生成（9.0.5 的失败点之一）');
    assert.equal(calls.saveFromJSON.length, 1);
    assert.equal(calls.saveFromJSON[0].json.key, 'ANNOGEN01');
    assert.equal(calls.saveFromJSON[0].json.position.pageIndex, 0);
    // 真机实测：PDF 注释的 sortIndex 必须匹配 /^\d{5}\|\d{6}\|\d{5}$/，缺了会抛 Invalid sortIndex
    assert.match(calls.saveFromJSON[0].json.sortIndex, /^\d{5}\|\d{6}\|\d{5}$/u, '缺 sortIndex 时必须按 position 兜底生成合法值');
    assert.equal(calls.loadPrimaryData, 1, '保存后必须 loadPrimaryData（9.0.5 的失败点之二）');
  }

  // ③b 批量里含非法项：全量校验后写入，不得先写合法项再报错（真机风险项）
  {
    const before = calls.saveFromJSON.length;
    const instance = new Endpoint();
    instance.plugin = {};
    const [status, , raw] = await instance.init({
      headers: { 'x-zoteromcp-token': 'token-abc-123' },
      data: {
        attachmentKey: 'ATT00001',
        annotations: [
          { type: 'highlight', text: '合法', position: { pageIndex: 0, rects: [[1, 2, 3, 4]] } },
          { type: 'nope', position: { pageIndex: 0, rects: [[1, 2, 3, 4]] } },
        ],
      },
    });
    assert.equal(status, 400);
    assert.equal(JSON.parse(raw).created.length, 0, '400 必须回报零写入');
    assert.equal(calls.saveFromJSON.length, before, '批量含非法项时不得先写入合法项');
  }

  // ③ 鉴权与校验：错误 token 401；缺 attachmentKey / 空 annotations / 非法类型 / 缺坐标都 400
  for (const [label, headers, data, expected] of [
    ['错误 token', { 'x-zoteromcp-token': 'wrong' }, payload, 401],
    ['缺 token', {}, payload, 401],
    ['缺附件 key', { 'x-zoteromcp-token': 'token-abc-123' }, { annotations: payload.annotations }, 400],
    ['空注释', { 'x-zoteromcp-token': 'token-abc-123' }, { attachmentKey: 'ATT00001', annotations: [] }, 400],
    ['非法类型', { 'x-zoteromcp-token': 'token-abc-123' }, { attachmentKey: 'ATT00001', annotations: [{ type: 'nope', position: { pageIndex: 0, rects: [[1, 2, 3, 4]] } }] }, 400],
    ['缺坐标', { 'x-zoteromcp-token': 'token-abc-123' }, { attachmentKey: 'ATT00001', annotations: [{ type: 'highlight', text: 'x' }] }, 400],
    ['附件不存在', { 'x-zoteromcp-token': 'token-abc-123' }, { attachmentKey: 'NOSUCH', annotations: payload.annotations }, 404],
  ]) {
    const instance = new Endpoint();
    instance.plugin = {};
    const [status] = await instance.init({ headers, data });
    assert.equal(status, expected, `${label} 应当是 ${expected}`);
  }

  // ④ 方法/Content-Type 约束与「不声明 allowRequestsFromUnsafeWebContent」
  const instance = new Endpoint();
  // 注意：端点对象来自 vm 沙箱，数组原型不同，必须先展开再比
  assert.deepEqual([...instance.supportedMethods], ['POST']);
  assert.deepEqual([...instance.supportedDataTypes], ['application/json']);
  assert.equal('allowRequestsFromUnsafeWebContent' in instance, false, '不得对不安全网页内容开放');
});

test('G1 客户端：默认关闭时把 annotations-disabled 透传给调用方，开启后拿到创建结果', async () => {
  const disabled = await startFakePlugin({ mode: 'ok' });
  try {
    const result = await requestPluginAnnotations({
      baseUrl: disabled.url,
      token: TOKEN,
      attachmentKey: 'ATT00001',
      annotations: [{ type: 'highlight', text: 'x', position: { pageIndex: 0, rects: [[1, 2, 3, 4]] } }],
    });
    assert.equal(result.pluginAvailable, false);
    assert.equal(result.reason, 'annotations-disabled');
    assert.match(result.hint, /extensions\.zoteromcp\.enableAnnotations/u);
  } finally {
    await disabled.close();
  }

  const enabled = await startFakePlugin({ mode: 'ok', annotationsEnabled: true });
  try {
    const result = await requestPluginAnnotations({
      baseUrl: enabled.url,
      token: TOKEN,
      attachmentKey: 'ATT00001',
      annotations: [{ type: 'highlight', text: '高亮文字', position: { pageIndex: 0, rects: [[72, 500, 540, 520]] } }],
    });
    assert.equal(result.pluginAvailable, true);
    assert.equal(result.created.length, 1);
    assert.equal(result.created[0].type, 'highlight');
    const sent = enabled.requests.find((request) => request.path === '/zoteromcp/annotations');
    assert.equal(sent.method, 'POST');
    assert.match(sent.headers['content-type'], /application\/json/u);
    assert.match(sent.body, /高亮文字/u);
  } finally {
    await enabled.close();
  }
});

// ── G1：真机取证 CLI（scripts/plugin-annotate.mjs） ──

test('G1 CLI：未开启退出 3、缺 --rects 退出 2、成功退出 0 并打印深链接', async () => {
  const cli = join(ROOT, "scripts", "plugin-annotate.mjs");
  const run = async (env, args) => {
    const previous = {
      base: process.env['ZOTERO_MCP_BASE_URL'],
      token: process.env['ZOTERO_MCP_PLUGIN_TOKEN'],
    };
    process.env['ZOTERO_MCP_BASE_URL'] = env.baseUrl;
    process.env['ZOTERO_MCP_PLUGIN_TOKEN'] = env.token;
    try {
      return await execFileAsync(process.execPath, [cli, ...args], { cwd: ROOT }).then(
        (value) => ({ code: 0, stdout: value.stdout, stderr: value.stderr }),
        (error) => ({ code: typeof error.code === 'number' ? error.code : -1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }),
      );
    } finally {
      if (previous.base === undefined) delete process.env['ZOTERO_MCP_BASE_URL'];
      else process.env['ZOTERO_MCP_BASE_URL'] = previous.base;
      if (previous.token === undefined) delete process.env['ZOTERO_MCP_PLUGIN_TOKEN'];
      else process.env['ZOTERO_MCP_PLUGIN_TOKEN'] = previous.token;
    }
  };
  const rects = ['--rects', '72,500,540,520'];

  // 未开启：退出码 3，并打印开启方法
  const disabled = await startFakePlugin({ mode: 'ok', annotationsEnabled: false });
  try {
    const result = await run(
      { baseUrl: disabled.url, token: TOKEN },
      ['--attachment', 'ATT00001', '--page', '1', '--text', 'x', ...rects],
    );
    assert.equal(result.code, 3, '未开启注释写入时必须以退出码 3 区分于普通失败');
    assert.match(result.stderr, /annotations-disabled|enableAnnotations/u);
    assert.equal(result.stdout.includes('✔'), false, '未开启时不得打印成功行');
  } finally {
    await disabled.close();
  }

  // 缺 --rects：退出码 2，且不发任何请求
  {
    const result = await run({ baseUrl: 'http://127.0.0.1:9', token: TOKEN }, ['--attachment', 'ATT00001', '--page', '1', '--text', 'x']);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--rects 是必填/u);
  }

  // 成功后：退出码 0、打印注释 key 与深链接、提示两步人工确认
  const enabled = await startFakePlugin({ mode: 'ok', annotationsEnabled: true });
  try {
    const result = await run(
      { baseUrl: enabled.url, token: TOKEN },
      ['--attachment', 'ATT00001', '--page', '3', '--text', '高亮文字', ...rects],
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /✔ 插件已创建注释/u);
    assert.match(result.stdout, /zotero:\/\/open-pdf\/library\/items\/ATT00001\?page=3&annotation=/u);
    assert.match(result.stdout, /阅读器/u);
    const sent = enabled.requests.find((request) => request.path === '/zoteromcp/annotations');
    assert.equal(sent.method, 'POST');
    assert.match(sent.body, /"pageIndex":2/u, '页码 3 应换算成 0-based 的 pageIndex 2');
  } finally {
    await enabled.close();
  }
});
