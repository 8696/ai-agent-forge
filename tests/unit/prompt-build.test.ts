import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_PROMPT_VERSION,
  renderSystemPrompt,
  NO_HITS_NOTICE,
  EMPTY_LIBRARY_NOTICE,
} from '../../shared/prompts/chat/system-default';
import { renderRagContext, CITATION_TEXT_LIMIT } from '../../shared/prompts/chat/rag-context';
import { buildPrompt, resolvePrompt } from '../../src/prompts';
import { estimateTokens } from '../../src/lib/token-estimate';

/**
 * 提示词组装（shared/prompts/chat/* + src/prompts/index.ts）—— 纯函数，不碰网络
 *
 * 锁住三条最容易悄悄坏掉的语义：
 *  1. **资料段编号 = 发给前端的 citations.index**，两边必须严格一致。
 *     改任一边的编号方式，AI 回答里的 [n] 和 UI 上的角标就对不上了 ——
 *     而且这个 bug 只在「模型真的引用了第 2 条」时才暴露，很容易漏到线上。
 *  2. 默认提示词不超 CHAT_SYSTEM_TOKEN_BUDGET（600），否则会被硬截断，
 *     截断掉的多半正好是末尾的「输出格式」约束，回答格式会悄悄变差
 *  3. 检索为空时走降级文案，且正文里不能出现 [1] 这种悬空编号
 */

const hit = (over: Partial<Parameters<typeof renderRagContext>[0][number]> = {}) => ({
  doc_id: 'doc-1',
  chunk_index: 0,
  source: '员工手册.md',
  text: '员工入职满 1 年不满 10 年的，年假 5 天。',
  score: 1,
  sources: ['vector', 'bm25'],
  ...over,
});

describe('renderRagContext · 资料段编号', () => {
  it('编号从 1 开始连续分配', () => {
    const { text, hits } = renderRagContext([hit(), hit({ doc_id: 'doc-2' }), hit({ doc_id: 'doc-3' })], 'x');
    expect(hits.map((h) => h.index)).toEqual([1, 2, 3]);
    expect(text).toContain('[1]');
    expect(text).toContain('[2]');
    expect(text).toContain('[3]');
    expect(text).not.toContain('[4]');
  });

  it('编号与正文里的 [n] 严格对应（前端角标靠这个对上）', () => {
    const { text, hits } = renderRagContext([hit({ source: 'A.md' }), hit({ source: 'B.md' })], 'x');
    for (const h of hits) {
      expect(text).toContain(`[${h.index}] 来源：${h.source}`);
    }
  });

  it('chunk_index 从 0-based 转成 1-based 展示', () => {
    const { text } = renderRagContext([hit({ chunk_index: 0 })], 'x');
    expect(text).toContain('第 1 段');
  });

  it('片段正文截断到 CITATION_TEXT_LIMIT', () => {
    const long = '长'.repeat(CITATION_TEXT_LIMIT + 200);
    const { hits } = renderRagContext([hit({ text: long })], 'x');
    expect(hits[0]?.text).toHaveLength(CITATION_TEXT_LIMIT);
  });

  it('score 保留 4 位小数', () => {
    const { hits } = renderRagContext([hit({ score: 0.123456789 })], 'x');
    expect(hits[0]?.score).toBe(0.1235);
  });

  it('命中为空时走降级文案，且不出现悬空编号', () => {
    const { text, hits } = renderRagContext([], NO_HITS_NOTICE);
    expect(hits).toEqual([]);
    expect(text).toContain(NO_HITS_NOTICE);
    expect(text).not.toContain('[1]');
  });

  it('知识库为空和没命中的措辞不同', () => {
    expect(NO_HITS_NOTICE).not.toBe(EMPTY_LIBRARY_NOTICE);
    expect(renderRagContext([], EMPTY_LIBRARY_NOTICE).text).toContain(EMPTY_LIBRARY_NOTICE);
  });
});

describe('renderSystemPrompt · 占位符替换', () => {
  it('把 {{tenantName}} 换成真实租户名', () => {
    expect(renderSystemPrompt(DEFAULT_SYSTEM_PROMPT, 'Acme Corp')).toContain('Acme Corp');
    expect(renderSystemPrompt(DEFAULT_SYSTEM_PROMPT, 'Acme Corp')).not.toContain('{{tenantName}}');
  });
});

describe('resolvePrompt · 内置默认提示词', () => {
  // ⚠️ 2026-10-25：resolvePrompt 不再读 tenants.settings（那个列没有写入路径，
  //    迁移 013 已经把租户配置搬进 tenant_settings KV 表）。
  //    「配置指向的版本号不存在 → 回落默认」这条现在由 prompt-registry 负责，
  //    并在那里 warn（见 src/services/prompt-registry.ts）。
  it('返回内置默认版本，并把 {{tenantName}} 换成租户名', () => {
    const r = resolvePrompt('Acme');
    expect(r.version).toBe(DEFAULT_PROMPT_VERSION);
    expect(r.text).toContain('Acme');
  });

  it('不接受租户级参数了（防止有人再把 tenants.settings 接回来）', () => {
    expect(resolvePrompt.length).toBe(1);
  });
});

describe('buildPrompt · 完整系统提示词', () => {
  it('基础提示词 + 资料段拼在一起', () => {
    const built = buildPrompt({
      tenantName: 'Acme',
      hits: [hit()],
      systemTokenBudget: 600,
    });
    expect(built.systemText).toContain('你是 Acme 的智能客服助手');
    expect(built.systemText).toContain('[1] 来源：员工手册.md');
    expect(built.rag.hits).toHaveLength(1);
  });

  it('检索故障时用故障措辞，让模型明说「没有使用参考资料」', () => {
    const built = buildPrompt({
      tenantName: 'Acme',
      hits: [],
      emptyNotice: '知识库检索暂时不可用，本次回答没有使用参考资料。',
      systemTokenBudget: 600,
    });
    expect(built.systemText).toContain('知识库检索暂时不可用');
    expect(built.rag.hits).toEqual([]);
  });

  it('默认提示词不超默认的 SYSTEM_TOKEN_BUDGET（否则会被硬截断）', () => {
    const built = buildPrompt({
      tenantName: 'Acme',
      hits: [],
      systemTokenBudget: 600,
    });
    expect(built.truncatedSystem).toBe(false);
    expect(estimateTokens(built.systemText)).toBeLessThanOrEqual(600);
  });

  it('预算给得极小时会硬截断并标记', () => {
    const built = buildPrompt({
      tenantName: 'Acme',
      hits: [],
      systemTokenBudget: 10,
    });
    expect(built.truncatedSystem).toBe(true);
  });
});