/**
 * 可导入的高亮清单（Citavi 交换格式）——路线图 G2 的「真导入」形态。
 *
 * 背景（实证，详见 docs/G2_HIGHLIGHT_IMPORT.md）：Zotero 10.0.3 的 748 个 translator 里**没有一个是
 * 注释清单导入器**；能创建注释条目的只有三条原生通道：Mendeley 导入器、Citavi 导入器、
 * 以及导入「自带注释层的 PDF」（`pdf.importAnnotations`）。其中 **Citavi 交换 XML 直接吃显式坐标**
 * （`Quads`），能把 Zotero 自己记录的注释坐标精确 round-trip，因此选它做桥的输出格式。
 *
 * 上游读取方式（`chrome/content/zotero/import/citavi.js`，本文件必须与之逐条对齐）：
 *   - translator `Citavi 5 XML.js` 的 detectImport 只要求前 1000 字符里出现 `<CitaviExchangeData`；
 *   - `//CitaviExchangeData/@Version` 以 "5" 开头 → 走 v5 的 `PageIndex;IsContainer;X1;Y1;X2;Y2`（`|` 分隔）
 *     解析，否则（本文件用 "6"）走 `JSON.parse(Quads)`；
 *   - `<Locations><Location id=…><ReferenceID>参考 id</ReferenceID><Address>…</Address></Location>`：
 *     **Version≠5 时 Address 会被 `JSON.parse` 并取 `.UriString`**，所以本地路径必须包成 JSON；
 *   - 注释：`<Annotations><Annotation id=…><Quads>…</Quads><LocationID>…</LocationID></Annotation>`；
 *     `LocationID → Location → ReferenceID → IDMap[参考 id]` 定位到导入出来的条目，注释落在它的**第一个附件**上；
 *   - 文本与批注来自 `<EntityLinks><EntityLink><SourceID>知识项 id</SourceID><TargetID>注释 id</TargetID></EntityLink>`
 *     指向的 `KnowledgeItem`（`Text` / `CoreStatement` / `QuotationType`）；
 *   - `QuotationType` 决定颜色，其中 5（黄）/6（红）会**丢弃批注**——所以有批注的注释一律用 1–4；
 *   - 注释导入要求附件是真实存在的 PDF（`PDFWorker.processCitaviAnnotations` 会读文件）。
 *
 * 已知差异（写在文档里，不隐藏）：导入会**新建一条条目**（导入器只给自己导入的附件建注释），
 * 颜色会落到 Citavi 的 6 色调色板。
 */

import { fetchAnnotationChildren, getItems, readContent, toAnnotationDetail } from './read.ts';
import { resolveAuditDir } from '../paths.ts';
import type { AnnotationDetail, ChannelOptions } from './read.ts';

/** Citavi 调色板（与上游 citavi.js 的 switch 一一对应）。 */
export const CITAVI_QUOTATION_TYPES = {
  1: { color: '#2ea8e5', label: 'direct-quotation', keepsComment: true },
  2: { color: '#a6507b', label: 'indirect-quotation', keepsComment: true },
  3: { color: '#5fb236', label: 'summary', keepsComment: true },
  4: { color: '#ff8c19', label: 'comment', keepsComment: true },
  5: { color: '#ffd400', label: 'highlight-yellow', keepsComment: false },
  6: { color: '#ff6666', label: 'highlight-red', keepsComment: false },
} as const;

export interface CitaviQuad {
  PageIndex: number;
  IsContainer: boolean;
  X1: number;
  Y1: number;
  X2: number;
  Y2: number;
}

export interface CitaviExchangeOptions extends ChannelOptions {
  /** 要导出的条目 key（父条目或附件本身都可）。 */
  keys: string[];
  /** 可选：生成用的时间戳（测试注入）。 */
  now?: () => Date;
}

export interface CitaviExchangeEntry {
  itemKey: string;
  title: string | null;
  attachmentKey: string;
  pdfPath: string;
  annotationCount: number;
  referenceId: string;
}

export interface CitaviExchangeSkipped {
  itemKey: string;
  annotationKey: string;
  reason: string;
}

export interface CitaviExchangeIssue {
  kind: 'skipped-annotation' | 'type-not-preserved';
  id: string;
  reason: string;
}

export interface CitaviExchangeResult {
  xml: string;
  entries: CitaviExchangeEntry[];
  skipped: CitaviExchangeSkipped[];
  /** 被拒绝的条目（没有可用 PDF 附件 / 没有本地文件路径）。 */
  rejected: { itemKey: string; reason: string }[];
  /** 逐条可读问题：跳过的注释、以及「类型不被 Citavi 通道保留」的提示。 */
  issues: CitaviExchangeIssue[];
  annotationTotal: number;
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** 把一条 Zotero 注释的 `annotationPosition` 转成 Citavi 的 `Quads` 数组（PageIndex 为 1-based）。 */
export function toCitaviQuads(position: unknown): { ok: true; quads: CitaviQuad[]; pageIndex: number } | { ok: false; reason: string } {
  let parsed: unknown = position;
  if (typeof position === 'string') {
    try {
      parsed = JSON.parse(position);
    } catch {
      return { ok: false, reason: '注释的 annotationPosition 不是合法 JSON' };
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: '注释没有可用的 annotationPosition（缺坐标）' };
  }
  const record = parsed as Record<string, unknown>;
  const rawPageIndex = record['pageIndex'];
  if (typeof rawPageIndex !== 'number' || !Number.isInteger(rawPageIndex) || rawPageIndex < 0) {
    return { ok: false, reason: '注释缺少 pageIndex（无法定位页码）' };
  }
  const pageIndex: number = rawPageIndex;
  const rects = record['rects'];
  if (!Array.isArray(rects) || rects.length === 0) {
    return { ok: false, reason: '注释没有 rects（无法定位高亮区域）' };
  }
  const quads: CitaviQuad[] = [];
  for (const rect of rects) {
    if (!Array.isArray(rect) || rect.length !== 4 || rect.some((value) => typeof value !== 'number')) {
      return { ok: false, reason: '注释的 rects 形态非法（期望四个数字）' };
    }
    const [x1, y1, x2, y2] = rect as [number, number, number, number];
    quads.push({ PageIndex: pageIndex + 1, IsContainer: false, X1: x1, Y1: y1, X2: x2, Y2: y2 });
  }
  return { ok: true, quads, pageIndex };
}

/**
 * 选 `QuotationType`：有批注时只能用保留批注的类型 1–4（5/6 会丢批注）；没有批注时按最接近的原色
 * 落到调色板（含 5/6）。规则写进文档，不隐藏「颜色会变」这一事实。
 */
export function toQuotationType(annotation: { annotationType: string | null; comment: string | null; color: string | null }): number {
  const hasComment = typeof annotation.comment === 'string' && annotation.comment.length > 0;
  const color = (annotation.color ?? '').toLowerCase();
  const nearest = (candidates: number[]): number => {
    let best: number = candidates[0] ?? 1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const type of candidates) {
      const target = CITAVI_QUOTATION_TYPES[type as keyof typeof CITAVI_QUOTATION_TYPES].color;
      const parse = (hex: string): [number, number, number] => [
        Number.parseInt(hex.slice(1, 3), 16),
        Number.parseInt(hex.slice(3, 5), 16),
        Number.parseInt(hex.slice(5, 7), 16),
      ];
      const [r1, g1, b1] = parse(target);
      const [r2, g2, b2] = parse(color.length === 7 ? color : '#2ea8e5');
      const distance = (r1 - r2) ** 2 + (g1 - g2) ** 2 + (b1 - b2) ** 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = type;
      }
    }
    return best;
  };
  // ⚠️ 类型 2 不能使用：上游 citavi.js 的 case '2' 会执行
  // `annotation.text = coreStatement; annotation.comment = text`（把正文与批注**互换**），
  // 与我们写入的 Text=正文 / CoreStatement=批注 布局相反。因此候选集里彻底排除 2：
  // 有批注 → 1/3/4（都保留我们的布局）；无批注 → 1/3/4/5/6（含黄与红，颜色更贴近原色）。
  return hasComment ? nearest([1, 3, 4]) : nearest([1, 3, 4, 5, 6]);
}

const REFERENCE_TYPE_BY_ITEM_TYPE: Record<string, string> = {
  journalArticle: 'JournalArticle',
  conferencePaper: 'ConferenceProceedings',
  book: 'Book',
  bookSection: 'Contribution',
  thesis: 'Thesis',
  report: 'Report',
  webpage: 'InternetDocument',
  preprint: 'UnpublishedWork',
  manuscript: 'Manuscript',
  patent: 'Patent',
  newspaperArticle: 'NewspaperArticle',
};

/**
 * 生成 Citavi 6 交换 XML。只读（附件路径走 302 重定向，注释走修复后的读取路径）。
 *
 * 拒绝规则：条目下没有 PDF 附件、或附件拿不到本地文件路径时，该条目进 `rejected` 并给出可读原因
 * （导入器需要真实 PDF 才能落注释）；没有坐标的注释进 `skipped`（逐条给原因）。
 */
export async function buildCitaviAnnotationExchange(options: CitaviExchangeOptions): Promise<CitaviExchangeResult> {
  const entries: CitaviExchangeEntry[] = [];
  const issues: CitaviExchangeIssue[] = [];
  const skipped: CitaviExchangeSkipped[] = [];
  const rejected: { itemKey: string; reason: string }[] = [];
  const references: string[] = [];
  const locations: string[] = [];
  const knowledgeItems: string[] = [];
  const annotations: string[] = [];
  const entityLinks: string[] = [];
  let annotationTotal = 0;

  const keys = [...new Set(options.keys.map((key) => key.trim()).filter((key) => key.length > 0))];
  if (keys.length === 0) throw new Error('keys 不能为空');

  const details = await getItems({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    keys,
    include: ['attachments', 'annotations'],
  });
  const byKey = new Map(details.map((detail) => [detail.key, detail]));

  for (const key of keys) {
    const detail = byKey.get(key);
    if (detail === undefined) {
      rejected.push({ itemKey: key, reason: '条目不存在或读不到' });
      continue;
    }
    // 候选附件：条目自身就是附件时就是它，否则取它的 PDF 附件。
    const attachmentKeys: string[] = [];
    if (detail.itemType === 'attachment') attachmentKeys.push(detail.key);
    for (const attachment of detail.attachments) {
      if (attachment.isPdf) attachmentKeys.push(attachment.key);
    }
    // ⚠️ 注释一律按**附件 key** 走带 itemType=annotation 过滤的子项查询：
    // 读层的 detail.annotations 只在「父条目的 PDF 子项」那条分支上填充，条目自身是附件时恒为空
    // （此前依赖它，导致传附件 key 一律报「没有可导出的注释」）。
    const candidates: { attachmentKey: string; annotations: AnnotationDetail[] }[] = [];
    for (const attachmentKey of attachmentKeys) {
      const envelopes = await fetchAnnotationChildren(attachmentKey, {
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      candidates.push({
        attachmentKey,
        annotations: envelopes
          .filter((envelope) => String(envelope.data?.['itemType'] ?? '') === 'annotation')
          .map((envelope) => toAnnotationDetail(envelope, attachmentKey)),
      });
    }
    const withAnnotations = candidates.find((candidate) => candidate.annotations.length > 0) ?? candidates[0];
    if (withAnnotations === undefined) {
      rejected.push({ itemKey: key, reason: '该条目下没有 PDF 附件，Citavi 导入器无法落注释' });
      continue;
    }

    let pdfPath: string | null = null;
    try {
      const content = await readContent({
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        key: withAnnotations.attachmentKey,
        mode: 'path',
      });
      pdfPath = typeof content.path === 'string' && content.path.length > 0 ? content.path : null;
    } catch (error) {
      rejected.push({
        itemKey: key,
        reason: `拿不到附件的本地文件路径（${error instanceof Error ? error.message : String(error)}）——导入器需要真实 PDF`,
      });
      continue;
    }
    if (pdfPath === null) {
      rejected.push({ itemKey: key, reason: '附件没有本地文件路径（linked 附件文件缺失？），导入器需要真实 PDF' });
      continue;
    }

    const referenceId = `zoteromcp-R${entries.length + 1}`;
    const locationId = `zoteromcp-L${entries.length + 1}`;
    const title = detail.title ?? '';
    const referenceType = REFERENCE_TYPE_BY_ITEM_TYPE[detail.itemType ?? ''] ?? 'Unknown';
    references.push(
      [
        `    <Reference id="${referenceId}" ReferenceType="${escapeXml(referenceType)}">`,
        `      <Title>${escapeXml(title)}</Title>`,
        `      <Year>${escapeXml(detail.year ?? '')}</Year>`,
        `      <DOI>${escapeXml(detail.doi ?? '')}</DOI>`,
        '    </Reference>',
      ].join('\n'),
    );
    // Version=6：Address 会被 JSON.parse 取 UriString，所以必须是 JSON 文本
    locations.push(
      [
        `    <Location id="${locationId}">`,
        `      <ReferenceID>${referenceId}</ReferenceID>`,
        `      <Address>${escapeXml(JSON.stringify({ UriString: pdfPath }))}</Address>`,
        '    </Location>',
      ].join('\n'),
    );

    let kept = 0;
    for (const annotation of withAnnotations.annotations) {
      const quads = toCitaviQuads(annotation.position);
      if (!quads.ok) {
        skipped.push({ itemKey: key, annotationKey: annotation.key, reason: quads.reason });
        issues.push({ kind: 'skipped-annotation', id: annotation.key, reason: quads.reason });
        continue;
      }
      // 上游 citavi.js 把导入的注释类型硬编码成 highlight：非 highlight 的源注释导入后会变类型，
      // 这是上游行为、桥改不了，但必须逐条告诉用户，不能让它悄悄发生。
      if (annotation.annotationType !== null && annotation.annotationType !== 'highlight') {
        issues.push({
          kind: 'type-not-preserved',
          id: annotation.key,
          reason: `Citavi 通道只创建 highlight（上游硬编码），该注释是 ${annotation.annotationType}，导入后会变成 highlight`,
        });
      }
      kept += 1;
      const annotationId = `zoteromcp-A${annotationTotal + 1}`;
      const knowledgeId = `zoteromcp-K${annotationTotal + 1}`;
      const quotationType = toQuotationType(annotation);
      annotations.push(
        [
          `    <Annotation id="${annotationId}">`,
          `      <Quads>${escapeXml(JSON.stringify(quads.quads))}</Quads>`,
          `      <LocationID>${locationId}</LocationID>`,
          '    </Annotation>',
        ].join('\n'),
      );
      // 注意：KnowledgeItem **不带 ReferenceID** —— translator 只把带 ReferenceID 的知识项转成 note，
      // 注释导入是按 @id 找知识项的，所以不写 ReferenceID 可以避免导入时多出一条重复 note。
      knowledgeItems.push(
        [
          `    <KnowledgeItem id="${knowledgeId}">`,
          `      <CoreStatement>${escapeXml(annotation.comment ?? '')}</CoreStatement>`,
          `      <Text>${escapeXml(annotation.text ?? '')}</Text>`,
          `      <QuotationType>${quotationType}</QuotationType>`,
          `      <PageRange>${escapeXml(annotation.pageLabel ?? '')}</PageRange>`,
          '    </KnowledgeItem>',
        ].join('\n'),
      );
      entityLinks.push(
        ['    <EntityLink>', `      <SourceID>${knowledgeId}</SourceID>`, `      <TargetID>${annotationId}</TargetID>`, '    </EntityLink>'].join('\n'),
      );
      annotationTotal += 1;
    }

    entries.push({
      itemKey: key,
      title: detail.title,
      attachmentKey: withAnnotations.attachmentKey,
      pdfPath,
      annotationCount: kept,
      referenceId,
    });
  }

  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<CitaviExchangeData Version="6">',
    '  <References>',
    ...references,
    '  </References>',
    '  <Locations>',
    ...locations,
    '  </Locations>',
    '  <KnowledgeItems>',
    ...knowledgeItems,
    '  </KnowledgeItems>',
    '  <Annotations>',
    ...annotations,
    '  </Annotations>',
    '  <EntityLinks>',
    ...entityLinks,
    '  </EntityLinks>',
    '</CitaviExchangeData>',
    '',
  ].join('\n');

  void resolveAuditDir; // 导出不依赖审计目录（保持纯只读）
  return { xml, entries, skipped, rejected, issues, annotationTotal };
}
