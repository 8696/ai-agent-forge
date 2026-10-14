import { generateText } from 'ai';
import { buildLlm } from './llm';
import { loadSystemPrompt } from './load-prompt';
import { logger } from '../logger';
import type { Message } from '../models';
import { estimateMessageTokens } from './token-budget';

/**
 * 摘要压缩 —— 详见 docs/16-b §B1 + docs/15 §Step 7
 *
 * 触发条件：history 总 token 数 > budget.history
 * 行为：把「最早 N 条」消息用 LLM 压缩成一段摘要，结果替换为一条「summary 消息」
 *   role: 'system'，content: 摘要正文
 *   后续 model 调用时塞进 messages 列表开头（紧跟主 system 之后）
 *
 * 为什么用单独的 LLM 调用：摘要要稳，跟主对话用同一个模型最一致
 *   ——成本考虑后续可切到更便宜的 Sonnet / Haiku，但本期 MVP 共用
 */

const SUMMARY_SYSTEM = `你是一个对话摘要助手。请把以下多轮客服对话压缩成一段简洁的中文摘要。

要求：
- 保留：用户提到的关键问题、模型给出的关键回答、待办事项、用户偏好
- 丢掉：寒暄、重复信息、模型的标准客套话
- 控制在 200 字以内
- 用第三人称（"用户问…"、"模型答…"）
- 不要解释，直接给摘要正文`;

export interface SummarizeInput {
  tenantId: string;
  /** 要压缩的最早一段消息（按 created_at ASC 取前 N 条） */
  earlyMessages: Pick<Message, 'role' | 'content'>[];
}

export interface SummarizeResult {
  summary: string;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * 把一段早期历史压缩成 200 字内的摘要
 *  - 失败（API 错 / 返回空）：返回原 messages 不压缩（main loop 改走 truncateHistoryToBudget 兜底）
 */
export async function summarizeEarlyHistory(input: SummarizeInput): Promise<SummarizeResult> {
  const { tenantId, earlyMessages } = input;
  const tokensBefore = earlyMessages.reduce(
    (s, m) => s + estimateMessageTokens(m.content),
    0,
  );

  const tenantSystem = await loadSystemPrompt(tenantId);

  const formatted = earlyMessages
    .map((m) => {
      const role = m.role === 'user' ? '用户' : m.role === 'assistant' ? '模型' : m.role;
      return `${role}：${m.content ?? ''}`;
    })
    .join('\n');

  try {
    const { model, modelId, provider } = buildLlm();
    const res = await generateText({
      model,
      system: `${tenantSystem}\n\n${SUMMARY_SYSTEM}`,
      prompt: formatted,
      maxTokens: 400,
    });
    const summary = res.text.trim();
    if (summary === '') {
      throw new Error('摘要返回空字符串');
    }
    const tokensAfter = estimateMessageTokens(summary);
    logger.info(
      {
        tenantId,
        provider,
        model: modelId,
        beforeCount: earlyMessages.length,
        tokensBefore,
        tokensAfter,
      },
      'summarizeEarlyHistory 完成',
    );
    return { summary, tokensBefore, tokensAfter };
  } catch (err: unknown) {
    logger.warn(
      {
        tenantId,
        err: err instanceof Error ? err.message : String(err),
      },
      'summarizeEarlyHistory 失败，返回原消息（main loop 会兜底 truncate）',
    );
    return {
      summary: '',
      tokensBefore,
      tokensAfter: tokensBefore,
    };
  }
}
