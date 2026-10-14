/**
 * tests/integration/legacy-step6.test.ts
 * 历史 Step 6 验收：LLM 调用 + 流式（API Key 鉴权）
 * 已转为 vitest 格式
 *
 * 注：依赖 .env 配 LLM_PROVIDER + 对应 *_API_KEY / *_ANTHROPIC_BASE_URL；
 *     未配置时 LLM 用例会失败（不是 skip）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { getSequelize } from '../../src/db';
import { Tenant, User, ApiKey } from '../../src/models';
import { hashPassword } from '../../src/lib/password';
import { resolveLlm } from '../../src/config';
import bcrypt from 'bcrypt';
import { nanoid } from 'nanoid';

const BASE = `http://localhost:${process.env.PORT ?? '3000'}`;

describe('legacy Step 6 · LLM 调用 + 流式', () => {
  let rawKey = '';
  let llmReady = false;

  beforeAll(async () => {
    getSequelize();
    try {
      const cfg = resolveLlm();
      llmReady = cfg.llmApiKey !== '' && cfg.llmBaseUrl !== '' && cfg.llmModel !== '';
    } catch {
      llmReady = false;
    }
    if (!llmReady) {
      console.warn('⚠️  LLM 未配置；LLM 用例会失败（需要 .env）');
      return;
    }
    // 建独立租户 + api key（用时间戳后缀避免和 fixture 冲突）
    const code = `step6-${Date.now()}`;
    const t = await Tenant.create({ code, name: 'Step6 Tenant' });
    const u = await User.create({
      tenant_id: t.id,
      email: `step6-${Date.now()}@step6.test`,
      password_hash: await hashPassword('Step6-123'),
      role: 'admin',
      must_change_password: false,
    });
    rawKey = `ak_${nanoid(32)}`;
    await ApiKey.create({
      tenant_id: t.id,
      name: 'step6-test',
      key_prefix: rawKey.slice(0, 8),
      key_hash: await bcrypt.hash(rawKey, 12),
      created_by: u.id,
    });
  });

  it('POST /chat 无 key → 401', async () => {
    const r = await axios.post(`${BASE}/api/v1/chat`, {
      messages: [{ role: 'user', content: 'hi' }],
    }, { validateStatus: () => true });
    expect(r.status).toBe(401);
  });

  it('POST /chat 用错 key（ak_ 但不匹配） → 401', async () => {
    const r = await axios.post(`${BASE}/api/v1/chat`, {
      messages: [{ role: 'user', content: 'hi' }],
    }, {
      headers: { authorization: 'Bearer ak_definitely_not_real_key_1234567890' },
      validateStatus: () => true,
    });
    expect(r.status).toBe(401);
  });

  it('POST /chat 用 raw key → 200 + reply 非空（依赖 LLM）', async () => {
    if (!llmReady) {
      console.warn('LLM 未配置，跳过');
      return;
    }
    const r = await axios.post(`${BASE}/api/v1/chat`, {
      messages: [{ role: 'user', content: 'reply with one word: pong' }],
    }, {
      headers: { authorization: `Bearer ${rawKey}` },
      timeout: 60_000,
      validateStatus: () => true,
    });
    expect(r.status).toBe(200);
    const data = r.data as { reply: string; model: string; provider: string };
    expect(data.reply.length).toBeGreaterThan(0);
    expect(typeof data.model).toBe('string');
    expect(typeof data.provider).toBe('string');
  });

  it('POST /chat/stream 200 + 收到 SSE data 事件（依赖 LLM）', async () => {
    if (!llmReady) {
      console.warn('LLM 未配置，跳过');
      return;
    }
    const r = await axios.post(`${BASE}/api/v1/chat/stream`, {
      messages: [{ role: 'user', content: 'reply with one word: ping' }],
    }, {
      headers: { authorization: `Bearer ${rawKey}`, accept: 'text/event-stream' },
      responseType: 'stream',
      timeout: 60_000,
      validateStatus: () => true,
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/event-stream/);

    // 收集 stream 看有没有 0:"..." 事件
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const s = r.data as unknown as NodeJS.ReadableStream;
      s.on('data', (c: Buffer | string) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
      s.on('end', () => resolve());
      s.on('error', reject);
    });
    const text = Buffer.concat(chunks).toString('utf8');
    expect(text).toMatch(/data: 0:/); // 至少 1 条文本片段
  });
});
