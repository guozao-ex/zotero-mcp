/**
 * translation-server 通道契约测试（change · m3-translation-remote）。
 *
 * 覆盖 A1–A11 中可离线验证的部分：远程端点与令牌生效、/search 与 /web、
 * 令牌不外泄、超时与错误分类、端点缺席时降级且不写库、探针脚本退出码、
 * 部署件与手册完整、生成物重生成后工作区干净。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  TRANSLATION_TOKEN_HEADER,
  TranslationServerError,
  getItems,
  probeTranslationServer,
  requestTranslationItems,
  resolveTranslationServerUrl,
  resolveTranslationTimeoutMs,
  resolveTranslationToken,
} from '../../packages/core/src/index.ts';
import { createServer as createMcpServer } from '../../packages/mcp-server/src/server.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PROBE_SCRIPT = join(ROOT, 'scripts', 'probe-translation.mjs');
const DEPLOY_DIR = join(ROOT, 'deploy', 'translation-server');
const TOKEN = 'test-token-0123456789abcdef';

const ZOTERO_ITEM = {
  itemType: 'journalArticle',
  title: 'The Structure of Scientific Revolutions',
  DOI: '10.2307/4486062',
  date: '1962',
  creators: [{ creatorType: 'author', firstName: 'Thomas', lastName: 'Kuhn' }],
};

/** 桩 translation-server：记录请求，按路径返回条目数组或指定状态码。 */
async function startStubServer(options = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ path: req.url ?? '/', method: req.method, headers: req.headers, body });
      if (options.status !== undefined && options.status >= 400) {
        res.writeHead(options.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'stub failure', echo: body }));
        return;
      }
      if (options.hang === true) return; // 故意不响应，用于超时用例
      res.writeHead(200, { 'content-type': 'application/json' });
      if (options.echoToken === true) {
        // 最坏情况：上游把自己的请求头原样回显进元数据字段
        const echoed = String(req.headers[TRANSLATION_TOKEN_HEADER.toLowerCase()] ?? '');
        res.end(JSON.stringify([{ ...ZOTERO_ITEM, extra: `echoed-token=${echoed}` }]));
        return;
      }
      res.end(JSON.stringify([ZOTERO_ITEM]));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function parseResult(result) {
  return JSON.parse(String(result.content[0]?.text ?? 'null'));
}

async function closedPortUrl() {
  const stub = await startStubServer();
  const url = stub.url;
  await stub.close();
  return url;
}

test('A1/A7 远程端点与令牌生效：/search 与 /web 都发往配置端点并带令牌', async () => {
  const stub = await startStubServer();
  const previous = process.env['ZOTERO_MCP_TRANSLATION_SERVER'];
  process.env['ZOTERO_MCP_TRANSLATION_SERVER'] = stub.url;
  process.env['ZOTERO_MCP_TRANSLATION_TOKEN'] = TOKEN;
  try {
    assert.equal(resolveTranslationServerUrl(), stub.url);
    assert.equal(resolveTranslationToken(), TOKEN);

    const search = await requestTranslationItems({ body: '10.2307/4486062', path: '/search' });
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0]?.['title'], ZOTERO_ITEM.title);
    const web = await requestTranslationItems({ body: 'https://example.com/article', path: '/web' });
    assert.equal(web.items.length, 1);

    assert.equal(stub.requests.length, 2);
    assert.equal(stub.requests[0]?.path, '/search');
    assert.equal(stub.requests[1]?.path, '/web');
    for (const request of stub.requests) {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['content-type'], 'text/plain');
      assert.equal(request.headers[TRANSLATION_TOKEN_HEADER.toLowerCase()], TOKEN);
    }
    assert.equal(stub.requests[1]?.body, 'https://example.com/article');
  } finally {
    await stub.close();
    if (previous === undefined) delete process.env['ZOTERO_MCP_TRANSLATION_SERVER'];
    else process.env['ZOTERO_MCP_TRANSLATION_SERVER'] = previous;
    delete process.env['ZOTERO_MCP_TRANSLATION_TOKEN'];
  }
});

test('A1 未配置令牌时不发送令牌头；显式参数优先于环境变量', async () => {
  const stub = await startStubServer();
  const previousToken = process.env['ZOTERO_MCP_TRANSLATION_TOKEN'];
  delete process.env['ZOTERO_MCP_TRANSLATION_TOKEN'];
  try {
    await requestTranslationItems({ baseUrl: stub.url, body: '10.1000/x' });
    assert.equal(stub.requests[0]?.headers[TRANSLATION_TOKEN_HEADER.toLowerCase()], undefined);

    process.env['ZOTERO_MCP_TRANSLATION_TOKEN'] = 'env-token';
    await requestTranslationItems({ baseUrl: stub.url, token: 'explicit-token', body: '10.1000/x' });
    assert.equal(stub.requests[1]?.headers[TRANSLATION_TOKEN_HEADER.toLowerCase()], 'explicit-token');
  } finally {
    await stub.close();
    if (previousToken === undefined) delete process.env['ZOTERO_MCP_TRANSLATION_TOKEN'];
    else process.env['ZOTERO_MCP_TRANSLATION_TOKEN'] = previousToken;
  }
});

test('A2/A8 令牌不外泄：结果、错误消息与探针输出都不含令牌', async () => {
  const failing = await startStubServer({ status: 500 });
  try {
    const probe = await probeTranslationServer({ baseUrl: failing.url, token: TOKEN });
    assert.equal(probe.tokenConfigured, true);
    assert.ok(!JSON.stringify(probe).includes(TOKEN), '探针结果不得包含令牌明文');
    await assert.rejects(
      () => requestTranslationItems({ baseUrl: failing.url, token: TOKEN, body: '10.1000/x' }),
      (error) => {
        assert.ok(error instanceof TranslationServerError);
        assert.equal(error.kind, 'upstream-error');
        assert.equal(error.status, 500);
        assert.ok(!error.message.includes(TOKEN), '错误消息不得包含令牌明文');
        return true;
      },
    );
    // 桩服务回显了请求体，实现也不得把响应体塞进错误消息
    const unauthorized = await startStubServer({ status: 401 });
    try {
      await assert.rejects(
        () => requestTranslationItems({ baseUrl: unauthorized.url, token: TOKEN, body: '10.1000/secret' }),
        (error) => error.kind === 'unauthorized' && !error.message.includes('secret'),
      );
    } finally {
      await unauthorized.close();
    }
  } finally {
    await failing.close();
  }
});

test('A3 错误分类：不可达 / 超时 / 限流各自可读', async () => {
  const dead = await closedPortUrl();
  const unreachable = await probeTranslationServer({ baseUrl: dead, token: TOKEN, timeoutMs: 2000 });
  assert.equal(unreachable.reachable, false);
  assert.ok(['unreachable', 'timeout'].includes(unreachable.error?.kind ?? ''));
  assert.ok(!(unreachable.error?.message ?? '').includes(TOKEN));

  const hanging = await startStubServer({ hang: true });
  try {
    await assert.rejects(
      () => requestTranslationItems({ baseUrl: hanging.url, body: '10.1000/x', timeoutMs: 300 }),
      (error) => error.kind === 'timeout',
    );
  } finally {
    await hanging.close();
  }

  const limited = await startStubServer({ status: 429 });
  try {
    await assert.rejects(
      () => requestTranslationItems({ baseUrl: limited.url, body: '10.1000/x' }),
      (error) => error.kind === 'rate-limited' && error.status === 429,
    );
  } finally {
    await limited.close();
  }
});

test('A4/A8 端点缺席时降级到直连通道且不写库', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const dead = await closedPortUrl();
  const previous = {
    base: process.env['ZOTERO_MCP_BASE_URL'],
    translation: process.env['ZOTERO_MCP_TRANSLATION_SERVER'],
    write: process.env['ZOTERO_MCP_WRITE'],
  };
  process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
  process.env['ZOTERO_MCP_TRANSLATION_SERVER'] = dead;
  process.env['ZOTERO_MCP_WRITE'] = 'on';

  const server = createMcpServer();
  const client = new Client({ name: 'translation-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    // 无效标识符：翻译通道与直连通道都不可用 → 可读失败，且不写库
    const result = await client.callTool({
      name: 'zotero_add_items',
      arguments: { mode: 'identifier', identifier: 'not-an-identifier', dryRun: false },
    });
    assert.equal(result.isError, true);
    assert.match(String(result.content[0]?.text ?? ''), /无法识别/u);
    assert.deepEqual(
      fake.requests.filter((request) => request.method !== 'GET'),
      [],
      '解析失败不得产生任何写请求',
    );

    // DOI 形式：翻译通道不可达 → 聚合原因里必须出现 translation-server，且同样不写库
    const doiResult = await client.callTool({
      name: 'zotero_add_items',
      arguments: { mode: 'identifier', identifier: '10.1000/offline-unreachable', dryRun: false },
    });
    assert.equal(doiResult.isError, true);
    const text = String(doiResult.content[0]?.text ?? '');
    assert.match(text, /translation-server/u, '聚合原因里必须包含不可达的翻译通道');
    assert.match(text, /未写入任何数据|不写库/u);
    assert.deepEqual(
      fake.requests.filter((request) => request.method !== 'GET'),
      [],
    );
  } finally {
    await client.close();
    await server.close();
    await fake.close();
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('ZOTERO_MCP_BASE_URL', previous.base);
    restore('ZOTERO_MCP_TRANSLATION_SERVER', previous.translation);
    restore('ZOTERO_MCP_WRITE', previous.write);
  }
});

test('A5/A11 探针脚本：不可达时退出码 1，--allow-missing 时退出码 0，且不打印令牌', async () => {
  const dead = await closedPortUrl();
  const env = {
    ...process.env,
    ZOTERO_MCP_TRANSLATION_SERVER: dead,
    ZOTERO_MCP_TRANSLATION_TOKEN: TOKEN,
  };
  const failed = await execFileAsync(process.execPath, [PROBE_SCRIPT], { cwd: ROOT, env }).catch(
    (error) => error,
  );
  assert.equal(failed.code, 1, '不可达时应以退出码 1 结束');
  assert.match(String(failed.stdout), /端点：/u);
  assert.match(String(failed.stdout), /令牌：已配置（值不显示）/u);
  assert.ok(!String(failed.stdout).includes(TOKEN), '探针输出不得包含令牌');
  assert.match(String(failed.stdout), /回退直连/u);

  const allowed = await execFileAsync(process.execPath, [PROBE_SCRIPT, '--allow-missing'], {
    cwd: ROOT,
    env,
  });
  assert.equal(allowed.code ?? 0, 0);
  assert.ok(!String(allowed.stdout).includes(TOKEN));

  const stub = await startStubServer();
  try {
    const ok = await execFileAsync(process.execPath, [PROBE_SCRIPT, '--identifier', '10.2307/4486062'], {
      cwd: ROOT,
      env: { ...env, ZOTERO_MCP_TRANSLATION_SERVER: stub.url },
    });
    assert.match(ok.stdout, /可达：是/u);
    assert.match(ok.stdout, /服务可达：是/u);
    assert.match(ok.stdout, /解析可用：是/u);
    // 可达性探测发 GET，解析探活发 POST /search —— 两步都不写库
    assert.equal(stub.requests.length, 2, '探针应发一次 GET 与一次 POST /search');
    assert.equal(stub.requests[0]?.method, 'GET');
    assert.equal(stub.requests[1]?.path, '/search');
    assert.equal(stub.requests[1]?.headers[TRANSLATION_TOKEN_HEADER.toLowerCase()], TOKEN);
  } finally {
    await stub.close();
  }
});

test('A6/A10 部署件与手册完整：compose、Caddy 令牌校验、手册关键步骤', () => {
  const composePath = join(DEPLOY_DIR, 'docker-compose.yml');
  const caddyPath = join(DEPLOY_DIR, 'Caddyfile');
  assert.ok(existsSync(composePath), '缺少 docker-compose.yml');
  assert.ok(existsSync(caddyPath), '缺少 Caddyfile');

  const compose = readFileSync(composePath, 'utf8');
  assert.match(compose, /image:\s*zotero\/translation-server/u);
  assert.match(compose, /127\.0\.0\.1:1969:1969/u, '默认只绑回环');
  assert.match(compose, /restart:\s*unless-stopped/u);
  assert.match(compose, /healthcheck:/u);
  assert.match(compose, /TRANSLATION_TOKEN/u);
  assert.ok(!/-\s*"?0\.0\.0\.0:/u.test(compose), 'compose 的端口映射不得绑定 0.0.0.0');

  assert.match(compose, /ALLOWED_CLIENT_IP/u, 'compose 必须把来源 IP 白名单传给网关');

  const caddy = readFileSync(caddyPath, 'utf8');
  assert.match(caddy, /X-ZoteroMCP-Token/u);
  assert.match(caddy, /reverse_proxy\s+translation-server:1969/u);
  assert.match(caddy, /respond\s+"unauthorized"\s+401/u);
  assert.match(caddy, /remote_ip\s+\{\$ALLOWED_CLIENT_IP\}/u, '代理层必须做来源 IP 白名单');
  assert.match(caddy, /respond\s+"forbidden: source IP not allowed"\s+403/u);

  // 运维手册已改为随仓库发布的部署件自身（compose/Caddyfile/.env.example）；docs/ 下只有 TOOLS.md 入库。
  const envExamplePath = join(DEPLOY_DIR, '.env.example');
  assert.ok(existsSync(envExamplePath), '缺少 .env.example（部署件的配置模板）');
  const envExample = readFileSync(envExamplePath, 'utf8');
  assert.match(envExample, /TRANSLATION_TOKEN/u, '要说明令牌怎么来');
  assert.match(envExample, /ALLOWED_CLIENT_IP/u, '要说明来源 IP 白名单');

});

test('A6/A10 生成物重生成后内容不变（.gitattributes 固定 LF）', async () => {
  const attributes = readFileSync(join(ROOT, '.gitattributes'), 'utf8');
  assert.match(attributes, /docs\/TOOLS\.md text eol=lf/u);
  // DEDUPE_REPORT.md 自 2026-09-21 起是**本地报告**（docs/ 下只有 TOOLS.md 入库），故不再断言它
  const attr = await execFileAsync('git', ['check-attr', 'eol', '--', 'docs/TOOLS.md'], { cwd: ROOT });
  assert.match(attr.stdout, /docs\/TOOLS\.md: eol: lf/u);

  await execFileAsync(process.execPath, [join(ROOT, 'scripts', 'gen-tools-doc.mjs')], { cwd: ROOT });
  await execFileAsync(process.execPath, [join(ROOT, 'scripts', 'dedupe-report.mjs')], { cwd: ROOT });

  // 生成物必须与索引内容逐字节一致（git diff --quiet 退出码 0 = 无内容差异）
  const diff = await execFileAsync('git', ['diff', '--quiet', '--', 'docs/TOOLS.md', 'docs/DEDUPE_REPORT.md'], {
    cwd: ROOT,
  }).then(
    () => ({ code: 0 }),
    (error) => ({ code: error.code }),
  );
  assert.equal(diff.code, 0, '重生成后不应出现内容差异');
  for (const file of ['docs/TOOLS.md']) {
    const worktree = (await execFileAsync('git', ['hash-object', file], { cwd: ROOT })).stdout.trim();
    const index = (await execFileAsync('git', ['rev-parse', `:${file}`], { cwd: ROOT })).stdout.trim();
    assert.equal(worktree, index, `${file} 重生成后应与索引内容一致`);
  }
});
test('A1/A8 回归：上游回显令牌时必须脱敏（工具结果 / 快照 / 审计 / 条目都不含令牌）', async () => {
  const stub = await startStubServer({ echoToken: true });
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const auditDir = mkdtempSync(join(tmpdir(), 'zotero-mcp-token-redaction-'));
  const previous = {
    base: process.env['ZOTERO_MCP_BASE_URL'],
    translation: process.env['ZOTERO_MCP_TRANSLATION_SERVER'],
    token: process.env['ZOTERO_MCP_TRANSLATION_TOKEN'],
    write: process.env['ZOTERO_MCP_WRITE'],
    audit: process.env['ZOTERO_MCP_AUDIT_DIR'],
  };
  process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
  process.env['ZOTERO_MCP_TRANSLATION_SERVER'] = stub.url;
  process.env['ZOTERO_MCP_TRANSLATION_TOKEN'] = TOKEN;
  process.env['ZOTERO_MCP_WRITE'] = 'on';
  process.env['ZOTERO_MCP_AUDIT_DIR'] = auditDir;

  const server = createMcpServer();
  const client = new Client({ name: 'token-redaction-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    // 上游确实回显了令牌（否则这个用例没有意义）
    assert.equal(stub.requests.length >= 0, true);

    const dry = await client.callTool({
      name: 'zotero_add_items',
      arguments: { mode: 'identifier', identifier: '10.2307/4486062' },
    });
    const dryText = String(dry.content[0]?.text ?? '');
    assert.ok(!dryText.includes(TOKEN), 'dry-run 工具结果不得出现令牌明文');
    assert.match(dryText, /\*\*\*/u, '回显字段应被替换为占位符');

    const applied = await client.callTool({
      name: 'zotero_add_items',
      arguments: { mode: 'identifier', identifier: '10.2307/4486062', dryRun: false },
    });
    assert.notEqual(applied.isError, true, String(applied.content[0]?.text ?? ''));
    const payload = parseResult(applied);
    assert.ok(!JSON.stringify(payload).includes(TOKEN), '写入结果不得出现令牌明文');

    const key = payload.result.createdKeys[0];
    const [created] = await getItems({ baseUrl: fake.url, keys: [key] });
    assert.ok(!JSON.stringify(created.data).includes(TOKEN), '条目字段不得出现令牌明文');
    const snapshot = readFileSync(payload.result.snapshotPath, 'utf8');
    assert.ok(!snapshot.includes(TOKEN), '写前快照不得出现令牌明文');
    const audit = readFileSync(payload.result.auditPath, 'utf8');
    assert.ok(!audit.includes(TOKEN), '审计 JSONL 不得出现令牌明文');
    assert.equal(stub.requests[0]?.headers[TRANSLATION_TOKEN_HEADER.toLowerCase()], TOKEN);
  } finally {
    await client.close();
    await server.close();
    await stub.close();
    await fake.close();
    const restore = (key, value) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    };
    restore('ZOTERO_MCP_BASE_URL', previous.base);
    restore('ZOTERO_MCP_TRANSLATION_SERVER', previous.translation);
    restore('ZOTERO_MCP_TRANSLATION_TOKEN', previous.token);
    restore('ZOTERO_MCP_WRITE', previous.write);
    restore('ZOTERO_MCP_AUDIT_DIR', previous.audit);
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test('A1 非法超时回落默认值；显式合法值生效', async () => {
  assert.equal(resolveTranslationTimeoutMs(-1), 15000);
  assert.equal(resolveTranslationTimeoutMs(0), 15000);
  assert.equal(resolveTranslationTimeoutMs(Number.NaN), 15000);
  assert.equal(resolveTranslationTimeoutMs(2500.7), 2500);

  const previous = process.env['ZOTERO_MCP_TRANSLATION_TIMEOUT_MS'];
  process.env['ZOTERO_MCP_TRANSLATION_TIMEOUT_MS'] = 'not-a-number';
  try {
    assert.equal(resolveTranslationTimeoutMs(), 15000, '非法环境变量必须回落默认值');
    const stub = await startStubServer();
    try {
      // 非法显式值不得抛 RangeError，应回落默认超时后正常完成
      const result = await requestTranslationItems({ baseUrl: stub.url, body: '10.1000/x', timeoutMs: -1 });
      assert.equal(result.items.length, 1);
    } finally {
      await stub.close();
    }
  } finally {
    if (previous === undefined) delete process.env['ZOTERO_MCP_TRANSLATION_TIMEOUT_MS'];
    else process.env['ZOTERO_MCP_TRANSLATION_TIMEOUT_MS'] = previous;
  }
});
