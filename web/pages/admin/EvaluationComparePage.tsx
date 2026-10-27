import type { ReactElement, ReactNode } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../components/shell/PageHeader';
import {
  evaluationErrorMessage,
  fetchRunComparison,
  fetchRuns,
  type EvaluationRun,
  type RunComparison,
  type RunComparisonItem,
} from '../../lib/adminEvaluation';

const { Paragraph, Text } = Typography;

/**
 * /admin/evaluation/compare —— A/B 对比（docs/12-e 裁定表 表 4）
 *
 * ## 它解决什么
 *
 * 提示词改一版到底有没有变好？原来的办法是：
 * 「发布 → 等生效 → 手动跑一次 → 去跑批列表里看那条折线」。
 *
 * 折线图把**所有**跑批混在一条线上（不区分评测集、不区分提示词版本），
 * 根本看不出「这一版比上一版好还是差」。
 *
 * 这一页把两次跑批**并排放**：四维 + 总分的差值、token / 成本的差值，
 * 以及**逐题**谁更好、谁更差 —— 差在哪道题上直接能定位。
 *
 * ## 前提：跑批时能指定提示词版本
 *
 * 跑批入口现在接受 `prompt_version`（不传 = 跟随租户当前生效的版本）。
 * 没有这个能力，「A/B 对比」就只能是「切生效指针 → 跑 → 再切 → 跑」，
 * 中间任何一次别的操作都会让两次跑批不是你想比的那两版。
 *
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.6.3
 */

/** 结论的展示文案与配色 */
const VERDICT_VIEW: Record<
  RunComparisonItem['verdict'],
  { label: string; color: string }
> = {
  better: { label: 'B 更好', color: 'green' },
  worse: { label: 'B 更差', color: 'red' },
  same: { label: '持平', color: 'default' },
  only_a: { label: '只有 A 有', color: 'gold' },
  only_b: { label: '只有 B 有', color: 'blue' },
};

/** 提示词版本的展示名（null / chat-v1 都算「内置默认」） */
function promptLabel(run: EvaluationRun): string {
  if (run.prompt_version === null || run.prompt_version === 'chat-v1') {
    return '内置默认';
  }
  return run.prompt_version;
}

export function EvaluationComparePage(): ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const [runs, setRuns] = useState<EvaluationRun[] | null>(null);
  const [aId, setAId] = useState<string>(searchParams.get('a') ?? '');
  const [bId, setBId] = useState<string>(searchParams.get('b') ?? '');
  const [comparison, setComparison] = useState<RunComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  // 图表 / 标签的配色走 antd token —— 写死 hex 的话暗色模式下对不上
  const { token } = theme.useToken();

  /** 组件还活着吗 —— 避免卸载后 setState */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const loadRuns = async (): Promise<void> => {
    try {
      const res = await fetchRuns({ page: 1, page_size: 100 });
      if (!aliveRef.current) return;
      setRuns(res.runs);
    } catch (err: unknown) {
      if (!aliveRef.current) return;
      setRuns(null);
      setErrMsg(evaluationErrorMessage(err, '加载跑批列表失败'));
    }
  };

  useEffect(() => {
    void loadRuns();
  }, []);

  /**
   * URL → state 的回写。
   *
   * ⚠️ 以前只写不读：URL 里的 `?a=&b=` 选了之后**不回写** ——
   *    用户按浏览器后退时 URL 变了但对比内容不变（state 还是旧的）。
   */
  useEffect(() => {
    const nextA = searchParams.get('a') ?? '';
    const nextB = searchParams.get('b') ?? '';
    setAId((prev) => (prev === nextA ? prev : nextA));
    setBId((prev) => (prev === nextB ? prev : nextB));
  }, [searchParams]);

  // 选了两次跑批才拉对比 —— 没选满不该发请求
  useEffect(() => {
    if (aId === '' || bId === '' || aId === bId) {
      setComparison(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErrMsg(null);
    void fetchRunComparison(aId, bId)
      .then((res) => {
        if (!cancelled) setComparison(res);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setComparison(null);
        setErrMsg(evaluationErrorMessage(err, '对比失败'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [aId, bId]);

  // 选择写进 URL —— 链接可以直接分享给别人看
  const onSelect = (which: 'a' | 'b', value: string): void => {
    const next: Record<string, string> = {};
    const a = which === 'a' ? value : aId;
    const b = which === 'b' ? value : bId;
    if (a !== '') next['a'] = a;
    if (b !== '') next['b'] = b;
    // ⚠️ `replace: true` —— 每次换下拉都 push 一条历史记录的话，
    //    用户按「后退」要按十几次才能回到进来之前。
    setSearchParams(next, { replace: true });
    if (which === 'a') setAId(value);
    else setBId(value);
  };

  const options = useMemo(
    () =>
      (runs ?? []).map((r) => ({
        value: r.id,
        label: `${promptLabel(r)} · ${new Date(r.started_at).toLocaleString()} · ${
          r.total_score === null ? '未完成' : `${r.total_score.toFixed(2)} 分`
        }`,
      })),
    [runs],
  );

  /**
   * 差值的展示 —— 正=绿、负=红、零=灰（颜色走 token，深色模式自动跟）
   *
   * @param precision 小数位 —— 分数 2 位、token 0 位（整数）、成本 4 位
   */
  const deltaText = (delta: number | null, precision = 2): ReactNode => {
    if (delta === null) {
      return <span style={{ color: token.colorTextTertiary }}>—</span>;
    }
    const color =
      delta > 0 ? token.colorSuccess : delta < 0 ? token.colorError : token.colorTextTertiary;
    return (
      <span style={{ color, fontWeight: 600 }}>
        {delta > 0 ? '+' : ''}
        {delta.toFixed(precision)}
      </span>
    );
  };

  const dimensionColumns: TableColumnsType<RunComparison['dimensions'][number]> = [
    { title: '维度', dataIndex: 'label', key: 'label', width: 120 },
    {
      title: 'A（基线）',
      dataIndex: 'a',
      key: 'a',
      width: 110,
      align: 'right',
      render: (v: number | null) => (v === null ? '—' : v.toFixed(2)),
    },
    {
      title: 'B（对比）',
      dataIndex: 'b',
      key: 'b',
      width: 110,
      align: 'right',
      render: (v: number | null) => (v === null ? '—' : v.toFixed(2)),
    },
    {
      title: '差值 (B - A)',
      dataIndex: 'delta',
      key: 'delta',
      width: 130,
      align: 'right',
      render: (v: number | null) => deltaText(v),
    },
  ];

  const itemColumns: TableColumnsType<RunComparisonItem> = [
    {
      title: '题目',
      dataIndex: 'question',
      key: 'question',
      ellipsis: true,
      render: (q: string) => (
        <Tooltip title={q}>
          <Text style={{ fontSize: 13 }}>{q}</Text>
        </Tooltip>
      ),
    },
    {
      title: 'A',
      key: 'a',
      width: 80,
      align: 'right',
      render: (_: unknown, row) =>
        row.a === null ? (
          <span style={{ color: token.colorTextTertiary }}>—</span>
        ) : (
          averageOf(row.a.scores).toFixed(2)
        ),
    },
    {
      title: 'B',
      key: 'b',
      width: 80,
      align: 'right',
      render: (_: unknown, row) =>
        row.b === null ? (
          <span style={{ color: token.colorTextTertiary }}>—</span>
        ) : (
          averageOf(row.b.scores).toFixed(2)
        ),
    },
    {
      title: '差值',
      dataIndex: 'delta',
      key: 'delta',
      width: 100,
      align: 'right',
      render: (v: number | null) => deltaText(v),
    },
    {
      title: '结论',
      dataIndex: 'verdict',
      key: 'verdict',
      width: 120,
      render: (v: RunComparisonItem['verdict']) => (
        <Tag color={VERDICT_VIEW[v].color}>{VERDICT_VIEW[v].label}</Tag>
      ),
    },
  ];

  const expandedRow = (row: RunComparisonItem): ReactElement => (
    <Space orientation="vertical" size={8} style={{ width: '100%' }}>
      {(['a', 'b'] as const).map((side) => {
        const data = row[side];
        if (data === null) return null;
        return (
          <div key={side}>
            <Text strong>{side === 'a' ? 'A（基线）' : 'B（对比）'}</Text>
            <Space wrap size={4} style={{ marginLeft: 8 }}>
              <Tag>准确性 {data.scores.accuracy}</Tag>
              <Tag>完整性 {data.scores.completeness}</Tag>
              <Tag>风格 {data.scores.style}</Tag>
              <Tag>安全性 {data.scores.safety}</Tag>
            </Space>
            <Paragraph
              style={{ margin: '6px 0 0', fontSize: 13 }}
              ellipsis={{ rows: 3, expandable: true, symbol: '展开回答' }}
            >
              {data.answer}
            </Paragraph>
            {data.judge_reason !== null && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                裁判理由：{data.judge_reason}
              </Text>
            )}
          </div>
        );
      })}
    </Space>
  );

  return (
    <div>
      <PageHeader
        title="版本对比"
        subtitle="把两次跑批并排放：看四维分差、逐题谁更好。A 一般是旧版本，B 是新版本。"
        breadcrumb={[{ title: '首页' }, { title: '评测' }, { title: '版本对比' }]}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void loadRuns()}>
            刷新
          </Button>
        }
      />

      {errMsg !== null && (
        <Alert type="error" showIcon title={errMsg} style={{ marginBottom: 16 }} />
      )}

      <Card style={{ marginBottom: 16 }}>
        <Space size={16} wrap style={{ width: '100%' }}>
          <div style={{ minWidth: 280, flex: 1 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              A（基线）
            </Text>
            <Select
              style={{ width: '100%' }}
              placeholder="选一次跑批当基线"
              options={options}
              value={aId === '' ? null : aId}
              onChange={(v: string) => onSelect('a', v)}
              showSearch
              optionFilterProp="label"
              loading={runs === null}
            />
          </div>
          <div style={{ minWidth: 280, flex: 1 }}>
            <Text type="secondary" style={{ fontSize: 12 }}>
              B（对比）
            </Text>
            <Select
              style={{ width: '100%' }}
              placeholder="选一次跑批来对比"
              options={options}
              value={bId === '' ? null : bId}
              onChange={(v: string) => onSelect('b', v)}
              showSearch
              optionFilterProp="label"
              loading={runs === null}
            />
          </div>
        </Space>
      </Card>

      {aId !== '' && bId !== '' && aId === bId && (
        <Alert
          type="warning"
          showIcon
          title="A 和 B 是同一次跑批"
          description="选两次不同的跑批才能看出差异。"
          style={{ marginBottom: 16 }}
        />
      )}

      {comparison === null ? (
        <Card>
          <Empty
            description={
              aId === '' || bId === ''
                ? '在上面选两次跑批就能开始对比'
                : loading
                  ? '对比中…'
                  : '没有可对比的数据'
            }
          />
        </Card>
      ) : (
        <>
          {comparison.warnings.length > 0 && (
            <Alert
              type="warning"
              showIcon
              title="对比前先看这几条"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {comparison.warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              }
              style={{ marginBottom: 16 }}
            />
          )}

          <Card title="两次跑批" size="small" style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
              {([['a', comparison.a], ['b', comparison.b]] as const).map(([side, run]) => (
                <div key={side} style={{ minWidth: 260 }}>
                  <Text strong>{side === 'a' ? 'A（基线）' : 'B（对比）'}</Text>
                  <div style={{ fontSize: 13, marginTop: 4 }}>
                    <Paragraph style={{ margin: 0 }} type="secondary">
                      提示词版本：{promptLabel(run)}
                      <br />
                      评测集：{run.dataset_name ?? '—'}
                      <br />
                      模型：{run.model ?? '—'}
                      <br />
                      时间：{new Date(run.started_at).toLocaleString()}
                    </Paragraph>
                  </div>
                </div>
              ))}
            </div>
          </Card>

          <Card title="维度分数" size="small" style={{ marginBottom: 16 }}>
            <Table
              rowKey="key"
              size="small"
              columns={dimensionColumns}
              dataSource={comparison.dimensions}
              pagination={false}
              tableLayout="fixed"
            />
          </Card>

          <Card title="题数 / 成本 / token" size="small" style={{ marginBottom: 16 }}>
            <Space size={32} wrap>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  明细条数
                </Text>
                <div style={{ fontSize: 18, fontWeight: 600 }}>
                  A {comparison.metrics.items.a} / B {comparison.metrics.items.b} / 配对{' '}
                  {comparison.metrics.items.matched}
                </div>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  总 token
                </Text>
                <div style={{ fontSize: 18, fontWeight: 600 }}>
                  {comparison.metrics.total_tokens.a} → {comparison.metrics.total_tokens.b}
                  {deltaText(comparison.metrics.total_tokens.delta, 0)}
                </div>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  总花费
                </Text>
                <div style={{ fontSize: 18, fontWeight: 600 }}>
                  ${comparison.metrics.total_cost.a.toFixed(4)} → $
                  {comparison.metrics.total_cost.b.toFixed(4)}
                  {deltaText(comparison.metrics.total_cost.delta, 4)}
                </div>
              </div>
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  逐题结论
                </Text>
                <div style={{ fontSize: 18, fontWeight: 600 }}>
                  更好 {comparison.item_stats.better} · 更差 {comparison.item_stats.worse} · 持平{' '}
                  {comparison.item_stats.same}
                </div>
              </div>
            </Space>
          </Card>

          <Card title="逐题对比" size="small">
            <Table
              rowKey="key"
              size="small"
              columns={itemColumns}
              dataSource={comparison.items}
              loading={loading}
              pagination={{ pageSize: 20, showTotal: (total) => `共 ${total} 题` }}
              tableLayout="fixed"
              expandable={{
                expandedRowRender: expandedRow,
                rowExpandable: (row: RunComparisonItem) => row.a !== null || row.b !== null,
              }}
              locale={{ emptyText: '这两次跑批没有可对比的明细' }}
            />
          </Card>
        </>
      )}
    </div>
  );
}

/** 四维平均 —— 跟后端的 averageScore 一个口径（0~5） */
function averageOf(scores: {
  accuracy: number;
  completeness: number;
  style: number;
  safety: number;
}): number {
  return (scores.accuracy + scores.completeness + scores.style + scores.safety) / 4;
}
