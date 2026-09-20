# Zotero MCP

**[English](README.md)** | **中文**

> **状态**：`npm test` **287/287** · `npm run plugin:verify` → **up-to-date** · `npm run verify:offline` → **0** 次非回环请求。

`zotero-mcp` 是一个**本地优先、写操作需批准**的 [Zotero](https://www.zotero.org/) MCP（Model Context Protocol）服务器。
它让 AI 助手检索、阅读并且——**在你明确批准之后**——**写入**你的 Zotero 库：条目、集合、标签、笔记、注释、附件，
并提供本地语义检索、去重、元数据补全与引用导出。

---

## 30 秒了解

- **可读也可写** —— 但只有在你预览 diff 并确认之后才会落库（`zotero_plan_changes` → `zotero_apply_changes`）。
- **四级写通道 + 如实降级**：本机 Local API → 薄插件 → 云端 Web API → 失败时清楚说明原因。
- **全部在本机完成**：语义检索用 ONNX + sqlite-vec（三种模型）；页码逐页精确，估算会如实标注。
- **可审计、可回滚**：JSONL 审计 + 快照 + 一条指令回滚；离线不变量断言零非回环请求。

---

## 1. 这是什么

```
┌────────────┐   MCP (stdio)   ┌──────────────┐  ① 本机 Local API  ┌──────────────┐
│ AI 助手    │ ───────────────▶│ zotero-mcp   │ ──────────────────▶│ Zotero 10+   │
│（任意 MCP  │                 │ MCP server   │  ② 薄插件（特权 JS）
│  客户端）  │ ◀───────────────│ (Node ≥22.16)│  ③ 云端 Web API（降级）
└────────────┘                 └──────────────┘  ④ 如实降级
```

Zotero 10 在 `localhost:23119` 暴露**本机 Local API**（读取无需鉴权；写入需要用户在弹窗里授予一条 local API key）。
有些操作只能在 Zotero 的特权作用域内完成——这些通过一个**薄插件**实现：它在 `/zoteromcp/*` 下新增六个端点。
如果本机不可达，写入可以**降级到云端 Web API**（用你自己的 zotero.org key），或者**如实失败并告诉你原因**。

---

## 2. 与其他 Zotero MCP 的差异

| 维度 | 社区常见 Zotero MCP | **本项目** |
| --- | --- | --- |
| 读写能力 | **只读**为主——例如 [kujenga/zotero-mcp](https://playbooks.com/mcp/kujenga/zotero-mcp)、[atakaragoz/zotero-mcp](https://lobehub.com/mcp/atakaragoz-zotero-mcp)、[sebastianv89/zotero-mcp](https://github.com/sebastianv89/zotero-mcp) 明确「从不请求写 key，写路径不可达」 | **可读可写**，且**默认关闭写**：`ZOTERO_MCP_WRITE=on` + `dry-run` 预览 + `confirm` 关键字之后才落库 |
| 写通道 | 一般只有一条 | **四级通道**：本机 Local API → 薄插件 → 云端 Web API → 如实降级；每轮都会报告选中哪条、为什么跳过其它 |
| 审计与回滚 | 少见 | **可回放的 JSONL 审计** + 快照 + **一条指令回滚**（失败行带错误 `code`） |
| 语义检索 | 少量项目有 | 纯本地 ONNX + sqlite-vec，**三种模型**，跨语言与 `[UNK]` 行为都有实测数字，负例违规也入表 |
| 页码精度 | 基本不涉及 | 逐页 `pageLabel` 真机 **12/12 精确**；估算页如实标 `pageLabelEstimated`；病态 PDF 有专门样本组 |

---

## 3. 环境要求

| | |
| --- | --- |
| Zotero | **10+**（开发与验证均在 **10.0.3**、Windows 上完成） |
| Node.js | **≥ 22.16**（直接运行 TypeScript 入口） |
| 操作系统 | Windows 端到端验证；macOS / Linux **尚未验证** |
| 可选 | MiKTeX（仅用于 LaTeX `.bib` 导出/编译相关流程） |
| 磁盘 | 模型约 23 MB（英）/ 24 MB（中）/ 118 MB + 17 MB tokenizer（多语种） |

---

## 4. 安装

### A. 一句话让 agent 帮你配

把下面这段贴给你的 AI agent（把 `<仓库路径或地址>` 换成实际值），然后回答它问你的问题即可。
MCP 服务器、插件构建、索引与客户端配置都可以由 agent 完成；下表标 **你** 的步骤无法自动化，
脚本里也已经要求 agent 在这些地方**停下来等你**。

```text
请在这台机器上配置 zotero-mcp（MCP 服务器），仓库位置：<仓库路径或地址>。

按下面顺序做。**凡是需要图形界面或需要我点头的步骤，停下来问我**；没有命令能证明的步骤，不许说「已完成」。
任何 token / API key 都只输出掩码，不要打印明文。

1. 克隆/拉取仓库并运行 `npm ci`。
2. 运行 `npm run plugin:build`，把生成的 `.xpi` 绝对路径告我，然后**等我**在
   Zotero → 工具 → 插件 → 齿轮 →「从文件安装插件」里装好并重启 Zotero。
3. 提醒我到 Zotero →「设置 → 高级」勾选「允许其它应用与本机 Zotero 通信」。
4. 运行 `npm run plugin:verify`，把结论给我看（预期 `up-to-date`）。若报 `stale-install`，重新构建并让我重装。
5. 问我 MCP 客户端配置文件在哪，写入服务器条目（`node packages/mcp-server/src/main.ts`、cwd=仓库、`ZOTERO_MCP_WRITE=on`），
   保存前先把 diff 给我看。
6. 运行 `npm run report:index` 构建语义索引（首次会下载模型）。
7. 先做**只读**冒烟：用 `zotero_search` 搜我指定的主题，再对命中的附件跑 `zotero_read_content`。
8. 第一次**写入**之前，提醒我 Zotero 会弹授权框、我必须点 **「Always Allow」**（第二个按钮）——
   「Allow」是一次性的，下次还会再问。
9. 最后跑 `npm test` 与 `npm run verify:offline`，把数字报给我。
```

| 步骤 | 谁来做 |
| --- | --- |
| 克隆/拉取、`npm ci`、`plugin:build`、`report:index`、写客户端配置、冒烟测试 | agent |
| 在 Zotero 里安装 `.xpi`（工具 → 插件 → 齿轮 → 从文件安装插件）并**重启 Zotero** | **你** |
| 勾选「允许其它应用与本机 Zotero 通信」 | **你** |
| 首次写入时点 **「Always Allow」**（可选：为写注释设置 `extensions.zoteromcp.enableAnnotations` 并重启） | **你** |

如果你的 agent 支持 skill，请同时让它加载 [`skills/zotero-mcp/SKILL.md`](skills/zotero-mcp/SKILL.md)——
工具路由与审批规则都在那份文件里。

### B. 手动：五步



```bash
# 1) 安装依赖
npm ci

# 2) 构建插件，然后在 Zotero 里安装
npm run plugin:build
#    Zotero → 工具 → 插件 → 齿轮 → 从文件安装插件 → 选 build/zotero-mcp-plugin-1.0.0.xpi
#    → 重启 Zotero

# 3) 打开本机 Local API
#    Zotero → 设置 → 高级 →「允许其它应用与本机 Zotero 通信」

# 4) 只读自检：确认装的就是当前源码构建的插件
npm run plugin:verify        # 预期结论：up-to-date

# 5)（可选）构建语义索引——首次会自动下载模型
npm run report:index
```

MCP 客户端配置示例：

```json
{
  "mcpServers": {
    "zotero": {
      "command": "node",
      "args": ["packages/mcp-server/src/main.ts"],
      "cwd": "/absolute/path/to/zotero-mcp",
      "env": { "ZOTERO_MCP_WRITE": "on" }
    }
  }
}
```

---

## 5. 快速上手

> **★ 唯一必须知道的一点**：**第一次写入**会弹出 Zotero 授权框。请点**「Always Allow」**（第二个按钮）——
> **不是**「Allow」。「Allow」是一次性授权：Zotero 在第一次成功写入后就把那条 key 删掉，所以下次还会再问你。
> 点「Always Allow」后，key 会按 `Zotero-Server-ID` 被记住，跨进程、跨 Zotero 重启都可复用。
> `zotero-mcp` 会把它持久化在 `<Zotero 数据目录>/zoteromcp-local-api-key.json`（0600、原子写），并且**只存 remembered key**。

```
1) 找一篇：      zotero_search  { "query": "冰芯气泡", "mode": "keyword" }
2) 读全文：      zotero_read_content { "key": "<附件 key>", "mode": "fulltext" }
3) 写一条高亮：  zotero_plan_changes → 看 diff → zotero_apply_changes { "confirm": "OVERWRITE" }
```

日常五连：`zotero_search` → `zotero_read_content` → `zotero_index`（语义检索）→
`zotero_plan_changes` / `zotero_apply_changes` → `zotero_export`。

---

## 6. 工具表（24 个全列）

标记：**★ 常用重点** · **◆ 本项目特色** · **✎ 需要写权限（`ZOTERO_MCP_WRITE=on`）**

| 大类 | 小类 | 工具 | 做什么 | |
| --- | --- | --- | --- | --- |
| **A. 读与检索** | 检索 | `zotero_search` | 关键词 / 全文 / **语义** / 保存的搜索 | ★◆ |
| | 条目 | `zotero_get_items` | 条目详情（含子项、标签、集合） | ★ |
| | 条目 | `zotero_read_content` | 全文或 **PDF 逐页文本**（`charRange`、`pageLabel`、`pageLabelEstimated`） | ★◆ |
| | 组织 | `zotero_list_collections` | 列出集合 | |
| | 组织 | `zotero_list_tags` | 列出标签 | |
| | 概览 | `zotero_library_stats` | 库健康度：计数、缺元数据、重复候选数 | |
| **B. 写 ✎** | 计划与提交 | `zotero_plan_changes` | **dry-run**：生成计划并预览 diff | ★◆ |
| | 计划与提交 | `zotero_apply_changes` | 提交计划（破坏性改动需 `confirm` 关键字） | ★◆ |
| | 条目 | `zotero_create_item` | 新建条目 | ★ |
| | 条目 | `zotero_update_item` | 更新字段 | ★ |
| | 条目 | `zotero_delete_items` | 删除条目（默认进回收站） | |
| | 条目 | `zotero_add_items` | 按标识符（DOI/arXiv）或 PDF 批量导入 | |
| | 笔记 | `zotero_add_note` | 新建子笔记（或追加） | |
| | 集合 | `zotero_manage_collections` | 新建 / 重命名 / 移动 / 删除集合 | |
| | 标签 | `zotero_manage_tags` | 增 / 删 / 改标签 | |
| | 附件 | `zotero_attach_file` | 挂载 **linked_file** 附件（不占云配额；本机路径） | ◆ |
| | 注释 | `zotero_attach_annotations` | 写入高亮 / 下划线 / 笔记（走四级通道） | ◆ |
| **C. 索引** | 语义索引 | `zotero_index` | 构建 / 增量更新 / 查看状态（含 `page_alignment` 诊断） | ★◆ |
| **D. 文献整理** | 去重 | `zotero_find_duplicates` | 查找重复候选（强键 / 弱键） | |
| | 去重 | `zotero_merge_duplicates` | 合并重复条目 | |
| | 引用 | `zotero_export` | 导出 `.bib` / CSL 引用（对 LaTeX 友好） | ★ |
| **E. 学术情报** | 补全 | `zotero_enrich` | 通过 OpenAlex / Semantic Scholar / Crossref / Unpaywall / PubMed 补元数据 | ◆ |
| **F. 插件与联动** | 插件通道 | `zotero_client` | 触发同步 / 读选中条目 / 深链定位 | ◆ |
| | 写作 | `zotero_inject_citations` | 注入 / 刷新 Word 域代码 | ◆ |

带参数的完整参考由脚本生成：**[`docs/TOOLS.md`](docs/TOOLS.md)**（`npm run docs:tools`）。

---

## 7. 配置项

| 环境变量 | 含义 |
| --- | --- |
| `ZOTERO_MCP_WRITE` | `on` 才允许写入（默认只读） |
| `ZOTERO_MCP_BASE_URL` | 本机 API 地址（默认 `http://127.0.0.1:23119`） |
| `ZOTERO_MCP_DATA_DIR` | Zotero 数据目录（默认 `~/Zotero`）——共享 token、落盘的写授权都在这里 |
| `ZOTERO_MCP_AUDIT_DIR` / `ZOTERO_MCP_CACHE_DIR` | 审计日志 / 缓存位置 |
| `ZOTERO_MCP_INDEX_DIR` / `ZOTERO_MCP_INDEX_MODEL` | 语义索引目录 / 模型（`default`、`chinese`\|`zh`、`multilingual`\|`multi`） |
| `ZOTERO_MCP_PLUGIN_TOKEN` | 覆盖插件共享 token（否则读 `<数据目录>/zoteromcp-token.txt`） |
| `ZOTERO_MCP_WEB_API_KEY` / `ZOTERO_MCP_WEB_API_LIBRARY` | 云端降级凭证（或 `<数据目录>/zoteromcp-web-api.json`） |
| `ZOTERO_MCP_CROSSREF_MAILTO`、`ZOTERO_MCP_TRANSLATION_*` | 补全功能用到的礼貌标识 / 翻译端点 |

插件侧偏好：`extensions.zoteromcp.enableAnnotations`（布尔，默认 **false**）控制注释端点。
⚠️ **重装插件会把它重置为 `false`**，且该偏好是**启动时读取**的——请在「设置 → 高级 → 配置编辑器」里设置后**重启 Zotero**。

---

## 8. 写安全模型

1. **未显式开启写路径就绝不写入**（`ZOTERO_MCP_WRITE=on`）。
2. `zotero_plan_changes` 生成计划；破坏性改动必须在 `zotero_apply_changes` 里带 `confirm` 关键字（`OVERWRITE`、`DELETE`）。
3. 每个操作都写入 **审计 JSONL**（含错误 `code`），并在写前留下**快照**。
4. 回滚只需一条针对快照的指令。
5. 通道选择是显式且被报告的：本机 Local API → 插件 → 云端 Web API → 如实失败。
6. **授权是持久化的**：点一次「Always Allow」之后不再弹窗——key 按 `Zotero-Server-ID` 存在
   `<Zotero 数据目录>/zoteromcp-local-api-key.json`，复用直到你主动撤销。

---

## 9. 语义检索与索引

| 模型别名 | 模型 | 维度 | 说明 |
| --- | --- | --- | --- |
| `default` | `all-MiniLM-L6-v2-quantized` | 384 | 英文；总体最优的默认值；中文 `[UNK]` 比例高（约 73–77 %） |
| `chinese` / `zh` | `bge-small-zh-v1.5-quantized` | 512 | 中文查询；英文较弱 |
| `multilingual` / `multi` | `paraphrase-multilingual-MiniLM-L12-v2-quantized` | 384 | **中英混合最优**：在受控语料上跨语言 top-1 18/20，而英文缺省 0/20、中文模型 0/20 |

```bash
npm run report:index                          # 建/更索引（含各阶段耗时、分块计数）
npm run report:index -- --synthetic 1000      # 规模口径：1000 篇 / 32000 分块 ≈ 26.8 分钟全量，
                                              # 库未变时的增量更新 0.6 秒、零嵌入
npm run eval:semantic -- --json               # 三列对照评测
npm run report:page-align                     # 逐篇页边界精确率（真机 12/12 精确）
npm run report:page-labels -- <itemKey>       # 逐页标签读数，可与阅读器对照
```

**换模型必须重建索引**（索引里记录 `model_id`，混用会被拒绝而不是静默复用）。
索引 **schema 已版本化（1 → 2）**，旧 schema 会触发重建。

---

## 10. 验证与可信度（完整版）

**提交前必过的四条检查**（撰写本文件时全绿）：

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 单元 + 契约测试 | `npm test` | **287 / 287**，0 fail，0 skip |
| 类型 | `npm run typecheck` | 干净 |
| 生成物与文档同步 | `npm run docs:tools` | 无 diff（24 个工具） |
| 离线不变量 | `npm run verify:offline` | 被拦截的非回环请求 **0** 个 |

另有：`npm run plugin:verify`（已安装 `.xpi` 的哈希 **==** 现构建产物；当前 `a93749277c742bd1…`、33 477 B → **up-to-date**）；
以及：在**没有模型缓存**的干净克隆上，依赖模型的测试会**跳过**而不是失败（这是刻意的）。

**真机证据**（带日期、可复现的记录）与每个改动的验收报告**保存在仓库之外**；仓库内的检查就是上面那张
四条检查表 + `plugin:verify` + `verify:offline`。

---

## 11. 已知边界

- **平台覆盖**：端到端证据只覆盖 **Windows + Zotero 10.0.3**。macOS/Linux、组库、Zotero 10.0.2、第二个云账号
  **均未验证**。
- **Windows 上 linked 附件的路径必须是原生反斜杠**（`D:\…`）：正斜杠虽然 API 接受，但 Zotero 之后会报「找不到文件」。
- **扫描件（无文本层）不会进入语义索引**——Zotero 本身就没有它们的全文。
- **Zotero 不会为空白页插入 `\f`**，因此含空白页的 PDF 会退回**估算页边界**（`no-separators`），而不是部分精确。
- **`count-mismatch`**（分隔符数与页数不符）目前只有契约测试覆盖，真机难以自然产生。
- **规模**：1000 篇 = 32000 分块 ≈ **26.8 分钟**全量（其中约 90 % 花在嵌入）；库未变时的增量更新 **0.6 秒**、零嵌入。
  真实变更时只重嵌变化的条目。
- **真实库规模未验证**：252 篇的评测用的是**受控合成语料**（刻意堆满近似重复），其绝对数字**不能**外推到真实 200+ 篇库。
- **附件字节上传未实现**：`zotero_attach_file` 只支持 `linked_file`（不占云配额）；stored-file 上传属后续改动。
- **模型缓存不入仓库**：干净克隆上语义相关测试会跳过，直到 `npm run report:index` 下载过模型。
- **多进程写落盘 key 未加锁**（频率极低，最坏情况是多弹一次授权框）。
- 两条审计观察项按现状保留：create 失败时计划汇总行记为 `failed: [null]`；计划汇总行不带逐操作的错误 `code`。

---

## 12. 故障排查 / FAQ

| 现象 | 原因与处理 |
| --- | --- |
| 每次写入都弹 Zotero 授权框 | 你点的是 **「Allow」**（一次性）。Zotero 在第一次成功写入后就删掉那条 key。先「设置 → 高级 → Clear Write Authorizations」清掉，然后点一次 **「Always Allow」**。本项目也会持久化 remembered key，之后就不会再问 |
| 重装插件后注释写不了 | 重装会把 `enableAnnotations` 重置为 `false`；重新打开并**重启 Zotero**（该偏好启动时读取） |
| `/api/local/authorize` 返回 `429` | Zotero 对该端点限流 5 次/分钟；把写操作聚合成批，而不是每个操作都授权一次 |
| 检索报「需要重建索引」 | 索引是用另一个 `model_id`（或旧 schema）建的，用 `npm run report:index` 重建 |
| 索引目录搬迁后检索为空 | 索引是本机的、且被 gitignore；拷贝 `cache/` 或重建 |
| `plugin:verify` 报 `stale-install` | 已安装的 `.xpi` 与构建产物不一致：`npm run plugin:build` → 在 Zotero 里重装 → 重启 |
| 干净克隆上语义测试被跳过 | 模型缓存不入仓库；跑一次 `npm run report:index` 下载即可 |

---

## 13. 开发

```
packages/core/          能力层：读写管线、通道、审计、引用、补全 …
packages/indexer/       分块、分词器（WordPiece + SentencePiece unigram）、ONNX 嵌入、sqlite-vec 存储
packages/mcp-server/    MCP 工具面（24 个工具）与服务入口
packages/zotero-plugin/ 薄插件（bootstrap.js、manifest.json、src/plugin.js → content/channel.js）
scripts/                构建、报告、评测、离线验证、文档生成
tests/contract/         契约测试（假 Zotero 服务器 + 注入 fetch）
docs/                   设计、交付说明、证据、路线图、每个改动的归档
```

任何改动的流程都是：**Shape → Build → 独立只读验收 → 归档**（Comet Native）。
每个改动的 brief、验收报告与工作流状态**保存在本地、不随本仓库发布**。提交必须保持四条检查全绿。

---

## 14. 文档地图

| 主题 | 文档 |
| --- | --- |
| **给 AI agent 用的 skill** | [`skills/zotero-mcp/SKILL.md`](skills/zotero-mcp/SKILL.md) |
| 工具参考（生成） | [`docs/TOOLS.md`](docs/TOOLS.md) |

设计说明、交付报告与真机证据保存在仓库之外——需要时请联系维护者。

---

## 15. 许可证与致谢

MIT —— 见 [LICENSE](LICENSE)。站在这些项目的肩膀上：`onnxruntime-node`、`sqlite-vec`、`unpdf`/`pdf.js`、`esbuild`、`zod`，以及 Zotero 本机 API。
Zotero 是 Corporation for Digital Scholarship 的商标；本项目与官方无隶属关系。
