import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  InputNumber,
  Space,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { SearchOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { PageHeader } from '../../components/shell/PageHeader';
import {
  errorMessage,
  searchKnowledge,
  type SearchHit,
  type SearchResult,
} from '../../lib/adminKnowledge';

const { Text, Paragraph } = Typography;

/**
 * /admin/knowledge/test —— 检索测试
 *
 * 调 POST /knowledge/search（src/gateway/admin/knowledge-routes.ts），
 * 后端跑「向量召回 + BM25 关键词召回 → RRF 融合」，**不调 LLM**：
 * 这一页的价值就是看清「哪些块被召回了、为什么」，加了 LLM 反而掩盖了检索层的问题。
 *
 * **score 怎么读**（后端 src/rag/hybrid-search.ts 有完整推导）：
 *  - 重排生效时 `score` 是重排分（模型给的原始分，落在 [0,1]）
 *  - 没重排时 `score` 是归一化到 [0,1] 的 RRF 分：1.0 = 向量和关键词两路都排第一
 *  - 一路命中排第一只能到 0.5 —— 这是设计如此，不是 bug
 *  - `sources` 标签告诉你是哪几路召回的，这比分数本身更能解释「为什么命中」
 *
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.3
 */
export function KnowledgeSearchPage(): ReactElement {
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(5);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onSearch = async (): Promise<void> => {
    const q = query.trim();
    if (q === '') {
      message.warning('请输入检索内容');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setResult(await searchKnowledge(q, topK));
    } catch (err: unknown) {
      setResult(null);
      setError(errorMessage(err, '检索失败'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="检索测试"
        subtitle="验证知识库的召回效果：输入问句，看哪些文档块被检索到、是被哪一路召回的。"
        breadcrumb={[{ title: '首页' }, { title: '知识库' }, { title: '检索测试' }]}
      />

      <Card style={{ marginBottom: 16 }}>
        <Space.Compact style={{ width: '100%', marginBottom: 12 }}>
          <Input
            size="large"
            allowClear
            placeholder="输入测试问句，例如：年假怎么算？"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onPressEnter={() => void onSearch()}
          />
          <Button
            type="primary"
            size="large"
            icon={<SearchOutlined />}
            loading={loading}
            onClick={() => void onSearch()}
          >
            检索
          </Button>
        </Space.Compact>

        <Space wrap>
          <Space size={6}>
            <Text type="secondary">返回条数</Text>
            <InputNumber
              min={1}
              max={50}
              value={topK}
              onChange={(v) => setTopK(v ?? 5)}
              style={{ width: 80 }}
            />
          </Space>
          <Text type="secondary" style={{ fontSize: 13 }}>
            两路召回：向量（语义相近）+ 关键词（专有名词 / 编号精确匹配），结果用 RRF 融合排序，
            平台配了重排服务的话还会再排一遍（重排分见每条的「重排」标签）。
          </Text>
        </Space>
      </Card>

      {error !== null && (
        <Alert type="error" showIcon title={error} style={{ marginBottom: 16 }} />
      )}

      {result === null && error === null && (
        <Card>
          <Empty description="输入问句后点检索，这里会显示命中的文档块" />
        </Card>
      )}

      {result !== null && (
        <Card
          title={`命中 ${result.hits.length} 条`}
          extra={
            <Space size={8}>
              <Tooltip
                title={
                  result.rerank_applied
                    ? '这次排序是重排模型给的（RRF 融合之后又排了一遍）'
                    : '这次没有重排：要么平台没配重排服务，要么本租户在「租户设置 → 知识库」里关掉了，' +
                      '要么调用失败已自动降级为 RRF 排序'
                }
              >
                <Tag color={result.rerank_applied ? 'purple' : 'default'}>
                  {result.rerank_applied ? '已重排' : '未重排'}
                </Tag>
              </Tooltip>
              <Text type="secondary">耗时 {result.took_ms} ms</Text>
            </Space>
          }
        >
          {result.hits.length === 0 ? (
            <Empty description="没有命中任何块。检查知识库是否有已就绪的文档，或换个说法再试" />
          ) : (
            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              {result.hits.map((hit, i) => (
                <HitCard key={`${hit.doc_id}#${hit.chunk_index}`} rank={i + 1} hit={hit} />
              ))}
            </Space>
          )}
        </Card>
      )}
    </div>
  );
}

function HitCard({ rank, hit }: { rank: number; hit: SearchHit }): ReactElement {
  const isDual = hit.sources.length > 1;
  return (
    <Card
      size="small"
      style={{ borderLeft: `3px solid ${isDual ? '#52c41a' : '#d9d9d9'}` }}
      styles={{ body: { padding: 14 } }}
    >
      <Space orientation="vertical" size={6} style={{ width: '100%' }}>
        <Space wrap size={8}>
          <Text strong>{rank}.</Text>
          <Text strong>{hit.source}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>
            第 {hit.chunk_index + 1} 块
          </Text>
          <Tooltip
            title={
              <span style={{ fontSize: 12 }}>
                {hit.rerank_score !== null
                  ? '重排模型给的相关度分（0~1，越大越相关）。这次的顺序就是按它排的'
                  : '归一化 RRF 分。1.0 = 向量和关键词都排第一；只有一路排第一时最高 0.5。'}
                <br />
                原始 RRF 分 {hit.rrf_score}
              </span>
            }
          >
            <Tag color={isDual ? 'green' : 'default'}>相关度 {hit.score.toFixed(2)}</Tag>
          </Tooltip>
          {hit.rerank_score !== null && (
            <Tooltip title="重排模型给的原始分">
              <Tag color="purple">重排 {hit.rerank_score.toFixed(3)}</Tag>
            </Tooltip>
          )}
          {hit.vector_rank !== null && (
            <Tooltip title="向量（语义）召回排名">
              <Tag icon={<ThunderboltOutlined />} color="blue">
                语义 第 {hit.vector_rank}
              </Tag>
            </Tooltip>
          )}
          {hit.bm25_rank !== null && (
            <Tooltip title="BM25 关键词召回排名">
              <Tag color="orange">关键词 第 {hit.bm25_rank}</Tag>
            </Tooltip>
          )}
        </Space>
        <Paragraph
          style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7 }}
          ellipsis={{ rows: 6, expandable: true, symbol: '展开全文' }}
        >
          {hit.text}
        </Paragraph>
      </Space>
    </Card>
  );
}