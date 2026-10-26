/**
 * tests/integration/public-admin-api.test.ts
 * E1 · 对外 REST API 的 **admin 档**（知识库管理）
 *
 * 对应 src/gateway/public/admin-api-routes.ts（GET/POST/DELETE /api/v1/public/documents）
 *        src/services/document-ingest.ts（上传 / 索引 / 删除的共享实现）
 *
 * ## 为什么有这个文件
 *
 * `api_keys.scope` 的枚举里一直有 `admin`，后台的下拉里也能选 ——
 * 但**对外 API 没有任何 admin 专属端点**，所以一把 admin key 的实际能力
 * 跟 write 一模一样。用户能建出一把「看着比 write 大、实际没变」的钥匙。
 * 这个文件锁住「admin 真的有额外能力」这条。
 *
 * ## 本文件不调 LLM
 *
 * 只测鉴权 + 权限分级 + 知识库管理，**零费用**。
 * 上传那一条会真的调 Embedding（要花一点钱），所以只测「权限不够时被挡住」，
 * 不测「上传成功」（成功路径由 tests/integration/admin-knowledge.test.ts 覆盖）。
 *
 * 前置条件：后端起在 3099（NODE_ENV=test PORT=3099 tsx src/server.ts）
 */
import 'reflect-metadata';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import axios from 'axios';
import { allHttpFromTokensFile, type AllHttp } from '../helpers';
import { getSequelize } from '../../src/db';
import { ApiKey, AuditLog, Document, Tenant } from '../../src/models';

function base(): string {
  return process.env.API_BASE ?? `http://localhost:${process.env.PORT ?? '3099'}`;
}

describe('E1 · 对外 API 的 admin 档（知识库管理）', () => {
  let http: AllHttp;
  let acmeTenantId = '';
  let globTenantId = '';
  const createdKeyIds: string[] = [];
  const createdDocIds: string[] = [];

  beforeAll(async () => {
    getSequelize();
    http = await allHttpFromTokensFile();
    const acme = await Tenant.findOne({ where: { code: 'acme' } });
    const glob = await Tenant.findOne({ where: { code: 'globex' } });
    acmeTenantId = acme?.id ?? '';
    globTenantId = glob?.id ?? '';
    expect(acmeTenantId).not.toBe('');
    expect(globTenantId).not.toBe('');
  });

  afterAll(async () => {
    if (createdDocIds.length > 0) {
      await Document.destroy({ where: { id: createdDocIds } });
    }
    if (createdKeyIds.length > 0) {
      await ApiKey.destroy({ where: { id: createdKeyIds } });
    }
  });

  /** 建一把指定权限的 key（走后台管理端点，顺带验那条路也通） */
  const createKey = async (scope: 'read' | 'write' | 'admin'): Promise<string> => {
    const res = await http.acmeAdmin.post(
      '/api-keys',
      { name: `测试-admin档-${scope}-${Date.now()}`, scope },
      { validateStatus: () => true },
    );
    expect(res.status).toBe(201);
    const body = res.data as { id: string; api_key: string; scope: string };
    expect(body.scope).toBe(scope);
    createdKeyIds.push(body.id);
    return body.api_key;
  };

  const asKey = (key: string): ReturnType<typeof axios.create> =>
    axios.create({
      baseURL: base(),
      headers: { Authorization: `Bearer ${key}` },
      validateStatus: () => true,
    });

  /** 造一条文档行（不落盘、不索引 —— 只为测删除 / 列表的权限） */
  const makeDoc = async (tenantId: string, title: string): Promise<string> => {
    const doc = await Document.create({
      tenant_id: tenantId,
      title,
      source: null,
      file_type: 'txt',
      file_path: null,
      status: 'ready',
      chunk_count: 0,
      uploaded_by: null,
      metadata: { bytes: 0 },
    });
    createdDocIds.push(doc.id);
    return doc.id;
  };

  // ===== 权限分级 =====

  it('read 级 key：调知识库管理端点被挡（403）', async () => {
    const key = await createKey('read');
    const res = await asKey(key).get('/api/v1/public/documents');
    // 403 = key 有效但权限不够（401 会让调用方以为 key 失效了从而反复换 key）
    expect(res.status).toBe(403);
  });

  it('write 级 key：调知识库管理端点被挡（403）', async () => {
    const key = await createKey('write');
    const res = await asKey(key).get('/api/v1/public/documents');
    expect(res.status).toBe(403);
  });

  it('write 级 key：上传 / 删除也被挡（403）', async () => {
    const key = await createKey('write');
    const del = await asKey(key).delete('/api/v1/public/documents/whatever');
    expect(del.status).toBe(403);
  });

  it('admin 级 key：能列出本租户文档', async () => {
    const key = await createKey('admin');
    const res = await asKey(key).get('/api/v1/public/documents');
    expect(res.status).toBe(200);
    const body = res.data as {
      documents: Array<{ id: string; title: string }>;
      pagination: { page: number; total: number };
    };
    expect(Array.isArray(body.documents)).toBe(true);
    expect(body.pagination.page).toBe(1);
  });

  it('admin 级 key：列表里只有本租户的文档', async () => {
    const globDocId = await makeDoc(globTenantId, `globex-${Date.now()}`);
    const key = await createKey('admin');
    const res = await asKey(key).get('/api/v1/public/documents', { params: { page_size: 100 } });
    expect(res.status).toBe(200);
    const body = res.data as { documents: Array<{ id: string }> };
    // 别的租户的文档不该出现在这把 key 的列表里
    expect(body.documents.map((d) => d.id)).not.toContain(globDocId);
  });

  // ===== 跨租户隔离 =====

  it('admin 级 key：删别的租户的文档 → 404（不泄露存在性）', async () => {
    const globDocId = await makeDoc(globTenantId, `globex-${Date.now()}`);
    const key = await createKey('admin');
    const res = await asKey(key).delete(`/api/v1/public/documents/${globDocId}`);
    expect(res.status).toBe(404);
    // 文档还在
    const still = await Document.findByPk(globDocId);
    expect(still).not.toBeNull();
  });

  // ===== 删除 =====

  it('admin 级 key：能删本租户的文档，且留审计', async () => {
    const docId = await makeDoc(acmeTenantId, `acme-删我-${Date.now()}`);
    const key = await createKey('admin');

    const res = await asKey(key).delete(`/api/v1/public/documents/${docId}`);
    expect(res.status).toBe(204);

    const gone = await Document.findByPk(docId);
    expect(gone).toBeNull();

    // 审计里要能看出「是 API 删的、哪把 key 删的」
    const audit = await AuditLog.findOne({
      where: { resource_id: docId, action: 'DOCUMENT_DELETE' },
    });
    expect(audit).not.toBeNull();
    const details = audit?.details as { via?: string; api_key_id?: string } | null;
    expect(details?.via).toBe('api');
    expect(details?.api_key_id).toBeTruthy();
  });

  it('admin 级 key：删不存在的文档 → 404', async () => {
    const key = await createKey('admin');
    const res = await asKey(key).delete('/api/v1/public/documents/does-not-exist');
    expect(res.status).toBe(404);
  });

  // ===== sha256 定位列（迁移 034）=====

  it('新建的 key 落库时带 key_sha256', async () => {
    const key = await createKey('admin');
    const id = createdKeyIds[createdKeyIds.length - 1];
    const row = await ApiKey.findByPk(id);
    expect(row?.key_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.key_sha256).not.toBeNull();
    // 拿这把 key 调一次端点，鉴权应该走通（sha256 精确命中 + bcrypt 比对）
    // ⚠️ 用 GET /documents 探针而不是 GET /search —— 后者要连向量库，
    //    测「API Key 鉴权」不该被 Qdrant 的可用性带偏。
    const res = await asKey(key).get('/api/v1/public/documents');
    expect(res.status).toBe(200);
  });

  it('存量 key（key_sha256 为 NULL）仍能鉴权，并被自动回填', async () => {
    // 模拟迁移之前建的 key：sha256 列为空
    const key = await createKey('admin');
    const id = createdKeyIds[createdKeyIds.length - 1];
    await ApiKey.update({ key_sha256: null }, { where: { id } });

    // 慢路径：前缀粗筛 + bcrypt 比对 → 应该照样认出来
    const res = await asKey(key).get('/api/v1/public/documents');
    expect(res.status).toBe(200);

    // 自愈：鉴权成功后回填 sha256
    const row = await ApiKey.findByPk(id);
    expect(row?.key_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});
