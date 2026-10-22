/**
 * 前后端共享代码（types / prompts / schemas）
 * 详见 docs/02-系统架构与目录.md §2.3
 *
 * B1 起 shared/ 有实际内容了：对话类型 + 提示词常量。
 * 两边都从这里 import，避免「system prompt 里的 [n]」和「前端角标的 index」
 * 各写一份导致编号错位。
 */
export type {
  ChatDataTypes,
  ChatUIMessage,
  CitationHit,
  SessionListItem,
  SessionMessagesResponse,
} from './types/chat';

export {
  DEFAULT_PROMPT_VERSION,
  DEFAULT_SYSTEM_PROMPT,
  EMPTY_LIBRARY_NOTICE,
  NO_HITS_NOTICE,
  renderSystemPrompt,
} from './prompts/chat/system-default';

export { CITATION_TEXT_LIMIT, renderRagContext } from './prompts/chat/rag-context';
export type { RagContextResult, RenderableHit } from './prompts/chat/rag-context';