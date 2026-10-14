# 13-e · 后端代码 · MCP Server 端示例

> **本文件是 `13-后端代码示例.md` 的 §13.10 节**（原主文件已拆分为 13-a / 13-b / 13-c / 13-d / 13-e 五份）。本份负责**怎么写一个 MCP 服务 + 主项目怎么连**。
> 数据库与模型见 `13-a-后端代码-数据库与模型.md`；工具与注册见 `13-b-后端代码-工具与注册.md`；路由与流式聊天见 `13-c-后端代码-路由与流式.md`；业务功能见 `13-d-后端代码-业务功能.md`。

> **⚠ 重要警告**（沿用 13 原文件规则）：本文件代码是**模式示意**，不是可直接 ship 的代码。详见 `13-a-后端代码-数据库与模型.md` 顶部警告区。

## 13.10 MCP Server 端示例（怎么写一个 MCP 服务让 Agent 来连）

```typescript
// mcp-servers/order-system/src/server.ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'order-system', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

// 列出所有工具
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'order_query',
      description: '查询订单',
      inputSchema: {
        type: 'object',
        properties: {
          order_id: { type: 'string', description: '订单 ID' },
          user_id: { type: 'string', description: '用户 ID' },
        },
      },
    },
    {
      name: 'order_update_address',
      description: '修改收货地址（敏感操作）',
      inputSchema: {
        type: 'object',
        properties: {
          order_id: { type: 'string' },
          new_address: { type: 'string' },
        },
        required: ['order_id', 'new_address'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'order_query') {
    const result = await queryOrderDatabase(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  if (name === 'order_update_address') {
    const result = await markAddressChangeForReview(args);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

async function queryOrderDatabase(args: any) {
  return { order_id: args.order_id, status: 'shipped' };
}

async function markAddressChangeForReview(args: any) {
  return { status: 'pending_review', message: '请等待人工确认' };
}

// stdio 模式，主项目通过 child_process 启动这个进程
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('Order system MCP server started on stdio');
```

主项目连这个 server：

```typescript
// src/tools/mcp/connect-order-system.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'path';

const orderServerPath = path.resolve(__dirname, '../../../mcp-servers/order-system/dist/server.js');

export async function connectOrderSystem() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [orderServerPath],
  });

  const client = new Client({ name: 'agent-platform', version: '0.1.0' }, { capabilities: {} });

  await client.connect(transport);
  return client;
}
```
