---
name: zotero-mcp
description: 通过 zotero-mcp MCP 服务器检索、阅读并（经批准后）写入用户的本机 Zotero 文献库。当用户提到「我的 Zotero / 文献库 / 这篇论文 / 高亮 / 注释 / 引用 / .bib / 参考文献 / 找文献 / 读 PDF / 语义检索」等意图，或要求把资料整理进 Zotero 时使用本 skill。只读操作可直接执行；任何写入都必须先 dry-run 预览并获得用户确认。
license: MIT
---

# zotero-mcp 使用规范（agent 版）

这份 skill 只讲**怎么用** `zotero-mcp`：工具怎么选、写入怎么过审批、出错怎么自愈。
工具的参数级细节见仓库里的 `docs/TOOLS.md`；项目全貌见 `README.md`。

---

## 0. 两条铁律（违反即事故）

1. **写入前必须先 dry-run 并让用户看 diff**：永远先 `zotero_plan_changes` → 把计划/差异讲给用户 →
   得到明确同意后才 `zotero_apply_changes`（破坏性改动还要带 `confirm` 关键字）。
   **不要**为了"省一步"直接调 `zotero_create_item` / `zotero_update_item` / `zotero_delete_items` 等单步写工具。
2. **第一次写入会弹 Zotero 授权框**：告诉用户点 **「Always Allow」**（第二个按钮），**不是**「Allow」。
   「Allow」是一次性的——Zotero 在第一次成功写入后就删掉那条 key，下次还会再弹。
   点过 Always Allow 之后，本机 key 会被持久化（按 `Zotero-Server-ID` 分区），之后跨进程、跨 Zotero 重启都不再弹。

---

## 1. 能力边界（先判断能不能做）

| 情况 | 结论 |
| --- | --- |
| Zotero 没在运行 | 只有云端 Web API 通道可能可用；本机读写会失败，先请用户打开 Zotero |
| 写路径未开启（`ZOTERO_MCP_WRITE` 不是 `on`） | 只能读；要写请让用户开启后重启 MCP 进程 |
| 需要「上传附件字节」 | **不支持**——只能挂 `linked_file`（附件必须已在本机磁盘上） |
| 想直接改 `zotero.sqlite` | **禁止**（本项目硬规则；运行时缓存会覆盖你的改动且可能损坏库） |
| 扫描件（无文本层 PDF） | 能读元数据，但**没有可检索全文**，语义索引里也不会有它 |

---

## 2. 工具路由表（按意图）

| 用户意图 | 工具 | 关键参数 |
| --- | --- | --- |
| 找文献 / 搜库 | `zotero_search` | `query`、`mode`：`keyword` / `fulltext` / `semantic` |
| 看某条详情 | `zotero_get_items` | `keys` |
| 读正文 / PDF 文本 | `zotero_read_content` | `key`（附件 key）、`mode: fulltext`；返回含 `charRange`、`pageLabel`（估算会标 `pageLabelEstimated`） |
| 看集合 / 标签 | `zotero_list_collections` / `zotero_list_tags` | — |
| 库概览 / 缺元数据 | `zotero_library_stats` | — |
| 建索引 / 语义检索前置 | `zotero_index` | `action: build` / `update` / `status` |
| **预览写操作** | `zotero_plan_changes` | 目标 + 变更描述；产出计划与 diff |
| **提交写操作** | `zotero_apply_changes` | `confirm`（覆盖用 `OVERWRITE`、删除用 `DELETE`） |
| 批量导入 | `zotero_add_items` | DOI / arXiv 标识符，或本机 PDF 路径 |
| 写高亮 / 注释 | `zotero_attach_annotations` | 附件 key + `rects`（必填）+ `text`；走四级通道 |
| 挂附件 | `zotero_attach_file` | 本机绝对路径；**Windows 用原生反斜杠** `D:\…` |
| 笔记 | `zotero_add_note` | 父条目 key + 正文 |
| 集合 / 标签维护 | `zotero_manage_collections` / `zotero_manage_tags` | — |
| 去重 | `zotero_find_duplicates` → `zotero_merge_duplicates` | 先给用户看候选与影响面 |
| 导出引用 / `.bib` | `zotero_export` | 目标条目集合、格式 |
| 补元数据 | `zotero_enrich` | 目标 key（会外呼学术 API；离线环境会失败） |
| 与 Zotero 界面联动 | `zotero_client` | 触发同步 / 读选中条目 / 深链定位 |
| Word 引用 | `zotero_inject_citations` | 文档路径（需 Word 环境） |

---

## 3. 四个配方

### 配方 A：找一篇并读全文
```
1) zotero_search { query: "<关键词>", mode: "keyword" }     # 先拿条目
2) zotero_get_items { keys: ["<itemKey>"] }                 # 找它的 PDF 附件 key（子项）
3) zotero_read_content { key: "<attachmentKey>", mode: "fulltext" }
```
注意：`zotero_read_content` 要的是**附件 key**，不是父条目 key。用 `pageLabel` 报页码（若带
`pageLabelEstimated: true`，说明该篇页码是估算的，**引用时要说清**）。

### 配方 B：语义检索（首次需建索引）
```
1) zotero_index { action: "status" }      # 看有没有索引、模型是否匹配
2) zotero_index { action: "build" }       # 没有就建（首次会下载模型，耗时较长；1000 篇量级约 27 分钟）
3) zotero_search { query: "…", mode: "semantic" }
```
中英混合库建议让用户把 `ZOTERO_MCP_INDEX_MODEL` 设为 `multilingual`（换模型必须重建索引）。

### 配方 C：安全写入（例如把一句话标成高亮）
```
1) 先确认写路径已开启；未开启就请用户设置 ZOTERO_MCP_WRITE=on 并重启 MCP
2) zotero_plan_changes  → 把 diff 原样呈现给用户，等一句明确同意
3) zotero_apply_changes { confirm: "OVERWRITE" }（或 DELETE；按计划要求）
4) 若弹授权框：提醒用户点「Always Allow」（只需一次）
```
`zotero_attach_annotations` 的 `rects` 是**必填**的：没有坐标的高亮会落在错误位置。

### 配方 D：导出参考文献给 LaTeX / Word
```
1) zotero_search / zotero_list_collections   # 圈定范围
2) zotero_export                             # 拿 .bib / CSL 条目
3) 需要写入 Word 文档时用 zotero_inject_citations
```

---

## 4. 禁则（不要做）

- **不要绕过审批**：不预览、不问用户就直接写；也不要自己拼 `confirm` 关键字蒙混破坏性检查。
- **不要直接动 SQLite**、不要手改 `localAPIKeys.json`（Zotero 的凭证存储）。
- **不要打印凭证**：插件共享 token、local API key、云端 key 一律只输出掩码/哈希。
- **不要在没有用户明说时删东西**：`zotero_delete_items`（默认进回收站）与 `merge_duplicates` 都属高影响操作。
- **不要跑 `plugin:verify -- --rebuild`**（会改写 `build/`）——除非用户明确要求重新构建插件。
- **不要把「估算页码」当精确页码引用**；`pageLabelEstimated: true` 时必须如实告知。
- **不要在未核实的情况下声称知识库里有某篇文献**：先搜、再读、再下结论。

---

## 5. 失败码与自愈

| 现象 | 含义 | 怎么办 |
| --- | --- | --- |
| `degraded: true` + reason 含「另一个模型」/「需重建」 | 索引是为别的模型（或旧 schema）建的 | 用 `zotero_index { action: "build" }` 重建（**不要**指望静默兼容） |
| `write-unauthorized` | 授权被撤销或 key 失效 | 会**自动**重新授权一次；此时提醒用户点「Always Allow」 |
| `rate-limited`（HTTP 429） | 授权端点限流 5 次/分钟 | 停下等待窗口恢复，并把写操作聚合成一批 |
| `endpoint-missing`（插件 404） | 插件未装 / 未重启 / 版本过旧 | 让用户 `npm run plugin:verify` 自检，必要时重装 xpi 并重启 Zotero |
| `annotations-disabled`（403） | 注释端点默认关闭 | 让用户在「设置 → 高级 → 配置编辑器」把 `extensions.zoteromcp.enableAnnotations` 设为 `true` 并**重启 Zotero** |
| `local-api-disabled`（403） | 本机 Local API 未打开 | 让用户在「设置 → 高级」勾选「允许其它应用与本机 Zotero 通信」 |
| 检索为空但库里有这篇 | 可能是扫描件（无全文）或索引未建 | 先 `zotero_index { action: "status" }`，再判断 |
| 写成功但用户说「界面上没变」 | 可能是同步/刷新延迟 | 用 `zotero_client` 触发同步，或让用户看条目详情 |

---

## 6. 环境自证（需要时用，都是只读）

```bash
npm run plugin:verify     # 已安装插件是否就是当前源码构建（verdict: up-to-date / stale-build / stale-install）
npm run verify:offline    # 离线不变量：应报「被拦截的非回环请求 0 个」
npm run report:index      # 建/更索引并打印耗时与分块计数
npm run test              # 全量契约测试（提交前的四条检查之一）
```

向用户汇报时请给**可核对的数字**（例如 `top-1 40/50`、`12/12 精确`、`0 次弹窗`），而不是「应该没问题」。
