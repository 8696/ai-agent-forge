import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Input,
  InputNumber,
  List,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { ExperimentOutlined, SearchOutlined } from '@ant-design/icons';
import { searchKnowledge, type SearchHit } from '../../lib/adminKnowledge';
import { PageHeader } from '../../components/shell/PageHeader';
import { EmptyState } from '../../components/shell/EmptyState';

const { Text, Paragraph } = Typography;

const SCORE_COLOR = (s: number): string => {
  if (s >= 0.8) return 'green';
  if (s >= 0.6) return 'blue';
  return 'orange';
};

/**
 * /admin/knowledge/test —— 检索测试
 * 详见 docs/04-c §5.3 + docs/16-c §C1
 */
export function KnowledgeSearchPage(): ReactElement {
  const [query, setQuery] = useState('');
  const [topK, setTopK] = useState(5);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [lastQuery, setLastQuery] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const doSearch = async (): Promise<void> => {
    const q = query.trim();
    if (q === '') {
      message.warning('请输入问句');
      return;
    }
    setErrMsg(null);
    setSearching(true);
    try {
      const result = await searchKnowledge({
        query: q,
        top_k: topK,
        ...(threshold !== null ? { score_threshold: threshold } : {}),
      });
      setHits(result.hits);
      setLastQuery(q);
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } }).response?.status;
      setHits(null);
      setLastQuery(q);
      if (status === 401) {
        setErrMsg('鉴权失败（需 admin 角色）');
      } else if (status === 500) {
        setErrMsg('检索服务异常（Embedding / Qdrant 是否正常？）');
      } else {
        setErrMsg('检索失败');
      }
    } finally {
      setSearching(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="检索测试"
        subtitle="输入问句，查看当前租户知识库里最相近的文档块。"
      />

      {errMsg !== null && (
        <Alert
          type="error"
          showIcon
          message={errMsg}
          style={{ marginBottom: 16 }}
        />
      )}

      <Card style={{ marginBottom: 16, borderRadius: 12 }} styles={{ body: { padding: 20 } }}>
        <Input.Search
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="输入测试问句（如：年假怎么算？）"
          onSearch={() => void doSearch()}
          enterButton={
            <Space>
              <SearchOutlined />
              检索
            </Space>
          }
          size="large"
          loading={searching}
          allowClear
        />
        <Space wrap size={20} style={{ marginTop: 16 }}>
          <span>
            <Text type="secondary" style={{ marginRight: 8 }}>
              topK
            </Text>
            <InputNumber
              min={1}
              max={50}
              value={topK}
              onChange={(v) => setTopK(Number(v ?? 5))}
              style={{ width: 90 }}
            />
          </span>
          <span>
            <Text type="secondary" style={{ marginRight: 8 }}>
              分数阈值
            </Text>
            <InputNumber
              min={0}
              max={1}
              step={0.05}
              value={threshold}
              onChange={(v) => setThreshold(v === null ? null : Number(v))}
              placeholder="0-1，留空不过滤"
              style={{ width: 140 }}
            />
          </span>
        </Space>
      </Card>

      <Card
        title={
          <Space>
            <ExperimentOutlined style={{ color: '#2f54eb' }} />
            {lastQuery === null ? '命中片段' : `命中片段 · "${lastQuery}"`}
          </Space>
        }
        style={{ borderRadius: 12 }}
      >
        {hits === null ? (
          <EmptyState description="还没有检索结果；试试在上面的输入框问一句。" />
        ) : hits.length === 0 ? (
          <EmptyState
            title="没有命中"
            description="试着调整 topK / 阈值，或先上传文档。"
          />
        ) : (
          <List
            dataSource={hits}
            renderItem={(hit, idx) => (
              <List.Item
                key={`${hit.doc_id}-${hit.chunk_index}`}
                style={{ padding: '14px 0' }}
              >
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Space wrap size={8} align="center">
                    <Text strong style={{ fontSize: 14, color: '#2f54eb' }}>
                      #{idx + 1}
                    </Text>
                    <Tag color="blue">{hit.source}</Tag>
                    <Tag color={SCORE_COLOR(hit.score)} style={{ fontWeight: 500 }}>
                      相似度 {hit.score.toFixed(3)}
                    </Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      chunk #{hit.chunk_index}
                    </Text>
                  </Space>
                  <Paragraph
                    style={{
                      marginBottom: 0,
                      background: '#fafbfc',
                      padding: '10px 14px',
                      borderRadius: 8,
                      border: '1px solid #f0f0f0',
                      whiteSpace: 'pre-wrap',
                      maxHeight: 240,
                      overflow: 'auto',
                      fontSize: 13,
                      lineHeight: 1.6,
                    }}
                  >
                    {hit.text}
                  </Paragraph>
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>
    </div>
  );
}
