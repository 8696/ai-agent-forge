import { z } from 'zod';
import { Op } from 'sequelize';
import { Document } from '../../models';
import type { BuiltinTool } from './types';

/**
 * 查知识库文档清单 —— 内置工具（**查真实数据**，不是 mock）
 *
 * 前五个工具里只有这个不是假数据：它真的查本租户的 `documents` 表。
 * 目的是让「工具能触到真实库」这件事有个直观的证据，
 * 同时给 docs/12-b §B7 记的那条已知边界（前台用户能看见本租户全部文档标题）
 * 留一个受控的出口 —— 租户不注册这个工具，前台就查不到。
 *
 * ⚠️ **必须带 tenant_id 过滤** —— 这里查的是「本租户」的文档，
 * 漏了就是跨租户泄露（A1 的隔离红线）。
 * 另外 `tests/unit/tenant-isolation-guard.test.ts` 会扫这段代码，
 * 过滤条件必须**字面出现在 findAll 的括号里**。
 */
const schema = z.object({
  keyword: z.string().trim().max(100).optional(),
});

const MAX_ROWS = 20;

export const listKnowledgeDocuments: BuiltinTool = {
  key: 'list_knowledge_documents',
  name: '查知识库文档清单',
  description:
    '列出本租户知识库里有哪些资料（售后政策 / 商品说明 / 活动规则等），可按关键词过滤。' +
    '当用户问「你们有哪些资料 / 知识库里有什么文档」时使用。' +
    '用户问资料清单一定要调用本工具查真实的文档列表，不要凭印象编。',
  inputSchema: schema,
  sampleArgs: { keyword: '' },
  sensitive: false,
  async execute(ctx, args) {
    const { keyword } = schema.parse(args);
    const trimmed = keyword ?? '';

    const rows = await Document.findAll({
      where: {
        tenant_id: ctx.tenantId,
        ...(trimmed !== '' ? { title: { [Op.like]: `%${trimmed}%` } } : {}),
      },
      attributes: ['id', 'title', 'file_type', 'status', 'chunk_count', 'updated_at'],
      order: [['updated_at', 'DESC']],
      limit: MAX_ROWS,
    });

    return {
      total: rows.length,
      truncated: rows.length >= MAX_ROWS,
      documents: rows.map((r) => ({
        title: r.title,
        file_type: r.file_type,
        status: r.status,
        chunk_count: r.chunk_count,
        updated_at: r.updated_at.toISOString(),
      })),
    };
  },
};
