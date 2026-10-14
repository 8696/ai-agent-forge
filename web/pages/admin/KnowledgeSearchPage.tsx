import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  InputNumber,
  List,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { searchKnowledge, type SearchHit } from '../../lib/adminKnowledge';

const { Title, Paragraph, Text } = Typography;

const SCORE_COLOR = (s: number): string => {
  if (s >= 0.8) return 'green';
  if (s >= 0.6) return 'blue';
  return 'orange';
};

/**
 * /admin/knowledge/test —— 检索测试（Step 4 仅向量检索；BM25 / rerank 留给 Step 5）
 * 详见 docs/04-c §5.3 + docs/16-c §C1
 *
 * 跟 04-c UI 草图的差异（Step 4 边界）：
 *  - 只显示 top 5 命中片段，不附带 AI 回答（Step 6 才接 LLM）
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
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', display: 'flex' }}>
        <Title level={3} style={{ margin: 0 }}>
          检索测试
        </Title>
      </Space>
      <Paragraph type="secondary">
        输入问句 → 向量召回 top 5 命中文档块（按当前租户的知识库）。BM25 + 重排序后续 Step 5 落。
      </Paragraph>

      {errMsg !== null && (
        <Alert type="error" showIcon message={errMsg} style={{ marginBottom: 16 }} />
      )}

      <Card style={{ marginBottom: 16 }}>
        <Space.Compact style={{ width: '100%' }}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入测试问句（如：年假怎么算？）"
            onPressEnter={() => void doSearch()}
            allowClear
            size="large"
          />
          <Button type="primary" size="large" loading={searching} onClick={() => void doSearch()}>
            🔍 检索
          </Button>
        </Space.Compact>
        <Space style={{ marginTop: 12 }}>
          <span>
            <Text type="secondary">topK：</Text>
            <InputNumber min={1} max={50} value={topK} onChange={(v) => setTopK(Number(v ?? 5))} />
          </span>
          <span>
            <Text type="secondary">分数阈值：</Text>
            <InputNumber
              min={0}
              max={1}
              step={0.05}
              value={threshold}
              onChange={(v) => setThreshold(v === null ? null : Number(v))}
              placeholder="0-1，留空不过滤"
            />
          </span>
        </Space>
      </Card>

      <Card title={lastQuery === null ? '命中片段' : `命中片段 · "${lastQuery}"`}>
        {hits === null ? (
          <Empty description="还没有检索结果" />
        ) : hits.length === 0 ? (
          <Empty description="没有命中任何内容（试着调整 topK / 阈值，或先上传文档）" />
        ) : (
          <List
            dataSource={hits}
            renderItem={(hit, idx) => (
              <List.Item key={`${hit.doc_id}-${hit.chunk_index}`}>
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  <Space>
                    <Text strong>{idx + 1}.</Text>
                    <Tag color="blue">{hit.source}</Tag>
                    <Tag color={SCORE_COLOR(hit.score)}>相似度 {hit.score.toFixed(3)}</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      chunk #{hit.chunk_index}
                    </Text>
                  </Space>
                  <Paragraph
                    type="secondary"
                    style={{
                      marginBottom: 0,
                      background: '#fafafa',
                      padding: 8,
                      borderRadius: 4,
                      whiteSpace: 'pre-wrap',
                      maxHeight: 240,
                      overflow: 'auto',
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