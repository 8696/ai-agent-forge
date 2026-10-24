/**
 * tests/integration/memory-extraction-model.test.ts
 * B4 长期记忆的「抽取侧」：抽取模型可独立配置 + 抽取进 trace/span
 *
 * 对应 src/services/memory.ts（extractAndApplyMemories）
 *        src/services/llm-settings.ts（resolveExtractionLlm）
 *        src/services/tenant-models.ts（usage_scope）
 *
 * 本文件**不产生 LLM 费用**：`generateText` 被 mock 掉，
 * 走的是「模型返回一段 JSON → 解析 → 落库」这条纯本地链路。
 *
 * 前置条件：后端起在 3099（NODE_ENV=test PORT=3099 tsx src/server.ts）
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Op } from 'sequelize';
import { allHttpFromTokensFile, type AllHttp } from '../helpers';
import { getSequelize } from '../../src/db';
import { Span, Tenant, TenantModel, Trace, User, UserMemory } from '../../src/models';
import { encryptSecret, secretHint } from '../../src/lib/crypto';
import { resolveExtractionLlm, type ResolvedLlmSettings } from '../../src/services/llm-settings';
import { activateTenantModel } from '../../src/services/tenant-models';
import { extractAndApplyMemories } from '../../src/services/memory';

// ⚠️ mock 必须打在**被测模块的导入之前**（vitest 会把 vi.mock 提到文件顶部）。
//    用 importOriginal 保留 'ai' 的其它导出 —— 依赖链上还有别的模块从 'ai' 取东西。
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn(async () => ({
      text: JSON.stringify({
        memories: [
          { op: 'add', category: 'profile', content: '用户是客服主管', confidence: 0.9 },
        ],
      }),
      usage: { inputTokens: 1200, outputTokens: 300 },
    })),
  };
});

/** 兜底的对话模型配置（抽取模型解析失败时才用得到） */
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

/** 测试专用模型条目的名字前缀（用来清掉上次跑剩下的） */
const TEST_MODEL_PREFIX = '测试-';

describe('记忆抽取 · 模型可独立配置 + 进 trace', () => {
  let http: AllHttp;
  let tenantId: string;
  let userId: string;
  /** 本次测试建的模型条目，afterAll 清掉 */
  const createdModelIds: string[] = [];

  beforeAll(async () => {
    getSequelize();
    http = await allHttpFromTokensFile();
    const tenant = await Tenant.findOne({ where: { code: 'acme' } });
    expect(tenant).not.toBeNull();
    tenantId = tenant!.id;
    const user = await User.findOne({ where: { tenant_id: tenantId, email: 'alice@acme.test' } });
    expect(user).not.toBeNull();
    userId = user!.id;

    // 清掉上次跑剩下的测试模型 —— 否则「这个 scope 的第一条自动启用」会不成立
    await TenantModel.destroy({
      where: { tenant_id: tenantId, name: { [Op.like]: `${TEST_MODEL_PREFIX}%` } },
    });
  });

  afterAll(async () => {
    if (createdModelIds.length > 0) {
      await TenantModel.destroy({ where: { id: createdModelIds } });
    }
  });

  /** 直接往库里塞一条模型条目（绕开 HTTP，测服务层的回落链） */
  const insertModel = async (opts: {
    name: string;
    modelId: string;
    scope: 'chat' | 'memory';
    active: boolean;
  }): Promise<string> => {
    const row = await TenantModel.create({
      tenant_id: tenantId,
      name: `${TEST_MODEL_PREFIX}${opts.name}`,
      provider: 'custom',
      model_id: opts.modelId,
      base_url: 'http://127.0.0.1:9/v1',
      api_key_enc: encryptSecret('sk-test-dummy'),
      api_key_hint: secretHint('sk-test-dummy'),
      usage_scope: opts.scope,
      is_active: opts.active,
    });
    createdModelIds.push(row.id);
    return row.id;
  };

  /** 把本租户所有模型的启用位清掉 —— 让回落链的断言是确定的 */
  const deactivateAll = async (): Promise<void> => {
    await TenantModel.update({ is_active: false }, { where: { tenant_id: tenantId } });
  };

  describe('配置 · usage_scope', () => {
    it('201 建的模型默认是「对话」用途', async () => {
      const r = await http.acmeAdmin.post(
        '/config/models',
        {
          name: `${TEST_MODEL_PREFIX}对话模型-${Date.now()}`,
          provider: 'custom',
          model_id: 'test-chat-model',
          base_url: 'http://127.0.0.1:9/v1',
          api_key: 'sk-test-dummy',
          temperature: 0.2,
          max_output_tokens: 2048,
          prompt_cache_enabled: false,
        },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(201);
      const body = r.data as { id: string; usage_scope: string; is_active: boolean };
      expect(body.usage_scope).toBe('chat');
      createdModelIds.push(body.id);
    });

    it('201 能建「记忆抽取」用途的模型', async () => {
      const r = await http.acmeAdmin.post(
        '/config/models',
        {
          name: `${TEST_MODEL_PREFIX}抽取模型-${Date.now()}`,
          provider: 'custom',
          model_id: 'test-memory-model',
          base_url: 'http://127.0.0.1:9/v1',
          api_key: 'sk-test-dummy',
          temperature: 0,
          max_output_tokens: 4096,
          prompt_cache_enabled: false,
          usage_scope: 'memory',
        },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(201);
      const body = r.data as { id: string; usage_scope: string; is_active: boolean };
      expect(body.usage_scope).toBe('memory');
      // 每个 scope 的第一条自动成为该 scope 的启用项
      expect(body.is_active).toBe(true);
      createdModelIds.push(body.id);
    });

    it('GET /config/models 分别报出「对话启用项」和「抽取启用项」', async () => {
      const r = await http.acmeAdmin.get('/config/models', { validateStatus: () => true });
      expect(r.status).toBe(200);
      const body = r.data as {
        active_chat: { usage_scope: string } | null;
        active_memory: { usage_scope: string } | null;
      };
      expect(body.active_chat?.usage_scope ?? 'chat').toBe('chat');
      expect(body.active_memory?.usage_scope ?? null).toBe('memory');
    });

    it('两个 scope 各自一条启用项，切一个不动另一个', async () => {
      await deactivateAll();
      const chatId = await insertModel({
        name: '不变式-对话',
        modelId: 'inv-chat',
        scope: 'chat',
        active: true,
      });
      await insertModel({ name: '不变式-抽取旧', modelId: 'inv-mem-old', scope: 'memory', active: true });
      const memNewId = await insertModel({
        name: '不变式-抽取新',
        modelId: 'inv-mem-new',
        scope: 'memory',
        active: false,
      });

      // 切 memory scope → chat scope 的启用项不该被动
      await activateTenantModel(tenantId, memNewId);

      const rows = await TenantModel.findAll({ where: { tenant_id: tenantId } });
      const activeChat = rows.find((r) => r.usage_scope === 'chat' && r.is_active);
      const activeMem = rows.find((r) => r.usage_scope === 'memory' && r.is_active);
      expect(activeChat?.id).toBe(chatId);
      expect(activeMem?.id).toBe(memNewId);
    });
  });

  describe('回落链 · resolveExtractionLlm', () => {
    it('配了抽取模型就用抽取模型（tenant-model）', async () => {
      await deactivateAll();
      await insertModel({
        name: '回落-抽取',
        modelId: 'pick-memory-model',
        scope: 'memory',
        active: true,
      });
      const resolved = await resolveExtractionLlm(tenantId);
      expect(resolved.source).toBe('tenant-model');
      expect(resolved.model).toBe('pick-memory-model');
    });

    it('没配抽取模型就回落到对话模型（chat-model）', async () => {
      await deactivateAll();
      await insertModel({
        name: '回落-对话',
        modelId: 'pick-chat-model',
        scope: 'chat',
        active: true,
      });

      const resolved = await resolveExtractionLlm(tenantId);
      expect(resolved.source).toBe('chat-model');
      expect(resolved.model).toBe('pick-chat-model');
    });

    it('一条模型都没配就回落到平台默认（process-default）', async () => {
      await deactivateAll();

      const resolved = await resolveExtractionLlm(tenantId);
      expect(resolved.source).toBe('process-default');
      expect(resolved.modelEntryId).toBeNull();
    });
  });

  describe('观测 · 抽取进 trace/span', () => {
    it('抽取会写一条 kind=memory 的 trace，并带上 LLM / 成本 / 落库三段 span', async () => {
      const before = await Trace.count({ where: { tenant_id: tenantId, kind: 'memory' } });

      const result = await extractAndApplyMemories({
        tenantId,
        userId,
        userText: '我是华东区的区域经理',
        assistantText: '好的，记住了。',
        sessionId: null,
        messageId: null,
        fallbackLlm: FALLBACK_LLM,
      });

      expect(result.status).toBe('applied');
      expect(result.added).toBe(1);
      expect(result.tokens).toBe(1500);

      const after = await Trace.count({ where: { tenant_id: tenantId, kind: 'memory' } });
      expect(after).toBe(before + 1);

      const trace = await Trace.findOne({
        where: { tenant_id: tenantId, kind: 'memory' },
        order: [['started_at', 'DESC']],
      });
      expect(trace).not.toBeNull();
      expect(trace!.name).toBe('memory.extract');
      expect(trace!.status).toBe('success');
      expect(trace!.total_tokens).toBe(1500);
      expect(trace!.input_tokens).toBe(1200);
      expect(trace!.output_tokens).toBe(300);
      // 模型是谁要能看出来（成本排查的第一眼）
      expect(trace!.model).toBeTruthy();

      const spans = await Span.findAll({ where: { trace_id: trace!.id } });
      const names = spans.map((s) => s.name).sort();
      expect(names).toEqual(['cost.record', 'llm.extract', 'storage.apply']);
      // 每一段都得是 success —— 有一段 error 说明抽取中途出问题了
      expect(spans.every((s) => s.status === 'success')).toBe(true);

      // 记忆确实落库了
      const mem = await UserMemory.findOne({
        where: { tenant_id: tenantId, user_id: userId, content: '用户是客服主管' },
      });
      expect(mem).not.toBeNull();
      expect(mem!.source).toBe('auto');

      // 清理：把这次造的痕迹清掉
      await UserMemory.destroy({ where: { id: mem!.id } });
      await Span.destroy({ where: { trace_id: trace!.id } });
      await Trace.destroy({ where: { id: trace!.id } });
    });

    it('抽取失败时 trace 记 error（不是静默消失）', async () => {
      const { generateText } = await import('ai');
      const mocked = generateText as unknown as ReturnType<typeof vi.fn>;
      const original = mocked.getMockImplementation();
      mocked.mockImplementationOnce(async () => {
        throw new Error('模拟 LLM 挂了');
      });

      const result = await extractAndApplyMemories({
        tenantId,
        userId,
        userText: '我叫李雷',
        assistantText: '好的。',
        sessionId: null,
        messageId: null,
        fallbackLlm: FALLBACK_LLM,
      });

      expect(result.status).toBe('failed');

      const trace = await Trace.findOne({
        where: { tenant_id: tenantId, kind: 'memory' },
        order: [['started_at', 'DESC']],
      });
      expect(trace).not.toBeNull();
      expect(trace!.status).toBe('error');

      await Span.destroy({ where: { trace_id: trace!.id } });
      await Trace.destroy({ where: { id: trace!.id } });
      // 还原 mock（一次性覆盖用 mockImplementationOnce，不用还原也行，
      // 这里还原是为了让后面的用例拿到干净的默认实现）
      if (original !== undefined) {
        mocked.mockImplementation(original);
      }
    });
  });
});
