/**
 * MCP stdio 服务器：把公开工具（读 10 + 写 / 整理 8 + 研究 2 + 合并 1）注册到 MCP 协议上。
 *
 * 启动与列出工具都不访问网络或文库；只有工具被调用时才经过能力层访问本地 API。
 * 写工具默认只读：服务端 ZOTERO_MCP_WRITE 未开启时，提交一律被拒绝。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { assertWriteEnabled } from '@zotero-mcp/core';
import { ALL_TOOLS, GATED_TOOL_NAME_SET } from './tools.ts';

export const SERVER_NAME = 'zotero-mcp';
export const SERVER_VERSION = '0.1.0';

/** 构造 MCP 服务器并注册全部公开工具（不建立传输，便于测试用内存传输连接）。 */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: Record<string, unknown>) => {
        try {
          // 默认只读总闸：写 / 整理与补全工具在 dryRun=false 时先过 ZOTERO_MCP_WRITE，未开启则连计划都不生成
          if (GATED_TOOL_NAME_SET.has(tool.name) && args['dryRun'] === false) assertWriteEnabled();
          const result = await tool.handler(args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const code =
            typeof error === 'object' && error !== null && 'code' in error
              ? ` [${String((error as { code?: unknown }).code)}]`
              : '';
          return { content: [{ type: 'text' as const, text: `错误${code}：${message}` }], isError: true };
        }
      },
    );
  }
  return server;
}

/** 通过 stdio 启动服务器（长时间运行，直到客户端断开）。 */
export async function startStdioServer(): Promise<McpServer> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
