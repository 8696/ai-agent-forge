/**
 * tests/integration/admin-knowledge.test.ts
 * 对应 src/gateway/admin/knowledge-routes.ts（5 个端点）
 * 详见 docs/12-c-需求-管理员可配置.md §C1
 *
 * ⚠️ 前置条件（跟仓库其它 integration 测试一样，由 vitest globalSetup 保证）：
 *   1. 已跑过 `yarn migrate`（documents 表存在）
 *   2. 测试后端已起在 3099：`NODE_ENV=test PORT=3099 tsx src/server.ts`
 *   3. .env 里 LLM_PROVIDER 对应的 provider **有可用的 Embedding 凭据**
 *      （本测试会真的调 Embedding API 并往 Qdrant 写真数据）
 *
 * 本测试会真的产生 Embedding 调用费用，并用 acme / globex 两个租户的
 * doc_id 往 Qdrant 的 documents collection 写点（跑完自动清理）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import axios from 'axios';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { allHttpFromTokensFile, type AllHttp } from '../helpers';

const BASE = `http://localhost:${process.env.PORT ?? '3099'}`;
const TMP_DIR = path.resolve(process.cwd(), 'data', 'tmp');

/** 统计 DATA_DIR/tmp 里的残留文件数（用于验证被拒的上传不留垃圾） */
async function tmpFileCount(): Promise<number> {
  const entries = await readdir(TMP_DIR).catch(() => []);
  return entries.filter((name) => !name.startsWith('.')).length;
}

/** 带唯一后缀的关键词：即使测试重跑 / 库里留着上一轮的残留文档，也不会互相干扰 */
const MARKER = `知识库测试${Date.now()}`;

interface KnowledgeDoc {
  id: string;
  title: string;
  file_type: string | null;
  status: string;
  chunk_count: number;
  error_message: string | null;
}

interface ListResponse {
  documents: KnowledgeDoc[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
  stats: { chunk_total: number; bm25_chunk_total: number; qdrant_points: number };
}

interface UploadResponse {
  id: string;
  title: string;
  file_type: string | null;
  status: string;
  chunk_count: number;
  pages?: number;
  error?: string;
}

interface SearchResponse {
  query: string;
  took_ms: number;
  hits: Array<{
    doc_id: string;
    chunk_index: number;
    source: string;
    text: string;
    score: number;
    rrf_score: number;
    sources: Array<'vector' | 'bm25'>;
    vector_rank: number | null;
    bm25_rank: number | null;
  }>;
}

/** 造一个内存里的 .md 文件；Node 18+ 有全局 FormData / Blob，axios 能直接发 multipart */
function mdFile(content: string): FormData {
  const form = new FormData();
  form.append(
    'file',
    new Blob([content], { type: 'text/markdown' }),
    `${MARKER}.md`,
  );
  return form;
}

describe('admin-knowledge-routes', () => {
  let http: AllHttp;
  /** 本轮创建的文档 id，afterAll 里统一删干净 */
  const createdIds: string[] = [];

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await http.acmeAdmin.delete(`/knowledge/${id}`, { validateStatus: () => true });
    }
  });

  async function uploadAcme(content: string): Promise<UploadResponse> {
    const r = await http.acmeAdmin.post<UploadResponse>('/knowledge/upload', mdFile(content), {
      timeout: 300_000,
    });
    if (r.data.id !== undefined) createdIds.push(r.data.id);
    return r.data;
  }

  describe('GET /knowledge · 文档列表', () => {
    it('200 + 返回列表 / 分页 / 统计', async () => {
      const r = await http.acmeAdmin.get<ListResponse>('/knowledge');
      expect(r.status).toBe(200);
      expect(Array.isArray(r.data.documents)).toBe(true);
      expect(r.data.pagination.page).toBe(1);
      expect(typeof r.data.stats.chunk_total).toBe('number');
      expect(typeof r.data.stats.bm25_chunk_total).toBe('number');
    });

    it('401 无 token', async () => {
      const r = await axios.get(`${BASE}/api/v1/admin/knowledge`, {
        validateStatus: () => true,
      });
      expect(r.status).toBe(401);
    });

    it('支持分页与关键词筛选', async () => {
      const r = await http.acmeAdmin.get<ListResponse>('/knowledge', {
        params: { page: 1, page_size: 5, keyword: '不可能存在的文件名xyz' },
      });
      expect(r.status).toBe(200);
      expect(r.data.documents).toHaveLength(0);
      expect(r.data.pagination.page_size).toBe(5);
    });
  });

  describe('POST /knowledge/upload · 上传并索引', () => {
    it('201 + Markdown 索引完成且有块数', async () => {
      const content = [
        `# ${MARKER}`,
        '',
        `${MARKER}的年假制度：员工入职满 1 年不满 10 年的，年假 5 天；满 10 年不满 20 年的，年假 10 天。`,
        '',
        `${MARKER}的报销制度：差旅报销需要在出差结束后 30 天内提交发票，逾期不予受理。`,
      ].join('\n');

      const result = await uploadAcme(content);
      expect(result.status).toBe('ready');
      expect(result.chunk_count).toBeGreaterThan(0);
      expect(result.file_type).toBe('markdown');
      expect(result.error).toBeUndefined();
    });

    it('201 + TXT 索引完成', async () => {
      const form = new FormData();
      form.append('file', new Blob([`${MARKER} TXT 测试内容。`], { type: 'text/plain' }), `${MARKER}.txt`);
      const r = await http.acmeAdmin.post<UploadResponse>('/knowledge/upload', form, {
        timeout: 300_000,
      });
      createdIds.push(r.data.id);
      expect(r.data.status).toBe('ready');
      expect(r.data.chunk_count).toBeGreaterThan(0);
      expect(r.data.file_type).toBe('txt');
    });

    it('索引成功后出现在列表里，块数一致', async () => {
      const result = await uploadAcme(`${MARKER} 出现在列表里的文档。`);
      const list = await http.acmeAdmin.get<ListResponse>('/knowledge', {
        params: { keyword: MARKER },
      });
      const found = list.data.documents.find((d) => d.id === result.id);
      expect(found).toBeDefined();
      expect(found?.status).toBe('ready');
      expect(found?.chunk_count).toBe(result.chunk_count);
      expect(found?.error_message).toBeNull();
    });

    it('400 不支持的文件类型，且不在 tmp 目录留垃圾文件', async () => {
      const before = await tmpFileCount();
      const form = new FormData();
      form.append('file', new Blob(['MZ...'], { type: 'application/octet-stream' }), 'virus.exe');
      const r = await http.acmeAdmin.post('/knowledge/upload', form, {
        validateStatus: () => true,
        timeout: 60_000,
      });
      expect(r.status).toBe(400);
      // koa-body 在进处理器前就把文件写到 tmp 了；校验失败必须自己清掉，
      // 否则每次被拒的上传都会留一份垃圾在磁盘上
      expect(await tmpFileCount()).toBe(before);
    });

    it('400 没有上传文件', async () => {
      const form = new FormData();
      form.append('not_file', 'x');
      const r = await http.acmeAdmin.post('/knowledge/upload', form, {
        validateStatus: () => true,
        timeout: 60_000,
      });
      expect(r.status).toBe(400);
    });
  });

  describe('POST /knowledge/search · 混合检索', () => {
    it('200 + 命中刚上传的文档，且带召回来源标记', async () => {
      const keyword = `急先锋${MARKER}`;
      const result = await uploadAcme(`${keyword}：本产品不支持开具增值税专用发票。`);
      expect(result.status).toBe('ready');

      const r = await http.acmeAdmin.post<SearchResponse>('/knowledge/search', {
        query: keyword,
        top_k: 5,
      });
      expect(r.status).toBe(200);
      expect(r.data.query).toBe(keyword);
      expect(r.data.hits.length).toBeGreaterThan(0);

      const hit = r.data.hits.find((h) => h.doc_id === result.id);
      expect(hit).toBeDefined();
      expect(hit?.source).toContain(MARKER);
      expect(hit?.text).toContain('增值税专用发票');
      // 至少被向量或关键词其中一路召回
      expect(hit?.sources.length).toBeGreaterThan(0);
      expect(hit?.score).toBeGreaterThan(0);
      expect(hit?.score).toBeLessThanOrEqual(1);
    });

    it('top_k 生效', async () => {
      const r = await http.acmeAdmin.post<SearchResponse>('/knowledge/search', {
        query: MARKER,
        top_k: 1,
      });
      expect(r.status).toBe(200);
      expect(r.data.hits.length).toBeLessThanOrEqual(1);
    });

    it('400 空检索词', async () => {
      const r = await http.acmeAdmin.post('/knowledge/search', { query: '   ' }, {
        validateStatus: () => true,
      });
      expect(r.status).toBe(400);
    });

    it('401 无 token', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/admin/knowledge/search`,
        { query: MARKER },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(401);
    });
  });

  describe('跨租户隔离', () => {
    it('acme 的文档不出现在 globex 的列表里', async () => {
      const result = await uploadAcme(`${MARKER} 仅属于 acme 的机密文档。`);
      const globList = await http.globAdmin.get<ListResponse>('/knowledge');
      expect(globList.data.documents.some((d) => d.id === result.id)).toBe(false);
    });

    it('globex 检索不到 acme 的文档', async () => {
      const keyword = `隔离探针${MARKER}`;
      const result = await uploadAcme(`${keyword}：这是 acme 租户独有的内容。`);
      const r = await http.globAdmin.post<SearchResponse>('/knowledge/search', {
        query: keyword,
        top_k: 10,
      });
      expect(r.data.hits.some((h) => h.doc_id === result.id)).toBe(false);
    });

    it('globex 拿 acme 的文档 id 直接查 → 404', async () => {
      const result = await uploadAcme(`${MARKER} 只属于 acme。`);
      const r = await http.globAdmin.get(`/knowledge?page=1&page_size=100`);
      const list = r.data as ListResponse;
      expect(list.documents.some((d) => d.id === result.id)).toBe(false);

      const reindex = await http.globAdmin.post(`/knowledge/${result.id}/reindex`, null, {
        validateStatus: () => true,
      });
      expect(reindex.status).toBe(404);

      const del = await http.globAdmin.delete(`/knowledge/${result.id}`, {
        validateStatus: () => true,
      });
      expect(del.status).toBe(404);
    });
  });

  describe('POST /knowledge/:id/reindex · 重新索引', () => {
    it('201 + 重新索引后仍是 ready 且块数一致', async () => {
      const result = await uploadAcme(`${MARKER} 重新索引测试文档。`);
      const r = await http.acmeAdmin.post<UploadResponse>(
        `/knowledge/${result.id}/reindex`,
        null,
        { timeout: 300_000 },
      );
      expect(r.status).toBe(201);
      expect(r.data.status).toBe('ready');
      // 同样的文本重新切一遍，块数必须一致（否则说明重试会累积旧块）
      expect(r.data.chunk_count).toBe(result.chunk_count);
    });

    it('404 文档不存在 / 跨租户', async () => {
      const r = await http.acmeAdmin.post('/knowledge/does-not-exist/reindex', null, {
        validateStatus: () => true,
      });
      expect(r.status).toBe(404);
    });
  });

  describe('DELETE /knowledge/:id · 删除', () => {
    it('204 + 删除后列表里没有了，且检索也不再命中', async () => {
      const keyword = `待删除探针${MARKER}`;
      const result = await uploadAcme(`${keyword}：这条待会儿要被删掉。`);
      const docId = result.id;

      const del = await http.acmeAdmin.delete(`/knowledge/${docId}`);
      expect(del.status).toBe(204);
      createdIds.splice(createdIds.indexOf(docId), 1);

      const list = await http.acmeAdmin.get<ListResponse>('/knowledge', {
        params: { keyword },
      });
      expect(list.data.documents.some((d) => d.id === docId)).toBe(false);

      const search = await http.acmeAdmin.post<SearchResponse>('/knowledge/search', {
        query: keyword,
        top_k: 10,
      });
      expect(search.data.hits.some((h) => h.doc_id === docId)).toBe(false);
    });

    it('404 删除不存在的文档', async () => {
      const r = await http.acmeAdmin.delete('/knowledge/does-not-exist', {
        validateStatus: () => true,
      });
      expect(r.status).toBe(404);
    });
  });
});