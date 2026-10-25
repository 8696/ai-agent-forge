import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import { Alert, Button, Card, Descriptions, Empty, Tag, Typography, theme } from 'antd';
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons';
import { useNavigate, useParams } from 'react-router-dom';
import { PageHeader } from '../../components/shell/PageHeader';
import { TraceTimeline } from '../../components/TraceTimeline';
import {
  fetchTraceDetail,
  observabilityErrorMessage,
  type TraceDetail,
} from '../../lib/adminObservability';

const { Text } = Typography;

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
        <Alert type="error" showIcon title={errMsg} style={{ marginBottom: 16 }} />
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
            title="失败原因"
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
        <TraceTimeline spans={detail.spans} />
      </Card>
    </div>
  );
}

