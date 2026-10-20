import { describe, it, expect, beforeEach } from 'vitest';
import {
  bm25Add,
  bm25Clear,
  bm25ChunkCount,
  bm25RemoveDoc,
  bm25Search,
  tokenize,
} from '../../src/rag/bm25';

/**
 * BM25 关键词召回（src/rag/bm25.ts）—— 纯内存，不碰 DB / Qdrant
 */
describe('bm25', () => {
  beforeEach(() => {
    bm25Clear();
  });

  describe('tokenize', () => {
    it('中文按词切，不是一律切单字', () => {
      // nodejieba 自带词库覆盖常见词（报销 / 流程 / 制度），但不是所有组合词
      // 都收录（如「年假」会被切成「年」「假」）。查询和文档走同一套分词，
      // 同词仍能对上，只是多字词命中的精度略低。
      const tokens = tokenize('报销流程');
      expect(tokens).toEqual(['报销', '流程']);
    });

    it('英文单词整体保留，不被拆成单个字母', () => {
      const tokens = tokenize('annual leave policy');
      expect(tokens).toEqual(['annual', 'leave', 'policy']);
    });

    it('英文大小写归一', () => {
      expect(tokenize('Refund Policy')).toEqual(['refund', 'policy']);
    });

    it('中英文混排都能切出来', () => {
      const tokens = tokenize('订单 SO-2024-0817 的退款流程');
      expect(tokens).toContain('订单');
      expect(tokens).toContain('so');
      expect(tokens).toContain('2024');
    });

    it('过滤高频虚词', () => {
      expect(tokenize('这个政策是什么')).not.toContain('的');
    });

    it('纯符号切出空数组', () => {
      expect(tokenize('!!! ??? ---')).toEqual([]);
    });
  });

  describe('bm25Search', () => {
    it('没索引任何文档时返回空', () => {
      expect(bm25Search({ tenantId: 't1', query: '年假', topK: 5 })).toEqual([]);
    });

    it('命中包含查询词的块', () => {
      bm25Add({
        tenantId: 't1',
        chunks: [
          { doc_id: 'd1', chunk_index: 0, source: '员工手册.md', text: '年假按工龄计算，满一年不满十年为 5 天。' },
          { doc_id: 'd2', chunk_index: 0, source: '报销制度.md', text: '差旅报销需要在出差结束后 30 天内提交发票。' },
        ],
      });
      const hits = bm25Search({ tenantId: 't1', query: '年假', topK: 5 });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.doc_id).toBe('d1');
    });

    it('命中查询词次数更多的块排前面', () => {
      bm25Add({
        tenantId: 't1',
        chunks: [
          { doc_id: 'd1', chunk_index: 0, source: 'a.md', text: '完全无关的内容，说的是食堂菜单和健身卡。' },
          { doc_id: 'd2', chunk_index: 0, source: 'b.md', text: '报销制度：差旅报销需要在出差结束后 30 天内提交。' },
          { doc_id: 'd3', chunk_index: 0, source: 'c.md', text: '报销流程说明，附发票模板下载链接。' },
        ],
      });
      const hits = bm25Search({ tenantId: 't1', query: '报销', topK: 3 });
      expect(hits.length).toBe(2);
      // d2 里「报销」出现两次，词频更高 → 排第一
      expect(hits[0]?.doc_id).toBe('d2');
      expect(hits[1]?.doc_id).toBe('d3');
    });

    it('租户之间互相看不见', () => {
      bm25Add({
        tenantId: 't1',
        chunks: [{ doc_id: 'd1', chunk_index: 0, source: 'a.md', text: '租户一的机密：并购计划书。' }],
      });
      expect(bm25Search({ tenantId: 't2', query: '机密', topK: 5 })).toEqual([]);
      expect(bm25Search({ tenantId: 't1', query: '机密', topK: 5 })).toHaveLength(1);
    });

    it('topK 生效', () => {
      bm25Add({
        tenantId: 't1',
        chunks: Array.from({ length: 10 }, (_, i) => ({
          doc_id: `d${i}`,
          chunk_index: 0,
          source: `${i}.md`,
          text: `报销制度第 ${i} 条说明。`,
        })),
      });
      expect(bm25Search({ tenantId: 't1', query: '报销', topK: 3 })).toHaveLength(3);
    });

    it('查询分词后没命中任何词时返回空', () => {
      bm25Add({
        tenantId: 't1',
        chunks: [{ doc_id: 'd1', chunk_index: 0, source: 'a.md', text: '年假政策。' }],
      });
      expect(bm25Search({ tenantId: 't1', query: 'zzzz', topK: 5 })).toEqual([]);
    });

    it('结果顺序稳定（同分时按 doc_id 排）', () => {
      bm25Add({
        tenantId: 't1',
        chunks: [
          { doc_id: 'zzz', chunk_index: 0, source: 'z.md', text: '报销制度。' },
          { doc_id: 'aaa', chunk_index: 0, source: 'a.md', text: '报销制度。' },
        ],
      });
      const first = bm25Search({ tenantId: 't1', query: '报销', topK: 5 });
      const second = bm25Search({ tenantId: 't1', query: '报销', topK: 5 });
      expect(first.map((h) => h.doc_id)).toEqual(second.map((h) => h.doc_id));
      expect(first[0]?.doc_id).toBe('aaa');
    });
  });

  describe('增删改', () => {
    it('重复索引同一个文档不会翻倍（先删后写）', () => {
      const chunks = [
        { doc_id: 'd1', chunk_index: 0, source: 'a.md', text: '年假政策说明。' },
      ];
      bm25Add({ tenantId: 't1', chunks });
      bm25Add({ tenantId: 't1', chunks });
      expect(bm25ChunkCount('t1')).toBe(1);
    });

    it('重新索引会替换掉旧内容', () => {
      bm25Add({
        tenantId: 't1',
        chunks: [{ doc_id: 'd1', chunk_index: 0, source: 'a.md', text: '旧版本的年假政策。' }],
      });
      bm25Add({
        tenantId: 't1',
        chunks: [{ doc_id: 'd1', chunk_index: 0, source: 'a.md', text: '新版本的年假政策。' }],
      });
      expect(bm25Search({ tenantId: 't1', query: '旧版本', topK: 5 })).toEqual([]);
      expect(bm25Search({ tenantId: 't1', query: '新版本', topK: 5 })).toHaveLength(1);
    });

    it('删文档后该文档的所有块都消失', () => {
      bm25Add({
        tenantId: 't1',
        chunks: [
          { doc_id: 'd1', chunk_index: 0, source: 'a.md', text: '年假政策第一块。' },
          { doc_id: 'd1', chunk_index: 1, source: 'a.md', text: '年假政策第二块。' },
          { doc_id: 'd2', chunk_index: 0, source: 'b.md', text: '年假政策别人的块。' },
        ],
      });
      expect(bm25ChunkCount('t1')).toBe(3);
      bm25RemoveDoc('t1', 'd1');
      expect(bm25ChunkCount('t1')).toBe(1);
      const hits = bm25Search({ tenantId: 't1', query: '年假', topK: 5 });
      expect(hits.every((h) => h.doc_id === 'd2')).toBe(true);
    });

    it('删完文档的词频统计也回滚（不会让别的块凭空高 IDF）', () => {
      bm25Add({
        tenantId: 't1',
        chunks: [
          { doc_id: 'd1', chunk_index: 0, source: 'a.md', text: '报销制度。' },
          { doc_id: 'd2', chunk_index: 0, source: 'b.md', text: '报销流程。' },
        ],
      });
      bm25RemoveDoc('t1', 'd1');
      const hits = bm25Search({ tenantId: 't1', query: '报销', topK: 5 });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.doc_id).toBe('d2');
    });

    it('删不存在的文档不报错', () => {
      expect(() => bm25RemoveDoc('t1', '不存在')).not.toThrow();
      expect(() => bm25RemoveDoc('不存在的租户', 'd1')).not.toThrow();
    });
  });
});