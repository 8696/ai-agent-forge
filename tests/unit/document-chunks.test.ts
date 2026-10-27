import { describe, it, expect } from 'vitest';
import {
  mergeChunkTexts,
  splitBreadcrumb,
  splitChunkText,
} from '../../src/services/document-chunks';

/**
 * 切片编辑的**纯逻辑**（不碰 DB / Qdrant / embedding —— 零成本）
 *
 * 对应 src/services/document-chunks.ts
 *
 * ⚠️ 这几个函数是「人工编辑」能不能用的关键：
 *   - 拆分位置算错 → 拆出来的块从半句话开始
 *   - 面包屑处理错 → 拆出来的第二块没有章节上下文（向量里跟裸正文没区别）
 */

const SEP = '\n\n';

describe('splitBreadcrumb', () => {
  it('拆出「面包屑 + 正文」', () => {
    const { breadcrumb, content } = splitBreadcrumb(`产品手册 > 退款政策${SEP}正文内容`);
    expect(breadcrumb).toBe('产品手册 > 退款政策');
    expect(content).toBe('正文内容');
  });

  it('没有分隔符时全部当正文', () => {
    const { breadcrumb, content } = splitBreadcrumb('只有正文');
    expect(breadcrumb).toBe('');
    expect(content).toBe('只有正文');
  });
});

describe('splitChunkText', () => {
  it('在指定位置拆成两块，两块都带同样的面包屑', () => {
    const text = `手册 > 退款${SEP}第一句。第二句。`;
    const { left, right } = splitChunkText(text, `手册 > 退款${SEP}第一句。`.length);

    expect(left).toBe(`手册 > 退款${SEP}第一句。`);
    // ⚠️ 第二块也带面包屑 —— 否则它的向量里没有「自己在哪一节」的信息
    expect(right).toBe(`手册 > 退款${SEP}第二句。`);
  });

  it('拆分位置落在空白处 → 抛错（拆出来的块必须有正文）', () => {
    const text = `手册${SEP}   `;
    expect(() => splitChunkText(text, text.length)).toThrow(/正文/);
  });

  it('位置超出范围 → 没有可拆的部分，抛错', () => {
    const text = `手册${SEP}甲乙丙`;
    expect(() => splitChunkText(text, 9999)).toThrow(/正文/);
  });
});

describe('mergeChunkTexts', () => {
  it('合并后只保留第一块的面包屑（后面那块的是重复的）', () => {
    const merged = mergeChunkTexts([
      `手册 > 退款${SEP}第一块。`,
      `手册 > 退款${SEP}第二块。`,
    ]);
    expect(merged).toBe(`手册 > 退款${SEP}第一块。${SEP}第二块。`);
    expect(merged.split(SEP)[0]).toBe('手册 > 退款');
  });

  it('合并没有面包屑的块', () => {
    expect(mergeChunkTexts(['甲', '乙'])).toBe(`甲${SEP}乙`);
  });

  it('全是空正文 → 抛错', () => {
    expect(() => mergeChunkTexts(['', '  '])).toThrow(/正文/);
  });
});
