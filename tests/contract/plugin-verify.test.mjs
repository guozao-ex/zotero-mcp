import assert from 'node:assert/strict';
import { test } from 'node:test';

import { judgePluginState, sha256, findInstalledXpi, readAnnotationsPref } from '../../scripts/plugin-verify.mjs';

const H = 'a'.repeat(64);
const G = 'b'.repeat(64);

test('插件自检判定：五个分支', () => {
  assert.equal(judgePluginState({ installedHash: null, builtHash: null, builtMtimeMs: null, sourceChangeMs: null }).verdict, 'no-build');
  assert.equal(judgePluginState({ installedHash: null, builtHash: H, builtMtimeMs: 1, sourceChangeMs: 1 }).verdict, 'not-installed');
  assert.equal(judgePluginState({ installedHash: H, builtHash: G, builtMtimeMs: 2, sourceChangeMs: 1 }).verdict, 'stale-install');
  assert.equal(judgePluginState({ installedHash: H, builtHash: H, builtMtimeMs: 1, sourceChangeMs: 2 }).verdict, 'stale-build');
  assert.equal(judgePluginState({ installedHash: H, builtHash: H, builtMtimeMs: 2, sourceChangeMs: 2 }).verdict, 'up-to-date');
});

test('插件自检判定：哈希相同但源码提交比构建新 → stale-build', () => {
  const verdict = judgePluginState({ installedHash: H, builtHash: H, builtMtimeMs: 100, sourceChangeMs: 101 });
  assert.equal(verdict.verdict, 'stale-build');
  assert.match(verdict.next, /plugin:build/u);
});

test('插件自检判定：源码有未提交改动 → stale-build（即使提交时间更早）', () => {
  const verdict = judgePluginState({ installedHash: H, builtHash: H, builtMtimeMs: 100, sourceChangeMs: 1, sourceDirty: true });
  assert.equal(verdict.verdict, 'stale-build');
  assert.match(verdict.next, /未提交改动/u);
});

test('插件自检判定：不看文件 mtime（git checkout 会刷新 mtime，只看 git 语义）', () => {
  // 提交时间早于构建、也无未提交改动 → 即便文件 mtime 是「刚刚」也必须判 up-to-date
  const verdict = judgePluginState({ installedHash: H, builtHash: H, builtMtimeMs: 100, sourceChangeMs: 50, sourceDirty: false });
  assert.equal(verdict.verdict, 'up-to-date');
});

test('插件自检：sha256 对缺失文件返回 null，对环境变量覆盖如实返回', () => {
  assert.equal(sha256('C:/definitely/not/here.xpi'), null);
  assert.equal(findInstalledXpi({ ZOTERO_MCP_PROFILE_DIR: 'C:/definitely/not/a/profile' }), null);
  const pref = readAnnotationsPref('C:/definitely/not/a/profile');
  assert.equal(pref.value, null);
});
