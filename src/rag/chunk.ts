import { config } from '../config';

/**
 * 文档拆块 —— 详见 docs/05-b-数据模型-qdrant.md §5.6
 *
 * 为什么按「字符数」而不是 token 数切：
 *  - 中文 1 字 ≈ 1~2 token，英文 1 词 ≈ 1~2 token，字符数对两者都够用且可预测
 *  - 引入 tiktoken / 某种 tokenizer 会把「换 provider 要重算历史文档的块」变成常态问题
 *  - 实际影响精度的因素是「有没有在语义边界断开」和「overlap 够不够」，不是精确 token 计数
 *
 * 切分策略：滑窗 + 边界吸附
 *  1. 归一化空白（统一换行、去行尾空格、折叠连续空行、全角空格转半角）
 *  2. 从 cursor 起取 CHUNK_SIZE 个字符作为候选块
 *  3. 如果这一刀落在文档中间，回看窗口末段找一个更靠后的段落/句子边界，有就切在那里
 *  4. 下一块从 end - CHUNK_OVERLAP 开始（overlap 保证跨块的句子不会丢上下文）
 */

export interface Chunk {
  /** 块在文档内的序号，0-based */
  index: number;
  text: string;
  /** 在**归一化后**全文中的字符区间，便于排查「这段原文在哪」 */
  charStart: number;
  charEnd: number;
}

export interface SplitOptions {
  size?: number;
  overlap?: number;
}

/**
 * 边界回看窗口：只在块末这么多个字符内找断点。
 * 太大 → 块会被压得很短；太小 → 常常找不到边界，只能硬切。
 */
const BOUNDARY_LOOKBACK = 120;

/** 候选断点，从最想切的地方往下退 */
const BOUNDARY_MARKS = ['\n\n', '\n', '。', '！', '？', '. ', '; ', '；', '，'] as const;

/**
 * 拆块主入口。空文档 / 纯空白文档返回 []。
 * 参数默认从 config 读（CHUNK_SIZE=800 / CHUNK_OVERLAP=150，见 .env.example）。
 */
export function splitByChunk(rawText: string, options: SplitOptions = {}): Chunk[] {
  const text = normalizeWhitespace(rawText);
  if (text.length === 0) {
    return [];
  }

  const size = options.size ?? config.CHUNK_SIZE;
  const overlap = Math.min(options.overlap ?? config.CHUNK_OVERLAP, size - 1);
  if (size <= 0) {
    throw new Error(`拆块 size 必须为正数，收到 ${size}`);
  }

  const chunks: Chunk[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    const hardEnd = Math.min(cursor + size, text.length);
    const end =
      hardEnd >= text.length ? hardEnd : alignToBoundary(text, cursor, hardEnd, size);
    const piece = text.slice(cursor, end).trim();

    if (piece.length > 0) {
      chunks.push({
        index: chunks.length,
        text: piece,
        charStart: cursor,
        charEnd: end,
      });
    }

    if (end >= text.length) {
      break;
    }
    // overlap 让下一块回头重述上一块的尾巴；至少 +1 保证游标严格前进，不会死循环
    cursor = Math.max(end - overlap, cursor + 1);
  }
  return chunks;
}

/**
 * 在 [cursor + size - BOUNDARY_LOOKBACK, hardEnd) 里找最靠后的边界并返回该位置。
 * 找不到就原样返回 hardEnd（硬切）。
 *
 * 边界本身（那个分隔符）归**前一块**，语义上「上一段讲完了」比「下一段开头重复一个字」自然。
 */
function alignToBoundary(text: string, cursor: number, hardEnd: number, size: number): number {
  const floor = Math.max(cursor + 1, hardEnd - BOUNDARY_LOOKBACK);
  const window = text.slice(floor, hardEnd);
  // 只接受「切完还剩得下大半块」的边界，否则这一块会短得没意义
  const minEnd = cursor + Math.floor(size / 2);
  for (const mark of BOUNDARY_MARKS) {
    const at = window.lastIndexOf(mark);
    if (at < 0) {
      continue;
    }
    const candidate = floor + at + mark.length;
    if (candidate > minEnd) {
      return candidate;
    }
  }
  return hardEnd;
}

/** 全文归一化：统一换行 / 折叠空行 / 去行尾空白 / 全角空格转半角 */
function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/　/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}