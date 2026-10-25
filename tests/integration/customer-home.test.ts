import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import {
  apiBase,
  allHttpFromTokensFile,
  customerHttp,
  readTokensFile,
  type AllHttp,
} from '../helpers';

/**
 * customer 首页工作台相关路由（B7）
 *   src/gateway/customer/profile-routes.ts    GET /profile
 *   src/gateway/customer/knowledge-routes.ts  GET /documents
 *
 * 前置条件：后端起在 3099（NODE_ENV=test PORT=3099 tsx src/server.ts）。
 *
 * ⚠️ 本文件**不调 LLM / Embedding**，全部是零费用的读接口 + 鉴权边界。
 */
const BASE = apiBase();

interface ProfileResponse {
  tenant: { code: string; name: string };
  home: { welcome_message: string; suggested_questions: string[] };
}

interface DocumentsResponse {
  documents: Array<{
    id: string;
    title: string;
    file_type: string | null;
    status: string;
    chunk_count: number;
    updated_at: string;
  }>;
  total: number;
}

describe('customer-home-routes · 前台首页', () => {
  let http: AllHttp;

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
  });

  describe('GET /api/v1/customer/profile', () => {
    it('200 + 租户信息 + 首页配置', async () => {
      const r = await http.acmeCustomer.get<ProfileResponse>('/profile');
      expect(r.status).toBe(200);
      expect(r.data.tenant.code).toBe('acme');
      expect(r.data.tenant.name.length).toBeGreaterThan(0);
      expect(typeof r.data.home.welcome_message).toBe('string');
      expect(Array.isArray(r.data.home.suggested_questions)).toBe(true);
    });

    it('租户 id 只认 JWT —— 换个租户的 token 拿不到别的租户', async () => {
      const r = await http.globCustomer.get<ProfileResponse>('/profile');
      expect(r.status).toBe(200);
      expect(r.data.tenant.code).toBe('globex');
    });

    it('401 没带 token', async () => {
      const r = await axios.get(`${BASE}/api/v1/customer/profile`, { validateStatus: () => true });
      expect(r.status).toBe(401);
    });

    it('401 admin 角色打不进 customer 命名空间', async () => {
      // ⚠️ 必须用 customer 命名空间的 baseURL + admin 的 token
      //    （http.acmeAdmin 的 baseURL 是 /api/v1/admin，路径打不到这边）
      const tokens = await readTokensFile();
      const r = await customerHttp(tokens.acmeAdmin).get('/profile', {
        validateStatus: () => true,
      });
      expect(r.status).toBe(401);
    });
  });

  describe('GET /api/v1/customer/documents', () => {
    it('200 + 文档清单 + 总数', async () => {
      const r = await http.acmeCustomer.get<DocumentsResponse>('/documents');
      expect(r.status).toBe(200);
      expect(Array.isArray(r.data.documents)).toBe(true);
      expect(typeof r.data.total).toBe('number');
      expect(r.data.total).toBeGreaterThanOrEqual(r.data.documents.length);
    });

    it('不泄露磁盘路径 / 存储文件名 / 排障摘要', async () => {
      const r = await http.acmeCustomer.get<DocumentsResponse>('/documents');
      for (const doc of r.data.documents) {
        expect(Object.keys(doc)).not.toContain('file_path');
        expect(Object.keys(doc)).not.toContain('source');
        expect(Object.keys(doc)).not.toContain('error_message');
      }
    });

    it('limit 生效', async () => {
      const r = await http.acmeCustomer.get<DocumentsResponse>('/documents', { params: { limit: 1 } });
      expect(r.status).toBe(200);
      expect(r.data.documents.length).toBeLessThanOrEqual(1);
    });

    it('limit 越界 → 400', async () => {
      const r = await http.acmeCustomer.get('/documents', {
        params: { limit: 999 },
        validateStatus: () => true,
      });
      expect(r.status).toBe(400);
    });

    it('跨租户隔离：globex 看不到 acme 的文档', async () => {
      const acme = await http.acmeCustomer.get<DocumentsResponse>('/documents');
      const globex = await http.globCustomer.get<DocumentsResponse>('/documents');
      const acmeIds = new Set(acme.data.documents.map((d) => d.id));
      for (const doc of globex.data.documents) {
        expect(acmeIds.has(doc.id)).toBe(false);
      }
    });

    it('401 没带 token', async () => {
      const r = await axios.get(`${BASE}/api/v1/customer/documents`, { validateStatus: () => true });
      expect(r.status).toBe(401);
    });
  });
});
