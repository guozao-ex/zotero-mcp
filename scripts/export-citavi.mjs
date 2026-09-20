#!/usr/bin/env node
/**
 * 导出「可导入的高亮清单」（Citavi 6 交换 XML）——路线图 G2 的桥，供 GUI 会话使用。
 *
 * 用法：
 *   npm run export:citavi -- --item <条目或附件 KEY> --out <file.xml>
 *   npm run export:citavi -- --item <KEY> --out <file.xml> --overwrite
 *
 * 产出物用 Zotero 的 `File → Import` 导入（它是 Citavi 5/6 交换格式，Zotero 自带的 Citavi 导入器
 * 会据此**创建注释条目**）。已知差异写在 docs/G2_HIGHLIGHT_IMPORT.md：导入会新建条目、颜色落到
 * Citavi 调色板、可能与既有条目重复。
 *
 * 只读：全程 GET，不写库、不写审计。
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { buildCitaviAnnotationExchange, probeLocalApi } from '../packages/core/src/index.ts';

const argv = process.argv.slice(2);
const flagValue = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : argv[index + 1] ?? null;
};
const items = [];
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === '--item' || argv[index] === '--key') items.push(argv[index + 1]);
}
const outArg = flagValue('out');
const overwrite = argv.includes('--overwrite');

if (items.length === 0 || outArg === null) {
  console.error('用法：npm run export:citavi -- --item <KEY> [--item <KEY> …] --out <file.xml> [--overwrite]');
  process.exit(2);
}
const outPath = isAbsolute(outArg) ? outArg : resolve(process.cwd(), outArg);

const probe = await probeLocalApi();
if (!probe.reachable) {
  console.error(`本地 API 不可用：${probe.reason ?? '未知原因'}（请启动 Zotero 并确认允许其它应用通信）`);
  process.exit(1);
}

const exchange = await buildCitaviAnnotationExchange({ keys: items.filter((key) => typeof key === 'string' && key.length > 0) });

for (const rejected of exchange.rejected) console.error(`✖ 跳过条目 ${rejected.itemKey}：${rejected.reason}`);
for (const skipped of exchange.skipped) console.error(`✖ 跳过注释 ${skipped.annotationKey}（${skipped.itemKey}）：${skipped.reason}`);
// 类型不被 Citavi 通道保留（上游硬编码 highlight）必须逐条提示，不能静默——这是导入后会发现差异的地方
for (const issue of exchange.issues.filter((entry) => entry.kind === 'type-not-preserved')) {
  console.error(`! 类型会变：注释 ${issue.id} —— ${issue.reason}`);
}
if (exchange.entries.length === 0) {
  console.error('没有任何条目可以导出（见上面的原因）。');
  process.exit(1);
}

if (existsSync(outPath) && !overwrite) {
  console.error(`目标文件已存在，如需覆盖请加 --overwrite：${outPath}`);
  process.exit(1);
}
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, exchange.xml, 'utf8');

console.log('已导出可导入的高亮清单（Citavi 6 交换 XML）');
console.log(`  文件：${outPath}`);
for (const entry of exchange.entries) {
  console.log(`  条目 ${entry.itemKey}（${entry.title ?? '无标题'}）→ 注释 ${entry.annotationCount} 条，PDF ${entry.pdfPath}`);
}
console.log(`  共 ${exchange.annotationTotal} 条注释；跳过 ${exchange.skipped.length} 条（无坐标）。`);
console.log('');
console.log('导入方式：Zotero → 文件(File) → 导入(Import)… → 选择上面这个 XML。');
console.log('注意：导入会**新建一条条目**（导入器只给自己导入的附件建注释），注释颜色会落到 Citavi 调色板。');
