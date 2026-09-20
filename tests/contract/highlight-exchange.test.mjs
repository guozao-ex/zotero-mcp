/**
 * 「可导入的高亮清单」（Citavi 交换格式）契约测试 —— 路线图 G2 的桥。
 *
 * 核心思路：**在测试里复刻 Zotero 上游 `chrome/content/zotero/import/citavi.js` 的读取逻辑**，
 * 用它去读我们生成的 XML。这样断言的不是「我们的 XML 长什么样」，而是「上游能不能按它的方式读出来」——
 * 包括 `Version=6` 的 JSON Address、1-based PageIndex、EntityLink 方向、批注与正文的字段归属。
 *
 * 另覆盖：无坐标注释如实跳过、附件拿不到本地文件路径时拒绝、outPath 不覆盖、全程只读。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { buildCitaviAnnotationExchange, exportItems, toQuotationType } from '../../packages/core/src/index.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'export-citavi.mjs');
const execFileAsync = promisify(execFile);

const LIBRARY = {
  items: [
    {
      key: 'ITEM0001',
      version: 1,
      data: { itemType: 'journalArticle', title: 'Bridge source', date: '2020', DOI: '10.1000/bridge', collections: [], tags: [] },
    },
  ],
  children: {
    ITEM0001: [
      {
        key: 'ATT00001',
        version: 1,
        data: {
          itemType: 'attachment',
          contentType: 'application/pdf',
          title: 'PDF',
          linkMode: 'imported_url',
          parentItem: 'ITEM0001',
        },
      },
    ],
    ATT00001: [
      {
        key: 'ANNO0001',
        version: 1,
        data: {
          itemType: 'annotation',
          annotationType: 'highlight',
          annotationText: 'quoted text',
          annotationComment: 'my comment',
          annotationColor: '#ffd400',
          annotationPageLabel: '3',
          annotationPosition: '{"pageIndex":2,"rects":[[10,20,110,40],[10,45,90,60]]}',
          parentItem: 'ATT00001',
        },
      },
      {
        key: 'ANNO0002',
        version: 1,
        data: {
          itemType: 'annotation',
          annotationType: 'highlight',
          annotationText: 'no position',
          annotationComment: '',
          annotationColor: '#ff6666',
          annotationPageLabel: '5',
          parentItem: 'ATT00001',
        },
      },
    ],
  },
};

/**
 * 复刻上游 citavi.js 的读取路径（只保留它真正用到的 xpath 与解析步骤）。
 * 返回它会给 `Zotero.Annotations.saveFromJSON` 的注释列表。
 */
function readLikeZoteroCitaviImporter(xml) {
  // 只支持上游真正用到的取值方式：按标签+可选属性筛块，再取块内子标签文本
  const all = (tag, attr, value) => {
    // 注意 `<Reference(?=[ >])`：否则会把容器标签 `<References>` 也算进来
    const blocks = [...xml.matchAll(new RegExp(`<${tag}(?=[ >])([^>]*)>([\\s\\S]*?)</${tag}>`, 'gu'))];
    return blocks
      .map((match) => ({ attrs: match[1], inner: match[2] }))
      .filter((block) => (attr === null ? true : new RegExp(`${attr}="${value}"`, 'u').test(block.attrs)));
  };
  const inner = (block, tag) => {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'u').exec(block.inner);
    return match === null ? null : match[1];
  };
  const unescape = (text) =>
    text
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&amp;', '&');

  // ① Version
  const version = /<CitaviExchangeData Version="([^"]*)"/u.exec(xml)?.[1] ?? null;
  assert.equal(version, '6', '上游用 Version 决定 Quads 与 Address 的解析方式');
  const isCitavi5 = version.startsWith('5');

  // ② detectImport：前 1000 字符里必须出现根标签
  assert.ok(xml.slice(0, 1000).includes('<CitaviExchangeData'), 'detectImport 只读前 1000 字符');

  // ③ References
  const references = all('Reference', null, null);
  assert.ok(references.length > 0, '至少要有一个 Reference');

  const results = [];
  for (const annotationBlock of all('Annotation', null, null)) {
    const annotationId = /id="([^"]*)"/u.exec(annotationBlock.attrs)?.[1] ?? null;
    const locationId = unescape(inner(annotationBlock, 'LocationID') ?? '');
    // ④ Location → ReferenceID
    const location = all('Location', 'id', locationId)[0];
    assert.ok(location, `注释 ${annotationId} 的 LocationID 必须能查到 Location`);
    const referenceId = unescape(inner(location, 'ReferenceID') ?? '');
    const reference = all('Reference', 'id', referenceId)[0];
    assert.ok(reference, `Location 的 ReferenceID（${referenceId}）必须能查到 Reference`);

    // ⑤ Address：Version≠5 时上游 JSON.parse 取 UriString
    const addressRaw = unescape(inner(location, 'Address') ?? '');
    const address = isCitavi5 ? addressRaw : JSON.parse(addressRaw).UriString;
    assert.ok(typeof address === 'string' && address.length > 0, 'Address 必须给出 PDF 路径');

    // ⑥ Quads：Version≠5 时 JSON.parse；PageIndex 由上游 -1 还原
    const quadsRaw = unescape(inner(annotationBlock, 'Quads') ?? '');
    const quads = isCitavi5 ? null : JSON.parse(quadsRaw);
    assert.ok(Array.isArray(quads) && quads.length > 0, 'Quads 必须是非空 JSON 数组');
    for (const quad of quads) {
      for (const field of ['PageIndex', 'IsContainer', 'X1', 'Y1', 'X2', 'Y2']) {
        assert.ok(field in quad, `quad 缺字段 ${field}`);
      }
    }
    const pageIndex = Number.parseInt(String(quads[0].PageIndex), 10) - 1;

    // ⑦ EntityLink：TargetID=注释 id → SourceID=知识项 id
    const link = all('EntityLink', null, null).find((block) => unescape(inner(block, 'TargetID') ?? '') === annotationId);
    assert.ok(link, `注释 ${annotationId} 必须有指向它的 EntityLink`);
    const knowledgeId = unescape(inner(link, 'SourceID') ?? '');
    const knowledge = all('KnowledgeItem', 'id', knowledgeId)[0];
    assert.ok(knowledge, `EntityLink 的 SourceID（${knowledgeId}）必须能查到 KnowledgeItem`);

    results.push({
      annotationId,
      referenceId,
      pdfPath: address,
      pageIndex,
      rects: quads.map((quad) => [quad.X1, quad.Y1, quad.X2, quad.Y2]),
      text: unescape(inner(knowledge, 'Text') ?? ''),
      comment: unescape(inner(knowledge, 'CoreStatement') ?? ''),
      quotationType: unescape(inner(knowledge, 'QuotationType') ?? ''),
    });
  }
  return results;
}

test('G2 桥：生成的 Citavi 交换 XML 能被上游读取逻辑逐条还原', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: LIBRARY, filePath: 'C:/fake/storage/ATT00001/paper.pdf' });
  try {
    const exchange = await buildCitaviAnnotationExchange({ baseUrl: fake.url, keys: ['ITEM0001'] });
    assert.equal(exchange.entries.length, 1);
    assert.equal(exchange.annotationTotal, 1, '只有带坐标的那条注释可导出');
    assert.equal(exchange.skipped.length, 1, '没有坐标的注释必须被跳过');
    assert.match(exchange.skipped[0].reason, /坐标|rects|position/u);

    const restored = readLikeZoteroCitaviImporter(exchange.xml);
    assert.equal(restored.length, 1);
    assert.equal(restored[0].referenceId, exchange.entries[0].referenceId);
    assert.equal(restored[0].pdfPath, 'C:/fake/storage/ATT00001/paper.pdf', 'Address 必须是真实 PDF 路径（JSON UriString）');
    assert.equal(restored[0].pageIndex, 2, 'PageIndex 供上游 1-based→0-based 还原，必须等于源 pageIndex+1 再 -1');
    assert.deepEqual(restored[0].rects, [
      [10, 20, 110, 40],
      [10, 45, 90, 60],
    ], 'rects 必须逐值一致');
    assert.equal(restored[0].text, 'quoted text');
    assert.equal(restored[0].comment, 'my comment');
    // 黄色高亮（#ffd400）在 Citavi 里本应落到 5（黄）——但 5/6 会**丢弃批注**，所以有批注时
    // 必须换成保留批注的类型 1–4；这里取其中最接近原色的 4（橙）。断言只看「是否保留批注」这一类。
    assert.ok(['1', '2', '3', '4'].includes(restored[0].quotationType), `有批注时必须用保留批注的类型，实际 ${restored[0].quotationType}`);
    assert.notEqual(restored[0].comment, '', '批注必须随 QuotationType 的选择一起保留下来');

    // 只读
    assert.deepEqual(fake.requests.filter((request) => request.method !== 'GET'), []);
  } finally {
    await fake.close();
  }
});

test('G2 桥：zotero_export(format=citavi) 缺数据必须拒绝、逐条给原因、不覆盖', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: LIBRARY, filePath: 'C:/fake/storage/ATT00001/paper.pdf' });
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-citavi-'));
  try {
    const outPath = join(dir, 'highlights.xml');
    const written = await exportItems({ baseUrl: fake.url, keys: ['ITEM0001'], format: 'citavi', outPath });
    assert.equal(written.format, 'citavi');
    assert.equal(written.count, 1);
    assert.equal(existsSync(outPath), true);
    assert.ok(readFileSync(outPath, 'utf8').includes('<CitaviExchangeData Version="6">'));
    // 逐条原因必须随工具面结果返回（无坐标的那条注释）
    assert.equal(Array.isArray(written.annotationIssues), true, '工具面必须带逐条问题清单');
    assert.equal(written.annotationIssues.length, 1);
    assert.equal(written.annotationIssues[0].id, 'ANNO0002');
    assert.match(written.annotationIssues[0].reason, /rects|坐标/u);
    assert.deepEqual(written.annotationSummary, [{ itemKey: 'ITEM0001', attachmentKey: 'ATT00001', annotationCount: 1 }]);

    // 未加 overwrite：拒绝覆盖
    await assert.rejects(
      () => exportItems({ baseUrl: fake.url, keys: ['ITEM0001'], format: 'citavi', outPath }),
      /已存在/u,
    );

    // 条目没有任何 PDF 附件：必须拒绝、给出可读原因、且**不得**写出文件
    const bare = {
      items: [{ key: 'ITEM0009', version: 1, data: { itemType: 'journalArticle', title: 'No attachment', date: '2020', collections: [], tags: [] } }],
      children: { ITEM0009: [] },
    };
    const fakeNoFile = await startFakeZotero({ mode: 'ok', port: 0, library: bare });
    const bareOut = join(dir, 'bare.xml');
    try {
      await assert.rejects(
        () => exportItems({ baseUrl: fakeNoFile.url, keys: ['ITEM0009'], format: 'citavi', outPath: bareOut }),
        /没有 PDF 附件/u,
      );
      assert.equal(existsSync(bareOut), false, '拒绝时不得写出任何文件（更不得写出空骨架 XML）');
    } finally {
      await fakeNoFile.close();
    }

    // 附件有注释但拿不到本地文件路径：同样拒绝
    const fakeNoPath = await startFakeZotero({ mode: 'ok', port: 0, library: LIBRARY, filePath: null });
    const noPathOut = join(dir, 'nopath.xml');
    try {
      await assert.rejects(
        () => exportItems({ baseUrl: fakeNoPath.url, keys: ['ITEM0001'], format: 'citavi', outPath: noPathOut }),
        /无法导出|本地文件路径|file is not available/u,
      );
      assert.equal(existsSync(noPathOut), false);
    } finally {
      await fakeNoPath.close();
    }
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G2 桥：非 highlight 注释与批注颜色都如实报告（类型不被通道保留 / 不用会交换正文批注的类型 2）', async () => {
  const library = JSON.parse(JSON.stringify(LIBRARY));
  const target = library.children['ATT00001'].find((entry) => entry.key === 'ANNO0001');
  target.data.annotationType = 'underline';
  target.data.annotationComment = 'a comment';
  target.data.annotationColor = '#a6507b';
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library, filePath: 'C:/fake/storage/ATT00001/paper.pdf' });
  try {
    const exchange = await buildCitaviAnnotationExchange({ baseUrl: fake.url, keys: ['ITEM0001'] });
    // 洋红 + 批注：绝不能选 2（上游会把正文与批注互换）
    assert.notEqual(toQuotationType({ annotationType: 'underline', comment: 'a comment', color: '#a6507b' }), 2);
    assert.equal(exchange.xml.includes('<QuotationType>2</QuotationType>'), false, '不得产出会交换正文批注的类型 2');
    const restored = readLikeZoteroCitaviImporter(exchange.xml);
    assert.equal(restored[0].text, 'quoted text', '正文必须仍在 Text');
    assert.equal(restored[0].comment, 'a comment', '批注必须仍在 CoreStatement');
    // 类型不被保留：必须有逐条提示
    const notice = exchange.issues.find((issue) => issue.kind === 'type-not-preserved');
    assert.ok(notice, '非 highlight 注释必须逐条提示类型会变');
    assert.match(notice.reason, /underline/u);
  } finally {
    await fake.close();
  }
});

test('G2 桥：传附件 key 也能导出（与条目 key 等价）', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library: LIBRARY, filePath: 'C:/fake/storage/ATT00001/paper.pdf' });
  try {
    const viaItem = await buildCitaviAnnotationExchange({ baseUrl: fake.url, keys: ['ITEM0001'] });
    const viaAttachment = await buildCitaviAnnotationExchange({ baseUrl: fake.url, keys: ['ATT00001'] });
    assert.equal(viaAttachment.entries.length, 1, '传附件 key 必须能导出');
    assert.equal(viaAttachment.entries[0].attachmentKey, 'ATT00001');
    assert.equal(viaAttachment.annotationTotal, viaItem.annotationTotal);
    assert.equal(viaAttachment.rejected.length, 0);
    // 附件 key 的注释同样走带 itemType=annotation 的过滤查询
    assert.ok(
      fake.requests.some((request) => request.url.includes('/items/ATT00001/children') && request.url.includes('itemType=annotation')),
    );
  } finally {
    await fake.close();
  }
});

test('G2 桥：CLI 产出文件并打印导入指引', async () => {
  const library = JSON.parse(JSON.stringify(LIBRARY));
  library.children['ATT00001'].find((entry) => entry.key === 'ANNO0001').data.annotationType = 'underline';
  const fake = await startFakeZotero({ mode: 'ok', port: 0, library, filePath: 'C:/fake/storage/ATT00001/paper.pdf' });
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-citavi-cli-'));
  const outPath = join(dir, 'cli.xml');
  const previous = process.env['ZOTERO_MCP_BASE_URL'];
  process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
  try {
    const result = await execFileAsync(process.execPath, [SCRIPT, '--item', 'ITEM0001', '--out', outPath], { cwd: ROOT });
    assert.match(result.stdout, /已导出可导入的高亮清单/u);
    assert.match(result.stdout, /文件\(File\) → 导入\(Import\)/u);
    assert.match(result.stdout, /新建一条条目/u, '必须如实提示「导入会新建条目」');
    // 类型不被保留的提示必须打到 stderr（不能静默）
    assert.match(result.stderr, /类型会变/u, 'CLI 必须逐条提示「类型不被 Citavi 通道保留」');
    assert.equal(existsSync(outPath), true);

    // 已存在且未加 --overwrite：拒绝
    const again = await execFileAsync(process.execPath, [SCRIPT, '--item', 'ITEM0001', '--out', outPath], { cwd: ROOT }).then(
      () => ({ code: 0 }),
      (error) => ({ code: typeof error.code === 'number' ? error.code : -1 }),
    );
    assert.notEqual(again.code, 0);
  } finally {
    if (previous === undefined) delete process.env['ZOTERO_MCP_BASE_URL'];
    else process.env['ZOTERO_MCP_BASE_URL'] = previous;
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
