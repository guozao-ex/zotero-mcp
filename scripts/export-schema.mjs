#!/usr/bin/env node
/**
 * 导出契约层的 JSON Schema（供 Zotero 插件侧共享类型）。
 *
 * 输出目录：packages/core/schema/<name>.schema.json
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { exportJsonSchemas } from '../packages/core/src/index.ts';

const OUTPUT_DIR = new URL('../packages/core/schema/', import.meta.url);
const OUTPUT_DIR_PATH = fileURLToPath(OUTPUT_DIR);

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const schemas = exportJsonSchemas();
  const names = Object.keys(schemas);
  for (const name of names) {
    const file = new URL(`${name}.schema.json`, OUTPUT_DIR);
    await writeFile(file, `${JSON.stringify(schemas[name], null, 2)}\n`, 'utf8');
  }
  console.log(`已导出 ${names.length} 个 JSON Schema 到 ${OUTPUT_DIR_PATH}`);
  for (const name of names) console.log(`  - packages/core/schema/${name}.schema.json`);
}

await main();
