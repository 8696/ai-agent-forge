/**
 * 全文归一化 —— 切块器与元素解析器共用
 *
 * ⚠️ **归一化必须在解析之前做**：
 * Markdown 的 AST 位置（offset）是对**输入文本**的，归一化会改变字符数，
 * 顺序反了会导致「这个元素在原文里的位置」全部偏移（排查时对不上原文）。
 */

/** 全文归一化：统一换行 / 折叠空行 / 去行尾空白 / 全角空格转半角 */
export function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/　/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
