import { describe, it, expect } from 'vitest';
import { buildElements } from '../../src/rag/elements';
import { buildMarkdownElements } from '../../src/rag/elements/markdown';
import { buildPdfElements, buildPlainElements } from '../../src/rag/elements/plaintext';

/**
 * 元素层（src/rag/elements/）—— 切块前的结构解析
 *
 * 这是 2026-10-27 改版新增的一层：先把文档解析成带类型的元素序列，
 * 再交给切块器。元素层保不住结构的话，切块器再聪明也没用。
 */
describe('buildMarkdownElements', () => {
  it('标题层级路径逐级累积', () => {
    const doc = buildMarkdownElements(
      ['# 产品手册', '', '## 退款政策', '', '正文一。', '', '### 特殊情况', '', '正文二。'].join('\n'),
    );

    const headings = doc.elements.filter((el) => el.type === 'heading');
    expect(headings.map((el) => el.headingPath)).toEqual([
      ['产品手册'],
      ['产品手册', '退款政策'],
      ['产品手册', '退款政策', '特殊情况'],
    ]);
    expect(headings.map((el) => el.level)).toEqual([1, 2, 3]);
    // 正文挂在对应标题下
    expect(doc.elements.find((el) => el.text === '正文一。')?.headingPath).toEqual([
      '产品手册',
      '退款政策',
    ]);
    expect(doc.elements.find((el) => el.text === '正文二。')?.headingPath).toEqual([
      '产品手册',
      '退款政策',
      '特殊情况',
    ]);
  });

  it('同级新标题会覆盖同级旧标题的层级', () => {
    const doc = buildMarkdownElements(
      ['# 手册', '', '## 甲', '', '## 乙', '', '### 丙', '', '## 丁'].join('\n'),
    );
    const paths = doc.elements.filter((el) => el.type === 'heading').map((el) => el.headingPath);
    expect(paths).toEqual([
      ['手册'],
      ['手册', '甲'],
      ['手册', '乙'],
      ['手册', '乙', '丙'],
      ['手册', '丁'],
    ]);
  });

  it('Setext 标题（=== 下划线形式）也能认 —— 正则认不出，AST 能', () => {
    const doc = buildMarkdownElements(['产品手册', '========', '', '正文。'].join('\n'));
    expect(doc.elements[0]?.type).toBe('heading');
    expect(doc.elements[0]?.text).toBe('产品手册');
  });

  it('列表项各自独立成元素（超长列表能按项拆）', () => {
    const doc = buildMarkdownElements(['# 列表', '', '- 条目一', '- 条目二', '- 条目三'].join('\n'));
    const items = doc.elements.filter((el) => el.type === 'list');
    expect(items.map((el) => el.text)).toEqual(['条目一', '条目二', '条目三']);
  });

  it('代码块保留原文 + 围栏 + 语言标记（剥了就没法跟 JSON 区分了）', () => {
    const doc = buildMarkdownElements(['# 代码', '', '```ts', 'const a = **1**;', '```'].join('\n'));
    const code = doc.elements.find((el) => el.type === 'code');
    expect(code?.text).toBe('```ts\nconst a = **1**;\n```');
  });

  it('没有语言标记的代码块也保留围栏', () => {
    const doc = buildMarkdownElements(['# 代码', '', '```', 'plain', '```'].join('\n'));
    const code = doc.elements.find((el) => el.type === 'code');
    expect(code?.text).toBe('```\nplain\n```');
  });

  it('表格渲染成管道表（保留表头和分隔行）', () => {
    const doc = buildMarkdownElements(
      ['# 表', '', '| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n'),
    );
    const table = doc.elements.find((el) => el.type === 'table');
    expect(table?.text).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });

  it('正文剥掉 markdown 标记（星号 / 链接语法不进向量）', () => {
    const doc = buildMarkdownElements('这是**粗体**和[链接](https://example.com)。');
    expect(doc.elements[0]?.text).toBe('这是粗体和链接。');
  });

  it('空文档返回空元素数组', () => {
    expect(buildMarkdownElements('').elements).toEqual([]);
    expect(buildMarkdownElements('   \n\n  ').elements).toEqual([]);
  });
});

describe('buildPlainElements（TXT / PDF 的兜底结构）', () => {
  it('按空行切段落', () => {
    const doc = buildPlainElements('第一段。\n\n第二段。\n\n第三段。');
    expect(doc.elements.map((el) => el.text)).toEqual(['第一段。', '第二段。', '第三段。']);
    expect(doc.elements.every((el) => el.type === 'paragraph')).toBe(true);
  });

  it('强标题模式能认出来（第一章 / 一、 / （一））', () => {
    const doc = buildPlainElements(
      ['第一章 概述', '', '正文一。', '', '一、适用范围', '', '正文二。'].join('\n'),
    );
    const headings = doc.elements.filter((el) => el.type === 'heading');
    expect(headings.map((el) => el.text)).toEqual(['第一章 概述', '一、适用范围']);
    // 层级：第一章 = 2 级，一、 = 2 级
    expect(headings[0]?.headingPath).toEqual(['第一章 概述']);
  });

  it('列表项不会被误判成标题', () => {
    const doc = buildPlainElements('1. 商品七天内无理由\n\n2. 商品存在质量问题');
    expect(doc.elements.every((el) => el.type === 'paragraph')).toBe(true);
  });

  it('以句读结尾的短行不会被误判成标题', () => {
    const doc = buildPlainElements('好的。\n\n这个也短。');
    expect(doc.elements.every((el) => el.type === 'paragraph')).toBe(true);
  });

  it('独立成段的短行按弱规则判成标题', () => {
    const doc = buildPlainElements('考勤制度\n\n迟到要扣钱。');
    expect(doc.elements[0]?.type).toBe('heading');
    expect(doc.elements[0]?.text).toBe('考勤制度');
  });
});

describe('buildPdfElements', () => {
  it('页边界是元素边界，每页的段落不混在一起', () => {
    const doc = buildPdfElements(['第一页甲。\n\n第一页乙。', '第二页丙。']);
    expect(doc.elements.map((el) => el.text)).toEqual(['第一页甲。', '第一页乙。', '第二页丙。']);
    expect(doc.elements.map((el) => el.page)).toEqual([1, 1, 2]);
  });

  it('标题栈跨页延续（第 1 页的标题，第 2 页的内容仍属于同一节）', () => {
    const doc = buildPdfElements(['第一章 概述', '本章内容在第二页。']);
    const paragraph = doc.elements.find((el) => el.type === 'paragraph');
    expect(paragraph?.headingPath).toEqual(['第一章 概述']);
  });

  it('归一化后全文与各页拼接一致（偏移量对得上）', () => {
    const doc = buildPdfElements(['甲页。', '乙页。']);
    expect(doc.text).toBe('甲页。\n\n乙页。');
    const second = doc.elements[1];
    expect(doc.text.slice(second?.charStart, second?.charEnd)).toBe('乙页。');
  });
});

describe('buildElements（按文件类型分发）', () => {
  it('markdown 走 AST', () => {
    const doc = buildElements({ text: '# 标题\n\n正文。', fileType: 'markdown' });
    expect(doc.elements[0]?.type).toBe('heading');
  });

  it('txt 走纯文本', () => {
    const doc = buildElements({ text: '第一段。\n\n第二段。', fileType: 'txt' });
    expect(doc.elements).toHaveLength(2);
  });

  it('pdf 走分页', () => {
    const doc = buildElements({
      text: '甲页。\n\n乙页。',
      fileType: 'pdf',
      pageTexts: ['甲页。', '乙页。'],
    });
    expect(doc.elements.map((el) => el.page)).toEqual([1, 2]);
  });

  it('pdf 缺分页信息时退回单页纯文本（不炸）', () => {
    const doc = buildElements({ text: '甲页。\n\n乙页。', fileType: 'pdf' });
    expect(doc.elements.length).toBeGreaterThan(0);
  });
});
