import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Progress,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import type { TableColumnsType, UploadProps } from 'antd';
import { InboxOutlined } from '@ant-design/icons';
import {
  deleteDocument,
  listDocuments,
  uploadDocument,
  type KnowledgeDocument,
  type DocumentStatus,
  type FileType,
} from '../../lib/adminKnowledge';

const { Title, Paragraph, Text } = Typography;
const { Dragger } = Upload;

const STATUS_COLOR: Record<DocumentStatus, string> = {
  uploaded: 'default',
  indexing: 'processing',
  ready: 'success',
  failed: 'error',
};

const STATUS_TEXT: Record<DocumentStatus, string> = {
  uploaded: '已上传',
  indexing: '索引中…',
  ready: '就绪',
  failed: '失败',
};

const TYPE_COLOR: Record<FileType, string> = {
  pdf: 'red',
  markdown: 'geekblue',
  txt: 'green',
};

/**
 * 拒收类型（与 src/services/document-upload.ts:detectFileType 一致）：
 * Step 4 实际只接 PDF / MD / TXT（mammoth 未引入，Word 下一步再加）
 */
const ACCEPT = '.pdf,.md,.markdown,.txt';

/**
 * /admin/knowledge/documents —— 知识库管理 P8
 * 详见 docs/04-c §5.2 + docs/16-c §C1 + docs/15 §Step 4
 */
export function KnowledgeDocumentsPage(): ReactElement {
  const [rows, setRows] = useState<KnowledgeDocument[] | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | DocumentStatus>('all');
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [detail, setDetail] = useState<KnowledgeDocument | null>(null);

  const load = async (): Promise<void> => {
    setErrMsg(null);
    try {
      const docs = await listDocuments();
      setRows(docs);
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } }).response?.status;
      setErrMsg(status === 401 ? '鉴权失败（需 admin 角色）' : '加载文档列表失败');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  // 客户端状态过滤
  const filtered = useMemo(() => {
    const data = rows ?? [];
    return statusFilter === 'all' ? data : data.filter((r) => r.status === statusFilter);
  }, [rows, statusFilter]);

  // 上传 Dragger：beforeUpload=false 让 antd 不真发，由我们 axios 发（带拦截器 / token）
  const draggerProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: ACCEPT,
    showUploadList: false,
    beforeUpload: () => false, // 阻止 antd 默认上传
    onChange: async (info) => {
      const file = info.file.originFileObj;
      if (file === undefined) return;
      await doUpload(file);
    },
  };

  const doUpload = async (file: File): Promise<void> => {
    // 前端先按扩展名拒一波（后端也拒；前端早失败 UX 更好）
    const lower = file.name.toLowerCase();
    if (!/\.(pdf|md|markdown|txt)$/.test(lower)) {
      message.error('仅支持 PDF / Markdown / TXT 文件');
      return;
    }
    setUploading(true);
    setUploadPct(0);
    try {
      const result = await uploadDocument(file, (pct) => setUploadPct(pct));
      message.success(
        `上传成功：${result.title}（${result.chunk_count} 个块，状态：${STATUS_TEXT[result.status]}）`,
      );
      await load();
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } }).response?.status;
      const data = (e as { response?: { data?: { message?: string } } }).response?.data;
      if (status === 400 && data?.message !== undefined) {
        message.error(data.message);
      } else if (status === 413) {
        message.error('文件超过 50 MB 上限');
      } else {
        message.error('上传失败');
      }
    } finally {
      setUploading(false);
      setUploadPct(0);
    }
  };

  const onDelete = async (row: KnowledgeDocument): Promise<void> => {
    try {
      await deleteDocument(row.id);
      message.success(`已删除 ${row.title}`);
      await load();
    } catch (e: unknown) {
      const status = (e as { response?: { status?: number } }).response?.status;
      message.error(status === 404 ? '文档已不存在' : '删除失败');
    }
  };

  const columns: TableColumnsType<KnowledgeDocument> = [
    {
      title: '文件名',
      dataIndex: 'title',
      key: 'title',
      render: (t: string, row) => (
        <Space size={4} direction="vertical" style={{ lineHeight: 1.2 }}>
          <span>{t}</span>
          {row.file_type !== null && (
            <Tag color={TYPE_COLOR[row.file_type]} style={{ marginInlineEnd: 0 }}>
              {row.file_type}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (s: DocumentStatus) => (
        <Tag color={STATUS_COLOR[s]}>{STATUS_TEXT[s]}</Tag>
      ),
    },
    {
      title: '块数',
      dataIndex: 'chunk_count',
      key: 'chunk_count',
      width: 80,
      align: 'right',
      render: (n: number) => (n === 0 ? '—' : n),
    },
    {
      title: '上传时间',
      dataIndex: 'uploaded_at',
      key: 'uploaded_at',
      width: 170,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      render: (_: unknown, row) => (
        <Space onClick={(e) => e.stopPropagation()}>
          <Button size="small" onClick={() => setDetail(row)}>
            详情
          </Button>
          <Button size="small" danger onClick={() => void onDelete(row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Space style={{ marginBottom: 16, justifyContent: 'space-between', display: 'flex' }}>
        <Title level={3} style={{ margin: 0 }}>
          知识库管理
        </Title>
        <Space>
          <Button onClick={() => void load()}>刷新</Button>
        </Space>
      </Space>
      <Paragraph type="secondary">
        上传 PDF / Markdown / TXT 文件，系统同步拆块 + 向量化入知识库；检索效果可在「检索测试」页验证。
      </Paragraph>

      {errMsg !== null && (
        <Alert type="error" showIcon message={errMsg} style={{ marginBottom: 16 }} />
      )}

      <Card style={{ marginBottom: 16 }} title="上传文档">
        <Dragger {...draggerProps} disabled={uploading}>
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">点击或拖拽文件到这里上传</p>
          <p className="ant-upload-hint">
            支持 PDF / Markdown / TXT，单文件 ≤ 50 MB；上传后自动拆块并向量化（同步处理）
          </p>
        </Dragger>
        {uploading && (
          <div style={{ marginTop: 12 }}>
            <Progress percent={uploadPct} status="active" />
          </div>
        )}
      </Card>

      <Card>
        <Space style={{ marginBottom: 12 }}>
          <Select
            value={statusFilter}
            onChange={(v) => setStatusFilter(v)}
            style={{ width: 180 }}
            options={[
              { value: 'all', label: '全部状态' },
              { value: 'uploaded', label: '已上传' },
              { value: 'indexing', label: '索引中' },
              { value: 'ready', label: '就绪' },
              { value: 'failed', label: '失败' },
            ]}
          />
        </Space>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={filtered}
          loading={rows === null}
          pagination={false}
          locale={{
            emptyText: rows === null ? '加载中…' : '本租户还没有文档，去上传一个吧',
          }}
          onRow={(row) => ({
            onClick: () => setDetail(row),
            style: { cursor: 'pointer' },
          })}
        />
      </Card>

      <Drawer
        open={detail !== null}
        title={detail === null ? '' : `文档详情：${detail.title}`}
        width={420}
        onClose={() => setDetail(null)}
        destroyOnClose
      >
        {detail !== null && (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <div>
              <Text type="secondary">ID</Text>
              <div>
                <Text code>{detail.id}</Text>
              </div>
            </div>
            <div>
              <Text type="secondary">类型</Text>
              <div>
                {detail.file_type !== null ? (
                  <Tag color={TYPE_COLOR[detail.file_type]}>{detail.file_type}</Tag>
                ) : (
                  '—'
                )}
              </div>
            </div>
            <div>
              <Text type="secondary">状态</Text>
              <div>
                <Tag color={STATUS_COLOR[detail.status]}>{STATUS_TEXT[detail.status]}</Tag>
              </div>
            </div>
            <div>
              <Text type="secondary">块数</Text>
              <div>{detail.chunk_count}</div>
            </div>
            <div>
              <Text type="secondary">上传时间</Text>
              <div>{new Date(detail.uploaded_at).toLocaleString()}</div>
            </div>
            <div>
              <Text type="secondary">最后更新</Text>
              <div>{new Date(detail.updated_at).toLocaleString()}</div>
            </div>
          </Space>
        )}
      </Drawer>
    </div>
  );
}