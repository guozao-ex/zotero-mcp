/**
 * PDF 元数据识别链契约测试（change · m3-pdf-identification）。
 *
 * 覆盖：四级链按序与短路、L1 复用 Zotero 全文索引、L2 字节窗口解析 XMP 与 /Info、
 * L3 复用既有通道、L4 相似度打分、未识别降级为 needs-metadata、mode=pdf 经写安全管线、
 * 计划内 @created 引用、识别报告只读与未识别清单、探针区分「服务可达」与「解析可用」。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import {
  applyPlan,
  extractIdentifier,
  getItems,
  identifyPdf,
  makeChangePlan,
  parsePdfInfo,
  parseXmp,
  pickBestByTitle,
  probeTranslationServer,
  resolveCreatedRefs,
  titleFromFileName,
} from '../../packages/core/src/index.ts';
import { createServer as createMcpServer } from '../../packages/mcp-server/src/server.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REPORT_SCRIPT = join(ROOT, 'scripts', 'identify-report.mjs');
const PROBE_SCRIPT = join(ROOT, 'scripts', 'probe-translation.mjs');
const FAKE_AUTHORIZE_KEY = 'FAKEKEY00000000000000000000000000';

/** 构造一个带 XMP 包的最小 PDF（XMP 是 PDF 里常见的自描述元数据）。 */
function xmpPacket({ title, creator, date, doi }) {
  return [
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"',
    ' xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/"',
    doi === undefined ? '' : ` prism:doi="${doi}"`,
    '>',
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${title}</rdf:li></rdf:Alt></dc:title>`,
    creator === undefined ? '' : `<dc:creator><rdf:Seq><rdf:li>${creator}</rdf:li></rdf:Seq></dc:creator>`,
    date === undefined ? '' : `<dc:date><rdf:Seq><rdf:li>${date}</rdf:li></rdf:Seq></dc:date>`,
    '</rdf:Description></rdf:RDF></x:xmpmeta>',
  ].join('');
}

function writePdf(filePath, { xmp, info, text }) {
  const head = `%PDF-1.4\n${text ?? ''}\n${xmp ?? ''}\n`;
  const tail = `${info ?? ''}\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`;
  writeFileSync(filePath, `${head}${tail}`, 'latin1');
}

async function connectPair() {
  const server = createMcpServer();
  const client = new Client({ name: 'pdf-identification-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function parseResult(result) {
  return JSON.parse(String(result.content[0]?.text ?? 'null'));
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'zotero-mcp-pdf-'));
}

/**
 * DOI 形态：`10.<4–9 位注册号>/…`。
 *
 * 用它而不是裸的 `'10.'` 子串判定：计划自身的 `createdAt` 时间戳在秒数恰为 10 时形如
 * `2026-09-18T12:44:10.123Z`，裸子串会把它误判成标识符（约 1/60 概率的假失败）。
 */
const IDENTIFIER_SHAPE = /10\.\d{4,9}\//u;

/** 可能在计划里携带标识符的字段键（识别失败时一个都不该出现）。 */
const IDENTIFIER_KEYS = ['DOI', 'ISBN', 'PMID', 'arXiv'];

/**
 * 遍历任意 JSON 值，返回所有「标识符形态字符串」与「标识符字段键」的命中路径。
 *
 * 既覆盖 `10.1000/xyz` 这类值，也覆盖 `DOI: '...'` 这类键——两边都挡住才算这条降级断言
 * 真的在守；返回路径是为了失败时能直接读出命中的位置与值。
 */
function identifierHits(value) {
  const hits = [];
  const visit = (node, path) => {
    if (typeof node === 'string') {
      if (IDENTIFIER_SHAPE.test(node)) hits.push(`${path}=${node}`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (node !== null && typeof node === 'object') {
      for (const [key, entry] of Object.entries(node)) {
        const next = path.length === 0 ? key : `${path}.${key}`;
        if (IDENTIFIER_KEYS.includes(key)) hits.push(`${next}=${JSON.stringify(entry)}`);
        visit(entry, next);
      }
    }
  };
  visit(value, '');
  return hits;
}

test('A1/A7 四级按序执行并在 L3 命中后短路', async () => {
  const dir = tempDir();
  try {
    const pdf = join(dir, 'with-doi.pdf');
    writePdf(pdf, { text: 'This article is available at doi:10.1000/level-one' });
    const calls = [];
    const result = await identifyPdf({
      path: pdf,
      io: {
        fileBytes: async () => 'This article is available at doi:10.1000/level-one',
        filePathOf: async () => pdf,
        resolveIdentifier: async (identifier) => {
          calls.push(identifier);
          return {
            records: [{ itemType: 'journalArticle', fields: { title: 'Resolved by L3', DOI: '10.1000/level-one' } }],
            source: 'translation-server',
          };
        },
        searchByTitle: async () => {
          throw new Error('L4 不应被调用（L3 已命中）');
        },
      },
    });
    assert.equal(result.level, 'L3');
    assert.equal(result.needsMetadata, false);
    assert.deepEqual(calls, ['10.1000/level-one']);
    assert.deepEqual(
      result.hits.map((entry) => `${entry.level}:${entry.ok ? 'ok' : 'miss'}`),
      ['L1:ok', 'L2:miss', 'L3:ok', 'L4:miss'],
      '四级必须按序留痕',
    );
    assert.match(result.hits[3]?.detail ?? '', /短路/u);
    assert.equal(result.record?.fields['title'], 'Resolved by L3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A2 字节窗口解析 XMP 与 /Info（不引入 PDF 解析库）', () => {
  const xmp = xmpPacket({ title: 'Glacier mass balance from XMP', creator: 'Li, Dan', date: '2021-03-01' });
  const parsedXmp = parseXmp(xmp);
  assert.equal(parsedXmp.title, 'Glacier mass balance from XMP');
  assert.deepEqual(parsedXmp.creators, ['Li, Dan']);
  assert.equal(parsedXmp.date, '2021-03-01');

  const info = '<</Title (Info Title Here)/Author (Ada Lovelace)/CreationDate (D:20190506)>>';
  const parsedInfo = parsePdfInfo(info);
  assert.equal(parsedInfo.title, 'Info Title Here');
  assert.equal(parsedInfo.author, 'Ada Lovelace');
  assert.equal(parsedInfo.date, '2019');

  // 十六进制 /Title（PDF 常见编码）
  const hexTitle = Buffer.from('Hex Encoded Title', 'latin1')
    .toString('hex')
    .toUpperCase();
  assert.equal(parsePdfInfo(`<</Title <${hexTitle}>>>`).title, 'Hex Encoded Title');
});

test('A2 L2 命中：文件里没有标识符但有 XMP 标题与作者', async () => {
  const dir = tempDir();
  try {
    const pdf = join(dir, 'xmp-only.pdf');
    writePdf(pdf, {
      xmp: xmpPacket({ title: 'Precambrian glacial erosion', creator: 'Feng Zhang', date: '2022-09-01' }),
    });
    const result = await identifyPdf({
      path: pdf,
      io: {
        resolveIdentifier: async () => null,
        searchByTitle: async () => null,
      },
    });
    assert.equal(result.level, 'L2');
    assert.equal(result.needsMetadata, false);
    assert.equal(result.record?.fields['title'], 'Precambrian glacial erosion');
    assert.deepEqual(result.record?.fields['creators'], [
      { creatorType: 'author', lastName: 'Zhang', firstName: 'Feng' },
    ]);
    assert.equal(result.record?.fields['date'], '2022-09-01');
    assert.equal(result.hits[0]?.ok, false, 'L1 应记录未命中');
    assert.equal(result.hits[1]?.ok, true, 'L2 应命中');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A3 L1 复用 Zotero 全文索引（附件场景不重复解析 PDF）', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0, fulltextContent: 'Full text mentions doi:10.1000/from-index' });
  try {
    const result = await identifyPdf({
      baseUrl: fake.url,
      itemKey: 'ATT00001',
      io: {
        resolveIdentifier: async () => ({
          records: [{ itemType: 'journalArticle', fields: { title: 'From index', DOI: '10.1000/from-index' } }],
          source: 'crossref',
        }),
        searchByTitle: async () => null,
      },
    });
    assert.equal(result.hits[0]?.ok, true);
    assert.equal(result.hits[0]?.source, 'zotero-fulltext', 'L1 必须优先用 Zotero 全文索引');
    assert.ok(
      fake.requests.some((request) => request.path.includes('/items/ATT00001/fulltext')),
      '应请求 Zotero 的全文索引端点',
    );
    assert.equal(result.level, 'L3');
  } finally {
    await fake.close();
  }
});

test('A4 L4 用相似度选最佳候选；L3 走既有通道并标注来源', async () => {
  const records = [
    { itemType: 'journalArticle', fields: { title: 'Completely different topic about machine learning' } },
    { itemType: 'journalArticle', fields: { title: 'Glacier runoff modelling in Xinjiang', DOI: '10.1000/best' } },
  ];
  const best = pickBestByTitle('Glacier runoff modelling in Xinjiang', records);
  assert.equal(best?.record.fields['DOI'], '10.1000/best');
  assert.ok((best?.score ?? 0) >= 0.8);
  assert.equal(pickBestByTitle('Glacier runoff modelling in Xinjiang', [records[0]], 0.95), null, '低于阈值不得采纳');

  const dir = tempDir();
  try {
    const pdf = join(dir, 'glacier_runoff_modelling_in_xinjiang.pdf');
    writePdf(pdf, {});
    const result = await identifyPdf({
      path: pdf,
      io: {
        resolveIdentifier: async () => null,
        searchByTitle: async (title) => {
          assert.equal(title, 'glacier runoff modelling in xinjiang', '没有 L2 标题时必须用文件名回退标题检索');
          return { records, source: 'crossref+openalex' };
        },
      },
    });
    assert.equal(result.level, 'L4');
    assert.equal(result.record?.fields['DOI'], '10.1000/best');
    assert.match(result.hits[3]?.source ?? '', /crossref\+openalex/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A5/A8 未识别时降级为 needs-metadata（默认不写库）', async () => {
  const dir = tempDir();
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const previous = {
    base: process.env['ZOTERO_MCP_BASE_URL'],
    write: process.env['ZOTERO_MCP_WRITE'],
    titleSearch: process.env['ZOTERO_MCP_TITLE_SEARCH'],
  };
  process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
  process.env['ZOTERO_MCP_TITLE_SEARCH'] = 'off'; // 离线确定性：不外呼 Crossref / OpenAlex
  delete process.env['ZOTERO_MCP_WRITE'];
  const { client, server } = await connectPair();
  try {
    const pdf = join(dir, 'unnamed_scan_2024-final.pdf');
    // 标题检索已关闭：L1–L4 全部未命中 → 走 needs-metadata 降级
    writePdf(pdf, {});
    const result = await client.callTool({
      name: 'zotero_add_items',
      arguments: { mode: 'pdf', path: pdf },
    });
    assert.notEqual(result.isError, true, String(result.content[0]?.text ?? ''));
    const payload = parseResult(result);
    assert.equal(payload.identification.needsMetadata, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.plan.operations[0].itemType, 'attachment');
    assert.equal(payload.plan.operations[0].fields.title, titleFromFileName('unnamed_scan_2024-final.pdf'));
    assert.deepEqual(payload.plan.operations[0].fields.tags, [{ tag: 'needs-metadata' }]);
    assert.deepEqual(identifierHits(payload.plan), [], '未识别时不应带任何标识符形态的字符串或标识符字段');

    // 提交（写开关关闭）必须被拒绝且零请求
    const rejected = await client.callTool({
      name: 'zotero_add_items',
      arguments: { mode: 'pdf', path: pdf, dryRun: false },
    });
    assert.equal(rejected.isError, true);
    assert.match(String(rejected.content[0]?.text ?? ''), /ZOTERO_MCP_WRITE|默认只读/u);
    assert.deepEqual(fake.requests.filter((request) => request.method !== 'GET'), []);
  } finally {
    await client.close();
    await server.close();
    await fake.close();
    if (previous.base === undefined) delete process.env['ZOTERO_MCP_BASE_URL'];
    else process.env['ZOTERO_MCP_BASE_URL'] = previous.base;
    if (previous.write !== undefined) process.env['ZOTERO_MCP_WRITE'] = previous.write;
    if (previous.titleSearch === undefined) delete process.env['ZOTERO_MCP_TITLE_SEARCH'];
    else process.env['ZOTERO_MCP_TITLE_SEARCH'] = previous.titleSearch;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A5 降级守卫本身可被证伪，且不被计划时间戳误伤', () => {
  // ① 守卫必须能失败：带 DOI 形态字符串的计划要被判出标识符（含嵌套与数组里的值）
  assert.deepEqual(identifierHits({ operations: [{ fields: { extra: 'doi:10.1000/leaked' } }] }), [
    'operations[0].fields.extra=doi:10.1000/leaked',
  ]);
  // ② 标识符字段键同样要被抓到（值不是 DOI 形态也不能放过）
  assert.deepEqual(identifierHits({ fields: { DOI: '' } }), ['fields.DOI=""']);
  assert.deepEqual(identifierHits({ fields: { ISBN: '978-0-306-40615-7' } }), ['fields.ISBN="978-0-306-40615-7"']);
  // ③ 反向：计划时间戳里也会出现「10.」，但秒数为 10 的 createdAt 不能被误判
  const stamped = { createdAt: '2026-09-18T12:44:10.123Z', summary: '新建 attachment（2 个字段）' };
  assert.ok(
    JSON.stringify(stamped).includes('10.'),
    '前提：裸子串判定确实会被这个时间戳命中（旧写法的失效条件）',
  );
  assert.deepEqual(identifierHits(stamped), [], '时间戳里的 10. 不是标识符');
  // ④ 真正干净的降级计划形态
  assert.deepEqual(identifierHits({ operations: [{ itemType: 'attachment', fields: { title: 'unnamed scan 2024-final', tags: [{ tag: 'needs-metadata' }] } }] }), []);
});

test('A9 mode=pdf 经写安全管线：条目 + linked 附件共用一次授权与一份快照', async () => {
  const dir = tempDir();
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const auditDir = tempDir();
  const previous = {
    base: process.env['ZOTERO_MCP_BASE_URL'],
    write: process.env['ZOTERO_MCP_WRITE'],
    audit: process.env['ZOTERO_MCP_AUDIT_DIR'],
    titleSearch: process.env['ZOTERO_MCP_TITLE_SEARCH'],
  };
  process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
  process.env['ZOTERO_MCP_WRITE'] = 'on';
  process.env['ZOTERO_MCP_AUDIT_DIR'] = auditDir;
  process.env['ZOTERO_MCP_TITLE_SEARCH'] = 'off';
  const { client, server } = await connectPair();
  try {
    const pdf = join(dir, 'identified.pdf');
    writePdf(pdf, { xmp: xmpPacket({ title: 'Identified by XMP', creator: 'Ada Lovelace', date: '2020-01-02' }) });
    const result = await client.callTool({
      name: 'zotero_add_items',
      arguments: { mode: 'pdf', path: pdf, dryRun: false },
    });
    assert.notEqual(result.isError, true, String(result.content[0]?.text ?? ''));
    const payload = parseResult(result);
    assert.equal(payload.identification.level, 'L2');
    const itemKey = payload.result.createdKeys[0];
    assert.ok(typeof itemKey === 'string' && itemKey.length > 0, '应创建条目');

    const [created, attachment] = await getItems({ baseUrl: fake.url, keys: [itemKey, payload.result.createdKeys[1]] });
    assert.equal(created?.data['title'], 'Identified by XMP');
    assert.equal(attachment?.data['itemType'], 'attachment');
    assert.equal(attachment?.data['parentItem'], itemKey, '@created 引用必须解析成新条目 key');
    assert.equal(attachment?.data['path']?.toString().endsWith('identified.pdf'), true);

    const snapshot = readFileSync(payload.result.snapshotPath, 'utf8');
    assert.match(snapshot, /@created:0/u, '快照保留占位符，便于回放计划意图');
    assert.match(readFileSync(payload.result.auditPath, 'utf8'), new RegExp(itemKey, 'u'));
    assert.equal(
      fake.requests.filter((request) => request.path === '/api/local/authorize').length,
      1,
      '条目与附件必须共用一次授权',
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
    restore('ZOTERO_MCP_WRITE', previous.write);
    restore('ZOTERO_MCP_AUDIT_DIR', previous.audit);
    restore('ZOTERO_MCP_TITLE_SEARCH', previous.titleSearch);
    rmSync(dir, { recursive: true, force: true });
    rmSync(auditDir, { recursive: true, force: true });
  }
});

test('A9 @created 占位符：缺失时给出可读错误，解析函数按序取 key', () => {
  assert.deepEqual(resolveCreatedRefs({ parentItem: '@created:0' }, ['ITEMKEY']), { parentItem: 'ITEMKEY' });
  assert.deepEqual(resolveCreatedRefs({ title: 'x' }, ['ITEMKEY']), { title: 'x' });
  assert.throws(() => resolveCreatedRefs({ parentItem: '@created:1' }, ['ITEMKEY']), /尚不存在的创建对象/u);
});

test('A6/A8 识别报告：逐级日志、未识别清单与退出码（只读）', async () => {
  const dir = tempDir();
  try {
    const identifiable = join(dir, 'a-identified.pdf');
    writePdf(identifiable, { xmp: xmpPacket({ title: 'Report identified title', creator: 'Report Author' }) });
    const unidentifiable = join(dir, 'b-unknown.pdf');
    writePdf(unidentifiable, {});

    // 关闭 L4 外呼，保证报告用例离线确定性（标题检索另有单测覆盖）
    const env = { ...process.env, ZOTERO_MCP_TITLE_SEARCH: 'off', ZOTERO_MCP_AUDIT_DIR: dir };
    const mixed = await execFileAsync(process.execPath, [REPORT_SCRIPT, dir], { cwd: ROOT, env }).catch(
      (error) => error,
    );
    assert.equal(mixed.code, 1, '存在未识别项时退出码应为 1');
    assert.match(String(mixed.stdout), /\[命中\] L2/u);
    assert.match(String(mixed.stdout), /未识别清单/u);
    assert.match(String(mixed.stdout), /b-unknown\.pdf/u);
    assert.match(String(mixed.stdout), /已识别 1 \/ 未识别 1/u);

    const onlyIdentified = await execFileAsync(process.execPath, [REPORT_SCRIPT, identifiable], { cwd: ROOT, env });
    assert.match(onlyIdentified.stdout, /已识别 1 \/ 未识别 0/u);
    assert.equal(onlyIdentified.code ?? 0, 0);

    const noInput = await execFileAsync(process.execPath, [REPORT_SCRIPT], { cwd: ROOT, env }).catch((error) => error);
    assert.equal(noInput.code, 1, '没有输入时应以非 0 退出码提示用法');
    const allowed = await execFileAsync(process.execPath, [REPORT_SCRIPT, '--allow-missing'], { cwd: ROOT, env });
    assert.equal(allowed.code ?? 0, 0);
    assert.ok(!existsSync(join(dir, 'audit.jsonl')), '报告不得产生审计文件');
    assert.ok(!existsSync(join(dir, 'snapshots')), '报告不得产生快照目录');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A10 探针区分「服务可达」与「解析可用」', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.method === 'GET') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"boom"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;
  try {
    const probe = await probeTranslationServer({ baseUrl: url, timeoutMs: 2000 });
    assert.equal(probe.serverReachable, true, 'GET 有响应（404 也算）即服务可达');
    assert.equal(probe.serverStatus, 404);
    assert.equal(probe.resolveAvailable, false);
    assert.equal(probe.reachable, false, '解析不可用时通道整体不可用');
    assert.equal(requests[0]?.method, 'GET', '可达性探测必须只发 GET');

    const output = await execFileAsync(process.execPath, [PROBE_SCRIPT, '--allow-missing'], {
      cwd: ROOT,
      env: { ...process.env, ZOTERO_MCP_TRANSLATION_SERVER: url },
    });
    assert.match(output.stdout, /服务可达：是（HTTP 404）/u);
    assert.match(output.stdout, /解析可用：否/u);
    assert.match(output.stdout, /服务是活的，但解析不可用/u);
    assert.equal(output.code ?? 0, 0);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('A10 写管线的 @created 占位符在真实提交中生效（两次创建共用一次授权）', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const auditDir = tempDir();
  const previousWrite = process.env['ZOTERO_MCP_WRITE'];
  process.env['ZOTERO_MCP_WRITE'] = 'on';
  try {
    const plan = makeChangePlan({
      targetKeys: [],
      changes: [],
      operations: [
        { kind: 'create', itemType: 'journalArticle', fields: { title: 'Parent item' } },
        {
          kind: 'create',
          itemType: 'attachment',
          fields: { linkMode: 'linked_file', path: 'D:/tmp/x.pdf', title: 'x.pdf', parentItem: '@created:0' },
        },
      ],
      summary: '条目 + 附件',
    });
    const result = await applyPlan(plan, {
      baseUrl: fake.url,
      auditDir,
      write: true,
      authorizeImpl: async () => FAKE_AUTHORIZE_KEY,
    });
    assert.deepEqual(
      result.operations.map((operation) => operation.status),
      ['applied', 'applied'],
    );
    const [parent, attachment] = await getItems({ baseUrl: fake.url, keys: result.createdKeys });
    assert.equal(attachment?.data['parentItem'], parent?.key);
    assert.equal(result.authorizeCount, 1, '两次创建必须共用一次授权');
  } finally {
    await fake.close();
    if (previousWrite === undefined) delete process.env['ZOTERO_MCP_WRITE'];
    else process.env['ZOTERO_MCP_WRITE'] = previousWrite;
    rmSync(auditDir, { recursive: true, force: true });
  }
});
