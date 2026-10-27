import { describe, it, expect } from 'vitest';
import { applyPreservedEdits, splitByChunk, splitByElements } from '../../src/rag/chunk';
import { buildElements } from '../../src/rag/elements';

/**
 * 拆块逻辑（src/rag/chunk.ts）—— 纯函数，不碰 DB / Qdrant
 *
 * 2026-10-27 改版：从「按字符滑窗 + 边界吸附」改成「结构感知」
 * （元素层 → 按标题分节 → 节内按元素聚合 → 超大元素按类型切）。
 * 下面标了「核心」的几条是这次改版要守住的不变量。
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

    // 下一块的开头 = 上一块结尾的一个**完整句子**（2026-10-27 改版后的语义：
    // 重叠区按元素/句子携带，不再按字符截断）
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1];
      const curr = chunks[i];
      if (prev === undefined || curr === undefined) continue;
      const carry = curr.text.split('\n\n')[0] ?? '';
      expect(prev.text.endsWith(carry)).toBe(true);
      // 携带的上下文是一句完整的话（不是半句）
      expect(carry.endsWith('。')).toBe(true);
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

  it('重叠区只带段落类元素，表格和代码不带（碎片没有意义）', () => {
    const table = ['| 方式 | 费用 |', '| --- | --- |', '| 顺丰 | 20 元 |', '| 普通 | 8 元 |'].join(
      '\n',
    );
    const code = ['const a = 1;', 'const b = 2;', 'const c = 3;'].join('\n');
    const doc = buildElements({
      text: `# 说明\n\n${table}\n\n\`\`\`ts\n${code}\n\`\`\`\n`,
      fileType: 'markdown',
    });
    const chunks = splitByElements(doc, { size: 60, overlap: 30 });

    // 表格 / 代码的碎片不会被带到别的块里
    for (const chunk of chunks) {
      const body = chunk.text.split('\n\n').slice(1).join('\n\n');
      if (body.includes('| 顺丰 |')) {
        // 带着表头才有意义
        expect(body).toContain('| 方式 | 费用 |');
      }
    }
  });
});

/**
 * 结构感知切块 —— 2026-10-27 改版的核心不变量
 */
describe('splitByElements · 结构感知', () => {
  const markdown = `# 员工手册

## 考勤制度

迟到 15 分钟以内扣 15 分钟。迟到超过 3 次本月不再计全勤。

## 报销制度

差旅报销需要在出差结束后 30 天内提交发票。超过 30 天不予受理。
`;

  it('核心 · 块不跨节：一节的内容不会被劈到另一节去', () => {
    const doc = buildElements({ text: markdown, fileType: 'markdown' });
    const chunks = splitByElements(doc, { size: 200, overlap: 30, root: ['员工手册.md'] });

    expect(chunks).toHaveLength(2);
    // 第 1 块只讲考勤，第 2 块只讲报销 —— 标题没有被劈开
    expect(chunks[0]?.text).toContain('考勤制度');
    expect(chunks[0]?.text).not.toContain('报销');
    expect(chunks[1]?.text).toContain('报销制度');
    expect(chunks[1]?.text).not.toContain('考勤');
  });

  it('核心 · 每块带标题路径面包屑', () => {
    const doc = buildElements({ text: markdown, fileType: 'markdown' });
    const chunks = splitByElements(doc, { size: 200, overlap: 30, root: ['员工手册.md'] });

    expect(chunks[0]?.headingPath).toEqual(['员工手册', '考勤制度']);
    expect(chunks[0]?.text.startsWith('员工手册.md > 员工手册 > 考勤制度')).toBe(true);
    expect(chunks[1]?.text.startsWith('员工手册.md > 员工手册 > 报销制度')).toBe(true);
  });

  it('核心 · 面包屑不超长（超了截掉最外层，留最具体的）', () => {
    const doc = buildElements({ text: markdown, fileType: 'markdown' });
    const chunks = splitByElements(doc, { size: 60, overlap: 10, root: ['x'.repeat(200)] });
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(60);
    }
  });

  it('核心 · 表格切片重复表头（后半截也得有列名）', () => {
    const table = [
      '| 方式 | 费用 | 时效 |',
      '| --- | --- | --- |',
      '| 顺丰 | 20 元 | 2 天 |',
      '| 普通 | 8 元 | 5 天 |',
      '| 邮政 | 5 元 | 7 天 |',
      '| 极兔 | 6 元 | 6 天 |',
    ].join('\n');
    const doc = buildElements({ text: `# 运费\n\n${table}\n`, fileType: 'markdown' });
    const chunks = splitByElements(doc, { size: 90, overlap: 10 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // 每一块都带表头
      expect(chunk.text).toContain('| 方式 | 费用 | 时效 |');
    }
  });

  it('核心 · 代码块按行切，不重复粘贴', () => {
    const code = [
      'const a = 1;',
      'const b = 2;',
      'const c = 3;',
      'const d = 4;',
      'const e = 5;',
      'const f = 6;',
      'const g = 7;',
    ].join('\n');
    const doc = buildElements({ text: `# 代码\n\n\`\`\`ts\n${code}\n\`\`\`\n`, fileType: 'markdown' });
    const chunks = splitByElements(doc, { size: 60, overlap: 10 });

    expect(chunks.length).toBeGreaterThan(1);
    // 每行只出现一次（代码不进重叠区）
    for (const line of code.split('\n')) {
      const occurrences = chunks.filter((c) => c.text.includes(line)).length;
      expect(occurrences).toBe(1);
    }
  });

  it('核心 · 超长段落按句切，不切半句', () => {
    const text = '这是一句话。'.repeat(200);
    const doc = buildElements({ text, fileType: 'txt' });
    const chunks = splitByElements(doc, { size: 200, overlap: 40 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      // 正文由完整句子拼成 → 去掉重叠区后每句都完整
      const body = chunk.text.split('\n\n').join('');
      expect(body.endsWith('。')).toBe(true);
    }
  });

  it('核心 · PDF 的页边界是硬边界（段落不跨页被切开）', () => {
    const page1 = '第一页有一段话。';
    const page2 = '第二页也有段话。';
    const doc = buildElements({
      text: `${page1}\n\n${page2}`,
      fileType: 'pdf',
      pageTexts: [page1, page2],
    });

    // 每页的段落是独立元素，并记住了自己属于第几页
    expect(doc.elements).toHaveLength(2);
    expect(doc.elements[0]?.page).toBe(1);
    expect(doc.elements[1]?.page).toBe(2);

    const chunks = splitByElements(doc, { size: 18, overlap: 6 });
    expect(chunks.length).toBeGreaterThan(1);
    // 第 1 页的内容不会被劈到第 2 页去
    expect(chunks[0]?.text).toContain('第一页');
    expect(chunks[0]?.text).not.toContain('第二页');
  });

  it('核心 · 只有标题没有正文的文档也能切出块（不会索引失败）', () => {
    const doc = buildElements({ text: '# 目录\n\n## 第一章\n\n## 第二章\n', fileType: 'markdown' });
    const chunks = splitByElements(doc, { size: 800, overlap: 150 });
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('核心 · 块长不超 size（含面包屑和重叠区）', () => {
    const doc = buildElements({ text: markdown, fileType: 'markdown' });
    for (const size of [40, 80, 200, 800]) {
      const chunks = splitByElements(doc, { size, overlap: 30, root: ['员工手册.md'] });
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(size);
      }
    }
  });
});

/**
 * 人工编辑在重新索引后的「搬家」逻辑（src/rag/chunk.ts · applyPreservedEdits）
 *
 * 重新索引 = 从磁盘原文件重新切一遍。人工编辑的块序号会漂移
 * （改了 CHUNK_SIZE、改了标题识别规则都会漂）——
 * 按序号对齐会把编辑搬到**完全不相干的一段文字**上，那比丢掉更糟。
 * 所以按**源区间重叠度**配对。
 */
describe('applyPreservedEdits', () => {
  const mk = (start: number, end: number, text: string) => ({
    index: 0,
    text,
    charStart: start,
    charEnd: end,
    headingPath: [],
    elementTypes: [] as never[],
    sectionChunkIndex: 1,
    sectionChunkTotal: 1,
  });

  it('源区间没变 → 编辑原样搬回去', () => {
    const chunks = [mk(0, 100, '新切的'), mk(100, 200, '新切的2')];
    const res = applyPreservedEdits(chunks, [
      { sourceCharStart: 0, sourceCharEnd: 100, text: '人工改过的' },
    ]);
    expect(res.chunks[0]?.text).toBe('人工改过的');
    expect(res.chunks[1]?.text).toBe('新切的2');
    expect(res.unmatched).toBe(0);
  });

  it('重叠不到一半 → 不搬（宁可不搬，也不要搬到不相干的地方）', () => {
    const chunks = [mk(0, 100, '新切的')];
    const res = applyPreservedEdits(chunks, [
      { sourceCharStart: 0, sourceCharEnd: 100, text: '人工改过的' },
    ]);
    // 完全重合 → 应该搬
    expect(res.chunks[0]?.text).toBe('人工改过的');

    const res2 = applyPreservedEdits([mk(0, 1000, '新切的')], [
      { sourceCharStart: 0, sourceCharEnd: 100, text: '人工改过的' },
    ]);
    // 旧块只占新块的 10% → 不搬
    expect(res2.chunks[0]?.text).toBe('新切的');
    expect(res2.unmatched).toBe(1);
  });

  it('一个编辑最多认领一个块（不会被搬到多处）', () => {
    const chunks = [mk(0, 100, 'A'), mk(100, 200, 'B')];
    const res = applyPreservedEdits(chunks, [
      { sourceCharStart: 0, sourceCharEnd: 200, text: '人工改过的' },
    ]);
    const hits = res.chunks.filter((c) => c.text === '人工改过的');
    expect(hits.length).toBe(1);
    expect(res.unmatched).toBe(0);
  });

  it('没有编辑 → 原样返回', () => {
    const chunks = [mk(0, 100, 'A')];
    const res = applyPreservedEdits(chunks, []);
    expect(res.chunks[0]?.text).toBe('A');
    expect(res.unmatched).toBe(0);
  });
});

/**
 * 表格 / 代码的重叠区与切片形态（2026-10-27 改）
 */
describe('表格与代码 · 重叠区和切片形态', () => {
  it('表格之后的块带「表头 + 尾部行」（不是一行没有列名的值）', () => {
    const md = [
      '| 订单 | 金额 |',
      '| --- | --- |',
      '| A | 1 |',
      '| B | 2 |',
      '',
      '上表说明了退款流程。',
    ].join('\n');
    const doc = buildElements({ text: md, fileType: 'markdown' });
    const chunks = splitByElements(doc, { size: 60, overlap: 40, root: ['x'] });
    expect(chunks.length).toBeGreaterThan(1);
    // 后面那块带着表头
    const last = chunks[chunks.length - 1];
    expect(last?.text).toContain('| 订单 | 金额 |');
  });

  it('代码被切成多片时，每片都是闭合的完整代码块（带语言标记）', () => {
    const code = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`).join('\n');
    const md = `# 代码\n\n\`\`\`ts\n${code}\n\`\`\`\n`;
    const doc = buildElements({ text: md, fileType: 'markdown' });
    const chunks = splitByElements(doc, { size: 200, overlap: 40, root: ['x'] });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      if (!chunk.text.includes('const v')) {
        continue;
      }
      // 围栏成对出现（不会出现开着的 ``` ）
      const fences = chunk.text.split('```').length - 1;
      expect(fences % 2).toBe(0);
      expect(chunk.text).toContain('```ts');
    }
  });
});

/**
 * 标题碎片的治理（src/rag/elements/plaintext.ts）
 *
 * 弱规则（独立成段 + 短）会把 PDF 里一组并列的短行全判成标题
 * → 每条各自成一节 → 每条各自成一个块 → 一篇文档碎成几十个一两行的块。
 */
describe('弱标题 · 连续降级', () => {
  it('连续多个弱标题 → 全部降级为正文（不碎成一堆块）', () => {
    const text = ['微信支付', '', '支付宝', '', '银行卡', '', '这是一段真正的正文内容，用来把这一节撑起来。'].join('\n');
    const doc = buildElements({ text, fileType: 'txt' });
    const headings = doc.elements.filter((el) => el.type === 'heading');
    expect(headings.length).toBe(0);
    expect(doc.elements.every((el) => el.type === 'paragraph')).toBe(true);
  });

  it('单个弱标题仍然算标题（不能一刀切全砍掉）', () => {
    const text = ['退款政策', '', '这是一段真正的正文内容，用来把这一节撑起来。'].join('\n');
    const doc = buildElements({ text, fileType: 'txt' });
    expect(doc.elements.filter((el) => el.type === 'heading')).toHaveLength(1);
  });

  it('强模式标题不受影响（第一章这种一眼就是标题）', () => {
    const text = ['第一章 概述', '', '这是一段真正的正文内容，用来把这一节撑起来。'].join('\n');
    const doc = buildElements({ text, fileType: 'txt' });
    const headings = doc.elements.filter((el) => el.type === 'heading');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.weak).toBeUndefined();
  });
});
