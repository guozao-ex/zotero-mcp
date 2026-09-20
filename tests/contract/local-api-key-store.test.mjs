import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  deleteRememberedKey,
  getRememberedKey,
  localApiKeyStorePath,
  putRememberedKey,
  readLocalApiKeyStore,
} from '../../packages/core/src/capabilities/local-api-key-store.ts';

const tempPath = () => join(mkdtempSync(join(tmpdir(), 'zotero-mcp-keystore-')), 'keys.json');

test('落盘存储：按 server ID 分区，只认 remember=true 的条目', () => {
  const path = tempPath();
  try {
    putRememberedKey('SRVAAA', 'KEYAAAA', { path });
    putRememberedKey('SRVBBB', 'KEYBBBB', { path });
    assert.equal(getRememberedKey('SRVAAA', path), 'KEYAAAA');
    assert.equal(getRememberedKey('SRVBBB', path), 'KEYBBBB');
    assert.equal(getRememberedKey('SRVCCC', path), null, '没有的 server ID 返回 null');
    assert.equal(getRememberedKey('unknown', path), null, 'unknown 一律不命中');
  } finally {
    rmSync(path, { force: true, recursive: true });
  }
});

test('落盘存储：损坏文件 / 非法条目一律视为无缓存，不抛异常', () => {
  const path = tempPath();
  try {
    writeFileSync(path, '{ 这不是 JSON', 'utf8');
    assert.deepEqual(readLocalApiKeyStore(path), { version: 1, entries: {} });
    // 合法 JSON 但 remember=false 的条目必须被忽略（绝不复用一次性 key）
    writeFileSync(path, JSON.stringify({ version: 1, entries: { SRVAAA: { key: 'K', remember: false } } }), 'utf8');
    assert.equal(getRememberedKey('SRVAAA', path), null);
  } finally {
    rmSync(path, { force: true, recursive: true });
  }
});

test('落盘存储：删除分区；删空后文件本身被移除', () => {
  const path = tempPath();
  try {
    putRememberedKey('SRVAAA', 'KEYAAAA', { path });
    putRememberedKey('SRVBBB', 'KEYBBBB', { path });
    deleteRememberedKey('SRVAAA', path);
    assert.equal(getRememberedKey('SRVAAA', path), null);
    assert.equal(getRememberedKey('SRVBBB', path), 'KEYBBBB', '别的分区不受影响');
    deleteRememberedKey('SRVBBB', path);
    assert.equal(existsSync(path), false, '分区空后删除文件本身');
  } finally {
    rmSync(path, { force: true, recursive: true });
  }
});

test('落盘存储：文件权限收窄（POSIX 0600）且路径可被 ZOTERO_MCP_DATA_DIR 覆盖', () => {
  const path = tempPath();
  try {
    putRememberedKey('SRVAAA', 'KEYAAAA', { path });
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777;
      assert.equal(mode, 0o600, `权限应为 0600，实际 ${mode.toString(8)}`);
    }
    const raw = readFileSync(path, 'utf8');
    assert.match(raw, /SRVAAA/u, '分区键是 server ID');
    assert.match(raw, /"remember": true/u);
  } finally {
    rmSync(path, { force: true, recursive: true });
  }
});

test('落盘存储：默认路径取自 ZOTERO_MCP_DATA_DIR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zotero-mcp-keystore-'));
  try {
    assert.equal(localApiKeyStorePath({ ZOTERO_MCP_DATA_DIR: dir }), join(dir, 'zoteromcp-local-api-key.json'));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
