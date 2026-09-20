#!/usr/bin/env node
/**
 * PDF 元数据识别报告（只读）。
 *
 * 用法：
 *   node scripts/identify-report.mjs <pdf 路径或目录> [...]
 *   node scripts/identify-report.mjs --item-key <Zotero 附件 key> [--item-key ...]
 *   node scripts/identify-report.mjs <路径> --allow-missing     # 没有输入也不报错
 *
 * 输出：每个输入的逐级命中日志与结论，以及未识别清单（needs-metadata）。
 * 只读保证：识别链不写库、不产生审计或快照；退出码在有未识别项时为 1。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { identifyPdf } from '../packages/core/src/index.ts';

const argv = process.argv.slice(2);
const allowMissing = argv.includes('--allow-missing');
const itemKeys = [];
const pathArgs = [];
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--item-key') {
    const value = argv[index + 1];
    if (value !== undefined) itemKeys.push(value);
    index += 1;
    continue;
  }
  if (arg.startsWith('--')) continue;
  pathArgs.push(arg);
}

/** 目录展开成其中的 PDF 文件；非 PDF 文件忽略。 */
function collectPdfs(input) {
  const absolute = resolve(input);
  if (!existsSync(absolute)) return { files: [], missing: absolute };
  if (statSync(absolute).isDirectory()) {
    return {
      files: readdirSync(absolute)
        .filter((entry) => entry.toLowerCase().endsWith('.pdf'))
        .map((entry) => join(absolute, entry)),
      missing: null,
    };
  }
  return { files: [absolute], missing: null };
}

const targets = [];
for (const input of pathArgs) {
  const { files, missing } = collectPdfs(input);
  if (missing !== null) console.log(`跳过不存在的输入：${missing}`);
  targets.push(...files.map((file) => ({ kind: 'path', value: file })));
}
for (const key of itemKeys) targets.push({ kind: 'itemKey', value: key });

console.log('PDF 元数据识别报告（只读）');
console.log(`输入：${targets.length} 个（${pathArgs.length} 个路径参数，${itemKeys.length} 个附件 key）`);
console.log('');

if (targets.length === 0) {
  console.log('没有可识别的输入。用法：node scripts/identify-report.mjs <pdf 路径或目录> 或 --item-key <附件 key>');
  process.exitCode = allowMissing ? 0 : 1;
} else {
  const unidentified = [];
  const identified = [];
  for (const target of targets) {
    const label = target.kind === 'path' ? target.value : `itemKey=${target.value}`;
    const result = await identifyPdf(
      target.kind === 'path' ? { path: target.value } : { itemKey: target.value },
    ).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    if ('error' in result) {
      console.log(`✘ ${label}：识别失败 —— ${result.error}`);
      unidentified.push(label);
      continue;
    }
    console.log(`${result.needsMetadata ? '○' : '✔'} ${label}`);
    for (const hit of result.hits) {
      console.log(`    [${hit.ok ? '命中' : '未命中'}] ${hit.level} · ${hit.source}：${hit.detail}`);
    }
    console.log(
      `    结论：${result.needsMetadata ? '未识别（needs-metadata）' : `level=${result.level} · ${result.record?.itemType ?? ''}`}`,
    );
    if (result.needsMetadata) unidentified.push(label);
    else identified.push(label);
  }
  console.log('');
  console.log(`已识别 ${identified.length} / 未识别 ${unidentified.length}（共 ${targets.length}）`);
  if (unidentified.length > 0) {
    console.log('未识别清单（建议打 needs-metadata 标签并人工补全）：');
    for (const label of unidentified) console.log(`  - ${label}`);
    console.log('提示：可先入库为附件并打标签 —— zotero_add_items(mode=pdf, path=…) 默认即为 dry-run 降级计划。');
  }
  process.exitCode = unidentified.length === 0 ? 0 : 1;
}
