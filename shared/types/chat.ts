import type { UIMessage } from 'ai';

/**
 * 前后端共用的对话类型 —— B1 多轮对话（docs/12-b-需求-ai对话能力.md §B1）
 *
 * 为什么要放 shared/：
 *  system prompt 里要求模型用 `[n]` 标注来源，前端拿 `data-citations` 里的 `index` 画角标。
 *  两边的编号必须严格一致，所以 CitationHit 这类形状只能有一份定义。
 */

/**
 * 一条检索命中的片段，随 SSE 流发给前端做「来源角标 + 查看原文」
 *
 * index 与 system prompt 里的 `[n]` 一一对应（1-based，连续无洞）：
 * 检索片段要过 token 预算裁剪，被裁掉的不会占编号，所以是「留下来的才编号」。
 */
export interface CitationHit {
  /** 1-based 引用编号，与提示词里的 [n] 对应 */
  index: number;
  doc_id: string;
  chunk_index: number;
  /** 文档标题（= 上传时的原始文件名） */
  source: string;
  /** 归一化相关度 [0,1]：1.0 = 向量 + 关键词两路都排第一（见 src/rag/hybrid-search.ts） */
  score: number;
  /** 片段正文；发给前端时截断到 500 字符，省带宽也够「查看原文」用 */
  text: string;
  /** 被哪几路召回（'vector' / 'bm25'） */
  sources: string[];
}

/**
 * AI SDK 自定义 data part 的类型表 —— key 决定 wire 上的 `data-xxx` 事件名
 *
 * 这不是自定义 SSE：AI SDK v7 的 UIMessageChunk 联合类型本身就支持任意 `data-${NAME}`，
 * 前端 useChat 直接收得到（也可用 onData 回调实时拿）。
 *
 * ⚠️ 必须写成 **type 而不是 interface**：UIDataTypes = Record<string, unknown>，
 * 只有「对象字面量类型的 type 别名」才有隐式索引签名能过这个约束（interface 没有），
 * 而带显式 `[key: string]: unknown` 的话 `part.data` 又会被推成 unknown，
 * 前端 `part.data.hits` 直接报错。
 */
export type ChatDataTypes = {
  /** 检索结果（一次回答只发一次，不是每 chunk 一次） */
  citations: {
    hits: CitationHit[];
    /** false = 一条都没检索到（库是空的 / 查询太泛 / 检索层挂了） */
    retrieved: boolean;
    /** 检索耗时 ms，前端可展示 */
    took_ms: number;
    /**
     * 检索层故障说明。两路召回全挂时 hybridSearch 返回 [] 而不抛错
     * （见 src/rag/hybrid-search.ts），没有这个字段就没法把「系统故障」
     * 和「知识库里真没有」区分开，运营排查时一头雾水。
     */
    retrieval_error?: string;
  };
  /** 阶段心跳：检索 → 组织回答，中间那几百毫秒空窗要让用户看见 */
  status: {
    phase: 'retrieving' | 'generating';
    message: string;
  };
  /** 被预算裁掉的早期轮数 —— 前端要提示用户，别让模型悄悄失忆 */
  truncated: {
    dropped_turns: number;
    message: string;
    /**
     * 开了摘要压缩（B1）时为 true —— 被裁掉的内容不是丢了，
     * 而是被折成摘要，下一轮还会回来（措辞不一样，用户的预期差很多）
     */
    summarized?: boolean;
  };
  /**
   * 输出审核结果（D4）
   *
   * blocked=true 表示这条回答没过内容审核：
   *  - 后端**没有**把原文写进 messages，只写了拦截文案
   *  - 前端要把气泡里的正文换成拦截文案（原文已经在流里发出去了，收不回来）
   */
  moderation: {
    blocked: boolean;
    /** 拦截原因（给用户看的中文文案） */
    reason: string;
  };
};

/**
 * 本项目的 UI message 类型。后端 createUIMessageStream<ChatUIMessage>、
 * 前端 useChat<ChatUIMessage> 都用它，两边类型天然对齐。
 *
 * metadata 是消息级元数据（见 ChatMessageMetadata）——
 * 用具体类型比 unknown 更能暴露误用。
 */
/**
 * 消息级元数据。
 *
 * 目前只有一条：**消息创建时间** —— 前端在用户气泡右上角显示一个小时间戳
 * （docs/04-b §4.2）。实时流式的新消息没有这个字段（前端用本地时间兜底），
 * 历史消息由后端从 `messages.created_at` 带出来。
 */
export interface ChatMessageMetadata {
  /** 消息创建时间（ISO8601） */
  created_at?: string;
}

export type ChatUIMessage = UIMessage<ChatMessageMetadata, ChatDataTypes>;

/** 会话列表项（GET /api/v1/customer/sessions） */
export interface SessionListItem {
  id: string;
  title: string | null;
  status: string;
  channel: string;
  message_count: number;
  started_at: string;
  last_message_at: string | null;
}

/** 历史消息（GET /api/v1/customer/sessions/:id/messages）
 *  刻意做成 useChat({ messages }) 能直接吃的形状：前端切换会话时一次灌进去即可 */
export interface SessionMessagesResponse {
  messages: ChatUIMessage[];
  has_more: boolean;
}