import type { DocumentFileType } from '../../models';
import { logger } from '../../logger';
import { buildMarkdownElements } from './markdown';
import { buildPdfElements, buildPlainElements } from './plaintext';
import type { ElementDoc } from './types';

export type { DocElement, DocElementType, ElementDoc } from './types';

export interface BuildElementsInput {
  /** 文档全文（原始文本，未归一化） */
  text: string;
  fileType: DocumentFileType;
  /** PDF 专用：每页文本（用来保住页边界这个结构信号） */
  pageTexts?: string[] | undefined;
}

/**
 * 按文件类型产出元素序列 —— 切块器的唯一入口
 *
 * 三种格式的结构可得性差别很大，这一层就是把它们拉齐的地方：
 *   - Markdown → AST，标题层级 / 列表 / 代码 / 表格全有
 *   - PDF      → 页 + 段 + 猜出来的标题
 *   - TXT      → 段 + 猜出来的标题
 */
export function buildElements(input: BuildElementsInput): ElementDoc {
  switch (input.fileType) {
    case 'markdown':
      return buildMarkdownElements(input.text);
    case 'pdf': {
      if (input.pageTexts && input.pageTexts.length > 0) {
        return buildPdfElements(input.pageTexts);
      }
      // 没有分页信息（理论上不该发生 —— document-parse 一定会给）→ 退回单页纯文本
      logger.warn({}, 'PDF 缺少分页文本，退回单页纯文本切块');
      return buildPlainElements(input.text);
    }
    case 'txt':
      return buildPlainElements(input.text);
    default: {
      const unreachable: never = input.fileType;
      throw new Error(`未知的文件类型：${String(unreachable)}`);
    }
  }
}
