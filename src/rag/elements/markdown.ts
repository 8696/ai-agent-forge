import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { toString } from 'mdast-util-to-string';
import type { List, ListItem, Root, RootContent, Table } from 'mdast';
import type { Node } from 'unist';
import { normalizeWhitespace } from '../normalize';
import { buildPlainElements } from './plaintext';
import type { DocElement, DocElementType, ElementDoc } from './types';

/**
 * Markdown → 元素序列
 *
 * **用 AST 不用正则**：正则认标题很脆（`#` 后面必须有空格、`##` 在代码块里不是标题、
 * Setext 标题（`===` 下划线形式）正则根本认不出）。AST 是解析器认定的结构，不会错。
 *
 * 产出的元素对应 mdast 的块级节点：
 *   heading → heading（并维护标题层级栈）
 *   paragraph → paragraph
 *   code → code
 *   table（GFM）→ table（渲染成 markdown 管道表）
 *   list → 每个 listItem 一个 list 元素（这样超长列表能按项拆，不会拆坏一项）
 *
 * ⚠️ **正文用 `toString()` 而不是原文**：`toString` 会剥掉 `**粗体**` 的星号、
 * 把 `[链接](url)` 变成「链接」。这些标记进了向量是纯噪声（`##`、`**`、`()`）。
 * 代码块和表格例外 —— 它们的结构本身就是内容，必须保留。
 */

/** 解析 Markdown → mdast（带 GFM：表格 / 任务列表 / 删除线 / 自动链接） */
function parseMarkdown(text: string): Root {
  return fromMarkdown(text, {
    extensions: [gfm()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
}

/**
 * 维护标题层级栈。
 *
 * 例：栈 ['产品手册']，遇到 `## 退款政策`（level 2）→ 保留前 1 层再 push
 * → ['产品手册', '退款政策']；遇到 `## 另一章` → 覆盖第 2 层 → ['产品手册', '另一章']。
 */
function pushHeading(stack: string[], level: number, title: string): string[] {
  const next = stack.slice(0, Math.max(0, level - 1));
  next.push(title);
  return next;
}

/** mdast 节点 → 字符区间 */
function offsets(node: Node): { charStart: number; charEnd: number } {
  const charStart = node.position?.start.offset ?? 0;
  const charEnd = node.position?.end.offset ?? charStart;
  return { charStart, charEnd };
}

/** GFM 表格节点 → markdown 管道表文本（保留表头，结构不丢） */
function renderTable(node: Table): string {
  const rows = node.children.map((row) => row.children.map((cell) => toString(cell)));
  const header = rows[0];
  if (!header) {
    return '';
  }
  const lines = [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
  ];
  for (const row of rows.slice(1)) {
    lines.push(`| ${row.join(' | ')} |`);
  }
  return lines.join('\n');
}

export function buildMarkdownElements(rawText: string): ElementDoc {
  const text = normalizeWhitespace(rawText);
  if (text.length === 0) {
    return { text, elements: [] };
  }

  let tree: Root;
  try {
    tree = parseMarkdown(text);
  } catch {
    // Markdown 语法烂到解析器都读不了 → 退回纯文本路径
    // （宁可切得差，也不能整篇文档索引失败）
    return buildPlainElements(text);
  }

  const elements: DocElement[] = [];
  /** 当前标题层级栈 */
  let stack: string[] = [];

  const emit = (
    type: DocElementType,
    content: string,
    level: number,
    node: Parameters<typeof offsets>[0],
  ): void => {
    if (content.trim() === '') {
      return;
    }
    const { charStart, charEnd } = offsets(node);
    elements.push({ type, text: content, headingPath: [...stack], level, charStart, charEnd });
  };

  const walkList = (node: List): void => {
    for (const item of node.children as ListItem[]) {
      const firstParagraph = item.children.find((child) => child.type === 'paragraph');
      const itemText = firstParagraph ? toString(firstParagraph) : toString(item);
      emit('list', itemText, 0, item);
      // 嵌套内容（子列表 / 引用 / 第二个段落）继续处理
      for (const child of item.children) {
        if (child === firstParagraph) {
          continue;
        }
        if (child.type === 'list') {
          walkList(child);
        } else {
          walk([child]);
        }
      }
    }
  };

  const walk = (nodes: RootContent[]): void => {
    for (const node of nodes) {
      switch (node.type) {
        case 'heading': {
          const title = toString(node);
          stack = pushHeading(stack, node.depth, title);
          emit('heading', title, node.depth, node);
          break;
        }
        case 'paragraph': {
          emit('paragraph', toString(node), 0, node);
          break;
        }
        case 'code': {
          /**
           * ⚠️ **保留围栏和语言标记**（2026-10-27 改）：
           *   - 剥掉之后，一段 Python 和一段 JSON 在向量里长得一样（`def f():` vs `const f =`）
           *   - 代码超预算按行切开后，后半片连函数签名都没有了
           * 代码块本身就是内容 —— 跟表格一个待遇（正文才剥 markdown 标记）。
           */
          const lang = node.lang ?? '';
          emit('code', `\`\`\`${lang}\n${node.value}\n\`\`\``, 0, node);
          break;
        }
        case 'table': {
          emit('table', renderTable(node), 0, node);
          break;
        }
        case 'list': {
          walkList(node);
          break;
        }
        case 'blockquote': {
          walk(node.children as RootContent[]);
          break;
        }
        case 'thematicBreak': {
          break;
        }
        default: {
          // html / definition / 未来新增的块类型 → 当段落保留原文
          const value = 'value' in node ? String(node.value) : toString(node);
          emit('paragraph', value, 0, node);
        }
      }
    }
  };

  walk(tree.children);
  return { text, elements };
}
