import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../../web/components/Markdown';

/**
 * Markdown 组件 —— docs/04-b §4.9 特殊元素
 *
 * 规格要求（以前全靠肉眼看，模型不一定肯吐代码块，测不了）：
 *  - **代码块用 highlight.js 高亮 + 右上角复制按钮**
 *  - **引用块**：左侧蓝色边 + 浅灰背景
 *  - **链接**：自动识别 + 新窗口打开
 *  - **表格** → HTML 表格（remark-gfm）
 *
 * 用 `renderToStaticMarkup` 服务端渲染断言 —— 不依赖浏览器，
 * 也不依赖「模型这次恰好吐了个代码块」。
 */
describe('Markdown 组件 · 04-b §4.9', () => {
  it('围栏代码块 → <pre> + highlight.js 高亮类 + 复制按钮', () => {
    const html = renderToStaticMarkup(
      <Markdown>{'```js\nconst a = 1;\n```'}</Markdown>,
    );
    expect(html).toContain('<pre');
    expect(html).toContain('class="hljs"');
    // 高亮后的产物带 span（highlight.js 给关键字加了 <span class="hljs-keyword">）
    expect(html).toContain('hljs-keyword');
    // 右上角复制按钮
    expect(html).toContain('aria-label="复制代码"');
    // 代码原文不能被吞掉
    expect(html).toContain('const');
  });

  it('代码块的语言标签显示在标题条上', () => {
    const html = renderToStaticMarkup(<Markdown>{'```python\nprint(1)\n```'}</Markdown>);
    expect(html).toContain('python');
  });

  it('没有语言标记的代码块也能高亮（自动识别）', () => {
    const html = renderToStaticMarkup(<Markdown>{'```\nplain text\n```'}</Markdown>);
    expect(html).toContain('class="hljs"');
    expect(html).toContain('text');
  });

  it('引用块 → <blockquote> + 左侧蓝色边 + 浅灰背景', () => {
    const html = renderToStaticMarkup(<Markdown>{'> 这是引用的一段话'}</Markdown>);
    expect(html).toContain('<blockquote');
    expect(html).toContain('border-left');
    expect(html).toContain('background');
  });

  it('链接 → 新窗口打开 + 加 rel=noopener', () => {
    const html = renderToStaticMarkup(<Markdown>{'看这个 [链接](https://example.com)'}</Markdown>);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('href="https://example.com"');
  });

  it('表格 → HTML 表格（remark-gfm）', () => {
    const html = renderToStaticMarkup(
      <Markdown>{'| 姓名 | 年假 |\n| --- | --- |\n| 小林 | 5 天 |'}</Markdown>,
    );
    expect(html).toContain('<table');
    expect(html).toContain('<th');
    expect(html).toContain('小林');
  });

  it('行内代码不会被当成代码块（不产生 <pre>）', () => {
    const html = renderToStaticMarkup(<Markdown>{'用 `npm install` 安装'}</Markdown>);
    expect(html).not.toContain('<pre');
    expect(html).toContain('<code');
  });

  it('原始 HTML 不会被执行（转义成文本）', () => {
    const html = renderToStaticMarkup(<Markdown>{'<script>alert(1)</script>'}</Markdown>);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
