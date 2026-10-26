/**
 * tests/integration/memory-relevance.test.ts
 * B4 的「记忆检索」那一项 —— 注入哪几条记忆按「跟当前问题相不相关」排
 *
 * 对应 src/services/memory.ts（buildMemoryContext / createMemory）
 *        src/services/memory-relevance.ts（向量召回）
 *
 * 本文件**不产生 embedding 费用**：`src/rag/embedding` 被 mock 掉，
 * 走的是「假向量 → 排序」这条纯本地链路。
 *
 * 前置条件：后端起在 3099（NODE_ENV=test PORT=3099 tsx src/server.ts）
 *            且迁移 035（user_memories.embedding）已跑 —— 少了那两列，
 *            查 user_memories 会报「Unknown column 'embedding'」。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { getSequelize } from '../../src/db';
import { Tenant, User, UserMemory } from '../../src/models';
import { buildMemoryContext, createMemory } from '../../src/services/memory';

// ⚠️ mock 必须打在**被测模块的导入之前**（vitest 会把 vi.mock 提到文件顶部）。
vi.mock('../../src/rag/embedding', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/rag/embedding')>();
  // 一个确定性的假 embedding：正文里含哪个关键词，就落在哪根轴上
  const AXES: Record<string, number> = { 发票: 0, 报销: 1, 回答: 2 };
  const fake = (text: string): number[] => {
    const vector = [0, 0, 0];
    for (const [word, axis] of Object.entries(AXES)) {
      if (text.includes(word)) {
        vector[axis] = 1;
      }
    }
    return vector;
  };
  return {
    ...actual,
    embedBatch: vi.fn(async (texts: readonly string[]) => texts.map(fake)),
    embedOne: vi.fn(async (text: string) => fake(text)),
  };
});

// resolveEmbedding 在测试环境不一定配了 embedding 模型 —— 固定成一个假的
vi.mock('../../src/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config')>();
  return {
    ...actual,
    resolveEmbedding: () => ({
      provider: 'test',
      embedModel: 'test-embed',
      embedDimensions: 3,
      embedBaseUrl: 'http://127.0.0.1:9/v1',
      embedApiKey: 'sk-test',
    }),
  };
});

describe('记忆的向量召回 · 按相关性注入', () => {
  let tenantId: string;
  let userId: string;
  /** 本次测试建的记忆，afterAll 清掉 */
  const createdIds: string[] = [];

  beforeAll(async () => {
    getSequelize();
    const tenant = await Tenant.findOne({ where: { code: 'acme' } });
    expect(tenant).not.toBeNull();
    tenantId = tenant!.id;
    const user = await User.findOne({ where: { tenant_id: tenantId, email: 'alice@acme.test' } });
    expect(user).not.toBeNull();
    userId = user!.id;
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await UserMemory.destroy({ where: { id: createdIds } });
    }
  });

  /** 建一条记忆（走真实的写入路径 —— 顺带验证向量确实被写进去了） */
  const addMemory = async (content: string): Promise<UserMemory> => {
    const row = await createMemory({
      tenantId,
      userId,
      content,
      source: 'user',
    });
    createdIds.push(row.id);
    return row;
  };

  it('写入的时候就把向量算好存进库里了', async () => {
    const row = await addMemory('发票抬头是 XX 公司');
    const stored = await UserMemory.findOne({ where: { id: row.id } });
    expect(stored?.embedding).not.toBeNull();
    expect(stored?.embedding_model).toBe('test-embed');
    expect(Array.isArray(stored?.embedding)).toBe(true);
  });

  it('⚠️ 核心：相关的那条排在前面，而不是「最新 / 用户写的优先」', async () => {
    // 这三条都是用户写的（优先级一样），只有相关性能分出胜负
    await addMemory('回答请简短一些');
    await addMemory('发票抬头是 XX 公司');
    await addMemory('报销要在每月 25 号之前提交');

    const ctx = await buildMemoryContext(tenantId, userId, {
      topK: 1,
      tokenBudget: 600,
      query: '发票怎么开',
    });

    expect(ctx.ranked).toBe(true);
    expect(ctx.injected).toHaveLength(1);
    expect(ctx.injected[0]?.content).toContain('发票');
    // 得分是正的（确实被判成相关）
    expect(ctx.relevance.get(ctx.injected[0]!.id) ?? 0).toBeGreaterThan(0);
  });

  it('换个问题，排第一的也跟着换', async () => {
    const ctx = await buildMemoryContext(tenantId, userId, {
      topK: 1,
      tokenBudget: 600,
      query: '报销流程是什么',
    });
    expect(ctx.injected[0]?.content).toContain('报销');
  });

  it('不给问题 = 退回固定顺序（相关性排序是可选的）', async () => {
    const ctx = await buildMemoryContext(tenantId, userId, {
      topK: 3,
      tokenBudget: 600,
    });
    expect(ctx.ranked).toBe(false);
    expect(ctx.relevance.size).toBe(0);
    expect(ctx.injected.length).toBeGreaterThan(0);
  });

  it('改了内容 → 旧向量作废并重算（不能让旧内容的向量继续参与排序）', async () => {
    const row = await addMemory('临时写的一条');
    const before = await UserMemory.findOne({ where: { id: row.id } });
    expect(before?.embedding).not.toBeNull();

    const { updateMemoryContent } = await import('../../src/services/memory');
    await updateMemoryContent(tenantId, row.id, { content: '发票抬头改成 YY 公司' });

    const after = await UserMemory.findOne({ where: { id: row.id } });
    expect(after?.embedding).not.toBeNull();
    // 向量跟着新内容重算了（假 embedding 里「发票」在第 0 根轴上）
    expect((after?.embedding as number[])[0]).toBe(1);
  });
});
