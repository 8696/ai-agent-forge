/**
 * Token 预算（docs/16-b §B1 + docs/15 §Step 7）
 *
 * 上下文窗口管理：超出 token 预算自动摘要压缩早期内容。
 * 详见 docs/08-a-模块-llm与prompt.md（token 预算分配策略）。
 *
 * 分配原则（与 Anthropic Claude 系列对齐；模型切换可调）：
 *  - system     系统提示词 + tenant 注入 — 800 tokens
 *  - retrieval  RAG 检索结果 — 4000 tokens（Step 7 先占位，Step 8 注入）
 *  - tools      工具 schema 描述 — 2000 tokens
 *  - history    历史消息 — 剩给模型上下文的 70%（按模型窗口）
 *  - reserve    输出预留 — max_tokens 上限 + 100 tokens
 *
 * 实际生效：单租户可覆盖（Step 9 落地），当前用进程级常量
 */

export interface TokenBudget {
  /** 模型上下文窗口大小（按 provider 默认） */
  contextWindow: number;
  /** 系统提示词预算 */
  system: number;
  /** 检索结果预算 */
  retrieval: number;
  /** 工具 schema 描述预算 */
  tools: number;
  /** 历史消息预算 */
  history: number;
  /** 输出预留（给 max_tokens 留位置） */
  reserve: number;
}

/** Anthropic Claude Sonnet/Opus 默认 200K 上下文；给历史分配大块 */
export const DEFAULT_BUDGET: TokenBudget = {
  contextWindow: 200_000,
  system: 800,
  retrieval: 4_000,
  tools: 2_000,
  history: Math.floor((200_000 - 800 - 4_000 - 2_000 - 2_000) * 0.7),
  reserve: 2_000,
};

/**
 * 估算一条消息的 token 数（粗估：中文 1 字 ≈ 1.5 token，英文 1 词 ≈ 1.3 token）
 * 不依赖第三方 tokenizer（避免引入额外依赖；用于预算粗判）
 *
 * 准确率：~±20%；MVP 够用。生产可换 anthropic-tokenizer / tiktoken。
 */
export function estimateMessageTokens(content: string | null | undefined): number {
  if (content === null || content === undefined || content === '') return 0;
  const text = content;
  // 中文字符（CJK 范围）
  const cjkCount = (text.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
  // 其他字符
  const otherCount = text.length - cjkCount;
  // 英文按词粗估：单词数 ≈ 非空白字符数 / 5
  const enWords = Math.ceil(otherCount / 5);
  // 中文字符按 1.5 token / 字，英文按 1.3 token / 词
  return Math.ceil(cjkCount * 1.5 + enWords * 1.3);
}

/**
 * 估算一组消息的总 token 数
 */
export function estimateMessagesTokens(
  messages: Array<{ content: string | null | undefined }>,
): number {
  return messages.reduce((sum, m) => sum + estimateMessageTokens(m.content), 0);
}

/**
 * 给出当前预算 + 已用 token，返回历史消息可用的预算
 *  historyAvailable = budget.history - retrievalActual - toolsActual
 *
 * 当 history 超出预算时由 main loop 触发 summarize 压缩
 */
export function computeHistoryAvailable(
  budget: TokenBudget,
  retrievalActual: number,
  toolsActual: number,
): number {
  const fixed = budget.system + retrievalActual + toolsActual + budget.reserve;
  return Math.max(0, budget.contextWindow - fixed);
}

/**
 * 截断历史消息到指定 token 预算：从最旧的消息开始丢
 * 保留 system 消息不动；保留最后一对 user/assistant
 */
export function truncateHistoryToBudget<T extends { role: string; content: string | null | undefined }>(
  history: T[],
  maxTokens: number,
): T[] {
  if (history.length <= 1) return history;

  const system = history.find((m) => m.role === 'system');
  const nonSystem = history.filter((m) => m.role !== 'system');
  if (nonSystem.length === 0) return history;

  // 从最新往旧累加（保留最新对话）
  let usedTokens = 0;
  const kept: T[] = [];
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const m = nonSystem[i];
    if (m === undefined) continue;
    const tokens = estimateMessageTokens(m.content);
    if (usedTokens + tokens > maxTokens) break;
    usedTokens += tokens;
    kept.unshift(m);
  }

  // 至少保留最后一对（user + assistant），避免 LLM 看到「没有用户消息就空 assistant」
  if (kept.length < 2 && nonSystem.length >= 2) {
    kept.length = 0;
    kept.push(nonSystem[nonSystem.length - 2] as T, nonSystem[nonSystem.length - 1] as T);
  }

  return system !== undefined ? [system, ...kept] : kept;
}
