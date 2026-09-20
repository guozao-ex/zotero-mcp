# Zotero MCP Channel（薄插件）

这是 [zotero-mcp](../../README.md) 的薄 Zotero 插件：它把**只有 Zotero 桌面端能做到**的几件事暴露成回环 HTTP 端点（共六条），供本仓库的 MCP 服务器调用。

| 端点 | 方法 | 作用 |
| --- | --- | --- |
| `/zoteromcp/health` | `GET` | 插件版本、端点清单、同步状态与 HTTP 服务器信息 |
| `/zoteromcp/sync` | `POST` | 触发一次后台同步，回报 `{running, lastSync}` 供轮询 |
| `/zoteromcp/select-items` | `POST` | 让 Zotero 主窗口选中指定条目 |
| `/zoteromcp/merge` | `POST` | 请求合并条目（**执行前必弹 Zotero 确认框**） |
| `/zoteromcp/recognize-pdf` | `POST` | 调用 Zotero 自己的识别器就地补全 PDF 元数据 |
| `/zoteromcp/annotations` | `POST` | 写入注释（**默认关闭**，需把 pref `extensions.zoteromcp.enableAnnotations` 设为 true） |

## 构建

```bash
npm run plugin:build     # 产出 build/zotero-mcp-plugin-<版本>.xpi
```

构建会用 esbuild 把 `src/plugin.js`（连同 `zotero-plugin-toolkit`）内联成单文件经典脚本，再用仓库内自写的零依赖 ZIP 写入器打包；同样输入必然产出同样字节。

## 安装

Zotero → **工具 → 插件 → 右上角齿轮 ⚙️ → 从文件安装插件…** → 选 `build/` 下的 `.xpi` → **重启 Zotero**。

## 鉴权

所有端点都要求请求头 `X-ZoteroMCP-Token`，其值取自 `<Zotero 数据目录>/zoteromcp-token.txt`；文件缺失或为空时插件拒绝服务。详见 [docs/PLUGIN.md](../../docs/PLUGIN.md)。

## 没装这个插件也能写注释

注释写入走**四级回退**：① 本插件的 `/zoteromcp/annotations` → ② **本机 Local API 写**（Zotero 10+ 自带的 `127.0.0.1:23119/api/`，首次写入弹一次授权框；不出本机、免云凭证、可断网）→ ③ **云端 Web API 写**（需显式配置凭证，未配置时零外呼）→ ④ 如实降级为「等待自动同步」。
即：**未安装本插件时，第 ② 级就能把注释写进本机库**。配置与边界见 [docs/WEB_API_FALLBACK.md](../../docs/WEB_API_FALLBACK.md)。

> 完整说明（token 生成与轮换、安全模型、已知风险、依赖与许可）都在 [`docs/PLUGIN.md`](../../docs/PLUGIN.md)。
