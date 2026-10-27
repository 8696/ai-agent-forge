import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Empty,
  Flex,
  Input,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd';
import {
  BookFilled,
  BookOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  LikeFilled,
  LikeOutlined,
  DislikeFilled,
  DislikeOutlined,
  LoadingOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
  StarOutlined,
} from '@ant-design/icons';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import { useSearchParams } from 'react-router-dom';
import type { ChatUIMessage, CitationHit, SessionListItem } from '@shared/types/chat';
import {
  approveToolCall,
  rejectToolCall,
  chatTransportOptions,
  createSession,
  deleteSession,
  errorMessage,
  fetchSessionMessages,
  fetchSessions,
  formatFullTime,
  messageMeta,
  renameSession,
  sendFeedback,
  setMessageFavorite,
  setSessionFavorite,
  streamErrorMessage,
} from '../../lib/customerChat';
import { PageHeader } from '../../components/shell';
import { Markdown } from '../../components/Markdown';
import { ToolCallList, toolCallsOf, type ToolCallRecord } from '../../components/ToolCallList';
import { formatMessageTime } from '../../lib/datetime';

/**
 * B1 · 租户前台聊天页 —— 详见 docs/04-b-ui-登录与聊天挂件.md §4
 * 后端对应 src/gateway/customer/chat-routes.ts（流式走 SSE + AI SDK UI message stream）
 *
 * 结构：左会话侧栏 + 右消息区。SharedShellLayout 是 100vh + overflow:hidden，
 * 所以**消息区自己管滚动**（flex:1 + minHeight:0 + overflowY:auto），
 * 不能靠页面级滚动。
 *
 * ⚠️ token 不走 axios 拦截器：useChat 内部是 fetch，必须在 transport 里手动带
 *    Authorization（见 chatTransportOptions）。
 */

const { Text, Paragraph } = Typography;

type Phase = 'idle' | 'retrieving' | 'generating';

/** 从一条 assistant 消息的 parts 里取出引用片段 */
function citationsOf(m: ChatUIMessage): CitationHit[] | null {
  for (const part of m.parts) {
    if (part.type === 'data-citations') {
      return part.data.hits;
    }
  }
  return null;
}

function textOf(m: ChatUIMessage): string {
  return m.parts
    .filter((p): p is Extract<typeof p, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

/** 最后一条用户消息的正文 —— 断流后拿它来「重试」 */
function lastUserTextOf(messages: ChatUIMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m !== undefined && m.role === 'user') {
      const t = textOf(m);
      if (t !== '') {
        return t;
      }
    }
  }
  return null;
}

function thinkingOf(m: ChatUIMessage): string {
  return m.parts
    .filter((p): p is Extract<typeof p, { type: 'reasoning' }> => p.type === 'reasoning')
    .map((p) => p.text)
    .join('');
}

/**
 * 从历史消息里还原 👍/👎 状态。
 *
 * 后端 `rowToUiMessage` 把 `messages.feedback` 放在 `metadata.feedback` 里
 * （见 src/services/chat.ts）—— 刷新后要能还原成「已选中」，
 * 不然再点一次是「又赞一次」而不是取消。
 */
function feedbackOf(messages: ChatUIMessage[]): Record<string, 1 | -1> {
  const map: Record<string, 1 | -1> = {};
  for (const m of messages) {
    const fb = messageMeta(m).feedback;
    if (fb === 1 || fb === -1) {
      map[m.id] = fb;
    }
  }
  return map;
}

/** 从历史消息里还原 📌 收藏状态（同上，后端放在 `metadata.favorite`） */
function favoritesOf(messages: ChatUIMessage[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const m of messages) {
    if (messageMeta(m).favorite === true) {
      map[m.id] = true;
    }
  }
  return map;
}

/**
 * 输出审核结果（D4）—— 后端判定这条回答没过审时会下发 data-moderation part。
 *
 * ⚠️ SSE 的固有约束：正文已经流到浏览器了，收不回来。
 *    后端保证的是「原文不落库」；前端这边把气泡正文换成拦截提示。
 */
function moderationOf(m: ChatUIMessage): { blocked: boolean; reason: string } | null {
  for (const part of m.parts) {
    if (part.type === 'data-moderation') {
      return part.data;
    }
  }
  return null;
}

/**
 * 上下文预算裁剪提示 —— 后端在裁掉早期轮次时下发 data-truncated part。
 *
 * ⚠️ 这个 part **会落库**（不是 transient），所以刷新页面后历史里也带着它 ——
 *    之前标了 transient，只在当次流里显示，刷新就没了（历史跟当时屏幕对不上）。
 */
function truncatedOf(m: ChatUIMessage): { dropped_turns: number; message: string } | null {
  for (const part of m.parts) {
    if (part.type === 'data-truncated') {
      return part.data;
    }
  }
  return null;
}

export function ChatPage(): ReactElement {
  const { token } = theme.useToken();
  const [searchParams, setSearchParams] = useSearchParams();
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * 右侧聊天面板的加载闸门 —— **只在首次进入时**为 true。
   *
   * ⚠️ 以前这里只有一个 `loading`，侧栏刷新和右侧面板共用 ——
   *    切「只看收藏」→ identity 变 → effect 重跑 → setLoading(true)
   *    → 右侧的 `SessionLoader` 被**整个卸载**（useChat cleanup 调 `chat.stop()`
   *    掐断正在流式的回答）→ 重新挂载 → 自动发送的问题**又发一遍**（多花一次 LLM 调用）。
   *    现在侧栏的加载闸门是 `sessionsLoading`，两边彻底分开。
   */
  const [initialLoading, setInitialLoading] = useState(true);
  /** 侧栏会话列表的加载闸门（跟右侧面板**分开**） */
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<SessionListItem | null>(null);
  /** 只看收藏的会话（12-e 裁定表 #7） */
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  /** 侧栏收起 / 展开（docs/04-b §4.5「可隐藏侧栏」） */
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  /**
   * 待自动发出的问题（首页点「推荐问题 / 资料」跳过来时带 ?q=）。
   * 记着 sessionId —— 只往「当初为这个问题建的那个会话」里发，
   * 用户切到别的会话时不会把同一个问题再问一遍。
   */
  const [pendingQuestion, setPendingQuestion] = useState<{ sessionId: string; text: string } | null>(null);
  /** 只跑一次的初始化标记（StrictMode 下 effect 会跑两遍） */
  const bootstrappedRef = useRef(false);

  const reloadSessions = useCallback(async (): Promise<void> => {
    setSessionsLoading(true);
    try {
      const data = await fetchSessions(1, 50, favoriteOnly);
      setSessions(data.sessions);
      setError(null);
    } catch (err: unknown) {
      setError(errorMessage(err, '加载会话列表失败'));
    } finally {
      setSessionsLoading(false);
    }
  }, [favoriteOnly]);

  useEffect(() => {
    void (async () => {
      await reloadSessions();
      // ⚠️ 只在**首次**加载后放开右侧面板 —— 后续 reloadSessions（切「只看收藏」等）
      //    绝不能把面板重新变成 loading，否则 SessionLoader 会被卸载（见上面的注释）。
      setInitialLoading(false);
    })();
  }, [reloadSessions]);

  // ===== 从首页带参数进来 =====
  //
  //   ?q=<问题>     → 为这个问题开一个新会话，并自动把它发出去
  //   ?session=<id> → 直接打开某个会话（首页「最近会话」点进来）
  //
  // 两个参数都不带的话就是普通进入 —— 什么都不做。
  useEffect(() => {
    if (bootstrappedRef.current) {
      return;
    }
    bootstrappedRef.current = true;

    const q = searchParams.get('q');
    const sid = searchParams.get('session');

    if (q !== null && q.trim() !== '') {
      void (async () => {
        try {
          const s = await createSession();
          await reloadSessions();
          setActiveId(s.id);
          setPendingQuestion({ sessionId: s.id, text: q.trim() });
          // 把 URL 换成 session 形式 —— 刷新页面不会把这个问题再问一遍
          setSearchParams({ session: s.id }, { replace: true });
        } catch (err: unknown) {
          message.error(errorMessage(err, '新建会话失败'));
        }
      })();
      return;
    }

    if (sid !== null && sid !== '') {
      setActiveId(sid);
    }
  }, [searchParams, reloadSessions, setSearchParams]);

  /** 切会话：顺手把 URL 同步成 ?session=<id>，刷新页面还停在这个会话 */
  const selectSession = useCallback(
    (id: string): void => {
      setPendingQuestion(null);
      setActiveId(id);
      setSearchParams({ session: id }, { replace: true });
    },
    [setSearchParams],
  );

  const onNewSession = useCallback(async (): Promise<void> => {
    try {
      const s = await createSession();
      await reloadSessions();
      setPendingQuestion(null);
      setActiveId(s.id);
      setSearchParams({ session: s.id }, { replace: true });
    } catch (err: unknown) {
      message.error(errorMessage(err, '新建会话失败'));
    }
  }, [reloadSessions, setSearchParams]);

  /**
   * 自动发送完成 → 清掉「待发问题」。
   *
   * ⚠️ **必须清** —— `pendingQuestion` 以前从发送完成后就**再没被清过**
   *    （只在 selectSession / onNewSession 里清）。任何原因导致聊天面板重挂，
   *    `autoSentRef` 会归零 → 同一个问题**再自动发一遍**，多花一次 LLM 调用。
   */
  const onAutoSent = useCallback((): void => {
    setPendingQuestion(null);
  }, []);

  /** 收藏 / 取消收藏（12-e 裁定表 #7） */
  const onToggleFavorite = useCallback(
    async (s: SessionListItem): Promise<void> => {
      try {
        await setSessionFavorite(s.id);
        await reloadSessions();
      } catch (err: unknown) {
        message.error(errorMessage(err, '操作失败'));
      }
    },
    [reloadSessions],
  );

  const onDeleteSession = useCallback(
    async (id: string): Promise<void> => {
      try {
        await deleteSession(id);
        if (activeId === id) {
          setActiveId(null);
        }
        await reloadSessions();
        message.success('会话已删除');
      } catch (err: unknown) {
        message.error(errorMessage(err, '删除会话失败'));
      }
    },
    [activeId, reloadSessions],
  );

  const onRename = useCallback(async (): Promise<void> => {
    if (renaming === null) {
      return;
    }
    try {
      await renameSession(renaming.id, renameValue);
      setRenaming(null);
      await reloadSessions();
    } catch (err: unknown) {
      message.error(errorMessage(err, '重命名失败'));
    }
  }, [renameSession, reloadSessions, renameValue, renaming]);

  const sidebar = (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Flex gap={8} align="center">
        <Button type="primary" icon={<PlusOutlined />} block onClick={() => void onNewSession()}>
          新对话
        </Button>
        {/* 收起侧栏（docs/04-b §4.5「可隐藏侧栏」）。
            ⚠️ 收起**只影响侧栏自己** —— 右侧的 SessionLoader 绝不能被卸载
               （那会掐断正在流式的回答）。 */}
        <Tooltip title="收起会话列表">
          <Button
            type="text"
            icon={<MenuFoldOutlined />}
            onClick={() => setSidebarCollapsed(true)}
          />
        </Tooltip>
      </Flex>
      <Flex align="center" justify="space-between" style={{ marginTop: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {favoriteOnly ? '只看收藏' : '全部会话'}
        </Text>
        <Switch
          size="small"
          // 侧栏自己的加载态 —— 切「只看收藏」时这里转个圈，
          // **右侧聊天面板不受影响**（正在流式的回答不会被掐断）。
          loading={sessionsLoading}
          checked={favoriteOnly}
          onChange={(v) => {
            setFavoriteOnly(v);
          }}
        />
      </Flex>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 8 }}>
        {sessions.length === 0 ? (
          sessionsLoading ? (
            <Flex align="center" justify="center" style={{ padding: 16 }}>
              <Spin size="small" />
            </Flex>
          ) : (
            <Empty
              description={favoriteOnly ? '还没有收藏的会话' : '还没有对话记录，开始聊天吧'}
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            />
          )
        ) : (
          <Space orientation="vertical" size={4} style={{ width: '100%' }}>
            {sessions.map((s) => (
              <Flex
                key={s.id}
                align="center"
                gap={4}
                style={{
                  padding: '6px 8px',
                  borderRadius: 6,
                  cursor: 'pointer',
                  background: s.id === activeId ? token.colorFillQuaternary : undefined,
                }}
                onClick={() => selectSession(s.id)}
              >
                <MessageOutlined style={{ color: token.colorTextQuaternary }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Text ellipsis style={{ display: 'block' }} title={s.title ?? '未命名会话'}>
                    {s.title ?? '未命名会话'}
                  </Text>
                  {/* 最后消息时间（docs/04-b §4.5）—— 跟气泡上的时间戳同一种格式 */}
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {formatMessageTime(s.last_message_at ?? undefined) ?? ''}
                  </Text>
                </div>
                <Tooltip title={s.favorite ? '取消收藏' : '收藏'}>
                  <Button
                    type="text"
                    size="small"
                    icon={<StarOutlined />}
                    style={s.favorite ? { color: token.colorWarning } : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      void onToggleFavorite(s);
                    }}
                  />
                </Tooltip>
                <Tooltip title="重命名">
                  <Button
                    type="text"
                    size="small"
                    icon={<EditOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenaming(s);
                      setRenameValue(s.title ?? '');
                    }}
                  />
                </Tooltip>
                <Popconfirm
                  title="删除这个会话？"
                  description="会话里的所有消息会一起删除，不可恢复。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => void onDeleteSession(s.id)}
                  onPopupClick={(e) => e.stopPropagation()}
                >
                  <Button
                    type="text"
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    onClick={(e) => e.stopPropagation()}
                  />
                </Popconfirm>
              </Flex>
            ))}
          </Space>
        )}
      </div>
    </div>
  );

  return (
    // ⚠️ 高度不再写死 `calc(100vh - 190px)` —— 那个魔法数是「视口 - 顶栏 - 页脚 -
    //    Content 内边距 - 页面头」硬凑出来的，改一次布局就错。
    //    现在整页是一列 flex：`height: 100%` 跟 SharedShellLayout 的 Content 对齐，
    //    聊天区自己 `flex: 1 + minHeight: 0` 吃掉剩余空间（消息区内部滚动）。
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <PageHeader
        title="智能问答"
        subtitle="基于本租户知识库回答，答案会标注引用来源。"
      />

      {error !== null && (
        <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />
      )}

      <Flex gap={16} style={{ flex: 1, minHeight: 0 }}>
        {/* 会话侧栏（可收起） */}
        {sidebarCollapsed ? (
          <Tooltip title="展开会话列表" placement="right">
            <Button
              type="text"
              icon={<MenuUnfoldOutlined />}
              onClick={() => setSidebarCollapsed(false)}
              style={{ flexShrink: 0, alignSelf: 'flex-start' }}
            />
          </Tooltip>
        ) : (
          <Card
            size="small"
            style={{ width: 260, flexShrink: 0 }}
            styles={{ body: { height: '100%', padding: 12, display: 'flex', flexDirection: 'column' } }}
          >
            {sidebar}
          </Card>
        )}

        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRadius: 8,
            background: token.colorBgContainer,
            boxShadow: token.boxShadowTertiary,
            overflow: 'hidden',
          }}
        >
          {initialLoading ? (
            <Flex align="center" justify="center" style={{ flex: 1 }}>
              <Spin />
            </Flex>
          ) : activeId === null ? (
            <Flex align="center" justify="center" style={{ flex: 1 }}>
              <Empty description="选一个会话，或者点「新对话」开始">
                <Button type="primary" icon={<PlusOutlined />} onClick={() => void onNewSession()}>
                  新对话
                </Button>
              </Empty>
            </Flex>
          ) : (
            <SessionLoader
              key={activeId}
              sessionId={activeId}
              autoSend={pendingQuestion?.sessionId === activeId ? pendingQuestion.text : undefined}
              onAutoSent={onAutoSent}
              onSessionsChanged={() => void reloadSessions()}
            />
          )}
        </div>
      </Flex>
    </div>
  );
}

/**
 * 先把历史从 DB 拉出来，再挂聊天区。
 *
 * 为什么分两层：useChat 的 messages 选项**只在首次渲染时生效**，
 * 异步拉回来的历史塞不进已经初始化完的 hook。所以必须先渲染一个
 * 「加载中」的壳，历史到了才把带 initialMessages 的 ChatPanel 挂上去，
 * 并用 key={sessionId} 保证切会话时整个 hook 重建。
 */
function SessionLoader({
  sessionId,
  autoSend,
  onAutoSent,
  onSessionsChanged,
}: {
  sessionId: string;
  /** 挂上之后自动发出去的问题（首页 ?q= 跳过来时才有） */
  autoSend?: string | undefined;
  /** 自动发送完成后回调（父组件据此清掉「待发问题」，避免重挂后重复发送） */
  onAutoSent: () => void;
  onSessionsChanged: () => void;
}): ReactElement {
  const [initial, setInitial] = useState<ChatUIMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await fetchSessionMessages(sessionId);
        if (!cancelled) {
          setInitial(data.messages);
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(errorMessage(err, '加载历史消息失败'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (error !== null) {
    return (
      <Flex align="center" justify="center" style={{ flex: 1, padding: 24 }}>
        <Alert type="error" showIcon title={error} />
      </Flex>
    );
  }
  if (initial === null) {
    return (
      <Flex align="center" justify="center" style={{ flex: 1 }}>
        <Spin />
      </Flex>
    );
  }
  return (
    <ChatPanel
      sessionId={sessionId}
      initialMessages={initial}
      autoSend={autoSend}
      onAutoSent={onAutoSent}
      onSessionsChanged={onSessionsChanged}
    />
  );
}

function ChatPanel({
  sessionId,
  initialMessages,
  autoSend,
  onAutoSent,
  onSessionsChanged,
}: {
  sessionId: string;
  initialMessages: ChatUIMessage[];
  autoSend?: string | undefined;
  onAutoSent: () => void;
  onSessionsChanged: () => void;
}): ReactElement {
  const { token } = theme.useToken();
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * 👍/👎 反馈状态 —— **初值来自后端**（历史消息的 `metadata.feedback`）。
   *
   * ⚠️ 以前是纯前端 state，刷新后归零 → 图标回到未选中，
   *    再点一次是「又赞一次」而不是「取消」（反馈再也取消不了）。
   */
  const [feedbackMap, setFeedbackMap] = useState<Record<string, 1 | -1>>(() =>
    feedbackOf(initialMessages),
  );
  /** 📌 消息级收藏状态（初值来自后端的 `metadata.favorite`） */
  const [favoriteMap, setFavoriteMap] = useState<Record<string, boolean>>(() =>
    favoritesOf(initialMessages),
  );
  /** 正在确认中的那次工具调用（B3 HITL） */
  const [approvingToolId, setApprovingToolId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /**
   * 用户是不是「贴着底部」。
   *
   * ⚠️ 以前每有一条消息就无条件 `scrollIntoView` —— 用户往上翻历史时
   *    会被**硬拽回底部**（想看上一条的回答根本看不住）。
   *    现在离底部 > 80px 就认为用户在上翻，不再自动滚。
   */
  const stickToBottomRef = useRef(true);

  // 「思考模式」开关（docs/04-b §4.4）：本轮要不要让模型先推理再回答。
  // 用 ref 传给 transport —— transport 只在 sessionId 变化时重建，
  // 直接把 state 塞进去会被冻在创建那一刻。
  const [thinking, setThinking] = useState(false);
  const thinkingRef = useRef(false);
  useEffect(() => {
    thinkingRef.current = thinking;
  }, [thinking]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport(
        chatTransportOptions(sessionId, () => ({ thinking: thinkingRef.current })),
      ),
    [sessionId],
  );

  const { messages, sendMessage, regenerate, stop, status, error } = useChat<ChatUIMessage>({
    id: sessionId,
    messages: initialMessages,
    transport,
    onData: (part) => {
      if (part.type === 'data-status') {
        setPhase(part.data.phase);
      } else if (part.type === 'data-truncated') {
        setNotice(part.data.message);
      }
    },
    onFinish: () => {
      setPhase('idle');
      onSessionsChanged();
    },
    onError: () => {
      setPhase('idle');
    },
  });

  const busy = status === 'submitted' || status === 'streaming';
  const lastUserText = useMemo(() => lastUserTextOf(messages), [messages]);
  /**
   * 用户消息已经发出、但 assistant 消息**还没建出来**的那段窗口
   * （检索 + 查询改写 + 重排那几秒）。
   *
   * ⚠️ 后端的 `data-status` part 是 transient 的 —— transient part **不建消息**
   *    （SDK 的 processUIMessageStream：transient 直接 break，不 write），
   *    所以这段时间消息区里只有用户气泡，没有任何加载指示。
   *    规格 §4.8.5 要求这里就有「✍ 思考中...」+ `<Spin />`。
   */
  const waitingForAssistant = busy && messages[messages.length - 1]?.role === 'user';

  /**
   * 自动发出带过来的问题（首页点「推荐问题 / 资料」跳过来）。
   *
   * ⚠️ **必须延后一拍（setTimeout 0）再发，不能直接在 effect 里发**：
   *    StrictMode 下 mount effect 跑完会立刻 cleanup，而 `useChat` 在 unmount 时
   *    会调 `chat.stop()` —— `sendMessage` 内部「消息准备」阶段（第一个 await 之前）
   *    挂着 abort controller，被 stop() 一取消，消息就**永远发不出去，而且不报错**
   *    （sendMessage 正常 resolve，messages 一直空着，看起来像「卡在检索中」）。
   *    延后一拍让 cleanup 先过去，避开这个窗口。
   */
  const autoSentRef = useRef(false);
  useEffect(() => {
    if (autoSend === undefined || autoSend === '' || autoSentRef.current) {
      return;
    }
    autoSentRef.current = true;
    setPhase('retrieving');
    const timer = window.setTimeout(() => {
      // ⚠️ **先清「待发问题」再发** —— 父组件据此把 `pendingQuestion` 置空。
      //    不清的话：任何原因导致面板重挂（`autoSentRef` 归零），
      //    同一个问题会**再自动发一遍**，多花一次 LLM 调用。
      onAutoSent();
      void sendMessage({ text: autoSend });
    }, 0);
    // ⚠️ 故意**不** clearTimeout：cleanup 里清掉就等于又踩回上面那个坑
    //    （StrictMode 的 cleanup 正好跑在 timer 之前）。
    //    用户在同一个 tick 里切走会话的概率极低，代价只是白发一次请求。
  }, [autoSend, onAutoSent, sendMessage]);

  // 消息增长时滚到底 —— 但**用户已经往上翻**的时候别把他拽回来
  const onScroll = useCallback((): void => {
    const el = scrollRef.current;
    if (el === null) {
      return;
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distance <= 80;
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) {
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const onSend = useCallback((): void => {
    const text = input.trim();
    if (text === '') {
      return;
    }
    if (busy) {
      // ⚠️ 流式中按 Enter：以前**静默无效**（用户毫无反馈，还以为页面卡了）
      //    → 给一句明确提示（停止按钮就在旁边）
      message.info('正在回答中…等这一轮结束再发下一条');
      return;
    }
    setInput('');
    setNotice(null);
    setPhase('retrieving');
    void sendMessage({ text });
  }, [busy, input, sendMessage]);

  /**
   * 断流后的「重试」—— **重跑这一轮**，不是再问一遍。
   *
   * ⚠️ 以前是 `sendMessage({text: lastUserText})` → **追加一条新的用户消息**，
   *    页面上出现「同一个问题问了两遍」，DB 里也多一行。
   *    现在按消息角色分两种情况：
   *      - 已经有 assistant 行（多半是半截的）→ 重新生成它（覆盖同一行）
   *      - 还没有 assistant 行（请求根本没发出去）→ 重跑那个用户问题
   *        （用户行已经在库里，后端不会重复插）
   */
  const onRetry = useCallback((): void => {
    if (busy) {
      return;
    }
    let userIdx = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]?.role === 'user') {
        userIdx = i;
        break;
      }
    }
    const userMsg = userIdx < 0 ? undefined : messages[userIdx];
    if (userMsg === undefined) {
      return;
    }
    // 这条用户消息**之后**的 assistant（多半是失败 / 半截的）就是被重跑的那一条
    const assistant = messages[userIdx + 1];
    setNotice(null);
    setPhase('retrieving');
    if (assistant !== undefined && assistant.role === 'assistant') {
      void regenerate({ messageId: assistant.id });
    } else {
      void regenerate({ messageId: userMsg.id });
    }
  }, [busy, messages, regenerate]);

  /**
   * 确认一次敏感工具调用（B3 HITL）。
   *
   * 后端的闸门在工具执行**之前**就把调用拦下了 —— 工具并没有真的跑，
   * 模型拿到的是一个「需要确认」的工具结果。所以这里点确认之后要**让模型再调一次**
   *（同样的参数），这次闸门放行，工具才真的执行。
   *
   * 跟随的用户消息只写「确认执行」（自然一点）；
   * **「请再调一次」这件事由后端在系统提示词里提醒**
   * （见 shared/prompts/chat/tools.ts 的「待执行的确认」段）——
   * 光靠用户这一句话，模型可能回一句「好的」就完了，工具还是没跑。
   */
  const onApproveTool = useCallback(
    async (call: ToolCallRecord): Promise<void> => {
      setApprovingToolId(call.tool_call_id);
      try {
        await approveToolCall(sessionId, call.tool_name, call.args);
        message.success('已确认，正在让 AI 继续执行');
        void sendMessage({ text: '确认执行' });
      } catch (err: unknown) {
        message.error(errorMessage(err, '确认失败'));
      } finally {
        setApprovingToolId(null);
      }
    },
    [sessionId, sendMessage],
  );

  /**
   * 取消一次敏感工具调用（用户反悔）。
   *
   * 取消之后闸门会回「用户拒绝执行这个操作」，模型如实告诉用户，
   * **不会再问第三次** —— 所以这里也发一句话过去，让模型立刻收尾。
   */
  const onRejectTool = useCallback(
    async (call: ToolCallRecord): Promise<void> => {
      setApprovingToolId(call.tool_call_id);
      try {
        await rejectToolCall(sessionId, call.tool_name, call.args);
        message.success('已取消，AI 不会再执行这次调用');
        void sendMessage({ text: '取消这个操作，不用执行了' });
      } catch (err: unknown) {
        message.error(errorMessage(err, '取消失败'));
      } finally {
        setApprovingToolId(null);
      }
    },
    [sessionId, sendMessage],
  );

  const onFeedback = useCallback(
    async (messageId: string, value: 1 | -1): Promise<void> => {
      const next = feedbackMap[messageId] === value ? null : value;
      try {
        await sendFeedback(messageId, next);
        setFeedbackMap((prev) => {
          const copy = { ...prev };
          if (next === null) {
            delete copy[messageId];
          } else {
            copy[messageId] = next;
          }
          return copy;
        });
      } catch (err: unknown) {
        message.error(errorMessage(err, '反馈提交失败'));
      }
    },
    [feedbackMap],
  );

  /**
   * 📌 消息级收藏（docs/04-b §4.2 的操作行）
   *
   * 跟会话收藏是两回事：会话收藏是「这一段对话重要」，消息收藏是「这一条回答值得留着」。
   * ⚠️ 挂件页**没有**这个按钮 —— 挂件是匿名会话，收藏没有持久归属语义。
   */
  const onToggleMessageFavorite = useCallback(
    async (messageId: string): Promise<void> => {
      const next = favoriteMap[messageId] !== true;
      try {
        await setMessageFavorite(messageId, next);
        setFavoriteMap((prev) => ({ ...prev, [messageId]: next }));
      } catch (err: unknown) {
        message.error(errorMessage(err, '操作失败'));
      }
    },
    [favoriteMap],
  );

  const onCopy = useCallback(async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制');
    } catch {
      message.warning('复制失败，请手动选择文本');
    }
  }, []);

  const phaseHint =
    phase === 'retrieving'
      ? '正在检索知识库…'
      : phase === 'generating'
        ? '正在组织回答…'
        : null;

  return (
    <>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        {messages.length === 0 ? (
          <Empty
            description="问我一个关于公司制度或产品的问题，我会基于知识库回答并标出来源。"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
          />
        ) : (
          messages.map((m) =>
            m.role === 'user' ? (
              <UserBubble key={m.id} message={m} />
            ) : (
              <AssistantBubble
                key={m.id}
                message={m}
                busy={busy}
                feedback={feedbackMap[m.id]}
                favorite={favoriteMap[m.id] === true}
                onFeedback={(v) => void onFeedback(m.id, v)}
                onToggleFavorite={() => void onToggleMessageFavorite(m.id)}
                onCopy={() => void onCopy(textOf(m))}
                onRegenerate={() => {
                  setNotice(null);
                  setPhase('retrieving');
                  // ⚠️ **必须传 messageId** —— 不传的话 SDK 会重新生成
                  //    **最后一条** assistant 消息（ai/dist/index.d.ts:6151：
                  //    "If no message id is provided, the last assistant message
                  //    will be regenerated."），点哪条都作用在最后一条上。
                  void regenerate({ messageId: m.id });
                }}
                onApproveTool={(call) => void onApproveTool(call)}
                onRejectTool={(call) => void onRejectTool(call)}
                approvingToolId={approvingToolId}
              />
            ),
          )
        )}
        {/* 检索 / 改写 / 重排那几秒：用户消息已经发出去了，但 assistant 消息
            还没建出来（后端的 data-status 是 transient part，不建消息）——
            这里补一个「✍ 思考中…」指示（docs/04-b §4.8.5）。 */}
        {waitingForAssistant && (
          <Space>
            <Spin size="small" />
            <Text type="secondary">✍ 思考中…</Text>
          </Space>
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ borderTop: `1px solid ${token.colorBorderSecondary}`, padding: 12 }}>
        {notice !== null && (
          <Alert
            type="info"
            showIcon
            title={notice}
            closable
            onClose={() => setNotice(null)}
            style={{ marginBottom: 8 }}
          />
        )}
        {error !== undefined && (
          <Alert
            type="error"
            showIcon
            title={streamErrorMessage(error, '请求失败，请稍后重试')}
            action={
              // 断流后的「重试」：**重跑这一轮**，不是再问一遍
              // （以前 sendMessage 会追加一条重复的用户消息）。
              // ⚠️ 不做**自动**重试 —— 流断的时候上游可能已经算过 token 了，
              //    自动重发等于悄悄多花一次钱。让人点一下更保险。
              lastUserText !== null ? (
                <Button size="small" onClick={onRetry}>
                  重试
                </Button>
              ) : undefined
            }
            style={{ marginBottom: 8 }}
          />
        )}
        <Flex gap={12} align="center" style={{ marginBottom: 8 }} wrap>
          <Checkbox checked={thinking} onChange={(e) => setThinking(e.target.checked)}>
            思考模式
          </Checkbox>
          {/* 「联网」是 v1 占位（docs/04-b §4.3）—— 联网搜索要接外部 API，
              按裁定表属于「跨系统」不做。这里只画一个**禁用**的开关，
              ⚠️ **不接进请求体**（后端不认这个字段）。 */}
          <Tooltip title="联网搜索（暂未开放）">
            <span>
              <Checkbox disabled>联网</Checkbox>
            </span>
          </Tooltip>
          <Text type="secondary" style={{ fontSize: 12 }}>
            开启后 AI 先推理再回答（折叠在「思考过程」里）
          </Text>
        </Flex>
        <Flex gap={8} align="flex-end">
          <Input.TextArea
            value={input}
            autoSize={{ minRows: 2, maxRows: 8 }}
            placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                onSend();
              }
            }}
          />
          {busy ? (
            <Button icon={<LoadingOutlined spin />} onClick={() => stop()}>
              停止
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<SendOutlined />}
              disabled={input.trim() === ''}
              onClick={onSend}
            >
              发送
            </Button>
          )}
        </Flex>
        {phaseHint !== null && (
          <Text type="secondary" style={{ fontSize: 12 }}>
            {phaseHint}
          </Text>
        )}
      </div>
    </>
  );
}

function UserBubble({ message }: { message: ChatUIMessage }): ReactElement {
  const { token } = theme.useToken();
  const text = textOf(message);
  // 右上角小时间戳（docs/04-b §4.2）——
  // 历史消息带 created_at（后端从 messages.created_at 带出来）；
  // 实时流式的新消息没有，用本地时间兜底。
  const createdAt = message.metadata?.created_at;
  const stamp = formatMessageTime(createdAt) ?? formatMessageTime(new Date().toISOString());
  // hover 显示**完整**时间（小时间戳只到分钟）
  const fullStamp = createdAt === undefined ? '' : formatFullTime(createdAt);

  return (
    <Flex justify="flex-end" vertical align="flex-end" gap={2}>
      <Tooltip title={fullStamp === '' ? stamp : fullStamp}>
        <span style={{ fontSize: 11, color: token.colorTextTertiary, lineHeight: 1 }}>{stamp}</span>
      </Tooltip>
      <div
        style={{
          maxWidth: '76%',
          padding: '10px 14px',
          borderRadius: 12,
          borderBottomRightRadius: 4,
          background: token.colorPrimary,
          // 主色底上的文字走 token（colorTextLightSolid = 实心背景上的文字色）
          color: token.colorTextLightSolid,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </div>
    </Flex>
  );
}

function AssistantBubble({
  message: msg,
  busy,
  feedback,
  favorite,
  onFeedback,
  onToggleFavorite,
  onCopy,
  onRegenerate,
  onApproveTool,
  onRejectTool,
  approvingToolId,
}: {
  message: ChatUIMessage;
  busy: boolean;
  feedback: 1 | -1 | undefined;
  /** 📌 是否已收藏 */
  favorite: boolean;
  onFeedback: (value: 1 | -1) => void;
  onToggleFavorite: () => void;
  onCopy: () => void;
  onRegenerate: () => void;
  /** 确认一次敏感工具调用（B3 HITL） */
  onApproveTool?: ((call: ToolCallRecord) => void) | undefined;
  /** 取消一次敏感工具调用 */
  onRejectTool?: ((call: ToolCallRecord) => void) | undefined;
  approvingToolId?: string | null | undefined;
}): ReactElement {
  const { token } = theme.useToken();
  const text = textOf(msg);
  const thinking = thinkingOf(msg);
  const citations = citationsOf(msg);
  const moderation = moderationOf(msg);
  const toolCalls = toolCallsOf(msg);
  const truncated = truncatedOf(msg);
  // 没过审的回答：正文已经被后端拦下，这里不渲染原文，只显示拦截提示
  const blocked = moderation !== null && moderation.blocked;
  const isStreaming = busy && text === '';

  return (
    // ⚠️ `alignSelf: 'flex-start'` + `maxWidth` —— 外层是 `<Flex vertical>`，
    //    antd v6 在 vertical 且没显式传 align 时会加 `align-items: stretch`
    //    （antd/es/flex/utils.js:24）→ AI 回答被拉成一条**满宽的灰带**，
    //    跟右边 76% 的用户气泡完全不对称。加上这两个就是「气泡」了。
    <Flex vertical gap={8} style={{ maxWidth: '88%', alignSelf: 'flex-start' }}>
      {thinking !== '' &&
        // 流式期间直接摊开（边生成边看），跑完换成折叠的 <details>。
        // 用「两种元素」而不是受控的 open 属性 —— 受控 open 会覆盖用户手动展开/收起的意图。
        (busy ? (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              💭 思考中…
            </Text>
            <Paragraph
              style={{
                whiteSpace: 'pre-wrap',
                fontSize: 12,
                color: token.colorTextSecondary,
                marginTop: 4,
                maxHeight: 260,
                overflowY: 'auto',
              }}
            >
              {thinking}
            </Paragraph>
          </div>
        ) : (
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: token.colorTextQuaternary }}>
              💭 思考过程
            </summary>
            <Paragraph
              style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: token.colorTextSecondary, marginTop: 4 }}
            >
              {thinking}
            </Paragraph>
          </details>
        ))}

      {truncated !== null && (
        <Alert
          type="info"
          showIcon
          title={truncated.message}
          style={{ fontSize: 12 }}
        />
      )}

      {citations !== null && citations.length > 0 && <CitationList hits={citations} />}

      {toolCalls.length > 0 && (
        <ToolCallList
          calls={toolCalls}
          onApprove={onApproveTool}
          onReject={onRejectTool}
          approvingId={approvingToolId}
        />
      )}

      {isStreaming ? (
        <Space>
          <Spin size="small" />
          <Text type="secondary">思考中…</Text>
        </Space>
      ) : blocked ? (
        <Alert
          type="warning"
          showIcon
          title={moderation?.reason ?? '该回答未通过内容审核，已被拦截'}
          description="回答内容触发了安全策略，已被拦截且不会保存到对话记录。"
        />
      ) : (
        <div
          style={{
            background: token.colorBgLayout,
            borderRadius: 12,
            borderBottomLeftRadius: 4,
            padding: '10px 14px',
            wordBreak: 'break-word',
          }}
        >
          <Markdown>{text}</Markdown>
        </div>
      )}

      {!isStreaming && !blocked && text !== '' && (
        <Space size={4} wrap>
          <Tooltip title={feedback === 1 ? '已点赞' : '有帮助'}>
            <Button
              type="text"
              size="small"
              icon={feedback === 1 ? <LikeFilled /> : <LikeOutlined />}
              onClick={() => onFeedback(1)}
            />
          </Tooltip>
          <Tooltip title={feedback === -1 ? '已点踩' : '没帮助'}>
            <Button
              type="text"
              size="small"
              icon={feedback === -1 ? <DislikeFilled /> : <DislikeOutlined />}
              onClick={() => onFeedback(-1)}
            />
          </Tooltip>
          <Tooltip title="复制全文">
            <Button type="text" size="small" icon={<CopyOutlined />} onClick={onCopy} />
          </Tooltip>
          <Tooltip title="重新生成">
            <Button type="text" size="small" icon={<ReloadOutlined />} onClick={onRegenerate} />
          </Tooltip>
          {/* 📌 消息级收藏（docs/04-b §4.2）—— 收藏的是「这一条回答」，
              跟侧栏的会话收藏是两回事。 */}
          <Tooltip title={favorite ? '取消收藏' : '收藏这条回答'}>
            <Button
              type="text"
              size="small"
              icon={favorite ? <BookFilled /> : <BookOutlined />}
              style={favorite ? { color: token.colorWarning } : undefined}
              onClick={onToggleFavorite}
            />
          </Tooltip>
        </Space>
      )}
    </Flex>
  );
}

/**
 * 引用片段卡片 —— 视觉沿用 admin 检索测试页的 HitCard（docs/04-c §5.3），
 * 数据来自 SSE 里的 data-citations part，编号与 AI 回答里的 [n] 一一对应。
 */
function CitationList({ hits }: { hits: CitationHit[] }): ReactElement {
  const { token } = theme.useToken();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {hits.map((h) => (
        <Card
          key={`${h.doc_id}-${h.chunk_index}`}
          size="small"
          style={{
            borderLeft: `3px solid ${h.sources.length > 1 ? token.colorSuccess : token.colorBorder}`,
            background: token.colorFillQuaternary,
          }}
          styles={{ body: { padding: 10 } }}
        >
          <Flex gap={8} align="center" wrap style={{ marginBottom: 4 }}>
            <Tag color="blue">{h.index}</Tag>
            <Text strong style={{ fontSize: 13 }}>
              {h.source}
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              第 {h.chunk_index + 1} 段
            </Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              相关度 {h.score.toFixed(2)}
            </Text>
            {h.sources.map((s) => (
              <Tag key={s} color={s === 'vector' ? 'geekblue' : 'purple'}>
                {s === 'vector' ? '语义' : '关键词'}
              </Tag>
            ))}
          </Flex>
          <Paragraph
            type="secondary"
            style={{ fontSize: 12, marginBottom: 0, whiteSpace: 'pre-wrap' }}
            ellipsis={{ rows: 3, expandable: true, symbol: '展开原文' }}
          >
            {h.text}
          </Paragraph>
        </Card>
      ))}
    </div>
  );
}