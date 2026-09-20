# Zotero MCP

**English** | **[中文](README.zh-CN.md)**

> **Status**: `npm test` **287/287** · `npm run plugin:verify` → **up-to-date** · `npm run verify:offline` → **0** non-loopback requests.

`zotero-mcp` is a **local-first, approval-gated** Model Context Protocol server for [Zotero](https://www.zotero.org/).
It lets an AI agent search, read and — with explicit approval — **write** to your Zotero library: items, collections,
tags, notes, annotations, attachments, plus local semantic search, dedup, metadata enrichment and citation export.

---

## 30-second tour

- **Reads *and* writes** — but nothing lands until you preview a diff and confirm (`zotero_plan_changes` → `zotero_apply_changes`).
- **Four write channels with honest degradation**: local API → thin plug-in → cloud Web API → a clear failure with the reason.
- **Everything runs locally**: semantic search is on-device (ONNX + sqlite-vec, three models), page labels are exact per page, and estimates are flagged.
- **Auditable and reversible**: JSONL journal + snapshot + one-command rollback; an offline invariant asserts zero non-loopback requests.

---

## 1. What it is

```
┌────────────┐   MCP (stdio)   ┌──────────────┐  ① Local API  ┌──────────────┐
│ AI agent   │ ───────────────▶│ zotero-mcp   │ ────────────▶ │ Zotero 10+   │
│ (any MCP   │                 │ MCP server   │  ② thin plug-in (privileged JS)
│  client)   │ ◀───────────────│ (Node ≥22.16)│  ③ cloud Web API (fallback)
└────────────┘                 └──────────────┘  ④ honest degradation
```

Zotero 10 exposes a **local API** on `localhost:23119` (reads need no auth; writes need a local API key granted by a
dialog). Some operations can only be done from inside Zotero’s privileged scope — those go through a **thin plug-in**
that adds six endpoints under `/zoteromcp/*`. If the local machine is unreachable, writes can fall back to the
**cloud Web API** with your own zotero.org key — or the operation fails honestly, telling you why.

---

## 2. How this differs from other Zotero MCP servers

| Dimension | Typical community Zotero MCP | **This project** |
| --- | --- | --- |
| Read / write | **Read-only** by design — e.g. [kujenga/zotero-mcp](https://playbooks.com/mcp/kujenga/zotero-mcp), [atakaragoz/zotero-mcp](https://lobehub.com/mcp/atakaragoz-zotero-mcp), [sebastianv89/zotero-mcp](https://github.com/sebastianv89/zotero-mcp) state they never request a write key, so “the write path stays unreachable” | **Read *and* write**, and **off by default**: `ZOTERO_MCP_WRITE=on` + `dry-run` preview + a `confirm` keyword before anything lands |
| Write channels | Usually one | **Four-tier**: local API → thin plug-in → cloud Web API → honest degradation. The chosen channel and the reason for any skip are reported per run |
| Audit & rollback | Rare | **Replayable JSONL audit** + snapshot + **one-command rollback** (each failure line carries an error `code`) |
| Semantic search | A few projects | Fully local ONNX + sqlite-vec, **three models**, cross-lingual and `[UNK]` behaviour measured, negative-query violations reported |
| Page accuracy | Usually not addressed | Per-page `pageLabel` **12/12 exact** on a real library; estimated pages are flagged (`pageLabelEstimated`); pathological PDFs have a dedicated sample matrix |

---

## 3. Requirements

| | |
| --- | --- |
| Zotero | **10+** (authoring/verification done on **10.0.3**, Windows) |
| Node.js | **≥ 22.16** (runs the TypeScript entry directly) |
| OS | Windows verified end-to-end; macOS/Linux **not yet verified** |
| Optional | MiKTeX (only for LaTeX `.bib` export/compile workflows) |
| Optional | Docker/WSL2 **or** a small server, only if you want to self-host Zotero’s `translation-server` as an extra identifier-resolution channel — everything works without it |
| Disk | Models ~23 MB (English) / ~24 MB (Chinese) / ~118 MB + 17 MB tokenizer (multilingual) |

---

## 4. Install

### Option A — one prompt: let your agent configure it

Paste the block below to your AI agent (replace `<REPO_PATH_OR_URL>`), and answer the questions it asks you.
The MCP server, plug-in build, index and client config are all agent-doable; the steps marked **you** below
cannot be automated, and the agent is told to stop and wait for you there.

```text
Set up the zotero-mcp MCP server from <REPO_PATH_OR_URL> on this machine.

Work in this order. **Stop and ask me** whenever a step needs a GUI or my approval, and never claim a step
succeeded unless you ran a command that proves it. Do not print my tokens or API keys — use masked values.

1. Clone/pull the repo and run `npm ci`.
2. Run `npm run plugin:build`, then tell me the exact `.xpi` path and wait while I install it in
   Zotero → Tools → Add-ons → gear → "Install Add-on From File…", and restart Zotero.
3. Ask me to enable Zotero → Settings → Advanced → "Allow other applications on this computer to communicate with Zotero".
4. Run `npm run plugin:verify` and show me the verdict (expect `up-to-date`). If it reports `stale-install`, rebuild and ask me to reinstall.
5. Ask me where my MCP client config file lives; write the server entry (`node packages/mcp-server/src/main.ts`,
   cwd = the repo, `ZOTERO_MCP_WRITE=on`) and show me the diff before saving.
6. Run `npm run report:index` to build the semantic index (it downloads a model on first run).
7. Smoke-test **read-only** first: `zotero_search` for a topic I name, then `zotero_read_content` on the resulting attachment.
8. Before my first *write*: warn me that Zotero will pop an authorization dialog and that I must click
   **"Always Allow"** (the second button) — "Allow" is single-use and will ask again next time.
9. Finish by running `npm test` and `npm run verify:offline` and report the numbers.
```

| Step | Who |
| --- | --- |
| Clone/pull, `npm ci`, `plugin:build`, `report:index`, client config, smoke tests | agent |
| Install the `.xpi` in Zotero (Tools → Add-ons → gear → Install Add-on From File) + restart Zotero | **you** |
| Tick “Allow other applications on this computer to communicate with Zotero” | **you** |
| Click **“Always Allow”** on the first write (optional: `extensions.zoteromcp.enableAnnotations` + restart, for annotation writes) | **you** |

If your agent supports skills, also point it at [`skills/zotero-mcp/SKILL.md`](skills/zotero-mcp/SKILL.md) —
that file carries the tool-routing and approval rules.

### Option B — manual: five steps



```bash
# 1) dependencies
npm ci

# 2) build the plug-in, then install it in Zotero
npm run plugin:build
#    Zotero → Tools → Add-ons → gear → Install Add-on From File → build/zotero-mcp-plugin-1.0.0.xpi
#    → restart Zotero

# 3) enable the local API
#    Zotero → Settings → Advanced → “Allow other applications on this computer to communicate with Zotero”

# 4) verify the plug-in really is the current build (read-only)
npm run plugin:verify        # expect: verdict up-to-date

# 5) (optional) build the semantic index — downloads a model on first run
npm run report:index
```

MCP client configuration (example):

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

## 5. Quick start

> **★ The one thing to know**: the **first write** pops a Zotero dialog. Click
> **“Always Allow”** (the *second* button) — **not** “Allow”. “Allow” is single-use: Zotero deletes that key
> after one successful write, so you will be asked again next time. With “Always Allow”, the key is remembered per
> `Zotero-Server-ID` and reused across processes and Zotero restarts. `zotero-mcp` persists it at
> `<Zotero data dir>/zoteromcp-local-api-key.json` (0600, atomic write) and only ever stores remembered keys.

```
1) Find:        zotero_search  { "query": "ice core bubbles", "mode": "keyword" }
2) Read:        zotero_read_content { "key": "<attachmentKey>", "mode": "fulltext" }
3) Write:       zotero_plan_changes  →  review the diff  →  zotero_apply_changes { "confirm": "OVERWRITE" }
```

Typical daily loop: `zotero_search` → `zotero_read_content` → `zotero_index` (semantic) →
`zotero_plan_changes` / `zotero_apply_changes` → `zotero_export`.

---

## 6. Tool reference (all 24)

Legend: **★ commonly used** · **◆ distinctive here** · **✎ requires write access (`ZOTERO_MCP_WRITE=on`)**

| Group | Sub-group | Tool | What it does | |
| --- | --- | --- | --- | --- |
| **A. Read & search** | Search | `zotero_search` | Keyword / full-text / **semantic** / saved-search queries | ★◆ |
| | Items | `zotero_get_items` | Item details incl. children, tags, collections | ★ |
| | Items | `zotero_read_content` | Full text or **per-page PDF text** (`charRange`, `pageLabel`, `pageLabelEstimated`) | ★◆ |
| | Organization | `zotero_list_collections` | List collections | |
| | Organization | `zotero_list_tags` | List tags | |
| | Overview | `zotero_library_stats` | Library health: counts, metadata gaps, duplicate candidates | |
| **B. Write ✎** | Plan & commit | `zotero_plan_changes` | **dry-run**: build a plan and preview the diff | ★◆ |
| | Plan & commit | `zotero_apply_changes` | Commit the plan (requires `confirm` keyword for destructive edits) | ★◆ |
| | Items | `zotero_create_item` | Create an item | ★ |
| | Items | `zotero_update_item` | Update fields | ★ |
| | Items | `zotero_delete_items` | Delete items (trash by default) | |
| | Items | `zotero_add_items` | Bulk import by identifier (DOI/arXiv) or PDF | |
| | Notes | `zotero_add_note` | Add a child note (or append) | |
| | Collections | `zotero_manage_collections` | Create / rename / move / delete collections | |
| | Tags | `zotero_manage_tags` | Add / remove / rename tags | |
| | Attachments | `zotero_attach_file` | Attach a **linked-file** attachment (no cloud quota; local path) | ◆ |
| | Annotations | `zotero_attach_annotations` | Write highlights / underlines / notes through the four-tier channel | ◆ |
| **C. Index** | Semantic index | `zotero_index` | Build / incrementally update / inspect the semantic index (`page_alignment` diagnostics) | ★◆ |
| **D. Curation** | Dedup | `zotero_find_duplicates` | Find duplicate candidates (strong/weak keys) | |
| | Dedup | `zotero_merge_duplicates` | Merge duplicates | |
| | Citations | `zotero_export` | Export `.bib` / CSL citations (LaTeX-friendly) | ★ |
| **E. Scholarly** | Enrichment | `zotero_enrich` | Enrich metadata via OpenAlex / Semantic Scholar / Crossref / Unpaywall / PubMed | ◆ |
| **F. Plug-in & integration** | Plug-in channel | `zotero_client` | Trigger sync / read selection / reveal deep link | ◆ |
| | Writing | `zotero_inject_citations` | Inject / refresh Word field codes | ◆ |

Full parameter-level reference is generated: **[`docs/TOOLS.md`](docs/TOOLS.md)** (`npm run docs:tools`).

---

## 7. Configuration

| Variable | Meaning |
| --- | --- |
| `ZOTERO_MCP_WRITE` | `on` enables writes (default: read-only) |
| `ZOTERO_MCP_BASE_URL` | Local API base (default `http://127.0.0.1:23119`) |
| `ZOTERO_MCP_DATA_DIR` | Zotero data dir (default `~/Zotero`) — shared token, persisted write key |
| `ZOTERO_MCP_AUDIT_DIR` / `ZOTERO_MCP_CACHE_DIR` | Audit journal / cache location |
| `ZOTERO_MCP_INDEX_DIR` / `ZOTERO_MCP_INDEX_MODEL` | Semantic index dir / model (`default`, `chinese`\|`zh`, `multilingual`\|`multi`) |
| `ZOTERO_MCP_PLUGIN_TOKEN` | Override the plug-in shared token (otherwise `<data dir>/zoteromcp-token.txt`) |
| `ZOTERO_MCP_WEB_API_KEY` / `ZOTERO_MCP_WEB_API_LIBRARY` | Cloud fallback credentials (or `<data dir>/zoteromcp-web-api.json`) |
| `ZOTERO_MCP_CROSSREF_MAILTO`, `ZOTERO_MCP_TRANSLATION_*` | Politeness/translation endpoints for enrichment |

Plug-in preference: `extensions.zoteromcp.enableAnnotations` (boolean, default **false**) gates the annotation endpoint.
⚠️ Re-installing the plug-in resets it to `false`, and the pref is read **at startup** — set it in
Settings → Advanced → Config Editor, then restart Zotero.

---

## 8. Write safety model

1. **Nothing is written unless the write path is explicitly enabled** (`ZOTERO_MCP_WRITE=on`).
2. `zotero_plan_changes` produces a plan; `zotero_apply_changes` needs a `confirm` keyword for destructive changes
   (`OVERWRITE`, `DELETE`).
3. Every operation is journaled to an **audit JSONL** (including an error `code`), with a pre-write **snapshot**.
4. Rollback is one command against the snapshot.
5. Channel selection is explicit and reported: local API → plug-in → cloud Web API → honest failure.
6. **Authorization is persisted**: one “Always Allow” click, then no further dialogs — the key is stored per
   `Zotero-Server-ID` under `<Zotero data dir>/zoteromcp-local-api-key.json` and reused until you revoke it.

---

## 9. Semantic search & indexing

| Model alias | Model | Dim | Notes |
| --- | --- | --- | --- |
| `default` | `all-MiniLM-L6-v2-quantized` | 384 | English; best default overall; Chinese `[UNK]` rate is high (≈73–77 %) |
| `chinese` / `zh` | `bge-small-zh-v1.5-quantized` | 512 | Chinese queries; weaker on English |
| `multilingual` / `multi` | `paraphrase-multilingual-MiniLM-L12-v2-quantized` | 384 | **Best for mixed ZH/EN**: cross-lingual top-1 18/20 vs 0/20 (EN default) and 0/20 (ZH model) on a controlled corpus |

```bash
npm run report:index                          # build / update the index (+ timings, chunk counts)
npm run report:index -- --synthetic 1000      # scale check: 1000 items / 32 000 chunks ≈ 26.8 min full build,
                                              # unchanged-library update 0.6 s with 0 embeddings
npm run eval:semantic -- --json               # three-column evaluation
npm run report:page-align                     # per-item page-boundary precision (real library: 12/12 exact)
npm run report:page-labels -- <itemKey>       # per-page labels, for eyeballing against the reader
```

**Switching models requires a rebuild** (the index records `model_id`; mixing is refused rather than silently reused).
The index **schema is versioned (1 → 2)**; an older schema is rebuilt.

---

## 10. Verification & confidence (full)

**Four checks before every commit** (all green at the time of writing):

| Check | Command | Result |
| --- | --- | --- |
| Unit + contract tests | `npm test` | **287 / 287**, 0 fail, 0 skip |
| Types | `npm run typecheck` | clean |
| Generated docs are current | `npm run docs:tools` | no diff (24 tools) |
| Offline invariant | `npm run verify:offline` | **0** non-loopback requests intercepted |

Plus: `npm run plugin:verify` (installed `.xpi` hash **==** freshly built artefact; currently
`a93749277c742bd1…`, 33 477 B → **up-to-date**), and, for a clean clone without the model cache, the
model-dependent tests **skip** rather than fail (by design).

**Real-machine evidence** (dated, reproducible records) is kept **outside this repository** together with the
per-change verification reports; the test suite, `plugin:verify` and `verify:offline` above are the in-repo checks.

---

## 11. Known limits

- **Platform coverage**: end-to-end evidence exists for **Windows + Zotero 10.0.3** only. macOS/Linux, group libraries,
  Zotero 10.0.2 and a second cloud account are **not yet verified**.
- **Linked attachments on Windows must use native backslashes** (`D:\…`); a forward-slash path is accepted by the API
  but Zotero then reports “file not found”.
- **Scanned PDFs (no text layer) never enter the semantic index** — Zotero itself has no full text for them.
- **Zotero does not emit `\f` for blank pages**, so a PDF with blank pages falls back to estimated page boundaries
  (`no-separators`) instead of partial precision.
- **`count-mismatch`** (separator count ≠ page count) is covered by contract tests only; it is hard to produce naturally.
- **Scale**: 1 000 items = 32 000 chunks ≈ **26.8 min** full build (≈90 % in embedding); a no-change update is **0.6 s**
  with zero embeddings. Incremental updates for a *changed* library re-embed only changed items.
- **Real-library scale is not verified**: the 252-item evaluation used a *synthetic, controlled* corpus (deliberately
  full of near-duplicates), so its absolute numbers do not transfer to a real 200+ item library.
- **`translation-server` (optional L3 channel) is verified at the *channel* level only**: ten contract tests cover
  endpoint/token/timeout/redaction and graceful degradation, and an independent verification round passed — but the
  **deployment itself was never exercised** (no container or cloud run; the authoring machine has neither Docker nor
  WSL2). In every real-machine run so far the endpoint was absent and identifier resolution fell back to

  Crossref / OpenLibrary / PubMed: *“works without it”* is proven, *“works with it”* is not.
- **Attachment byte-upload is not implemented**: `zotero_attach_file` supports `linked_file` only (no cloud quota);
  stored-file uploads are a future change.
- **Model cache is not committed**, so semantic tests skip on a clean clone until `npm run report:index` downloads a model.
- **Multi-process key writes are not locked** (rare, worst case one extra authorization dialog).
- Two audit observations remain by design: create failures record `failed: [null]` in the plan-summary line, and
  `plan-summary` does not carry a per-operation error `code`.

---

## 12. Troubleshooting / FAQ

| Symptom | Cause & fix |
| --- | --- |
| A Zotero authorization dialog appears **every time** I write | You clicked **“Allow”** (single-use). Zotero deletes that key after one successful write. Remove stored authorizations (Settings → Advanced → **Clear Write Authorizations**), then click **“Always Allow”** once. This project also persists remembered keys, so afterwards it will not ask again |
| `enableAnnotations` seems off after re-installing the plug-in | Re-installation resets the pref to `false`; set it again and **restart Zotero** (the pref is read at startup) |
| `429 Too Many Requests` from `/api/local/authorize` | Zotero rate-limits the authorization endpoint to 5 requests/minute; batch writes instead of authorizing per operation |
| `需要重建索引` / “rebuild required” on search | The index was built with another `model_id` (or an older schema). Rebuild with `npm run report:index` |
| Search returns nothing after moving the index | Index dir is machine-local and gitignored; copy `cache/` or rebuild |
| `plugin:verify` says `stale-install` | The installed `.xpi` differs from the build. Run `npm run plugin:build`, reinstall in Zotero, restart |
| Semantic tests skip on a fresh clone | Model cache is gitignored; run `npm run report:index` once to download it |

---

## 13. Development

```
packages/core/         capabilities: read/write pipeline, channels, audit, citations, enrichment …
packages/indexer/      chunking, tokenizers (WordPiece + SentencePiece unigram), ONNX embedder, sqlite-vec store
packages/mcp-server/   MCP tool surface (24 tools) + server entry
packages/zotero-plugin/ thin plug-in (bootstrap.js, manifest.json, src/plugin.js → content/channel.js)
scripts/               build, reports, evaluations, offline verification, doc generation
tests/contract/        contract tests (fake Zotero server + injected fetch)
docs/                  design, delivery notes, evidence, roadmap, per-change archive
```

Workflow for any change: **Shape → Build → independent read-only verification → archive** (Comet Native).
The per-change briefs, verification reports and workflow state are kept locally (not published in this repository).
Commits must keep the four checks green.

---

## 14. Documentation map

| Topic | Document |
| --- | --- |
| **Agent skill (for AI agents)** | [`skills/zotero-mcp/SKILL.md`](skills/zotero-mcp/SKILL.md) |
| Tool reference (generated) | [`docs/TOOLS.md`](docs/TOOLS.md) |

Design notes, delivery reports and real-machine evidence live outside this repository — ask the maintainer if you
need them.

---

## 15. License & credits

MIT — see [LICENSE](LICENSE). Built on the shoulders of `onnxruntime-node`, `sqlite-vec`, `unpdf`/`pdf.js`, `esbuild`, `zod`, and the
Zotero local API. Zotero is a trademark of the Corporation for Digital Scholarship; this project is unaffiliated.
