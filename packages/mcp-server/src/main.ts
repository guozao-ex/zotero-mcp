#!/usr/bin/env node
/**
 * MCP 服务器入口：`npm run mcp` 或 `node packages/mcp-server/src/main.ts`。
 */

import { startStdioServer } from './server.ts';

await startStdioServer();
