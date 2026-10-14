import { Message, type MessageRole } from '../models';
import { logger } from '../logger';
import { estimateMessagesTokens } from '../lib/token-budget';

/**
 * 短期记忆 —— 详见 docs/16-b §B4 + docs/15 §Step 7
 *
 * 直接查 messages 表（不引入 Redis；MVP 规模够用）
 * 详见 docs/03-b §B.3 「不引入 Redis（当前规模用不上）」
 */

export interface HistoryMessage {
  role: MessageRole;
  content: string;
  /** 思考模式内容（Step 8 前端折叠展示） */
  thinking_content?: string | null;
}

export interface LoadHistoryParams {
  sessionId: string;
  tenantId: string;
  /** 最多拉多少条；默认 50 */
  limit?: number;
}

export interface LoadHistoryResult {
  messages: HistoryMessage[];
  /** 拉到的消息总 token 数（粗估） */
  tokens: number;
  /** 是否触底（==limit 说明历史可能更长，主循环该考虑摘要压缩） */
  hitLimit: boolean;
}

/**
 * 加载一个会话的短期历史（按时间正序）
 *  - 跳过 status='cancelled' 的消息（用户中止的不要发给 LLM 当上下文）
 *  - 不返回 tool 消息的 tool_results 字段（避免泄露 tool 内部状态；如需可单独取）
 */
export async function loadShortTermHistory(
  params: LoadHistoryParams,
): Promise<LoadHistoryResult> {
  const limit = params.limit ?? 50;
  const rows = await Message.findAll({
    where: {
      session_id: params.sessionId,
      tenant_id: params.tenantId,
      status: ['streaming', 'complete', 'failed'], // cancelled 跳过
    },
    order: [['created_at', 'ASC']],
    limit,
    attributes: ['role', 'content', 'thinking_content', 'created_at'],
  });
  const messages: HistoryMessage[] = rows.map((r) => ({
    role: r.role,
    content: r.content ?? '',
    ...(r.thinking_content !== null ? { thinking_content: r.thinking_content } : {}),
  }));
  const tokens = estimateMessagesTokens(messages);
  const hitLimit = rows.length >= limit;
  logger.debug(
    {
      sessionId: params.sessionId,
      count: messages.length,
      tokens,
      hitLimit,
    },
    'loadShortTermHistory',
  );
  return { messages, tokens, hitLimit };
}
