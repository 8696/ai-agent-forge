import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Descriptions, Empty, Space, Tag, Typography } from 'antd';
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../../components/shell/PageHeader';
import {
  fetchTraceDetail,
  observabilityErrorMessage,
  type TraceDetail,
  type TraceSpan,
} from '../../lib/adminObservability';

const { Text, Paragraph } = Typography;

/** span 的 kind → 中文名 + 颜色 */
const SPAN_KIND_META: Record<string, { label: string; color: string }> = {
  http: { label: 'HTTP 路由', color: 'blue' },
  retrieval: { label: '知识库检索', color: 'cyan' },
  llm: { label: '模型调用', color: 'purple' },
  guard: { label: '安全审核', color: 'volcano' },
  cost: { label: '成本记账', color: 'gold' },
  storage: { label: '存储', color: 'green' },
  step: { label: '步骤', color: 'default' },
};

function spanMeta(kind: string): { label: string; color: string } {
  return SPAN_KIND_META[kind] ?? { label: kind, color: 'default' };
}

/**
 * /admin/observability/traces/:id —— Trace 详情（D2）
 *
 * 上半部分是这次对话的关键指标，下半部分是**时间线**：
 * 每个 span 一行（检索 / 模型调用 / 记账…），点开看入参出参摘要。
 *
 * 「哪一步慢」是这一页存在的唯一理由 —— 总耗时只能告诉你「有问题」，
 * 时间线才能告诉你「问题在哪」。
 *
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.7.2
 */
export function ObservabilityTraceDetailPage(): ReactElement {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<TraceDetail | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [openSpan, setOpenSpan] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    setErrMsg(null);
    try {
      setDetail(await fetchTraceDetail(id));
    } catch (err: unknown) {
      setDetail(null);
      setErrMsg(observabilityErrorMessage(err, '加载 trace 详情失败'));
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (errMsg !== null) {
    return (
      <div>
        <PageHeader
          title="Trace 详情"
          breadcrumb={[{ title: '首页' }, { title: '观测' }, { title: 'Trace 详情' }]}
        />
        <Alert type="error" showIcon message={errMsg} style={{ marginBottom: 16 }} />
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/admin/observability/traces')}>
          返回列表
        </Button>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div>
        <PageHeader title="Trace 详情" />
        <Card>
          <Empty description="加载中…" />
        </Card>
      </div>
    );
  }

  const t = detail.trace;
  const totalSpanMs = detail.spans.reduce((acc, s) => acc + (s.duration_ms ?? 0), 0);

  return (
    <div>
      <PageHeader
        title="Trace 详情"
        subtitle={`${t.name} · ${new Date(t.started_at).toLocaleString()}`}
        breadcrumb={[
          { title: '首页' },
          { title: '观测' },
          { title: 'Trace 列表' },
          { title: 'Trace 详情' },
        ]}
        extra={
          <>
            <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/admin/observability/traces')}>
              返回
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
          </>
        }
      />

      <Card style={{ marginBottom: 16 }} title="关键指标">
        <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }} bordered>
          <Descriptions.Item label="总耗时">
            {t.duration_ms === null ? '—' : `${t.duration_ms} ms`}
          </Descriptions.Item>
          <Descriptions.Item label="输入 token">
            {t.input_tokens.toLocaleString('zh-CN')}
          </Descriptions.Item>
          <Descriptions.Item label="输出 token">
            {t.output_tokens.toLocaleString('zh-CN')}
          </Descriptions.Item>
          <Descriptions.Item label="成本">${t.cost.toFixed(6)}</Descriptions.Item>
          <Descriptions.Item label="状态">
            <Tag color={t.status === 'success' ? 'green' : 'red'}>
              {t.status === 'success' ? '成功' : '失败'}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="模型">{t.model ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="渠道">{t.channel ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="会话">
            <Text copyable={{ text: t.session_id ?? '' }} style={{ fontSize: 12 }}>
              {t.session_id ?? '—'}
            </Text>
          </Descriptions.Item>
        </Descriptions>

        {t.error_message !== null && (
          <Alert
            type="error"
            showIcon
            message="失败原因"
            description={t.error_message}
            style={{ marginTop: 16 }}
          />
        )}
      </Card>

      <Card
        title="时间线"
        extra={
          <Text type="secondary" style={{ fontSize: 12 }}>
            各段耗时合计 {totalSpanMs} ms（总耗时 {t.duration_ms ?? 0} ms，含串行等待）
          </Text>
        }
      >
        {detail.spans.length === 0 ? (
          <Empty description="这次调用没有记录 span" />
        ) : (
          detail.spans.map((span: TraceSpan) => {
            const meta = spanMeta(span.kind);
            const expanded = openSpan === span.id;
            return (
              <Card
                key={span.id}
                size="small"
                style={{ marginBottom: 8 }}
                styles={{ body: { padding: 12 } }}
                onClick={() => setOpenSpan(expanded ? null : span.id)}
              >
                <Space orientation="vertical" size={6} style={{ width: '100%' }}>
                  <Space wrap size={8}>
                    <Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace' }}>
                      {new Date(span.started_at).toLocaleTimeString()}
                    </Text>
                    <Tag color={meta.color}>{meta.label}</Tag>
                    <Text strong>{span.name}</Text>
                    <Text type="secondary">{span.duration_ms ?? 0} ms</Text>
                    {span.status === 'error' && <Tag color="red">失败</Tag>}
                  </Space>
                  {span.error_message !== null && (
                    <Text type="danger" style={{ fontSize: 12 }}>
                      {span.error_message}
                    </Text>
                  )}
                  {expanded && (
                    <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                      <JsonBlock title="入参" value={span.input} />
                      <JsonBlock title="出参" value={span.output} />
                    </Space>
                  )}
                </Space>
              </Card>
            );
          })
        )}
      </Card>
    </div>
  );
}

function JsonBlock({
  title,
  value,
}: {
  title: string;
  value: Record<string, unknown> | null;
}): ReactElement {
  if (value === null || Object.keys(value).length === 0) {
    return (
      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {title}：（无）
        </Text>
      </div>
    );
  }
  return (
    <div>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {title}
      </Text>
      <Paragraph
        style={{
          margin: 0,
          fontSize: 12,
          fontFamily: 'monospace',
          background: 'rgba(0,0,0,0.03)',
          padding: 8,
          borderRadius: 4,
          whiteSpace: 'pre-wrap',
        }}
      >
        {JSON.stringify(value, null, 2)}
      </Paragraph>
    </div>
  );
}
