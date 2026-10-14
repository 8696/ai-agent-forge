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
import {
  CloudUploadOutlined,
  FilePdfOutlined,
  FileMarkdownOutlined,
  FileTextOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import { InboxOutlined } from '@ant-design/icons';
import {
  deleteDocument,
  listDocuments,
  uploadDocument,
  type KnowledgeDocument,
  type DocumentStatus,
  type FileType,
} from '../../lib/adminKnowledge';
import { PageHeader } from '../../components/shell/PageHeader';

const { Text } = Typography;
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

const ACCEPT = '.pdf,.md,.markdown,.txt';

const FileTypeIcon = ({ type }: { type: FileType | null }): ReactElement => {
  if (type === null) return <></>;
  if (type === 'pdf') return <FilePdfOutlined style={{ color: '#ff4d4f' }} />;
  if (type === 'markdown') return <FileMarkdownOutlined style={{ color: '#2f54eb' }} />;
  return <FileTextOutlined style={{ color: '#13c2c2' }} />;
};

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

  const filtered = useMemo(() => {
    const data = rows ?? [];
    return statusFilter === 'all' ? data : data.filter((r) => r.status === statusFilter);
  }, [rows, statusFilter]);

  const draggerProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: ACCEPT,
    showUploadList: false,
    beforeUpload: () => false,
    onChange: (info) => {
      const maybeWrapped = info.file as unknown as { originFileObj?: File };
      const file: File | undefined =
        maybeWrapped.originFileObj instanceof File
          ? maybeWrapped.originFileObj
          : info.file instanceof File
            ? info.file
            : undefined;
      if (file === undefined) return;
      void doUpload(file);
    },
  };

  const doUpload = async (file: File): Promise<void> => {
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
      ellipsis: true,
      render: (t: string, row) => (
        <Space size={10} align="center">
          <FileTypeIcon type={row.file_type} />
          <span style={{ fontWeight: 500 }}>{t}</span>
        </Space>
      ),
    },
    {
      title: '类型',
      dataIndex: 'file_type',
      key: 'file_type',
      width: 110,
      render: (t: FileType | null) =>
        t === null ? (
          <span style={{ color: 'rgba(0,0,0,0.45)' }}>—</span>
        ) : (
          <Tag style={{ fontWeight: 500 }}>{t.toUpperCase()}</Tag>
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 110,
      render: (s: DocumentStatus) => (
        <Tag color={STATUS_COLOR[s]} style={{ fontWeight: 500 }}>
          {STATUS_TEXT[s]}
        </Tag>
      ),
    },
    {
      title: '块数',
      dataIndex: 'chunk_count',
      key: 'chunk_count',
      width: 90,
      align: 'right',
      render: (n: number) => (n === 0 ? '—' : n),
    },
    {
      title: '上传时间',
      dataIndex: 'uploaded_at',
      key: 'uploaded_at',
      width: 180,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '操作',
      key: 'actions',
      width: 120,
      render: (_: unknown, row) => (
        <Space onClick={(e) => e.stopPropagation()}>
          <Button type="link" size="small" onClick={() => setDetail(row)}>
            详情
          </Button>
          <Button type="link" size="small" danger onClick={() => void onDelete(row)}>
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="文档管理"
        subtitle="上传 PDF / Markdown / TXT，系统会拆块并写入知识库。"
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        }
      />

      {errMsg !== null && (
        <Alert
          type="error"
          showIcon
          message={errMsg}
          style={{ marginBottom: 16 }}
        />
      )}

      <Card
        title={
          <Space>
            <CloudUploadOutlined style={{ color: '#2f54eb' }} />
            上传文档
          </Space>
        }
        style={{ marginBottom: 16, borderRadius: 12 }}
        styles={{ body: { padding: 20 } }}
      >
        <Dragger {...draggerProps} disabled={uploading}>
          <p className="ant-upload-drag-icon" style={{ marginBottom: 8 }}>
            <InboxOutlined style={{ color: '#2f54eb' }} />
          </p>
          <p
            className="ant-upload-text"
            style={{ fontSize: 15, fontWeight: 500, color: '#1f2937' }}
          >
            点击或拖拽文件到这里上传
          </p>
          <p
            className="ant-upload-hint"
            style={{ fontSize: 13, color: 'rgba(0,0,0,0.45)' }}
          >
            支持 PDF / Markdown / TXT，单文件 ≤ 50 MB；上传后自动拆块并向量化（同步处理）
          </p>
        </Dragger>
        {uploading && (
          <div style={{ marginTop: 16 }}>
            <Progress percent={uploadPct} status="active" strokeColor="#2f54eb" />
          </div>
        )}
      </Card>

      <Card>
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            value={statusFilter}
            onChange={(v) => setStatusFilter(v)}
            style={{ width: 160 }}
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
          tableLayout="fixed"
          locale={{
            emptyText: rows === null ? '加载中…' : '还没有文档',
          }}
          onRow={(row) => ({
            onClick: () => setDetail(row),
            style: { cursor: 'pointer' },
          })}
        />
      </Card>

      <Drawer
        open={detail !== null}
        title={detail === null ? '' : `文档详情 · ${detail.title}`}
        width={460}
        onClose={() => setDetail(null)}
        destroyOnClose
      >
        {detail !== null && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>ID</Text>
              <div>
                <Text code>{detail.id}</Text>
              </div>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>类型</Text>
              <div style={{ marginTop: 4 }}>
                {detail.file_type !== null ? (
                  <Tag style={{ fontWeight: 500 }}>
                    {detail.file_type.toUpperCase()}
                  </Tag>
                ) : (
                  '—'
                )}
              </div>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>状态</Text>
              <div style={{ marginTop: 4 }}>
                <Tag color={STATUS_COLOR[detail.status]} style={{ fontWeight: 500 }}>
                  {STATUS_TEXT[detail.status]}
                </Tag>
              </div>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>块数</Text>
              <div style={{ marginTop: 4 }}>{detail.chunk_count}</div>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>上传时间</Text>
              <div style={{ marginTop: 4 }}>{new Date(detail.uploaded_at).toLocaleString()}</div>
            </div>
            <div>
              <Text type="secondary" style={{ fontSize: 12 }}>最后更新</Text>
              <div style={{ marginTop: 4 }}>{new Date(detail.updated_at).toLocaleString()}</div>
            </div>
          </Space>
        )}
      </Drawer>
    </div>
  );
}
