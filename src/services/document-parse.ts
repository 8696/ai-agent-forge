import { promises as fs } from 'fs';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

/**
 * 文档文本提取 —— 详见 docs/16-c §C1
 *
 * Step 4 范围（用户确认）：
 *   - PDF       → pdf-parse
 *   - Markdown  → 直接读文件（按文本处理；不剥 frontmatter / 转 HTML）
 *   - TXT       → 直接读文件
 *
 * mammoth 没装，Word 文档（.doc/.docx）Step 4 拒收；下一步要做文再加。
 * 文件类型校验在 services/document-upload.ts:detectFileType 完成
 */

export type SupportedFileType = 'pdf' | 'markdown' | 'txt';

export async function extractText(
  filePath: string,
  fileType: SupportedFileType,
): Promise<string> {
  switch (fileType) {
    case 'pdf':
      return extractPdf(filePath);
    case 'markdown':
    case 'txt':
      return extractPlain(filePath);
  }
}

async function extractPlain(filePath: string): Promise<string> {
  return await fs.readFile(filePath, 'utf8');
}

async function extractPdf(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  // pdf-parse v1 API：直接传 Buffer；返回 { text, numpages, info, ... }
  const result = await pdfParse(buf);
  return result.text;
}