import { config } from '../config';

/**
 * 文档拆块 —— 详见 docs/05-b-数据模型-qdrant.md §5.6 + docs/13-d-后端代码-业务功能.md §13.7
 *
 * 简单实现：按字符数（中文友好；不引入 tokenizer 依赖）+ overlap
 *   - 中文 1 字符 = 1 单位（与英文按空格分词相比，简单且可预测）
 *   - 优先在段落 / 换行边界断块（避免在句子中间切断）
 *
 * 未来要换「按语义断块 / tiktoken 计数」直接换实现，对外接口不变。
 */

export interface Chunk {
  index: number;
  text: string;
  charStart: number;
  charEnd: number;
}

/**
 * 拆块主入口；空文档返回 []。
 *  - 步骤：normalized → 按段落切片 → 在每个段内按 SIZE 滑窗（带 OVERLAP）→ 合并
 *  - 边界尽量对齐 \n\n / \n；中文段落保留
 *  - SIZE/OVERLAP 从 config 读（与 docs/05-b §5.6 + docs/15 §Step 4 一致：默认 800/150）
 */
export function splitByChunk(rawText: string): Chunk[] {
  const text = normalizeWhitespace(rawText);
  if (text.length === 0) return [];

  const out: Chunk[] = [];
  let globalIdx = 0;
  let cursor = 0;
  const size = config.CHUNK_SIZE;
  const overlap = config.CHUNK_OVERLAP;
  while (cursor < text.length) {
    let end = Math.min(cursor + size, text.length);
    if (end < text.length) {
      // 尽量在最近的 \n 处断开（最近 100 字符内）
      const slice = text.slice(cursor, end);
      const lastBreak = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'));
      if (lastBreak > size - 100 && lastBreak > 0) {
        end = cursor + lastBreak;
      }
    }
    const piece = text.slice(cursor, end).trim();
    if (piece.length > 0) {
      out.push({
        index: globalIdx,
        text: piece,
        charStart: cursor,
        charEnd: end,
      });
      globalIdx += 1;
    }
    if (end >= text.length) break;
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return out;
}

function normalizeWhitespace(s: string): string {
  // 全角空格（U+3000）→ 半角；多个连续 \n 折叠；去掉行尾空白
  return s.replace(/\r\n/g, '\n').replace(/\u3000/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}