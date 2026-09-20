/**
 * MCP 服务器契约测试：工具清单、非法输入、懒执行与真实调用（经假服务器）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from '../../packages/mcp-server/src/server.ts';
import { TOOL_NAMES } from '../../packages/mcp-server/src/tools.ts';
import { startFakeZotero } from '../../scripts/fake-zotero.mjs';

async function connectPair() {
  const server = createServer();
  const client = new Client({ name: 'contract-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

async function closedPortUrl() {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const url = fake.url;
  await fake.close();
  return url;
}

test('工具清单：注册全部公开工具（数量以 write-tools 规格为准）并给出 JSON Schema', async () => {
  const { client, server } = await connectPair();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 24);
    assert.deepEqual(
      tools.map((tool) => tool.name).sort(),
      [...TOOL_NAMES].sort(),
    );
    const getItems = tools.find((tool) => tool.name === 'zotero_get_items');
    assert.ok(getItems, '缺少 zotero_get_items');
    assert.deepEqual(Object.keys(getItems.inputSchema.properties ?? {}).sort(), ['include', 'keys']);
    assert.deepEqual(getItems.inputSchema.required, ['keys']);
  } finally {
    await client.close();
    await server.close();
  }
});

test('启动与列出工具不触网（本地 API 不可用时依然成功）', async () => {
  const url = await closedPortUrl();
  const previous = process.env['ZOTERO_MCP_BASE_URL'];
  process.env['ZOTERO_MCP_BASE_URL'] = url;
  const { client, server } = await connectPair();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 24);
    // 调用才会失败：错误被包成 isError，而不是让进程崩溃
    const result = await client.callTool({ name: 'zotero_library_stats', arguments: {} });
    assert.equal(result.isError, true);
    // 服务器仍然可用
    const again = await client.listTools();
    assert.equal(again.tools.length, 24);
  } finally {
    await client.close();
    await server.close();
    if (previous === undefined) delete process.env['ZOTERO_MCP_BASE_URL'];
    else process.env['ZOTERO_MCP_BASE_URL'] = previous;
  }
});

test('非法输入被拒绝且服务器存活', async () => {
  const { client, server } = await connectPair();
  try {
    let rejected = false;
    try {
      const result = await client.callTool({ name: 'zotero_get_items', arguments: {} });
      rejected = result.isError === true;
    } catch {
      rejected = true;
    }
    assert.equal(rejected, true, '缺少 keys 的调用应被拒绝');
    const { tools } = await client.listTools();
    assert.equal(tools.length, 24, '被拒绝后服务器仍可用');
  } finally {
    await client.close();
    await server.close();
  }
});

test('工具调用经能力层读取假库（只读）', async () => {
  const fake = await startFakeZotero({ mode: 'ok', port: 0 });
  const previous = process.env['ZOTERO_MCP_BASE_URL'];
  process.env['ZOTERO_MCP_BASE_URL'] = fake.url;
  const { client, server } = await connectPair();
  try {
    const statsResult = await client.callTool({ name: 'zotero_library_stats', arguments: {} });
    const stats = JSON.parse(String(statsResult.content[0]?.text ?? '{}'));
    assert.equal(stats.totalItems, 3);

    const itemsResult = await client.callTool({
      name: 'zotero_get_items',
      arguments: { keys: ['ITEM0001'], include: ['annotations'] },
    });
    const items = JSON.parse(String(itemsResult.content[0]?.text ?? '[]'));
    assert.equal(items[0].annotations[0].pageLabel, '3');

    const searchResult = await client.callTool({
      name: 'zotero_search',
      arguments: { mode: 'saved', savedSearchKey: 'SEARCH01' },
    });
    const search = JSON.parse(String(searchResult.content[0]?.text ?? '{}'));
    assert.match(search.path, /\/searches\/SEARCH01\/items/u);
  } finally {
    await client.close();
    await server.close();
    await fake.close();
    if (previous === undefined) delete process.env['ZOTERO_MCP_BASE_URL'];
    else process.env['ZOTERO_MCP_BASE_URL'] = previous;
  }
});
