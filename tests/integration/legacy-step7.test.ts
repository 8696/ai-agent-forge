/**
 * tests/integration/legacy-step7.test.ts
 * 历史 Step 7 验收：多轮对话 + 历史持久化 + 跨租户防御
 * 已转为 vitest 格式
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { getSequelize } from '../../src/db';
import { Tenant, User, ApiKey, Session, Message } from '../../src/models';
import { hashPassword } from '../../src/lib/password';
import { resolveLlm } from '../../src/config';
import bcrypt from 'bcrypt';
import { nanoid } from 'nanoid';

const BASE = `http://localhost:${process.env.PORT ?? '3000'}`;

describe('legacy Step 7 · 多轮对话 + 历史', () => {
  let rawKey = '';
  let llmReady = false;
  let tenantId = '';

  beforeAll(async () => {
    getSequelize();
    try {
      const cfg = resolveLlm();
      llmReady = cfg.llmApiKey !== '' && cfg.llmBaseUrl !== '' && cfg.llmModel !== '';
    } catch {
      llmReady = false;
    }
    if (!llmReady) {
      console.warn('⚠️  LLM 未配置；多轮 + 持久化用例会失败');
      return;
    }
    const code = `step7-${Date.now()}`;
    const t = await Tenant.create({ code, name: 'Step7 Tenant' });
    tenantId = t.id;
    const u = await User.create({
      tenant_id: t.id,
      email: `step7-${Date.now()}@step7.test`,
      password_hash: await hashPassword('Step7-123'),
      role: 'admin',
      must_change_password: false,
    });
    rawKey = `ak_${nanoid(32)}`;
    await ApiKey.create({
      tenant_id: t.id,
      name: 'step7-test',
      key_prefix: rawKey.slice(0, 8),
      key_hash: await bcrypt.hash(rawKey, 12),
      created_by: u.id,
    });
  });

  async function streamOnce(sessionId: string | undefined, prompt: string): Promise<{ status: number; xSessionId: string | null; text: string }> {
    return axios.post(`${BASE}/api/v1/chat/stream`, {
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      messages: [{ role: 'user', content: prompt }],
    }, {
      headers: { authorization: `Bearer ${rawKey}`, accept: 'text/event-stream' },
      responseType: 'stream',
      timeout: 60_000,
      validateStatus: () => true,
    }).then(async (r) => {
      const xSessionId = (r.headers['x-session-id'] as string | undefined) ?? null;
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const s = r.data as unknown as NodeJS.ReadableStream;
        s.on('data', (c: Buffer | string) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
        s.on('end', () => resolve());
        s.on('error', reject);
      });
      const text = Buffer.concat(chunks).toString('utf8');
      // 提取 0:"..." 片段
      const events = text.split('\n\n').map((b) => b.trim()).filter((b) => b.startsWith('data:'));
      const segs = events.filter((e) => e.startsWith('data: 0:')).map((e) => {
        try {
          return JSON.parse(e.slice('data: 0:'.length).trim());
        } catch {
          return '';
        }
      });
      return { status: r.status, xSessionId, text: segs.join('') };
    });
  }

  it('第 1 轮无 session_id → 自动建 + 响应头 X-Session-Id', async () => {
    if (!llmReady) return;
    const r = await streamOnce(undefined, '记住这个关键词：BANANA-WALNUT-77');
    expect(r.status).toBe(200);
    expect(r.xSessionId).not.toBeNull();
  });

  it('session 持久化：title 自动回填 = 第 1 轮 user message 前 20 字', async () => {
    if (!llmReady) return;
    const r = await streamOnce(undefined, '你好，这是一段自我介绍');
    expect(r.xSessionId).not.toBeNull();
    const sessionId = r.xSessionId!;
    // 等落库
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = async (): Promise<void> => {
        const s = await Session.findByPk(sessionId);
        if (s !== null && s.title !== null) return resolve();
        if (Date.now() - start > 15_000) return resolve();
        setTimeout(() => void tick(), 300);
      };
      void tick();
    });
    const s = await Session.findByPk(sessionId);
    expect(s).not.toBeNull();
    expect(s?.title?.startsWith('你好，这是一段自我')).toBe(true);
  });

  it('第 2-5 轮带 session_id → 历史加载（5 轮后 ≥ 10 行）', async () => {
    if (!llmReady) return;
    const r1 = await streamOnce(undefined, '第 1 轮：起头');
    const sessionId = r1.xSessionId!;
    await new Promise((res) => setTimeout(res, 1500));

    const initial = await Message.count({ where: { session_id: sessionId } });
    for (let i = 2; i <= 5; i += 1) {
      await streamOnce(sessionId, `第 ${i} 轮测试`);
      await new Promise((res) => setTimeout(res, 1500));
    }
    // 等落库
    await new Promise<void>((resolve) => {
      const start = Date.now();
      const tick = async (): Promise<void> => {
        const c = await Message.count({ where: { session_id: sessionId } });
        if (c >= initial + 6 || Date.now() - start > 30_000) return resolve();
        setTimeout(() => void tick(), 500);
      };
      void tick();
    });
    const final = await Message.count({ where: { session_id: sessionId } });
    expect(final).toBeGreaterThanOrEqual(initial + 6);

    // 清理
    await Message.destroy({ where: { session_id: sessionId } });
    await Session.destroy({ where: { id: sessionId } });
  });

  it('GET /api/v1/sessions/:id 外部读（API Key 鉴权）', async () => {
    if (!llmReady) return;
    const r1 = await streamOnce(undefined, 'hello session');
    const sessionId = r1.xSessionId!;
    await new Promise((res) => setTimeout(res, 2000));
    const list = await axios.get(`${BASE}/api/v1/sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${rawKey}` },
      validateStatus: () => true,
    });
    expect(list.status).toBe(200);
    const body = list.data as { session: { id: string }; messages: unknown[] };
    expect(body.session.id).toBe(sessionId);
    expect(Array.isArray(body.messages)).toBe(true);

    // 清理
    await Message.destroy({ where: { session_id: sessionId } });
    await Session.destroy({ where: { id: sessionId } });
  });

  it('跨租户防御：另一个租户的 API Key 拿不到这个 session', async () => {
    if (!llmReady) return;
    // 建 tenantB + key
    const tB = await Tenant.create({ code: `step7b-${Date.now()}`, name: 'Step7 B' });
    const uB = await User.create({
      tenant_id: tB.id,
      email: `step7b-${Date.now()}@step7.test`,
      password_hash: await hashPassword('Step7B-123'),
      role: 'admin',
      must_change_password: false,
    });
    const rawB = `ak_${nanoid(32)}`;
    await ApiKey.create({
      tenant_id: tB.id,
      name: 'step7-b',
      key_prefix: rawB.slice(0, 8),
      key_hash: await bcrypt.hash(rawB, 12),
      created_by: uB.id,
    });

    const r1 = await streamOnce(undefined, 'tenantA session');
    const sessionId = r1.xSessionId!;
    await new Promise((res) => setTimeout(res, 2000));

    // tenantB 的 key 不能读
    const r = await axios.get(`${BASE}/api/v1/sessions/${sessionId}`, {
      headers: { authorization: `Bearer ${rawB}` },
      validateStatus: () => true,
    });
    expect(r.status).toBe(404);

    // 清理
    await Message.destroy({ where: { session_id: sessionId } });
    await Session.destroy({ where: { id: sessionId } });
    await ApiKey.destroy({ where: { tenant_id: [tenantId, tB.id] } });
    await User.destroy({ where: { id: [uB.id] } });
    await Tenant.destroy({ where: { id: [tB.id] } });
  });
});
