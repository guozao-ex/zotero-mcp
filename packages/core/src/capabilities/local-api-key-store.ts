/**
 * 本机 Local API「已记住的写授权」的落盘存储（见 docs/LOCAL_API_WRITE_AUTHORIZATION.md）。
 *
 * 为什么需要：官方文档明确 `remember: true`（使用者点了 “Always Allow”）的 key **可无限复用**，
 * 而 `POST /api/local/authorize` **每次都弹窗并签发新 key**——所以「只点一次」的责任在客户端：
 * 由我们自己把 remembered key 存下来，写入时优先复用，只有 401（被撤销/失效）时才重新授权一次。
 *
 * 三条硬约束：
 *   1. **只存 `remember: true` 的 key**：一次性 key 第一次成功使用后会被 Zotero 消费，存了必 401；
 *   2. **按 `Zotero-Server-ID` 分区**（官方要求：跨运行保存的数据必须按 server ID 分区，换 ID 即换数据库）；
 *   3. **凭证不进审计/日志**：本模块只负责存取，打印掩码由调用方保证。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const LOCAL_API_KEY_STORE_FILENAME = 'zoteromcp-local-api-key.json';

export interface LocalApiKeyEntry {
  key: string;
  appName: string;
  remember: true;
  savedAt: string;
}

export interface LocalApiKeyStore {
  version: 1;
  entries: Record<string, LocalApiKeyEntry>;
}

/** 落盘路径：与 `zoteromcp-token.txt` / `zoteromcp-web-api.json` 同目录（Zotero 数据目录）。 */
export function localApiKeyStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['ZOTERO_MCP_DATA_DIR'] ?? join(homedir(), 'Zotero');
  return join(base, LOCAL_API_KEY_STORE_FILENAME);
}

/** 读取：文件缺失/损坏/字段不合法一律视为「无缓存」，不抛异常。 */
export function readLocalApiKeyStore(path: string = localApiKeyStorePath()): LocalApiKeyStore {
  const empty: LocalApiKeyStore = { version: 1, entries: {} };
  if (!existsSync(path)) return empty;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const entries = (parsed as { entries?: unknown }).entries;
    if (typeof entries !== 'object' || entries === null) return empty;
    const clean: Record<string, LocalApiKeyEntry> = {};
    for (const [serverId, value] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const entry = value as Partial<LocalApiKeyEntry>;
      if (typeof entry.key !== 'string' || entry.key.length === 0) continue;
      if (entry.remember !== true) continue; // 只有 remembered key 才允许存在于缓存里
      clean[serverId] = {
        key: entry.key,
        appName: typeof entry.appName === 'string' ? entry.appName : 'zotero-mcp',
        remember: true,
        savedAt: typeof entry.savedAt === 'string' ? entry.savedAt : new Date().toISOString(),
      };
    }
    return { version: 1, entries: clean };
  } catch {
    return empty;
  }
}

/** 原子写 + 权限 0600（POSIX）。 */
function writeStore(path: string, store: LocalApiKeyStore): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows 上 chmod 语义有限；失败不阻塞（权限收窄是尽力而为）
  }
}

/** 取该 server ID 的 remembered key（没有则 null）。 */
export function getRememberedKey(serverId: string, path: string = localApiKeyStorePath()): string | null {
  if (serverId === '' || serverId === 'unknown') return null;
  return readLocalApiKeyStore(path).entries[serverId]?.key ?? null;
}

/** 记下一条 remembered key（覆盖同 server ID 的旧值）。 */
export function putRememberedKey(
  serverId: string,
  key: string,
  options: { appName?: string; path?: string } = {},
): void {
  if (serverId === '' || serverId === 'unknown' || key === '') return;
  const path = options.path ?? localApiKeyStorePath();
  const store = readLocalApiKeyStore(path);
  store.entries[serverId] = {
    key,
    appName: options.appName ?? 'zotero-mcp',
    remember: true,
    savedAt: new Date().toISOString(),
  };
  writeStore(path, store);
}

/** 删除该 server ID 的分区（401/412 或被拒时调用）；文件里空了就删除文件本身。 */
export function deleteRememberedKey(serverId: string, path: string = localApiKeyStorePath()): void {
  const store = readLocalApiKeyStore(path);
  if (store.entries[serverId] === undefined) return;
  delete store.entries[serverId];
  if (Object.keys(store.entries).length === 0) {
    rmSync(path, { force: true });
    return;
  }
  writeStore(path, store);
}
