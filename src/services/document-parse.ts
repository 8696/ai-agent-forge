import { promises as fs } from 'node:fs';
import { PDFParse } from 'pdf-parse';
import type { DocumentFileType } from '../models';

/**
 * 文档正文提取 —— 详见 docs/12-c-需求-管理员可配置.md §C1
 *
 * 当前支持 PDF / Markdown / TXT（docs/05-a 的 file_type 里还有一个 'word'，
 * 但 mammoth 没引入，暂时不会产生这个值）。
 *
 * pdf-parse v2 的用法：`new PDFParse({ data })` → `getText()` → **必须 destroy()**，
 * 漏掉会泄漏 worker / 文件句柄，进程跑久了会耗尽 fd。
 */

/** 提取结果 */
export interface ParsedDocument {
  text: string;
  /** PDF 页数（其它类型为 undefined） */
  pages?: number;
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
    case 'word':
      throw new Error('暂不支持 Word 文档（file_type=word 尚未启用）');
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
    const result = await parser.getText();
    // total 是总页数；扫描件 PDF 也能返回 total，但 text 全是空
    return { text: result.text, pages: result.total };
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