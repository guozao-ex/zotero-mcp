#!/usr/bin/env node
/**
 * 从工具定义生成 docs/TOOLS.md，避免文档与实现漂移。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  ALL_TOOLS,
  INDEX_TOOLS,
  MERGE_TOOLS,
  READ_TOOLS,
  RESEARCH_TOOLS,
  WRITE_TOOLS,
  WRITING_TOOLS,
} from '../packages/mcp-server/src/tools.ts';

const lines = [];
lines.push('# MCP 工具参考');
lines.push('');
lines.push('> 本文件由 `npm run docs:tools` 从 `packages/mcp-server/src/tools.ts` 生成，请勿手工编辑。');
lines.push('');
lines.push(
  `当前公开工具：**${ALL_TOOLS.length}** 个（读工具 ${READ_TOOLS.length} 个 + 写 / 整理工具 ${WRITE_TOOLS.length} 个 + 研究工具 ${RESEARCH_TOOLS.length} 个 + 合并工具 ${MERGE_TOOLS.length} 个 + 索引工具 ${INDEX_TOOLS.length} 个 + 写作工具 ${WRITING_TOOLS.length} 个，路线图要求不超过 24 个）。`,
);
lines.push('');
lines.push('约定：读工具无副作用；会改动文库的工具（写 / 整理工具、`zotero_enrich`、`zotero_client(mode=recognize)`、`zotero_merge_duplicates`）默认 `dryRun=true` 只返回计划，提交需要 `dryRun=false` 且服务端 `ZOTERO_MCP_WRITE=on`（破坏性操作还要 `confirm`）；只写本地缓存 / 文件的 `zotero_index` 与 `zotero_inject_citations` 不受该总闸约束，但同样默认 `dryRun=true`。所有真实库访问都走回环地址的 Local API，缓存按 serverID 分区。');
lines.push('');

for (const tool of ALL_TOOLS) {
  lines.push(`## \`${tool.name}\``);
  lines.push('');
  lines.push(`**${tool.title}**`);
  lines.push('');
  lines.push(tool.description);
  lines.push('');
  const names = Object.keys(tool.inputSchema);
  if (names.length === 0) {
    lines.push('参数：无。');
  } else {
    const jsonSchema = z.toJSONSchema(z.object(tool.inputSchema), { target: 'draft-2020-12' });
    const required = new Set(Array.isArray(jsonSchema.required) ? jsonSchema.required : []);
    const properties = jsonSchema.properties ?? {};
    lines.push('| 参数 | 类型 | 必填 | 说明 |');
    lines.push('| --- | --- | --- | --- |');
    for (const name of names) {
      const property = properties[name] ?? {};
      const type = property.type ?? (Array.isArray(property.enum) ? 'enum' : 'unknown');
      const enumText = Array.isArray(property.enum) ? `（${property.enum.join(' / ')}）` : '';
      lines.push(
        `| \`${name}\` | ${type}${enumText} | ${required.has(name) ? '是' : '否'} | ${property.description ?? ''} |`,
      );
    }
  }
  lines.push('');
}

await mkdir('docs', { recursive: true });
await writeFile('docs/TOOLS.md', `${lines.join('\n')}\n`, 'utf8');
console.log(`已生成 docs/TOOLS.md（${ALL_TOOLS.length} 个工具）`);
