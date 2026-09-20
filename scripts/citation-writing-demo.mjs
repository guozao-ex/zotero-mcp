/**
 * 引用写作集成演示与取证（M6）。
 *
 * 默认走真机（只读）：取库里的条目 → 生成含引用与参考文献块域代码的样例 `.docx`
 * → 导出 `.bib` 与 CSL JSON → LibreOffice 无头往返 → MiKTeX `latexmk` 真编译。
 *
 * `--fake` 用内置假服务器离线复现同一套流程（不依赖 Zotero 是否在运行）。
 *
 * 证据口径：
 * - 全过程对本地 API 只发 GET：脚本记录调用前后 `Last-Modified-Version`，并比对
 *   `.audit` 目录清单，证明既没有写请求也没有审计 / 快照产生；
 * - 产物落在 `build/m6-sample/`（gitignore），不改动真实文库。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  compileBibSample,
  exportItems,
  injectCitations,
  readZip,
  resolveLatex,
  validateBib,
} from '../packages/core/src/index.ts';
import { startFakeZotero } from './fake-zotero.mjs';

const repoRoot = join(import.meta.dirname, '..');
const outDir = join(repoRoot, 'build', 'm6-sample');
const auditDir = join(repoRoot, '.audit');
const useFake = process.argv.includes('--fake');
// 取证用作者-年份样式：内文引用是 `(作者, 年份)`，在 Word 里一眼能看出域结果是否正确。
const style = process.env['ZOTERO_MCP_CITATION_STYLE'] ?? 'apa';
const baseUrl = process.env['ZOTERO_MCP_BASE_URL'] ?? 'http://127.0.0.1:23119';

function auditListing() {
  if (!existsSync(auditDir)) return [];
  return readdirSync(auditDir).sort();
}

/**
 * 只读 GET（带一次重试）。
 *
 * 本机事件循环被 `spawnSync`（LibreOffice / latexmk）长时间阻塞后，复用中的 keep-alive
 * 连接可能已被对端关闭，导致下一次请求报 `ECONNRESET`；这类失败与取证内容无关，重试一次
 * 即可拿到新连接。业务代码（core 能力层）不依赖这个重试，这里只服务于取证脚本本身。
 */
async function getWithRetry(url, attempt = 0) {
  try {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  } catch (error) {
    if (attempt >= 1) throw error;
    return await getWithRetry(url, attempt + 1);
  }
}

/** 读库级版本（只读）：写操作会让它递增，用来证明本次取证零写请求。 */
async function libraryVersion(url) {
  const response = await getWithRetry(`${url}/api/users/0/items/top?limit=1`);
  return Number(response.headers.get('last-modified-version') ?? '0');
}

async function topItems(url, limit) {
  const response = await getWithRetry(`${url}/api/users/0/items/top?limit=${limit}`);
  const body = await response.json();
  return body.map((entry) => ({ key: entry.key, title: entry.data?.title ?? '(无标题)' }));
}

function findSoffice() {
  const candidates = [
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'LibreOffice', 'program', 'soffice.exe'),
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

const evidence = { startedAt: new Date().toISOString(), mode: useFake ? 'fake' : 'live', steps: [] };
let fake = null;
const before = { audit: auditListing(), libraryVersion: null };

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

try {
  const url = useFake ? (fake = await startFakeZotero({ mode: 'ok', port: 0 })).url : baseUrl;
  before.libraryVersion = await libraryVersion(url);
  const items = await topItems(url, 3);
  if (items.length === 0) throw new Error('库里没有可用的顶层条目，无法生成样例');
  evidence.items = items;
  evidence.steps.push({ name: '读取条目（GET）', ok: true, detail: items.map((item) => item.key).join(', ') });

  const docxPath = join(outDir, 'sample.docx');
  const mapping = {
    ref1: [items[0].key],
    ref2: items.slice(1).map((item) => item.key),
    ...(items.length > 2 ? { ref3: { keys: [items[2].key], locator: '12', label: 'page' } } : {}),
  };
  const injected = await injectCitations({ baseUrl: url, docxPath, mapping, style, dryRun: false });
  if (!injected.injected) throw new Error(`注入失败：${injected.reason}`);
  evidence.injection = {
    style,
    created: injected.created,
    citations: injected.citations,
    bibliography: injected.bibliography,
    word: injected.word,
    requiresRefresh: injected.requiresRefresh,
  };
  evidence.steps.push({
    name: '注入域代码',
    ok: true,
    detail: `${injected.citations.length} 处引用 + 参考文献块（${injected.bibliography.mode}）→ ${docxPath}`,
  });

  // ZIP 结构：条目清单与域代码数量
  const archive = readZip(readFileSync(docxPath));
  const documentXml = archive.entries.find((entry) => entry.name === 'word/document.xml').data.toString('utf8');
  evidence.zip = {
    entries: archive.entries.map((entry) => entry.name),
    fieldBegins: (documentXml.match(/w:fldCharType="begin"/gu) ?? []).length,
    instrTexts: (documentXml.match(/<w:instrText/gu) ?? []).length,
  };
  evidence.steps.push({
    name: 'ZIP / 域代码结构',
    ok: evidence.zip.fieldBegins === evidence.zip.instrTexts && evidence.zip.fieldBegins >= 2,
    detail: `${evidence.zip.entries.length} 个条目；${evidence.zip.fieldBegins} 个域`,
  });

  // 导出 .bib 与 CSL JSON
  const keys = items.map((item) => item.key);
  const bibPath = join(outDir, 'refs.bib');
  const bib = await exportItems({ baseUrl: url, keys, format: 'bib', outPath: bibPath });
  const csl = await exportItems({ baseUrl: url, keys, format: 'csljson', outPath: join(outDir, 'refs.csl.json') });
  const validation = validateBib(bib.content, { requireYear: false });
  evidence.bib = {
    path: bibPath,
    entryCount: validation.entryCount,
    keys: validation.keys,
    structureOk: validation.ok,
    issues: validation.issues,
  };
  evidence.csl = { entryCount: csl.count };
  evidence.steps.push({
    name: '导出 .bib 与 CSL JSON',
    ok: validation.ok,
    detail: `${validation.entryCount} 条；引用键 ${validation.keys.join(', ')}`,
  });

  // LibreOffice 无头往返（无 Word 也能验证文档未损坏）
  const soffice = findSoffice();
  if (soffice === null) {
    evidence.steps.push({ name: 'LibreOffice 往返', ok: false, detail: '本机未找到 soffice.exe' });
  } else {
    const txtDir = join(outDir, 'txt');
    mkdirSync(txtDir, { recursive: true });
    const converted = spawnSync(soffice, ['--headless', '--convert-to', 'txt:Text', '--outdir', txtDir, docxPath], {
      encoding: 'utf8',
      timeout: 180000,
    });
    const textPath = join(txtDir, 'sample.txt');
    const ok = converted.status === 0 && existsSync(textPath);
    evidence.steps.push({
      name: 'LibreOffice 往返',
      ok,
      detail: ok ? readFileSync(textPath, 'utf8').split(/\r?\n/u).slice(0, 4).join(' | ') : `退出码 ${converted.status}`,
    });
    evidence.libreoffice = { exitCode: converted.status, textPath: ok ? textPath : null };
  }

  // .bib 真编译（MiKTeX）
  const latex = resolveLatex();
  if (!latex.available) {
    evidence.steps.push({ name: '.bib 真编译', ok: false, detail: latex.reason });
  } else {
    const compile = compileBibSample({ bibPath, keys: validation.keys, workDir: join(outDir, 'latex') });
    evidence.steps.push({
      name: '.bib 真编译',
      ok: compile.compiled,
      detail: compile.compiled
        ? `latexmk 退出码 0；PDF ${compile.pdfPath}；.bbl 含条目；未定义引用 ${compile.undefinedCitations.length}`
        : (compile.reason ?? '编译失败'),
    });
    evidence.latex = {
      latexmk: compile.latexmk,
      exitCode: compile.exitCode,
      pdfPath: compile.pdfPath,
      bblPath: compile.bblPath,
      undefinedCitations: compile.undefinedCitations.length,
    };
  }

  // 只读证明
  const afterVersion = await libraryVersion(url);
  const afterAudit = auditListing();
  const addedAudit = afterAudit.filter((name) => !before.audit.includes(name));
  evidence.readOnly = {
    libraryVersionBefore: before.libraryVersion,
    libraryVersionAfter: afterVersion,
    unchanged: before.libraryVersion === afterVersion,
    auditFilesAdded: addedAudit,
    nonGetRequests: fake === null ? null : fake.requests.filter((entry) => entry.method !== 'GET').length,
  };
  evidence.steps.push({
    name: '零写请求证明',
    ok: before.libraryVersion === afterVersion && addedAudit.length === 0,
    detail: `Last-Modified-Version ${before.libraryVersion} → ${afterVersion}；.audit 新增 ${addedAudit.length} 个文件`,
  });

  evidence.finishedAt = new Date().toISOString();
  evidence.ok = evidence.steps.every((step) => step.ok);
  writeFileSync(join(outDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  console.log(`引用写作取证（${evidence.mode}）：${evidence.ok ? '全部通过' : '存在未通过项'}`);
  for (const step of evidence.steps) console.log(`  ${step.ok ? '✔' : '✖'} ${step.name}：${step.detail}`);
  console.log(`\n产物目录：${outDir}`);
  console.log(`证据文件：${join(outDir, 'evidence.json')}`);
  if (!evidence.ok) process.exitCode = 1;
} catch (error) {
  evidence.finishedAt = new Date().toISOString();
  evidence.ok = false;
  evidence.error = error instanceof Error ? error.message : String(error);
  writeFileSync(join(outDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.error(`取证失败：${evidence.error}`);
  for (const step of evidence.steps) console.log(`  ${step.ok ? '✔' : '✖'} ${step.name}：${step.detail}`);
  process.exitCode = 1;
} finally {
  if (fake !== null) await fake.close();
}
