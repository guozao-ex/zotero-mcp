#!/usr/bin/env node
/**
 * 插件自检（**默认完全只读**）：Zotero 里装的插件是不是当前源码构建的那一份？
 *
 * 背景：插件本体只有三个文件（bootstrap.js / content/channel.js / manifest.json）。
 * 「要不要重装」过去靠人肉比对时间戳与哈希，容易看错——比如 `npm run plugin:build` 会把
 * build/ 与 xpi 的 mtime 刷成「刚刚」，看起来像更新了，其实内容没变。
 *
 * 判定同时看**哈希**与**时间**：
 *   - 哈希不同                      → stale-install（构建比安装新 / 内容不同：需重装）
 *   - 哈希相同但源码比构建新        → stale-build（先重建，再重装）
 *   - 哈希相同且构建不早于源码      → up-to-date
 *   - 已安装缺失 / 构建缺失          → not-installed / no-build
 *
 * 用法：npm run plugin:verify [-- --json] [-- --rebuild]
 *   --json     机器可读输出
 *   --rebuild  真的执行一次 npm run plugin:build 再复比（**会写 build/**，默认关闭）
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const PLUGIN_ID = 'zotero-mcp@guozao-ex.github.io';
export const XPI_FILENAME = 'zotero-mcp-plugin-1.0.0.xpi';
export const ANNOTATIONS_PREF = 'extensions.zoteromcp.enableAnnotations';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_FILES = [
  join(ROOT, 'packages', 'zotero-plugin', 'bootstrap.js'),
  join(ROOT, 'packages', 'zotero-plugin', 'manifest.json'),
  join(ROOT, 'packages', 'zotero-plugin', 'src', 'plugin.js'),
];

/** sha256（缺文件返回 null）。 */
export function sha256(path) {
  if (path === null || !existsSync(path)) return null;
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 判定：纯函数，便于单测。 */
export function judgePluginState({ installedHash, builtHash, builtMtimeMs, sourceChangeMs, sourceDirty = false }) {
  if (builtHash === null) return { verdict: 'no-build', next: '先跑 npm run plugin:build 生成 xpi' };
  if (installedHash === null) return { verdict: 'not-installed', next: '在 Zotero 里从文件安装 build/' + XPI_FILENAME + '，然后重启 Zotero' };
  if (installedHash !== builtHash) {
    return { verdict: 'stale-install', next: '构建产物与已安装的不是同一份：在 Zotero 里重装 build/' + XPI_FILENAME + ' 并重启' };
  }
  // 用 git 语义判断「源码是否比构建新」：**不看文件 mtime**——git checkout 会把 mtime 刷成刚刚，会误报。
  if (sourceDirty === true || (sourceChangeMs !== null && builtMtimeMs !== null && sourceChangeMs > builtMtimeMs)) {
    return {
      verdict: 'stale-build',
      next: (sourceDirty ? '插件源码有未提交改动：' : '插件源码的最近提交比构建新：') + '先 npm run plugin:build，再在 Zotero 里重装并重启',
    };
  }
  return { verdict: 'up-to-date', next: '无需操作（重装插件会重置 enableAnnotations，需重新打开）' };
}

/** 找已安装的 xpi：优先 $ZOTERO_MCP_PROFILE_DIR，其次扫 Zotero 的 profile 目录。 */
export function findInstalledXpi(env = process.env) {
  const override = env['ZOTERO_MCP_PROFILE_DIR'];
  if (override !== undefined && override !== '') {
    const direct = join(override, 'extensions', PLUGIN_ID + '.xpi');
    return existsSync(direct) ? direct : null;
  }
  const base = join(env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming'), 'Zotero', 'Zotero', 'Profiles');
  if (!existsSync(base)) return null;
  for (const profile of readdirSync(base)) {
    const candidate = join(base, profile, 'extensions', PLUGIN_ID + '.xpi');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 从 prefs.js 读注释开关（可能滞后于运行态）。 */
export function readAnnotationsPref(profileDir) {
  if (profileDir === null) return { value: null, source: null };
  const prefs = join(profileDir, 'prefs.js');
  if (!existsSync(prefs)) return { value: null, source: null };
  const text = readFileSync(prefs, 'utf8');
  const match = new RegExp('user_pref\\("' + ANNOTATIONS_PREF.replace(/\./gu, '\\.') + '",\\s*(true|false)\\)').exec(text);
  if (match === null) return { value: null, source: prefs };
  return { value: match[1] === 'true', source: prefs };
}

/** 插件源码最近一次提交时间（ms）；不在 git 仓库或查询失败返回 null。 */
export function sourceLastChangeMs() {
  const out = spawnSync('git', ['log', '-1', '--format=%ct', '--', 'packages/zotero-plugin'], { cwd: ROOT, encoding: 'utf8' });
  const seconds = Number.parseInt(String(out.stdout ?? '').trim(), 10);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

/** 插件源码是否有未提交改动。 */
export function sourceDirty() {
  const out = spawnSync('git', ['status', '--porcelain', '--', 'packages/zotero-plugin'], { cwd: ROOT, encoding: 'utf8' });
  return String(out.stdout ?? '').trim().length > 0;
}

function newestMtime(paths) {
  let newest = null;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const mtime = statSync(path).mtimeMs;
    if (newest === null || mtime > newest) newest = mtime;
  }
  return newest;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const asJson = process.argv.includes('--json');
  if (process.argv.includes('--rebuild')) {
    console.log('--rebuild：执行 npm run plugin:build（会写 build/）…');
    const built = spawnSync('npm', ['run', 'plugin:build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
    if (built.status !== 0) {
      console.error('构建失败，后续比对跳过。');
      process.exit(2);
    }
  }
  const builtPath = join(ROOT, 'build', XPI_FILENAME);
  const installedPath = findInstalledXpi();
  const builtHash = sha256(builtPath);
  const installedHash = sha256(installedPath);
  const sourceChangeMs = sourceLastChangeMs();
  const dirty = sourceDirty();
  const builtMtimeMs = existsSync(builtPath) ? statSync(builtPath).mtimeMs : null;
  const selected = judgePluginState({ installedHash, builtHash, builtMtimeMs, sourceChangeMs, sourceDirty: dirty });
  const profileDir = installedPath === null ? null : resolve(installedPath, '..', '..');
  const pref = readAnnotationsPref(profileDir);

  if (asJson) {
    console.log(JSON.stringify({
      verdict: selected.verdict,
      next: selected.next,
      installed: { path: installedPath, sha256: installedHash },
      built: { path: builtPath, sha256: builtHash, sizeBytes: existsSync(builtPath) ? statSync(builtPath).size : null },
      source: { files: SOURCE_FILES, lastCommitMtime: sourceChangeMs === null ? null : new Date(sourceChangeMs).toISOString(), dirty },
      pref: { name: ANNOTATIONS_PREF, value: pref.value, source: pref.source, note: 'prefs.js 可能滞后于运行态' },
    }, null, 2));
    process.exit(selected.verdict === 'up-to-date' ? 0 : 1);
  }

  console.log('插件自检（只读）');
  console.log('  已安装：' + (installedPath ?? '(未找到)'));
  if (installedHash !== null) console.log('    sha256 ' + installedHash.slice(0, 16) + '…');
  console.log('  构建产物：' + (builtHash === null ? '(缺失)' : builtPath));
  if (builtHash !== null) console.log('    sha256 ' + builtHash.slice(0, 16) + '…');
  console.log('  插件源码最近提交：' + (sourceChangeMs === null ? '(未知)' : new Date(sourceChangeMs).toLocaleString()) + (dirty ? '（有未提交改动）' : ''));
  console.log('  注释写入开关（' + ANNOTATIONS_PREF + '）：' +
    (pref.value === null ? '未设置（默认关闭）' : pref.value ? '已开启' : '已关闭') + '（读自 prefs.js，可能滞后）');
  console.log('');
  console.log('结论：' + selected.verdict);
  console.log('下一步：' + selected.next);
  process.exit(selected.verdict === 'up-to-date' ? 0 : 1);
}
