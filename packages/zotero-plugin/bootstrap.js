/**
 * Zotero MCP Channel 插件引导脚本（Zotero 7+ bootstrapped extension）。
 *
 * 这里只做三件事：加载打包好的主逻辑、在 `startup` 时注册端点、在 `shutdown` / `uninstall`
 * 时把端点清理干净。所有业务逻辑在 `content/channel.js`（由 `npm run plugin:build` 用 esbuild
 * 从 `src/plugin.js` 内联 `zotero-plugin-toolkit` 后生成）。
 *
 * 事实依据（Zotero 10.0.3 源码）：`Zotero.Plugins` 会以 `params = { id, version, rootURI }`
 * 调用 bootstrap 的 `startup` / `shutdown` / `onMainWindowLoad` / `onMainWindowUnload` /
 * `install` / `uninstall`，并在插件作用域内注入 `Zotero`、`Services`、`IOUtils`、`PathUtils` 等全局；
 * `rootURI` 以 `/` 结尾，可直接拼接文件名。
 */

var ZoteroMCPChannel;

function log(message) {
  Zotero.debug(`Zotero MCP Channel: ${message}`);
}

function install() {
  log('installed');
}

async function startup({ id, version, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) return;
  Services.scriptloader.loadSubScript(`${rootURI}content/channel.js`);
  ZoteroMCPChannel = ZoteroMCPChannel.create({ id, version, rootURI });
  await ZoteroMCPChannel.startup();
  log(`started ${version}`);
}

function onMainWindowLoad({ window }) {
  ZoteroMCPChannel?.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
  ZoteroMCPChannel?.onMainWindowUnload(window);
}

function shutdown({ id, version, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) return;
  ZoteroMCPChannel?.shutdown();
  ZoteroMCPChannel = undefined;
  log(`shut down ${version}`);
}

function uninstall() {
  log('uninstalled');
}
