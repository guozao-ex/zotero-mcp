/**
 * 工具定义（路线图工具面 1–21）。
 *
 * 工具层只做参数校验与结果序列化：所有实际读取都交给 @zotero-mcp/core 的能力层；
 * 写工具把意图编译成 ChangePlan 后一律交给写安全管线执行，工具层不自行发写请求。
 * 输入契约用 zod，随工具一起导出，供 MCP 客户端与文档生成复用。
 */

import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

import { z } from 'zod';
import {
  COLLECTION_ACTIONS,
  ENRICH_MODES,
  ENRICH_SOURCES,
  MERGE_CONFIRM_KEYWORD,
  PLUGIN_CLIENT_MODES,
  RECOGNIZE_CONFIRM_KEYWORD,
  ANNOTATION_WRITE_CONFIRM_KEYWORD,
  applyAnnotationWrite,
  planAnnotationWrite,
  applyMerge,
  applyRecognize,
  buildMergePlan,
  buildRecognizePlan,
  pluginHealth,
  pluginSelectItems,
  pluginSync,
  revealDeepLink,
  NEEDS_METADATA_TAG,
  EXPORT_FORMATS,
  TAG_ACTIONS,
  applyPlan,
  assertWriteEnabled,
  buildAddItemsPlan,
  buildAddNotePlan,
  buildAttachFilePlan,
  buildChangePlan,
  buildCreateItemPlan,
  buildDeleteItemsPlan,
  buildEnrichmentPlan,
  buildManageCollectionsPlan,
  buildManageTagsPlan,
  buildUpdateItemPlan,
  enrichItems,
  exportItems,
  injectCitations,
  normalizeMapping,
  contentTypeForPath,
  explainRejectedPairs,
  findDuplicateReport,
  getItems,
  identifiedFields,
  identifyPdf,
  makeChangePlan,
  readItemEnvelope,
  toPosixPath,
  isWriteEnabled,
  listCollections,
  listTags,
  libraryStats,
  previewPlan,
  readContent,
  resolveAuditDir,
  resolveBaseUrl,
  resolveTimeoutMs,
  searchItems,
} from '@zotero-mcp/core';
import {
  DEFAULT_MODEL as DEFAULT_INDEX_MODEL,
  resolveModelSpec,
  IndexUnavailableError,
  MAX_LIMIT as MAX_SEMANTIC_LIMIT,
  buildIndex,
  indexStatus,
  semanticSearch,
  updateIndex,
} from '@zotero-mcp/indexer';
import type { ChangePlan, ChannelOptions, EnrichMode, EnrichSource, PlanOperation } from '@zotero-mcp/core';

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  /** zod raw shape：MCP SDK 据此生成 JSON Schema 并在调用前校验。 */
  inputSchema: Record<string, z.ZodType>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const INCLUDE_FLAGS = ['children', 'attachments', 'annotations', 'notes', 'collections', 'tags'] as const;

function channelOptions(): ChannelOptions {
  const baseUrl = resolveBaseUrl();
  const timeoutMs = resolveTimeoutMs();
  return timeoutMs === undefined ? { baseUrl } : { baseUrl, timeoutMs };
}

/**
 * `zotero_add_items(mode=pdf)`：跑四级识别链，再编译成入库计划。
 *
 * - 识别成功：新建条目（+ 可选 linked 附件，用 `@created:0` 引用新条目 key）；
 * - 识别失败：降级为 `needs-metadata` —— 提供 path 时建一条独立的 linked 附件条目，
 *   提供 itemKey 时给库内既有附件补标签（合并而不是覆盖已有标签）。
 * 两种情况都默认 dry-run，不写库。
 */
async function importFromPdf(args: Record<string, unknown>): Promise<unknown> {
  const pathText = typeof args['path'] === 'string' ? args['path'].trim() : '';
  const itemKey = typeof args['itemKey'] === 'string' ? args['itemKey'].trim() : '';
  if (pathText.length === 0 && itemKey.length === 0) {
    throw new Error('mode=pdf 必须提供 path（本地 PDF 绝对路径）或 itemKey（库内附件 key）');
  }
  if (pathText.length > 0 && !isAbsolute(pathText)) {
    throw new Error(`path 必须是绝对路径：${pathText}`);
  }
  if (pathText.length > 0 && !existsSync(pathText)) {
    throw new Error(`文件不存在或不可读：${pathText}`);
  }
  const identification = await identifyPdf({
    ...channelOptions(),
    ...(pathText.length > 0 ? { path: pathText } : {}),
    ...(itemKey.length > 0 ? { itemKey } : {}),
  });
  const attach = args['attach'] !== false;
  const operations: PlanOperation[] = [];
  const identified = identifiedFields(identification);
  if (identified !== null) {
    operations.push({
      kind: 'create',
      itemType: identified.itemType,
      fields: identified.fields,
      source: identification.level ?? 'identification',
    });
    if (pathText.length > 0 && attach) {
      operations.push({
        kind: 'create',
        itemType: 'attachment',
        fields: {
          linkMode: 'linked_file',
          path: toPosixPath(pathText),
          title: basename(pathText),
          contentType: contentTypeForPath(pathText),
          parentItem: '@created:0',
        },
        source: 'linked-file',
      });
    }
  } else if (pathText.length > 0) {
    operations.push({
      kind: 'create',
      itemType: 'attachment',
      fields: {
        linkMode: 'linked_file',
        path: toPosixPath(pathText),
        title: identification.fallbackTitle,
        contentType: contentTypeForPath(pathText),
        tags: [{ tag: NEEDS_METADATA_TAG }],
      },
      source: 'needs-metadata',
    });
  } else {
    const envelope = await readItemEnvelope(channelOptions(), itemKey);
    if (envelope === null) throw new Error(`附件不存在或不可读写：${itemKey}`);
    const existing = Array.isArray(envelope.data['tags'])
      ? (envelope.data['tags'] as unknown[])
          .map((tag) => (typeof tag === 'string' ? tag : (tag as { tag?: unknown } | null)?.tag))
          .filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
      : [];
    const merged = [...new Set([...existing, NEEDS_METADATA_TAG])].map((tag) => ({ tag }));
    operations.push({ kind: 'patch', key: itemKey, fields: { tags: merged } });
  }

  const plan = makeChangePlan({
    targetKeys: identification.input.itemKey === null ? [] : [identification.input.itemKey],
    changes: [],
    operations,
    summary: identification.needsMetadata
      ? `识别未命中，降级为 needs-metadata（${identification.input.fileName}）`
      : `识别命中 ${identification.level}，导入 ${identification.record?.itemType ?? '条目'}（${identification.input.fileName}）`,
    destructive: false,
    confirmKeyword: null,
  });
  return planResult(plan, args, {
    identification: {
      level: identification.level,
      needsMetadata: identification.needsMetadata,
      identifier: identification.identifier,
      hits: identification.hits,
      input: identification.input,
    },
  });
}

/**
 * 写工具的公共出口：默认 dry-run 只返回计划与 diff；只有 `dryRun=false` 才提交。
 *
 * 两条门禁在所有写工具上一致：
 * 1. 服务端 `ZOTERO_MCP_WRITE` 未开启 → 在发出任何非 GET 请求之前直接拒绝（默认只读）；
 * 2. 破坏性计划必须携带 `confirm`，由写管线核对 confirmKeyword。
 */
async function planResult(
  plan: ChangePlan,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<unknown> {
  const dryRun = args['dryRun'] !== false;
  const operations = plan.operations ?? [];
  const base = {
    planId: plan.id,
    summary: plan.summary,
    affected: plan.targetKeys,
    operationKinds: operations.map((operation) => operation.kind),
    destructive: plan.destructive,
    confirmKeyword: plan.confirmKeyword,
    ...extra,
  };
  if (dryRun) {
    return {
      dryRun: true,
      writeEnabled: isWriteEnabled(),
      changed: operations.length > 0,
      preview: previewPlan(plan),
      plan,
      ...base,
    };
  }
  // 默认只读：写开关未开启时不得产生任何非 GET 请求
  assertWriteEnabled();
  if (operations.length === 0) {
    return { dryRun: false, changed: false, message: '计划不包含任何变更（目标已是期望状态），未发出写请求', ...base };
  }
  const result = await applyPlan(plan, {
    ...channelOptions(),
    auditDir: resolveAuditDir(),
    write: true,
    ...(typeof args['confirm'] === 'string' ? { confirm: args['confirm'] } : {}),
  });
  // 逐操作结论必须对调用方可见：有失败时 ok=false，并把失败的操作列出来
  const failed = result.operations.filter((operation) => operation.status === 'failed');
  return { dryRun: false, changed: true, ok: failed.length === 0, failed, ...base, result };
}

const DRY_RUN_SCHEMA = z
  .boolean()
  .optional()
  .describe('默认 true：只返回计划与 diff；false 才经写安全管线提交（需要服务端 ZOTERO_MCP_WRITE=on）');
const CONFIRM_SCHEMA = z
  .string()
  .min(1)
  .optional()
  .describe('破坏性操作的确认关键字（永久删除 DELETE；覆盖已有值/标签重命名 OVERWRITE）');
const CREATOR_SCHEMA = z.object({
  creatorType: z.string().min(1).optional().describe('创建者类型，默认 author'),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  name: z.string().min(1).optional().describe('单字段名称（机构作者）'),
});

export const READ_TOOLS: ToolDefinition[] = [
  {
    name: 'zotero_search',
    title: '检索文献',
    description:
      '在本地 Zotero 库中检索条目。mode=keyword 检索标题/作者/年份，mode=fulltext 走全文索引，mode=saved 执行保存搜索（本地 API 独有端点 /searches/<key>/items），mode=semantic 走本地语义索引并返回段落级命中（含 itemKey、精确字符区间、页码与估算标记、相似度分数）。语义索引不存在、为空或模型不可用时如实降级为关键词 / 全文检索并带 degraded 与可读原因，绝不假装成功。',
    inputSchema: {
      mode: z.enum(['keyword', 'fulltext', 'saved', 'semantic']).describe('检索模式；semantic 需要先跑 zotero_index(action=build|update)'),
      query: z.string().min(1).optional().describe('keyword / fulltext 模式的检索词'),
      savedSearchKey: z.string().min(1).optional().describe('saved 模式使用的保存搜索 key'),
      itemType: z.string().min(1).optional().describe('按条目类型过滤'),
      tag: z.string().min(1).optional().describe('按标签过滤（支持布尔语法）'),
      collection: z.string().min(1).optional().describe('限定集合 key'),
      limit: z.number().int().min(1).max(100).optional().describe('返回条数上限，默认 25'),
      start: z.number().int().min(0).optional().describe('分页起点'),
    },
    handler: async (args) => {
      const mode = args['mode'] as 'keyword' | 'fulltext' | 'saved' | 'semantic';
      if (mode === 'semantic') {
        const query = typeof args['query'] === 'string' ? args['query'].trim() : '';
        if (query.length === 0) throw new Error('mode=semantic 必须提供 query');
        const limit = typeof args['limit'] === 'number' ? Math.min(args['limit'], MAX_SEMANTIC_LIMIT) : undefined;
        const result = await semanticSearch(query, {
          ...channelOptions(),
          ...(limit === undefined ? {} : { limit }),
        });
        if (result.degraded !== true) return { mode, query, ...result };
        // 规格要求「降级为既有关键词 + 全文检索」：先走全文检索，没有命中再走关键词检索，
        // 并把用了哪种回退如实带回结果里（不返回空命中却声称成功）。
        const fallbackOptions = {
          ...channelOptions(),
          ...(limit === undefined ? {} : { limit }),
          ...(typeof args['itemType'] === 'string' ? { itemType: args['itemType'] } : {}),
          ...(typeof args['tag'] === 'string' ? { tag: args['tag'] } : {}),
          ...(typeof args['collection'] === 'string' ? { collection: args['collection'] } : {}),
        };
        const fulltext = await searchItems({ ...fallbackOptions, mode: 'fulltext', query });
        if (fulltext.items.length > 0) {
          return { mode, query, ...result, fallback: { mode: 'fulltext', total: fulltext.total, items: fulltext.items } };
        }
        const keyword = await searchItems({ ...fallbackOptions, mode: 'keyword', query });
        return { mode, query, ...result, fallback: { mode: 'keyword', total: keyword.total, items: keyword.items } };
      }
      return searchItems({
        ...channelOptions(),
        mode,
        ...(typeof args['query'] === 'string' ? { query: args['query'] } : {}),
        ...(typeof args['savedSearchKey'] === 'string' ? { savedSearchKey: args['savedSearchKey'] } : {}),
        ...(typeof args['itemType'] === 'string' ? { itemType: args['itemType'] } : {}),
        ...(typeof args['tag'] === 'string' ? { tag: args['tag'] } : {}),
        ...(typeof args['collection'] === 'string' ? { collection: args['collection'] } : {}),
        ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
        ...(typeof args['start'] === 'number' ? { start: args['start'] } : {}),
      });
    },
  },
  {
    name: 'zotero_get_items',
    title: '读取条目详情',
    description:
      '按 key 读取条目详情，支持批量（自动按 50 个一批）与 include=attachments,annotations,notes 附加子项；注释返回 annotationPageLabel 与 zotero://open-pdf 深链接。',
    inputSchema: {
      keys: z.array(z.string().min(1)).min(1).describe('条目 key 列表（超过 50 个自动分批）'),
      include: z.array(z.enum(INCLUDE_FLAGS)).optional().describe('附加内容'),
    },
    handler: async (args) =>
      getItems({
        ...channelOptions(),
        keys: args['keys'] as string[],
        ...(Array.isArray(args['include']) ? { include: args['include'] as (typeof INCLUDE_FLAGS)[number][] } : {}),
      }),
  },
  {
    name: 'zotero_list_collections',
    title: '列出集合树',
    description: '返回集合树（含父子关系、可读路径与条目计数）。',
    inputSchema: {
      withCounts: z.boolean().optional().describe('是否附带条目计数（默认 true）'),
    },
    handler: async (args) =>
      listCollections({
        ...channelOptions(),
        ...(typeof args['withCounts'] === 'boolean' ? { withCounts: args['withCounts'] } : {}),
      }),
  },
  {
    name: 'zotero_list_tags',
    title: '列出标签',
    description: '返回标签与出现频次（numItems）。',
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe('返回条数上限，默认 100'),
    },
    handler: async (args) =>
      listTags({
        ...channelOptions(),
        ...(typeof args['limit'] === 'number' ? { limit: args['limit'] } : {}),
      }),
  },
  {
    name: 'zotero_read_content',
    title: '读取内容',
    description:
      'mode=path 经 /items/<key>/file 的 302 取本地文件路径；mode=fulltext 取全文索引内容。',
    inputSchema: {
      key: z.string().min(1).describe('附件 key'),
      mode: z.enum(['path', 'fulltext']).describe('读取方式'),
    },
    handler: async (args) =>
      readContent({
        ...channelOptions(),
        key: args['key'] as string,
        mode: args['mode'] as 'path' | 'fulltext',
      }),
  },
  {
    name: 'zotero_find_duplicates',
    title: '查找重复候选',
    description:
      '重复候选聚类：强键（DOI / ISBN / PMID 归一化精确匹配）加弱键（同 itemType + 年份相差不超过容差 + 首作者姓与标题的 Jaro-Winkler 阈值）。返回候选簇、建议主记录（附件 → 注释 → 集合 → 字段完整度）与统计；纯读，不执行合并（合并由 M4 的插件通道负责）。',
    inputSchema: {
      includeWeakKeys: z.boolean().optional().describe('是否启用弱键聚类，默认 true'),
      threshold: z.number().min(0.5).max(1).optional().describe('标题与首作者姓的相似度阈值，默认 0.9'),
      yearTolerance: z.number().int().min(0).max(3).optional().describe('弱键的年份容差，默认 1'),
      explain: z.boolean().optional().describe('是否附带被拒对的诊断（弱键失败原因），默认 false'),
    },
    handler: async (args) => {
      const dedupeOptions = {
        ...(typeof args['includeWeakKeys'] === 'boolean' ? { includeWeakKeys: args['includeWeakKeys'] } : {}),
        ...(typeof args['threshold'] === 'number' ? { threshold: args['threshold'] } : {}),
        ...(typeof args['yearTolerance'] === 'number' ? { yearTolerance: args['yearTolerance'] } : {}),
      };
      const report = await findDuplicateReport({ ...channelOptions(), ...dedupeOptions });
      const keys = [...new Set(report.clusters.flatMap((cluster) => cluster.items.map((item) => item.key)))];
      return {
        clusters: report.clusters,
        stats: {
          totalItems: report.totalItems,
          clusters: report.clusters.length,
          strongClusters: report.clusters.filter((cluster) => cluster.confidence === 'strong').length,
          weakClusters: report.clusters.filter((cluster) => cluster.confidence === 'weak').length,
          candidateItems: keys.length,
        },
        ...(args['explain'] === true
          ? { rejected: explainRejectedPairs(report.items, dedupeOptions, 20) }
          : {}),
      };
    },
  },
  {
    name: 'zotero_export',
    title: '引用与导出',
    description:
      '导出条目引用：format=bib/bibtex/csljson/ris 为整条记录，citation/bibliography 为格式化引用（可传 style 与 locale）；format=citavi 导出该条目 PDF 注释的「可导入高亮清单」（Citavi 6 交换 XML，Zotero 自带 Citavi 导入器可直接导入并创建注释条目，颜色会落到 Citavi 调色板且导入会新建条目）。可选 outPath 落盘（默认不覆盖已有文件）。',
    inputSchema: {
      keys: z.array(z.string().min(1)).min(1).describe('条目 key 列表（≤50）'),
      format: z.enum(EXPORT_FORMATS).describe('导出格式'),
      style: z.string().min(1).optional().describe('citation / bibliography 的 CSL 样式'),
      locale: z.string().min(1).optional().describe('citation / bibliography 的语言'),
      outPath: z.string().min(1).optional().describe('落盘路径（本地文件系统）'),
      overwrite: z.boolean().optional().describe('是否允许覆盖已存在文件，默认 false'),
    },
    handler: async (args) =>
      exportItems({
        ...channelOptions(),
        keys: args['keys'] as string[],
        format: args['format'] as (typeof EXPORT_FORMATS)[number],
        ...(typeof args['style'] === 'string' ? { style: args['style'] } : {}),
        ...(typeof args['locale'] === 'string' ? { locale: args['locale'] } : {}),
        ...(typeof args['outPath'] === 'string' ? { outPath: args['outPath'] } : {}),
        ...(typeof args['overwrite'] === 'boolean' ? { overwrite: args['overwrite'] } : {}),
      }),
  },
  {
    name: 'zotero_plan_changes',
    title: '生成写计划（dry-run）',
    description:
      '把「条目 key + 字段 + 新值」意图归一化为 ChangePlan，返回逐字段 before → after diff 与影响面统计；不落盘、不写库。',
    inputSchema: {
      updates: z
        .array(
          z.object({
            key: z.string().min(1).describe('条目 key'),
            field: z.string().min(1).describe('Zotero 字段名（如 extra、language）'),
            value: z.unknown().describe('新值（字符串/数字/数组）'),
          }),
        )
        .min(1)
        .describe('字段更新意图列表'),
    },
    handler: async (args) => {
      const plan = await buildChangePlan({
        ...channelOptions(),
        updates: args['updates'] as { key: string; field: string; value: unknown }[],
      });
      return { plan, preview: previewPlan(plan), writeEnabled: isWriteEnabled() };
    },
  },
  {
    name: 'zotero_apply_changes',
    title: '提交写计划',
    description:
      '提交 ChangePlan：默认只读（需 write=true 且服务端 ZOTERO_MCP_WRITE=on）→ 一次授权 → 写前快照 → 批量提交（版本前置 + Zotero-Server-ID）→ 审计；412 自动重建计划重试。',
    inputSchema: {
      plan: z.unknown().describe('由 zotero_plan_changes 返回的 plan 对象'),
      write: z.boolean().optional().describe('必须显式为 true 才写入，默认只预览'),
      confirm: z.string().min(1).optional().describe('破坏性计划的确认关键字'),
    },
    handler: async (args) => {
      const plan = args['plan'] as Parameters<typeof applyPlan>[0];
      return applyPlan(plan, {
        ...channelOptions(),
        auditDir: resolveAuditDir(),
        write: args['write'] === true,
        ...(typeof args['confirm'] === 'string' ? { confirm: args['confirm'] } : {}),
      });
    },
  },
  {
    name: 'zotero_library_stats',
    title: '库健康度',
    description: '返回条目总数、缺 PDF、缺 DOI、缺元数据、未分类、重名作者与条目类型分布。',
    inputSchema: {},
    handler: async () => libraryStats(channelOptions()),
  },
];

/**
 * 写 / 整理工具（路线图工具面 11–18）。
 *
 * 全部复用 change 4 的写安全管线：默认只读、一次授权、写前快照、逐条写入（版本前置）、
 * 写后回读校验、审计 JSONL；工具层只负责把意图编译成 `ChangePlan`。
 */
export const WRITE_TOOLS: ToolDefinition[] = [
  {
    name: 'zotero_create_item',
    title: '新建条目',
    description:
      '按 itemType + fields（可选 creators / collections）新建条目。默认 dryRun=true 只返回计划与影响面；dryRun=false 且服务端 ZOTERO_MCP_WRITE=on 时经写安全管线提交（一次授权 → 写前快照 → POST /items → 回读校验 → 审计 JSONL），新条目 key 会出现在结果、快照与审计中。',
    inputSchema: {
      itemType: z.string().min(1).describe('Zotero 条目类型（journalArticle / book / conferencePaper …）'),
      fields: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('字段映射（title / DOI / date / publicationTitle / extra …）'),
      creators: z.array(CREATOR_SCHEMA).optional().describe('创建者列表'),
      collections: z.array(z.string().min(1)).optional().describe('加入的集合 key 列表'),
      dryRun: DRY_RUN_SCHEMA,
      confirm: CONFIRM_SCHEMA,
    },
    handler: async (args) =>
      planResult(
        buildCreateItemPlan({
          itemType: args['itemType'] as string,
          ...(args['fields'] === undefined ? {} : { fields: args['fields'] as Record<string, unknown> }),
          ...(Array.isArray(args['creators']) ? { creators: args['creators'] as { creatorType?: string; firstName?: string; lastName?: string; name?: string }[] } : {}),
          ...(Array.isArray(args['collections']) ? { collections: args['collections'] as string[] } : {}),
        }),
        args,
      ),
  },
  {
    name: 'zotero_update_item',
    title: '更新条目字段',
    description:
      '更新既有条目：可传 updates（key + field + value）或 keys + fields。复用 change 4 的计划路径，dryRun=true 时返回逐字段 before → after diff；覆盖已有非空值属于破坏性操作，需 confirm="OVERWRITE"。',
    inputSchema: {
      updates: z
        .array(
          z.object({
            key: z.string().min(1).describe('条目 key'),
            field: z.string().min(1).describe('Zotero 字段名（如 extra、language、creators）'),
            value: z.unknown().describe('新值'),
          }),
        )
        .optional()
        .describe('字段更新意图列表'),
      keys: z.array(z.string().min(1)).min(1).optional().describe('批量应用同一组字段时的条目 key 列表'),
      fields: z.record(z.string(), z.unknown()).optional().describe('与 keys 搭配的字段映射'),
      mode: z.enum(['patch']).optional().describe('本轮仅支持 patch（逐字段 PATCH，PUT 整对象覆盖留给后续 change）'),
      dryRun: DRY_RUN_SCHEMA,
      confirm: CONFIRM_SCHEMA,
    },
    handler: async (args) =>
      planResult(
        await buildUpdateItemPlan({
          ...channelOptions(),
          ...(Array.isArray(args['updates']) ? { updates: args['updates'] as { key: string; field: string; value: unknown }[] } : {}),
          ...(Array.isArray(args['keys']) ? { keys: args['keys'] as string[] } : {}),
          ...(args['fields'] === undefined ? {} : { fields: args['fields'] as Record<string, unknown> }),
        }),
        args,
      ),
  },
  {
    name: 'zotero_delete_items',
    title: '删除条目（默认进垃圾箱）',
    description:
      '删除条目：默认只移入垃圾箱（真机用 PATCH deleted=1，条目出现在 /items/trash 且可从垃圾箱恢复）；permanent=true 先用 DELETE 彻底删除（真机 DELETE 不会进垃圾箱），需要 confirm="DELETE"。只作用于显式传入的 keys。',
    inputSchema: {
      keys: z.array(z.string().min(1)).min(1).describe('要删除的条目 key 列表（白名单，禁止全库批量）'),
      permanent: z.boolean().optional().describe('true = 彻底删除（先移入垃圾箱再删除），默认 false 只进垃圾箱'),
      dryRun: DRY_RUN_SCHEMA,
      confirm: CONFIRM_SCHEMA,
    },
    handler: async (args) =>
      planResult(
        await buildDeleteItemsPlan({
          ...channelOptions(),
          keys: args['keys'] as string[],
          ...(args['permanent'] === true ? { permanent: true } : {}),
        }),
        args,
      ),
  },
  {
    name: 'zotero_manage_collections',
    title: '集合管理',
    description:
      '集合整理：action=create（新建，可带 parentCollection）/ rename（重命名）/ addItems / removeItems（条目归属只作用于显式传入的 keys）。返回受影响对象清单与审计路径。',
    inputSchema: {
      action: z.enum([...COLLECTION_ACTIONS]).describe('集合操作'),
      name: z.string().min(1).optional().describe('create / rename 使用的集合名'),
      collectionKey: z.string().min(1).optional().describe('rename / addItems / removeItems 的目标集合 key'),
      parentCollection: z.string().min(1).optional().describe('create 时的父集合 key'),
      keys: z.array(z.string().min(1)).min(1).optional().describe('addItems / removeItems 的条目 key 列表'),
      dryRun: DRY_RUN_SCHEMA,
      confirm: CONFIRM_SCHEMA,
    },
    handler: async (args) =>
      planResult(
        await buildManageCollectionsPlan({
          ...channelOptions(),
          action: args['action'] as (typeof COLLECTION_ACTIONS)[number],
          ...(typeof args['name'] === 'string' ? { name: args['name'] } : {}),
          ...(typeof args['collectionKey'] === 'string' ? { collectionKey: args['collectionKey'] } : {}),
          ...(typeof args['parentCollection'] === 'string' ? { parentCollection: args['parentCollection'] } : {}),
          ...(Array.isArray(args['keys']) ? { keys: args['keys'] as string[] } : {}),
        }),
        args,
      ),
  },
  {
    name: 'zotero_manage_tags',
    title: '标签管理',
    description:
      '标签整理：action=add / remove（需要 keys + tags，只作用于显式传入的 keys）；action=rename（from → to，默认覆盖所有使用该标签的条目，可用 keys 限定范围，属于破坏性操作，需 confirm="OVERWRITE"）。返回受影响对象清单与审计路径。',
    inputSchema: {
      action: z.enum([...TAG_ACTIONS]).describe('标签操作'),
      tags: z.array(z.string().min(1)).min(1).optional().describe('add / remove 使用的标签列表'),
      keys: z.array(z.string().min(1)).min(1).optional().describe('作用范围的条目 key 列表（rename 时可选）'),
      from: z.string().min(1).optional().describe('rename 的旧标签'),
      to: z.string().min(1).optional().describe('rename 的新标签'),
      dryRun: DRY_RUN_SCHEMA,
      confirm: CONFIRM_SCHEMA,
    },
    handler: async (args) =>
      planResult(
        await buildManageTagsPlan({
          ...channelOptions(),
          action: args['action'] as (typeof TAG_ACTIONS)[number],
          ...(Array.isArray(args['tags']) ? { tags: args['tags'] as string[] } : {}),
          ...(Array.isArray(args['keys']) ? { keys: args['keys'] as string[] } : {}),
          ...(typeof args['from'] === 'string' ? { from: args['from'] } : {}),
          ...(typeof args['to'] === 'string' ? { to: args['to'] } : {}),
        }),
        args,
      ),
  },
  {
    name: 'zotero_attach_file',
    title: '挂载附件（linked）',
    description:
      '在父条目下挂载 linked 附件（path 必须是本机绝对路径且文件存在）；reuseExisting 默认 true：同路径已有附件时直接复用其 key，不重复新建。附件文件字节上传属后续 change。',
    inputSchema: {
      parentKey: z.string().min(1).describe('父条目 key'),
      mode: z.enum(['linked']).optional().describe('本轮只支持 linked（linked_file）'),
      path: z.string().min(1).describe('本机文件的绝对路径'),
      title: z.string().min(1).optional().describe('附件标题，默认取文件名'),
      reuseExisting: z.boolean().optional().describe('同路径已存在附件时复用（默认 true）'),
      dryRun: DRY_RUN_SCHEMA,
      confirm: CONFIRM_SCHEMA,
    },
    handler: async (args) => {
      const outcome = await buildAttachFilePlan({
        ...channelOptions(),
        parentKey: args['parentKey'] as string,
        ...(args['mode'] === 'linked' ? { mode: 'linked' as const } : {}),
        path: args['path'] as string,
        ...(typeof args['title'] === 'string' ? { title: args['title'] } : {}),
        ...(typeof args['reuseExisting'] === 'boolean' ? { reuseExisting: args['reuseExisting'] } : {}),
      });
      if (outcome.reused !== null) {
        return { reused: true, ...outcome.reused, message: '同路径附件已存在，复用既有附件（未发出写请求）' };
      }
      return planResult(outcome.plan as ChangePlan, args);
    },
  },
  {
    name: 'zotero_add_note',
    title: '新建或更新笔记',
    description:
      '在父条目下新建笔记（parentKey + content），或更新既有笔记（noteKey + content）。纯文本会被包成 HTML 段落；笔记属于条目子项，写入同样经过写安全管线。fromAnnotations=true 时不写 content：改读目标的注释（父条目下 PDF 附件的注释，或目标自身就是附件时的注释子项），拼成含 zotero://open-pdf 深链接的结构化 note，每条注释恰好一个深链接；目标没有注释、或与 content / noteKey 同时给出时一律拒绝且不写库。',
    inputSchema: {
      parentKey: z.string().min(1).optional().describe('新建笔记时的父条目 key（fromAnnotations=true 时必填）'),
      noteKey: z.string().min(1).optional().describe('更新既有笔记时的笔记 key'),
      content: z.string().min(1).optional().describe('笔记内容（HTML 片段或纯文本）；fromAnnotations=true 时不要给'),
      fromAnnotations: z
        .boolean()
        .optional()
        .describe('true 时由目标的注释生成结构化 note（含 zotero://open-pdf 深链接），与 content / noteKey 互斥'),
      dryRun: DRY_RUN_SCHEMA,
      confirm: CONFIRM_SCHEMA,
    },
    handler: async (args) => {
      const outcome = await buildAddNotePlan({
        ...channelOptions(),
        ...(typeof args['parentKey'] === 'string' ? { parentKey: args['parentKey'] } : {}),
        ...(typeof args['noteKey'] === 'string' ? { noteKey: args['noteKey'] } : {}),
        ...(typeof args['content'] === 'string' ? { content: args['content'] } : {}),
        ...(args['fromAnnotations'] === true ? { fromAnnotations: true } : {}),
      });
      return planResult(outcome.plan, args, {
        noteMode: outcome.mode,
        noteKey: outcome.targetKey,
        ...(outcome.deepLinks === undefined ? {} : { annotationCount: outcome.deepLinks.length, deepLinks: outcome.deepLinks }),
      });
    },
  },
  {
    name: 'zotero_add_items',
    title: '导入条目（标识符 / PDF）',
    description:
      'mode=identifier：把 DOI / ISBN / PMID 解析为条目元数据（优先本地 translation-server，端口 1969；不可用时回退直连 Crossref / OpenLibrary / PubMed），解析成功才经写安全管线建条目，结果里标注所用通道；解析失败返回可读原因且不写库。mode=pdf：对本地 PDF（path）或库内附件（itemKey）跑四级识别链（L1 文本层正则 / L2 PDF 信息与 XMP / L3 translation-server / L4 标题检索），识别成功则建条目并按需挂 linked 附件，识别不出时降级为 needs-metadata（独立附件条目或给既有附件补标签；未拿到 DOI 时按 document 建条目）。两种模式都默认 dryRun=true，只有 dryRun=false 且服务端 ZOTERO_MCP_WRITE=on 才提交。',
    inputSchema: {
      mode: z.enum(['identifier', 'pdf']).describe('identifier 按标识符导入；pdf 先跑四级识别链再入库'),
      identifier: z.string().min(1).optional().describe('mode=identifier：标识符本体（可带 doi: / https://doi.org/ 前缀）'),
      identifierType: z.enum(['auto', 'doi', 'isbn', 'pmid']).optional().describe('mode=identifier：显式指定类型，默认 auto'),
      path: z.string().min(1).optional().describe('mode=pdf：本地 PDF 绝对路径'),
      itemKey: z.string().min(1).optional().describe('mode=pdf：库内附件 key（可用 Zotero 全文索引）'),
      attach: z.boolean().optional().describe('mode=pdf 且提供 path 时是否把 PDF 挂成新条目的 linked 附件，默认 true'),
      dryRun: DRY_RUN_SCHEMA,
      confirm: CONFIRM_SCHEMA,
    },
    handler: async (args) => {
      if (args['mode'] === 'pdf') return importFromPdf(args);
      const { plan, resolution } = await buildAddItemsPlan({
        ...channelOptions(),
        mode: 'identifier',
        identifier: args['identifier'] as string,
        ...(typeof args['identifierType'] === 'string' ? { identifierType: args['identifierType'] as 'auto' | 'doi' | 'isbn' | 'pmid' } : {}),
      });
      return planResult(plan, args, {
        identifier: {
          kind: resolution.kind,
          value: resolution.identifier,
          source: resolution.source,
          records: resolution.records.map((record) => record.itemType),
          attempts: resolution.attempts,
        },
      });
    },
  },
  {
    name: 'zotero_attach_annotations',
    title: '写入注释（四级回退通道）',
    description:
      '把注释（highlight / underline / note / image / ink）写入指定 PDF 附件。插件端点在 Zotero 自带 HTTP 服务器上，插件不可用时按四级回退逐级尝试：① 插件端点 /zoteromcp/annotations（默认关闭，需打开插件 pref）→ ② 本机 Local API 写（Zotero 10+ 官方写入通道，首次写入会在 Zotero 弹一次授权框；不出本机、免云凭证）→ ③ 云端 Web API 写 https://api.zotero.org（**必须显式配置** ZOTERO_MCP_WEB_API_KEY + ZOTERO_MCP_WEB_API_LIBRARY 或 <Zotero 数据目录>/zoteromcp-web-api.json；未配置时零外呼）→ ④ 如实降级为「等待自动同步」。结果里给出最终通道、逐级尝试记录与失败原因、创建的注释 key、被跳过的重复项（幂等：类型+位置+正文+批注全同则跳过）与快照/审计路径；任何一级失败都不会被写成成功。默认只读（dryRun=true 只出计划与通道探测结论）；dryRun=false 需要 confirm="WRITE" 且服务端 ZOTERO_MCP_WRITE=on，否则在发出任何写请求之前拒绝。本轮只做创建，不做注释的编辑与删除。',
    inputSchema: {
      attachmentKey: z.string().min(1).describe('目标 PDF 附件 key（注释是它的子项）'),
      annotations: z
        .array(
          z.object({
            type: z.enum(['highlight', 'underline', 'note', 'image', 'ink']).describe('注释类型'),
            pageIndex: z.number().int().min(0).describe('0-based 页索引（Zotero 内部口径）'),
            rects: z.array(z.array(z.number())).min(1).describe('PDF 坐标矩形数组，如 [[x1,y1,x2,y2]]（位置决定高亮落在哪，text 只是元数据）'),
            text: z.string().optional().describe('高亮/下划线正文（highlight / underline 用）'),
            comment: z.string().optional().describe('批注文字'),
            color: z.string().optional().describe('颜色，如 #ffd400（缺省 #ffd400）'),
            pageLabel: z.string().optional().describe('页码标签（与 Zotero 阅读器显示口径一致的字符串）'),
          }),
        )
        .min(1)
        .max(50)
        .describe('要写入的注释（1–50 条）'),
      dryRun: DRY_RUN_SCHEMA,
      confirm: z.string().min(1).optional().describe('写入确认关键字：注释写入需 confirm="WRITE"'),
    },
    handler: async (args) => {
      const attachmentKey = String(args['attachmentKey'] ?? '').trim();
      const rawAnnotations = Array.isArray(args['annotations']) ? args['annotations'] : [];
      const annotations = rawAnnotations.map((entry) => {
        const record = entry as Record<string, unknown>;
        return {
          type: String(record['type']),
          pageIndex: Number(record['pageIndex']),
          rects: (record['rects'] as number[][]).map((rect) => rect.map((value) => Number(value))),
          ...(typeof record['text'] === 'string' ? { text: record['text'] } : {}),
          ...(typeof record['comment'] === 'string' ? { comment: record['comment'] } : {}),
          ...(typeof record['color'] === 'string' ? { color: record['color'] } : {}),
          ...(typeof record['pageLabel'] === 'string' ? { pageLabel: record['pageLabel'] } : {}),
        };
      });
      const plan = await planAnnotationWrite({ ...channelOptions(), attachmentKey, annotations });
      const preview = {
        planId: plan.planId,
        attachmentKey: plan.attachmentKey,
        parentItem: plan.parentItem,
        attachmentTitle: plan.attachmentTitle,
        annotationCount: plan.items.length,
        channels: plan.channels,
        selectedChannel: plan.selectedChannel,
        duplicates: plan.duplicates,
        notes: plan.notes,
        pluginStatus: plan.pluginStatus,
        webApi: plan.webApi,
      };
      if (args['dryRun'] === false) {
        // 与其它写工具同口径：先过「默认只读」总闸（连计划都不提交），再校验确认关键字
        assertWriteEnabled();
        if (args['confirm'] !== ANNOTATION_WRITE_CONFIRM_KEYWORD) {
          throw new Error(`注释写入必须携带 confirm="${ANNOTATION_WRITE_CONFIRM_KEYWORD}"`);
        }
      }
      if (args['dryRun'] !== false) {
        return { dryRun: true, writeEnabled: isWriteEnabled(), ...preview };
      }
      const applied = await applyAnnotationWrite(plan, {
        ...channelOptions(),
        auditDir: resolveAuditDir(),
        write: true,
        ...(typeof args['confirm'] === 'string' ? { confirm: args['confirm'] } : {}),
      });
      return { dryRun: false, ...preview, ...applied };
    },
  },
];

/**
 * 研究工具（路线图工具面 19，由 metadata-enrichment 规格定义）。
 *
 * `zotero_enrich` 与写工具共用同一条写安全管线：默认 dry-run；`dryRun=false` 时先在
 * 任何请求之前过「默认只读」总闸（连计划都不生成），再交给 `applyPlan` 提交。
 * 补全本身不写库：`extra` 只替换自己的托管块、`journalAbbreviation` 只补空、标签只增不减。
 */
export const RESEARCH_TOOLS: ToolDefinition[] = [
  {
    name: 'zotero_enrich',
    title: '元数据补全（学术情报）',
    description:
      '按 DOI（条目无 DOI 时用标题在 OpenAlex 回退检索，Jaro-Winkler ≥ 0.8 才采纳并标注相似度）级联外部学术 API，取回引用数与影响力（OpenAlex cited_by_count、Semantic Scholar citationCount / influentialCitationCount）、撤稿标记（OpenAlex is_retracted / Crossref updated-by / PubMed pubtype）、OA 级联（Unpaywall → Semantic Scholar openAccessPdf → arXiv → PMC）与期刊缩写（Crossref short-container-title 优先），写入 extra 托管块、journalAbbreviation（仅补空）与标签（retracted / open-access / needs-enrichment）；全部源失败时降级为 needs-enrichment 标签且不写任何字段。外呼一律带 mailto 标识、按主机限速并命中本地缓存。默认 dryRun=true 只返回计划与逐条情报；dryRun=false 且服务端 ZOTERO_MCP_WRITE=on 时经写安全管线提交（一次授权 → 写前快照 → 逐条 PATCH → 回读校验 → 审计 JSONL）。',
    inputSchema: {
      mode: z
        .enum(ENRICH_MODES)
        .describe('metadata 取全部四类情报；retractions 只外呼 OpenAlex / Crossref / PubMed 三个撤稿信号源，写入内容即为这三源返回的情报'),
      keys: z.array(z.string().min(1)).min(1).describe('条目 key 列表（显式白名单，禁止全库扫描）'),
      sources: z.array(z.enum(ENRICH_SOURCES)).optional().describe('限定源子集，缺省全开'),
      dryRun: DRY_RUN_SCHEMA,
      confirm: CONFIRM_SCHEMA,
    },
    handler: async (args) => {
      // 默认只读前置：dryRun=false 且写开关未开启时，连计划都不生成（假服务器零请求）
      if (args['dryRun'] === false) assertWriteEnabled();
      const report = await enrichItems({
        ...channelOptions(),
        keys: args['keys'] as string[],
        ...(typeof args['mode'] === 'string' ? { mode: args['mode'] as EnrichMode } : {}),
        ...(Array.isArray(args['sources']) ? { sources: args['sources'] as EnrichSource[] } : {}),
      });
      const plan = buildEnrichmentPlan(report.items);
      return planResult(plan, args, {
        mode: report.mode,
        sources: report.sources,
        generatedAt: report.generatedAt,
        calls: report.calls,
        items: report.items.map((item) => ({
          key: item.key,
          title: item.title,
          status: item.status,
          doi: item.doi,
          doiSource: item.doiSource,
          doiSimilarity: item.doiSimilarity,
          doiFallback: item.doiFallback,
          enabledSources: item.enabledSources,
          attempts: item.attempts,
          intel: item.intel,
          fields: item.fields,
          tags: item.tags,
          skipped: item.skipped,
          calls: item.calls,
        })),
      });
    },
  },
  {
    name: 'zotero_client',
    title: '插件通道（同步 / 定位）',
    description:
      '调用薄插件在 Zotero 自带 HTTP 服务器上暴露的端点：mode=health 返回插件版本、端点清单与同步状态；mode=sync 触发一次后台同步并回报 {running, lastSync} 供轮询；mode=reveal 返回 zotero:// 深链接文本（给 page 时是 open-pdf 链接，页码为 Zotero 的 1-based 口径），插件可用时还会让 Zotero 主窗口直接选中该条目；mode=recognize 默认只输出「将对哪些 key 调用 Zotero 识别器」的只读计划与写前快照路径，dryRun=false + confirm="OVERWRITE" 且服务端 ZOTERO_MCP_WRITE=on 时才调用插件的 /zoteromcp/recognize-pdf 就地补全元数据，并逐条给出识别前后可见字段的 before → after 对照。插件未安装、token 未配置或 token 不匹配、HTTP 服务器未开启时一律如实降级为 {pluginAvailable:false, reason, hint}，绝不假装成功；深链接不依赖插件，永远可用。除 mode=recognize 的写路径外，本工具不进入写安全管线、不产生审计与快照。',
    inputSchema: {
      mode: z.enum(PLUGIN_CLIENT_MODES).describe('health 看插件与同步状态；sync 触发一次同步；reveal 生成深链接并尽力让 Zotero 选中条目；recognize 调用 Zotero 自己的识别器补全 PDF 元数据'),
      key: z.string().min(1).optional().describe('mode=reveal 必填：条目 key'),
      page: z.number().int().min(1).optional().describe('mode=reveal：1-based 页码，给了就返回 zotero://open-pdf 深链接'),
      annotation: z.string().min(1).optional().describe('mode=reveal：注释 key，会作为 &annotation= 追加到深链接'),
      keys: z.array(z.string().min(1)).min(1).optional().describe('mode=recognize 必填：要识别的条目 key 列表'),
      dryRun: DRY_RUN_SCHEMA,
      confirm: CONFIRM_SCHEMA,
    },
    handler: async (args) => {
      const mode = args['mode'] as (typeof PLUGIN_CLIENT_MODES)[number];
      if (mode === 'health') return { mode, ...(await pluginHealth(channelOptions())) };
      if (mode === 'sync') return { mode, ...(await pluginSync(channelOptions())) };
      if (mode === 'recognize') {
        const keys = Array.isArray(args['keys']) ? (args['keys'] as string[]) : [];
        if (keys.length === 0) throw new Error('mode=recognize 必须提供 keys');
        // 缺 confirm 必须在**发出任何请求之前**被拒绝（连只读计划都不生成）
        if (args['dryRun'] === false) {
          assertWriteEnabled();
          if (args['confirm'] !== RECOGNIZE_CONFIRM_KEYWORD) {
            throw new Error(`识别会就地改写元数据，必须携带 confirm="${RECOGNIZE_CONFIRM_KEYWORD}"`);
          }
        }
        const plan = await buildRecognizePlan({ ...channelOptions(), keys });
        const preview = { planId: plan.planId, pluginAvailable: plan.pluginAvailable, reason: plan.reason, hint: plan.hint, guide: plan.guide, targets: plan.targets, snapshotPath: plan.snapshotPath, summary: plan.summary };
        if (args['dryRun'] !== false) return { mode, dryRun: true, ...preview, writeEnabled: isWriteEnabled() };
        assertWriteEnabled();
        const applied = await applyRecognize(plan, {
          ...channelOptions(),
          auditDir: resolveAuditDir(),
          write: true,
          ...(typeof args['confirm'] === 'string' ? { confirm: args['confirm'] } : {}),
        });
        return { mode, dryRun: false, ...preview, ...applied };
      }
      const key = typeof args['key'] === 'string' ? args['key'].trim() : '';
      if (key.length === 0) throw new Error('mode=reveal 必须提供 key');
      const deepLink = revealDeepLink({
        key,
        ...(typeof args['page'] === 'number' ? { page: args['page'] } : {}),
        ...(typeof args['annotation'] === 'string' ? { annotation: args['annotation'] } : {}),
      });
      const selection = await pluginSelectItems(key, channelOptions());
      return {
        mode,
        deepLink,
        pluginAvailable: selection.pluginAvailable,
        reason: selection.reason,
        hint: selection.hint,
        selected: selection.selected,
        note:
          selection.selected
            ? '已让 Zotero 主窗口选中该条目。'
            : selection.note ?? '未让 Zotero 选中条目：可直接打开上面的深链接。',
      };
    },
  },
];

/** 本版本交付的默认嵌入模型 id（换模型属 D5 的显式可选项）。 */
const DEFAULT_INDEX_MODEL_ID = DEFAULT_INDEX_MODEL.id;

/**
 * 索引工具（路线图工具面 22）。
 *
 * **只读工具**：它不写文库、不写审计、不需要 `ZOTERO_MCP_WRITE`；写入的只有本地缓存
 * （`cache/index/` 的向量库与 `cache/models/` 的模型文件）。因此它不进默认只读总闸。
 */
export const INDEX_TOOLS: ToolDefinition[] = [
  {
    name: 'zotero_index',
    title: '语义索引（本地向量库）',
    description:
      '构建 / 更新 / 查看本地语义索引：action=build 全量重建，action=update 按库级版本增量更新（内容指纹未变的条目跳过，连续两次 update 不重复嵌入），action=status 只回报现状（含页码来源分布 pageLabels.precise / pageLabels.estimated）。索引只读文库：正文来自 Zotero 的全文端点；精确页边界取自全文自带的分页符（U+000C，个数等于 indexedPages-1），PDF（unpdf，MIT）只用来取 /PageLabels 给这些边界命名，页标签与阅读器显示口径一致（空表项回退页序）。拿不到 PDF 只影响命名：标签按页序合成、页边界仍精确、pageLabelEstimated 保持 false；只有全文没有分页符、分页符个数与页数不符或存在没有任何可读文本的页时才如实退回线性估算并标 true——解析失败不会让建索引失败。向量与模型只落本地缓存（cache/index 与 cache/models），不写文库、不写审计、不需要 ZOTERO_MCP_WRITE。模型缺失时会按需下载（可用 downloadModel=false 禁止），拿不到时如实回报不可用原因。',
    inputSchema: {
      action: z.enum(['build', 'update', 'status']).describe('build 全量重建；update 增量；status 只读回报现状'),
      model: z.string().min(1).optional().describe('嵌入模型（缺省 all-MiniLM-L6-v2-quantized，即英文基线；chinese / zh / bge-small-zh-v1.5-quantized 用中文模型；multilingual / multi / paraphrase-multilingual-MiniLM-L12-v2-quantized 用 XLM-R 系多语种模型（SentencePiece unigram 分词器，中英兼顾）；未知值会被拒绝且不回落缺省）'),
      since: z.number().int().min(0).optional().describe('update 时可显式指定增量水位（缺省用索引里记录的水位）'),
      downloadModel: z.boolean().optional().describe('缺省 true：模型缺失时按需下载；false 时只用本地已有模型'),
    },
    handler: async (args) => {
      const action = args['action'] as 'build' | 'update' | 'status';
      const downloadModel = args['downloadModel'] !== false;
      const requestedModel = typeof args['model'] === 'string' ? args['model'].trim() : '';
      // 换模型会改变向量维度并触发整库重建（Q1 起支持中文模型）。未知值由 resolveModelSpec 可读拒绝，
      // **不回落缺省**——静默回落会让人以为在用中文模型、实际仍是英文索引。
      if (requestedModel.length > 0) resolveModelSpec(requestedModel);
      const modelOption = requestedModel.length > 0 ? { model: requestedModel } : {};
      try {
        if (action === 'status') return { action, ...indexStatus(modelOption) };
        const since = typeof args['since'] === 'number' ? args['since'] : undefined;
        const report =
          action === 'build'
            ? await buildIndex({ downloadModel, ...modelOption, ...(since === undefined ? {} : { since }) })
            : await updateIndex({ downloadModel, ...modelOption, ...(since === undefined ? {} : { since }) });
        // report 自带 action 字段，这里不再重复指定
        return { ok: true, ...report };
      } catch (error) {
        if (error instanceof IndexUnavailableError) {
          return { action, ok: false, degraded: true, reason: error.reason };
        }
        throw error;
      }
    },
  },
];

/**
 * 写作工具（路线图工具面 23）。
 *
 * **只写本地文件**：它把引用与参考文献块以 Word 域代码写进调用方指定的 `.docx`，
 * 不写文库、不写审计，因此与 `zotero_index` 一样**不进**默认只读总闸；它自己仍有
 * `dryRun` 缺省 true 的保护。引用数据全部来自本地 API 的只读请求。
 */
export const WRITING_TOOLS: ToolDefinition[] = [
  {
    name: 'zotero_inject_citations',
    title: '引用写作集成（Word 域代码注入）',
    description:
      '把 Zotero 引用以 Word 域代码写进 .docx：文档中的 {{zotero:名称}} / {{zotero:KEY1,KEY2}} 占位符会被替换成 ADDIN ZOTERO_ITEM CSL_CITATION 域，{{zotero:bibliography}} 处写入 ADDIN ZOTERO_BIBL 参考文献块（没有该占位符时落在文末）；文档在 Word 中执行 Zotero → Refresh 后成为受管引用。mapping 给出「占位符名 → 条目 key」，条目数据取自本地 API 的 format=csljson 与官方格式化输出，不会在客户端重实现 CSL 渲染。只重写 word/document.xml，其余 ZIP 条目逐字节保留；默认 dryRun=true 只返回计划，dryRun=false 且 outPath 缺省时原地写回并先把原文件备份为 <docxPath>.bak。docxPath 不存在时按 mapping 生成一份最小文档。占位符命中 0 次或多次、文件不是合法 .docx、取不到条目数据时一律如实拒绝并给出 CSL / BibTeX / RIS 文本作为替代产物，绝不假装注入成功。',
    inputSchema: {
      docxPath: z.string().min(1).describe('目标 .docx 路径；不存在时按 mapping 生成一份最小文档再注入'),
      mapping: z
        .record(
          z.string().min(1),
          z.union([
            z.string().min(1),
            z.array(z.string().min(1)).min(1),
            z.object({
              keys: z.array(z.string().min(1)).min(1).describe('该引用组包含的条目 key'),
              locator: z.string().optional().describe('定位符（如页码 "12" 或 "12-14"）'),
              label: z.string().optional().describe('定位符类型（如 page / chapter）'),
              prefix: z.string().optional().describe('引用前缀'),
              suffix: z.string().optional().describe('引用后缀'),
              suppressAuthor: z.boolean().optional().describe('true 时只输出年份等非作者部分'),
            }),
          ]),
        )
        .optional()
        .describe('占位符名 → 引用条目；占位符里直接写 key（含逗号时按内联列表解析）时可以省略'),
      style: z.string().min(1).optional().describe('CSL 样式 id（缺省 chicago-shortened-notes-bibliography），透传给本地 API'),
      locale: z.string().min(1).optional().describe('CSL 语言（缺省 en-US），透传给本地 API'),
      outPath: z.string().min(1).optional().describe('输出路径；缺省原地写回 docxPath 并先备份为 <docxPath>.bak'),
      overwrite: z.boolean().optional().describe('允许覆盖已存在的输出 / 备份文件，缺省 false'),
      dryRun: z
        .boolean()
        .optional()
        .describe(
          '默认 true：只返回计划（目标文件、命中的占位符与位置、引用组、参考文献块位置、是否新建），不写任何文件；false 才写盘。本工具只写本地 .docx，不写文库，因此不受 ZOTERO_MCP_WRITE 约束。',
        ),
    },
    handler: async (args) => {
      const docxPath = typeof args['docxPath'] === 'string' ? args['docxPath'].trim() : '';
      if (docxPath.length === 0) throw new Error('必须提供 docxPath');
      const rawMapping = args['mapping'];
      const options = {
        ...channelOptions(),
        docxPath,
        ...(rawMapping === undefined || rawMapping === null
          ? {}
          : { mapping: rawMapping as Parameters<typeof normalizeMapping>[0] }),
        ...(typeof args['style'] === 'string' && args['style'].trim().length > 0 ? { style: args['style'].trim() } : {}),
        ...(typeof args['locale'] === 'string' && args['locale'].trim().length > 0 ? { locale: args['locale'].trim() } : {}),
        ...(typeof args['outPath'] === 'string' && args['outPath'].trim().length > 0 ? { outPath: args['outPath'].trim() } : {}),
        ...(args['overwrite'] === true ? { overwrite: true } : {}),
        dryRun: args['dryRun'] !== false,
      };
      return await injectCitations(options);
    },
  },
];

/**
 * 合并工具（路线图工具面 19）。
 *
 * 合并由薄插件调用 Zotero 自己的 `mergeItems.mjs` 完成；本工具负责计划、门禁、快照与回读，
 * 默认 dry-run，破坏性操作需要 `confirm="MERGE"`，**插件侧还会再弹一次 Zotero 确认框**。
 */
export const MERGE_TOOLS: ToolDefinition[] = [
  {
    name: 'zotero_merge_duplicates',
    title: '合并重复条目',
    description:
      '把显式给出的 mergeKeys 合并到 primaryKey：先读全部参与条目的完整 JSON 产出影响面与写前快照，提交时要求 dryRun=false + confirm="MERGE" 且服务端 ZOTERO_MCP_WRITE=on，快照先落盘再调用插件端点（插件会调用 Zotero 自己的合并实现，并在合并前再弹一次 Zotero 确认框）；合并后被合并条目进垃圾箱（可恢复，也可用 Zotero 的撤销），合并完成后回读主记录并写审计 JSONL。插件不可用时只输出候选清单与人工合并指引，不执行合并。',
    inputSchema: {
      primaryKey: z.string().min(1).describe('主记录条目 key（合并后保留的那条）'),
      mergeKeys: z.array(z.string().min(1)).min(1).describe('要合并进主记录的条目 key 列表（不得包含 primaryKey）'),
      dryRun: DRY_RUN_SCHEMA,
      confirm: CONFIRM_SCHEMA,
    },
    handler: async (args) => {
      // 缺 confirm 必须在**发出任何请求之前**被拒绝（连只读计划都不生成）
      if (args['dryRun'] === false) {
        assertWriteEnabled();
        if (args['confirm'] !== MERGE_CONFIRM_KEYWORD) {
          throw new Error(`合并是破坏性操作，必须携带 confirm="${MERGE_CONFIRM_KEYWORD}"`);
        }
      }
      const plan = await buildMergePlan({
        ...channelOptions(),
        primaryKey: args['primaryKey'] as string,
        mergeKeys: args['mergeKeys'] as string[],
      });
      const preview = {
        planId: plan.planId,
        primaryKey: plan.primaryKey,
        mergeKeys: plan.mergeKeys,
        pluginAvailable: plan.pluginAvailable,
        reason: plan.reason,
        hint: plan.hint,
        guide: plan.guide,
        summary: plan.summary,
        impacts: plan.impacts,
        snapshotPath: plan.snapshotPath,
      };
      if (args['dryRun'] !== false) {
        return { dryRun: true, writeEnabled: isWriteEnabled(), changed: plan.pluginAvailable, ...preview };
      }
      assertWriteEnabled();
      const applied = await applyMerge(plan, {
        ...channelOptions(),
        auditDir: resolveAuditDir(),
        write: true,
        ...(typeof args['confirm'] === 'string' ? { confirm: args['confirm'] } : {}),
      });
      return { dryRun: false, ...preview, ...applied };
    },
  },
];

/** 已注册的公开工具：读 10 + 写 / 整理 9 + 研究 2 + 合并 1 + 索引 1 + 写作 1 = 24 个（路线图要求不超过 24）。 */
export const ALL_TOOLS: ToolDefinition[] = [...READ_TOOLS, ...WRITE_TOOLS, ...RESEARCH_TOOLS, ...MERGE_TOOLS, ...INDEX_TOOLS, ...WRITING_TOOLS];

export const READ_TOOL_NAMES = READ_TOOLS.map((tool) => tool.name);

/** 写 / 整理工具名单（工具面 11–18，加注释写入工具 `zotero_attach_annotations`）。 */
export const WRITE_TOOL_NAMES = WRITE_TOOLS.map((tool) => tool.name);

/** 写工具名单的集合形式：服务器注册层用它统一施加「默认只读」总闸。 */
export const WRITE_TOOL_NAME_SET: ReadonlySet<string> = new Set(WRITE_TOOL_NAMES);

/** 研究工具名单（工具面 19）。 */
export const RESEARCH_TOOL_NAMES = RESEARCH_TOOLS.map((tool) => tool.name);

/**
 * 受「默认只读」总闸约束的工具：9 个写 / 整理工具（含注释写入 `zotero_attach_annotations`）+ 1 个研究工具。
 * `zotero_enrich` 可以提交写入，因此 `dryRun=false` 时同样必须在任何请求之前被总闸拦下。
 */
/** 合并工具名单（工具面 19；破坏性写操作，同样受默认只读总闸约束）。 */
export const MERGE_TOOL_NAMES = MERGE_TOOLS.map((tool) => tool.name);

/**
 * 索引工具名单（工具面 22）。
 *
 * 注意：`zotero_index` **不在**默认只读总闸里——它只读文库、写的是本地缓存（向量库与模型文件），
 * 与 `ZOTERO_MCP_WRITE` 无关。
 */
export const INDEX_TOOL_NAMES = INDEX_TOOLS.map((tool) => tool.name);

/**
 * 写作工具名单（工具面 23）。
 *
 * 注意：`zotero_inject_citations` **不在**默认只读总闸里——它只写调用方指定的本地
 * `.docx`，不写文库，与 `ZOTERO_MCP_WRITE` 无关；`dryRun` 缺省 true 由工具自身保证。
 */
export const WRITING_TOOL_NAMES = WRITING_TOOLS.map((tool) => tool.name);

export const GATED_TOOL_NAME_SET: ReadonlySet<string> = new Set([...WRITE_TOOL_NAMES, ...RESEARCH_TOOL_NAMES, ...MERGE_TOOL_NAMES]);

export const TOOL_NAMES = ALL_TOOLS.map((tool) => tool.name);

