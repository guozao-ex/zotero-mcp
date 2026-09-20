#!/usr/bin/env node
/**
 * 插件打包：`npm run plugin:build`。
 *
 * 步骤：
 *   1. 校验 `packages/zotero-plugin/manifest.json` 的结构（manifest_version / applications.zotero）；
 *   2. 用 esbuild 把 `src/plugin.js`（连同 `zotero-plugin-toolkit`）内联成**单文件经典脚本**——
 *      Zotero 的 bootstrap 只能用 `loadSubScript` 加载经典脚本，而该库只发布 ESM；
 *   3. 组装 XPI 目录树（根目录即插件根目录：`manifest.json` + `bootstrap.js` + `content/`）；
 *   4. 用仓库内自写的 ZIP 写入器（零依赖）打成 `.xpi`，字节输出确定可复现。
 *
 * 产物落在 `build/`（gitignore）：`build/plugin/` 是展开后的插件目录，`build/*.xpi` 是安装包。
 * 只读保证：本脚本不访问网络、不写仓库源码、不触碰 Zotero 库。
 */

import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN_SRC = join(ROOT, 'packages', 'zotero-plugin');
const BUILD_DIR = join(ROOT, 'build');
const STAGE_DIR = join(BUILD_DIR, 'plugin');
const BUNDLE_GLOBAL = 'ZoteroMCPChannel';
const BUNDLE_REL = join('content', 'channel.js');
const GITIGNORE_ENTRIES = ['build/'];

class BuildError extends Error {}

function fail(message) {
  throw new BuildError(message);
}

// ── manifest 校验 ───────────────────────────────────────────────────────

export function validateManifest(manifest) {
  if (manifest === null || typeof manifest !== 'object') fail('manifest.json 不是对象');
  if (manifest.manifest_version !== 2) fail(`manifest_version 必须是 2，实际 ${String(manifest.manifest_version)}`);
  for (const field of ['name', 'version', 'description']) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim().length === 0) fail(`manifest.json 缺少 ${field}`);
  }
  const zotero = manifest.applications?.zotero;
  if (zotero === undefined || zotero === null) fail('manifest.json 缺少 applications.zotero（Zotero 据此决定是否允许安装）');
  if (typeof zotero.id !== 'string' || !/^[^@\s]+@[^@\s]+$/u.test(zotero.id)) fail(`applications.zotero.id 非法：${String(zotero.id)}`);
  for (const field of ['strict_min_version', 'strict_max_version', 'update_url']) {
    if (typeof zotero[field] !== 'string' || zotero[field].trim().length === 0) fail(`applications.zotero 缺少 ${field}`);
  }
  if (!/^https?:\/\//u.test(zotero.update_url)) fail(`applications.zotero.update_url 必须是 http(s) URL：${zotero.update_url}`);
  if (!zotero.strict_max_version.startsWith('10.')) {
    fail(`strict_max_version 必须覆盖 Zotero 10（当前 ${zotero.strict_max_version}）`);
  }
  return manifest;
}

// ── ZIP 写入器（store / deflate，零依赖，确定性） ────────────────────────

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** 固定时间戳：产物字节可复现（1980-01-01 00:00:00，ZIP 的最小合法值）。 */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;

/**
 * 把 `entries`（相对路径 → Buffer）打成 ZIP。
 * 条目按路径排序，时间戳固定，因此同样输入必然产出同样字节。
 */
export function writeZip(entries) {
  const names = [...entries.keys()].sort();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const name of names) {
    const data = entries.get(name);
    const nameBytes = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc32(data), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBytes, payload);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc32(data), 16);
    header.writeUInt32LE(payload.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk
    header.writeUInt16LE(0, 36); // internal attrs
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38); // external attrs：普通文件（>>> 0 避免有符号左移溢出）
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

// ── 构建 ────────────────────────────────────────────────────────────────

/**
 * 打包主逻辑（内联 zotero-plugin-toolkit）到 `<stageRoot>/content/channel.js`。
 *
 * 导出它是为了让契约测试能**构建到自己的临时目录**：`main()` 会先清空共享的
 * `build/plugin/`，两个测试文件并行重建时会互相删掉对方的产物。
 */
export async function bundle(pluginRoot, stageRoot) {
  const entry = join(pluginRoot, 'src', 'plugin.js');
  const outfile = join(stageRoot, BUNDLE_REL);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'iife',
    globalName: BUNDLE_GLOBAL,
    platform: 'browser',
    target: 'firefox140',
    legalComments: 'none',
    logLevel: 'warning',
    absWorkingDir: ROOT,
  });
  return outfile;
}

async function main() {
  const manifestPath = join(PLUGIN_SRC, 'manifest.json');
  const manifest = validateManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));

  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(STAGE_DIR, { recursive: true });

  // 包根：manifest.json + bootstrap.js（Zotero 只从包根加载这两个文件）
  const files = new Map();
  for (const name of ['manifest.json', 'bootstrap.js']) {
    const source = join(PLUGIN_SRC, name);
    const bytes = readFileSync(source);
    files.set(name, bytes);
    writeFileSync(join(STAGE_DIR, name), bytes);
  }

  const bundlePath = await bundle(PLUGIN_SRC, STAGE_DIR);
  files.set(BUNDLE_REL.replaceAll('\\', '/'), readFileSync(bundlePath));

  const zip = writeZip(files);
  const xpiName = `zotero-mcp-plugin-${manifest.version}.xpi`;
  const xpiPath = join(BUILD_DIR, xpiName);
  writeFileSync(xpiPath, zip);

  const lines = [
    `插件：${manifest.name} ${manifest.version}（${manifest.applications.zotero.id}）`,
    `兼容：Zotero ${manifest.applications.zotero.strict_min_version} – ${manifest.applications.zotero.strict_max_version}`,
    `包内文件：${[...files.keys()].sort().join('、')}`,
    `内联后的主逻辑：${(files.get('content/channel.js').length / 1024).toFixed(1)} KB（含 zotero-plugin-toolkit）`,
    `XPI：${relative(ROOT, xpiPath).replaceAll('\\', '/')}（${zip.length} 字节，sha256 ${createHash('sha256').update(zip).digest('hex').slice(0, 16)}）`,
    `展开目录：${relative(ROOT, STAGE_DIR).replaceAll('\\', '/')}/`,
  ];
  console.log(lines.join('\n'));
  console.log('\n安装：Zotero → 工具 → 插件 → 齿轮 → 从文件安装插件 → 选择上面的 .xpi，然后重启 Zotero。');
  return { manifest, xpiPath, files, bytes: zip.length };
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    console.error(`插件打包失败：${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

export { main, PLUGIN_SRC, BUILD_DIR, STAGE_DIR, BUNDLE_REL, GITIGNORE_ENTRIES, dirname };
