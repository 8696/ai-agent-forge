import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Card, Col, Empty, Flex, Row, Space, Spin, Tag, Typography, theme } from 'antd';
import {
  ArrowRightOutlined,
  BookOutlined,
  FileTextOutlined,
  MessageOutlined,
  PlusOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import type { SessionListItem } from '@shared/types/chat';
import type { UserMemoryItem } from '@shared/types/memory';
import {
  fetchCustomerDocuments,
  fetchProfile,
  type CustomerDocumentItem,
  type CustomerProfile,
} from '../../lib/customerHome';
import { fetchMyMemories } from '../../lib/customerMemory';
import { errorMessage, fetchSessions } from '../../lib/customerChat';
import { PageHeader } from '../../components/shell';

/**
 * B7 · 租户前台首页 `/customer` —— 用户中心工作台
 * 详见 docs/12-b-需求-ai对话能力.md §B7 / docs/04-b-ui-登录与聊天挂件.md §4.10
 *
 * 之前 `/customer` 和 `/customer/chat` 指向同一个 ChatPage —— 首页这个位置
 * 是空着的，用户登录后只看到一列会话 + 右边一片空白。
 *
 * 现在的分工：
 *   /customer       首页 = 概览 + 入口（欢迎语 / 最近会话 / 知识库 / 我的记忆）
 *   /customer/chat  智能问答 = 纯对话
 *
 * 四张卡片的数据来源全是**已经存在**的端点，只有 profile / documents 是新加的：
 *   欢迎区    GET /api/v1/customer/profile      （新）
 *   最近会话  GET /api/v1/customer/sessions
 *   知识库    GET /api/v1/customer/documents     （新）
 *   我的记忆  GET /api/v1/customer/memories?limit=3
 *
 * 四个请求用 allSettled 并行 —— 任何一个挂了都只降级那一块，不白屏。
 */

const { Text, Paragraph } = Typography;

/** 首页各块展示的上限 */
const RECENT_SESSION_LIMIT = 5;
const DOCUMENT_LIMIT = 6;
const MEMORY_PREVIEW_LIMIT = 3;

export function HomePage(): ReactElement {
  const { token } = theme.useToken();
  const navigate = useNavigate();

  const [profile, setProfile] = useState<CustomerProfile | null>(null);
  const [sessions, setSessions] = useState<SessionListItem[]>([]);
  const [documents, setDocuments] = useState<CustomerDocumentItem[]>([]);
  const [documentTotal, setDocumentTotal] = useState(0);
  const [memories, setMemories] = useState<UserMemoryItem[]>([]);
  const [memoryTotal, setMemoryTotal] = useState(0);
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  /**
   * 每块**各自**的加载态。
   * ⚠️ 刻意**没有**一个全局 loading 闸门：早先用 `Promise.allSettled` 然后统一
   * `setLoading(false)`，结果是最慢的那个接口决定整页什么时候出内容 ——
   * 慢的接口能把整页卡住。现在各块自己转自己的圈，谁先回来谁先显示。
   */
  const [profileLoading, setProfileLoading] = useState(true);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [documentsLoading, setDocumentsLoading] = useState(true);
  const [memoriesLoading, setMemoriesLoading] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);

  const load = useCallback(async (): Promise<void> => {
    setProfileLoading(true);
    setSessionsLoading(true);
    setDocumentsLoading(true);
    setMemoriesLoading(true);
    setErrors([]);

    const failed: string[] = [];
    const note = (msg: string): void => {
      failed.push(msg);
      setErrors([...failed]);
    };

    void fetchProfile()
      .then((data) => setProfile(data))
      .catch((err: unknown) => note(errorMessage(err, '加载租户信息失败')))
      .finally(() => setProfileLoading(false));

    void fetchSessions(1, RECENT_SESSION_LIMIT)
      .then((data) => setSessions(data.sessions))
      .catch((err: unknown) => note(errorMessage(err, '加载会话列表失败')))
      .finally(() => setSessionsLoading(false));

    void fetchCustomerDocuments(DOCUMENT_LIMIT)
      .then((data) => {
        setDocuments(data.documents);
        setDocumentTotal(data.total);
      })
      .catch((err: unknown) => note(errorMessage(err, '加载知识库失败')))
      .finally(() => setDocumentsLoading(false));

    void fetchMyMemories({ status: 'active', limit: MEMORY_PREVIEW_LIMIT })
      .then((data) => {
        setMemories(data.memories);
        setMemoryTotal(data.total);
        setMemoryEnabled(data.memory_enabled);
      })
      .catch((err: unknown) => note(errorMessage(err, '加载我的记忆失败')))
      .finally(() => setMemoriesLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 点推荐问题 / 点资料 → 开新会话问这个问题 */
  const ask = useCallback(
    (question: string): void => {
      navigate(`/customer/chat?q=${encodeURIComponent(question)}`);
    },
    [navigate],
  );

  /** 点最近会话 → 打开那个会话 */
  const openSession = useCallback(
    (id: string): void => {
      navigate(`/customer/chat?session=${encodeURIComponent(id)}`);
    },
    [navigate],
  );

  const tenantName = profile?.tenant.name ?? '';
  /**
   * 欢迎语兜底**要带租户名**（docs/04-b §4.10「没配就按租户名兜底出一句默认文案」）。
   * 以前兜底文案是「这里可以基于本租户的知识库提问…」—— 租户名一个字都没有。
   */
  const welcomeMessage =
    profile?.home.welcome_message !== undefined && profile.home.welcome_message !== ''
      ? profile.home.welcome_message
      : tenantName === ''
        ? '这里可以基于知识库提问，回答会标注引用来源。'
        : `欢迎来到${tenantName}，这里可以基于本租户的知识库提问，回答会标注引用来源。`;
  /**
   * 推荐问题**最多 8 条**（docs/04-b §4.10「3~8 条」）——
   * 租户配了 20 条就渲染 20 条会把首页撑爆。
   */
  const suggested = (profile?.home.suggested_questions ?? []).slice(0, 8);

  return (
    <div>
      <PageHeader
        title={tenantName === '' ? '用户中心' : tenantName}
        subtitle="基于本租户知识库的问答工作台"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => {
              // ⚠️ 带上**第一个推荐问题** —— 以前跳到 /customer/chat（不带 ?q=），
              //    右栏是空态，用户还得再点一次「新对话」才能开始。
              const first = suggested[0];
              if (first !== undefined && first !== '') {
                navigate(`/customer/chat?q=${encodeURIComponent(first)}`);
                return;
              }
              navigate('/customer/chat');
            }}
          >
            开始新的提问
          </Button>
        }
      />

      {errors.length > 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title="部分内容没能加载出来"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          }
        />
      )}

      {/*
        ⚠️ 刻意**没有**全局 loading 闸门 —— 各块自己转自己的圈。
        慢的接口不该把整页卡住（详见 load() 的注释）。
      */}
      <>
        <Card
          size="small"
          style={{
            marginBottom: 16,
            background: token.colorFillQuaternary,
            borderLeft: `3px solid ${token.colorPrimary}`,
          }}
        >
          <Text style={{ fontSize: 16, fontWeight: 600 }}>
            {profileLoading ? '欢迎' : `你好${tenantName === '' ? '' : `，${tenantName}`}`}
          </Text>
          <Paragraph type="secondary" style={{ marginTop: 6, marginBottom: 0 }}>
            {profileLoading ? '正在加载…' : welcomeMessage}
          </Paragraph>

          {suggested.length > 0 && (
              <>
                <Text
                  type="secondary"
                  style={{ fontSize: 13, display: 'block', marginTop: 16, marginBottom: 8 }}
                >
                  你可以这样问
                </Text>
                <Row gutter={[10, 10]}>
                  {suggested.map((q) => (
                    <Col xs={24} sm={12} lg={8} key={q}>
                      <Card
                        size="small"
                        hoverable
                        onClick={() => ask(q)}
                        styles={{ body: { padding: '10px 12px' } }}
                      >
                        <Flex gap={8} align="start">
                          <QuestionCircleOutlined style={{ color: token.colorPrimary, marginTop: 3 }} />
                          <Text style={{ fontSize: 13 }}>{q}</Text>
                        </Flex>
                      </Card>
                    </Col>
                  ))}
                </Row>
              </>
            )}
          </Card>

          {/* ===== 三张小卡 ===== */}
          <Row gutter={[16, 16]}>
            {/* 最近会话 */}
            <Col xs={24} lg={8}>
              <Card
                size="small"
                title="最近会话"
                style={{ height: '100%' }}
                extra={
                  <Button type="link" size="small" onClick={() => navigate('/customer/chat')}>
                    全部
                  </Button>
                }
              >
                {sessionsLoading ? (
                  <Flex align="center" justify="center" style={{ padding: '28px 0' }}>
                    <Spin size="small" />
                  </Flex>
                ) : sessions.length === 0 ? (
                  <Empty
                    description="还没有对话记录，开始聊天吧"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    style={{ margin: '24px 0' }}
                  >
                    <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => navigate('/customer/chat')}>
                      问第一个问题
                    </Button>
                  </Empty>
                ) : (
                  <Space orientation="vertical" size={2} style={{ width: '100%' }}>
                    {sessions.map((s) => (
                      <Flex
                        key={s.id}
                        align="center"
                        gap={8}
                        style={{ padding: '6px 4px', borderRadius: 6, cursor: 'pointer' }}
                        onClick={() => openSession(s.id)}
                      >
                        <MessageOutlined style={{ color: token.colorTextQuaternary }} />
                        <Text ellipsis style={{ flex: 1, minWidth: 0 }} title={s.title ?? '未命名会话'}>
                          {s.title ?? '未命名会话'}
                        </Text>
                        <Text type="secondary" style={{ fontSize: 12, flexShrink: 0 }}>
                          {relativeTime(s.last_message_at ?? s.started_at)}
                        </Text>
                      </Flex>
                    ))}
                  </Space>
                )}
              </Card>
            </Col>

            {/* 知识库概览 */}
            <Col xs={24} lg={8}>
              <Card
                size="small"
                title="知识库"
                style={{ height: '100%' }}
                extra={
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    共 {documentTotal} 份资料
                  </Text>
                }
              >
                {documentsLoading ? (
                  <Flex align="center" justify="center" style={{ padding: '28px 0' }}>
                    <Spin size="small" />
                  </Flex>
                ) : documents.length === 0 ? (
                  <Empty
                    description="知识库还没有资料"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    style={{ margin: '24px 0' }}
                  />
                ) : (
                  <Space orientation="vertical" size={2} style={{ width: '100%' }}>
                    {documents.map((d) => (
                      <Flex
                        key={d.id}
                        align="center"
                        gap={8}
                        style={{ padding: '6px 4px', borderRadius: 6, cursor: 'pointer' }}
                        onClick={() => ask(`关于《${stripExtension(d.title)}》，有哪些重点？`)}
                      >
                        <FileTextOutlined style={{ color: token.colorTextQuaternary }} />
                        <Text ellipsis style={{ flex: 1, minWidth: 0 }} title={d.title}>
                          {stripExtension(d.title)}
                        </Text>
                        {d.status === 'ready' ? null : (
                          <Tag color={d.status === 'failed' ? 'red' : 'gold'} style={{ marginInlineEnd: 0 }}>
                            {d.status === 'failed' ? '索引失败' : '索引中'}
                          </Tag>
                        )}
                      </Flex>
                    ))}
                    {documentTotal > documents.length && (
                      <Text type="secondary" style={{ fontSize: 12, paddingLeft: 4 }}>
                        还有 {documentTotal - documents.length} 份，问的时候会自动检索
                      </Text>
                    )}
                  </Space>
                )}
              </Card>
            </Col>

            {/* 我的记忆 */}
            <Col xs={24} lg={8}>
              <Card
                size="small"
                title="我的记忆"
                style={{ height: '100%' }}
                extra={
                  <Button
                    type="link"
                    size="small"
                    onClick={() => navigate('/customer/memories')}
                    icon={<ArrowRightOutlined />}
                  >
                    管理
                  </Button>
                }
              >
                {memoriesLoading ? (
                  <Flex align="center" justify="center" style={{ padding: '28px 0' }}>
                    <Spin size="small" />
                  </Flex>
                ) : !memoryEnabled ? (
                  <Empty
                    description="自动记忆已关闭，AI 不会再记住关于你的事"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    style={{ margin: '24px 0' }}
                  >
                    <Button size="small" onClick={() => navigate('/customer/memories')}>
                      去开启
                    </Button>
                  </Empty>
                ) : memories.length === 0 ? (
                  <Empty
                    description="AI 还没记住关于你的事"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    style={{ margin: '24px 0' }}
                  >
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      多聊几轮，它会自动记住你的偏好
                    </Text>
                  </Empty>
                ) : (
                  <>
                    <Text type="secondary" style={{ fontSize: 13 }}>
                      系统记得关于你的 {memoryTotal} 件事
                    </Text>
                    <Space orientation="vertical" size={2} style={{ width: '100%', marginTop: 8 }}>
                      {memories.map((m) => (
                        <Flex key={m.id} align="center" gap={8}>
                          <BookOutlined style={{ color: token.colorTextQuaternary }} />
                          <Text ellipsis style={{ flex: 1, minWidth: 0 }} title={m.content}>
                            {m.content}
                          </Text>
                        </Flex>
                      ))}
                    </Space>
                  </>
                )}
              </Card>
            </Col>
          </Row>
        </>
    </div>
  );
}

/** 去掉文件名后缀 —— 「员工手册.pdf」→「员工手册」（Word 已从上传格式里去掉） */
function stripExtension(title: string): string {
  return title.replace(/\.(pdf|md|markdown|txt)$/i, '');
}

/** 相对时间：会话列表里用「3 分钟前」比「2026-10-24 20:50:11」好读 */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) {
    return '';
  }
  const diff = Date.now() - then;
  if (diff < 60_000) {
    return '刚刚';
  }
  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)} 分钟前`;
  }
  if (diff < 86_400_000) {
    return `${Math.floor(diff / 3_600_000)} 小时前`;
  }
  if (diff < 7 * 86_400_000) {
    return `${Math.floor(diff / 86_400_000)} 天前`;
  }
  const d = new Date(then);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
