#!/usr/bin/env node
/**
 * 通过插件写入一条注释（路线图 G1 的真机取证入口）。
 *
 *   npm run plugin:annotate -- --attachment <附件 KEY> --page 1 --text "高亮文字" --rects "x1,y1,x2,y2[;…]" [--comment ""] [--color "#ffd400"]
 *
 * `--rects` **必填**：Zotero 的注释以 position 为落位依据（`text` 只是元数据），
 * 位置与正文不一致的高亮在阅读器里就是“出现在别处”。
 *
 * 前置条件（插件侧 fail-closed）：
 *   1. 插件已安装并注册 `/zoteromcp/annotations`（六条端点之一）；
 *   2. `<Zotero 数据目录>/zoteromcp-token.txt` 存在且与本地一致；
 *   3. **在 Zotero「设置 → 高级 → 配置编辑器」里把 `extensions.zoteromcp.enableAnnotations` 设为 true**
 *      并重启 Zotero —— 默认关闭，未开启时本脚本会打印开启方法并**退出 3**（区别于写入失败的退出码 1）。
 *
 * 写入后请在 Zotero 阅读器里目视确认「注释可见」，并重启 Zotero 后再确认一次（路线图 G1 的第 3 条）。
 */

import { PLUGIN_ENDPOINTS, requestPluginAnnotations, resolveDataDir } from '../packages/core/src/index.ts';

const argv = process.argv.slice(2);
const valueOf = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : argv[index + 1] ?? null;
};

const attachmentKey = (valueOf('attachment') ?? '').trim();
const page = Number(valueOf('page') ?? '1');
const text = valueOf('text') ?? '';
const comment = valueOf('comment') ?? '';
const color = valueOf('color') ?? '#ffd400';
const rectsArg = valueOf('rects');

if (attachmentKey.length === 0 || !Number.isInteger(page) || page < 1 || rectsArg === null) {
  console.error('用法：npm run plugin:annotate -- --attachment <附件 KEY> --page <页码> --text "高亮文字" --rects "x1,y1,x2,y2[;…]" [--comment ""] [--color "#ffd400"]');
  console.error('');
  console.error('⚠️ --rects 是必填：Zotero 的注释按 position 落位（text 只是元数据），');
  console.error('   随便给一个矩形会让高亮出现在与正文无关的位置。坐标要来自真实文字区域，例如：');
  console.error('   - 用只读 API 取同一附件下既有注释的 annotationPosition.rects 复用；');
  console.error('   - 或由 PDF 阅读器/Zotero 阅读器的调试工具读出选区坐标。');
  process.exit(2);
}

// 只接受调用方显式给出的真实文字区域坐标（见上面的告警）
const rects = rectsArg
  .split(';')
  .map((pair) => pair.split(',').map((value) => Number(value.trim())))
  .filter((rect) => rect.length === 4 && rect.every((value) => Number.isFinite(value)));
if (rects.length === 0) {
  console.error('--rects 必须是 `x1,y1,x2,y2[;x1,y1,x2,y2…]`');
  process.exit(2);
}

console.log(`插件端点：${PLUGIN_ENDPOINTS.join(' ')}`);
console.log(`Zotero 数据目录：${resolveDataDir()}`);
console.log('（若提示 annotations-disabled，请在 Zotero 配置编辑器里把 extensions.zoteromcp.enableAnnotations 设为 true 并重启）');

const result = await requestPluginAnnotations({
  attachmentKey,
  annotations: [
    {
      type: 'highlight',
      position: { pageIndex: page - 1, rects },
      text,
      comment,
      color,
      pageLabel: String(page),
    },
  ],
});

if (result.pluginAvailable !== true) {
  console.error(`✖ 写入失败：${result.reason}`);
  console.error(`  ${result.hint}`);
  if (result.detail !== null) console.error(`  细节：${result.detail}`);
  // 便于脚本化判断：默认关闭用专门退出码 3
  process.exit(result.reason === 'annotations-disabled' ? 3 : 1);
}

console.log('✔ 插件已创建注释：');
for (const item of result.created) {
  console.log(`   ${item.key}  ${item.type}  第 ${item.pageLabel ?? '?'} 页  深链接：zotero://open-pdf/library/items/${attachmentKey}?page=${page}&annotation=${item.key}`);
}
console.log('');
console.log('接下来请人工确认（G1 第 3 条）：① 在 Zotero 阅读器里能看到这条高亮；② 重启 Zotero 后仍在。');
