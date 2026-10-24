/**
 * token 粗估 + 上下文预算截断 —— B1 多轮对话（docs/12-b-需求-ai对话能力.md §B1）
 *
 * 为什么不用 tiktoken / 真实 tokenizer：
 *  同 src/rag/chunk.ts 的取舍——中文 1 字 ≈ 1~2 token、英文 1 词 ≈ 1~2 token，
 *  字符数对两者都够用且可预测。引入 tiktoken 会让「换 provider 要重算历史」变成常态问题。
 *
 * 这里的估算**只用来做预算截断**，不用于计费：真实 token 数以 LLM 返回的 usage 为准
 * （落库到 messages.usage，成本统计见 docs/12-d §D3）。
 */

/** CJK 表意文字 + 中文标点 + 全角符号：主流 BPE 里约 1 字 ≈ 1~2 token，取 1.5 偏保守 */
const CJK_PATTERN =
  /[㐀-䶿一-鿿豈-﫿　-〿！-｠]/;

/** CJK 每字折算的 token 数（取中值偏保守） */
const CJK_TOKENS_PER_CHAR = 1.5;

/** 非 CJK 字符：按「4 字符 ≈ 1 token」估（英文单词约 4~6 字符） */
const NON_CJK_CHARS_PER_TOKEN = 4;

/** 每条消息的固定开销（role + 分隔符），Anthropic 这类协议都要额外算一点 */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * 粗估一段文本的 token 数。
 *
 * **故意高估**：估多了只是多裁几轮历史（用户看得见「已省略更早的 N 轮」）；
 * 估少了会在 provider 侧炸 400，而那时流已经开始写了，前端只能看到一个流内 error。
 *
 * 纯函数，不触网 —— 单测直接覆盖。
 */
export function estimateTokens(text: string): number {
  if (text === '') {
    return 0;
  }
  let cjkCount = 0;
  let otherCount = 0;
  for (const ch of text) {
    if (CJK_PATTERN.test(ch)) {
      cjkCount += 1;
    } else {
      otherCount += 1;
    }
  }
  return Math.ceil(cjkCount * CJK_TOKENS_PER_CHAR + otherCount / NON_CJK_CHARS_PER_TOKEN);
}

/** 历史消息的统一最小形状（DB 行 / prompt 组装都能喂进来） */
export interface TokenCountableMessage {
  role: string;
  content: string;
  /**
   * 这条消息在 DB 里的行 id（可选）。
   *
   * 只有摘要压缩（B1）用得上：它要记住「摘要覆盖到了哪一条消息」，
   * 才能算出「这一轮新增了哪些消息」。
   * 调用方不传就是纯文本消息 —— 纯逻辑（预算裁剪）不依赖这个字段。
   */
  ref?: string;
}

/**
 * 粗估一组消息的总 token 数（含每条消息的固定开销）。
 */
export function estimateMessagesTokens(messages: readonly TokenCountableMessage[]): number {
  let total = 0;
  for (const m of messages) {
    total += estimateTokens(m.content) + MESSAGE_OVERHEAD_TOKENS;
  }
  return total;
}

export interface HistoryBudgetOptions {
  /** 分给历史的 token 预算（已扣掉 system prompt + 检索片段 + 预留输出） */
  maxTokens: number;
  /** 最多保留多少轮；一轮 = 一条 user 消息 + 其后的 assistant 消息 */
  maxTurns: number;
}

export interface HistoryFitResult {
  /** 保留的消息，按时间从旧到新（可直接喂给 streamText） */
  kept: TokenCountableMessage[];
  /** 被丢弃的轮数（每轮一条 user 消息），0 表示没丢 */
  droppedTurns: number;
  /** 保留部分的估算 token 数 */
  estimatedTokens: number;
  /**
   * 被丢弃的消息本身（按时间从旧到新）。
   *
   * 摘要压缩（B1）要用它：把丢掉的轮次折成一段摘要写进 sessions.summary。
   * 没有它的话调用方只知道「丢了 N 轮」，没法去总结丢的是什么。
   */
  dropped: TokenCountableMessage[];
}

/**
 * 按预算裁剪历史：从最新一条往回累积，超预算即停。
 *
 * 两条硬规则：
 *  1. **最后一条 user 消息永远保留**——哪怕它一个人就超预算。否则这次请求就没有用户输入了，
 *     模型会拿着空历史回答，等于静默失败。
 *  2. **截断只在轮边界发生**——assistant 的回答不会被从中间砍掉。没有 assistant 收尾的那半轮
 *     （用户刚问完还没得到回答）会被整轮丢掉，因为把「有问无答」的尾巴喂回去只会浪费 token。
 *
 * 被丢掉的历史交给调用方处置：
 *  - 摘要压缩（B1）：把 dropped 折成一段摘要写进 sessions.summary，下一轮再喂回去
 *  - UI 提示：按 droppedTurns 告知用户「已省略更早的 N 轮对话」
 */
export function fitHistoryToBudget(
  messages: readonly TokenCountableMessage[],
  options: HistoryBudgetOptions,
): HistoryFitResult {
  const empty: HistoryFitResult = { kept: [], droppedTurns: 0, estimatedTokens: 0, dropped: [] };
  if (messages.length === 0) {
    return empty;
  }

  // 找每轮 user 消息的起始下标：从后往前扫，最后一条没有后续消息的 user 也算一轮。
  const turnStarts: number[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m !== undefined && m.role === 'user') {
      turnStarts.push(i);
    }
  }
  turnStarts.reverse(); // 变成从旧到新
  if (turnStarts.length === 0) {
    // 没有 user 消息（异常数据），原样返回让调用方自己处理
    return {
      kept: [...messages],
      droppedTurns: 0,
      estimatedTokens: estimateMessagesTokens(messages),
      dropped: [],
    };
  }

  // 从最新一轮开始往回收，收满 maxTurns 或超预算就停
  const maxTurns = Math.max(1, options.maxTurns);
  const keptStarts: number[] = [];
  let used = 0;
  for (let t = turnStarts.length - 1; t >= 0; t -= 1) {
    if (keptStarts.length >= maxTurns) {
      break;
    }
    const start = turnStarts[t];
    if (start === undefined) {
      break;
    }
    const nextStart = turnStarts[t + 1];
    // 本轮范围 [start, nextStart)（最后一轮到 messages 末尾）
    const end = nextStart ?? messages.length;
    const turn = messages.slice(start, end);
    const turnCost = estimateMessagesTokens(turn);

    const isLastTurn = keptStarts.length === 0;
    // 硬规则 1：最后一轮不因为超预算被丢
    if (!isLastTurn && used + turnCost > options.maxTokens) {
      break;
    }
    keptStarts.push(start);
    used += turnCost;
  }

  keptStarts.reverse();
  const firstKept = keptStarts[0] ?? messages.length;
  const kept = messages.slice(firstKept) as TokenCountableMessage[];
  return {
    kept,
    droppedTurns: turnStarts.length - keptStarts.length,
    estimatedTokens: used,
    dropped: messages.slice(0, firstKept) as TokenCountableMessage[],
  };
}

/** 检索片段的最小形状（不依赖 rag 模块的具体类型，纯数据，好测） */
export interface TokenCountableHit {
  text: string;
}

/**
 * 按 token 预算裁剪检索片段：从最高分开始装，装不下就丢后面的。
 *
 * 入参必须是**已按相关度降序**的（hybridSearch 的 RRF 融合结果天然有序）。
 * 至少保留第一条 —— 哪怕它一个人就超预算，否则这次回答连一条资料都没有，
 * 模型只能凭印象瞎答，比「多花点 token」糟糕得多。
 */
export function fitHitsToBudget<T extends TokenCountableHit>(
  hits: readonly T[],
  maxTokens: number,
): T[] {
  if (hits.length === 0) {
    return [];
  }
  const kept: T[] = [];
  let used = 0;
  for (const hit of hits) {
    const cost = estimateTokens(hit.text);
    if (kept.length > 0 && used + cost > maxTokens) {
      break;
    }
    kept.push(hit);
    used += cost;
  }
  return kept;
}