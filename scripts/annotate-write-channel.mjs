#!/usr/bin/env node
/**
 * 注释写入的四级回退通道 —— 只读探测 / 真机取证入口（change `web-api-write-fallback`）。
 *
 *   npm run annotate:write                                        # 只读：打印三级通道探测结论，零写请求
 *   npm run annotate:write -- --dry-run --attachment <附件KEY>     # 只读：额外打印将写入的注释计划
 *   ZOTERO_MCP_WRITE=on npm run annotate:write -- --apply \
 *       --attachment <附件KEY> --page 1 --text "高亮文字" --rects "x1,y1,x2,y2" [--color "#ffd400"]
 *   ZOTERO_MCP_WRITE=on npm run annotate:write -- --apply --dedicated \
 *       --pdf <本地 PDF 绝对路径> --page 1 --text "…" --rects "x1,y1,x2,y2"   # 自建一次性条目，跑完清理
 *
 * 真机注意：
 *   - `--apply` 走回退链（插件端点 → 本机 Local API 写 → 云端 Web API 写）。走 Local API 时
 *     **Zotero 会弹一次授权框**，需要人在场点「Allow」或「Always Allow」；
 *   - `--dedicated` 会把一次性条目（附件 + 注释）在跑完后**彻底删除**，让真实库回到运行前状态，
 *     适合做取证：不污染既有文献；
 *   - 云端一级需要先按 docs/WEB_API_FALLBACK.md 配置凭证（环境变量或本地文件），未配置时会如实报「未配置」
 *     并且**不发任何请求**；
 *   - 写入后请在 Zotero 阅读器里目视确认注释可见——脚本只证明「API 侧创建成功」。
 */

import { existsSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

import {
  ANNOTATION_WRITE_CONFIRM_KEYWORD,
  applyAnnotationWrite,
  applyPlan,
  makeChangePlan,
  planAnnotationWrite,
  probeChannels,
  resolveDataDir,
  revealDeepLink,
} from '../packages/core/src/index.ts';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const valueOf = (name) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? null : (argv[index + 1] ?? null);
};

const asJson = has('json');
const print = (label, payload) => {
  if (asJson) return;
  console.log(`${label}${typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)}`);
};

const probe = await probeChannels();

if (asJson) {
  console.log(JSON.stringify({ phase: 'probe', probe }, null, 2));
} else {
  console.log('注释写入通道探测（只读，未发出任何写请求）');
  console.log(`  Zotero 数据目录：${resolveDataDir()}`);
  console.log(`  ① 插件端点：${probe.plugin.available ? '可用' : '不可用'}`);
  if (!probe.plugin.available) console.log(`     ${probe.plugin.reason} — ${probe.plugin.hint ?? ''}`);
  console.log(`     共享 token：${probe.tokenConfigured ? '已配置' : '未配置'}；端点：${probe.endpoints.join(' ')}`);
  console.log(`  ② 本机 Local API 写：${probe.localApi.reachable ? `可达（Zotero-Server-ID ${probe.localApi.serverId}）` : '不可达'}`);
  if (!probe.localApi.reachable && probe.localApi.reason !== null) console.log(`     ${probe.localApi.reason}`);
  console.log(`  ③ 云端 Web API 写：${probe.webApi.configured ? `已配置（来源掩码 ${probe.webApi.maskedKey}，库 ${probe.webApi.library}）` : '未配置（零外呼）'}`);
  if (!probe.webApi.configured && probe.webApi.reason !== null) console.log(`     ${probe.webApi.reason}`);
  console.log('  ④ 提示等待自动同步：始终可用（不写库）');
  console.log('');
  console.log('说明：Local API 写入首次会触发 Zotero 授权弹窗（需人在场点一次）；');
  console.log('      云端一级必须在配置了凭证后才存在，未配置时本脚本不会向 api.zotero.org 发任何请求。');
}

const attachmentKeyArg = (valueOf('attachment') ?? '').trim();
const dedicated = has('dedicated');
/** --keep：直写不清理一次性条目（留给你在阅读器里目视确认）。 */
const keepArtifacts = has('keep');
const pdfPath = (valueOf('pdf') ?? '').trim();
const page = Number(valueOf('page') ?? '1');
const text = valueOf('text') ?? '';
const comment = valueOf('comment') ?? '';
const color = valueOf('color') ?? '#ffd400';
const rectsArg = valueOf('rects');

// ── 自建一次性条目模式（--dedicated）：跑完把附件与注释彻底删除 ──────────────
if (dedicated) {
  if (pdfPath.length === 0 || !isAbsolute(pdfPath) || !existsSync(pdfPath)) {
    console.error('--dedicated 需要 --pdf <本地 PDF 绝对路径>（作为一次性取证的附件）');
    process.exitCode = 2;
  } else if (!Number.isInteger(page) || page < 1 || rectsArg === null) {
    console.error('--dedicated 需要 --page <页码> 与 --rects "x1,y1,x2,y2[;…]"');
    process.exitCode = 2;
  } else if (!has('apply')) {
    console.log('--dedicated 是写路径：请加 --apply（并设置 ZOTERO_MCP_WRITE=on）。未执行任何写操作。');
    process.exitCode = 0;
  } else if ((process.env['ZOTERO_MCP_WRITE'] ?? '').trim().toLowerCase() !== 'on') {
    console.error('✖ --apply 需要服务端写开关：请设置 ZOTERO_MCP_WRITE=on（默认只读总闸）');
    process.exitCode = 3;
  } else {
    const rects = rectsArg
      .split(';')
      .map((pair) => pair.split(',').map((value) => Number(value.trim())))
      .filter((rect) => rect.length === 4 && rect.every((value) => Number.isFinite(value)));
    const title = `[zotero-mcp 一次性取证] ${basename(pdfPath)}`;
    let attachmentKey = null;
    let createdKeys = [];
    try {
      // 1. 建一条一次性 linked 附件（走既有写管线：快照 + 审计 + 授权）
      const attachPlan = makeChangePlan({
        targetKeys: [],
        changes: [],
        operations: [
          {
            kind: 'create',
            itemType: 'attachment',
            fields: { linkMode: 'linked_file', path: pdfPath.replace(/\\/gu, '/'), title, contentType: 'application/pdf' },
            source: 'annotate-write-dedicated',
          },
        ],
        summary: `一次性取证附件：${basename(pdfPath)}`,
      });
      const attachResult = await applyPlan(attachPlan, { write: true });
      attachmentKey = attachResult.createdKeys[0] ?? null;
      if (attachmentKey === null) throw new Error('一次性附件创建成功但未回报 key');
      if (!asJson) console.log(`\n① 已建一次性附件 ${attachmentKey}（${title}）`);

      // 2. 经四级回退链给这条附件写注释
      const plan = await planAnnotationWrite({
        attachmentKey,
        annotations: [{ type: 'highlight', pageIndex: page - 1, rects, text, comment, color, pageLabel: String(page) }],
      });
      const result = await applyAnnotationWrite(plan, { write: true, confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD });
      createdKeys = result.created.map((entry) => entry.key);
      if (asJson) console.log(JSON.stringify({ phase: 'dedicated', attachmentKey, planId: plan.planId, selectedChannel: plan.selectedChannel, result }, null, 2));
      else {
        console.log(`② 注释写入通道：${result.channel}`);
        for (const attempt of result.attempts) {
          console.log(`   ${attempt.channel}: ${attempt.outcome}${attempt.reason === null ? '' : ` — ${attempt.reason}`}`);
        }
        for (const created of result.created) {
          console.log(`   ✔ 注释 ${created.key}（${created.type}，页标签 ${created.pageLabel ?? '无'}）`);
        }
        if (result.note !== null) console.log(`   提示：${result.note}`);
        if (createdKeys.length > 0) {
          console.log(`③ 深链接：${revealDeepLink({ key: attachmentKey, page, annotation: createdKeys[0] })}`);
          console.log('   请现在到 Zotero 阅读器里目视确认该高亮可见（脚本只证明 API 侧创建成功）。');
        }
      }
    } finally {
      // 3. 清理：先删注释，再删一次性附件（永久删除需要 confirm="DELETE"）。
      //    --keep 时**不清理**，把条目留给你在阅读器里目视确认。
      try {
        if (keepArtifacts && attachmentKey !== null) {
          if (!asJson) {
            console.log('④ 已保留一次性条目（--keep）：请在 Zotero 阅读器里目视确认该高亮可见，再确认重启后仍在。');
            console.log(`   确认完后清理下面这些 key：${[...createdKeys, attachmentKey].join(' ')}`);
          }
        } else if (attachmentKey !== null) {
          const cleanupPlan = makeChangePlan({
            targetKeys: [...createdKeys, attachmentKey],
            changes: [],
            operations: [
              ...createdKeys.map((key) => ({ kind: 'delete', key })),
              { kind: 'delete', key: attachmentKey },
            ],
            summary: `清理一次性取证对象（注释 ${createdKeys.length} + 附件 1）`,
            destructive: true,
            confirmKeyword: 'DELETE',
          });
          const deleted = await applyPlan(cleanupPlan, { write: true, confirm: 'DELETE' });
          if (!asJson) {
            console.log(
              `④ 清理：已永久删除 ${deleted.operations.filter((entry) => entry.status === 'applied').length} 个一次性对象（注释 ${createdKeys.length} + 附件 1）`,
            );
          }
        }
      } catch (error) {
        console.error(`⚠️ 清理失败（请手动删除一次性条目 ${attachmentKey}）：${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
      }
    }
  }
} else if (attachmentKeyArg.length === 0) {
  if (asJson) console.log(JSON.stringify({ phase: 'plan', skipped: '未提供 --attachment，只做通道探测' }));
  else console.log('\n未提供 --attachment：只做通道探测（若要真写，请加 --attachment <附件KEY> --rects …）。');
  process.exitCode = 0;
} else {
  const attachmentKey = attachmentKeyArg;
  if (!Number.isInteger(page) || page < 1 || rectsArg === null) {
    console.error('用法：npm run annotate:write -- --attachment <附件 KEY> --page <页码> --rects "x1,y1,x2,y2[;…]" [--text ""] [--comment ""] [--color "#ffd400"] [--apply] [--json]');
    console.error('⚠️ --rects 必填：Zotero 的注释按 position 落位（text 只是元数据），坐标要来自真实文字区域。');
    process.exitCode = 2;
  } else {
    const rects = rectsArg
      .split(';')
      .map((pair) => pair.split(',').map((value) => Number(value.trim())))
      .filter((rect) => rect.length === 4 && rect.every((value) => Number.isFinite(value)));
    if (rects.length === 0) {
      console.error('--rects 必须是 `x1,y1,x2,y2[;x1,y1,x2,y2…]`');
      process.exitCode = 2;
    } else {
      const plan = await planAnnotationWrite({
        attachmentKey,
        annotations: [{ type: 'highlight', pageIndex: page - 1, rects, text, comment, color, pageLabel: String(page) }],
      });
      const preview = {
        planId: plan.planId,
        attachmentKey: plan.attachmentKey,
        parentItem: plan.parentItem,
        attachmentTitle: plan.attachmentTitle,
        selectedChannel: plan.selectedChannel,
        channels: plan.channels,
        duplicates: plan.duplicates,
        notes: plan.notes,
      };
      if (asJson) console.log(JSON.stringify({ phase: 'plan', plan: preview }, null, 2));
      else {
        console.log('\n写入计划（只读）');
        console.log(`  目标附件：${plan.attachmentKey}${plan.parentItem === null ? '' : `（父条目 ${plan.parentItem}）`}`);
        console.log(`  将使用通道：${plan.selectedChannel}`);
        for (const entry of plan.channels) {
          console.log(`    ${entry.channel}: ${entry.available ? '可用' : '不可用'}${entry.reason === null ? '' : ` — ${entry.reason}`}`);
        }
        if (plan.duplicates.length > 0) console.log(`  幂等跳过：${JSON.stringify(plan.duplicates)}`);
      }

      if (!has('apply')) {
        if (!asJson) {
          console.log('\n（只读模式：未写入任何注释。加 --apply 且 ZOTERO_MCP_WRITE=on 才真写。）');
        }
        process.exitCode = 0;
      } else if ((process.env['ZOTERO_MCP_WRITE'] ?? '').trim().toLowerCase() !== 'on') {
        console.error('\n✖ --apply 需要服务端写开关：请设置 ZOTERO_MCP_WRITE=on（默认只读总闸）');
        process.exitCode = 3;
      } else {
        const result = await applyAnnotationWrite(plan, {
          write: true,
          confirm: ANNOTATION_WRITE_CONFIRM_KEYWORD,
        });
        if (asJson) console.log(JSON.stringify({ phase: 'apply', result }, null, 2));
        else {
          console.log(`\n写入结果：通道 ${result.channel}`);
          for (const attempt of result.attempts) {
            console.log(`  ${attempt.channel}: ${attempt.outcome}${attempt.reason === null ? '' : ` — ${attempt.reason}`}`);
          }
          for (const created of result.created) {
            console.log(`  ✔ 已创建注释 ${created.key}（${created.type}，页标签 ${created.pageLabel ?? '无'}）`);
          }
          for (const skipped of result.skipped) {
            console.log(`  ⏭ 跳过重复注释 ${skipped.key}（${skipped.reason}）`);
          }
          for (const failed of result.failed) {
            console.log(`  ✖ 失败：${failed.reason}`);
          }
          if (result.note !== null) console.log(`  提示：${result.note}`);
          console.log(`  审计：${result.auditPath}`);
          console.log(`  快照：${result.snapshotPath}`);
          if (result.created.length > 0) {
            console.log('\n请人工确认两步：① 在 Zotero 阅读器里目视确认该注释可见；② 重启 Zotero 后仍在。');
            console.log('（脚本只能证明 API 侧创建成功与只读回读，不能证明阅读器可见。）');
          }
        }
        process.exitCode = result.created.length > 0 ? 0 : 1;
      }
    }
  }
}
