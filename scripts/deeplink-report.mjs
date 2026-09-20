#!/usr/bin/env node
/**
 * 深链接取证报告（`npm run report:deeplinks`，路线图 G7 的人工点击证据前置步骤）。
 *
 * 只读：对当前 Zotero 库（本地 API，全程 GET）挑出三类候选深链接并打印原文——
 *   ① 条目：`zotero://select/library/items/<KEY>`
 *   ② PDF + 页码：`zotero://open-pdf/library/items/<ATT>?page=<PAGE>`
 *   ③ 注释：`...?page=<PAGE>&annotation=<ANNO>`
 *
 * 取数优先序：优先挑「有注释的 PDF 附件」以便一次会话覆盖三类；库内没有注释时**如实说明**
 * 第三类无法在本机取证，不编造链接。页码口径与既有实现一致（1-based；注释用 annotationPageLabel，
 * PDF 用附件总页数范围内的第一页，并在输出里标注口径）。
 *
 * 用法：
 *   npm run report:deeplinks            # 人类可读
 *   npm run report:deeplinks -- --json  # 机读 JSON（含环境与三类链接）
 *
 * 退出码：0 = 拿到了条目类（第一类必有）并如实报告其余两类的可用性；1 = 取不到（Zotero 未运行等）。
 *
 * ⚠️ 本脚本**只打印链接**：点击由用户在 Zotero 里完成，不得自动调用系统 opener 冒充点击成功。
 */

import {
  annotationDeepLink,
  fetchAllTopItems,
  getItems,
  probeLocalApi,
  readContent,
  revealDeepLink,
} from '../packages/core/src/index.ts';

const wantsJson = process.argv.includes('--json');

function firstNumber(value) {
  const match = /\d+/u.exec(String(value ?? ''));
  return match === null ? null : Number(match[0]);
}

async function main() {
  const probe = await probeLocalApi();
  const base = (process.env['ZOTERO_MCP_BASE_URL'] ?? 'http://127.0.0.1:23119').replace(/\/$/u, '');
  if (!probe.reachable) {
    console.error(`本地 API 不可用：${probe.reason ?? '未知原因'}`);
    console.error('请启动 Zotero 并确认「设置 → 高级 → 允许其它应用与 Zotero 通信」已开启。');
    return 1;
  }
  // 走既有读层入口（统一基地址解析：显式 > ZOTERO_MCP_BASE_URL > 默认回环），测试可指向假服务器
  const top = await fetchAllTopItems();
  if (!Array.isArray(top) || top.length === 0) {
    console.error('库内没有顶层条目：第一类深链接无法取证。');
    return 1;
  }

  // 逐条看附件与注释，优先挑「有注释的 PDF 附件」
  let itemLink = null;
  let pdfLink = null;
  let annotationLink = null;
  const considered = [];

  for (const entry of top) {
    const itemKey = String(entry?.key ?? '');
    if (itemKey.length === 0) continue;
    const [detail] = await getItems({ keys: [itemKey], include: ['attachments', 'annotations'] });
    if (detail === undefined) continue;
    const pdfs = detail.attachments.filter((attachment) => attachment.isPdf);
    considered.push({ itemKey, title: detail.title, pdfs: pdfs.length, annotations: detail.annotations.length });

    if (itemLink === null) {
      itemLink = { kind: 'item', itemKey, title: detail.title, link: revealDeepLink({ key: itemKey }) };
    }
    if (pdfs.length === 0) continue;

    const pdf = pdfs[0];
    let totalPages = null;
    try {
      const content = await readContent({ key: pdf.key, mode: 'fulltext' });
      totalPages = typeof content.totalPages === 'number' ? content.totalPages : null;
    } catch {
      totalPages = null;
    }
    if (pdfLink === null) {
      const page = totalPages !== null && totalPages > 0 ? Math.min(2, totalPages) : 1;
      pdfLink = {
        kind: 'pdf',
        itemKey,
        attachmentKey: pdf.key,
        title: detail.title,
        page,
        pageBasis: totalPages !== null ? `附件共 ${totalPages} 页，取第 ${page} 页` : '拿不到总页数，取第 1 页',
        link: revealDeepLink({ key: pdf.key, page }),
      };
    }

    // ⚠️ 真机语义（Zotero 10.0.3 实测 2026-09-19）：`/items/<附件>/children` **不带 itemType 过滤**时
    // 不返回注释（返回 0 条），必须显式带 `itemType=annotation` 才拿得到。读层的 include=annotations
    // 走的是不带过滤的那条路径，因此在真机上会漏掉注释——已作为独立发现上报（后续 change 处理），
    // 本脚本为保证取证正确，直接按真机语义查询。
    const annotationsOf = async (attachmentKey) => {
      const response = await fetch(`${base}/api/users/0/items/${attachmentKey}/children?itemType=annotation`, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return [];
      const body = await response.json();
      return Array.isArray(body) ? body : [];
    };
    const annotationRecords = await annotationsOf(pdf.key);
    const annotation = annotationRecords.find((record) => typeof record?.key === 'string');
    if (annotation !== undefined && annotationLink === null) {
      const pageLabel = typeof annotation.data?.annotationPageLabel === 'string' ? annotation.data.annotationPageLabel : null;
      annotationLink = {
        kind: 'annotation',
        itemKey,
        attachmentKey: pdf.key,
        title: detail.title,
        annotationKey: annotation.key,
        annotationType: typeof annotation.data?.annotationType === 'string' ? annotation.data.annotationType : null,
        pageLabel,
        link: annotationDeepLink(pdf.key, annotation.key, pageLabel),
        linkFromReadLayer: detail.annotations.find((entry2) => entry2.key === annotation.key)?.deepLink ?? null,
      };
    }
    if (annotationLink !== null && pdfLink !== null && itemLink !== null) break;
  }

  const report = {
    schema: 'zotero-mcp.deeplink-report.v1',
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    serverId: probe.serverId,
    topLevelItems: top.length,
    links: { item: itemLink, pdf: pdfLink, annotation: annotationLink },
    considered,
    notes: [
      '本报告只由只读请求生成（GET），不写库、不写审计、不写快照。',
      '点击由用户在 Zotero 内完成；结果请记录到 docs/G7_DEEPLINK_CLICK.md（含失败与未覆盖）。',
      annotationLink === null ? '库内没有可用注释：第三类（注释深链接）无法在本机取证，替代证据是契约测试里的文本形态断言。' : '第三类候选已给出：请点开后确认是否定位/高亮到该注释。',
    ],
  };

  if (wantsJson) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  console.log('深链接取证报告（只读）');
  console.log(`时间：${report.generatedAt}　平台：${report.platform}　Node：${report.node}　serverID：${report.serverId ?? '(未知)'}`);
  console.log(`顶层条目：${report.topLevelItems} 条`);
  console.log('');
  console.log('① 条目类：');
  console.log(`   ${itemLink?.link ?? '(未取得)'}${itemLink?.title === undefined ? '' : `　（${itemLink.title}）`}`);
  console.log('② PDF + 页码：');
  if (pdfLink === null) console.log('   (库内没有 PDF 附件：无法取证)');
  else console.log(`   ${pdfLink.link}　（${pdfLink.title}，${pdfLink.pageBasis}）`);
  console.log('③ 注释类：');
  if (annotationLink === null) console.log('   (库内没有注释：无法在本机取证；替代证据见契约测试的文本形态断言)');
  else console.log(`   ${annotationLink.link}　（${annotationLink.annotationType ?? 'annotation'}${annotationLink.pageLabel === null ? '' : `，第 ${annotationLink.pageLabel} 页`}）`);
  console.log('');
  for (const note of report.notes) console.log(`· ${note}`);
  return 0;
}

process.exitCode = await main();
