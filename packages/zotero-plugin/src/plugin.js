/**
 * Zotero MCP Channel 插件主逻辑（ESM 源码，由 esbuild 内联 `zotero-plugin-toolkit` 后打包）。
 *
 * 暴露六个回环端点（注册在 Zotero 自带的 HTTP 服务器上，默认 127.0.0.1:23119）：
 *   - GET  /zoteromcp/health         插件与同步状态自述
 *   - POST /zoteromcp/sync           触发一次后台同步并回报 `{running, lastSync}` 供轮询
 *   - POST /zoteromcp/select-items   在主窗口选中条目（主窗口不可用时如实降级）
 *   - POST /zoteromcp/merge          调用 Zotero 自己的 `mergeItems.mjs` 合并（执行前必弹确认框）
 *   - POST /zoteromcp/recognize-pdf  调用 Zotero 自己的识别器就地补全元数据
 *   - POST /zoteromcp/annotations    写入注释（**默认关闭**，需显式打开 pref；见 ANNOTATIONS_PREF）
 *
 * 契约与安全（与 plugin-channel 规格逐条对应）：
 *   - 每个端点都校验 `X-ZoteroMCP-Token`，缺 token 或 token 错误一律 401 且不执行任何动作；
 *   - token 从 `<Zotero 数据目录>/zoteromcp-token.txt` 读取，文件缺失或为空时**拒绝服务**；
 *   - 写类端点声明 `supportedDataTypes: ['application/json']`，且**不**声明
 *     `allowRequestsFromUnsafeWebContent`——浏览器发起的请求由 Zotero 服务器自身阻断；
 *   - 端点只在 `/zoteromcp/` 前缀下注册，`shutdown` 时全部删除（`Zotero.Server.Endpoints`
 *     是全局共享表，残留会与其它插件冲突）。
 *
 * 事实依据（Zotero 10.0.3 源码 server.js / syncRunner.js / syncLocal.js / plugins.js）：
 *   - 端点对象用 `supportedMethods` / `supportedDataTypes` 约束，`init({method, pathname,
 *     pathParams, searchParams, headers, data})` 单参形态返回 `[status, contentType, body]`；
 *   - 同步状态用 `Zotero.Sync.Runner.syncInProgress` 与 `Zotero.Sync.Data.Local.getLastSyncTime()`；
 *   - 插件作用域内 `IOUtils` / `PathUtils` 可用（`OS.File` 在 Gecko 140 已移除）。
 */

import { BasicTool } from 'zotero-plugin-toolkit';
import ZoteroToolkit from 'zotero-plugin-toolkit/ztoolkit';

export const ENDPOINTS = [
  '/zoteromcp/health',
  '/zoteromcp/sync',
  '/zoteromcp/select-items',
  '/zoteromcp/merge',
  '/zoteromcp/recognize-pdf',
  '/zoteromcp/annotations',
];

/** 识别结果里要逐条回报的可见字段。 */
const RECOGNIZE_FIELDS = ['title', 'creators', 'date', 'DOI', 'publicationTitle'];
export const TOKEN_FILENAME = 'zoteromcp-token.txt';
export const PLUGIN_REF = 'zotero-mcp@guozao-ex.github.io';
/**
 * 轮询窗口：刚同步过（`getLastSyncTime()` 距今小于该窗口）时，`sync` 端点只回报状态、
 * 不重复触发。否则「轮询到完成」会变成「每轮询一次就再同步一次」。
 */
export const SYNC_POLL_WINDOW_MS = 10_000;

const JSON_TYPE = 'application/json';

/** 常量时间比较：长度不同直接失败，长度相同则逐字符异或累加。 */
export function tokenMatches(expected, provided) {
  if (typeof expected !== 'string' || typeof provided !== 'string') return false;
  if (expected.length === 0 || expected.length !== provided.length) return false;
  let diff = 0;
  for (let index = 0; index < expected.length; index += 1) {
    diff |= expected.charCodeAt(index) ^ provided.charCodeAt(index);
  }
  return diff === 0;
}

/** token 文件路径（插件侧用 Zotero 自己的数据目录，与 MCP 侧口径一致）。 */
export function tokenPath() {
  return PathUtils.join(Zotero.DataDirectory.dir, TOKEN_FILENAME);
}

/** 读取共享 token；文件缺失或内容为空时返回 null（调用方必须拒绝服务）。 */
export async function readToken() {
  try {
    const raw = await IOUtils.readUTF8(tokenPath());
    const token = raw.replace(/[\r\n]+$/u, '');
    return token.length === 0 ? null : token;
  } catch {
    return null;
  }
}

function json(status, body) {
  return [status, JSON_TYPE, JSON.stringify(body)];
}

function describeError(error) {
  // 不依赖 instanceof：跨 realm 时它不成立，会把错误降级成带 'Error: ' 前缀的字符串
  const message = error === null || error === undefined ? null : error.message;
  return typeof message === 'string' && message.length > 0 ? message : String(error);
}

/** 是否落在轮询窗口内（刚同步过）：只看 Zotero 自己的 lastSync 时间。 */
export function withinPollWindow(lastSync, now = Date.now(), windowMs = SYNC_POLL_WINDOW_MS) {
  if (typeof lastSync !== 'string') return false;
  const timestamp = Date.parse(lastSync);
  if (!Number.isFinite(timestamp)) return false;
  const elapsed = now - timestamp;
  return elapsed >= 0 && elapsed < windowMs;
}

/** 同步状态：只用 Zotero 自己的真实来源，不发明字段。 */
export function syncState() {
  const runner = Zotero.Sync?.Runner;
  let lastSync = null;
  let lastSyncError = null;
  try {
    // Zotero 启动极早期 `_lastSyncTime` 尚未加载时这里会抛错；读不到就如实回报未知，
    // 绝不让端点因为一个瞬态而 500（那会被 MCP 侧误当成「插件未安装」）。
    const value = Zotero.Sync?.Data?.Local?.getLastSyncTime?.();
    if (typeof value?.toISOString === 'function') lastSync = value.toISOString();
  } catch (error) {
    lastSyncError = error instanceof Error ? error.message : String(error);
  }
  return {
    enabled: runner?.enabled === true,
    running: runner?.syncInProgress === true,
    lastSync,
    lastSyncError,
  };
}

/**
 * 端点基类：统一 token 校验与 JSON 响应约定。
 *
 * `supportedMethods` / `supportedDataTypes` 是 Zotero 服务器在调用 `init` 之前就会检查的字段，
 * 因此方法与 Content-Type 不匹配的请求根本到不了这里。
 */
class Endpoint {
  constructor() {
    this.supportedMethods = ['GET'];
  }

  /** 子类实现：返回 [status, contentType, body]；抛错由基类兜底成 500。 */
  async handle() {
    throw new Error('not implemented');
  }

  async init(request) {
    let expected;
    try {
      expected = await readToken();
    } catch (error) {
      return json(503, { ok: false, error: 'token-unreadable', reason: describeError(error) });
    }
    if (expected === null) {
      // 没有配置 token 时拒绝服务，而不是放行
      return json(503, {
        ok: false,
        error: 'token-not-configured',
        hint: `请把共享 token 写入 ${tokenPath()} 后重试`,
      });
    }
    const provided = request?.headers?.['x-zoteromcp-token'];
    if (!tokenMatches(expected, typeof provided === 'string' ? provided : '')) {
      return json(401, { ok: false, error: 'unauthorized' });
    }
    try {
      return await this.handle(request);
    } catch (error) {
      return json(500, { ok: false, error: 'endpoint-failed', reason: describeError(error) });
    }
  }
}

export class HealthEndpoint extends Endpoint {
  constructor(plugin) {
    super();
    this.plugin = plugin;
    this.supportedMethods = ['GET'];
  }

  async handle() {
    return json(200, {
      ok: true,
      plugin: { id: this.plugin.id, version: this.plugin.version },
      endpoints: ENDPOINTS,
      toolkit: this.plugin.toolkitVersion,
      sync: syncState(),
      httpServer: { port: Zotero.Prefs.get('httpServer.port') ?? null },
    });
  }
}

export class SyncEndpoint extends Endpoint {
  constructor(plugin) {
    super();
    this.plugin = plugin;
    this.supportedMethods = ['POST'];
    this.supportedDataTypes = [JSON_TYPE];
  }

  async handle() {
    const runner = Zotero.Sync?.Runner;
    if (runner?.enabled !== true) {
      return json(200, { ok: false, error: 'sync-disabled', reason: 'Zotero 同步未启用', ...syncState() });
    }
    const before = syncState();
    if (before.running) {
      return json(200, { ok: true, started: false, reason: '同步已在进行中，复用本次会话', ...before });
    }
    if (withinPollWindow(before.lastSync)) {
      // 刚同步过：本次只回报状态，避免「轮询 = 反复同步」
      return json(200, { ok: true, started: false, reason: '刚刚同步过，本次只回报状态', ...before });
    }
    try {
      // 不 await：端点要立刻回报状态供轮询；失败只记日志，由下一次轮询的真实状态体现
      Promise.resolve(runner.sync({ background: true })).catch((error) => {
        Zotero.debug(`Zotero MCP Channel: sync failed: ${describeError(error)}`);
      });
    } catch (error) {
      return json(200, { ok: false, error: 'sync-failed', reason: describeError(error), ...syncState() });
    }
    return json(200, { ok: true, started: true, ...syncState() });
  }
}

export class SelectItemsEndpoint extends Endpoint {
  constructor(plugin) {
    super();
    this.plugin = plugin;
    this.supportedMethods = ['POST'];
    this.supportedDataTypes = [JSON_TYPE];
  }

  async handle(request) {
    const key = typeof request?.data?.key === 'string' ? request.data.key.trim() : '';
    if (key.length === 0) return json(400, { ok: false, error: 'key-required' });
    const window = Zotero.getMainWindow();
    if (!window || !window.ZoteroPane) {
      return json(503, { ok: false, error: 'main-window-unavailable', reason: 'Zotero 主窗口不可用' });
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID, key);
    if (!item) return json(404, { ok: false, error: 'item-not-found', key });
    await window.ZoteroPane.selectItems([item.id]);
    window.focus();
    return json(200, { ok: true, key, itemID: item.id });
  }
}

/** 读取一个条目在给定字段上的可见值（用于识别前后对照）。 */
function visibleFields(item) {
  const snapshot = {};
  for (const field of RECOGNIZE_FIELDS) {
    try {
      snapshot[field] = item.getField(field, false, true) ?? null;
    } catch {
      snapshot[field] = null;
    }
  }
  return snapshot;
}

/** 条目查询：库内按 key 取条目；取不到返回 null。 */
async function itemByKey(key) {
  return Zotero.Items.getByLibraryAndKeyAsync(Zotero.Libraries.userLibraryID, key);
}

/** 注释写入的开关（Zotero 高级设置里的布尔 pref）；缺省 false = 端点默认关闭。 */
export const ANNOTATIONS_PREF = 'extensions.zoteromcp.enableAnnotations';

/** 读开关：pref 不存在/读不到都算关闭（fail-closed）。 */
export function annotationsWriteEnabled() {
  try {
    return Zotero.Prefs.get(ANNOTATIONS_PREF, true) === true;
  } catch {
    return false;
  }
}

/**
 * 注释的 `sortIndex`：Zotero 对 PDF 注释的校验是 `/^\d{5}\|\d{6}\|\d{5}$/`（见 `data/item.js` 的 case
 * 'sortIndex'），格式与 PDF worker 一致：`页码(5) | 字符偏移(6) | 距页顶(5)`。
 *
 * 真机实测（10.0.3）：`saveFromJSON` 缺 sortIndex 会直接抛 `Invalid sortIndex 'undefined'`。
 * 这里按 `position` 兜底生成：页码取 `pageIndex`；**字符偏移留 0**（准确值需要 PDF 文本与 worker，
 * 插件侧不做），距页顶取 `rects[0][3]`（不减去页高，同样只是近似）——两者只影响注释面板里的排序，
 * 不影响高亮的落位与可见性；调用方可用 `sortIndex` 覆盖。
 */
export function defaultSortIndex(position) {
  const pageIndex = Number.isInteger(position?.pageIndex) ? Math.max(0, position.pageIndex) : 0;
  const top = Math.max(0, Math.floor(Array.isArray(position?.rects?.[0]) ? position.rects[0][3] : 0));
  return [
    String(pageIndex).slice(0, 5).padStart(5, '0'),
    '000000',
    String(Number.isFinite(top) ? top : 0).slice(0, 5).padStart(5, '0'),
  ].join('|');
}

/** 允许的注释类型（与 Zotero 自身的注解模型一致）。 */
const ANNOTATION_TYPES = ['highlight', 'underline', 'note', 'image', 'ink'];

/**
 * 注释写入端点：`POST /zoteromcp/annotations`。
 *
 * 路线图 G1 的四条升级条件在这里落地：
 *   1. **默认关闭**：pref `extensions.zoteromcp.enableAnnotations` 不为 true 时一律 403
 *      （fail-closed），并在响应里给出开启方法；沿用既有 token 与方法/Content-Type 约束，
 *      且**不**声明 `allowRequestsFromUnsafeWebContent`（与其它端点一致，只服务本机 MCP）。
 *   2. **补上 `key` 与 `loadPrimaryData()`**：9.0.5 那次真机失败的真正原因是注释条目缺 key /
 *      未加载主数据；这里显式分配 key（或沿用调用方给的 key）并在保存后调 `loadPrimaryData()`。
 *   3. 真机创建后由人在阅读器里目视确认（属于验收步骤，不在代码里）。
 *   4. 四条通过后 G4 才从「不可行」升级为「可交付能力」（写在文档里）。
 *
 * 内部走 `Zotero.Annotations.saveFromJSON`（Zotero 自己的注解保存路径），不自己拼 SQL / 不直写库。
 */
export class AnnotationsEndpoint extends Endpoint {
  constructor(plugin) {
    super();
    this.plugin = plugin;
    this.supportedMethods = ['POST'];
    this.supportedDataTypes = [JSON_TYPE];
  }

  async handle(request) {
    if (!annotationsWriteEnabled()) {
      return json(403, {
        ok: false,
        error: 'annotations-disabled',
        hint: `注释写入默认关闭：请在 Zotero「设置 → 高级 → 配置编辑器」把 ${ANNOTATIONS_PREF} 设为 true 后重启 Zotero`,
      });
    }
    const attachmentKey = typeof request?.data?.attachmentKey === 'string' ? request.data.attachmentKey.trim() : '';
    if (attachmentKey.length === 0) return json(400, { ok: false, error: 'attachment-key-required' });
    const specs = Array.isArray(request?.data?.annotations) ? request.data.annotations : [];
    if (specs.length === 0) return json(400, { ok: false, error: 'annotations-required' });
    if (specs.length > 50) return json(400, { ok: false, error: 'too-many-annotations', limit: 50 });

    const attachment = await itemByKey(attachmentKey);
    if (attachment === null) return json(404, { ok: false, error: 'attachment-not-found', attachmentKey });
    if (typeof attachment.isAttachment === 'function' && attachment.isAttachment() !== true) {
      return json(400, { ok: false, error: 'not-an-attachment', attachmentKey });
    }
    if (attachment.attachmentContentType !== undefined && attachment.attachmentContentType !== 'application/pdf') {
      return json(400, { ok: false, error: 'attachment-not-pdf', attachmentKey });
    }
    if (typeof Zotero.Annotations?.saveFromJSON !== 'function') {
      return json(503, { ok: false, error: 'annotations-api-unavailable', reason: '当前 Zotero 版本没有 Zotero.Annotations.saveFromJSON' });
    }

    // 先把**全部**条目校验完再写入：否则 [合法, 非法] 这种批量会先落库第 1 条再回 400，
    // 调用方看到失败却已经有副作用（重试还会重复创建）。
    for (const [index, spec] of specs.entries()) {
      const type = typeof spec?.type === 'string' ? spec.type : '';
      if (!ANNOTATION_TYPES.includes(type)) {
        return json(400, { ok: false, error: 'unsupported-annotation-type', index, type, created: [] });
      }
      const position = spec?.position;
      if (
        position === null ||
        typeof position !== 'object' ||
        !Number.isInteger(position.pageIndex) ||
        !Array.isArray(position.rects) ||
        position.rects.length === 0
      ) {
        return json(400, {
          ok: false,
          error: 'position-required',
          index,
          hint: '需要 { pageIndex, rects: [[x1,y1,x2,y2]] }',
          created: [],
        });
      }
    }

    const created = [];
    for (const [index, spec] of specs.entries()) {
      const type = spec.type;
      const position = spec.position;
      // 条件②：显式给 key（没有就生成），保存后 loadPrimaryData()——9.0.5 失败的真正原因
      const key =
        typeof spec.key === 'string' && spec.key.length > 0
          ? spec.key
          : Zotero.DataObjectUtilities.generateKey();
      const payload = {
        key,
        type,
        text: typeof spec.text === 'string' ? spec.text : '',
        comment: typeof spec.comment === 'string' ? spec.comment : '',
        color: typeof spec.color === 'string' ? spec.color : undefined,
        pageLabel: typeof spec.pageLabel === 'string' ? spec.pageLabel : undefined,
        sortIndex: typeof spec.sortIndex === 'string' && spec.sortIndex.length > 0 ? spec.sortIndex : defaultSortIndex(position),
        position,
      };
      let item;
      try {
        item = await Zotero.Annotations.saveFromJSON(attachment, payload);
      } catch (error) {
        return json(500, { ok: false, error: 'annotation-save-failed', index, key, reason: describeError(error), created });
      }
      if (typeof item?.loadPrimaryData === 'function') await item.loadPrimaryData();
      created.push({
        key: item?.key ?? key,
        type: item?.annotationType ?? type,
        pageLabel: item?.annotationPageLabel ?? null,
      });
    }
    return json(200, { ok: true, attachmentKey, created });
  }
}

/**
 * 合并端点：调用 Zotero 自身的合并实现（`mergeItems.mjs`）。
 *
 * 关键安全点：**执行前必须在 Zotero 里弹一次模态确认框**——MCP 侧的 `confirm="MERGE"`
 * 只是第一道闸，真正的合并要有人在 Zotero 面前点确认；主窗口不可用时直接拒绝
 * （无法让人确认就不做）。合并把其余条目移入垃圾箱（可恢复），不做任何永久删除。
 */
export class MergeEndpoint extends Endpoint {
  constructor(plugin) {
    super();
    this.plugin = plugin;
    this.supportedMethods = ['POST'];
    this.supportedDataTypes = [JSON_TYPE];
  }

  async handle(request) {
    const primaryKey = typeof request?.data?.primaryKey === 'string' ? request.data.primaryKey.trim() : '';
    const mergeKeys = Array.isArray(request?.data?.mergeKeys)
      ? request.data.mergeKeys.map((key) => (typeof key === 'string' ? key.trim() : '')).filter((key) => key.length > 0)
      : [];
    if (primaryKey.length === 0) return json(400, { ok: false, error: 'primary-key-required' });
    if (mergeKeys.length === 0) return json(400, { ok: false, error: 'merge-keys-required' });
    if (mergeKeys.includes(primaryKey)) return json(400, { ok: false, error: 'primary-in-merge-keys' });
    if (new Set(mergeKeys).size !== mergeKeys.length) return json(400, { ok: false, error: 'duplicate-merge-keys' });

    const primary = await itemByKey(primaryKey);
    if (!primary) return json(404, { ok: false, error: 'primary-not-found', primaryKey });
    const others = [];
    for (const key of mergeKeys) {
      const item = await itemByKey(key);
      if (!item) return json(404, { ok: false, error: 'item-not-found', key });
      if (item.libraryID !== primary.libraryID) return json(400, { ok: false, error: 'cross-library', key });
      others.push(item);
    }

    const window = Zotero.getMainWindow();
    if (!window) {
      return json(503, { ok: false, error: 'main-window-unavailable', reason: 'Zotero 主窗口不可用，无法请你确认合并' });
    }
    const message = [
      `Zotero MCP 请求把 ${mergeKeys.join('、')} 合并到 ${primaryKey}。`,
      '',
      '被合并的条目会被移入垃圾箱（可恢复），合并本身可以用 Zotero 的撤销或在重复项面板中人工处理。',
      '',
      '是否继续？',
    ].join('\n');
    const confirmed = Services.prompt.confirm(window, 'Zotero MCP：确认合并条目', message);
    if (!confirmed) return json(409, { ok: false, error: 'cancelled-by-user', primaryKey, mergeKeys });

    const { mergeItems } = ChromeUtils.importESModule('chrome://zotero/content/mergeItems.mjs');
    await mergeItems(primary, others);
    return json(200, { ok: true, primaryKey, mergedKeys: mergeKeys, trashedKeys: mergeKeys });
  }
}

/**
 * 识别端点：调用 Zotero 自身的 `Zotero.RecognizeDocument.recognizeItems` 就地补全元数据。
 *
 * 识别器没有 dry-run，因此写入前的快照由 MCP 侧负责；这里只负责执行与逐条回报
 * 识别前后的可见字段对照，以及如实回报不可识别的条目。
 */
export class RecognizeEndpoint extends Endpoint {
  constructor(plugin) {
    super();
    this.plugin = plugin;
    this.supportedMethods = ['POST'];
    this.supportedDataTypes = [JSON_TYPE];
  }

  async handle(request) {
    const keys = Array.isArray(request?.data?.keys)
      ? request.data.keys.map((key) => (typeof key === 'string' ? key.trim() : '')).filter((key) => key.length > 0)
      : [];
    if (keys.length === 0) return json(400, { ok: false, error: 'keys-required' });

    const results = [];
    for (const key of keys) {
      const item = await itemByKey(key);
      if (!item) {
        results.push({ key, ok: false, recognized: false, reason: 'item-not-found' });
        continue;
      }
      const before = visibleFields(item);
      if (!Zotero.RecognizeDocument.canRecognize(item)) {
        results.push({ key, ok: true, recognized: false, reason: 'can-recognize-false', before, after: before });
        continue;
      }
      try {
        await Zotero.RecognizeDocument.recognizeItems([item]);
      } catch (error) {
        results.push({ key, ok: false, recognized: false, reason: describeError(error), before, after: visibleFields(item) });
        continue;
      }
      results.push({ key, ok: true, recognized: true, before, after: visibleFields(item) });
    }
    return json(200, { ok: results.every((entry) => entry.ok), results });
  }
}

/** 插件实例：装载工具箱、注册端点，并在 shutdown 时把端点全部删除。 */
export function create({ id, version, rootURI }) {
  const plugin = { id, version, rootURI, toolkit: null, base: null, registered: [], windows: new Set() };
  return {
    get id() {
      return id;
    },
    get version() {
      return version;
    },
    get toolkitVersion() {
      return BasicTool?._version ?? null;
    },
    async startup() {
      // 路线图指定的运行时依赖（MIT）：这里只实例化它的基类 BasicTool，并把完整工具箱
      // 的**类**挂成插件全局。刻意不在启动时 new ZoteroToolkit()——那会立刻构造
      // FieldHookManager 等管理器并改写 `Zotero.Item.prototype`，对一个只做端点转发的
      // 薄插件来说既无必要，也把兼容面暴露在 Zotero 大版本的内部 API 变更上。
      // 后续端点按需从这里取具体工具。
      plugin.base = new BasicTool();
      plugin.toolkit = { BasicTool, ZoteroToolkit, base: plugin.base };
      Zotero.ZoteroMCPToolkit = plugin.toolkit;
      const endpoints = {
        '/zoteromcp/health': new HealthEndpoint(plugin),
        '/zoteromcp/sync': new SyncEndpoint(plugin),
        '/zoteromcp/select-items': new SelectItemsEndpoint(plugin),
        '/zoteromcp/merge': new MergeEndpoint(plugin),
        '/zoteromcp/recognize-pdf': new RecognizeEndpoint(plugin),
        '/zoteromcp/annotations': new AnnotationsEndpoint(plugin),
      };
      for (const [path, endpoint] of Object.entries(endpoints)) {
        const Constructor = function () {};
        Constructor.prototype = endpoint;
        Zotero.Server.Endpoints[path] = Constructor;
        plugin.registered.push(path);
      }
      Zotero.debug(`Zotero MCP Channel: registered ${plugin.registered.join(', ')}`);
    },
    onMainWindowLoad(window) {
      plugin.windows.add(window);
    },
    onMainWindowUnload(window) {
      plugin.windows.delete(window);
    },
    shutdown() {
      // 只删自己注册的端点：Endpoints 是全局共享表，不能影响其它插件
      for (const path of plugin.registered) {
        if (Zotero.Server?.Endpoints?.[path] !== undefined) delete Zotero.Server.Endpoints[path];
      }
      plugin.registered = [];
      plugin.base = null;
      plugin.toolkit = null;
      if (Zotero.ZoteroMCPToolkit !== undefined) delete Zotero.ZoteroMCPToolkit;
      Zotero.debug('Zotero MCP Channel: endpoints removed');
    },
  };
}

export default { create, ENDPOINTS, TOKEN_FILENAME, PLUGIN_REF, tokenMatches };
