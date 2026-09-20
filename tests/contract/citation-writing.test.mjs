/**
 * 引用写作集成契约测试（M6）。
 *
 * 覆盖：最小 ZIP 往返与「除目标条目外逐字节保留」、占位符扫描与映射解析、
 * 域代码 XML 形态与 `uris` / `itemData` 来源、参考文献块位置、默认只读与备份约定、
 * 四条降级路径、零写请求、工具面计数，以及 `.bib` 真编译与无 Word 工具的往返。
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  DOCUMENT_PART,
  buildBibliographyCode,
  buildCitationCode,
  buildMinimalDocx,
  citationUri,
  compileBibSample,
  createZip,
  detectLatexEnvironmentIssue,
  findPlaceholders,
  htmlToPlainText,
  injectCitations,
  injectFields,
  joinCitationTexts,
  normalizeMapping,
  readZip,
  replaceEntry,
  resolveLatex,
  resolvePlaceholder,
  scanParagraphRuns,
  writeZip,
} from '../../packages/core/src/index.ts';
import { ALL_TOOLS, GATED_TOOL_NAME_SET, TOOL_NAMES } from '../../packages/mcp-server/src/tools.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

/** 假服务器返回的 csljson 输出（断言 `itemData` 逐字来自它）。 */
async function cslJsonOf(fake, key) {
  const response = await fetch(`${fake.url}/api/users/0/items/${key}?format=csljson`);
  const body = await response.json();
  return Array.isArray(body) ? body[0] : body;
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 从 `word/document.xml` 里取出所有域代码文本（`w:instrText` 的内容）。 */
function fieldCodes(documentXml) {
  const codes = [];
  const pattern = /<w:instrText[^>]*>([\s\S]*?)<\/w:instrText>/gu;
  let match;
  while ((match = pattern.exec(documentXml)) !== null) codes.push(match[1]);
  return codes;
}

function decodeEntities(value) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

/** 造一份只含占位符段落的最小 .docx（用于注入前的既有文档场景）。 */
function docxWithPlaceholders(placeholders) {
  const paragraphs = placeholders
    .map((placeholder) => `<w:p><w:r><w:t xml:space="preserve">${placeholder}</w:t></w:r></w:p>`)
    .join('');
  return createZip([
    { name: '[Content_Types].xml', content: '<Types/>' },
    {
      name: DOCUMENT_PART,
      content: `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${paragraphs}</w:body></w:document>`,
    },
  ]);
}

test('最小 ZIP：往返、逐字节保留与条目集合不减少', () => {
  const original = createZip([
    { name: 'a.txt', content: 'alpha' },
    { name: 'b.txt', content: 'beta'.repeat(50) },
    { name: 'c.bin', content: Buffer.from([0, 1, 2, 3, 4, 5]) },
  ]);
  const archive = readZip(original);
  assert.deepEqual(
    archive.entries.map((entry) => entry.name),
    ['a.txt', 'b.txt', 'c.bin'],
  );
  assert.equal(archive.entries[1].data.toString('utf8'), 'beta'.repeat(50));

  const before = new Map(archive.entries.map((entry) => [entry.name, entry.raw]));
  const repacked = writeZip(replaceEntry(archive, 'a.txt', Buffer.from('ALPHA-CHANGED')));
  const after = readZip(repacked);
  assert.deepEqual(
    after.entries.map((entry) => entry.name),
    ['a.txt', 'b.txt', 'c.bin'],
  );
  assert.equal(after.entries[0].data.toString('utf8'), 'ALPHA-CHANGED');
  // 未改动条目的本地记录（含压缩字节）必须逐字节相同
  for (const entry of after.entries) {
    if (entry.name === 'a.txt') continue;
    assert.deepEqual(entry.raw, before.get(entry.name), `${entry.name} 应逐字节保留`);
  }

  // 守卫可证伪：换一份内容不同但同名的归档，raw 必须不同
  const other = readZip(createZip([{ name: 'b.txt', content: 'gamma'.repeat(50) }]));
  assert.notDeepEqual(other.entries[0].raw, before.get('b.txt'));
});

test('占位符扫描按段落定位且区分内联 key 与命名映射', () => {
  const docx = buildMinimalDocx({ title: 'T', placeholders: ['{{zotero:ref1}}', '{{zotero:ABC12345,XYZ98765}}'] });
  const xml = readZip(docx).entries.find((entry) => entry.name === DOCUMENT_PART).data.toString('utf8');
  const hits = findPlaceholders(xml);
  assert.deepEqual(
    hits.map((hit) => [hit.name, hit.paragraph, hit.offset]),
    [
      ['ref1', 1, 0],
      ['ABC12345,XYZ98765', 2, 0],
    ],
  );

  const mapping = normalizeMapping({ ref1: ['ITEM0001', 'ITEM0003'], ref2: { keys: ['ITEM0002'], locator: '12', label: 'page' } });
  assert.deepEqual(resolvePlaceholder('ref1', mapping)?.entry.keys, ['ITEM0001', 'ITEM0003']);
  assert.equal(resolvePlaceholder('ref1', mapping)?.source, 'mapping');
  assert.deepEqual(resolvePlaceholder('ABC12345,XYZ98765', mapping)?.entry.keys, ['ABC12345', 'XYZ98765']);
  assert.equal(resolvePlaceholder('ABC12345,XYZ98765', mapping)?.source, 'inline');
  assert.deepEqual(resolvePlaceholder('UNKNOWN99', mapping)?.entry.keys, ['UNKNOWN99']);
  assert.equal(resolvePlaceholder('ref2', mapping)?.entry.locator, '12');
  // 映射优先于同名内联 key
  const shadowed = normalizeMapping({ ABC12345: ['MAPPED001'] });
  assert.deepEqual(resolvePlaceholder('ABC12345', shadowed)?.entry.keys, ['MAPPED001']);
});

test('占位符被拆到多个 run 时仍能整体替换并保留其余文本', () => {
  const xml =
    '<?xml version="1.0"?><w:document xmlns:w="x"><w:body><w:p>' +
    '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">前文 {{zot</w:t></w:r>' +
    '<w:r><w:t xml:space="preserve">ero:ref1}} 后文</w:t></w:r>' +
    '</w:p></w:body></w:document>';
  const runs = scanParagraphRuns(xml.slice(xml.indexOf('<w:p>'), xml.indexOf('</w:p>') + 6));
  assert.equal(runs.length, 2);
  assert.equal(runs[0].text, '前文 {{zot');
  assert.equal(runs[0].rPr, '<w:rPr><w:b/></w:rPr>');

  const outcome = injectFields(xml, {
    fields: new Map([['ref1', { code: ' ADDIN ZOTERO_ITEM CSL_CITATION {} ', resultText: '(A 2020)' }]]),
  });
  assert.deepEqual(outcome.errors, []);
  assert.equal(outcome.applied.length, 1);
  assert.equal(outcome.applied[0].name, 'ref1');
  assert.equal((outcome.xml.match(/<w:fldChar w:fldCharType="begin"\/>/gu) ?? []).length, 1);
  assert.ok(outcome.xml.includes('前文 '), '前缀文本保留');
  assert.ok(outcome.xml.includes(' 后文'), '后缀文本保留');
  assert.ok(!outcome.xml.includes('{{zot'), '占位符不再出现');
  assert.ok(outcome.xml.includes('<w:rPr><w:b/></w:rPr>'), '未受影响的 rPr 被复用');
});

test('注入只改 word/document.xml，其余条目逐字节保留', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const dir = tempDir('zotero-mcp-cw-');
  try {
    const docxPath = join(dir, 'sample.docx');
    // 先造一份带额外条目的文档，验证其它条目被整段复制
    const minimal = readZip(buildMinimalDocx({ title: 'T', placeholders: ['{{zotero:ref1}}', '{{zotero:bibliography}}'] }));
    const documentXml = minimal.entries.find((entry) => entry.name === DOCUMENT_PART).data.toString('utf8');
    const withExtra = writeZip({
      entries: [
        ...minimal.entries,
        {
          name: 'word/styles.xml',
          method: 8,
          flags: 0,
          crc: 0,
          compressedSize: 0,
          uncompressedSize: 0,
          versionMadeBy: 20,
          versionNeeded: 20,
          modTime: 0,
          modDate: 0,
          internalAttributes: 0,
          externalAttributes: 0,
          raw: null,
          data: Buffer.from('<w:styles xmlns:w="x"/>', 'utf8'),
        },
      ],
      comment: Buffer.alloc(0),
    });
    writeFileSync(docxPath, withExtra);

    const before = readZip(readFileSync(docxPath));
    const beforeRaw = new Map(before.entries.map((entry) => [entry.name, entry.raw]));

    const result = await injectCitations({
      baseUrl: fake.url,
      docxPath,
      mapping: { ref1: ['ITEM0001'] },
      dryRun: false,
    });
    assert.equal(result.injected, true, result.reason ?? '');
    assert.equal(result.created, false);

    const after = readZip(readFileSync(docxPath));
    assert.deepEqual(
      after.entries.map((entry) => entry.name),
      before.entries.map((entry) => entry.name),
    );
    for (const entry of after.entries) {
      if (entry.name === DOCUMENT_PART) continue;
      assert.deepEqual(entry.raw, beforeRaw.get(entry.name), `${entry.name} 应逐字节保留`);
    }
    // 文档 XML 本身除占位符替换外不变：标题段落仍在
    assert.ok(after.entries.find((entry) => entry.name === DOCUMENT_PART).data.toString('utf8').includes('>T</w:t>'));
    assert.equal(documentXml.includes('x'), true);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('域代码形态：三段 fldChar、uris、itemData 与唯一 citationID', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const dir = tempDir('zotero-mcp-cw-');
  try {
    const docxPath = join(dir, 'sample.docx');
    const result = await injectCitations({
      baseUrl: fake.url,
      docxPath,
      mapping: {
        a: ['ITEM0001'],
        b: ['ITEM0001', 'ITEM0003'],
      },
      dryRun: false,
    });
    assert.equal(result.injected, true, result.reason ?? '');
    const xml = readZip(readFileSync(docxPath)).entries.find((entry) => entry.name === DOCUMENT_PART).data.toString('utf8');

    assert.equal((xml.match(/w:fldCharType="begin"/gu) ?? []).length, 3, '两处引用 + 一处参考文献块');
    assert.equal((xml.match(/w:fldCharType="separate"/gu) ?? []).length, 3);
    assert.equal((xml.match(/w:fldCharType="end"/gu) ?? []).length, 3);

    const codes = fieldCodes(xml).map(decodeEntities);
    const citationCodes = codes.filter((code) => code.includes('ADDIN ZOTERO_ITEM CSL_CITATION'));
    const biblioCodes = codes.filter((code) => code.includes('ADDIN ZOTERO_BIBL'));
    assert.equal(citationCodes.length, 2);
    assert.equal(biblioCodes.length, 1);

    const ids = new Set();
    for (const code of citationCodes) {
      assert.match(code, /^ ADDIN ZOTERO_ITEM CSL_CITATION \{/u);
      assert.match(code, /\} $/u);
      const json = JSON.parse(code.slice(' ADDIN ZOTERO_ITEM CSL_CITATION '.length, -1));
      assert.equal(typeof json.citationID, 'string');
      assert.ok(json.citationID.length > 0);
      ids.add(json.citationID);
      assert.equal(typeof json.properties.formattedCitation, 'string');
      assert.equal(typeof json.properties.plainCitation, 'string');
      assert.equal(json.schema, 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json');
      for (const item of json.citationItems) {
        assert.deepEqual(item.uris, [`http://zotero.org/users/0/items/${item.id}`]);
        assert.deepEqual(item.itemData, await cslJsonOf(fake, item.id));
      }
    }
    assert.equal(ids.size, 2, 'citationID 必须唯一');

    const biblio = JSON.parse(biblioCodes[0].slice(' ADDIN ZOTERO_BIBL '.length, -' CSL_BIBLIOGRAPHY '.length));
    assert.deepEqual(biblio, { uncited: [], omitted: [], custom: [] });
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mapping 的额外引用字段逐字透传，参考文献块缺占位符时落在文末', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const dir = tempDir('zotero-mcp-cw-');
  try {
    // 手工造一个只有引用占位符、没有参考文献块占位符的文档
    const docxPath = join(dir, 'no-biblio.docx');
    writeFileSync(
      docxPath,
      createZip([
        { name: '[Content_Types].xml', content: '<Types/>' },
        {
          name: DOCUMENT_PART,
          content:
            '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
            '<w:p><w:r><w:t xml:space="preserve">{{zotero:ref1}}</w:t></w:r></w:p>' +
            '<w:sectPr/></w:body></w:document>',
        },
      ]),
    );
    const result = await injectCitations({
      baseUrl: fake.url,
      docxPath,
      mapping: {
        ref1: { keys: ['ITEM0001'], locator: '12-14', label: 'page', prefix: 'see ', suffix: ' for details', suppressAuthor: true },
      },
      dryRun: false,
    });
    assert.equal(result.injected, true, result.reason ?? '');
    assert.equal(result.bibliography.mode, 'appended');

    const xml = readZip(readFileSync(docxPath)).entries.find((entry) => entry.name === DOCUMENT_PART).data.toString('utf8');
    const code = decodeEntities(fieldCodes(xml).find((entry) => entry.includes('ADDIN ZOTERO_ITEM')));
    const json = JSON.parse(code.slice(' ADDIN ZOTERO_ITEM CSL_CITATION '.length, -1));
    assert.equal(json.citationItems[0].locator, '12-14');
    assert.equal(json.citationItems[0].label, 'page');
    assert.equal(json.citationItems[0].prefix, 'see ');
    assert.equal(json.citationItems[0].suffix, ' for details');
    assert.equal(json.citationItems[0]['suppress-author'], true);
    // 参考文献块插在文末（sectPr 之前）
    assert.ok(xml.indexOf('ADDIN ZOTERO_BIBL') < xml.indexOf('<w:sectPr/>'));
    assert.equal(result.bibliography.position, null);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('默认只读与备份约定：dryRun 不落盘，原地写回先备份且拒绝重复备份', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const dir = tempDir('zotero-mcp-cw-');
  try {
    const docxPath = join(dir, 'sample.docx');
    const plan = await injectCitations({ baseUrl: fake.url, docxPath, mapping: { ref1: ['ITEM0001'] } });
    assert.equal(plan.injected, true);
    assert.equal(plan.dryRun, true);
    // 成功路径的计划同样带位置（与拒绝路径同一份数据源，守卫可证伪）
    assert.deepEqual(
      plan.citations.map((entry) => [entry.name, entry.paragraph, entry.offset]),
      [['ref1', 1, 0]],
    );
    // 新建的最小文档除引用占位符外还带参考文献块占位符，两者都要出现在命中清单里
    assert.deepEqual(plan.placeholderHits, [
      { name: 'ref1', paragraph: 1, offset: 0 },
      { name: 'bibliography', paragraph: 2, offset: 0 },
    ]);
    assert.equal(existsSync(docxPath), false, 'dryRun 不得写入任何文件');

    // 新建文档：没有可备份的原文件
    const applied = await injectCitations({ baseUrl: fake.url, docxPath, mapping: { ref1: ['ITEM0001'] }, dryRun: false });
    assert.equal(applied.injected, true, applied.reason ?? '');
    assert.equal(applied.created, true);
    assert.equal(applied.backupPath, null, '新建文档没有可备份的原文件');
    assert.equal(existsSync(`${docxPath}.bak`), false);

    // 已有文档原地写回：必须先留下写前备份
    const existing = join(dir, 'existing.docx');
    writeFileSync(existing, docxWithPlaceholders(['{{zotero:ref1}}']));
    const beforeBytes = readFileSync(existing);
    const inPlace = await injectCitations({ baseUrl: fake.url, docxPath: existing, mapping: { ref1: ['ITEM0001'] }, dryRun: false });
    assert.equal(inPlace.injected, true, inPlace.reason ?? '');
    assert.equal(inPlace.backupPath, `${existing}.bak`);
    assert.deepEqual(readFileSync(`${existing}.bak`), beforeBytes, '备份必须是写前的内容');
    assert.notDeepEqual(readFileSync(existing), beforeBytes);

    // 备份已存在且未显式 overwrite → 拒绝，且不改动任何文件
    const again = join(dir, 'again.docx');
    writeFileSync(again, docxWithPlaceholders(['{{zotero:ref1}}']));
    writeFileSync(`${again}.bak`, 'sentinel-backup');
    const againBytes = readFileSync(again);
    const refusedBackup = await injectCitations({ baseUrl: fake.url, docxPath: again, mapping: { ref1: ['ITEM0001'] }, dryRun: false });
    assert.equal(refusedBackup.injected, false);
    assert.match(refusedBackup.reason, /备份文件已存在/u);
    assert.deepEqual(readFileSync(again), againBytes);
    assert.equal(readFileSync(`${again}.bak`, 'utf8'), 'sentinel-backup');

    // outPath 指向已存在文件时同样拒绝，除非 overwrite
    const outPath = join(dir, 'out.docx');
    writeFileSync(outPath, 'sentinel');
    const source = join(dir, 'source.docx');
    writeFileSync(source, docxWithPlaceholders(['{{zotero:ref1}}']));
    const refused = await injectCitations({
      baseUrl: fake.url,
      docxPath: source,
      mapping: { ref1: ['ITEM0001'] },
      outPath,
      dryRun: false,
    });
    assert.equal(refused.injected, false);
    assert.match(refused.reason, /已存在/u);
    assert.equal(readFileSync(outPath, 'utf8'), 'sentinel');
    const allowed = await injectCitations({
      baseUrl: fake.url,
      docxPath: source,
      mapping: { ref1: ['ITEM0001'] },
      outPath,
      overwrite: true,
      dryRun: false,
    });
    assert.equal(allowed.injected, true, allowed.reason ?? '');
    assert.notEqual(readFileSync(outPath, 'utf8'), 'sentinel');
    assert.equal(existsSync(`${source}.bak`), false, '显式 outPath 时不动源文件、也不产生备份');
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('占位符命中 0 次或多次时拒绝写入且不改动文件', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const dir = tempDir('zotero-mcp-cw-');
  try {
    // 命中 0 次：mapping 里有 ref2，文档里没有
    const missing = join(dir, 'missing.docx');
    writeFileSync(
      missing,
      createZip([
        {
          name: DOCUMENT_PART,
          content:
            '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
            '<w:p><w:r><w:t xml:space="preserve">{{zotero:ref1}}</w:t></w:r></w:p>' +
            '</w:body></w:document>',
        },
      ]),
    );
    const beforeMissing = readFileSync(missing);
    const zero = await injectCitations({
      baseUrl: fake.url,
      docxPath: missing,
      mapping: { ref1: ['ITEM0001'], ref2: ['ITEM0002'] },
      dryRun: false,
    });
    assert.equal(zero.injected, false);
    assert.match(zero.reason, /ref2 在文档里命中 0 次/u);
    assert.match(zero.reason, /没有任何位置/u);
    assert.deepEqual(zero.placeholderHits.map((hit) => hit.name), ['ref1']);
    assert.deepEqual(readFileSync(missing), beforeMissing);

    // 命中 2 次
    const twice = join(dir, 'twice.docx');
    writeFileSync(
      twice,
      createZip([
        {
          name: DOCUMENT_PART,
          content:
            '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>' +
            '<w:p><w:r><w:t xml:space="preserve">{{zotero:ref1}}</w:t></w:r></w:p>' +
            '<w:p><w:r><w:t xml:space="preserve">{{zotero:ref1}}</w:t></w:r></w:p>' +
            '</w:body></w:document>',
        },
      ]),
    );
    const beforeTwice = readFileSync(twice);
    const duplicated = await injectCitations({
      baseUrl: fake.url,
      docxPath: twice,
      mapping: { ref1: ['ITEM0001'] },
      dryRun: false,
    });
    assert.equal(duplicated.injected, false);
    assert.match(duplicated.reason, /命中 2 次/u);
    // 拒绝原因必须报出**全部命中位置**（段落 + 段内偏移），而不只是次数
    assert.match(duplicated.reason, /段落 0 偏移 0/u);
    assert.match(duplicated.reason, /段落 1 偏移 0/u);
    assert.deepEqual(duplicated.problems.length, 1);
    // 结构化字段同样要给出位置，便于机器消费
    assert.deepEqual(
      duplicated.placeholderHits.map((hit) => [hit.name, hit.paragraph, hit.offset]),
      [
        ['ref1', 0, 0],
        ['ref1', 1, 0],
      ],
    );
    assert.deepEqual(readFileSync(twice), beforeTwice);
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('降级：四种不可注入的输入各自给出不同原因与替代产物，且不写盘', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const dir = tempDir('zotero-mcp-cw-');
  try {
    const missingPath = join(dir, 'nope.docx');
    const noMapping = await injectCitations({ baseUrl: fake.url, docxPath: missingPath, dryRun: false });
    assert.equal(noMapping.injected, false);
    assert.equal(existsSync(missingPath), false);
    assert.deepEqual(noMapping.textExports, { csljson: '', bibtex: '', ris: '' });

    const notZip = join(dir, 'broken.docx');
    writeFileSync(notZip, 'this is not a zip');
    const beforeNotZip = readFileSync(notZip);
    const broken = await injectCitations({
      baseUrl: fake.url,
      docxPath: notZip,
      mapping: { ref1: ['ITEM0001'] },
      dryRun: false,
    });
    assert.equal(broken.injected, false);
    assert.deepEqual(readFileSync(notZip), beforeNotZip);
    assert.ok(broken.textExports.bibtex.includes('@article'), '降级要给出 BibTeX 替代产物');
    assert.ok(broken.textExports.csljson.includes('ITEM0001'), '降级要给出 CSL JSON 替代产物');
    assert.ok(broken.textExports.ris.includes('TY  - '), '降级要给出 RIS 替代产物');

    const noDocument = join(dir, 'nodoc.docx');
    writeFileSync(noDocument, createZip([{ name: 'hello.txt', content: 'hi' }]));
    const beforeNoDoc = readFileSync(noDocument);
    const missingPart = await injectCitations({
      baseUrl: fake.url,
      docxPath: noDocument,
      mapping: { ref1: ['ITEM0001'] },
      dryRun: false,
    });
    assert.equal(missingPart.injected, false);
    assert.match(missingPart.reason, /word\/document\.xml/u);
    assert.deepEqual(readFileSync(noDocument), beforeNoDoc);

    const unknownItem = join(dir, 'unknown.docx');
    const unknown = await injectCitations({
      baseUrl: fake.url,
      docxPath: unknownItem,
      mapping: { ref1: ['NOSUCHKEY'] },
      dryRun: false,
    });
    assert.equal(unknown.injected, false);
    assert.match(unknown.reason, /NOSUCHKEY/u);
    assert.equal(existsSync(`${unknownItem}.bak`), false);

    const reasons = new Set([noMapping.reason, broken.reason, missingPart.reason, unknown.reason]);
    assert.equal(reasons.size, 4, '四种失败原因必须互不相同');
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('注入全过程对本地 API 只发 GET（零写请求）', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const dir = tempDir('zotero-mcp-cw-');
  try {
    const docxPath = join(dir, 'sample.docx');
    const result = await injectCitations({
      baseUrl: fake.url,
      docxPath,
      mapping: { ref1: ['ITEM0001', 'ITEM0003'] },
      dryRun: false,
    });
    assert.equal(result.injected, true, result.reason ?? '');
    const writes = fake.requests.filter((entry) => entry.method !== 'GET');
    assert.deepEqual(writes, [], '不得产生任何非 GET 请求');
    assert.ok(fake.requests.length > 0, '应当真的访问了本地 API');
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('域结果文本合并与 HTML 转纯文本', () => {
  // 真机 citeproc 输出用数字字符引用写 `&`（`&#38;`），必须与命名实体一起解码
  assert.equal(htmlToPlainText('(Junge &#38; Swanson, 2007)'), '(Junge & Swanson, 2007)');
  assert.equal(htmlToPlainText('<i>Dairy Science &amp; Technology</i>'), 'Dairy Science & Technology');
  assert.equal(htmlToPlainText('&#8217;x&#8217;'), '’x’');
  assert.equal(htmlToPlainText('literal &amp;#38; stays'), 'literal &#38; stays', '已转义的实体不得被二次解码');
  assert.equal(htmlToPlainText(['<ol>', '<li>A</li>', '<li>B</li>', '</ol>'].join(String.fromCharCode(10))), 'A B');
  assert.equal(joinCitationTexts(['(Author, 2021)']), '(Author, 2021)');
  assert.equal(joinCitationTexts(['(Author, 2021)', '(Edit Or, 1999)']), '(Author, 2021; Edit Or, 1999)');
  assert.equal(joinCitationTexts([]), '');
  assert.equal(citationUri('ITEM0001'), 'http://zotero.org/users/0/items/ITEM0001');
  assert.equal(buildBibliographyCode(), ' ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY ');
  const code = buildCitationCode({ citationId: 'abc', items: [{ key: 'K1', itemData: { id: 'K1', type: 'book' } }], formattedCitation: '(A 2020)' });
  assert.match(code, /^ ADDIN ZOTERO_ITEM CSL_CITATION \{/u);
  assert.match(code, /\} $/u);
  assert.ok(!code.includes('&'), '域代码本身不含需要转义的字符（转义发生在写 XML 时）');
});

test('无 Word 依赖：注入后的 .docx 仍可被 LibreOffice 打开', async (t) => {
  const soffice = join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe');
  if (!existsSync(soffice)) {
    t.skip('本机没有 LibreOffice，跳过无 Word 工具往返');
    return;
  }
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const dir = tempDir('zotero-mcp-cw-');
  try {
    const docxPath = join(dir, 'sample.docx');
    const result = await injectCitations({
      baseUrl: fake.url,
      docxPath,
      mapping: { ref1: ['ITEM0001'] },
      dryRun: false,
    });
    assert.equal(result.injected, true, result.reason ?? '');
    const outDir = join(dir, 'txt');
    mkdirSync(outDir, { recursive: true });
    const converted = spawnSync(soffice, ['--headless', '--convert-to', 'txt:Text', '--outdir', outDir, docxPath], {
      encoding: 'utf8',
      timeout: 180000,
    });
    assert.equal(converted.status, 0, `LibreOffice 转换失败：${converted.stdout ?? ''}${converted.stderr ?? ''}`);
    const textPath = join(outDir, 'sample.txt');
    assert.equal(existsSync(textPath), true, 'LibreOffice 应产出文本');
    const text = readFileSync(textPath, 'utf8');
    assert.ok(text.includes('(Author, 2021)'), '域结果文本应可在无 Word 的工具里读到');
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('.bib 真编译：latexmk 能编译含 \\cite 的最小文档', async (t) => {
  const latex = resolveLatex();
  if (!latex.available) {
    t.skip(`本机没有可用的 MiKTeX（${latex.reason}），跳过真编译`);
    return;
  }
  const dir = tempDir('zotero-mcp-bib-');
  try {
    const bibPath = join(dir, 'refs.bib');
    writeFileSync(
      bibPath,
      ['@article{smith2020,', '  title = {A Study of Things},', '  author = {Smith, John and Jones, Amy},', '  year = {2020}', '}', ''].join('\n'),
    );
    const result = compileBibSample({ bibPath, keys: ['smith2020'], workDir: join(dir, 'build') });
    assert.equal(result.latexAvailable, true);
    if (result.environmentIssue !== null && result.environmentIssue !== undefined) {
      // 外部工具链的联网类失败（实测：MiKTeX 未完成更新检查时，断网会让 pdflatex 以 FATAL 退出 1）：
      // 这是环境前提而不是本项目的编译路径缺陷，按外部前提跳过并写明下一步，绝不静默判为通过。
      t.skip(`MiKTeX 环境前提未满足：${result.environmentIssue}｜latexmk 输出尾部：${result.stdoutTail.slice(-300).replace(/\s+/gu, ' ')}`);
      return;
    }
    assert.equal(result.compiled, true, result.reason ?? '');
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.undefinedCitations, []);
    assert.ok(existsSync(result.pdfPath), '必须有 PDF 产物');
    assert.match(readFileSync(result.bblPath, 'utf8'), /smith2020/u, '.bbl 必须含条目');

    // 守卫可证伪：引一个 .bib 里不存在的键 → 必须判失败（日志出现 undefined）
    const broken = compileBibSample({ bibPath, keys: ['nosuchkey'], workDir: join(dir, 'build2') });
    assert.equal(broken.compiled, false);
    assert.ok(broken.undefinedCitations.length > 0, '未定义引用必须被如实报出');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('工具面：注册 24 个工具且写作工具不进写总闸', async () => {
  assert.equal(ALL_TOOLS.length, 24);
  assert.equal(TOOL_NAMES.length, 24);
  assert.equal(new Set(TOOL_NAMES).size, 24);
  assert.ok(TOOL_NAMES.includes('zotero_inject_citations'));
  assert.equal(GATED_TOOL_NAME_SET.has('zotero_inject_citations'), false, '只写本地文件的工具不进写总闸');

  const tool = ALL_TOOLS.find((entry) => entry.name === 'zotero_inject_citations');
  assert.ok(tool !== undefined);
  const schema = {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(tool.inputSchema).map(([key, value]) => [key, typeof value?.toJSONSchema === 'function' ? value.toJSONSchema() : value]),
    ),
  };
  for (const required of ['docxPath', 'mapping', 'style', 'locale']) {
    assert.ok(required in schema.properties, `契约必须含 ${required}`);
  }
  assert.equal(tool.inputSchema.docxPath.safeParse('').success, false, 'docxPath 不能为空');
});

test('MiKTeX 联网类失败被识别为环境前提，真实编译错误不受影响', () => {
  // 断网实测里看到的两种形态（本机 MiKTeX 实测文本）
  const updateCheck = [
    'pdflatex: major issue: So far, you have not checked for MiKTeX updates.',
    'FATAL pdflatex - major issue: So far, you have not checked for MiKTeX updates.',
  ].join(String.fromCharCode(10));
  assert.match(String(detectLatexEnvironmentIssue(updateCheck)), /更新检查/u);
  assert.match(String(detectLatexEnvironmentIssue(updateCheck)), /请在联网时/u);

  const repository = 'pdflatex.packagemanager - going to download https://api2.miktex.org/repositories?&releaseState=Stable';
  assert.match(String(detectLatexEnvironmentIssue(repository)), /api2\.miktex\.org|仓库/u);

  // 裸的宏包缺失属第 1 类「真实编译错误」：必须判失败，不得被当成环境前提跳过
  const missingPackage = '! LaTeX Error: File `nosuchpackage.sty` not found.';
  assert.equal(detectLatexEnvironmentIssue(missingPackage), null);
  assert.equal(detectLatexEnvironmentIssue('The required package `foo` is missing.'), null);
  // 但「缺包 + 仓库不可达」同时出现时，才算环境前提（用户需要先联网补齐）
  assert.match(
    String(detectLatexEnvironmentIssue(['! LaTeX Error: File `foo.sty` not found.', 'pdflatex.packagemanager - going to download https://api2.miktex.org/repositories'].join(String.fromCharCode(10)))),
    /仓库|更新检查/u,
  );

  // 断网时的兜底形态：MiKTeX 工具 + FATAL/连不上（具体文案随版本变化）
  const fatalGeneric = 'pdflatex: FATAL pdflatex - Could not resolve host: mirror.example.org (MiKTeX package repository)';
  assert.match(String(detectLatexEnvironmentIssue(fatalGeneric)), /环境前提/u);
  assert.equal(
    detectLatexEnvironmentIssue(
      ['This is pdfTeX, Version 3.141592653 (MiKTeX 24.1)', 'Output written on main.pdf (1 page).'].join(String.fromCharCode(10)),
    ),
    null,
    'MiKTeX 正常输出（无致命/联网信号）不得被判成环境前提',
  );

  // 真实编译错误（例如 undefined 引用）不得被当成环境前提放行
  assert.equal(detectLatexEnvironmentIssue('LaTeX Warning: Citation `nosuchkey` on page 1 undefined.'), null);
  assert.equal(detectLatexEnvironmentIssue(''), null);
});
