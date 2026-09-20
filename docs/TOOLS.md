# MCP 工具参考

> 本文件由 `npm run docs:tools` 从 `packages/mcp-server/src/tools.ts` 生成，请勿手工编辑。

当前公开工具：**24** 个（读工具 10 个 + 写 / 整理工具 9 个 + 研究工具 2 个 + 合并工具 1 个 + 索引工具 1 个 + 写作工具 1 个，路线图要求不超过 24 个）。

约定：读工具无副作用；会改动文库的工具（写 / 整理工具、`zotero_enrich`、`zotero_client(mode=recognize)`、`zotero_merge_duplicates`）默认 `dryRun=true` 只返回计划，提交需要 `dryRun=false` 且服务端 `ZOTERO_MCP_WRITE=on`（破坏性操作还要 `confirm`）；只写本地缓存 / 文件的 `zotero_index` 与 `zotero_inject_citations` 不受该总闸约束，但同样默认 `dryRun=true`。所有真实库访问都走回环地址的 Local API，缓存按 serverID 分区。

## `zotero_search`

**检索文献**

在本地 Zotero 库中检索条目。mode=keyword 检索标题/作者/年份，mode=fulltext 走全文索引，mode=saved 执行保存搜索（本地 API 独有端点 /searches/<key>/items），mode=semantic 走本地语义索引并返回段落级命中（含 itemKey、精确字符区间、页码与估算标记、相似度分数）。语义索引不存在、为空或模型不可用时如实降级为关键词 / 全文检索并带 degraded 与可读原因，绝不假装成功。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `mode` | string（keyword / fulltext / saved / semantic） | 是 | 检索模式；semantic 需要先跑 zotero_index(action=build|update) |
| `query` | string | 否 | keyword / fulltext 模式的检索词 |
| `savedSearchKey` | string | 否 | saved 模式使用的保存搜索 key |
| `itemType` | string | 否 | 按条目类型过滤 |
| `tag` | string | 否 | 按标签过滤（支持布尔语法） |
| `collection` | string | 否 | 限定集合 key |
| `limit` | integer | 否 | 返回条数上限，默认 25 |
| `start` | integer | 否 | 分页起点 |

## `zotero_get_items`

**读取条目详情**

按 key 读取条目详情，支持批量（自动按 50 个一批）与 include=attachments,annotations,notes 附加子项；注释返回 annotationPageLabel 与 zotero://open-pdf 深链接。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keys` | array | 是 | 条目 key 列表（超过 50 个自动分批） |
| `include` | array | 否 | 附加内容 |

## `zotero_list_collections`

**列出集合树**

返回集合树（含父子关系、可读路径与条目计数）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `withCounts` | boolean | 否 | 是否附带条目计数（默认 true） |

## `zotero_list_tags`

**列出标签**

返回标签与出现频次（numItems）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `limit` | integer | 否 | 返回条数上限，默认 100 |

## `zotero_read_content`

**读取内容**

mode=path 经 /items/<key>/file 的 302 取本地文件路径；mode=fulltext 取全文索引内容。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `key` | string | 是 | 附件 key |
| `mode` | string（path / fulltext） | 是 | 读取方式 |

## `zotero_find_duplicates`

**查找重复候选**

重复候选聚类：强键（DOI / ISBN / PMID 归一化精确匹配）加弱键（同 itemType + 年份相差不超过容差 + 首作者姓与标题的 Jaro-Winkler 阈值）。返回候选簇、建议主记录（附件 → 注释 → 集合 → 字段完整度）与统计；纯读，不执行合并（合并由 M4 的插件通道负责）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `includeWeakKeys` | boolean | 否 | 是否启用弱键聚类，默认 true |
| `threshold` | number | 否 | 标题与首作者姓的相似度阈值，默认 0.9 |
| `yearTolerance` | integer | 否 | 弱键的年份容差，默认 1 |
| `explain` | boolean | 否 | 是否附带被拒对的诊断（弱键失败原因），默认 false |

## `zotero_export`

**引用与导出**

导出条目引用：format=bib/bibtex/csljson/ris 为整条记录，citation/bibliography 为格式化引用（可传 style 与 locale）；format=citavi 导出该条目 PDF 注释的「可导入高亮清单」（Citavi 6 交换 XML，Zotero 自带 Citavi 导入器可直接导入并创建注释条目，颜色会落到 Citavi 调色板且导入会新建条目）。可选 outPath 落盘（默认不覆盖已有文件）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keys` | array | 是 | 条目 key 列表（≤50） |
| `format` | string（bib / bibtex / csljson / ris / citation / bibliography / citavi） | 是 | 导出格式 |
| `style` | string | 否 | citation / bibliography 的 CSL 样式 |
| `locale` | string | 否 | citation / bibliography 的语言 |
| `outPath` | string | 否 | 落盘路径（本地文件系统） |
| `overwrite` | boolean | 否 | 是否允许覆盖已存在文件，默认 false |

## `zotero_plan_changes`

**生成写计划（dry-run）**

把「条目 key + 字段 + 新值」意图归一化为 ChangePlan，返回逐字段 before → after diff 与影响面统计；不落盘、不写库。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `updates` | array | 是 | 字段更新意图列表 |

## `zotero_apply_changes`

**提交写计划**

提交 ChangePlan：默认只读（需 write=true 且服务端 ZOTERO_MCP_WRITE=on）→ 一次授权 → 写前快照 → 批量提交（版本前置 + Zotero-Server-ID）→ 审计；412 自动重建计划重试。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `plan` | unknown | 是 | 由 zotero_plan_changes 返回的 plan 对象 |
| `write` | boolean | 否 | 必须显式为 true 才写入，默认只预览 |
| `confirm` | string | 否 | 破坏性计划的确认关键字 |

## `zotero_library_stats`

**库健康度**

返回条目总数、缺 PDF、缺 DOI、缺元数据、未分类、重名作者与条目类型分布。

参数：无。

## `zotero_create_item`

**新建条目**

按 itemType + fields（可选 creators / collections）新建条目。默认 dryRun=true 只返回计划与影响面；dryRun=false 且服务端 ZOTERO_MCP_WRITE=on 时经写安全管线提交（一次授权 → 写前快照 → POST /items → 回读校验 → 审计 JSONL），新条目 key 会出现在结果、快照与审计中。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `itemType` | string | 是 | Zotero 条目类型（journalArticle / book / conferencePaper …） |
| `fields` | object | 否 | 字段映射（title / DOI / date / publicationTitle / extra …） |
| `creators` | array | 否 | 创建者列表 |
| `collections` | array | 否 | 加入的集合 key 列表 |
| `dryRun` | boolean | 否 | 默认 true：只返回计划与 diff；false 才经写安全管线提交（需要服务端 ZOTERO_MCP_WRITE=on） |
| `confirm` | string | 否 | 破坏性操作的确认关键字（永久删除 DELETE；覆盖已有值/标签重命名 OVERWRITE） |

## `zotero_update_item`

**更新条目字段**

更新既有条目：可传 updates（key + field + value）或 keys + fields。复用 change 4 的计划路径，dryRun=true 时返回逐字段 before → after diff；覆盖已有非空值属于破坏性操作，需 confirm="OVERWRITE"。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `updates` | array | 否 | 字段更新意图列表 |
| `keys` | array | 否 | 批量应用同一组字段时的条目 key 列表 |
| `fields` | object | 否 | 与 keys 搭配的字段映射 |
| `mode` | string（patch） | 否 | 本轮仅支持 patch（逐字段 PATCH，PUT 整对象覆盖留给后续 change） |
| `dryRun` | boolean | 否 | 默认 true：只返回计划与 diff；false 才经写安全管线提交（需要服务端 ZOTERO_MCP_WRITE=on） |
| `confirm` | string | 否 | 破坏性操作的确认关键字（永久删除 DELETE；覆盖已有值/标签重命名 OVERWRITE） |

## `zotero_delete_items`

**删除条目（默认进垃圾箱）**

删除条目：默认只移入垃圾箱（真机用 PATCH deleted=1，条目出现在 /items/trash 且可从垃圾箱恢复）；permanent=true 先用 DELETE 彻底删除（真机 DELETE 不会进垃圾箱），需要 confirm="DELETE"。只作用于显式传入的 keys。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `keys` | array | 是 | 要删除的条目 key 列表（白名单，禁止全库批量） |
| `permanent` | boolean | 否 | true = 彻底删除（先移入垃圾箱再删除），默认 false 只进垃圾箱 |
| `dryRun` | boolean | 否 | 默认 true：只返回计划与 diff；false 才经写安全管线提交（需要服务端 ZOTERO_MCP_WRITE=on） |
| `confirm` | string | 否 | 破坏性操作的确认关键字（永久删除 DELETE；覆盖已有值/标签重命名 OVERWRITE） |

## `zotero_manage_collections`

**集合管理**

集合整理：action=create（新建，可带 parentCollection）/ rename（重命名）/ addItems / removeItems（条目归属只作用于显式传入的 keys）。返回受影响对象清单与审计路径。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | string（create / rename / addItems / removeItems） | 是 | 集合操作 |
| `name` | string | 否 | create / rename 使用的集合名 |
| `collectionKey` | string | 否 | rename / addItems / removeItems 的目标集合 key |
| `parentCollection` | string | 否 | create 时的父集合 key |
| `keys` | array | 否 | addItems / removeItems 的条目 key 列表 |
| `dryRun` | boolean | 否 | 默认 true：只返回计划与 diff；false 才经写安全管线提交（需要服务端 ZOTERO_MCP_WRITE=on） |
| `confirm` | string | 否 | 破坏性操作的确认关键字（永久删除 DELETE；覆盖已有值/标签重命名 OVERWRITE） |

## `zotero_manage_tags`

**标签管理**

标签整理：action=add / remove（需要 keys + tags，只作用于显式传入的 keys）；action=rename（from → to，默认覆盖所有使用该标签的条目，可用 keys 限定范围，属于破坏性操作，需 confirm="OVERWRITE"）。返回受影响对象清单与审计路径。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | string（add / remove / rename） | 是 | 标签操作 |
| `tags` | array | 否 | add / remove 使用的标签列表 |
| `keys` | array | 否 | 作用范围的条目 key 列表（rename 时可选） |
| `from` | string | 否 | rename 的旧标签 |
| `to` | string | 否 | rename 的新标签 |
| `dryRun` | boolean | 否 | 默认 true：只返回计划与 diff；false 才经写安全管线提交（需要服务端 ZOTERO_MCP_WRITE=on） |
| `confirm` | string | 否 | 破坏性操作的确认关键字（永久删除 DELETE；覆盖已有值/标签重命名 OVERWRITE） |

## `zotero_attach_file`

**挂载附件（linked）**

在父条目下挂载 linked 附件（path 必须是本机绝对路径且文件存在）；reuseExisting 默认 true：同路径已有附件时直接复用其 key，不重复新建。附件文件字节上传属后续 change。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `parentKey` | string | 是 | 父条目 key |
| `mode` | string（linked） | 否 | 本轮只支持 linked（linked_file） |
| `path` | string | 是 | 本机文件的绝对路径 |
| `title` | string | 否 | 附件标题，默认取文件名 |
| `reuseExisting` | boolean | 否 | 同路径已存在附件时复用（默认 true） |
| `dryRun` | boolean | 否 | 默认 true：只返回计划与 diff；false 才经写安全管线提交（需要服务端 ZOTERO_MCP_WRITE=on） |
| `confirm` | string | 否 | 破坏性操作的确认关键字（永久删除 DELETE；覆盖已有值/标签重命名 OVERWRITE） |

## `zotero_add_note`

**新建或更新笔记**

在父条目下新建笔记（parentKey + content），或更新既有笔记（noteKey + content）。纯文本会被包成 HTML 段落；笔记属于条目子项，写入同样经过写安全管线。fromAnnotations=true 时不写 content：改读目标的注释（父条目下 PDF 附件的注释，或目标自身就是附件时的注释子项），拼成含 zotero://open-pdf 深链接的结构化 note，每条注释恰好一个深链接；目标没有注释、或与 content / noteKey 同时给出时一律拒绝且不写库。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `parentKey` | string | 否 | 新建笔记时的父条目 key（fromAnnotations=true 时必填） |
| `noteKey` | string | 否 | 更新既有笔记时的笔记 key |
| `content` | string | 否 | 笔记内容（HTML 片段或纯文本）；fromAnnotations=true 时不要给 |
| `fromAnnotations` | boolean | 否 | true 时由目标的注释生成结构化 note（含 zotero://open-pdf 深链接），与 content / noteKey 互斥 |
| `dryRun` | boolean | 否 | 默认 true：只返回计划与 diff；false 才经写安全管线提交（需要服务端 ZOTERO_MCP_WRITE=on） |
| `confirm` | string | 否 | 破坏性操作的确认关键字（永久删除 DELETE；覆盖已有值/标签重命名 OVERWRITE） |

## `zotero_add_items`

**导入条目（标识符 / PDF）**

mode=identifier：把 DOI / ISBN / PMID 解析为条目元数据（优先本地 translation-server，端口 1969；不可用时回退直连 Crossref / OpenLibrary / PubMed），解析成功才经写安全管线建条目，结果里标注所用通道；解析失败返回可读原因且不写库。mode=pdf：对本地 PDF（path）或库内附件（itemKey）跑四级识别链（L1 文本层正则 / L2 PDF 信息与 XMP / L3 translation-server / L4 标题检索），识别成功则建条目并按需挂 linked 附件，识别不出时降级为 needs-metadata（独立附件条目或给既有附件补标签；未拿到 DOI 时按 document 建条目）。两种模式都默认 dryRun=true，只有 dryRun=false 且服务端 ZOTERO_MCP_WRITE=on 才提交。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `mode` | string（identifier / pdf） | 是 | identifier 按标识符导入；pdf 先跑四级识别链再入库 |
| `identifier` | string | 否 | mode=identifier：标识符本体（可带 doi: / https://doi.org/ 前缀） |
| `identifierType` | string（auto / doi / isbn / pmid） | 否 | mode=identifier：显式指定类型，默认 auto |
| `path` | string | 否 | mode=pdf：本地 PDF 绝对路径 |
| `itemKey` | string | 否 | mode=pdf：库内附件 key（可用 Zotero 全文索引） |
| `attach` | boolean | 否 | mode=pdf 且提供 path 时是否把 PDF 挂成新条目的 linked 附件，默认 true |
| `dryRun` | boolean | 否 | 默认 true：只返回计划与 diff；false 才经写安全管线提交（需要服务端 ZOTERO_MCP_WRITE=on） |
| `confirm` | string | 否 | 破坏性操作的确认关键字（永久删除 DELETE；覆盖已有值/标签重命名 OVERWRITE） |

## `zotero_attach_annotations`

**写入注释（四级回退通道）**

把注释（highlight / underline / note / image / ink）写入指定 PDF 附件。插件端点在 Zotero 自带 HTTP 服务器上，插件不可用时按四级回退逐级尝试：① 插件端点 /zoteromcp/annotations（默认关闭，需打开插件 pref）→ ② 本机 Local API 写（Zotero 10+ 官方写入通道，首次写入会在 Zotero 弹一次授权框；不出本机、免云凭证）→ ③ 云端 Web API 写 https://api.zotero.org（**必须显式配置** ZOTERO_MCP_WEB_API_KEY + ZOTERO_MCP_WEB_API_LIBRARY 或 <Zotero 数据目录>/zoteromcp-web-api.json；未配置时零外呼）→ ④ 如实降级为「等待自动同步」。结果里给出最终通道、逐级尝试记录与失败原因、创建的注释 key、被跳过的重复项（幂等：类型+位置+正文+批注全同则跳过）与快照/审计路径；任何一级失败都不会被写成成功。默认只读（dryRun=true 只出计划与通道探测结论）；dryRun=false 需要 confirm="WRITE" 且服务端 ZOTERO_MCP_WRITE=on，否则在发出任何写请求之前拒绝。本轮只做创建，不做注释的编辑与删除。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `attachmentKey` | string | 是 | 目标 PDF 附件 key（注释是它的子项） |
| `annotations` | array | 是 | 要写入的注释（1–50 条） |
| `dryRun` | boolean | 否 | 默认 true：只返回计划与 diff；false 才经写安全管线提交（需要服务端 ZOTERO_MCP_WRITE=on） |
| `confirm` | string | 否 | 写入确认关键字：注释写入需 confirm="WRITE" |

## `zotero_enrich`

**元数据补全（学术情报）**

按 DOI（条目无 DOI 时用标题在 OpenAlex 回退检索，Jaro-Winkler ≥ 0.8 才采纳并标注相似度）级联外部学术 API，取回引用数与影响力（OpenAlex cited_by_count、Semantic Scholar citationCount / influentialCitationCount）、撤稿标记（OpenAlex is_retracted / Crossref updated-by / PubMed pubtype）、OA 级联（Unpaywall → Semantic Scholar openAccessPdf → arXiv → PMC）与期刊缩写（Crossref short-container-title 优先），写入 extra 托管块、journalAbbreviation（仅补空）与标签（retracted / open-access / needs-enrichment）；全部源失败时降级为 needs-enrichment 标签且不写任何字段。外呼一律带 mailto 标识、按主机限速并命中本地缓存。默认 dryRun=true 只返回计划与逐条情报；dryRun=false 且服务端 ZOTERO_MCP_WRITE=on 时经写安全管线提交（一次授权 → 写前快照 → 逐条 PATCH → 回读校验 → 审计 JSONL）。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `mode` | string（metadata / retractions） | 是 | metadata 取全部四类情报；retractions 只外呼 OpenAlex / Crossref / PubMed 三个撤稿信号源，写入内容即为这三源返回的情报 |
| `keys` | array | 是 | 条目 key 列表（显式白名单，禁止全库扫描） |
| `sources` | array | 否 | 限定源子集，缺省全开 |
| `dryRun` | boolean | 否 | 默认 true：只返回计划与 diff；false 才经写安全管线提交（需要服务端 ZOTERO_MCP_WRITE=on） |
| `confirm` | string | 否 | 破坏性操作的确认关键字（永久删除 DELETE；覆盖已有值/标签重命名 OVERWRITE） |

## `zotero_client`

**插件通道（同步 / 定位）**

调用薄插件在 Zotero 自带 HTTP 服务器上暴露的端点：mode=health 返回插件版本、端点清单与同步状态；mode=sync 触发一次后台同步并回报 {running, lastSync} 供轮询；mode=reveal 返回 zotero:// 深链接文本（给 page 时是 open-pdf 链接，页码为 Zotero 的 1-based 口径），插件可用时还会让 Zotero 主窗口直接选中该条目；mode=recognize 默认只输出「将对哪些 key 调用 Zotero 识别器」的只读计划与写前快照路径，dryRun=false + confirm="OVERWRITE" 且服务端 ZOTERO_MCP_WRITE=on 时才调用插件的 /zoteromcp/recognize-pdf 就地补全元数据，并逐条给出识别前后可见字段的 before → after 对照。插件未安装、token 未配置或 token 不匹配、HTTP 服务器未开启时一律如实降级为 {pluginAvailable:false, reason, hint}，绝不假装成功；深链接不依赖插件，永远可用。除 mode=recognize 的写路径外，本工具不进入写安全管线、不产生审计与快照。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `mode` | string（health / sync / reveal / recognize） | 是 | health 看插件与同步状态；sync 触发一次同步；reveal 生成深链接并尽力让 Zotero 选中条目；recognize 调用 Zotero 自己的识别器补全 PDF 元数据 |
| `key` | string | 否 | mode=reveal 必填：条目 key |
| `page` | integer | 否 | mode=reveal：1-based 页码，给了就返回 zotero://open-pdf 深链接 |
| `annotation` | string | 否 | mode=reveal：注释 key，会作为 &annotation= 追加到深链接 |
| `keys` | array | 否 | mode=recognize 必填：要识别的条目 key 列表 |
| `dryRun` | boolean | 否 | 默认 true：只返回计划与 diff；false 才经写安全管线提交（需要服务端 ZOTERO_MCP_WRITE=on） |
| `confirm` | string | 否 | 破坏性操作的确认关键字（永久删除 DELETE；覆盖已有值/标签重命名 OVERWRITE） |

## `zotero_merge_duplicates`

**合并重复条目**

把显式给出的 mergeKeys 合并到 primaryKey：先读全部参与条目的完整 JSON 产出影响面与写前快照，提交时要求 dryRun=false + confirm="MERGE" 且服务端 ZOTERO_MCP_WRITE=on，快照先落盘再调用插件端点（插件会调用 Zotero 自己的合并实现，并在合并前再弹一次 Zotero 确认框）；合并后被合并条目进垃圾箱（可恢复，也可用 Zotero 的撤销），合并完成后回读主记录并写审计 JSONL。插件不可用时只输出候选清单与人工合并指引，不执行合并。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `primaryKey` | string | 是 | 主记录条目 key（合并后保留的那条） |
| `mergeKeys` | array | 是 | 要合并进主记录的条目 key 列表（不得包含 primaryKey） |
| `dryRun` | boolean | 否 | 默认 true：只返回计划与 diff；false 才经写安全管线提交（需要服务端 ZOTERO_MCP_WRITE=on） |
| `confirm` | string | 否 | 破坏性操作的确认关键字（永久删除 DELETE；覆盖已有值/标签重命名 OVERWRITE） |

## `zotero_index`

**语义索引（本地向量库）**

构建 / 更新 / 查看本地语义索引：action=build 全量重建，action=update 按库级版本增量更新（内容指纹未变的条目跳过，连续两次 update 不重复嵌入），action=status 只回报现状（含页码来源分布 pageLabels.precise / pageLabels.estimated）。索引只读文库：正文来自 Zotero 的全文端点；精确页边界取自全文自带的分页符（U+000C，个数等于 indexedPages-1），PDF（unpdf，MIT）只用来取 /PageLabels 给这些边界命名，页标签与阅读器显示口径一致（空表项回退页序）。拿不到 PDF 只影响命名：标签按页序合成、页边界仍精确、pageLabelEstimated 保持 false；只有全文没有分页符、分页符个数与页数不符或存在没有任何可读文本的页时才如实退回线性估算并标 true——解析失败不会让建索引失败。向量与模型只落本地缓存（cache/index 与 cache/models），不写文库、不写审计、不需要 ZOTERO_MCP_WRITE。模型缺失时会按需下载（可用 downloadModel=false 禁止），拿不到时如实回报不可用原因。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `action` | string（build / update / status） | 是 | build 全量重建；update 增量；status 只读回报现状 |
| `model` | string | 否 | 嵌入模型（缺省 all-MiniLM-L6-v2-quantized，即英文基线；chinese / zh / bge-small-zh-v1.5-quantized 用中文模型；multilingual / multi / paraphrase-multilingual-MiniLM-L12-v2-quantized 用 XLM-R 系多语种模型（SentencePiece unigram 分词器，中英兼顾）；未知值会被拒绝且不回落缺省） |
| `since` | integer | 否 | update 时可显式指定增量水位（缺省用索引里记录的水位） |
| `downloadModel` | boolean | 否 | 缺省 true：模型缺失时按需下载；false 时只用本地已有模型 |

## `zotero_inject_citations`

**引用写作集成（Word 域代码注入）**

把 Zotero 引用以 Word 域代码写进 .docx：文档中的 {{zotero:名称}} / {{zotero:KEY1,KEY2}} 占位符会被替换成 ADDIN ZOTERO_ITEM CSL_CITATION 域，{{zotero:bibliography}} 处写入 ADDIN ZOTERO_BIBL 参考文献块（没有该占位符时落在文末）；文档在 Word 中执行 Zotero → Refresh 后成为受管引用。mapping 给出「占位符名 → 条目 key」，条目数据取自本地 API 的 format=csljson 与官方格式化输出，不会在客户端重实现 CSL 渲染。只重写 word/document.xml，其余 ZIP 条目逐字节保留；默认 dryRun=true 只返回计划，dryRun=false 且 outPath 缺省时原地写回并先把原文件备份为 <docxPath>.bak。docxPath 不存在时按 mapping 生成一份最小文档。占位符命中 0 次或多次、文件不是合法 .docx、取不到条目数据时一律如实拒绝并给出 CSL / BibTeX / RIS 文本作为替代产物，绝不假装注入成功。

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `docxPath` | string | 是 | 目标 .docx 路径；不存在时按 mapping 生成一份最小文档再注入 |
| `mapping` | object | 否 | 占位符名 → 引用条目；占位符里直接写 key（含逗号时按内联列表解析）时可以省略 |
| `style` | string | 否 | CSL 样式 id（缺省 chicago-shortened-notes-bibliography），透传给本地 API |
| `locale` | string | 否 | CSL 语言（缺省 en-US），透传给本地 API |
| `outPath` | string | 否 | 输出路径；缺省原地写回 docxPath 并先备份为 <docxPath>.bak |
| `overwrite` | boolean | 否 | 允许覆盖已存在的输出 / 备份文件，缺省 false |
| `dryRun` | boolean | 否 | 默认 true：只返回计划（目标文件、命中的占位符与位置、引用组、参考文献块位置、是否新建），不写任何文件；false 才写盘。本工具只写本地 .docx，不写文库，因此不受 ZOTERO_MCP_WRITE 约束。 |

