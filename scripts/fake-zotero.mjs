#!/usr/bin/env node
/**
 * 假 Zotero 本地 API 服务器。
 *
 * 两种用法：
 *   1. 作为模块：`startFakeZotero({ mode, port: 0 })` → 测试在随机端口启动，拿到实际端口；
 *   2. 作为 CLI：`node scripts/fake-zotero.mjs --mode rate-limited --port 23119`。
 *
 * 六种模式覆盖 M0 要求的全部错误路径与正常路径。
 */

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

export const FAKE_MODES = [
  'ok',
  'api-disabled',
  'unauthorized',
  'version-conflict',
  'missing-server-id',
  'rate-limited',
];

export const DEFAULT_FAKE_PORT = 23119;

const DEFAULTS = {
  serverId: 'FAKE0001',
  schemaVersion: '42',
  apiVersion: '3',
  serverTimestamp: '2026-01-01T00:00:00Z',
  /** 库级版本（Last-Modified-Version）；写操作会递增，创建类请求的版本前提用它。 */
  libraryVersion: 42,
  /** `/items/<key>/file` 的 302 目标；设为 null 时返回 404。 */
  filePath: 'D:/fake/storage/ATT00001/paper.pdf',
  fulltextContent: 'Alpha paper full text content used by offline contract tests.',
};

/** 固定固件库：覆盖条目、重复强键、附件、注释、笔记、集合、标签与保存搜索。 */
export const FAKE_LIBRARY = {
  items: [
    {
      key: 'ITEM0001',
      version: 1,
      data: {
        itemType: 'journalArticle',
        title: 'Alpha paper',
        DOI: '10.1000/alpha',
        date: '2021-03-01',
        creators: [{ firstName: 'Ada', lastName: 'Author', creatorType: 'author' }],
        collections: ['COLL0001'],
        tags: [{ tag: 'alpha' }],
        extra: 'Citation Key: alphaPaper2021',
      },
    },
    {
      key: 'ITEM0002',
      version: 2,
      data: {
        itemType: 'journalArticle',
        title: 'Alpha paper (duplicate)',
        DOI: 'https://doi.org/10.1000/ALPHA',
        date: '2021',
        creators: [{ firstName: 'Ada', lastName: 'Author', creatorType: 'author' }],
        collections: [],
        tags: [],
      },
    },
    {
      key: 'ITEM0003',
      version: 3,
      data: {
        itemType: 'book',
        title: 'Beta book',
        ISBN: '978-0-306-40615-7',
        date: '1999',
        creators: [{ name: 'Edit Or', creatorType: 'editor' }],
        collections: [],
        tags: [],
      },
    },
  ],
  children: {
    ITEM0001: [
      {
        key: 'ATT00001',
        version: 1,
        data: {
          itemType: 'attachment',
          contentType: 'application/pdf',
          title: 'Full Text PDF',
          linkMode: 'imported_url',
          parentItem: 'ITEM0001',
        },
      },
      { key: 'NOTE0001', version: 1, data: { itemType: 'note', note: '<p>reading note</p>', parentItem: 'ITEM0001' } },
    ],
    ITEM0002: [
      {
        key: 'ATT00002',
        version: 1,
        data: {
          itemType: 'attachment',
          contentType: 'application/pdf',
          title: 'Duplicate PDF without annotations',
          linkMode: 'imported_file',
          parentItem: 'ITEM0002',
        },
      },
    ],
    ATT00002: [],
    ATT00001: [
      {
        key: 'ANNO0001',
        version: 1,
        data: {
          itemType: 'annotation',
          annotationType: 'highlight',
          annotationText: 'important finding',
          annotationComment: 'revisit',
          annotationColor: '#ffd400',
          annotationPageLabel: '3',
          annotationPosition: '{"pageIndex":2}',
          parentItem: 'ATT00001',
        },
      },
    ],
  },
  collections: [{ key: 'COLL0001', version: 1, data: { name: 'Reading', parentCollection: false } }],
  tags: [{ tag: 'alpha', meta: { numItems: 1 } }],
  searches: [{ key: 'SEARCH01', version: 1, data: { name: 'Recent', conditions: [] } }],
  fulltext: { ATT00001: 7 },
};

function send(res, status, body, headers = {}) {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendText(res, status, body, contentType, headers = {}) {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

/**
 * 内文引用形态的格式化输出（模拟真机 `include=citation` 的 citeproc 输出）。
 *
 * 真机走 `citeprocToHTML(item, params, true)`，返回 `<span class="citation">(…)</span>`；
 * 参考文献形态（`format=bib` / `include=bib`）返回 `<div class="csl-entry">…</div>`。
 */
export function buildCitationListResponse(items) {
  const yearOf = (item) => String(item.data.date ?? '').slice(0, 4);
  const authorOf = (item) => {
    const creator = (item.data.creators ?? [])[0];
    if (creator === undefined) return 'Anon.';
    return creator.lastName ?? creator.name ?? 'Anon.';
  };
  return items
    .map((item) => `<span class="citation">(${authorOf(item)}, ${yearOf(item)})</span>`)
    .join('');
}

/**
 * 真机语义：`GET /items` 与 `GET /items/<key>` 返回的条目信封里，`data` **同时包含**
 * `key` 与 `version`（Zotero 10.0.3 实测）。这一点很关键——写前快照取的是 `data`，
 * 而真机会把 PATCH body 里的 `version` 当作版本前提，因此假服务器必须同样把这两个字段
 * 放进 `data`，否则「回滚把旧 version 塞进 body → 永远 412」这类缺陷在离线测试里看不见。
 */
function toEnvelope(item) {
  return { key: item.key, version: item.version, data: { key: item.key, version: item.version, ...item.data } };
}

/** 按 format 生成导出响应（模拟本地 API 的格式化输出）。 */
export function buildExportResponse(format, items, searchParams) {
  const keys = (searchParams.get('itemKey') ?? '').split(',').filter((key) => key.length > 0);
  const selected = items.filter((item) => keys.length === 0 || keys.includes(item.key));
  const yearOf = (item) => String(item.data.date ?? '').slice(0, 4);
  const authorsOf = (item) =>
    (item.data.creators ?? [])
      .map((creator) => (creator.lastName ? `${creator.lastName}, ${creator.firstName ?? ''}` : (creator.name ?? '')))
      .join(' and ');
  const keyOf = (item) => /Citation Key:\s*(\S+)/u.exec(item.data.extra ?? '')?.[1] ?? item.key;
  const NL = String.fromCharCode(10);
  const NL2 = NL + NL;

  // 真机语义：format=bib 返回 HTML 参考文献块（csl-bib-body），format=bibtex 才是原始 BibTeX
  if (format === 'bibtex') {
    const body = selected
      .map(
        (item) =>
          '@article{' + keyOf(item) + ',' + NL +
          '  title = {' + (item.data.title ?? '') + '},' + NL +
          '  author = {' + authorsOf(item) + '},' + NL +
          '  year = {' + yearOf(item) + '}' + NL +
          '}',
      )
      .join(NL2);
    return ['text/plain; charset=utf-8', body + NL];
  }
  if (format === 'csljson') {
    return [
      'application/json',
      JSON.stringify(
        selected.map((item) => ({
          id: item.key,
          type: item.data.itemType === 'book' ? 'book' : 'article-journal',
          title: item.data.title ?? null,
          DOI: item.data.DOI ?? null,
        })),
      ),
    ];
  }
  if (format === 'ris') {
    const body = selected
      .map((item) => 'TY  - JOUR' + NL + 'TI  - ' + (item.data.title ?? '') + NL + 'PY  - ' + yearOf(item) + NL + 'ER  -')
      .join(NL2);
    return ['text/plain; charset=utf-8', body + NL];
  }
  if (format === 'bib') {
    // 真机行为：format=bib 返回 HTML 参考文献块（csl-bib-body），并接受 style/locale
    const style = searchParams.get('style') ?? 'chicago-author-date';
    const locale = searchParams.get('locale') ?? 'en-US';
    const body = selected
      .map((item) => '<div class="csl-entry">' + (item.data.title ?? '') + ' (' + style + '/' + locale + ')</div>')
      .join(NL);
    return ['text/html; charset=utf-8', body + NL];
  }
  if (format === 'citation' || format === 'bibliography') {
    // 真机不支持这两个格式值（返回 400），用它证明实现不会走这条路
    return ['text/plain; charset=utf-8', null];
  }
  return ['text/plain; charset=utf-8', ''];
}

/**
 * `version-conflict` 模式的 412：真机上「库版本过旧」的冲突与请求体形态无关，
 * 因此这个模式必须覆盖**任意写请求**（数组体批量创建、集合写入、PATCH / DELETE 都算），
 * 不能只在某个窄分支上生效——模式名与可触发的路径必须一致。返回 null 表示当前模式不是它。
 */
function versionConflict(config) {
  return config.mode === 'version-conflict' ? { status: 412, body: { error: 'Version conflict' } } : null;
}

/**
 * 写请求的公共门禁（与真机一致）：未授权 401、缺 Zotero-Server-ID 428、
 * 本地 API 关闭 403、限流 429；`If-Unmodified-Since-Version` 只在真机要求它时才是 428
 * （见 `requireVersionHeader`）。返回 null 表示放行。
 *
 * 真机依据（`omni.ja` → `chrome/content/zotero/xpcom/server/server_localAPI.js`）：
 * `writeMultipleObjects()` 调 `_checkLibraryIfUnmodifiedSinceVersion(requestData)` 时
 * **没有**传 `{ required: true }`，因此**无 key 的 POST 创建不强制该头**；只有带 key 的写
 * 才要求「请求级 or 对象级」版本前提（对应真机的 428 "Either If-Unmodified-Since-Version
 * or 'version' property must be provided for 'key'-based writes"）。
 */
function writeGate(req, config, { requireVersionHeader = false } = {}) {
  const conflict = versionConflict(config);
  if (conflict !== null) return conflict;
  if (config.mode === 'api-disabled') return { status: 403, body: { error: 'Local API is not enabled' } };
  if (config.mode === 'unauthorized') return { status: 401, body: { error: 'Write requires authorization' } };
  if (config.mode === 'rate-limited') return { status: 429, body: { error: 'Too many requests' } };
  if (req.headers['authorization'] === undefined && req.headers['zotero-api-key'] === undefined) {
    return { status: 401, body: { error: 'Write requires authorization' } };
  }
  if (req.headers['zotero-server-id'] === undefined) {
    return { status: 428, body: { error: 'Zotero-Server-ID header is required' } };
  }
  if (requireVersionHeader && req.headers['if-unmodified-since-version'] === undefined) {
    return { status: 428, body: { error: 'If-Unmodified-Since-Version header is required' } };
  }
  return null;
}

/** 真机把垃圾箱状态放在 `data.deleted`（布尔或 1）。 */
function isDeleted(item) {
  const deleted = item?.data?.deleted;
  return deleted === true || deleted === 1 || deleted === '1';
}

function zoteroHeaders(config, libraryVersion) {
  return {
    'zotero-api-version': config.apiVersion,
    'zotero-server-id': config.serverId,
    'zotero-schema-version': config.schemaVersion,
    'last-modified-version': String(libraryVersion),
  };
}

async function readBody(req, log = []) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  // 把请求体挂到最近一条请求日志上，便于契约测试断言载荷形态（真机要求数组体）
  const entry = log[log.length - 1];
  if (entry !== undefined) entry.body = text;
  return text;
}

/**
 * 启动假服务器。返回实际端口与关闭函数；`port: 0` 表示由系统分配。
 */
export async function startFakeZotero(options = {}) {
  if (options.mode !== undefined && !FAKE_MODES.includes(options.mode)) {
    throw new Error(`未知模式：${options.mode}（可选：${FAKE_MODES.join(' / ')}）`);
  }
  const config = { ...DEFAULTS, ...options };
  // 每个实例克隆一份固件库，避免测试之间相互污染（写测试会修改 data/version）
  // options.library 可以只覆盖需要替换的部分（例如用标注语料替换 items）
  const library = { ...structuredClone(FAKE_LIBRARY), ...(options.library === undefined ? {} : structuredClone(options.library)) };
  /** 每个 key 首次 PATCH 返回 412（模拟外部改动），用于验证冲突恢复路径。 */
  const conflictedOnce = new Set();
  /** 库级版本：每次写操作递增（真机 Last-Modified-Version 的语义）。 */
  const state = { libraryVersion: config.libraryVersion };
  /** 首次创建类写入返回一次 412（模拟库版本滞后），用于验证 found 版本重试路径。 */
  let staleVersionUsed = false;
  /** 请求日志（每个实例独立）：契约测试用它断言「零写请求」与请求体形态。 */
  const requests = [];
  let createdCounter = 0;
  const allItems = () => [...library.items, ...Object.values(library.children).flat()];
  const findItem = (key) => allItems().find((entry) => entry.key === key);
  const nextKey = (itemType) => {
    createdCounter += 1;
    const prefix = itemType === 'attachment' ? 'NEWATT' : itemType === 'note' ? 'NEWNOTE' : 'NEWITEM';
    return `${prefix}${String(createdCounter).padStart(2, '0')}`;
  };
  const removeItem = (item) => {
    library.items = library.items.filter((entry) => entry.key !== item.key);
    for (const [parent, children] of Object.entries(library.children)) {
      library.children[parent] = children.filter((entry) => entry.key !== item.key);
    }
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const hasServerId = req.headers['zotero-server-id'] !== undefined;
    requests.push({
      method: (req.method ?? 'GET').toUpperCase(),
      path,
      url: req.url ?? path,
      version: req.headers['if-unmodified-since-version'] ?? null,
      // 请求头（小写键）：契约测试用它断言写请求必须带 Zotero-Server-ID / Zotero-API-Key
      headers: req.headers,
      body: null,
    });

    const json = (status, body) => send(res, status, body, zoteroHeaders(config, state.libraryVersion));
    const list = (status, body) => {
      const serialized = Array.isArray(body) ? body.map((entry) => (entry?.data === undefined ? entry : toEnvelope(entry))) : body;
      send(res, status, serialized, {
        ...zoteroHeaders(config, state.libraryVersion),
        'total-results': String(Array.isArray(serialized) ? serialized.length : 0),
      });
    };

    if (config.mode === 'api-disabled' && path.startsWith('/api/users/0/')) {
      send(res, 403, { error: 'Local API is not enabled' });
      return;
    }

    // `/api/` 根：真机用它探实例身份——**每个响应都带 `Zotero-Server-ID`**，
    // 写请求前必须先读它（缺它会被真机 428 拒绝）。这里按同一口径返回头。
    if (path === '/api/' || path === '/api') {
      send(res, 200, { message: 'Zotero API is running' }, zoteroHeaders(config, state.libraryVersion));
      return;
    }

    // `/api/local/authorize` 的探活（GET）：真机只接受 POST，这里给一个只读回执，
    // 便于测试在「不需要授权」的场景下区分「端点不存在」与「端点存在」。
    if (path === '/api/local/authorize' && req.method === 'GET') {
      send(res, 200, { ok: true }, zoteroHeaders(config, state.libraryVersion));
      return;
    }

    if (path === '/api/users/0/items/top' && req.method === 'GET') {
      const query = url.searchParams.get('q');
      let items = library.items.filter((item) => !isDeleted(item));
      const topTag = url.searchParams.get('tag');
      if (topTag !== null) {
        items = items.filter((item) =>
          (item.data.tags ?? []).some((entry) => (typeof entry === 'string' ? entry : entry.tag) === topTag),
        );
      }
      if (url.searchParams.get('collection') !== null) {
        const collection = url.searchParams.get('collection');
        items = items.filter((item) => (item.data.collections ?? []).includes(collection));
      }
      if (query !== null) {
        const needle = query.toLowerCase();
        items = items.filter((item) => JSON.stringify(item.data).toLowerCase().includes(needle));
      }
      list(200, items);
      return;
    }

    if (path === '/api/users/0/items' && req.method === 'GET' && url.searchParams.has('format')) {
      const [contentType, body] = buildExportResponse(url.searchParams.get('format'), library.items, url.searchParams);
      sendText(res, 200, body, contentType, zoteroHeaders(config, state.libraryVersion));
      return;
    }

    if (path === '/api/users/0/items' && req.method === 'GET') {
      const itemType = url.searchParams.get('itemType');
      const keys = url.searchParams.get('itemKey');
      const tag = url.searchParams.get('tag');
      // 真机 `GET /items?itemKey=<key>` 会命中**任意**条目（含附件与注释等子项），
      // 因此不能只从顶层条目里筛；此前只筛 `library.items`，导致「按 key 读回注释」在假服务器上永远为空。
      const wantsChildItem = (itemType !== null && itemType === 'annotation') || keys !== null;
      let items = (wantsChildItem ? allItems() : library.items).filter((item) => !isDeleted(item));
      if (itemType === 'attachment') {
        items = Object.values(library.children).flat().filter((entry) => entry.data.itemType === 'attachment');
      } else if (itemType !== null && itemType.length > 0 && !itemType.startsWith('-') && !itemType.includes('||')) {
        // 真机 `itemType=<单值>` 会跨顶层条目与子项（含注释）过滤；这里按同一口径补齐，
        // 否则 `itemKey=<附件>` + `itemType=annotation` 的组合在假服务器上会退化成「不过滤」。
        items = allItems().filter((item) => !isDeleted(item) && item.data.itemType === itemType);
      }
      if (keys !== null) {
        const wanted = new Set(keys.split(','));
        items = items.filter((item) => wanted.has(item.key));
      }
      if (tag !== null) {
        items = items.filter((item) =>
          (item.data.tags ?? []).some((entry) => (typeof entry === 'string' ? entry : entry.tag) === tag),
        );
      }
      list(200, items);
      return;
    }

    if (path === '/api/users/0/items/trash' && req.method === 'GET') {
      list(200, allItems().filter((item) => isDeleted(item)));
      return;
    }

    // single-item route（真机 /items/<key> 返回单个条目信封）
    const itemMatch = /^\/api\/users\/0\/items\/([^/]+)$/u.exec(path);
    if (itemMatch && req.method === 'GET') {
      const item = findItem(itemMatch[1]);
      if (item === undefined) {
        send(res, 404, { error: 'Item not found' });
        return;
      }
      if (url.searchParams.has('format')) {
        const [contentType, body] = buildExportResponse(url.searchParams.get('format'), [item], url.searchParams);
        if (body === null) {
          send(res, 400, { error: `Invalid 'format' value '${url.searchParams.get('format')}'` });
          return;
        }
        sendText(res, 200, body, contentType, zoteroHeaders(config, state.libraryVersion));
        return;
      }
      // 真机语义：include 缺省为 data；不在 include 里的字段会被删掉
      if (url.searchParams.has('include')) {
        const fields = (url.searchParams.get('include') ?? '').split(',');
        const envelope = { key: item.key, version: item.version };
        if (fields.includes('data')) envelope.data = item.data;
        if (fields.includes('bib')) envelope.bib = buildExportResponse('bib', [item], url.searchParams)[1];
        if (fields.includes('citation')) envelope.citation = buildCitationListResponse([item]);
        json(200, envelope);
        return;
      }
      json(200, toEnvelope(item));
      return;
    }

    const patchMatch = /^\/api\/users\/0\/items\/([^/]+)$/u.exec(path);
    if (patchMatch && req.method === 'PATCH') {
      readBody(req, requests)
        .then((raw) => {
          const item = findItem(patchMatch[1]);
          if (item === undefined) {
            send(res, 404, { error: 'Item not found' });
            return;
          }
          // version-conflict 模式覆盖任意写请求：这一支不走 writeGate，必须单独判定，
          // 否则正常的字段覆盖路径（PATCH）会绕过该模式（与 DELETE 一样先解析资源再判模式）。
          const conflict = versionConflict(config);
          if (conflict !== null) {
            send(res, conflict.status, conflict.body, zoteroHeaders(config, state.libraryVersion));
            return;
          }
          if (config.mode === 'unauthorized') {
            send(res, 401, { error: 'Write requires authorization' });
            return;
          }
          if (config.mode === 'rate-limited') {
            send(res, 429, { error: 'Too many requests' });
            return;
          }
          if (req.headers['authorization'] === undefined && req.headers['zotero-api-key'] === undefined) {
            send(res, 401, { error: 'Write requires authorization' });
            return;
          }
          if (req.headers['zotero-server-id'] === undefined) {
            send(res, 428, { error: 'Zotero-Server-ID header is required' });
            return;
          }
          if (req.headers['if-unmodified-since-version'] === undefined) {
            send(res, 428, { error: 'If-Unmodified-Since-Version header is required' });
            return;
          }
          if (config.conflictOnce === true && !conflictedOnce.has(item.key)) {
            conflictedOnce.add(item.key);
            send(res, 412, { error: 'Version conflict (simulated)' });
            return;
          }
          const ifVersion = Number(req.headers['if-unmodified-since-version']);
          if (Number.isFinite(ifVersion) && ifVersion !== item.version) {
            send(res, 412, { error: 'Version conflict' });
            return;
          }
          const body = JSON.parse(raw.length > 0 ? raw : '{}');
          // 真机语义（Zotero 10.0.3 实测）：PATCH body 里若带 `version`，它**同样**是版本前提，
          // 与当前版本不符时返回 412 `item version mismatch: expected <body.version>, found <item.version>`。
          // 只校验 header 会漏掉「body 带旧版本 → 无论重试多少次都 412」这一类缺陷（真机回滚实测踩到）。
          if (typeof body.version === 'number' && body.version !== item.version) {
            send(
              res,
              412,
              { error: `item version mismatch: expected ${body.version}, found ${item.version}` },
              zoteroHeaders(config, state.libraryVersion),
            );
            return;
          }
          // 真机：PATCH /items/<key> 的 body 直接是字段映射（不是 {data:…}）
          const patch = body.data ?? body;
          Object.assign(item.data, patch);
          // 真机把 {"deleted":1} 归一化成 data.deleted = true（进垃圾箱的唯一可用路径）
          if (Object.prototype.hasOwnProperty.call(patch, 'deleted')) {
            item.data.deleted = patch.deleted === true || patch.deleted === 1 || patch.deleted === '1';
          }
          item.version += 1;
          state.libraryVersion += 1;
          send(res, 204, null, zoteroHeaders(config, state.libraryVersion));
        })
        .catch((error) => send(res, 500, { error: String(error) }));
      return;
    }

    const deleteMatch = /^\/api\/users\/0\/items\/([^/]+)$/u.exec(path);
    if (deleteMatch && req.method === 'DELETE') {
      const item = findItem(deleteMatch[1]);
      if (item === undefined) {
        send(res, 404, { error: 'Item not found' });
        return;
      }
      const gate = writeGate(req, config, { requireVersionHeader: true });
      if (gate !== null) {
        send(res, gate.status, gate.body, zoteroHeaders(config, state.libraryVersion));
        return;
      }
      const ifVersion = Number(req.headers['if-unmodified-since-version']);
      if (Number.isFinite(ifVersion) && ifVersion !== item.version) {
        send(res, 412, { error: `Version conflict: found ${item.version}` }, zoteroHeaders(config, state.libraryVersion));
        return;
      }
      // 真机语义：DELETE 直接永久删除（不进垃圾箱；垃圾箱里条目的彻底删除也走这条路）
      removeItem(item);
      state.libraryVersion += 1;
      send(res, 204, null, zoteroHeaders(config, state.libraryVersion));
      return;
    }

    const childrenMatch = /^\/api\/users\/0\/items\/([^/]+)\/children$/u.exec(path);
    if (childrenMatch && req.method === 'GET') {
      // 真机语义（Zotero 10.0.3 实测 2026-09-19）：不带 `itemType` 过滤的 `/children` **不返回注释子项**
      // （附件、笔记等照旧），只有显式 `?itemType=annotation` 时才返回注释。此前这里无脑返回全部子项，
      // 让读层「用无过滤查询取注释」的缺陷在离线测试里不可见——现按真机对齐。
      const all = library.children[childrenMatch[1]] ?? [];
      const filter = url.searchParams.get('itemType');
      const filtered =
        filter === null || filter.length === 0
          ? all.filter((entry) => entry?.data?.itemType !== 'annotation')
          : all.filter((entry) => entry?.data?.itemType === filter);
      list(200, filtered);
      return;
    }

    const fileMatch = /^\/api\/users\/0\/items\/([^/]+)\/file$/u.exec(path);
    if (fileMatch && req.method === 'GET') {
      if (config.filePath === null) {
        send(res, 404, { error: 'Attachment file is not available' });
        return;
      }
      res.writeHead(302, { location: `file:///${String(config.filePath).replaceAll('\\', '/')}`, ...zoteroHeaders(config, state.libraryVersion) });
      res.end();
      return;
    }

    const fulltextMatch = /^\/api\/users\/0\/items\/([^/]+)\/fulltext$/u.exec(path);
    if (fulltextMatch && req.method === 'GET') {
      // 真机语义：逐条正文 + indexedPages / totalPages（无逐页偏移）
      const key = fulltextMatch[1];
      const content = config.fulltextContentMap?.[key] ?? config.fulltextContent;
      const totalPages = config.fulltextPages?.[key] ?? config.fulltextPagesDefault ?? 1;
      json(200, { content, indexedChars: content.length, totalChars: content.length, indexedPages: totalPages, totalPages });
      return;
    }

    if (path === '/api/users/0/fulltext' && req.method === 'GET') {
      // 真机语义：增量清单必须带 since，且只返回版本号大于 since 的条目
      const rawSince = url.searchParams.get('since');
      if (rawSince === null) {
        send(res, 400, { error: "Invalid 'since' value 'null'" }, zoteroHeaders(config, state.libraryVersion));
        return;
      }
      const since = Number(rawSince);
      if (!Number.isFinite(since) || since < 0) {
        send(res, 400, { error: `Invalid 'since' value '${rawSince}'` }, zoteroHeaders(config, state.libraryVersion));
        return;
      }
      const incremental = {};
      for (const [key, version] of Object.entries(library.fulltext)) {
        if (version > since) incremental[key] = version;
      }
      json(200, incremental);
      return;
    }

    if (path === '/api/users/0/collections' && req.method === 'GET') {
      list(200, library.collections);
      return;
    }

    if (path === '/api/users/0/collections' && req.method === 'POST') {
      readBody(req, requests)
        .then((raw) => {
          const gate = writeGate(req, config, { requireVersionHeader: true });
          if (gate !== null) {
            send(res, gate.status, gate.body, zoteroHeaders(config, state.libraryVersion));
            return;
          }
          if (config.staleVersionOnce === true && !staleVersionUsed) {
            staleVersionUsed = true;
            send(
              res,
              412,
              { error: `Library has been modified since specified version (expected 1, found ${state.libraryVersion})` },
              zoteroHeaders(config, state.libraryVersion),
            );
            return;
          }
          const parsed = JSON.parse(raw.length > 0 ? raw : 'null');
          if (!Array.isArray(parsed)) {
            // 真机硬约束：POST /collections 同样要求数组体
            send(res, 400, { error: 'Uploaded data must be a JSON array' }, zoteroHeaders(config, state.libraryVersion));
            return;
          }
          const successful = {};
          const success = {};
          const failed = {};
          parsed.forEach((body, index) => {
            if (typeof body?.name !== 'string' || body.name.length === 0) {
              failed[index] = { code: 400, message: 'Collection name is required' };
              return;
            }
            createdCounter += 1;
            const key = `NEWCOLL${String(createdCounter).padStart(2, '0')}`;
            library.collections.push({
              key,
              version: 1,
              data: { name: body.name, parentCollection: body.parentCollection ?? false },
            });
            state.libraryVersion += 1;
            const envelope = { key, version: 1, library: { type: 'user', id: 0 } };
            successful[index] = envelope;
            success[index] = envelope;
          });
          send(res, 200, { successful, success, failed }, zoteroHeaders(config, state.libraryVersion));
        })
        .catch((error) => send(res, 500, { error: String(error) }));
      return;
    }

    const collectionMatch = /^\/api\/users\/0\/collections\/([^/]+)$/u.exec(path);
    if (collectionMatch && req.method === 'GET') {
      const collection = library.collections.find((entry) => entry.key === collectionMatch[1]);
      if (collection === undefined) {
        send(res, 404, { error: 'Collection not found' });
        return;
      }
      json(200, collection);
      return;
    }
    if (collectionMatch && req.method === 'PATCH') {
      readBody(req, requests)
        .then((raw) => {
          const gate = writeGate(req, config, { requireVersionHeader: true });
          if (gate !== null) {
            send(res, gate.status, gate.body, zoteroHeaders(config, state.libraryVersion));
            return;
          }
          const collection = library.collections.find((entry) => entry.key === collectionMatch[1]);
          if (collection === undefined) {
            send(res, 404, { error: 'Collection not found' });
            return;
          }
          const ifVersion = Number(req.headers['if-unmodified-since-version']);
          if (Number.isFinite(ifVersion) && ifVersion !== collection.version) {
            send(res, 412, { error: `Version conflict: found ${collection.version}` }, zoteroHeaders(config, state.libraryVersion));
            return;
          }
          const body = JSON.parse(raw.length > 0 ? raw : '{}');
          Object.assign(collection.data, body.data ?? body);
          collection.version += 1;
          state.libraryVersion += 1;
          send(res, 200, { successful: { 0: collection.key }, version: collection.version }, zoteroHeaders(config, state.libraryVersion));
        })
        .catch((error) => send(res, 500, { error: String(error) }));
      return;
    }

    const collectionItemsMatch = /^\/api\/users\/0\/collections\/([^/]+)\/items\/top$/u.exec(path);
    if (collectionItemsMatch && req.method === 'GET') {
      const collection = collectionItemsMatch[1];
      list(200, library.items.filter((item) => (item.data.collections ?? []).includes(collection)));
      return;
    }

    if (path === '/api/users/0/tags' && req.method === 'GET') {
      list(200, library.tags);
      return;
    }

    if (path === '/api/users/0/searches' && req.method === 'GET') {
      list(200, library.searches);
      return;
    }

    const savedSearchMatch = /^\/api\/users\/0\/searches\/([^/]+)\/items$/u.exec(path);
    if (savedSearchMatch && req.method === 'GET') {
      list(200, library.items.filter((item) => item.data.collections?.includes('COLL0001')));
      return;
    }

    if (path === '/api/local/authorize' && req.method === 'POST') {
      if (config.mode === 'rate-limited') {
        send(res, 429, { error: 'Too many authorization prompts' });
        return;
      }
      // 真机语义：用户在弹窗里点「拒绝」时返回 403 {denied:true}；
      // `unauthorized` 模式用来模拟这一形态（读通道照常可用，只有写被拒），
      // 这样「本地写被拒 → 换到云端一级」的回退路径才有真实可测的触发条件。
      if (config.mode === 'unauthorized') {
        send(res, 403, { denied: true }, zoteroHeaders(config, state.libraryVersion));
        return;
      }
      send(res, 200, { key: 'FAKEKEY00000000000000000000000000' }, zoteroHeaders(config, state.libraryVersion));
      return;
    }

    if (path === '/api/users/0/items' && req.method === 'POST') {
      readBody(req, requests)
        .then((rawBatch) => {
          // version-conflict 模式覆盖任意形态的写请求：这一支不会（也不该）走到后面的 writeGate，
          // 所以在这里先判定，否则正常的数组体批量创建会绕过该模式。
          const conflict = versionConflict(config);
          if (conflict !== null) {
            send(res, conflict.status, conflict.body, zoteroHeaders(config, state.libraryVersion));
            return;
          }
          // batchWriteHandled：数组体 = 批量更新（key+version+data）
          let parsedBatch = null;
          try {
            parsedBatch = JSON.parse(rawBatch.length > 0 ? rawBatch : 'null');
          } catch {
            parsedBatch = null;
          }
          if (typeof parsedBatch === 'object' && parsedBatch !== null && !Array.isArray(parsedBatch) && typeof parsedBatch.itemType === 'string') {
            // 真机硬约束：POST /items 的 body 必须是 JSON 数组，对象体会被拒绝
            const gate = writeGate(req, config, { requireVersionHeader: true });
            if (gate !== null) {
              send(res, gate.status, gate.body, zoteroHeaders(config, state.libraryVersion));
              return;
            }
            send(res, 400, { error: 'Uploaded data must be a JSON array' }, zoteroHeaders(config, state.libraryVersion));
            return;
          }
          if (Array.isArray(parsedBatch)) {
            // 真机语义（`server_localAPI.js` 的 `writeMultipleObjects`）：无 key 的创建**不强制**
            // `If-Unmodified-Since-Version`（`_checkLibraryIfUnmodifiedSinceVersion` 的 required 缺省 false），
            // 而带 key 的写必须给出「请求级或对象级」版本前提，否则 428。
            const needsVersionHeader = parsedBatch.some(
              (entry) =>
                typeof entry?.key === 'string' &&
                entry.key.length > 0 &&
                entry.version === undefined &&
                entry.version !== null,
            );
            const gate = writeGate(req, config, { requireVersionHeader: needsVersionHeader });
            if (gate !== null) {
              send(res, gate.status, gate.body, zoteroHeaders(config, state.libraryVersion));
              return;
            }
            if (config.staleVersionOnce === true && !staleVersionUsed) {
              staleVersionUsed = true;
              send(
                res,
                412,
                { error: `Library has been modified since specified version (expected 1, found ${state.libraryVersion})` },
                zoteroHeaders(config, state.libraryVersion),
              );
              return;
            }
            const successful = {};
            const success = {};
            const unchanged = {};
            const failed = {};
            parsedBatch.forEach((entry, index) => {
              if (typeof entry !== 'object' || entry === null) {
                failed[index] = { code: 400, message: 'Invalid item data' };
                return;
              }
              // 带 key 的条目是「更新」语义：真机会整批判为 unchanged，不生效
              if (typeof entry.key === 'string') {
                unchanged[index] = entry.key;
                return;
              }
              if (typeof entry.itemType !== 'string') {
                failed[index] = { code: 400, message: 'itemType is required' };
                return;
              }
              // 注释条目（change web-api-write-fallback）：真机走 `new Zotero.Item('annotation')` +
              // `fromJSON`，因此必须是附件的子项，且 `annotationPosition` 是**JSON 字符串**
              // （`Annotations.saveFromJSON` 用 `JSON.stringify(position)` 写库；模板端点的对象形态不是写入口径）。
              if (entry.itemType === 'annotation') {
                const parentKey = typeof entry.parentItem === 'string' ? entry.parentItem : '';
                if (parentKey.length === 0) {
                  failed[index] = { code: 400, message: 'annotation requires a parentItem' };
                  return;
                }
                const parent = allItems().find((item) => item.key === parentKey);
                if (parent === undefined) {
                  failed[index] = { code: 404, message: `Parent item ${parentKey} not found` };
                  return;
                }
                if (parent.data.itemType !== 'attachment' || parent.data.contentType !== 'application/pdf') {
                  failed[index] = { code: 400, message: 'Annotations can only be added to PDF attachments' };
                  return;
                }
                if (typeof entry.annotationPosition !== 'string') {
                  failed[index] = {
                    code: 400,
                    message: 'annotationPosition must be a JSON string (not an object)',
                  };
                  return;
                }
                let position = null;
                try {
                  position = JSON.parse(entry.annotationPosition);
                } catch {
                  position = null;
                }
                if (position === null || typeof position !== 'object' || !Number.isInteger(position.pageIndex)) {
                  failed[index] = {
                    code: 400,
                    message: 'annotationPosition must be a JSON string with an integer pageIndex',
                  };
                  return;
                }
                if (typeof entry.annotationType !== 'string' || entry.annotationType.length === 0) {
                  failed[index] = { code: 400, message: 'annotationType is required' };
                  return;
                }
                // 真机硬约束（2026-09-20 实测，Zotero 10.0.3）：`itemAnnotations.sortIndex` 是 NOT NULL，
                // 缺 `annotationSortIndex` 会在 REPLACE INTO 上抛
                // "NOT NULL constraint failed: itemAnnotations.sortIndex"——写不进去。
                // 校验格式与 `data/item.js` 的 sortIndex 分支一致：`/^\d{5}\|\d{6}\|\d{5}$/`。
                if (typeof entry.annotationSortIndex !== 'string' || entry.annotationSortIndex.length === 0) {
                  failed[index] = {
                    code: 400,
                    message:
                      'NOT NULL constraint failed: itemAnnotations.sortIndex (annotationSortIndex is required)',
                  };
                  return;
                }
                if (!/^\d{5}\|\d{6}\|\d{5}$/u.test(entry.annotationSortIndex)) {
                  failed[index] = {
                    code: 400,
                    message: `Invalid sortIndex '${entry.annotationSortIndex}'`,
                  };
                  return;
                }
              }
              const { parentItem, ...fields } = entry;
              const key = nextKey(entry.itemType);
              const item = { key, version: 1, data: { ...fields } };
              if (typeof parentItem === 'string' && parentItem.length > 0) {
                item.data.parentItem = parentItem;
                library.children[parentItem] = [...(library.children[parentItem] ?? []), item];
              } else {
                library.items.push(item);
              }
              state.libraryVersion += 1;
              // 真机响应里 successful["0"] 是对象（含 key / version / library）
              const envelope = { key, version: item.version, library: { type: 'user', id: 0 } };
              successful[index] = envelope;
              success[index] = envelope;
            });
            send(res, 200, { successful, success, unchanged, failed }, zoteroHeaders(config, state.libraryVersion));
            return;
          }
          switch (config.mode) {
            case 'api-disabled':
              send(res, 403, { error: 'Local API is not enabled' });
              return;
            case 'unauthorized':
              send(res, 401, { error: 'Write requires authorization' });
              return;
            case 'missing-server-id':
              if (!hasServerId) {
                send(res, 428, { error: 'Zotero-Server-ID header is required' });
                return;
              }
              send(res, 200, { success: { 0: 'FAKEITEM1' } }, zoteroHeaders(config, state.libraryVersion));
              return;
            case 'rate-limited':
              send(res, 429, { error: 'Too many requests' });
              return;
            default:
              send(res, 200, { success: { 0: 'FAKEITEM1' } }, zoteroHeaders(config, state.libraryVersion));
          }
        })
        .catch((error) => {
          send(res, 500, { error: String(error) });
        });
      return;
    }

    send(res, 404, { error: `No route for ${req.method} ${path}` });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : Number(options.port ?? 0);
  return {
    mode: config.mode ?? 'ok',
    port,
    url: `http://127.0.0.1:${port}`,
    serverId: config.serverId,
    schemaVersion: config.schemaVersion,
    apiVersion: config.apiVersion,
    /** 请求日志（按顺序）：契约测试用它断言只读 / 只走 GET。 */
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function parseCliArgs(argv) {
  const options = { mode: 'ok', port: DEFAULT_FAKE_PORT, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--mode') options.mode = argv[++index];
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--server-id') options.serverId = argv[++index];
    else if (arg === '--schema-version') options.schemaVersion = argv[++index];
    else if (arg === '-h' || arg === '--help') options.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  return options;
}

const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      console.log(`用法：node scripts/fake-zotero.mjs [--mode <mode>] [--port <port>]

模式：${FAKE_MODES.join(' / ')}（默认 ok）
端口：默认 ${DEFAULT_FAKE_PORT}（0 表示由系统分配）`);
      process.exit(0);
    }
    const fake = await startFakeZotero(options);
    console.log(`假 Zotero 已启动：${fake.url}（mode=${fake.mode}，serverID=${fake.serverId}）`);
    console.log('按 Ctrl+C 停止。');
    const shutdown = async () => {
      await fake.close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    console.error(`启动假服务器失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
