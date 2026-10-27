import { promises as fs } from 'node:fs';
import { PDFParse } from 'pdf-parse';
import type { DocumentFileType } from '../models';

/**
 * 文档正文提取 —— 详见 docs/12-c-需求-管理员可配置.md §C1
 *
 * 当前支持 PDF / Markdown / TXT。**不支持 Word（.docx）** —— 2026-10-25 已把
 * DOCX 解析从需求里整个删掉（docs/01 §1.1 的上传格式、docs/05-a 的 file_type
 * ENUM 都去掉了 'word'），迁移 `021-alter-documents-file-type` 收窄了库里的列。
 *
 * pdf-parse v2 的用法：`new PDFParse({ data })` → `getText()` → **必须 destroy()**，
 * 漏掉会泄漏 worker / 文件句柄，进程跑久了会耗尽 fd。
 */

/** 提取结果 */
export interface ParsedDocument {
  text: string;
  /** PDF 页数（其它类型为 undefined） */
  pages?: number;
  /**
   * PDF 每页的文本（其它类型为 undefined）。
   *
   * **页边界是 PDF 仅剩的结构信号** —— 章节、换页都体现在这儿，
   * 切块时用它当硬边界（见 src/rag/elements/plaintext.ts）。
   */
  pageTexts?: string[];
}

export async function extractText(
  absolutePath: string,
  fileType: DocumentFileType,
): Promise<ParsedDocument> {
  switch (fileType) {
    case 'pdf':
      return extractPdf(absolutePath);
    case 'markdown':
    case 'txt':
      return extractPlainText(absolutePath);
    default: {
      // 类型来自数据库 ENUM，跑到这里说明库里出现了新值
      const unreachable: never = fileType;
      throw new Error(`未知的文件类型：${String(unreachable)}`);
    }
  }
}

async function extractPdf(absolutePath: string): Promise<ParsedDocument> {
  const buffer = await fs.readFile(absolutePath);
  const parser = new PDFParse({ data: buffer });
  try {
    /**
     * ⚠️ **`pageJoiner: ''` 必须显式传**（2026-10-27 加的）：
     * pdf-parse v2 的 `getText()` 默认会在每页后面插一个 `-- 1 of 12 --` 的页码标记
     * （默认值是 `'\n-- page_number of total_number --'`，实际渲染成 `-- 1 of 12 --`）。
     * 那个标记会：
     *   1. 进到正文里 → 进向量（纯噪声 token）
     *   2. 出现在引用卡片里（用户看到一串莫名的话）
     * 传空串 = 关掉标记，页面之间仍然用空行分隔。
     *
     * `result.pages` 里是**每页的文本**，那是 PDF 仅剩的结构信号，必须留着。
     */
    const result = await parser.getText({ pageJoiner: '' });
    // total 是总页数；扫描件 PDF 也能返回 total，但 text 全是空
    return {
      text: result.text,
      pages: result.total,
      pageTexts: result.pages.map((page) => page.text),
    };
  } finally {
    await parser.destroy();
  }
}

/**
 * MD / TXT 统一按 UTF-8 读。
 *
 * 国内环境偶尔会拿到 GBK 编码的 txt，解出来全是乱码，进而污染向量库。
 * 严格 UTF-8 解码失败就退一步用 latin1 兜底 —— 至少不会抛异常让整个文档 failed，
 * 代价只是这批字分词质量差些。
 */
async function extractPlainText(absolutePath: string): Promise<ParsedDocument> {
  const buffer = await fs.readFile(absolutePath);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder('latin1').decode(buffer);
  }
  // 去掉 UTF-8 BOM，否则第一个词会带上不可见字符，影响检索
  return { text: text.replace(/^﻿/, '') };
}