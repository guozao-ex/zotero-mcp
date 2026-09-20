/**
 * 深链接取证报告契约测试（G5 / G7 人工点击证据的前置步骤）。
 *
 * 三条验证线：
 *   1. 三类链接形态：对假服务器跑 `scripts/deeplink-report.mjs --json`，断言条目类 / PDF+页码类 /
 *      注释类的链接与既有 `revealDeepLink`、`annotationDeepLink` 口径逐字一致；
 *   2. 缺数据如实：假库注入「没有注释」的语料时，注释类必须为 null 且说明里写明无法取证，
 *      **不得编造** annotation 链接；
 *   3. 只读：全过程只发 GET；Zotero 不可达时退出码非 0 且给出可读原因。
 *
 * 本测试不点链接（点击是人在 Zotero 里的动作），只保证「取证工具本身」正确。
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { annotationDeepLink, revealDeepLink } from '../../packages/core/src/index.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'deeplink-report.mjs');
const execFileAsync = promisify(execFile);

async function runReport(baseUrl) {
  const previous = process.env['ZOTERO_MCP_BASE_URL'];
  process.env['ZOTERO_MCP_BASE_URL'] = baseUrl;
  try {
    const result = await execFileAsync(process.execPath, [SCRIPT, '--json'], { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }).then(
      (value) => ({ code: 0, stdout: value.stdout }),
      (error) => ({ code: typeof error.code === 'number' ? error.code : -1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') }),
    );
    return { ...result, report: result.code === 0 ? JSON.parse(result.stdout) : null };
  } finally {
    if (previous === undefined) delete process.env['ZOTERO_MCP_BASE_URL'];
    else process.env['ZOTERO_MCP_BASE_URL'] = previous;
  }
}

test('G5 取证脚本：三类链接形态与既有深链接口径逐字一致，且全程只读', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  try {
    const { code, report } = await runReport(fake.url);
    assert.equal(code, 0);
    assert.equal(report.schema, 'zotero-mcp.deeplink-report.v1');
    assert.equal(report.topLevelItems, 3);

    // ① 条目类
    assert.ok(report.links.item, '必须给出条目类链接');
    assert.equal(report.links.item.link, revealDeepLink({ key: report.links.item.itemKey }));
    assert.match(report.links.item.link, /^zotero:\/\/select\/library\/items\/[A-Za-z0-9]+$/u);

    // ② PDF + 页码类（假库 ITEM0001 → ATT00001 是 PDF）
    assert.ok(report.links.pdf, '必须给出 PDF 类链接');
    assert.equal(report.links.pdf.link, revealDeepLink({ key: report.links.pdf.attachmentKey, page: report.links.pdf.page }));
    assert.match(report.links.pdf.link, /^zotero:\/\/open-pdf\/library\/items\/[A-Za-z0-9]+\?page=\d+$/u);
    assert.ok(Number.isInteger(report.links.pdf.page) && report.links.pdf.page >= 1, '页码必须是 1-based 正整数');
    assert.ok(typeof report.links.pdf.pageBasis === 'string' && report.links.pdf.pageBasis.length > 0, '必须写明页码口径');

    // ③ 注释类（假库 ATT00001 下有 ANNO0001）：与读层 deepLink 逐字一致
    assert.ok(report.links.annotation, '假库有注释时必须给出注释类链接');
    assert.equal(
      report.links.annotation.link,
      annotationDeepLink(
        report.links.annotation.attachmentKey,
        report.links.annotation.annotationKey,
        report.links.annotation.pageLabel,
      ),
    );
    assert.equal(report.links.annotation.link, report.links.annotation.linkFromReadLayer, '必须与读层 deepLink 逐字一致');
    assert.match(report.links.annotation.link, /&annotation=[A-Za-z0-9]+$/u);

    // 只读：过程里不得出现任何非 GET 请求
    assert.deepEqual(
      fake.requests.filter((request) => request.method !== 'GET'),
      [],
      '取证脚本必须只发 GET',
    );
  } finally {
    await fake.close();
  }
});

test('G5 取证脚本：库内没有注释时如实说明，不编造 annotation 链接', async () => {
  // 只保留 ITEM0002 的 PDF（假库该附件没有注释）
  const fake = await startFakeZotero({
    mode: 'ok',
    port: 0,
    library: {
      items: [
        {
          key: 'ITEM0002',
          version: 1,
          data: { itemType: 'journalArticle', title: 'No annotation here', date: '2021', collections: [], tags: [] },
        },
      ],
      children: {
        ITEM0002: [
          {
            key: 'ATT00002',
            version: 1,
            data: {
              itemType: 'attachment',
              contentType: 'application/pdf',
              title: 'PDF without annotations',
              linkMode: 'imported_file',
              parentItem: 'ITEM0002',
            },
          },
        ],
        ATT00002: [],
      },
    },
  });
  try {
    const { code, report } = await runReport(fake.url);
    assert.equal(code, 0, '拿得到条目类就应成功退出，并如实报告其余两类的可用性');
    assert.equal(report.links.annotation, null, '没有注释时必须为 null');
    assert.ok(
      report.notes.some((note) => note.includes('无法在本机取证')),
      '说明里必须写明注释类无法取证',
    );
    assert.equal(JSON.stringify(report).includes('&annotation='), false, '不得编造 annotation 链接');
    // PDF 类仍应给出（附件存在）
    assert.ok(report.links.pdf, '有 PDF 附件时仍应给出 PDF 类链接');
  } finally {
    await fake.close();
  }
});

test('G5 取证脚本：按真机语义带 itemType=annotation 查询注释', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  try {
    const { code, report } = await runReport(fake.url);
    assert.equal(code, 0);
    assert.ok(report.links.annotation, '注释类必须取到（假库该附件下有注释）');
    // 真机（Zotero 10.0.3 实测）不带 itemType 过滤的 /children 不返回注释；脚本必须显式带过滤，
    // 否则在真机上拿不到注释（读层 include=annotations 就是踩在这条语义上，缺口已单独记录）。
    assert.ok(
      fake.requests.some(
        (request) => request.url.includes('/children') && request.url.includes('itemType=annotation'),
      ),
      '必须用 itemType=annotation 过滤查询注释（假服务器只把 pathname 存进 path，查询串在 url 里）',
    );
  } finally {
    await fake.close();
  }
});

test('G5 取证脚本：Zotero 不可达时非零退出并给出可读原因', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const url = fake.url;
  await fake.close();
  const { code, stderr } = await runReport(url).then((result) => ({ code: result.code, stderr: result.stderr ?? '' }));
  assert.notEqual(code, 0, 'Zotero 不可达时必须非零退出');
  assert.ok(stderr.includes('本地 API 不可用') || stderr.includes('启动 Zotero'), '必须给出可读原因与下一步');
});
