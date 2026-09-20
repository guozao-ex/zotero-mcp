/**
 * 注释页标签回填（写路径）——G2 真导入取证的补丁。
 *
 * 背景（实测 + 源码）：导入出来的注释 `annotationPageLabel` 为空，因为页标签来自 **PDF 自身的页标签表**
 * （worker 的 `processAnnotations`：`annotation.pageLabel = pageLabels[pageIndex]`），Citavi 与 Mendeley
 * 两条通道完全一致；没有页标签的 PDF 两条通道都拿不到标签。所以要在**导入之后**把源注释的页标签回填过去。
 *
 * 设计（与 `specs/write-tools/spec.md`「注释页标签回填（写路径）」一致）：
 * - 匹配规则唯一且可解释：**正文（`annotationText`）+ 页索引（`annotationPosition.pageIndex`）**；
 * - 默认 dry-run，只出 before → after 计划、零写请求；
 * - 真写复用既有写安全管线（`makeChangePlan` + `applyPlan`）：`Zotero-Server-ID`、
 *   `If-Unmodified-Since-Version`、`ZOTERO_MCP_WRITE` 总闸、破坏性计划的确认关键词、审计与失败关闭；
 * - 匹配不到、源注释没有页标签、目标已是同值 → 逐条给原因，不猜、不部分成功。
 */

import { applyPlan, makeChangePlan } from './write-pipeline.ts';
import { fetchAnnotationChildren, getItems, toAnnotationDetail } from './read.ts';
import type { ChannelOptions } from './read.ts';
import type { ApplyOptions, ApplyResult, ChangePlan, FieldChange } from './write-pipeline.ts';
import type { AnnotationDetail } from './read.ts';

/** 页标签回填的确认关键词（计划覆盖已有值时由写管线强制要求）。 */
export const LABEL_BACKFILL_CONFIRM = 'OVERWRITE';

export interface AnnotationLabelBackfillOptions extends ChannelOptions {
  /** 源附件（其注释带 pageLabel）。也可以是带 PDF 附件的父条目，取第一个 PDF。 */
  from: string;
  /** 目标附件（其注释 pageLabel 为空，需要回填）。同样接受父条目。 */
  to: string;
  /** 测试注入的时间戳。 */
  now?: () => Date;
}

export interface AnnotationLabelPair {
  sourceKey: string;
  targetKey: string;
  text: string;
  pageIndex: number;
  before: string | null;
  after: string;
}

export interface AnnotationLabelBackfillPlan {
  fromAttachmentKey: string;
  toAttachmentKey: string;
  pairs: AnnotationLabelPair[];
  /** 目标已经是同值。 */
  unchanged: { targetKey: string; reason: string }[];
  /** 源注释没能找到对应目标等。 */
  unmatched: { sourceKey: string; reason: string }[];
  plan: ChangePlan;
}

function annotationPageIndex(annotation: AnnotationDetail): number | null {
  const raw = annotation.position;
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const pageIndex = (parsed as Record<string, unknown>)['pageIndex'];
  return typeof pageIndex === 'number' && Number.isInteger(pageIndex) ? pageIndex : null;
}

const normalizeText = (text: string | null): string => (text ?? '').trim().replaceAll(/\s+/gu, ' ');

/** 把「条目或附件 key」解析成真正承载注释的 PDF 附件 key。 */
async function resolveAnnotationAttachment(key: string, options: ChannelOptions): Promise<string> {
  const [detail] = await getItems({ ...options, keys: [key], include: ['attachments'] });
  if (detail === undefined) throw new Error(`读不到条目或附件：${key}`);
  if (detail.itemType === 'attachment') return detail.key;
  const pdf = detail.attachments.find((attachment) => attachment.isPdf);
  if (pdf === undefined) throw new Error(`该条目下没有 PDF 附件，无法定位注释：${key}`);
  return pdf.key;
}

async function readAnnotations(attachmentKey: string, options: ChannelOptions): Promise<AnnotationDetail[]> {
  const envelopes = await fetchAnnotationChildren(attachmentKey, options);
  return envelopes
    .filter((envelope) => String(envelope.data?.['itemType'] ?? '') === 'annotation')
    .map((envelope) => toAnnotationDetail(envelope, attachmentKey));
}

/**
 * 生成回填计划（只读）。默认不写任何东西——写由 `applyAnnotationLabelBackfill` 触发。
 */
export async function planAnnotationLabelBackfill(options: AnnotationLabelBackfillOptions): Promise<AnnotationLabelBackfillPlan> {
  const channel: ChannelOptions = {
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
  const fromAttachmentKey = await resolveAnnotationAttachment(options.from, channel);
  const toAttachmentKey = await resolveAnnotationAttachment(options.to, channel);
  const [sourceAnnotations, targetAnnotations] = await Promise.all([
    readAnnotations(fromAttachmentKey, channel),
    readAnnotations(toAttachmentKey, channel),
  ]);

  const pairs: AnnotationLabelPair[] = [];
  const unchanged: { targetKey: string; reason: string }[] = [];
  const unmatched: { sourceKey: string; reason: string }[] = [];
  const used = new Set<string>();

  for (const source of sourceAnnotations) {
    const label = source.pageLabel;
    if (label === null || label.length === 0) {
      unmatched.push({ sourceKey: source.key, reason: '源注释没有页标签（annotationPageLabel 为空），无可回填' });
      continue;
    }
    const pageIndex = annotationPageIndex(source);
    if (pageIndex === null) {
      unmatched.push({ sourceKey: source.key, reason: '源注释缺少可用的 pageIndex，无法按「正文 + 页索引」匹配' });
      continue;
    }
    const text = normalizeText(source.text);
    const target = targetAnnotations.find(
      (candidate) =>
        !used.has(candidate.key) &&
        normalizeText(candidate.text) === text &&
        annotationPageIndex(candidate) === pageIndex,
    );
    if (target === undefined) {
      unmatched.push({
        sourceKey: source.key,
        reason: `目标附件下找不到同正文同页（pageIndex=${pageIndex}）的注释`,
      });
      continue;
    }
    used.add(target.key);
    if (target.pageLabel === label) {
      unchanged.push({ targetKey: target.key, reason: `目标注释页标签已是 "${label}"，无需回填` });
      continue;
    }
    pairs.push({
      sourceKey: source.key,
      targetKey: target.key,
      text: text.slice(0, 60),
      pageIndex,
      before: target.pageLabel,
      after: label,
    });
  }

  const changes: FieldChange[] = pairs.map((pair) => ({
    key: pair.targetKey,
    field: 'annotationPageLabel',
    before: pair.before,
    after: pair.after,
  }));
  const plan = makeChangePlan({
    targetKeys: pairs.map((pair) => pair.targetKey),
    changes,
    operations: pairs.map((pair) => ({
      kind: 'patch' as const,
      key: pair.targetKey,
      fields: { annotationPageLabel: pair.after },
    })),
    summary: `回填注释页标签：${fromAttachmentKey} → ${toAttachmentKey}（${pairs.length} 条）`,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  return { fromAttachmentKey, toAttachmentKey, pairs, unchanged, unmatched, plan };
}

/**
 * 执行回填。必须显式 `write: true`（且环境 `ZOTERO_MCP_WRITE` 已开启）；覆盖已有值时要带确认关键词。
 * 复用既有写管线：授权、版本前提、审计、失败关闭都在那里。
 */
export async function applyAnnotationLabelBackfill(
  backfill: AnnotationLabelBackfillPlan,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  if (backfill.pairs.length === 0) throw new Error('没有需要回填的注释（计划为空），未产生任何写请求');
  // 不替调用方补确认关键词：破坏性计划必须由调用方显式给出（写管线的确认门不能被包装层自动满足）
  return await applyPlan(backfill.plan, options);
}
