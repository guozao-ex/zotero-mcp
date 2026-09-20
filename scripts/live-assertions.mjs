#!/usr/bin/env node
/**
 * 真实文库断言（M1 退出条件：不少于 30 条断言）。
 *
 * - 只读：全部请求都是 GET，不修改文库；
 * - 缺样本的断言记 skipped 并写明缺少什么，既不算通过也不算失败；
 * - 有 failed 时退出码为 1，否则为 0。
 */

import {
  findDuplicateCandidates,
  getFulltextIndex,
  getItems,
  listCollections,
  listTags,
  libraryStats,
  exportItems,
  probeLocalApi,
  readContent,
  resolveBaseUrl,
  searchItems,
  validateBib,
} from '../packages/core/src/index.ts';
import { auditBibYears, describeBibYears } from './live-bib-check.mjs';

const baseUrl = resolveBaseUrl();
const requests = [];
const fetchImpl = async (input, init) => {
  requests.push({ method: (init?.method ?? 'GET').toUpperCase(), url: String(input) });
  return fetch(input, init);
};

const results = [];
function record(name, status, detail) {
  results.push({ name, status, detail });
}
async function check(name, fn) {
  try {
    const outcome = await fn();
    if (outcome && typeof outcome === 'object' && 'skipped' in outcome) {
      record(name, 'skipped', outcome.skipped);
    } else {
      record(name, 'passed', typeof outcome === 'string' ? outcome : '');
    }
  } catch (error) {
    record(name, 'failed', error instanceof Error ? error.message : String(error));
  }
}

const channel = { baseUrl, fetchImpl };

// ── 环境 ────────────────────────────────────────────────────────────────
const probe = await probeLocalApi({ baseUrl });
await check('探针可达', () => (probe.reachable ? 'reachable=true' : Promise.reject(new Error('23119 无响应'))));
await check('探针 HTTP 200', () => (probe.statusCode === 200 ? `status=${probe.statusCode}` : Promise.reject(new Error(`status=${probe.statusCode}`))));
await check('serverID 已知', () => (probe.serverId !== 'unknown' ? probe.serverId : Promise.reject(new Error('serverId=unknown'))));
await check('写能力可用', () => (probe.writeAvailable ? 'writeAvailable=true' : Promise.reject(new Error('writeAvailable=false'))));

// ── 库基础 ──────────────────────────────────────────────────────────────
const topItems = await searchItems({ ...channel, mode: 'keyword', query: 'a', limit: 100 })
  .then((result) => result.items)
  .catch(() => { record('顶层条目检索', 'failed', '检索失败'); return []; });
await check('顶层条目检索返回数组', () => (Array.isArray(topItems) ? `${topItems.length} 条` : Promise.reject(new Error('不是数组'))));
await check('每条检索结果都有 key', () => {
  const missing = topItems.filter((item) => typeof item.key !== 'string' || item.key.length === 0);
  return missing.length === 0 ? `${topItems.length} 条均有 key` : Promise.reject(new Error(`${missing.length} 条缺 key`));
});
await check('每条检索结果都有 itemType', () => {
  const missing = topItems.filter((item) => item.itemType === null);
  return missing.length === 0 ? 'itemType 齐备' : Promise.reject(new Error(`${missing.length} 条缺 itemType`));
});
await check('creators 字段为数组', () =>
  topItems.every((item) => Array.isArray(item.creators)) ? 'ok' : Promise.reject(new Error('creators 不是数组')));
await check('collections 字段为数组', () =>
  topItems.every((item) => Array.isArray(item.collections)) ? 'ok' : Promise.reject(new Error('collections 不是数组')));
await check('tags 字段为数组', () =>
  topItems.every((item) => Array.isArray(item.tags)) ? 'ok' : Promise.reject(new Error('tags 不是数组')));

// ── 集合 ────────────────────────────────────────────────────────────────
const collections = await listCollections(channel).catch(() => { record('集合读取', 'failed', '请求失败'); return { tree: [], flat: [] }; });
await check('集合返回 tree 与 flat', () =>
  Array.isArray(collections.tree) && Array.isArray(collections.flat)
    ? `flat=${collections.flat.length}`
    : Promise.reject(new Error('缺少 tree/flat')));
await check('flat 与 tree 节点数一致', () =>
  collections.flat.length >= collections.tree.length
    ? `${collections.tree.length} 顶层 / ${collections.flat.length} 总数`
    : Promise.reject(new Error('flat 少于 tree')));
await check('集合节点带可读路径', () =>
  collections.flat.every((node) => node.path.startsWith('/')) ? 'ok' : Promise.reject(new Error('路径不合法')));
await check('集合计数为数字或 null', () =>
  collections.flat.every((node) => node.itemCount === null || typeof node.itemCount === 'number')
    ? 'ok'
    : Promise.reject(new Error('itemCount 类型异常')));

// ── 标签 ────────────────────────────────────────────────────────────────
const tags = await listTags(channel).catch(() => { record('标签读取', 'failed', '请求失败'); return []; });
await check('标签返回数组', () => (Array.isArray(tags) ? `${tags.length} 个` : Promise.reject(new Error('不是数组'))));
await check('标签项带 tag 字段', () =>
  tags.every((tag) => typeof tag.tag === 'string' && tag.tag.length > 0) ? 'ok' : Promise.reject(new Error('tag 字段缺失')));
await check('标签频次为数字或 null', () =>
  tags.every((tag) => tag.itemCount === null || typeof tag.itemCount === 'number') ? 'ok' : Promise.reject(new Error('频次类型异常')));

// ── 搜索 ────────────────────────────────────────────────────────────────
const keyword = await searchItems({ ...channel, mode: 'keyword', query: 'e', limit: 5 }).catch(() => { record('keyword 搜索', 'failed', '请求失败'); return { mode: 'keyword', path: '', total: null, items: [] }; });
await check('keyword 搜索返回结构完整', () =>
  keyword.mode === 'keyword' && typeof keyword.path === 'string' && Array.isArray(keyword.items) ? 'ok' : Promise.reject(new Error('结构不完整')));
await check('keyword 使用标题/作者/年份模式', () =>
  keyword.path.includes('qmode=titleCreatorYear') ? 'ok' : Promise.reject(new Error(keyword.path)));
await check('搜索 limit 生效', () =>
  keyword.items.length <= 5 ? `${keyword.items.length} ≤ 5` : Promise.reject(new Error(`返回 ${keyword.items.length} 条`)));

const fulltext = await searchItems({ ...channel, mode: 'fulltext', query: 'e', limit: 5 }).catch(() => { record('fulltext 搜索', 'failed', '请求失败'); return { mode: 'fulltext', path: '', total: null, items: [] }; });
await check('fulltext 使用全文模式', () =>
  fulltext.path.includes('qmode=everything') ? 'ok' : Promise.reject(new Error(fulltext.path)));

const savedSearches = await fetch(`${baseUrl}/api/users/0/searches?limit=5`, { headers: { accept: 'application/json' } })
  .then((response) => response.json())
  .catch(() => []);
const firstSaved = Array.isArray(savedSearches) ? savedSearches[0] : undefined;
await check('saved 搜索走本地独有端点', async () => {
  if (firstSaved === undefined) return { skipped: '库中没有保存搜索' };
  const saved = await searchItems({ ...channel, mode: 'saved', savedSearchKey: firstSaved.key });
  if (!saved.path.startsWith(`/api/users/0/searches/${firstSaved.key}/items`)) {
    throw new Error(`路径不符：${saved.path}`);
  }
  return `${saved.path}（${saved.items.length} 条）`;
});

// ── 条目详情与注释 ──────────────────────────────────────────────────────
const sampleKeys = topItems.slice(0, 5).map((item) => item.key);
const details = sampleKeys.length === 0
  ? []
  : await getItems({ ...channel, keys: sampleKeys, include: ['attachments', 'annotations', 'notes', 'collections', 'tags'] });
await check('批量读取返回条目详情', () => {
  if (sampleKeys.length === 0) return { skipped: '库中还没有条目（先在 Zotero 里导入文献）' };
  return details.length === sampleKeys.length
    ? `${details.length} 条`
    : Promise.reject(new Error(`期望 ${sampleKeys.length}，得到 ${details.length}`));
});
await check('详情包含 itemType 与 version', () =>
  details.every((item) => item.itemType !== null && typeof item.version === 'number') ? 'ok' : Promise.reject(new Error('字段缺失')));
await check('详情 attachments/annotations/notes 为数组', () =>
  details.every((item) => Array.isArray(item.attachments) && Array.isArray(item.annotations) && Array.isArray(item.notes))
    ? 'ok'
    : Promise.reject(new Error('子项字段不是数组')));

const withPdf = details.find((item) => item.attachments.some((attachment) => attachment.isPdf));
await check('PDF 附件被识别', () => {
  if (withPdf === undefined) return { skipped: '样本条目中没有 PDF 附件' };
  const pdf = withPdf.attachments.find((attachment) => attachment.isPdf);
  return `${withPdf.key} → ${pdf?.key}`;
});

const withAnnotation = details.find((item) => item.annotations.length > 0);
await check('注释深链接格式正确', () => {
  if (withAnnotation === undefined) return { skipped: '样本条目中没有注释（需在 PDF 中做高亮/批注）' };
  const annotation = withAnnotation.annotations[0];
  if (!annotation.deepLink.startsWith('zotero://open-pdf/library/items/')) {
    throw new Error(`深链接异常：${annotation.deepLink}`);
  }
  return annotation.deepLink;
});
await check('注释带页码标注', () => {
  if (withAnnotation === undefined) return { skipped: '样本条目中没有注释' };
  const annotation = withAnnotation.annotations[0];
  if (annotation.pageLabel === null || annotation.pageLabel.length === 0) {
    throw new Error('annotationPageLabel 为空');
  }
  return `page=${annotation.pageLabel}`;
});

// ── 内容与全文索引 ──────────────────────────────────────────────────────
await check('mode=path 解析本地文件路径', async () => {
  if (withPdf === undefined) return { skipped: '样本条目中没有 PDF 附件' };
  const pdf = withPdf.attachments.find((attachment) => attachment.isPdf);
  const content = await readContent({ ...channel, key: pdf.key, mode: 'path' });
  if (content.source !== 'redirect-302' || !content.path || content.path.length === 0) {
    throw new Error(`未取到 302 路径：${JSON.stringify(content)}`);
  }
  return content.path;
});
await check('mode=fulltext 返回正文', async () => {
  if (withPdf === undefined) return { skipped: '样本条目中没有 PDF 附件' };
  const pdf = withPdf.attachments.find((attachment) => attachment.isPdf);
  const content = await readContent({ ...channel, key: pdf.key, mode: 'fulltext' });
  if ((content.content ?? '').length === 0) {
    throw new Error('全文为空（可能尚未建立全文索引）');
  }
  return `${content.content.length} 字符`;
});

let index = {};
await check('全文索引清单可读取（since=0）', async () => {
  index = await getFulltextIndex({ ...channel, since: 0 });
  return typeof index === 'object' && index !== null ? `${Object.keys(index).length} 个缓存项` : Promise.reject(new Error('不是对象'));
});

// ── 统计与重复候选 ──────────────────────────────────────────────────────
const stats = await libraryStats(channel).catch(() => { record('库健康度', 'failed', '请求失败'); return { totalItems: -1, missingPdf: -1, missingDoi: -1, missingMetadata: -1, unfiled: -1, duplicateCreators: -1, byItemType: {} }; });
await check('统计：totalItems 为数字', () =>
  typeof stats.totalItems === 'number' ? String(stats.totalItems) : Promise.reject(new Error('类型异常')));
await check('统计：missingPdf 不超过总数', () =>
  stats.missingPdf <= stats.totalItems ? `${stats.missingPdf}/${stats.totalItems}` : Promise.reject(new Error('计数异常')));
await check('统计：missingDoi 不超过总数', () =>
  stats.missingDoi <= stats.totalItems ? `${stats.missingDoi}/${stats.totalItems}` : Promise.reject(new Error('计数异常')));
await check('统计：unfiled 不超过总数', () =>
  stats.unfiled <= stats.totalItems ? `${stats.unfiled}/${stats.totalItems}` : Promise.reject(new Error('计数异常')));
await check('统计：byItemType 为对象', () =>
  typeof stats.byItemType === 'object' ? Object.keys(stats.byItemType).join(',') || '（空库）' : Promise.reject(new Error('类型异常')));

const duplicates = await findDuplicateCandidates(channel).catch(() => { record('重复候选', 'failed', '请求失败'); return []; });
await check('重复候选返回数组', () => (Array.isArray(duplicates) ? `${duplicates.length} 簇` : Promise.reject(new Error('不是数组'))));
await check('重复簇结构与建议主记录', () =>
  duplicates.every((cluster) => cluster.items.length > 1 && typeof cluster.suggestedPrimary === 'string')
    ? 'ok'
    : Promise.reject(new Error('簇结构异常')));

// ── 导出 ────────────────────────────────────────────────────────────────
const exportKeys = topItems.slice(0, 2).map((item) => item.key);
await check('导出 .bib 并通过结构校验', async () => {
  if (exportKeys.length === 0) return { skipped: '库中还没有条目' };
  // 逐条导出：这样每条导出文本只含一个条目，条目 key 与 .bib 引用键一一对应
  // （装了 Better BibTeX 的库里两者并不相同，不能拿条目 key 去比引用键）。
  // 日期必须取 getItems 的 data.date——searchItems 返回的 ItemSummary 没有 data 字段。
  const details = await getItems({ ...channel, keys: exportKeys });
  const detailByKey = new Map(details.map((detail) => [detail.key, detail]));
  const entries = [];
  for (const key of exportKeys) {
    const single = await exportItems({ ...channel, keys: [key], format: 'bib' });
    const date = detailByKey.get(key)?.data?.['date'];
    entries.push({
      key,
      hasDate: typeof date === 'string' && date.trim().length > 0,
      // 放宽 year 只在调用方核对过真实日期之后才允许；结构性规则（条目头 / 花括号 / title / author）仍然强制
      validation: validateBib(single.content, { requireYear: false }),
    });
  }
  const result = auditBibYears(entries);
  if (result.failures.length > 0) throw new Error(result.failures.join('；'));
  return describeBibYears(result);
});
await check('导出 citation 透传 style 与 locale', async () => {
  if (exportKeys.length === 0) return { skipped: '库中还没有条目' };
  const citation = await exportItems({ ...channel, keys: exportKeys, format: 'citation', style: 'apa', locale: 'zh-CN' });
  if (!citation.path.includes('style=apa') || !citation.path.includes('locale=zh-CN')) {
    throw new Error(`参数未透传：${citation.path}`);
  }
  return citation.content.trim().slice(0, 60);
});
await check('导出 csljson 结构化数组', async () => {
  if (exportKeys.length === 0) return { skipped: '库中还没有条目' };
  const csl = await exportItems({ ...channel, keys: exportKeys, format: 'csljson' });
  if (!Array.isArray(csl.data) || csl.data.some((entry) => typeof entry.id !== 'string')) {
    throw new Error('csljson 结构异常');
  }
  return `${csl.data.length} 条`;
});

// ── 只读保证 ────────────────────────────────────────────────────────────
await check('全程只读（均为 GET）', () => {
  const nonGet = requests.filter((entry) => entry.method !== 'GET');
  return nonGet.length === 0 ? `${requests.length} 次请求均为 GET` : Promise.reject(new Error(`出现 ${nonGet.length} 次非 GET 请求`));
});
await check('只访问回环本地 API', () => {
  const foreign = requests.filter((entry) => !entry.url.startsWith(baseUrl));
  return foreign.length === 0 ? 'ok' : Promise.reject(new Error(`越界请求：${foreign[0]?.url}`));
});

// ── 输出 ────────────────────────────────────────────────────────────────
const passed = results.filter((result) => result.status === 'passed').length;
const failed = results.filter((result) => result.status === 'failed').length;
const skipped = results.filter((result) => result.status === 'skipped').length;

console.log('真实文库断言报告（M1: read-surface）');
console.log(`目标：${baseUrl}  断言总数：${results.length}`);
console.log('');
for (const result of results) {
  const mark = result.status === 'passed' ? '✔' : result.status === 'skipped' ? '○' : '✘';
  console.log(`${mark} [${result.status}] ${result.name}${result.detail ? ` — ${result.detail}` : ''}`);
}
console.log('');
console.log(`通过 ${passed} / 跳过 ${skipped} / 失败 ${failed}（总 ${results.length}）`);
if (skipped > 0) console.log('跳过的断言缺少样本，需在库中补齐对应内容后再跑。');
if (results.length < 30) {
  console.error(`断言数量不足 30（当前 ${results.length}）`);
  process.exitCode = 1;
} else {
  // 用 exitCode 而不是 process.exit()：避免在 fetch 句柄关闭竞态中触发 libuv 断言
  process.exitCode = failed === 0 ? 0 : 1;
}
