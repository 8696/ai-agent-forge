import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfigProvider,
  Drawer,
  Dropdown,
  Empty,
  Flex,
  Input,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd';
import type { MenuProps } from 'antd';
import {
  CloseOutlined,
  CopyOutlined,
  HistoryOutlined,
  LoadingOutlined,
  LogoutOutlined,
  PaperClipOutlined,
  PlusOutlined,
  ReloadOutlined,
  SendOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';
import type { ChatUIMessage, CitationHit } from '@shared/types/chat';
import { Markdown } from '../../components/Markdown';
import { BrandMark } from '../../components/shell';
import { ToolCallList, toolCallsOf, type ToolCallRecord } from '../../components/ToolCallList';
import { formatMessageTime } from '../../lib/datetime';
import { formatFullTime } from '../../lib/customerChat';
import { WidgetCollapsed, WidgetLayout } from '../../layouts/widget/WidgetLayout';
import {
  approveWidgetToolCall,
  clearWidgetToken,
  createWidgetSession,
  fetchWidgetInfo,
  readWidgetToken,
  rejectWidgetToolCall,
  resumeWidgetSession,
  widgetErrorMessage,
  writeWidgetToken,
} from './widgetApi';

/**
 * 公开聊天挂件 —— E1（docs/12-e-需求-业务接入与平台运营.md §E1）
 *
 * UI 规格：docs/04-b-ui-登录与聊天挂件.md §4.1-4.3（浮层 / 消息气泡 / 输入区）
 * 后端：src/gateway/public/widget-routes.ts（SSE 流式，免登录）
 *
 * 与 /customer 聊天页的区别：
 *   - **不需要登录**：没有 JWT，访客直接就能聊
 *   - 会话靠一枚**匿名 token** 认领（存在 localStorage），关掉浏览器再打开能接着聊
 *   - 没有会话列表、没有 👍👎 反馈（反馈要绑定登录用户，匿名场景没地方存）
 *
 * 页面结构做成「浮层」形态：中间一张悬浮的客服面板，右下角一个悬浮的圆形按钮
 * （面板关闭时出现，点它重新打开）—— 这是挂件被嵌到别人网站上的真实形态。
 */

const { Text, Paragraph } = Typography;

type Phase = 'idle' | 'retrieving' | 'generating';

/**
 * 挂件的「紧凑模式」（docs/04-a §1.2）—— 边距更小、字号略小、控件更矮。
 *
 * 规格要求「AntD 主题 token 临时覆盖」—— 这里用一层 `ConfigProvider` 把
 * 整个挂件内容区（页头 / 消息区 / 输入区）都套上。
 */
const COMPACT_TOKEN = {
  fontSize: 13,
  controlHeight: 30,
  paddingXS: 6,
  paddingSM: 8,
  borderRadius: 8,
} as const;

/** 从一条 assistant 消息的 parts 里取出引用片段 */
function citationsOf(m: ChatUIMessage): CitationHit[] | null {
  for (const part of m.parts) {
    if (part.type === 'data-citations') {
      return part.data.hits;
    }
  }
  return null;
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
 * 前端把气泡正文换成拦截提示（原文已经流到浏览器了，收不回来）。
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
 * ⚠️ 这个 part **会落库**（不是 transient），所以刷新页面后历史里也带着它。
 */
function truncatedOf(m: ChatUIMessage): { dropped_turns: number; message: string } | null {
  for (const part of m.parts) {
    if (part.type === 'data-truncated') {
      return part.data;
    }
  }
  return null;
}

export function WidgetPage(): ReactElement {
  const params = useParams();
  const tenantCode = params['tenantCode'] ?? '';
  // 底板颜色跟深色模式走 —— 写死浅色的话，暗色下挂件整页是白底。
  // ⚠️ 叫 uiToken 不叫 token：这个文件里 `token` 已经被「匿名会话 token」占用了
  // （readWidgetToken / ensureSession），同名会互相遮蔽。
  const { token: uiToken } = theme.useToken();

  const [tenantName, setTenantName] = useState<string>('');
  const [initialMessages, setInitialMessages] = useState<ChatUIMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  // 首屏：拿租户名 + （有 token 的话）恢复上一段对话
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await fetchWidgetInfo(tenantCode);
        if (cancelled) {
          return;
        }
        setTenantName(info.tenant_name);

        const token = readWidgetToken(tenantCode);
        if (token === null) {
          setInitialMessages([]);
          return;
        }
        try {
          const session = await resumeWidgetSession(tenantCode, token);
          if (!cancelled) {
            setInitialMessages(session.messages);
          }
        } catch (err: unknown) {
          // token 失效（换密钥 / 会话被删）→ 清掉本地凭证，重新开一段
          clearWidgetToken(tenantCode);
          if (!cancelled) {
            setInitialMessages([]);
          }
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(widgetErrorMessage(err, '加载失败'));
          setInitialMessages([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantCode]);

  if (error !== null) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 24,
          background: uiToken.colorBgLayout,
        }}
      >
        <Card style={{ maxWidth: 420, width: '100%' }}>
          <Alert type="error" showIcon title="客服不可用" description={error} />
        </Card>
      </div>
    );
  }

  if (!open) {
    return (
      <ConfigProvider theme={{ token: COMPACT_TOKEN }}>
        <WidgetCollapsed onOpen={() => setOpen(true)} />
      </ConfigProvider>
    );
  }

  return (
    // 紧凑模式（docs/04-a §1.2）：整个挂件内容区（页头 / 消息区 / 输入区）都套上紧凑 token
    <ConfigProvider theme={{ token: COMPACT_TOKEN }}>
      <WidgetLayout>
        {initialMessages === null ? (
          <Flex align="center" justify="center" style={{ flex: 1 }}>
            <Spin />
          </Flex>
        ) : (
          <WidgetChat
            tenantCode={tenantCode}
            tenantName={tenantName}
            initialMessages={initialMessages}
            onClose={() => setOpen(false)}
          />
        )}
      </WidgetLayout>
    </ConfigProvider>
  );
}

/**
 * 聊天区（页头 + 消息区 + 输入区）。
 *
 * 会话是**懒创建**的：访客只是打开页面看看的话，不会在库里留下一条空会话；
 * 真正发出第一条消息时才建（prepareSendMessagesRequest 里 await 建会话）。
 */
function WidgetChat({
  tenantCode,
  tenantName,
  initialMessages,
  onClose,
}: {
  tenantCode: string;
  tenantName: string;
  initialMessages: ChatUIMessage[];
  onClose: () => void;
}): ReactElement {
  const { token: uiToken } = theme.useToken();
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  /** 消息区滚动容器（用来判断用户是不是已经往上翻了） */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 当前匿名会话的 token（null = 还没建会话） */
  const tokenRef = useRef<string | null>(null);
  /** 正在确认 / 取消中的那次工具调用 */
  const [approvingToolId, setApprovingToolId] = useState<string | null>(null);

  const ensureSession = useCallback(async (): Promise<string> => {
    if (tokenRef.current !== null) {
      return tokenRef.current;
    }
    const created = await createWidgetSession(tenantCode);
    tokenRef.current = created.token;
    writeWidgetToken(tenantCode, created.token);
    return created.token;
  }, [tenantCode]);

  /**
   * 确认 / 取消一次敏感工具调用（B3 HITL）。
   *
   * 挂件是匿名会话，但**会话本身是 token 认领来的**（ensureSession），
   * 所以这里照样能确认 —— 之前挂件里 AI 说「请确认」，用户点不了任何按钮，
   * 是个死路。
   */
  const onApproveTool = useCallback(
    async (call: ToolCallRecord): Promise<void> => {
      setApprovingToolId(call.tool_call_id);
      try {
        const token = await ensureSession();
        await approveWidgetToolCall(tenantCode, token, call.tool_name, call.args);
        void sendMessage({ text: '确认执行' });
      } catch (err: unknown) {
        message.error(widgetErrorMessage(err, '确认失败'));
      } finally {
        setApprovingToolId(null);
      }
    },
    [ensureSession, tenantCode],
  );

  const onRejectTool = useCallback(
    async (call: ToolCallRecord): Promise<void> => {
      setApprovingToolId(call.tool_call_id);
      try {
        const token = await ensureSession();
        await rejectWidgetToolCall(tenantCode, token, call.tool_name, call.args);
        void sendMessage({ text: '取消这个操作，不用执行了' });
      } catch (err: unknown) {
        message.error(widgetErrorMessage(err, '取消失败'));
      } finally {
        setApprovingToolId(null);
      }
    },
    [ensureSession, tenantCode],
  );

  // 「历史记录」抽屉（docs/04-a §2.3「用户头像菜单：登录 / 退出 / 历史记录」）
  const [historyOpen, setHistoryOpen] = useState(false);

  // 「思考模式」开关（docs/04-b §4.4）。用 ref 传进 transport ——
  // transport 只建一次，直接把 state 塞进去会被冻在创建那一刻。
  const [thinking, setThinking] = useState(false);
  const thinkingRef = useRef(false);
  useEffect(() => {
    thinkingRef.current = thinking;
  }, [thinking]);

  const transport = useMemo(
    () =>
      new DefaultChatTransport<ChatUIMessage>({
        api: `/api/v1/public/widget/${encodeURIComponent(tenantCode)}/messages`,
        prepareSendMessagesRequest: async ({ id, messages, trigger, messageId, body }) => {
          // 发出第一条消息前才建会话
          const token = await ensureSession();
          return {
            // ⚠️ 用了 prepareSendMessagesRequest 就得自己把 messages / id / trigger 带上
            //    （不接这个回调时 SDK 才自动补）
            // thinking：用户本轮要不要开「思考模式」（docs/04-b §4.4）
            body: { ...body, id, messages, trigger, messageId, thinking: thinkingRef.current },
            headers: { 'x-widget-token': token },
          };
        },
      }),
    [tenantCode, ensureSession],
  );

  const { messages, sendMessage, regenerate, stop, status, error, setMessages } =
    useChat<ChatUIMessage>({
      id: `widget-${tenantCode}`,
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
      },
      onError: () => {
        setPhase('idle');
      },
    });

  const busy = status === 'submitted' || status === 'streaming';
  const lastUserText = useMemo(() => lastUserTextOf(messages), [messages]);
  /**
   * 用户是不是「贴着底部」——
   * 往上翻历史时不要被硬拽回底部（见下面的 onScroll）。
   */
  const stickToBottomRef = useRef(true);
  /**
   * 用户消息已经发出、但 assistant 消息**还没建出来**的那段窗口
   * （检索 + 查询改写 + 重排那几秒）—— 那段时间消息区里只有用户气泡。
   */
  const waitingForAssistant = busy && messages[messages.length - 1]?.role === 'user';

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
      // 流式中按 Enter：以前**静默无效** → 给一句明确提示
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
   * ⚠️ 以前是 `sendMessage({text})` → 追加一条**重复**的用户消息。
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
    const assistant = messages[userIdx + 1];
    setNotice(null);
    setPhase('retrieving');
    if (assistant !== undefined && assistant.role === 'assistant') {
      void regenerate({ messageId: assistant.id });
    } else {
      void regenerate({ messageId: userMsg.id });
    }
  }, [busy, messages, regenerate]);

  const onNewConversation = useCallback((): void => {
    // 丢掉本地的匿名会话凭证 + 清空气泡；下一条消息会触发新建会话
    clearWidgetToken(tenantCode);
    tokenRef.current = null;
    setMessages([]);
    setNotice(null);
    setPhase('idle');
  }, [setMessages, tenantCode]);

  const onCopy = useCallback(async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      message.success('已复制');
    } catch {
      // 剪贴板不可用（http / 无权限）—— 提示一下，不打断对话
      message.warning('复制失败，请手动选择文本');
    }
  }, []);

  const phaseHint =
    phase === 'retrieving'
      ? '正在检索知识库…'
      : phase === 'generating'
        ? '正在组织回答…'
        : null;

  /**
   * 用户头像菜单（docs/04-a §2.3）—— 公开挂件没有登录态，这三项对应：
   *   - 历史记录：把当前会话的完整记录摊开看（小弹窗里回看长对话比在主区里滚方便）
   *   - 登录账号：跳到租户前台登录页（**新标签打开** —— 挂件通常嵌在 iframe 里，
   *     直接跳会把整个 iframe 换成登录页，访客原来的对话就没了）
   *   - 退出：忘掉这个浏览器的匿名记录，重新开始
   */
  const userMenuItems: MenuProps['items'] = [
    {
      key: 'history',
      icon: <HistoryOutlined />,
      label: '历史记录',
      onClick: () => setHistoryOpen(true),
    },
    {
      key: 'login',
      icon: <UserOutlined />,
      label: '登录账号',
      onClick: () => {
        const url = `/customer/login?tenant_code=${encodeURIComponent(tenantCode)}`;
        window.open(url, '_blank', 'noopener,noreferrer');
      },
    },
    { type: 'divider' },
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: '退出（清掉本机记录）',
      onClick: onNewConversation,
    },
  ];

  return (
    <>
      {/* ===== 页头（docs/04-b §4.1 / docs/04-a §1.2）==== */}
      <div
        style={{
          flexShrink: 0,
          // ⚠️ 规格 §1.2 写的是 **40px**（以前写死 52px，跟规格对不上）
          height: 40,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 12px 0 12px',
          borderBottom: `1px solid ${uiToken.colorBorder}`,
          background: uiToken.colorBgContainer,
        }}
      >
        {/* 公司 Logo —— 用平台统一的 BrandMark，不再是 🏢 emoji */}
        <BrandMark size="sm" text="" />
        <Text strong ellipsis style={{ maxWidth: 320, fontSize: 14 }}>
          {tenantName === '' ? '在线客服' : `${tenantName} 客服`}
        </Text>
        <Tag color="green" style={{ marginInlineEnd: 0 }}>
          在线
        </Tag>
        <div style={{ flex: 1 }} />
        <Tooltip title="开始一段新对话（清空当前记录）">
          <Button type="text" size="small" icon={<PlusOutlined />} onClick={onNewConversation}>
            新对话
          </Button>
        </Tooltip>
        <Dropdown menu={{ items: userMenuItems }} trigger={['click']}>
          <Tooltip title="历史记录 / 登录 / 退出">
            <Button type="text" size="small" icon={<UserOutlined />} />
          </Tooltip>
        </Dropdown>
        {/* ⚠️ 这个 × 不是「关掉页面」—— 它把挂件**收起**成右下角那个悬浮圆钮，
            点圆钮能再展开。文案要说清楚，否则用户以为页面被关掉了。 */}
        <Tooltip title="收起挂件">
          <Button type="text" size="small" icon={<CloseOutlined />} onClick={onClose} />
        </Tooltip>
      </div>

      {/* ===== 消息区 ===== */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          background: uiToken.colorBgContainer,
        }}
      >
        {messages.length === 0 ? (
          <Empty
            description="你好！问我一个关于公司制度或产品的问题，我会基于知识库回答并标出来源。"
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
                onCopy={() => void onCopy(textOf(m))}
                onApproveTool={(call) => void onApproveTool(call)}
                onRejectTool={(call) => void onRejectTool(call)}
                approvingToolId={approvingToolId}
                onRegenerate={() => {
                  setNotice(null);
                  setPhase('retrieving');
                  // ⚠️ **必须传 messageId** —— 不传的话 SDK 重新生成的是
                  //    **最后一条** assistant 消息（点哪条都作用在最后一条上）。
                  void regenerate({ messageId: m.id });
                }}
              />
            ),
          )
        )}
        {/* 检索 / 改写 / 重排那几秒：assistant 消息还没建出来 */}
        {waitingForAssistant && (
          <Space>
            <Spin size="small" />
            <Text type="secondary">✍ 思考中…</Text>
          </Space>
        )}
        <div ref={bottomRef} />
      </div>

      {/* ===== 输入区（docs/04-b §4.3）==== */}
      {/* ⚠️ 上边框原来写死 `rgba(5,5,5,0.06)` —— 写死的浅色在深色模式下几乎看不见，
          一律走 token。 */}
      <div style={{ flexShrink: 0, borderTop: `1px solid ${uiToken.colorBorder}`, padding: 12 }}>
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
            title={widgetErrorMessage(error, '请求失败，请稍后重试')}
            action={
              // 断流后的「重试」—— **重跑这一轮**，不是再问一遍
              // ⚠️ 不做自动重试（上游可能已经算过 token 了）
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
          <Tooltip title="联网搜索（本期未开放）">
            <Checkbox disabled>联网</Checkbox>
          </Tooltip>
          <Tooltip title="附件上传（本期未开放）">
            <Button type="text" size="small" disabled icon={<PaperClipOutlined />}>
              附件
            </Button>
          </Tooltip>
          <div style={{ flex: 1 }} />
          <Button type="text" size="small" icon={<PlusOutlined />} onClick={onNewConversation}>
            新对话
          </Button>
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

      {/* ===== 历史记录抽屉（docs/04-a §2.3）=====
          小弹窗里回看长对话比在主消息区里往上滚方便 —— 抽屉是全高的。 */}
      <Drawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        title="历史记录"
        // ⚠️ 用 `size` 不用 `width` —— antd v6 废弃了 `width`（控制台会刷警告）。
        // v6 的 `size` 接受数字（`Drawer.js`：isNumber(size) → 当宽度用），
        // 所以这里的动态窄屏适配能原样保留。
        size={Math.min(420, typeof window === 'undefined' ? 420 : window.innerWidth - 40)}
        styles={{ body: { padding: 16 } }}
      >
        {messages.length === 0 ? (
          <Empty description="还没有对话记录，开始聊天吧" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Flex vertical gap={16}>
            {messages.map((m) =>
              m.role === 'user' ? (
                <UserBubble key={m.id} message={m} />
              ) : (
                <AssistantBubble
                  key={m.id}
                  message={m}
                  busy={false}
                  // ⚠️ 以前这里是 `onCopy={() => undefined}` —— 点了**没反应**
                  onCopy={() => void onCopy(textOf(m))}
                  onRegenerate={() => undefined}
                  onApproveTool={() => undefined}
                  onRejectTool={() => undefined}
                  approvingToolId={null}
                />
              ),
            )}
          </Flex>
        )}
      </Drawer>
    </>
  );
}

/** 用户气泡 —— 右对齐，主题色背景白字（docs/04-b §4.2） */
function UserBubble({ message }: { message: ChatUIMessage }): ReactElement {
  const { token: uiToken } = theme.useToken();
  const text = textOf(message);
  // 右上角小时间戳（docs/04-b §4.2）——
  // 历史消息带 created_at（后端从 messages.created_at 带出来）；
  // 实时流式的新消息没有，用本地时间兜底。
  const createdAt = message.metadata?.created_at;
  const stamp =
    formatMessageTime(createdAt) ?? formatMessageTime(new Date().toISOString());
  // hover 显示**完整**时间（小时间戳只到分钟）
  const fullStamp = createdAt === undefined ? '' : formatFullTime(createdAt);

  return (
    <Flex justify="flex-end" vertical align="flex-end" gap={2}>
      <Tooltip title={fullStamp === '' ? stamp : fullStamp}>
        <span style={{ fontSize: 11, color: uiToken.colorTextTertiary, lineHeight: 1 }}>{stamp}</span>
      </Tooltip>
      <div
        style={{
          maxWidth: '76%',
          padding: '10px 14px',
          borderRadius: 12,
          borderBottomRightRadius: 4,
          background: uiToken.colorPrimary,
          // 主色底上的文字走 token（colorTextLightSolid = 实心背景上的文字色）
          color: uiToken.colorTextLightSolid,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {text}
      </div>
    </Flex>
  );
}

/**
 * AI 气泡 —— 左对齐，浅灰背景，Markdown 渲染（docs/04-b §4.2）
 *
 * 没有 👍👎：反馈要绑定登录用户，挂件是匿名的，没地方存。
 */
function AssistantBubble({
  message: msg,
  busy,
  onCopy,
  onRegenerate,
  onApproveTool,
  onRejectTool,
  approvingToolId,
}: {
  message: ChatUIMessage;
  busy: boolean;
  onCopy: () => void;
  onRegenerate: () => void;
  onApproveTool?: ((call: ToolCallRecord) => void) | undefined;
  onRejectTool?: ((call: ToolCallRecord) => void) | undefined;
  approvingToolId?: string | null | undefined;
}): ReactElement {
  const { token: uiToken } = theme.useToken();
  const text = textOf(msg);
  const thinking = thinkingOf(msg);
  const citations = citationsOf(msg);
  const moderation = moderationOf(msg);
  const truncated = truncatedOf(msg);
  const toolCalls = toolCallsOf(msg);
  const blocked = moderation !== null && moderation.blocked;
  const isStreaming = busy && text === '';

  return (
    // ⚠️ `alignSelf: 'flex-start'` + `maxWidth` —— 外层是 `<Flex vertical>`，
    //    antd v6 在 vertical 且没显式传 align 时会加 `align-items: stretch`
    //    → AI 回答被拉成一条满宽的灰带，跟右边 76% 的用户气泡不对称。
    <Flex vertical gap={8} style={{ maxWidth: '88%', alignSelf: 'flex-start' }}>
      {thinking !== '' &&
        // 流式期间直接摊开（边生成边看），跑完换成折叠的 <details>
        (busy ? (
          <div>
            <Text type="secondary" style={{ fontSize: 12 }}>
              💭 思考中…
            </Text>
            <Paragraph
              style={{
                whiteSpace: 'pre-wrap',
                fontSize: 12,
                color: uiToken.colorTextSecondary,
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
            <summary style={{ cursor: 'pointer', fontSize: 12, color: uiToken.colorTextTertiary }}>
              💭 思考过程
            </summary>
            <Paragraph
              style={{ whiteSpace: 'pre-wrap', fontSize: 12, color: uiToken.colorTextSecondary, marginTop: 4 }}
            >
              {thinking}
            </Paragraph>
          </details>
        ))}

      {truncated !== null && (
        <Alert type="info" showIcon title={truncated.message} style={{ fontSize: 12 }} />
      )}

      {citations !== null && citations.length > 0 && <CitationList hits={citations} />}

      {/* 工具调用卡片（B3）。挂件虽然是匿名会话，但会话是 token 认领来的，
          所以敏感工具照样能确认 / 取消。 */}
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
            background: uiToken.colorBgLayout,
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
 * 引用片段卡片 —— 文档名 + 段号 + 相关度 + 召回标签，正文可展开（docs/04-b §4.2）
 */
function CitationList({ hits }: { hits: CitationHit[] }): ReactElement {
  const { token: uiToken } = theme.useToken();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {hits.map((h) => (
        <Card
          key={`${h.doc_id}-${h.chunk_index}`}
          size="small"
          style={{
            borderLeft: `3px solid ${
              h.sources.length > 1 ? uiToken.colorSuccess : uiToken.colorBorder
            }`,
            background: uiToken.colorBgSpotlight,
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
