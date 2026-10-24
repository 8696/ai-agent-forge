import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Flex,
  Input,
  Popconfirm,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
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
} from '@ant-design/icons';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import type { ChatUIMessage, CitationHit, SessionListItem } from '@shared/types/chat';
import {
  chatTransportOptions,
  createSession,
  deleteSession,
  errorMessage,
  fetchSessionMessages,
  fetchSessions,
  renameSession,
  sendFeedback,
  streamErrorMessage,
} from '../../lib/customerChat';
import { PageHeader } from '../../components/shell';

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

export function ChatPage(): ReactElement {
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<SessionListItem | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const reloadSessions = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchSessions();
      setSessions(data.sessions);
      setError(null);
    } catch (err: unknown) {
      setError(errorMessage(err, '加载会话列表失败'));
    }
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await reloadSessions();
      setLoading(false);
    })();
  }, [reloadSessions]);

  const onNewSession = useCallback(async (): Promise<void> => {
    try {
      const s = await createSession();
      await reloadSessions();
      setActiveId(s.id);
    } catch (err: unknown) {
      message.error(errorMessage(err, '新建会话失败'));
    }
  }, [reloadSessions]);

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
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 12 }}>
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
                onClick={() => setActiveId(s.id)}
              >
                <MessageOutlined style={{ color: 'rgba(0,0,0,0.45)' }} />
                <Text
                  ellipsis
                  style={{ flex: 1, minWidth: 0 }}
                  title={s.title ?? '未命名会话'}
                >
                  {s.title ?? '未命名会话'}
                </Text>
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
        <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
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
            background: '#fff',
            boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
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
  onSessionsChanged,
}: {
  sessionId: string;
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
        <Alert type="error" showIcon message={error} />
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
      onSessionsChanged={onSessionsChanged}
    />
  );
}

function ChatPanel({
  sessionId,
  initialMessages,
  onSessionsChanged,
}: {
  sessionId: string;
  initialMessages: ChatUIMessage[];
  onSessionsChanged: () => void;
}): ReactElement {
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const [feedbackMap, setFeedbackMap] = useState<Record<string, 1 | -1>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const transport = useMemo(
    () => new DefaultChatTransport(chatTransportOptions(sessionId)),
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
              <UserBubble key={m.id} text={textOf(m)} />
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
              />
            ),
          )
        )}
        <div ref={bottomRef} />
      </div>

      <div style={{ borderTop: '1px solid rgba(5,5,5,0.06)', padding: 12 }}>
        {notice !== null && (
          <Alert
            type="info"
            showIcon
            message={notice}
            closable
            onClose={() => setNotice(null)}
            style={{ marginBottom: 8 }}
          />
        )}
        {error !== undefined && (
          <Alert
            type="error"
            showIcon
            message={streamErrorMessage(error, '请求失败，请稍后重试')}
            style={{ marginBottom: 8 }}
          />
        )}
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

function UserBubble({ text }: { text: string }): ReactElement {
  return (
    <Flex justify="flex-end">
      <div
        style={{
          maxWidth: '76%',
          padding: '10px 14px',
          borderRadius: 12,
          borderBottomRightRadius: 4,
          background: '#2f54eb',
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
}: {
  message: ChatUIMessage;
  busy: boolean;
  feedback: 1 | -1 | undefined;
  onFeedback: (value: 1 | -1) => void;
  onCopy: () => void;
  onRegenerate: () => void;
}): ReactElement {
  const text = textOf(msg);
  const thinking = thinkingOf(msg);
  const citations = citationsOf(msg);
  const moderation = moderationOf(msg);
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
                color: 'rgba(0,0,0,0.65)',
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
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'rgba(0,0,0,0.45)' }}>
              💭 思考过程
            </summary>
            <Paragraph
              style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: 'rgba(0,0,0,0.65)', marginTop: 4 }}
            >
              {thinking}
            </Paragraph>
          </details>
        ))}

      {citations !== null && citations.length > 0 && <CitationList hits={citations} />}

      {isStreaming ? (
        <Space>
          <Spin size="small" />
          <Text type="secondary">思考中…</Text>
        </Space>
      ) : blocked ? (
        <Alert
          type="warning"
          showIcon
          message={moderation?.reason ?? '该回答未通过内容审核，已被拦截'}
          description="回答内容触发了安全策略，已被拦截且不会保存到对话记录。"
        />
      ) : (
        <div
          style={{
            background: '#f5f7fa',
            borderRadius: 12,
            borderBottomLeftRadius: 4,
            padding: '10px 14px',
            wordBreak: 'break-word',
          }}
        >
          <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
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
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {hits.map((h) => (
        <Card
          key={`${h.doc_id}-${h.chunk_index}`}
          size="small"
          style={{
            borderLeft: `3px solid ${h.sources.length > 1 ? '#52c41a' : '#d9d9d9'}`,
            background: '#fafafa',
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