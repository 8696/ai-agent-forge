import { describe, it, expect } from 'vitest';
import { splitByChunk } from '../../src/rag/chunk';

/**
 * 拆块逻辑（src/rag/chunk.ts）—— 纯函数，不碰 DB / Qdrant
 */
describe('splitByChunk', () => {
  it('空白文档返回空数组', () => {
    expect(splitByChunk('')).toEqual([]);
    expect(splitByChunk('   \n\n\t  ')).toEqual([]);
  });

  it('短于一块的文档只切出 1 块，原文不丢', () => {
    const text = '这是一份很短的员工手册。';
    const chunks = splitByChunk(text, { size: 800, overlap: 150 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe(text);
    expect(chunks[0]?.index).toBe(0);
  });

  it('长文档切出多块，块序号连续', () => {
    const text = '员工手册。'.repeat(500); // 2500 字
    const chunks = splitByChunk(text, { size: 800, overlap: 150 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('每块长度不超过 size（边界吸附只会让块更短）', () => {
    const text = '句子。'.repeat(800);
    const chunks = splitByChunk(text, { size: 800, overlap: 150 });
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(800);
    }
  });

  it('相邻块之间有 overlap，跨块的句子不会丢上下文', () => {
    const text = '这是一段比较长的中文内容，用来验证重叠窗口是否生效。'.repeat(100);
    const size = 400;
    const overlap = 100;
    const chunks = splitByChunk(text, { size, overlap });
    expect(chunks.length).toBeGreaterThan(2);

    // 每块（除第一块）都应该从前一块的结尾处 overlap 个字符
    for (let i = 1; i < chunks.length; i += 1) {
      const prev = chunks[i - 1];
      const curr = chunks[i];
      if (prev === undefined || curr === undefined) continue;
      const tail = prev.text.slice(-overlap);
      expect(curr.text.startsWith(tail.slice(0, 20))).toBe(true);
    }
  });

  it('优先在段落边界断开，而不是硬切在句子中间', () => {
    const paragraphs = Array.from(
      { length: 12 },
      (_, i) => `第${i}段：${'内容。'.repeat(120)}`,
    );
    const text = paragraphs.join('\n\n');
    const chunks = splitByChunk(text, { size: 500, overlap: 50 });

    // 中间的块都应该收在句号或换行上，而不是从半个词开始；
    // 最后一块收在原文末尾，也是句号
    const lastChars = chunks.map((c) => c.text.slice(-1));
    expect(lastChars.every((ch) => '。\n'.includes(ch))).toBe(true);
  });

  it('归一化空白：统一换行符、折叠空行、去 BOM 影响', () => {
    const text = '第一行\r\n\r\n\r\n\r\n第二行   \n';
    const chunks = splitByChunk(text, { size: 800, overlap: 150 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toBe('第一行\n\n第二行');
  });

  it('全角空格转半角', () => {
    const chunks = splitByChunk('退款　政策', { size: 800, overlap: 150 });
    expect(chunks[0]?.text).toBe('退款 政策');
  });

  it('overlap >= size 时不会死循环', () => {
    const text = 'x'.repeat(2000);
    const chunks = splitByChunk(text, { size: 100, overlap: 500 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('size 非法时报错', () => {
    expect(() => splitByChunk('abc', { size: 0 })).toThrow();
  });
});