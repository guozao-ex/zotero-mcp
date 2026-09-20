#!/usr/bin/env node
/**
 * 契约测试入口。
 *
 * `npm test`                  → 运行 tests/ 下全部 *.test.mjs
 * `npm test -- contract`      → 只运行路径中包含 contract 的测试文件
 *
 * 用 node:test 作为运行器，不引入第三方测试框架。
 */

import { spawn } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['tests'];
const filters = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));

function collect(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...collect(full));
    else if (entry.endsWith('.test.mjs')) files.push(full);
  }
  return files;
}

const all = ROOTS.flatMap((root) => collect(root)).sort();
const selected =
  filters.length === 0 ? all : all.filter((file) => filters.some((filter) => file.includes(filter)));

if (selected.length === 0) {
  console.error(`没有匹配的测试文件（filters: ${filters.join(', ') || '无'}）`);
  process.exit(1);
}

console.log(`运行 ${selected.length} 个测试文件：`);
for (const file of selected) console.log(`  - ${file}`);

const child = spawn(process.execPath, ['--test', ...selected], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`测试进程被信号中断：${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
