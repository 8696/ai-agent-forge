/**
 * tests/integration/session-summary.test.ts
 * B1 摘要压缩的服务侧：调 LLM 摘要 → 写 sessions.summary → 推进边界
 *
 * 对应 src/services/session-summary.ts
 *
 * 本文件**不产生 LLM 费用**：`generateText` 被 mock 掉，
 * 走的是「模型返回一段摘要 → 清洗 → 落库 → 推进边界」这条纯本地链路。
 *
 * 前置条件：后端起在 3099（NODE_ENV=test PORT=3099 tsx src/server.ts）
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Op } from 'sequelize';
import { getSequelize } from '../../src/db';
import { Message, Session, Tenant, TenantModel, Trace, User } from '../../src/models';
import { encryptSecret, secretHint } from '../../src/lib/crypto';
import {
  loadSummaryState,
  readSummaryBoundary,
  summarizeDroppedTurns,
  type SessionSummaryState,
} from '../../src/services/session-summary';
import { resolveSummaryLlm, type ResolvedLlmSettings } from '../../src/services/llm-settings';

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn(async () => ({
      text: '- 用户咨询过年假制度\n- 助手已回答年假 5 天',
      usage: { inputTokens: 800, outputTokens: 60 },
    })),
  };
});

/** 兜底的对话模型配置（摘要模型解析失败时才用得到） */
const FALLBACK_LLM: ResolvedLlmSettings = {
  apiKey: 'sk-fallback',
  baseUrl: 'http://127.0.0.1:9/v1',
  model: 'fallback-chat-model',
  provider: 'custom',
  temperature: 0.2,
  maxOutputTokens: 2048,
  retrievalTopK: 5,
  maxHistoryTurns: 10,
  retrievalTokenBudget: 3000,
  contextTokenBudget: 12000,
  summaryTokenBudget: 600,
  summaryEnabled: true,
  maxInputChars: 4000,
  thinkingBudgetTokens: 0,
  promptCacheEnabled: true,
  promptVersion: null,
  modelEntryId: null,
  source: 'process-default',
  degraded: null,
};

const TEST_MODEL_PREFIX = '测试-摘要-';

describe('会话摘要 · 写库 + 边界推进', () => {
  let tenantId: string;
  let otherTenantId: string;
  let userId: string;
  /** 本次测试建的会话，afterAll 清掉 */
  const sessionIds: string[] = [];
  const createdModelIds: string[] = [];

  beforeAll(async () => {
    getSequelize();
    const tenant = await Tenant.findOne({ where: { code: 'acme' } });
    expect(tenant).not.toBeNull();
    tenantId = tenant!.id;
    const other = await Tenant.findOne({ where: { code: 'globex' } });
    expect(other).not.toBeNull();
    otherTenantId = other!.id;
    const user = await User.findOne({ where: { tenant_id: tenantId, email: 'alice@acme.test' } });
    expect(user).not.toBeNull();
    userId = user!.id;

    await TenantModel.destroy({
      where: { tenant_id: tenantId, name: { [Op.like]: `${TEST_MODEL_PREFIX}%` } },
    });
  });

  afterAll(async () => {
    if (sessionIds.length > 0) {
      await Session.destroy({ where: { id: sessionIds } });
    }
    if (createdModelIds.length > 0) {
      await TenantModel.destroy({ where: { id: createdModelIds } });
    }
  });

  /** 建一个会话 + 几轮消息，返回会话和消息行 */
  const seedSession = async (turns: number): Promise<{ session: Session; rows: Message[] }> => {
    const session = await Session.create({
      tenant_id: tenantId,
      user_id: userId,
      channel: 'web',
      status: 'active',
      started_at: new Date(),
    });
    sessionIds.push(session.id);
    const rows: Message[] = [];
    for (let i = 0; i < turns; i += 1) {
      await Message.create({
        session_id: session.id,
        tenant_id: tenantId,
        role: 'user',
        content: `问题 ${i + 1}`,
        status: 'complete',
      });
      await Message.create({
        session_id: session.id,
        tenant_id: tenantId,
        role: 'assistant',
        content: `回答 ${i + 1}`,
        status: 'complete',
      });
    }
    // 重新查一遍 —— created_at 是 DB 的列默认值（CURRENT_TIMESTAMP(6)），
    // create() 返回的实例里没有这个字段（模型的 timestamps 是 false）。
    // 生产链路拿到的也是 DB 行，所以这里跟线上保持一致。
    const reloaded = await Message.findAll({
      where: { session_id: session.id },
      order: [
        ['created_at', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    rows.push(...reloaded);
    return { session, rows };
  };

  it('摘要写进 sessions.summary，边界写进 metadata', async () => {
    const { session, rows } = await seedSession(3);

    const result = await summarizeDroppedTurns({
      tenantId,
      userId,
      sessionId: session.id,
      droppedRows: rows.slice(0, 2),
      fallbackLlm: FALLBACK_LLM,
    });

    expect(result.status).toBe('updated');
    expect(result.summary).toContain('年假');

    const reloaded = await Session.findByPk(session.id);
    expect(reloaded?.summary).toContain('年假');
    const boundary = readSummaryBoundary(reloaded?.metadata ?? null);
    expect(boundary?.message_id).toBe(rows[1]!.id);
  });

  it('已经摘要过的内容不会被重复摘要', async () => {
    const { session, rows } = await seedSession(3);
    await summarizeDroppedTurns({
      tenantId,
      userId,
      sessionId: session.id,
      droppedRows: rows.slice(0, 2),
      fallbackLlm: FALLBACK_LLM,
    });

    // 再来一次同样的一批 → 应该跳过
    const second = await summarizeDroppedTurns({
      tenantId,
      userId,
      sessionId: session.id,
      droppedRows: rows.slice(0, 2),
      fallbackLlm: FALLBACK_LLM,
    });
    expect(second.status).toBe('skipped');
    expect(second.turns).toBe(0);
  });

  it('新增的消息会被并进摘要（滚动重写）', async () => {
    const { session, rows } = await seedSession(4);
    await summarizeDroppedTurns({
      tenantId,
      userId,
      sessionId: session.id,
      droppedRows: rows.slice(0, 2),
      fallbackLlm: FALLBACK_LLM,
    });
    // 第二批：边界之后的 2 条
    const second = await summarizeDroppedTurns({
      tenantId,
      userId,
      sessionId: session.id,
      droppedRows: rows.slice(2, 4),
      fallbackLlm: FALLBACK_LLM,
    });
    expect(second.status).toBe('updated');

    const reloaded = await Session.findByPk(session.id);
    expect(readSummaryBoundary(reloaded?.metadata ?? null)?.message_id).toBe(rows[3]!.id);
  });

  it('读状态：摘要和边界都能读回来', async () => {
    const { session, rows } = await seedSession(2);
    await summarizeDroppedTurns({
      tenantId,
      userId,
      sessionId: session.id,
      droppedRows: rows,
      fallbackLlm: FALLBACK_LLM,
    });
    const state: SessionSummaryState = await loadSummaryState(session.id, tenantId);
    expect(state.summary).toContain('年假');
    // 边界落在「被摘要的最后一条消息」上
    expect(state.boundary?.message_id).toBe(rows[rows.length - 1]!.id);
  });

  it('跨租户读不到别人的摘要', async () => {
    const { session, rows } = await seedSession(2);
    await summarizeDroppedTurns({
      tenantId,
      userId,
      sessionId: session.id,
      droppedRows: rows,
      fallbackLlm: FALLBACK_LLM,
    });
    // 用别的租户 id 读 → 读不到
    const state = await loadSummaryState(session.id, otherTenantId);
    expect(state.summary).toBeNull();
    expect(state.boundary).toBeNull();
  });

  it('没有可摘要的内容时跳过（不调模型）', async () => {
    const { session } = await seedSession(1);
    const result = await summarizeDroppedTurns({
      tenantId,
      userId,
      sessionId: session.id,
      droppedRows: [],
      fallbackLlm: FALLBACK_LLM,
    });
    expect(result.status).toBe('skipped');
  });

  it('摘要写一条独立 trace（不挂在对话 trace 上）', async () => {
    const { session, rows } = await seedSession(2);
    await summarizeDroppedTurns({
      tenantId,
      userId,
      sessionId: session.id,
      droppedRows: rows,
      fallbackLlm: FALLBACK_LLM,
    });
    const trace = await Trace.findOne({
      where: { tenant_id: tenantId, session_id: session.id, kind: 'summary' },
    });
    expect(trace).not.toBeNull();
    expect(trace?.status).toBe('success');
  });

  it('摘要模型可以单独配（usage_scope=summary）', async () => {
    const row = await TenantModel.create({
      tenant_id: tenantId,
      name: `${TEST_MODEL_PREFIX}便宜模型`,
      provider: 'custom',
      model_id: 'cheap-summary-model',
      base_url: 'http://127.0.0.1:9/v1',
      api_key_enc: encryptSecret('sk-test-dummy'),
      api_key_hint: secretHint('sk-test-dummy'),
      usage_scope: 'summary',
      is_active: true,
      temperature: 0,
      max_output_tokens: 1024,
      prompt_cache_enabled: false,
    });
    createdModelIds.push(row.id);

    const resolved = await resolveSummaryLlm(tenantId);
    expect(resolved.source).toBe('tenant-model');
    expect(resolved.model).toBe('cheap-summary-model');
    expect(resolved.modelEntryId).toBe(row.id);
  });
});
