import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Input,
  Popconfirm,
  Progress,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  Typography,
  Upload,
  message,
  theme,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  CloudUploadOutlined,
  FileTextOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons';
import { PageHeader } from '../../components/shell/PageHeader';
import { apiErrorMessage } from '../../lib/apiError';
import {
  deleteDocument,
  fetchDocuments,
  reindexDocument,
  uploadDocument,
  ACCEPTED_UPLOAD_ACCEPT_ATTR,
  ACCEPTED_UPLOAD_EXTENSIONS,
  type KnowledgeDocument,
  type KnowledgeStats,
  type DocumentStatus,
} from '../../lib/adminKnowledge';

const { Dragger } = Upload;
const { Text } = Typography;

const STATUS_META: Record<
  DocumentStatus,
  { label: string; color: string }
> = {
  ready: { label: '已就绪', color: 'green' },
  indexing: { label: '索引中', color: 'processing' },
  failed: { label: '索引失败', color: 'red' },
  uploaded: { label: '待处理', color: 'default' },
};

const FILE_TYPE_LABEL: Record<string, string> = {
  pdf: 'PDF',
  markdown: 'Markdown',
  txt: 'TXT',
  word: 'Word',
};

const PAGE_SIZE = 20;

/**
 * 单文件大小上限（50 MB）—— docs/04-c §5.2「支持 PDF / Markdown / TXT，≤ 50 MB」。
 *
 * ⚠️ 前端先拦一道：不然用户要等 koa-body 把整个文件收完、再被拒，
 *    白等一趟（上传是同步的，大文件传完才发现超限最亏）。
 *    后端 `config.MAX_UPLOAD_BYTES` 是硬闸，前端这道只是提前告知。
 */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * /admin/knowledge/documents —— 知识库文档管理
 *
 * 后端 4 个端点（src/gateway/admin/knowledge-routes.ts）：
 *   GET    /knowledge            列表 + 分页 + 统计
 *   POST   /knowledge/upload     上传（同步跑完解析/拆块/Embedding/入库）
 *   POST   /knowledge/:id/reindex  重新索引
 *   DELETE /knowledge/:id         删除
 *
 * 上传是**同步**的（后端在 HTTP 请求里跑完整条索引链路），所以上传期间按钮转圈、
 * 一次只能传一个文件 —— 并发传多个不会更快，只会把 embedding 的限流打满。
 *
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.2
 */
export function KnowledgeDocumentsPage(): ReactElement {
  // 颜色走 antd token —— 写死浅色的话，深色模式下几乎看不见
  const { token } = theme.useToken();
  const [rows, setRows] = useState<KnowledgeDocument[]>([]);
  const [stats, setStats] = useState<KnowledgeStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<DocumentStatus | 'all'>('all');
  const [keyword, setKeyword] = useState('');
  const [appliedKeyword, setAppliedKeyword] = useState('');

  const [uploading, setUploading] = useState(false);
  const [busyDocId, setBusyDocId] = useState<string | null>(null);
  const [detail, setDetail] = useState<KnowledgeDocument | null>(null);

  /** 组件还挂着吗（unmount 后不要再 setState） */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await fetchDocuments({
        page,
        page_size: PAGE_SIZE,
        ...(statusFilter === 'all' ? {} : { status: statusFilter }),
        ...(appliedKeyword === '' ? {} : { keyword: appliedKeyword }),
      });
      if (!mountedRef.current) {
        return;
      }
      setRows(result.documents);
      setTotal(result.pagination.total);
      setStats(result.stats);
    } catch (err: unknown) {
      if (!mountedRef.current) {
        return;
      }
      setLoadError(apiErrorMessage(err, '文档列表加载失败'));
    } finally {
      if (mountedRef.current) {
        setLoading(false);
      }
    }
  }, [page, statusFilter, appliedKeyword]);

  useEffect(() => {
    void load();
  }, [load]);

  const onUpload = async (file: File): Promise<void> => {
    if (!hasAcceptedExtension(file.name)) {
      message.error(
        `「${file.name}」格式不支持，只接受 ${ACCEPTED_UPLOAD_EXTENSIONS.join(' / ')}`,
      );
      return;
    }
    // ⚠️ 50 MB 前端预检（docs/04-c §5.2）—— 别等后端 koa-body 拒
    if (file.size > MAX_UPLOAD_BYTES) {
      message.error(
        `「${file.name}」有 ${formatBytes(file.size)}，超过 50 MB 上限，请先拆分或压缩`,
      );
      return;
    }
    setUploading(true);
    const startedAt = Date.now();
    try {
      const result = await uploadDocument(file);
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (result.status === 'ready') {
        message.success(
          `《${result.title}》索引完成：${result.chunk_count} 块${
            result.pages === undefined ? '' : ` / ${result.pages} 页`
          }，耗时 ${elapsed}s`,
        );
      } else {
        message.error(`《${result.title}》索引失败：${result.error ?? '未知错误'}`);
      }
      setPage(1);
      await load();
    } catch (err: unknown) {
      message.error(apiErrorMessage(err, '上传失败'));
    } finally {
      setUploading(false);
    }
  };

  const onReindex = useCallback(
    async (row: KnowledgeDocument): Promise<void> => {
      setBusyDocId(row.id);
      try {
        const result = await reindexDocument(row.id);
        if (result.status === 'ready') {
          message.success(`《${row.title}》重新索引完成：${result.chunk_count} 块`);
        } else {
          message.error(`重新索引失败：${result.error ?? '未知错误'}`);
        }
        setDetail(null);
        await load();
      } catch (err: unknown) {
        message.error(apiErrorMessage(err, '重新索引失败'));
      } finally {
        setBusyDocId(null);
      }
    },
    [load],
  );

  const onDelete = useCallback(
    async (row: KnowledgeDocument): Promise<void> => {
      setBusyDocId(row.id);
      try {
        await deleteDocument(row.id);
        message.success(`已删除《${row.title}》`);
        setDetail(null);
        await load();
      } catch (err: unknown) {
        message.error(apiErrorMessage(err, '删除失败'));
      } finally {
        setBusyDocId(null);
      }
    },
    [load],
  );

  const columns: TableColumnsType<KnowledgeDocument> = useMemo(
    () => [
      {
        title: '文档',
        dataIndex: 'title',
        key: 'title',
        ellipsis: true,
        render: (title: string, row) => (
          <Space>
            <FileTextOutlined style={{ color: token.colorTextTertiary }} />
            <a onClick={() => setDetail(row)}>{title}</a>
          </Space>
        ),
      },
      {
        title: '类型',
        dataIndex: 'file_type',
        key: 'file_type',
        width: 100,
        render: (t: string | null) =>
          t === null ? '—' : <Tag>{FILE_TYPE_LABEL[t] ?? t}</Tag>,
      },
      {
        title: '状态',
        dataIndex: 'status',
        key: 'status',
        width: 120,
        render: (s: DocumentStatus) => {
          const meta = STATUS_META[s];
          return <Tag color={meta.color}>{meta.label}</Tag>;
        },
      },
      {
        title: '块数',
        dataIndex: 'chunk_count',
        key: 'chunk_count',
        width: 90,
        align: 'right',
        render: (n: number, row) =>
          row.status === 'ready' ? (
            <Text strong>{n}</Text>
          ) : (
            <Text type="secondary">—</Text>
          ),
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
        width: 170,
        render: (_: unknown, row) => (
          <Space onClick={(e) => e.stopPropagation()}>
            <Tooltip title="用磁盘上的原文件重新跑一遍解析 + 索引">
              <Button
                type="link"
                size="small"
                loading={busyDocId === row.id}
                onClick={() => void onReindex(row)}
              >
                重新索引
              </Button>
            </Tooltip>
            <Popconfirm
              title={`删除《${row.title}》？`}
              description="会同时删除向量库里的块、关键词索引和磁盘原文件，不可撤销。"
              okText="确认删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void onDelete(row)}
            >
              <Button type="link" size="small" danger loading={busyDocId === row.id}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        ),
      },
    ],
    // ⚠️ `onReindex` / `onDelete` 必须在依赖里 —— 它们闭包捕获了 `load`
    //    （含当前的页码 / 筛选）。漏了的话：改完筛选后点「删除」，
    //    刷新出来的还是**旧筛选**的结果。
    [busyDocId, token, onReindex, onDelete],
  );

  return (
    <div>
      <PageHeader
        title="知识库管理"
        subtitle="上传文档后系统自动拆块、向量化并写入向量库。"
        breadcrumb={[{ title: '首页' }, { title: '知识库' }, { title: '文档管理' }]}
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        }
      />

      {loadError !== null && (
        <Alert
          type="error"
          showIcon
          title={loadError}
          style={{ marginBottom: 16 }}
          action={
            <Button size="small" onClick={() => void load()}>
              重试
            </Button>
          }
        />
      )}

      {/* 4 张统计卡（docs/04-c §5.2）——
          ⚠️ **「文档总数」用的是 `stats.total_documents`（不受筛选影响）**，
             不是 `pagination.total`（那是当前筛选下的条数 —— 一按「索引失败」
             筛选，卡片就变成 3，看着像「本租户只有 3 篇文档」）。
          每张卡下面标清口径：哪几个是本租户的、哪个是跨租户参考值。 */}
      <Space size={16} wrap style={{ marginBottom: 16 }}>
        <Card size="small" style={{ minWidth: 180 }}>
          {/* ⚠️ 用 `stats.total_documents`（后端新加的、不受筛选影响的总数）。
              老后端没这个字段时回落到 `pagination.total`（筛选后的条数）——
              宁可口径退化，也不能显示成 0。 */}
          <Statistic title="文档总数" value={stats?.total_documents ?? total} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            本租户全部文档（不含筛选）
          </Text>
        </Card>
        <Card size="small" style={{ minWidth: 180 }}>
          <Statistic title="已索引块数" value={stats?.chunk_total ?? 0} />
          <Text type="secondary" style={{ fontSize: 12 }}>
            本租户已就绪文档的块数合计
          </Text>
        </Card>
        <Card size="small" style={{ minWidth: 200 }}>
          <Statistic
            title="关键词索引块数"
            value={stats?.bm25_chunk_total ?? 0}
            suffix={
              stats !== null && stats.bm25_chunk_total < stats.chunk_total ? (
                <Tooltip title="BM25 索引只存在内存里，服务重启后会从向量库自动重建，重建完成前数字会偏低。">
                  <Text type="warning" style={{ fontSize: 12 }}>
                    重建中
                  </Text>
                </Tooltip>
              ) : undefined
            }
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            本租户 · 内存索引，重启后重建
          </Text>
        </Card>
        <Card size="small" style={{ minWidth: 200 }}>
          <Statistic
            title="向量库总点数"
            value={stats?.qdrant_points ?? 0}
            suffix={
              <Tooltip title="向量库里所有租户的块数合计，仅供运维参考。">
                <Text type="secondary" style={{ fontSize: 12 }}>
                  全平台
                </Text>
              </Tooltip>
            }
          />
          <Text type="secondary" style={{ fontSize: 12 }}>
            跨租户合计 · 运维参考值
          </Text>
        </Card>
      </Space>

      <Dragger
        accept={ACCEPTED_UPLOAD_ACCEPT_ATTR}
        multiple={false}
        showUploadList={false}
        disabled={uploading}
        beforeUpload={(file) => {
          void onUpload(file as File);
          return false;
        }}
        style={{ marginBottom: 16 }}
      >
        <p style={{ margin: '8px 0' }}>
          <CloudUploadOutlined style={{ fontSize: 42, color: token.colorPrimary }} />
        </p>
        <p style={{ margin: '8px 0 4px', fontSize: 16 }}>点击或拖拽文件到此处上传</p>
        <p style={{ margin: 0, color: token.colorTextTertiary, fontSize: 13 }}>
          支持 PDF / Markdown / TXT，单文件 ≤ 50 MB。上传后会同步完成拆块与向量化。
        </p>
        {uploading && (
          <Progress
            percent={100}
            status="active"
            style={{ margin: '12px auto 0', maxWidth: 320 }}
            format={() => '正在解析并向量化，请稍候…'}
          />
        )}
      </Dragger>

      <Space style={{ marginBottom: 12 }} wrap>
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder="按文件名搜索"
          style={{ width: 260 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onPressEnter={() => {
            setPage(1);
            setAppliedKeyword(keyword.trim());
          }}
        />
        <Select<DocumentStatus | 'all'>
          value={statusFilter}
          style={{ width: 140 }}
          onChange={(v) => {
            setPage(1);
            setStatusFilter(v);
          }}
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'ready', label: '已就绪' },
            { value: 'failed', label: '索引失败' },
            { value: 'indexing', label: '索引中' },
            { value: 'uploaded', label: '待处理' },
          ]}
        />
      </Space>

      <Table<KnowledgeDocument>
        rowKey="id"
        columns={columns}
        dataSource={rows}
        loading={loading}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total,
          showSizeChanger: false,
          showTotal: (n) => `共 ${n} 个文档`,
          onChange: (next) => setPage(next),
        }}
        locale={{ emptyText: '还没有文档，先上传一个试试' }}
        onRow={(row) => ({
          onClick: () => setDetail(row),
          style: { cursor: 'pointer' },
        })}
      />

      <Drawer
        title="文档详情"
        open={detail !== null}
        onClose={() => setDetail(null)}
        size={480}
        extra={
          detail !== null && (
            <Button
              icon={<SyncOutlined />}
              loading={busyDocId === detail.id}
              onClick={() => void onReindex(detail)}
            >
              重新索引
            </Button>
          )
        }
      >
        {detail !== null && (
          <>
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="标题">{detail.title}</Descriptions.Item>
              <Descriptions.Item label="文档 ID">
                <Text copyable style={{ fontSize: 12 }}>
                  {detail.id}
                </Text>
              </Descriptions.Item>
              <Descriptions.Item label="类型">
                {detail.file_type === null ? '—' : FILE_TYPE_LABEL[detail.file_type]}
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                <Tag color={STATUS_META[detail.status].color}>
                  {STATUS_META[detail.status].label}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="块数">
                {detail.status === 'ready' ? detail.chunk_count : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="上传时间">
                {new Date(detail.uploaded_at).toLocaleString()}
              </Descriptions.Item>
              <Descriptions.Item label="最近更新">
                {new Date(detail.updated_at).toLocaleString()}
              </Descriptions.Item>
            </Descriptions>
            {detail.status === 'failed' && detail.error_message !== null && (
              <Alert
                type="error"
                showIcon
                style={{ marginTop: 16 }}
                title="最近一次索引失败"
                description={<Text style={{ fontSize: 12 }}>{detail.error_message}</Text>}
              />
            )}
          </>
        )}
      </Drawer>
    </div>
  );
}

function hasAcceptedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ACCEPTED_UPLOAD_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** 把字节数说成人话（MB / KB） */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${bytes} B`;
}
