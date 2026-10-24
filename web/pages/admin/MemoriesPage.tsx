import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { PageHeader } from '../../components/shell/PageHeader';
import {
  archiveMemory,
  createMemory,
  deleteMemoryForever,
  errorMessage,
  fetchMemories,
  fetchMemoryOwners,
  restoreMemory,
  updateMemory,
} from '../../lib/adminMemory';
import {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABEL,
  MEMORY_SOURCE_LABEL,
  type AdminMemoryItem,
  type MemoryCategory,
  type MemoryOwner,
  type MemorySource,
  type MemoryStatus,
} from '@shared/types/memory';

const { Paragraph, Text } = Typography;

const PAGE_SIZE = 20;

/** 分类的配色 —— 跟前台「我的记忆」页保持一致 */
const CATEGORY_COLOR: Record<MemoryCategory, string> = {
  profile: 'purple',
  preference: 'blue',
  fact: 'green',
  context: 'orange',
};

/**
 * /admin/memories —— 租户后台的「用户记忆」
 *
 * 后端端点（src/gateway/admin/memory-routes.ts）：
 *   GET    /memories              本租户全部记忆（分页 + 筛选）
 *   GET    /memories/owners       哪些用户有记忆、各有多少条
 *   PATCH  /memories/:id          改内容 / 分类
 *   DELETE /memories/:id          归档
 *   POST   /memories/:id/restore  恢复
 *
 * ## 为什么是「左用户 + 右记忆」的双栏
 * 需求是「在租户后台能看到每一个用户的独有记忆」——
 * 所以页面左边是用户（带记忆条数），右边是选中用户的记忆条目。
 * 直接平铺一个全租户的表，几十个用户混在一起根本看不出谁是谁的。
 *
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.11
 */
export function AdminMemoriesPage(): ReactElement {
  // ===== 左侧：用户 =====
  const [owners, setOwners] = useState<MemoryOwner[] | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  // ===== 右侧：记忆列表 =====
  const [rows, setRows] = useState<AdminMemoryItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  /** 加载失败（区别于「还在加载」—— 否则表格会永远转圈） */
  const [loadFailed, setLoadFailed] = useState(false);

  const [categoryFilter, setCategoryFilter] = useState<MemoryCategory | 'all'>('all');
  const [sourceFilter, setSourceFilter] = useState<MemorySource | 'all'>('all');
  const [statusFilter, setStatusFilter] = useState<MemoryStatus | 'all'>('active');
  const [keyword, setKeyword] = useState('');

  // ===== 详情 / 编辑抽屉 =====
  const [detail, setDetail] = useState<AdminMemoryItem | null>(null);
  const [editForm] = Form.useForm<{ content: string; category: MemoryCategory }>();
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // ===== 新增（管理员给选中的用户打标）=====
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [createForm] = Form.useForm<{ content: string; category: MemoryCategory }>();
  const [createSubmitting, setCreateSubmitting] = useState(false);

  // ===== 加载用户列表 =====
  const loadOwners = useCallback(async (): Promise<void> => {
    try {
      const res = await fetchMemoryOwners();
      setOwners(res.owners);
      // 默认选中第一个有记忆的用户
      setSelectedUserId((prev) => {
        if (prev !== null && res.owners.some((o) => o.user_id === prev)) {
          return prev;
        }
        return res.owners.length > 0 ? (res.owners[0]?.user_id ?? null) : null;
      });
    } catch (err: unknown) {
      setErrMsg(errorMessage(err, '加载用户列表失败'));
    }
  }, []);

  // ===== 加载记忆列表 =====
  // 请求序号：快速连点筛选时会同时有多个请求在飞，
  // 先发后到的旧结果会把新数据覆盖掉 —— 只认最后一次发起的那个。
  const reqSeq = useRef(0);
  const load = useCallback(async (): Promise<void> => {
    // ⚠️ 提前 return 之前也要作废在飞的请求 ——
    //    否则旧请求回来时 seq === reqSeq.current 判定成立，会把刚 set 的空状态覆盖掉
    const seq = ++reqSeq.current;
    if (selectedUserId === null) {
      setRows([]);
      setTotal(0);
      return;
    }
    setLoading(true);
    setErrMsg(null);
    setLoadFailed(false);
    try {
      const res = await fetchMemories({
        page,
        page_size: PAGE_SIZE,
        user_id: selectedUserId,
        status: statusFilter,
        ...(categoryFilter === 'all' ? {} : { category: categoryFilter }),
        ...(sourceFilter === 'all' ? {} : { source: sourceFilter }),
        ...(keyword.trim() === '' ? {} : { keyword: keyword.trim() }),
      });
      if (seq !== reqSeq.current) {
        return; // 已经有更新的请求发出去了，丢弃这次的结果
      }
      setRows(res.memories);
      setTotal(res.pagination.total);
    } catch (err: unknown) {
      if (seq !== reqSeq.current) {
        return;
      }
      // ⚠️ 失败时不能把 rows 留成 null —— null 表示「还在加载」，
      //    表格会永远转圈，用户以为还在加载，不会去看上面的错误提示
      setRows([]);
      setLoadFailed(true);
      setErrMsg(errorMessage(err, '加载记忆列表失败'));
    } finally {
      if (seq === reqSeq.current) {
        setLoading(false);
      }
    }
  }, [page, selectedUserId, categoryFilter, sourceFilter, statusFilter, keyword]);

  useEffect(() => {
    void loadOwners();
  }, [loadOwners]);

  useEffect(() => {
    void load();
  }, [load]);

  // ===== 管理员新增 =====
  const submitCreate = async (): Promise<void> => {
    if (selectedUserId === null) return;
    const v = await createForm.validateFields().catch(() => null);
    if (v === null) return;
    setCreateSubmitting(true);
    try {
      await createMemory({
        user_id: selectedUserId,
        content: v.content,
        category: v.category,
      });
      message.success('已添加');
      setCreatingOpen(false);
      createForm.resetFields();
      await load();
      await loadOwners();
    } catch (err: unknown) {
      message.error(errorMessage(err, '添加失败'));
    } finally {
      setCreateSubmitting(false);
    }
  };

  // ===== 编辑 =====
  const openEdit = (row: AdminMemoryItem): void => {
    editForm.setFieldsValue({ content: row.content, category: row.category });
    setDetail(row);
  };

  const submitEdit = async (): Promise<void> => {
    if (detail === null) return;
    const v = await editForm.validateFields().catch(() => null);
    if (v === null) return;
    setEditSubmitting(true);
    try {
      await updateMemory(detail.id, { content: v.content, category: v.category });
      message.success('已保存');
      setDetail(null);
      await load();
      await loadOwners();
    } catch (err: unknown) {
      message.error(errorMessage(err, '保存失败'));
    } finally {
      setEditSubmitting(false);
    }
  };

  // ===== 归档 / 恢复 =====
  const onArchive = async (row: AdminMemoryItem): Promise<void> => {
    setBusyId(row.id);
    try {
      await archiveMemory(row.id);
      message.success('已归档（可在「已归档」筛选里恢复）');
      setDetail(null);
      await load();
      await loadOwners();
    } catch (err: unknown) {
      message.error(errorMessage(err, '归档失败'));
    } finally {
      setBusyId(null);
    }
  };

  const onRestore = async (row: AdminMemoryItem): Promise<void> => {
    setBusyId(row.id);
    try {
      await restoreMemory(row.id);
      message.success('已恢复');
      setDetail(null);
      await load();
      await loadOwners();
    } catch (err: unknown) {
      message.error(errorMessage(err, '恢复失败'));
    } finally {
      setBusyId(null);
    }
  };

  /** 物理删除（合规清理用，不可恢复） */
  const onDeleteForever = async (row: AdminMemoryItem): Promise<void> => {
    setBusyId(row.id);
    try {
      await deleteMemoryForever(row.id);
      message.success('已永久删除');
      setDetail(null);
      await load();
      await loadOwners();
    } catch (err: unknown) {
      message.error(errorMessage(err, '永久删除失败'));
    } finally {
      setBusyId(null);
    }
  };

  const selectedOwner = owners?.find((o) => o.user_id === selectedUserId) ?? null;

  const columns: TableColumnsType<AdminMemoryItem> = [
    {
      title: '内容',
      dataIndex: 'content',
      key: 'content',
      // ⚠️ 必须给显式宽度：tableLayout="fixed" 下，没写宽度的列分到「剩余空间」。
      //    其它列的固定宽度加起来超过容器时，剩余空间是负数 → 内容列被压成 0 宽，整张表看不见内容。
      width: 300,
      ellipsis: true,
      render: (content: string) => <span style={{ fontWeight: 500 }}>{content}</span>,
    },
    {
      title: '分类',
      dataIndex: 'category',
      key: 'category',
      width: 90,
      render: (c: MemoryCategory) => (
        <Tag color={CATEGORY_COLOR[c]} style={{ fontWeight: 500 }}>
          {MEMORY_CATEGORY_LABEL[c]}
        </Tag>
      ),
    },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      width: 100,
      render: (s: MemorySource) => <Tag color={s === 'user' ? 'green' : 'default'}>{MEMORY_SOURCE_LABEL[s]}</Tag>,
    },
    {
      title: '置信度',
      dataIndex: 'confidence',
      key: 'confidence',
      width: 80,
      // 窄屏先砍次要列，保住「内容」和「操作」
      responsive: ['lg'],
      render: (c: number) => <Text type="secondary">{c.toFixed(2)}</Text>,
    },
    {
      title: '被引用',
      dataIndex: 'hit_count',
      key: 'hit_count',
      width: 80,
      responsive: ['lg'],
      render: (n: number) => <Text type="secondary">{n} 次</Text>,
    },
    {
      title: '更新时间',
      dataIndex: 'updated_at',
      key: 'updated_at',
      width: 170,
      responsive: ['md'],
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '操作',
      key: 'actions',
      width: 140,
      render: (_: unknown, row) => (
        <Space onClick={(e) => e.stopPropagation()}>
          <Button type="link" size="small" onClick={() => openEdit(row)}>
            编辑
          </Button>
          {row.status === 'active' ? (
            <Popconfirm
              title="确认归档这条记忆？"
              description="归档后 AI 不再使用它，用户自己也能恢复。"
              okText="确认"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void onArchive(row)}
            >
              <Button type="link" size="small" danger loading={busyId === row.id}>
                归档
              </Button>
            </Popconfirm>
          ) : (
            <Space onClick={(e) => e.stopPropagation()}>
              <Button type="link" size="small" loading={busyId === row.id} onClick={() => void onRestore(row)}>
                恢复
              </Button>
              <Popconfirm
                title="确认永久删除这条记忆？"
                description="物理删除后无法恢复。用户那边也不会再有这条记忆。"
                okText="永久删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => void onDeleteForever(row)}
              >
                <Button type="link" size="small" danger loading={busyId === row.id}>
                  永久删除
                </Button>
              </Popconfirm>
            </Space>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="用户记忆"
        subtitle="AI 记住的每个用户的长期记忆。左边选用户，右边看和改这个人的记忆条目。"
        extra={
          <Button icon={<ReloadOutlined />} onClick={() => void load()}>
            刷新
          </Button>
        }
      />

      {errMsg !== null && (
        <Alert type="error" showIcon message={errMsg} style={{ marginBottom: 16 }} />
      )}

      <Row gutter={[16, 16]} align="stretch">
        {/* 左：用户列表。窄屏时折到上面一整行（xs=24），不然右边的表格会被挤变形 */}
        <Col xs={24} md={8} lg={6}>
          <Card
            size="small"
            style={{ height: '100%' }}
            styles={{ body: { padding: 12 } }}
            title="有记忆的用户"
          >
            {owners === null ? (
              <Text type="secondary">加载中…</Text>
            ) : owners.length === 0 ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有任何记忆" />
            ) : (
              <div style={{ maxHeight: 520, overflowY: 'auto' }}>
                {owners.map((o) => {
                  const active = o.user_id === selectedUserId;
                  return (
                    <div
                      key={o.user_id}
                      onClick={() => {
                        setSelectedUserId(o.user_id);
                        setPage(1);
                      }}
                      style={{
                        padding: '8px 10px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        background: active ? 'rgba(47, 84, 235, 0.08)' : 'transparent',
                        marginBottom: 2,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: active ? 600 : 400,
                          wordBreak: 'break-all',
                        }}
                      >
                        {o.email}
                      </div>
                      <div style={{ fontSize: 12, color: 'rgba(0,0,0,0.45)', marginTop: 2 }}>
                        {o.memory_count} 条记忆
                        {o.last_hit_at !== null && (
                          <> · 最后被引用 {new Date(o.last_hit_at).toLocaleDateString()}</>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </Col>

        {/* 右：记忆列表 */}
        <Col xs={24} md={16} lg={18}>
          <Card
            size="small"
            style={{ height: '100%' }}
            styles={{ body: { padding: 16 } }}
            title={selectedOwner === null ? '记忆条目' : `${selectedOwner.email} 的记忆`}
          >
          <Space wrap size={12} style={{ marginBottom: 12 }}>
            <Select
              value={categoryFilter}
              onChange={(v) => {
                setPage(1);
                setCategoryFilter(v);
              }}
              style={{ width: 130 }}
              options={[
                { value: 'all', label: '全部分类' },
                ...MEMORY_CATEGORIES.map((c) => ({
                  value: c,
                  label: MEMORY_CATEGORY_LABEL[c],
                })),
              ]}
            />
            <Select
              value={sourceFilter}
              onChange={(v) => {
                setPage(1);
                setSourceFilter(v);
              }}
              style={{ width: 130 }}
              options={[
                { value: 'all', label: '全部来源' },
                { value: 'auto', label: '自动抽取' },
                { value: 'user', label: '用户自写' },
                { value: 'admin', label: '管理员' },
              ]}
            />
            <Select
              value={statusFilter}
              onChange={(v) => {
                setPage(1);
                setStatusFilter(v);
              }}
              style={{ width: 130 }}
              options={[
                { value: 'active', label: '生效中' },
                { value: 'archived', label: '已归档' },
                { value: 'all', label: '全部' },
              ]}
            />
            <Input.Search
              placeholder="按内容搜索"
              allowClear
              style={{ width: 220 }}
              onSearch={(v) => {
                setPage(1);
                setKeyword(v);
              }}
              onChange={(e) => {
                if (e.target.value === '') {
                  setPage(1);
                  setKeyword('');
                }
              }}
            />
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={selectedUserId === null}
              onClick={() => {
                // 显式设值，不靠 Form.Item 的 initialValue ——
                // 那个在「关掉再打开」时不一定重新生效
                createForm.setFieldsValue({ content: '', category: 'fact' });
                setCreatingOpen(true);
              }}
            >
              添加记忆
            </Button>
          </Space>

          <Table
            rowKey="id"
            columns={columns}
            dataSource={rows ?? []}
            loading={loading}
            tableLayout="fixed"
            onRow={(row) => ({
              onClick: () => openEdit(row),
              style: { cursor: 'pointer' },
            })}
            pagination={{
              current: page,
              pageSize: PAGE_SIZE,
              total,
              showSizeChanger: false,
              showTotal: (n) => `共 ${n} 条记忆`,
              onChange: (next) => setPage(next),
            }}
            locale={{
              emptyText:
                loadFailed
                  ? '加载失败，请点「刷新」重试'
                  : selectedUserId === null
                    ? '先在左边选一个用户'
                    : rows === null
                      ? '加载中…'
                      : '这个用户还没有记忆',
            }}
          />
          </Card>
        </Col>
      </Row>

      {/* 管理员新增 */}
      <Modal
        open={creatingOpen}
        title={selectedOwner === null ? '添加记忆' : `给 ${selectedOwner.email} 添加记忆`}
        okText="添加"
        cancelText="取消"
        confirmLoading={createSubmitting}
        onOk={submitCreate}
        onCancel={() => {
          setCreatingOpen(false);
          createForm.resetFields();
        }}
        destroyOnClose
      >
        <Form form={createForm} layout="vertical" preserve={false}>
          <Form.Item
            name="content"
            label="记忆内容"
            rules={[{ required: true, message: '内容不能为空' }]}
            extra="写成一句陈述句，例如「只关心物流时效」。这条会以「管理员」来源注入用户的对话。"
          >
            <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} maxLength={500} showCount />
          </Form.Item>
          <Form.Item name="category" label="分类">
            <Select
              options={MEMORY_CATEGORIES.map((c) => ({
                value: c,
                label: MEMORY_CATEGORY_LABEL[c],
              }))}
            />
          </Form.Item>
        </Form>
      </Modal>

      {/* 详情 / 编辑 */}
      <Drawer
        open={detail !== null}
        title={detail === null ? '' : '编辑记忆'}
        width={460}
        onClose={() => setDetail(null)}
        destroyOnClose
        extra={
          <Space>
            <Button onClick={() => setDetail(null)}>取消</Button>
            <Button type="primary" loading={editSubmitting} onClick={submitEdit}>
              保存
            </Button>
          </Space>
        }
      >
        {detail !== null && (
          <>
            <Descriptions column={1} size="small" bordered style={{ marginBottom: 16 }}>
              <Descriptions.Item label="所属用户">
                {detail.user_email}
              </Descriptions.Item>
              <Descriptions.Item label="来源">
                {MEMORY_SOURCE_LABEL[detail.source]}
              </Descriptions.Item>
              <Descriptions.Item label="置信度">{detail.confidence.toFixed(2)}</Descriptions.Item>
              <Descriptions.Item label="被引用">{detail.hit_count} 次</Descriptions.Item>
              <Descriptions.Item label="状态">
                {detail.status === 'active' ? '生效中' : '已归档'}
              </Descriptions.Item>
              <Descriptions.Item label="创建时间">
                {new Date(detail.created_at).toLocaleString()}
              </Descriptions.Item>
              {detail.source_session_id !== null && (
                <Descriptions.Item label="来源会话">
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {detail.source_session_id}
                  </Text>
                </Descriptions.Item>
              )}
            </Descriptions>

            <Form form={editForm} layout="vertical" preserve={false}>
              <Form.Item
                name="content"
                label="记忆内容"
                rules={[{ required: true, message: '内容不能为空' }]}
              >
                <Input.TextArea autoSize={{ minRows: 2, maxRows: 6 }} maxLength={500} showCount />
              </Form.Item>
              <Form.Item name="category" label="分类">
                <Select
                  options={MEMORY_CATEGORIES.map((c) => ({
                    value: c,
                    label: MEMORY_CATEGORY_LABEL[c],
                  }))}
                />
              </Form.Item>
            </Form>

            <Paragraph type="secondary" style={{ fontSize: 12 }}>
              改完保存立即生效：下一轮对话就会用上新的内容。
            </Paragraph>
          </>
        )}
      </Drawer>
    </div>
  );
}
