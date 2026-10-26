import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Drawer, Empty, Progress, Space, Table, Tag, Tooltip, Typography, message, theme } from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined, SwapOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import { PageHeader } from '../../components/shell/PageHeader';
import { Chart } from '../../components/Chart';
import {
  evaluationErrorMessage,
  fetchRunDetail,
  fetchRuns,
  type EvaluationResult,
  type EvaluationRun,
  type Pagination,
} from '../../lib/adminEvaluation';

const { Paragraph, Text } = Typography;

/**
 * 四个评分维度 —— 配色不写死 hex，而是记「用哪个 token」，
 * 实际颜色在组件里用 theme.useToken() 取（深浅色自动切换）。
 */
const DIMENSIONS = [
  { key: 'accuracy', label: '准确性', colorToken: 'colorPrimary' },
  { key: 'completeness', label: '完整性', colorToken: 'colorSuccess' },
  { key: 'style', label: '风格', colorToken: 'colorWarning' },
  { key: 'safety', label: '安全性', colorToken: 'colorError' },
] as const;

/**
 * /admin/evaluation/runs —— 评测结果（D1）
 *
 * 需求验收：「故意改坏提示词 → 分数下降 ≥ 10% → 控制台告警条出现」。
 * 这一页就是把「分数下降」变成能看见的东西：
 *   - 折线图：每次跑批的四维分数（看趋势）
 *   - 列表：每次跑批的分数 + 成本
 *   - 明细：每条题的得分和裁判理由（分数掉了能定位到哪道题）
 *
 * 跑批是后台异步的（一次 50 题 = 100 次 LLM 调用），
 * 所以有 run 在跑的时候这一页会自动轮询。
 *
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.6.2
 */
export function EvaluationRunsPage(): ReactElement {
  const [rows, setRows] = useState<EvaluationRun[] | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  // 勾选两次跑批 → 「对比」按钮跳到 A/B 对比页
  const [selected, setSelected] = useState<string[]>([]);
  const navigate = useNavigate();

  const [detail, setDetail] = useState<{
    run: EvaluationRun;
    results: EvaluationResult[];
    stats: { p95_latency_ms: number; max_cost: number; avg_cost: number };
  } | null>(null);

  // 图表 / 维度标签的配色走 antd token —— 写死 hex 的话暗色模式下对不上
  const { token } = theme.useToken();
  const dimensions = useMemo(
    () => DIMENSIONS.map((d) => ({ ...d, color: token[d.colorToken] })),
    [token],
  );

  const load = async (): Promise<void> => {
    setErrMsg(null);
    try {
      const res = await fetchRuns({ page, page_size: 20 });
      setRows(res.runs);
      setPagination(res.pagination);
    } catch (err: unknown) {
      setRows(null);
      setErrMsg(evaluationErrorMessage(err, '加载评测结果失败'));
    }
  };

  useEffect(() => {
    void load();
  }, [page]);

  // 有跑批在进行中时自动轮询（跑批是后台异步的，页面得自己刷新进度）
  const hasRunning = useMemo(() => (rows ?? []).some((r) => r.status === 'running'), [rows]);
  useEffect(() => {
    if (!hasRunning) return undefined;
    const timer = setInterval(() => {
      void load();
    }, 5000);
    return () => clearInterval(timer);
  }, [hasRunning]);

  const openDetail = async (run: EvaluationRun): Promise<void> => {
    try {
      const res = await fetchRunDetail(run.id, { page: 1, page_size: 100 });
      setDetail({ run: res.run, results: res.results, stats: res.stats });
    } catch (err: unknown) {
      setDetail(null);
      message.error(evaluationErrorMessage(err, '加载跑批详情失败'));
    }
  };

  const trendOption = useMemo(() => {
    // 列表是倒序（新的在前），画图要正序
    const ordered = [...(rows ?? [])].reverse();
    return {
      tooltip: { trigger: 'axis' },
      // type:'scroll' —— 窄容器里四项图例会挤成一坨互相压字
      legend: { type: 'scroll', data: dimensions.map((d) => d.label) },
      grid: { left: 50, right: 20, top: 40, bottom: 40 },
      xAxis: {
        type: 'category',
        data: ordered.map((r) => new Date(r.started_at).toLocaleString('zh-CN')),
      },
      yAxis: { type: 'value', min: 0, max: 5, name: '分数' },
      series: dimensions.map((d) => ({
        name: d.label,
        type: 'line',
        smooth: true,
        data: ordered.map((r) => r[d.key]),
        itemStyle: { color: d.color },
      })),
    };
  }, [rows, dimensions]);

  const columns: TableColumnsType<EvaluationRun> = [
    {
      title: '开始时间',
      dataIndex: 'started_at',
      key: 'started_at',
      width: 180,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '评测集',
      dataIndex: 'dataset_name',
      key: 'dataset_name',
      ellipsis: true,
      render: (n: string | null) => n ?? '—',
    },
    {
      title: '提示词版本',
      dataIndex: 'prompt_version',
      key: 'prompt_version',
      width: 130,
      render: (v: string | null) =>
        v === null ? <Tag>内置默认</Tag> : <Tag color="blue">{v}</Tag>,
    },
    {
      title: '触发方式',
      dataIndex: 'trigger',
      key: 'trigger',
      width: 150,
      render: (v: EvaluationRun['trigger'], row: EvaluationRun) =>
        v === 'prompt_regression' ? (
          <Tooltip title={`提示词发布后自动跑的小规模回归（只跑了前 ${row.item_limit ?? '?'} 题）`}>
            <Tag color="purple">提示词回归</Tag>
          </Tooltip>
        ) : (
          <Tag>手动</Tag>
        ),
    },
    {
      title: '模型',
      dataIndex: 'model',
      key: 'model',
      width: 150,
      ellipsis: true,
      render: (m: string | null) => m ?? '—',
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 140,
      render: (s: string, row) => {
        if (s === 'running') {
          return (
            <Space size={6}>
              <Progress
                type="circle"
                size={18}
                percent={row.total_items === 0 ? 0 : Math.round((row.completed_items / row.total_items) * 100)}
                format={() => ''}
              />
              <Text type="secondary">
                {row.completed_items}/{row.total_items}
              </Text>
            </Space>
          );
        }
        if (s === 'failed') {
          return <Tag color="red">失败</Tag>;
        }
        return <Tag color="green">完成</Tag>;
      },
    },
    {
      title: '总分',
      dataIndex: 'total_score',
      key: 'total_score',
      width: 100,
      render: (v: number | null) =>
        v === null ? <span style={{ color: token.colorTextTertiary }}>—</span> : `${v.toFixed(2)} / 5`,
    },
    {
      title: '四维',
      key: 'dims',
      width: 240,
      render: (_: unknown, row) => (
        <Space size={4} wrap>
          {dimensions.map((d) => (
            <Tag key={d.key} style={{ fontSize: 11 }}>
              {d.label} {row[d.key] === null ? '—' : row[d.key]?.toFixed(1)}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '成本',
      dataIndex: 'total_cost',
      key: 'total_cost',
      width: 100,
      render: (c: number) => `$${c.toFixed(4)}`,
    },
  ];

  return (
    <div>
      <PageHeader
        title="评测结果"
        subtitle="每次跑批的四维分数与趋势。分数掉了先看折线图定位是哪一维，再点进去看裁判理由。"
        breadcrumb={[{ title: '首页' }, { title: '评测' }, { title: '评测结果' }]}
        extra={
          <Space>
            <Button
              icon={<SwapOutlined />}
              disabled={selected.length !== 2}
              onClick={() => {
                const a = selected[0] ?? '';
                const b = selected[1] ?? '';
                navigate(
                  `/admin/evaluation/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`,
                );
              }}
            >
              对比选中的两次
            </Button>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
          </Space>
        }
      />

      {errMsg !== null && (
        <Alert type="error" showIcon title={errMsg} style={{ marginBottom: 16 }} />
      )}

      {hasRunning && (
        <Alert
          type="info"
          showIcon
          title="有评测正在后台跑，每 5 秒自动刷新一次进度"
          style={{ marginBottom: 16 }}
        />
      )}

      <Card title="分数趋势" style={{ marginBottom: 16 }}>
        {(rows ?? []).length === 0 ? (
          <Empty description="还没有跑批记录，先去「评测集」页跑一次" />
        ) : (
          <Chart option={trendOption} height={300} />
        )}
      </Card>

      <Card>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={rows ?? []}
          loading={rows === null}
          tableLayout="fixed"
          rowSelection={{
            type: 'checkbox',
            selectedRowKeys: selected,
            onSelect: (record: EvaluationRun, checked: boolean) => {
              setSelected((prev) =>
                checked
                  ? // 最多选两次 —— 多了就把最早选的那个挤掉
                    [...prev, record.id].slice(-2)
                  : prev.filter((id) => id !== record.id),
              );
            },
          }}
          onRow={(row) => ({
            onClick: () => {
              void openDetail(row);
            },
            style: { cursor: 'pointer' },
          })}
          pagination={{
            current: pagination?.page ?? page,
            pageSize: 20,
            total: pagination?.total ?? 0,
            showTotal: (total) => `共 ${total} 次`,
            onChange: (p) => setPage(p),
          }}
          locale={{ emptyText: rows === null ? '加载中…' : '还没有跑批记录' }}
        />
      </Card>

      <Drawer
        open={detail !== null}
        title={
          detail === null
            ? ''
            : `跑批详情 · ${detail.run.dataset_name ?? ''} · ${new Date(detail.run.started_at).toLocaleString()}`
        }
        size={860}
        onClose={() => setDetail(null)}
        destroyOnHidden
      >
        {detail !== null && (
          <>
            <Space size={24} wrap style={{ marginBottom: 16 }}>
              {dimensions.map((d) => (
                <div key={d.key}>
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {d.label}
                  </Text>
                  <div style={{ fontSize: 20, fontWeight: 600 }}>
                    {detail.run[d.key] === null ? '—' : detail.run[d.key]?.toFixed(2)}
                    <span style={{ fontSize: 12, fontWeight: 400, color: token.colorTextTertiary }}>
                      {' '}
                      / 5
                    </span>
                  </div>
                </div>
              ))}
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  花费
                </Text>
                <div style={{ fontSize: 20, fontWeight: 600 }}>
                  ${detail.run.total_cost.toFixed(4)}
                </div>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  p95 延迟
                </Text>
                <div style={{ fontSize: 20, fontWeight: 600 }}>
                  {detail.stats.p95_latency_ms} ms
                </div>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  单条最高成本
                </Text>
                <div style={{ fontSize: 20, fontWeight: 600 }}>
                  ${detail.stats.max_cost.toFixed(4)}
                </div>
              </div>
            </Space>

            {detail.run.error_message !== null && (
              <Alert type="error" showIcon title="失败原因" description={detail.run.error_message} style={{ marginBottom: 16 }} />
            )}

            {detail.results.length === 0 ? (
              <Empty description="这次跑批还没有产生明细" />
            ) : (
              detail.results.map((r) => (
                <Card key={r.id} size="small" style={{ marginBottom: 8 }}>
                  <Space orientation="vertical" size={6} style={{ width: '100%' }}>
                    <Text strong>{r.question}</Text>
                    <Paragraph
                      style={{ margin: 0, fontSize: 13 }}
                      ellipsis={{ rows: 4, expandable: true, symbol: '展开回答' }}
                    >
                      {r.answer}
                    </Paragraph>
                    <Space wrap size={4}>
                      {dimensions.map((d) => (
                        <Tag key={d.key} color={r.scores[d.key] >= 4 ? 'green' : r.scores[d.key] >= 3 ? 'gold' : 'red'}>
                          {d.label} {r.scores[d.key]}
                        </Tag>
                      ))}
                      {r.latency_ms !== null && (
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {r.latency_ms} ms
                        </Text>
                      )}
                    </Space>
                    {r.judge_reason !== null && (
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        裁判理由：{r.judge_reason}
                      </Text>
                    )}
                  </Space>
                </Card>
              ))
            )}
          </>
        )}
      </Drawer>
    </div>
  );
}
