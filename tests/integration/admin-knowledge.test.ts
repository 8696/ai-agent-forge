/**
 * tests/integration/admin-knowledge.test.ts
 * 对应 src/gateway/admin/knowledge-routes.ts（4 个端点）
 * 详见 docs/18-测试流程规范.md §18.3
 *
 * 注：POST /knowledge/upload 需要 multipart/form-data + 真实文件，本测试不跑
 *     （业务正确性由 test-step4.ts 验证）；只覆盖 GET / DELETE / test 的接口契约。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { allHttpFromTokensFile, type AllHttp } from '../helpers';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Document } from '../../src/models';

const BASE = `http://localhost:${process.env.PORT ?? '3000'}`;

describe('admin-knowledge-routes', () => {
  let http: AllHttp;

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
  });

  describe('GET /knowledge · 列文档', () => {
    it('200 + 返回 documents 数组', async () => {
      const r = await http.acmeAdmin.get('/knowledge');
      expect(r.status).toBe(200);
      expect(Array.isArray((r.data as { documents: unknown[] }).documents)).toBe(true);
    });

    it('401 无 token', async () => {
      const r = await axios.get(`${BASE}/api/v1/admin/knowledge`, {
        validateStatus: () => true,
      });
      expect(r.status).toBe(401);
    });
  });

  describe('DELETE /knowledge/:id · 删文档', () => {
    it('404 不存在的 id', async () => {
      const r = await http.acmeAdmin.delete('/knowledge/__no_such_id__', {
        validateStatus: () => true,
      });
      expect(r.status).toBe(404);
    });

    it('204 删刚建的测试文档', async () => {
      // 从 /me 拿真实 tenant_id
      const me = await http.acmeAdmin.get('/me');
      const tenantId = (me.data as { tenant_id: string }).tenant_id;
      const doc = await Document.create({
        tenant_id: tenantId,
        title: 'to-delete-test',
        source: 'to-delete-test.txt',
        file_type: 'txt',
        file_path: path.resolve('./data', 'uploads', '__no_real_file__.txt'),
        status: 'ready',
        uploaded_by: '__test__',
      });
      const r = await http.acmeAdmin.delete(`/knowledge/${doc.id}`, {
        validateStatus: () => true,
      });
      expect(r.status).toBe(204);
    });
  });

  describe('POST /knowledge/test · 检索测试', () => {
    it('200 + 空库返回空 hits', async () => {
      const r = await http.acmeAdmin.post(
        '/knowledge/test',
        { query: 'what is this', top_k: 5 },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(200);
      expect(Array.isArray((r.data as { hits: unknown[] }).hits)).toBe(true);
    });

    it('400 query 为空字符串', async () => {
      const r = await http.acmeAdmin.post(
        '/knowledge/test',
        { query: '' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });

    it('400 top_k 超 max=50', async () => {
      const r = await http.acmeAdmin.post(
        '/knowledge/test',
        { query: 'x', top_k: 999 },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(400);
    });
  });

  describe('POST /knowledge/upload', () => {
    it.skip('业务正确性由 test-step4.ts 覆盖（multipart + LLM 索引）', () => {});
  });

  // 静态检查 src 用到
  void fs;
});
