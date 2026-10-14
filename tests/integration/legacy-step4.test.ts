/**
 * tests/integration/legacy-step4.test.ts
 * 历史 Step 4 / C1 验收：知识库上传 + 索引 + 检索 + 删除 + 跨租户
 * 已转为 vitest 格式
 *
 * 注：Embedding + Qdrant 未配置时索引会失败（status=failed），但 HTTP 链路本身通。
 *     纯检索用例在无 Embedding 时跳过。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import axios from 'axios';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSequelize } from '../../src/db';
import { Tenant, User, AuditLog } from '../../src/models';
import { hashPassword } from '../../src/lib/password';
import { config, resolveEmbedding } from '../../src/config';

const BASE = `http://localhost:${process.env.PORT ?? '3000'}`;

const SAMPLE_MD = `# 年假制度

## 第一条：工龄计算
工龄 1-5 年的员工，每年享有 5 天年假。
工龄 6-10 年的员工，每年享有 10 天年假。
工龄 10 年以上的员工，每年享有 15 天年假。

## 第二条：申请流程
请在请假前 7 天通过申请系统提交申请，HR 会在 3 个工作日内审批。
`;

describe('legacy Step 4 / C1 · 知识库管理', () => {
  const codeA = `step4a-${Date.now()}`;
  const codeB = `step4b-${Date.now()}`;
  const adminEmail = `step4-${Date.now()}@step4.test`;
  let tenantAId = '';
  let tenantBId = '';
  let adminId = '';
  let adminToken = '';
  let docId = '';
  let fixturePath = '';
  let fixtureDir = '';

  let hasEmbed = false;

  beforeAll(async () => {
    getSequelize();
    await Tenant.destroy({ where: { code: { [Symbol.for('like')]: 'step4%' } } });
    const tA = await Tenant.create({ code: codeA, name: 'Step4 A' });
    tenantAId = tA.id;
    const tB = await Tenant.create({ code: codeB, name: 'Step4 B' });
    tenantBId = tB.id;
    const admin = await User.create({
      tenant_id: tA.id,
      email: adminEmail,
      password_hash: await hashPassword('Step4-123'),
      role: 'admin',
      must_change_password: false,
    });
    adminId = admin.id;

    // 登录拿 token
    const login = await axios.post(`${BASE}/api/v1/admin/login`, {
      email: adminEmail,
      password: 'Step4-123',
      tenant_code: codeA,
    }, { validateStatus: () => true });
    adminToken = (login.data as { token: string }).token;

    // 写 fixture
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'step4-'));
    fixturePath = path.join(fixtureDir, '年假制度.md');
    await fs.writeFile(fixturePath, SAMPLE_MD, 'utf8');

    try {
      const cfg = resolveEmbedding();
      hasEmbed = cfg.embedBaseUrl !== '' && cfg.embedApiKey !== '' && cfg.embedModel !== '';
    } catch {
      hasEmbed = false;
    }
  });

  afterAll(async () => {
    await User.destroy({ where: { id: adminId } });
    await Tenant.destroy({ where: { id: [tenantAId, tenantBId] } });
    if (fixtureDir !== '') await fs.rm(fixtureDir, { recursive: true, force: true }).catch(() => {});
  });

  function adminHttp() {
    return axios.create({
      baseURL: `${BASE}/api/v1/admin`,
      headers: { authorization: `Bearer ${adminToken}` },
      maxContentLength: 64 * 1024 * 1024,
      maxBodyLength: 64 * 1024 * 1024,
    });
  }

  it('POST /knowledge/upload 链路通', async () => {
    const fileBuf = await fs.readFile(fixturePath);
    const form = new FormData();
    form.append('file', new Blob([fileBuf]), '年假制度.md');
    const r = await adminHttp().post('/knowledge/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      validateStatus: () => true,
    });
    // 无 Embedding → 200 + status=failed；有 → 201 + status=ready
    if (!hasEmbed) {
      expect([200, 201]).toContain(r.status);
      expect((r.data as { status: string }).status).toBe('failed');
    } else {
      expect(r.status).toBe(201);
      expect((r.data as { status: string }).status).toBe('ready');
    }
    docId = (r.data as { id: string }).id;
  });

  it('GET /knowledge 列表能找到这条', async () => {
    const r = await adminHttp().get('/knowledge', { validateStatus: () => true });
    expect(r.status).toBe(200);
    const ids = (r.data as { documents: Array<{ id: string }> }).documents.map((d) => d.id);
    expect(ids).toContain(docId);
  });

  it('POST /knowledge/test 检索（依赖 Embedding+Qdrant；无配置时 skip）', async () => {
    if (!hasEmbed || config.QDRANT_URL === '') {
      console.warn('⚠️  Embedding/Qdrant 未配置，跳过检索');
      return;
    }
    const r = await adminHttp().post('/knowledge/test', {
      query: '年假几天',
      top_k: 5,
    }, { validateStatus: () => true });
    expect(r.status).toBe(200);
    const hits = (r.data as { hits: Array<{ doc_id: string }> }).hits;
    expect(hits.some((h) => h.doc_id === docId)).toBe(true);
  });

  it('跨租户：adminB 检索不出现 tenantA 的 doc', async () => {
    if (!hasEmbed || config.QDRANT_URL === '') {
      console.warn('⚠️  Embedding/Qdrant 未配置，跳过跨租户检索');
      return;
    }
    // 建 adminB + 登录
    const adminBEmail = `step4b-${Date.now()}@step4.test`;
    const adminB = await User.create({
      tenant_id: tenantBId,
      email: adminBEmail,
      password_hash: await hashPassword('Step4B-123'),
      role: 'admin',
      must_change_password: false,
    });
    const loginB = await axios.post(`${BASE}/api/v1/admin/login`, {
      email: adminBEmail,
      password: 'Step4B-123',
      tenant_code: codeB,
    }, { validateStatus: () => true });
    const tokenB = (loginB.data as { token: string }).token;

    const r = await axios.post(`${BASE}/api/v1/admin/knowledge/test`, {
      query: '年假几天',
      top_k: 5,
    }, {
      headers: { authorization: `Bearer ${tokenB}` },
      validateStatus: () => true,
    });
    expect(r.status).toBe(200);
    const hits = (r.data as { hits: Array<{ doc_id: string }> }).hits;
    expect(hits.some((h) => h.doc_id === docId)).toBe(false);

    // 清理
    await User.destroy({ where: { id: adminB.id } });
  });

  it('DELETE /knowledge/:id → 204 + 列表不再有', async () => {
    const r = await adminHttp().delete(`/knowledge/${docId}`, { validateStatus: () => true });
    expect(r.status).toBe(204);
    const list = await adminHttp().get('/knowledge', { validateStatus: () => true });
    const ids = (list.data as { documents: Array<{ id: string }> }).documents.map((d) => d.id);
    expect(ids).not.toContain(docId);
  });

  it('audit_logs 写了 DOCUMENT_UPLOAD + DOCUMENT_DELETE', async () => {
    const rows = await AuditLog.findAll({
      where: { resource_id: docId },
      order: [['created_at', 'ASC']],
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('DOCUMENT_UPLOAD');
    expect(actions).toContain('DOCUMENT_DELETE');
  });
});
