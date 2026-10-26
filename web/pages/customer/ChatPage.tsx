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
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  LikeFilled,
  LikeOutlined,
  DislikeFilled,
  DislikeOutlined,
  LoadingOutlined,
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
  setSessionFavorite,
  renameSession,
  sendFeedback,
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<SessionListItem | null>(null);
  /** 只看收藏的会话（12-e 裁定表 #7） */
  const [favoriteOnly, setFavoriteOnly] = useState(false);
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
    try {
      const data = await fetchSessions(1, 50, favoriteOnly);
      setSessions(data.sessions);
      setError(null);
    } catch (err: unknown) {
      setError(errorMessage(err, '加载会话列表失败'));
    }
  }, [favoriteOnly]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await reloadSessions();
      setLoading(false);
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
      <Button type="primary" icon={<PlusOutlined />} block onClick={() => void onNewSession()}>
        新对话
      </Button>
      <Flex align="center" justify="space-between" style={{ marginTop: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {favoriteOnly ? '只看收藏' : '全部会话'}
        </Text>
        <Switch
          size="small"
          checked={favoriteOnly}
          onChange={(v) => {
            setFavoriteOnly(v);
          }}
        />
      </Flex>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 8 }}>
        {sessions.length === 0 ? (
          <Empty description="还没有会话" image={Empty.PRESENTED_IMAGE_SIMPLE} />
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
                  background: s.id === activeId ? 'rgba(47, 84, 235, 0.08)' : undefined,
                }}
                onClick={() => selectSession(s.id)}
              >
                <MessageOutlined style={{ color: token.colorTextQuaternary }} />
                <Text
                  ellipsis
                  style={{ flex: 1, minWidth: 0 }}
                  title={s.title ?? '未命名会话'}
                >
                  {s.title ?? '未命名会话'}
                </Text>
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
    <div>
      <PageHeader
        title="智能问答"
        subtitle="基于本租户知识库回答，答案会标注引用来源。"
        extra={
          <Button
            icon={<PlusOutlined />}
            onClick={() => void onNewSession()}
            style={{ display: 'none' }}
          />
        }
      />

      {error !== null && (
        <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />
      )}

      <Flex gap={16} style={{ height: 'calc(100vh - 190px)', minHeight: 420 }}>
        {/* 会话侧栏 */}
        <Card
          size="small"
          style={{ width: 260, flexShrink: 0 }}
          styles={{ body: { height: '100%', padding: 12, display: 'flex', flexDirection: 'column' } }}
        >
          {sidebar}
        </Card>

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
          {loading ? (
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
  onSessionsChanged,
}: {
  sessionId: string;
  /** 挂上之后自动发出去的问题（首页 ?q= 跳过来时才有） */
  autoSend?: string | undefined;
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
      onSessionsChanged={onSessionsChanged}
    />
  );
}

function ChatPanel({
  sessionId,
  initialMessages,
  autoSend,
  onSessionsChanged,
}: {
  sessionId: string;
  initialMessages: ChatUIMessage[];
  autoSend?: string | undefined;
  onSessionsChanged: () => void;
}): ReactElement {
  const { token } = theme.useToken();
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [feedbackMap, setFeedbackMap] = useState<Record<string, 1 | -1>>({});
  /** 正在确认中的那次工具调用（B3 HITL） */
  const [approvingToolId, setApprovingToolId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

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
      void sendMessage({ text: autoSend });
    }, 0);
    // ⚠️ 故意**不** clearTimeout：cleanup 里清掉就等于又踩回上面那个坑
    //    （StrictMode 的 cleanup 正好跑在 timer 之前）。
    //    用户在同一个 tick 里切走会话的概率极低，代价只是白发一次请求。
  }, [autoSend, sendMessage]);

  // 消息增长时滚到底
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  const onSend = useCallback((): void => {
    const text = input.trim();
    if (text === '' || busy) {
      return;
    }
    setInput('');
    setNotice(null);
    setPhase('retrieving');
    void sendMessage({ text });
  }, [busy, input, sendMessage]);

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
                onFeedback={(v) => void onFeedback(m.id, v)}
                onCopy={() => void onCopy(textOf(m))}
                onRegenerate={() => {
                  setNotice(null);
                  regenerate();
                }}
                onApproveTool={(call) => void onApproveTool(call)}
                onRejectTool={(call) => void onRejectTool(call)}
                approvingToolId={approvingToolId}
              />
            ),
          )
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
              // 断流后的「重试」：把刚才那条问题重发一遍。
              // ⚠️ 不做**自动**重试 —— 流断的时候上游可能已经算过 token 了，
              //    自动重发等于悄悄多花一次钱。让人点一下更保险。
              lastUserText !== null ? (
                <Button size="small" onClick={() => void sendMessage({ text: lastUserText })}>
                  重试
                </Button>
              ) : undefined
            }
            style={{ marginBottom: 8 }}
          />
        )}
        <Flex gap={12} align="center" style={{ marginBottom: 8 }}>
          <Checkbox checked={thinking} onChange={(e) => setThinking(e.target.checked)}>
            思考模式
          </Checkbox>
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
  const stamp = formatMessageTime(message.metadata?.created_at) ?? formatMessageTime(new Date().toISOString());

  return (
    <Flex justify="flex-end" vertical align="flex-end" gap={2}>
      <span style={{ fontSize: 11, color: token.colorTextTertiary, lineHeight: 1 }}>{stamp}</span>
      <div
        style={{
          maxWidth: '76%',
          padding: '10px 14px',
          borderRadius: 12,
          borderBottomRightRadius: 4,
          background: token.colorPrimary,
          color: '#fff',
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
  onFeedback,
  onCopy,
  onRegenerate,
  onApproveTool,
  onRejectTool,
  approvingToolId,
}: {
  message: ChatUIMessage;
  busy: boolean;
  feedback: 1 | -1 | undefined;
  onFeedback: (value: 1 | -1) => void;
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
    <Flex vertical gap={8} style={{ maxWidth: '100%' }}>
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
            borderLeft: `3px solid ${h.sources.length > 1 ? '#52c41a' : token.colorBorder}`,
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