#!/usr/bin/env tsx
/**
 * Step 5 / B2 端到端验收（docs/16-b §B2 + docs/15 §Step 5）
 *
 * 用法：
 *   1) 起后端（yarn dev:backend）和 Qdrant（docker compose up -d qdrant）
 *   2) .env 配 EMBEDDING 端点（任何 OpenAI 兼容 provider；用 minimax/zhipu/qwen 任意之一）
 *   3) yarn tsx scripts/test-step5.ts
 *
 * 用例：
 *  1) seed 一个干净租户 + admin
 *  2) admin 登录拿 token
 *  3) 上传一个 .md（fixture 自带，含「年假 5 天」）
 *  4) POST /knowledge/test '年假几天' → 至少 1 条 hit 包含「年假」
 *  5) 至少 1 条 hit 的 sources 数组非空（融合生效）
 *  6) 跨租户：adminB token 检索时不出现 tenantA 文档
 *  7) DELETE /knowledge/:id → 检索不再命中
 *  8) audit_logs 写了 DOCUMENT_UPLOAD / DOCUMENT_DELETE
 *  9) BM25 关键字路径：纯 BM25 能命中（"工龄" "请假"）
 *
 * 注：Embedding/Qdrant 未配置时只跑 1-3 + 8；BM25 / hybrid 验证全部 skip
 */
import 'reflect-metadata';
import 'dotenv/config';
import axios, { type AxiosInstance } from 'axios';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { config, resolveEmbedding } from '../src/config';
import { getSequelize } from '../src/db';
import { SystemUser, Tenant, User, AuditLog } from '../src/models';
import { signToken } from '../src/lib/jwt';
import { hashPassword } from '../src/lib/password';
import { tokenize, bm25Search, bm25Add, _resetBm25ForTest } from '../src/rag/bm25';

const BASE = `http://localhost:${config.PORT}`;
let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass += 1;
    console.log(`✅ ${label} — ${detail}`);
  } else {
    fail += 1;
    console.log(`❌ ${label} — ${detail}`);
  }
}

function skip(label: string, reason: string): void {
  console.log(`⏭  ${label} — [跳过] ${reason}`);
}

function api(
  http: AxiosInstance,
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  return http
    .request({ method, url: p, data: body })
    .then((res) => ({ status: res.status, data: res.data }))
    .catch((e: unknown) => {
      const err = e as { response?: { status?: number; data?: unknown } };
      return { status: err.response?.status ?? 0, data: err.response?.data };
    });
}

const SAMPLE_MD = `# 年假制度

## 第一条：工龄计算
工龄 1-5 年的员工，每年享有 5 天年假。
工龄 6-10 年的员工，每年享有 10 天年假。
工龄 10 年以上的员工，每年享有 15 天年假。

## 第二条：申请流程
请在请假前 7 天通过 [申请系统] 提交申请，HR 会在 3 个工作日内审批。
`;

async function writeFixture(): Promise<{ tmpPath: string; originalName: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'step5-fixture-'));
  const tmpPath = path.join(tmpDir, '年假制度.md');
  await fs.writeFile(tmpPath, SAMPLE_MD, 'utf8');
  return { tmpPath, originalName: '年假制度.md' };
}

async function main(): Promise<void> {
  getSequelize();

  // ===== 准备：系统用户 + 2 个干净租户 =====
  const sysUser =
    (await SystemUser.findOne({ where: { email: 'platform-admin@local.test' } })) ??
    (await SystemUser.findOne({ where: { email: 'saas-admin@local.test' } }));
  if (sysUser === null) {
    console.error('❌ 系统用户不存在，先跑 yarn tsx scripts/seed-system-admin.ts');
    process.exit(1);
  }
  void signToken({ sub: sysUser.id, role: 'system' });

  const codeA = `step5-a-${Date.now()}`;
  const codeB = `step5-b-${Date.now()}`;
  await Tenant.destroy({ where: { code: { [Symbol.for('like')]: 'step5-%' } } });

  const tenantA = await Tenant.create({ code: codeA, name: 'Step5 Tenant A' });
  const tenantB = await Tenant.create({ code: codeB, name: 'Step5 Tenant B' });
  const adminAEmail = `step5-a-${Date.now()}@step5.test`;
  const adminAPwd = 'Step5Pwd-123';
  await User.create({
    tenant_id: tenantA.id,
    email: adminAEmail,
    password_hash: await hashPassword(adminAPwd),
    role: 'admin',
    must_change_password: false,
  });
  const adminBEmail = `step5-b-${Date.now()}@step5.test`;
  const adminBPwd = 'Step5Pwd-456';
  await User.create({
    tenant_id: tenantB.id,
    email: adminBEmail,
    password_hash: await hashPassword(adminBPwd),
    role: 'admin',
    must_change_password: false,
  });
  console.log(`\n=== seed: tenantA=${codeA}, tenantB=${codeB} ===\n`);

  // ===== 用例 2：登录拿 token =====
  const loginA = await axios.post(`${BASE}/api/v1/admin/login`, {
    email: adminAEmail,
    password: adminAPwd,
    tenant_code: codeA,
  });
  check(
    'admin/tenantA 登录成功',
    loginA.status === 200 && typeof loginA.data.token === 'string',
    `status=${loginA.status}`,
  );
  const adminAToken: string = loginA.data.token;
  const loginB = await axios.post(`${BASE}/api/v1/admin/login`, {
    email: adminBEmail,
    password: adminBPwd,
    tenant_code: codeB,
  });
  const adminBToken: string = loginB.data.token;

  const adminAHttp = axios.create({
    baseURL: `${BASE}/api/v1/admin`,
    headers: { Authorization: `Bearer ${adminAToken}` },
    maxContentLength: 64 * 1024 * 1024,
    maxBodyLength: 64 * 1024 * 1024,
  });

  // ===== 单元检查：tokenize 本身（jieba 切词）=====
  const tok1 = tokenize('年假 5 天');
  check(
    'tokenize 包含 jieba 切词单元 "年假" / "5" / "天"',
    ['年假', '5', '天'].every((t) => tok1.includes(t)),
    `tokens=${tok1.join('|')}`,
  );
  check(
    'tokenize 包含跨词 bigram "年假5" 或 "5天"',
    tok1.includes('年假5') || tok1.includes('5天'),
    `tokens=${tok1.join('|')}`,
  );
  const tok2 = tokenize('请在请假前 7 天');
  check(
    'tokenize 对长句切出多个 jieba 词（"请假" 作为语义单元）',
    tok2.includes('请假') && tok2.length >= 4,
    `tokens=${tok2.join('|')}`,
  );

  // ===== 单元检查：BM25 命中（不依赖 Qdrant / Embedding）=====
  _resetBm25ForTest();
  bm25Add({
    tenantId: tenantA.id,
    docId: 'doc1',
    source: '年假制度',
    chunks: [
      { index: 0, text: '工龄 1-5 年的员工，每年享有 5 天年假。', source: '年假制度' },
      { index: 1, text: '请在请假前 7 天通过申请系统提交申请，HR 会在 3 个工作日内审批。', source: '年假制度' },
    ],
  });
  const bm25Only = await bm25Search({ query: '年假几天', tenantId: tenantA.id, topK: 5 });
  check(
    'BM25 直接调：query "年假几天" 命中含「年假」的 chunk',
    bm25Only.length > 0 && bm25Only[0]?.chunk_index === 0 && bm25Only[0]?.text.includes('年假'),
    `topScore=${bm25Only[0]?.score.toFixed(4) ?? '?'}`,
  );
  const bm25Leave = await bm25Search({ query: '请假流程', tenantId: tenantA.id, topK: 5 });
  check(
    'BM25 直接调：query "请假流程" 命中第二条',
    bm25Leave.length > 0 && bm25Leave[0]?.chunk_index === 1,
    `topScore=${bm25Leave[0]?.score.toFixed(4) ?? '?'}`,
  );
  // 跨租户：tenantB 用同样的 BM25 索引隔离（不重置 → 不该看到 tenantA 的）
  const bm25Cross = await bm25Search({ query: '年假几天', tenantId: tenantB.id, topK: 5 });
  check(
    'BM25 跨租户：tenantB 检索不命中 tenantA 的 BM25 索引',
    bm25Cross.length === 0,
    `hits=${bm25Cross.length}`,
  );
  _resetBm25ForTest();

  // ===== 用例 3：上传 .md =====
  const fixture = await writeFixture();
  const fileBuf = await fs.readFile(fixture.tmpPath);
  const form = new FormData();
  form.append('file', new Blob([fileBuf]), fixture.originalName);

  const hasEmbed = ((): boolean => {
    try {
      const cfg = resolveEmbedding();
      return cfg.embedBaseUrl !== '' && cfg.embedApiKey !== '' && cfg.embedModel !== '';
    } catch {
      return false;
    }
  })();
  const indexReady = hasEmbed && config.QDRANT_URL !== '';

  let uploadRes;
  try {
    uploadRes = await adminAHttp.post('/knowledge/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
    });
  } catch (e: unknown) {
    const err = e as { response?: { status?: number; data?: unknown } };
    uploadRes = {
      status: err.response?.status ?? 0,
      data: err.response?.data ?? { code: 'UNKNOWN', message: 'no response' },
    } as typeof uploadRes;
  }
  if (uploadRes === undefined) {
    throw new Error('uploadRes undefined (logic bug)');
  }
  const uploadBody = uploadRes.data as { id: string; status: string; chunk_count: number };
  if (!indexReady) {
    skip(
      'POST /knowledge/upload 端到端索引（hybridSearch 4-7 用例）',
      `EMBEDDING=${hasEmbed ? 'ok' : '缺'} QDRANT_URL=${config.QDRANT_URL === '' ? '缺' : 'ok'}`,
    );
  } else {
    check(
      'POST /knowledge/upload 同步完成（status=ready）',
      uploadRes.status === 201 && uploadBody.status === 'ready',
      `status=${uploadBody.status} chunk_count=${uploadBody.chunk_count}`,
    );

    // ===== 用例 4：hybridSearch 命中（query="年假几天"）=====
    const search = await api(adminAHttp, 'POST', '/knowledge/test', {
      query: '年假几天',
      top_k: 5,
    });
    const searchBody = search.data as {
      hits: Array<{ doc_id: string; text: string; sources: string[] }>;
    };
    check(
      'POST /knowledge/test 返回 200 + hits 数组',
      search.status === 200 && Array.isArray(searchBody.hits),
      `status=${search.status} hits=${searchBody.hits?.length ?? '?'}`,
    );
    check(
      'hybridSearch 命中上传的文档（doc_id 对得上）',
      searchBody.hits.some((h) => h.doc_id === uploadBody.id),
      `hits=${searchBody.hits.length}`,
    );
    const hasNianJia = searchBody.hits.some((h) => h.text.includes('年假'));
    check(
      'hybridSearch 至少 1 条 hit text 含「年假」',
      hasNianJia,
      `hits=${searchBody.hits.length}`,
    );

    // ===== 用例 5：sources 字段非空（融合生效）=====
    const hasSource = searchBody.hits.some((h) => h.sources.length > 0);
    check(
      'hybridSearch 至少 1 条 hit sources 非空（说明两路召回都被调过）',
      hasSource,
      `sources=[${searchBody.hits.map((h) => `[${h.sources.join(',')}]`).join(' ')}]`,
    );
    // 至少 1 条既被 vector 命中也被 bm25 命中（'年假' 是文档里的关键词，BM25 应该命中）
    const dual = searchBody.hits.filter(
      (h) => h.sources.includes('vector') && h.sources.includes('bm25'),
    );
    check(
      'hybridSearch 至少 1 条 hit 两路都命中（双源融合）',
      dual.length > 0,
      `dual=${dual.length}`,
    );

    // ===== 用例 6：跨租户 =====
    const adminBHttp = axios.create({
      baseURL: `${BASE}/api/v1/admin`,
      headers: { Authorization: `Bearer ${adminBToken}` },
    });
    const bSearch = await api(adminBHttp, 'POST', '/knowledge/test', {
      query: '年假几天',
      top_k: 5,
    });
    const bHits = (bSearch.data as { hits: Array<{ doc_id: string }> }).hits;
    const leak = bHits.some((h) => h.doc_id === uploadBody.id);
    check(
      '跨租户：adminB token 检索时不出现 tenantA 文档',
      bSearch.status === 200 && !leak,
      `b_hits=${bHits.length} leaked=${leak}`,
    );
  }

  // ===== 用例 7：删除 + 检索不再命中 =====
  const del = await api(adminAHttp, 'DELETE', `/knowledge/${uploadBody.id}`);
  check('DELETE /knowledge/:id → 204', del.status === 204, `status=${del.status}`);

  if (indexReady) {
    const afterDel = await api(adminAHttp, 'POST', '/knowledge/test', {
      query: '年假几天',
      top_k: 5,
    });
    const afterHits = (afterDel.data as { hits: Array<{ doc_id: string }> }).hits;
    const stillThere = afterHits.some((h) => h.doc_id === uploadBody.id);
    check(
      'DELETE 后 hybridSearch 不再命中已删 doc',
      !stillThere,
      `hits=${afterHits.length} still=${stillThere}`,
    );
  }

  // ===== 用例 8：audit_logs =====
  const auditRows = await AuditLog.findAll({
    where: { resource_id: uploadBody.id },
    order: [['created_at', 'ASC']],
  });
  const actions = auditRows.map((r) => r.action);
  check(
    'audit_logs 写了 DOCUMENT_UPLOAD',
    actions.includes('DOCUMENT_UPLOAD'),
    `actions=${actions.join(',')}`,
  );
  check(
    'audit_logs 写了 DOCUMENT_DELETE',
    actions.includes('DOCUMENT_DELETE'),
    `actions=${actions.join(',')}`,
  );

  // ===== 清理 =====
  await Tenant.destroy({ where: { id: [tenantA.id, tenantB.id] } });
  await fs.rm(path.dirname(fixture.tmpPath), { recursive: true, force: true }).catch(() => {});

  console.log(`\n=== Step 5 / B2 验收：${pass} 通过 / ${fail} 失败 ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error('脚本异常：', e);
  process.exit(1);
});
