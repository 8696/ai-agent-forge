/**
 * tests/integration/legacy-step5.test.ts
 * 历史 Step 5 / B2 验收：BM25 单元 + hybridSearch + 跨租户
 * 已转为 vitest 格式
 *
 * 注：BM25 单元测试不依赖外部；hybridSearch 依赖 Embedding + Qdrant。
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
import { tokenize, bm25Search, bm25Add, _resetBm25ForTest } from '../../src/rag/bm25';

const BASE = `http://localhost:${process.env.PORT ?? '3000'}`;

const SAMPLE_MD = `# 年假制度

## 第一条：工龄计算
工龄 1-5 年的员工，每年享有 5 天年假。
工龄 6-10 年的员工，每年享有 10 天年假。
工龄 10 年以上的员工，每年享有 15 天年假。

## 第二条：申请流程
请在请假前 7 天通过申请系统提交申请，HR 会在 3 个工作日内审批。
`;

describe('legacy Step 5 / B2 · RAG 检索', () => {
  const codeA = `step5a-${Date.now()}`;
  const codeB = `step5b-${Date.now()}`;
  let tenantAId = '';
  let tenantBId = '';
  let adminId = '';
  let adminToken = '';
  let docId = '';
  let fixtureDir = '';

  let hasEmbed = false;

  beforeAll(async () => {
    getSequelize();
    await Tenant.destroy({ where: { code: { [Symbol.for('like')]: 'step5%' } } });
    const tA = await Tenant.create({ code: codeA, name: 'Step5 A' });
    tenantAId = tA.id;
    const tB = await Tenant.create({ code: codeB, name: 'Step5 B' });
    tenantBId = tB.id;
    const admin = await User.create({
      tenant_id: tA.id,
      email: `step5-${Date.now()}@step5.test`,
      password_hash: await hashPassword('Step5-123'),
      role: 'admin',
      must_change_password: false,
    });
    adminId = admin.id;
    const login = await axios.post(`${BASE}/api/v1/admin/login`, {
      email: admin.email,
      password: 'Step5-123',
      tenant_code: codeA,
    }, { validateStatus: () => true });
    adminToken = (login.data as { token: string }).token;
    fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'step5-'));
    const fixturePath = path.join(fixtureDir, '年假制度.md');
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

  describe('BM25 单元（不依赖外部）', () => {
    it('tokenize 切出 jieba 词 + bigram', () => {
      const tok = tokenize('年假 5 天');
      expect(tok).toContain('年假');
      expect(tok.some((t) => t === '年假5' || t === '5天')).toBe(true);
    });

    it('BM25 命中 + 跨租户隔离', async () => {
      _resetBm25ForTest();
      bm25Add({
        tenantId: tenantAId,
        docId: 'doc1',
        source: '年假制度',
        chunks: [
          { index: 0, text: '工龄 1-5 年的员工，每年享有 5 天年假。', source: '年假制度' },
          { index: 1, text: '请在请假前 7 天通过申请系统提交申请。', source: '年假制度' },
        ],
      });
      const hits = await bm25Search({ query: '年假几天', tenantId: tenantAId, topK: 5 });
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]?.chunk_index).toBe(0);
      const crossHits = await bm25Search({ query: '年假几天', tenantId: tenantBId, topK: 5 });
      expect(crossHits.length).toBe(0);
      _resetBm25ForTest();
    });
  });

  describe('hybridSearch 端到端（依赖 Embedding + Qdrant）', () => {
    function adminHttp() {
      return axios.create({
        baseURL: `${BASE}/api/v1/admin`,
        headers: { authorization: `Bearer ${adminToken}` },
        maxContentLength: 64 * 1024 * 1024,
        maxBodyLength: 64 * 1024 * 1024,
      });
    }

    it('上传 + 检索', async () => {
      if (!hasEmbed || config.QDRANT_URL === '') {
        console.warn('⚠️  Embedding/Qdrant 未配置，跳过 hybridSearch 端到端');
        return;
      }
      const fixturePath = path.join(fixtureDir, '年假制度.md');
      const fileBuf = await fs.readFile(fixturePath);
      const form = new FormData();
      form.append('file', new Blob([fileBuf]), '年假制度.md');
      const up = await adminHttp().post('/knowledge/upload', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        validateStatus: () => true,
      });
      expect(up.status).toBe(201);
      docId = (up.data as { id: string }).id;

      const r = await adminHttp().post('/knowledge/test', {
        query: '年假几天',
        top_k: 5,
      }, { validateStatus: () => true });
      expect(r.status).toBe(200);
      const hits = (r.data as { hits: Array<{ doc_id: string; text: string; sources: string[] }> }).hits;
      expect(hits.some((h) => h.doc_id === docId && h.text.includes('年假'))).toBe(true);
      // 至少 1 条双源融合
      const dual = hits.filter((h) => h.sources.includes('vector') && h.sources.includes('bm25'));
      expect(dual.length).toBeGreaterThan(0);
    });

    it('跨租户：adminB 检索不出现 tenantA 的 doc', async () => {
      if (!hasEmbed || config.QDRANT_URL === '') {
        console.warn('⚠️  Embedding/Qdrant 未配置，跳过');
        return;
      }
      const adminB = await User.create({
        tenant_id: tenantBId,
        email: `step5b-${Date.now()}@step5.test`,
        password_hash: await hashPassword('Step5B-123'),
        role: 'admin',
        must_change_password: false,
      });
      const loginB = await axios.post(`${BASE}/api/v1/admin/login`, {
        email: adminB.email,
        password: 'Step5B-123',
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
      const hits = (r.data as { hits: Array<{ doc_id: string }> }).hits;
      expect(hits.some((h) => h.doc_id === docId)).toBe(false);

      await User.destroy({ where: { id: adminB.id } });
    });

    it('DELETE → 检索不再命中', async () => {
      if (!hasEmbed || config.QDRANT_URL === '' || docId === '') {
        console.warn('⚠️  未配置或未上传，跳过');
        return;
      }
      const http = adminHttp();
      const del = await http.delete(`/knowledge/${docId}`, { validateStatus: () => true });
      expect(del.status).toBe(204);

      const after = await http.post('/knowledge/test', {
        query: '年假几天',
        top_k: 5,
      }, { validateStatus: () => true });
      const hits = (after.data as { hits: Array<{ doc_id: string }> }).hits;
      expect(hits.some((h) => h.doc_id === docId)).toBe(false);
    });

    it('audit_logs 写了 DOCUMENT_UPLOAD + DOCUMENT_DELETE', async () => {
      if (docId === '') {
        console.warn('⚠️  未上传文档，跳过');
        return;
      }
      const rows = await AuditLog.findAll({
        where: { resource_id: docId },
        order: [['created_at', 'ASC']],
      });
      const actions = rows.map((r) => r.action);
      expect(actions).toContain('DOCUMENT_UPLOAD');
      expect(actions).toContain('DOCUMENT_DELETE');
    });
  });
});
