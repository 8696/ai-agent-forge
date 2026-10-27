import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { PageHeader } from '../../components/shell/PageHeader';
import {
  clearMyMemories,
  createMyMemory,
  deleteMyMemory,
  errorMessage,
  fetchMyMemories,
  purgeMyMemories,
  purgeMyMemory,
  restoreMyMemory,
  updateMyMemory,
  updateMyMemorySetting,
} from '../../lib/customerMemory';
import {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_LABEL,
  MEMORY_SOURCE_LABEL,
  type MemoryCategory,
  type MemoryStatus,
  type UserMemoryItem,
} from '@shared/types/memory';

const { Paragraph, Text } = Typography;

/** 分类的配色 —— 跟租户后台的「用户记忆」页保持一致 */
const CATEGORY_COLOR: Record<MemoryCategory, string> = {
  profile: 'purple',
  preference: 'blue',
  fact: 'green',
  context: 'orange',
};

/**
 * /customer/memories —— 前台用户的「我的记忆」
 *
 * 后端端点（src/gateway/customer/memory-routes.ts）：
 *   GET    /memories              我的记忆列表
 *   POST   /memories              我新增一条
 *   PATCH  /memories/:id          我编辑一条
 *   DELETE /memories/:id          我归档一条
 *   POST   /memories/:id/restore  我恢复一条
 *   DELETE /memories/:id/permanent 我彻底删一条（不可恢复）
 *   GET    /memories/settings     我的记忆开关
 *   PUT    /memories/settings     改开关
 *   DELETE /memories              清空全部（归档，可恢复）
 *   DELETE /memories/permanent    彻底删掉全部（不可恢复）
 *
 * ## 这一页要解决的三个问题
 *  1. **看得见**：AI 记住了我什么，用户随时能查
 *  2. **改得了**：记错了用户能直接改 —— 自动抽取出来的记忆不一定准
 *  3. **关得掉**：不想要自动记忆，一个开关就能停
 *
 * ## 「删除」和「彻底删除」的区别
 *  - 删除 = 归档（软删），进「已删除」那个分组，还能恢复
 *  - 彻底删除 = 物理删，**不可恢复**。用户行使「删除我的全部个人数据」的权利时用这个
 *
 * UI 详见 docs/04-b-ui-登录与聊天挂件.md §4.9
 */
export function CustomerMemoriesPage(): ReactElement {
  const [rows, setRows] = useState<UserMemoryItem[] | null>(null);
  const [statusFilter, setStatusFilter] = useState<MemoryStatus | 'all'>('active');
  const [enabled, setEnabled] = useState(true);
  const [loading, setLoading] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  /** 加载失败（区别于「还在加载」—— 否则表格会永远转圈） */
  const [loadFailed, setLoadFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  /** 彻底删除是另一个请求（跟归档不共用一个 loading 状态，否则两个按钮一起转） */
  const [purgeBusyId, setPurgeBusyId] = useState<string | null>(null);

  // 新增 Modal
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [createForm] = Form.useForm<{ content: string; category: MemoryCategory }>();
  const [createSubmitting, setCreateSubmitting] = useState(false);

  // 编辑 Modal
  const [editing, setEditing] = useState<UserMemoryItem | null>(null);
  const [editForm] = Form.useForm<{ content: string; category: MemoryCategory }>();
  const [editSubmitting, setEditSubmitting] = useState(false);

  // 请求序号：快速连点筛选时会同时有多个请求在飞，
  // 先发后到的旧结果会把新数据覆盖掉 —— 只认最后一次发起的那个。
  const reqSeq = useRef(0);
  const load = useCallback(async (): Promise<void> => {
    const seq = ++reqSeq.current;
    setLoading(true);
    setErrMsg(null);
    setLoadFailed(false);
    try {
      const res = await fetchMyMemories({ status: statusFilter });
      if (seq !== reqSeq.current) {
        return; // 已经有更新的请求发出去了，丢弃这次的结果
      }
      setRows(res.memories);
      setEnabled(res.memory_enabled);
    } catch (err: unknown) {
      if (seq !== reqSeq.current) {
        return;
      }
      // ⚠️ 失败时不能把 rows 留成 null —— null 表示「还在加载」，
      //    表格会永远转圈，用户以为还在加载，不会去看上面的错误提示
      setRows([]);
      setLoadFailed(true);
      setErrMsg(errorMessage(err, '加载记忆失败'));
    } finally {
      if (seq === reqSeq.current) {
        setLoading(false);
      }
    }
  }, [statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  // ===== 开关 =====
  const onToggle = async (next: boolean): Promise<void> => {
    try {
      await updateMyMemorySetting(next);
      setEnabled(next);
      message.success(next ? '已开启自动记忆' : '已关闭自动记忆');
    } catch (err: unknown) {
      message.error(errorMessage(err, '设置失败'));
      await load();
    }
  };

  // ===== 新增 =====
  const submitCreate = async (): Promise<void> => {
    const v = await createForm.validateFields().catch(() => null);
    if (v === null) return;
    setCreateSubmitting(true);
    try {
      await createMyMemory({ content: v.content, category: v.category });
      message.success('已添加');
      setCreatingOpen(false);
      createForm.resetFields();
      await load();
    } catch (err: unknown) {
      message.error(errorMessage(err, '添加失败'));
    } finally {
      setCreateSubmitting(false);
    }
  };

  // ===== 编辑 =====
  const openEdit = (row: UserMemoryItem): void => {
    editForm.setFieldsValue({ content: row.content, category: row.category });
    setEditing(row);
  };

  const submitEdit = async (): Promise<void> => {
    if (editing === null) return;
    const v = await editForm.validateFields().catch(() => null);
    if (v === null) return;
    setEditSubmitting(true);
    try {
      await updateMyMemory(editing.id, { content: v.content, category: v.category });
      message.success('已保存');
      setEditing(null);
      await load();
    } catch (err: unknown) {
      message.error(errorMessage(err, '保存失败'));
    } finally {
      setEditSubmitting(false);
    }
  };

  // ===== 删除 / 恢复 =====
  const onDelete = async (row: UserMemoryItem): Promise<void> => {
    setBusyId(row.id);
    try {
      await deleteMyMemory(row.id);
      message.success('已删除');
      await load();
    } catch (err: unknown) {
      message.error(errorMessage(err, '删除失败'));
    } finally {
      setBusyId(null);
    }
  };

  const onRestore = async (row: UserMemoryItem): Promise<void> => {
    setBusyId(row.id);
    try {
      await restoreMyMemory(row.id);
      message.success('已恢复');
      await load();
    } catch (err: unknown) {
      message.error(errorMessage(err, '恢复失败'));
    } finally {
      setBusyId(null);
    }
  };

  const onClearAll = async (): Promise<void> => {
    try {
      await clearMyMemories();
      message.success('已清空全部记忆');
      await load();
    } catch (err: unknown) {
      message.error(errorMessage(err, '清空失败'));
    }
  };

  // ===== 彻底删除（物理删，不可恢复）=====
  const onPurge = async (row: UserMemoryItem): Promise<void> => {
    setPurgeBusyId(row.id);
    try {
      await purgeMyMemory(row.id);
      message.success('已彻底删除');
      await load();
    } catch (err: unknown) {
      message.error(errorMessage(err, '彻底删除失败'));
    } finally {
      setPurgeBusyId(null);
    }
  };

  const onPurgeAll = async (): Promise<void> => {
    try {
      await purgeMyMemories();
      message.success('已彻底删除全部记忆');
      await load();
    } catch (err: unknown) {
      message.error(errorMessage(err, '彻底删除失败'));
    }
  };

  /** 彻底删除全部：不可恢复，用 Modal 而不是 Popconfirm 把话说清楚 */
  const confirmPurgeAll = (): void => {
    Modal.confirm({
      title: '彻底删除全部记忆？',
      // ⚠️ Modal.confirm 渲染的是**纯文本**，不是 markdown —— 别写 **加粗**
      content:
        '这些记忆会从数据库里物理删除，无法恢复，AI 也再也不会记得关于你的任何信息。' +
        '（只是想先清空、以后还能恢复的话，用「清空全部」就够了。）',
      okText: '彻底删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => onPurgeAll(),
    });
  };

  const columns: TableColumnsType<UserMemoryItem> = [
    {
      title: '内容',
      dataIndex: 'content',
      key: 'content',
      // ⚠️ 必须给显式宽度：tableLayout="fixed" 下，没写宽度的列分到「剩余空间」。
      //    其它列的固定宽度加起来超过容器时，剩余空间是负数 → 内容列被压成 0 宽。
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
      render: (s: UserMemoryItem['source']) => (
        <Tag color={s === 'user' ? 'green' : 'default'}>{MEMORY_SOURCE_LABEL[s]}</Tag>
      ),
    },
    {
      title: '被引用',
      dataIndex: 'hit_count',
      key: 'hit_count',
      width: 80,
      // 窄屏先砍次要列，保住「内容」和「操作」
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
      width: 200,
      render: (_: unknown, row) => (
        <Space onClick={(e) => e.stopPropagation()}>
          <Button type="link" size="small" onClick={() => openEdit(row)}>
            编辑
          </Button>
          {row.status === 'active' ? (
            <Popconfirm
              title="确认删除这条记忆？"
              description="删除后 AI 不会再记得它。删错了可以在「已删除」里恢复。"
              okText="确认"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => void onDelete(row)}
            >
              <Button type="link" size="small" danger loading={busyId === row.id}>
                删除
              </Button>
            </Popconfirm>
          ) : (
            // 已归档的行：可以恢复，也可以彻底删掉（物理删，不可恢复）
            <Space size={0}>
              <Button
                type="link"
                size="small"
                loading={busyId === row.id}
                onClick={() => void onRestore(row)}
              >
                恢复
              </Button>
              <Popconfirm
                title="彻底删除这条记忆？"
                description="物理删除，无法恢复。"
                okText="彻底删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={() => void onPurge(row)}
              >
                <Button type="link" size="small" danger loading={purgeBusyId === row.id}>
                  彻底删除
                </Button>
              </Popconfirm>
            </Space>
          )}
        </Space>
      ),
    },
  ];

  const activeCount = (rows ?? []).filter((r) => r.status === 'active').length;

  return (
    <div>
      <PageHeader
        title="我的记忆"
        subtitle="AI 记住的关于你的信息。可以随时查看、改掉，或者干脆不让它记。"
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => {
                // 显式设值，不靠 Form.Item 的 initialValue ——
                // 那个在「关掉再打开」时不一定重新生效
                createForm.setFieldsValue({ content: '', category: 'preference' });
                setCreatingOpen(true);
              }}
            >
              添加记忆
            </Button>
          </>
        }
      />

      {errMsg !== null && (
        <Alert type="error" showIcon title={errMsg} style={{ marginBottom: 16 }} />
      )}

      <Card size="small" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 500 }}>自动记忆</div>
            <Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 13 }}>
              开启后，AI 会从对话里自动记住你提到的偏好和情况（比如「我是客服主管」「回答请简短些」）。
              关掉后既不会自动记，也不会把已有的记忆带进回答。
            </Paragraph>
          </div>
          <Switch checked={enabled} onChange={(v) => void onToggle(v)} />
        </div>
      </Card>

      <Card size="small" styles={{ body: { padding: 16 } }}>
        <Space wrap size={12} style={{ marginBottom: 12 }}>
          <Select
            value={statusFilter}
            onChange={setStatusFilter}
            style={{ width: 140 }}
            options={[
              { value: 'active', label: '生效中' },
              { value: 'archived', label: '已删除' },
              { value: 'all', label: '全部' },
            ]}
          />
          {/* ⚠️ 这两个按钮**一直可见** —— 以前外面套了
              `statusFilter !== 'archived' && activeCount > 0`，
              切到「已删除」筛选时它们整个消失，用户以为没有这些操作了。
              现在改成：按筛选器调整**作用范围 / 文案**，按钮本身一直在。 */}
          <Popconfirm
            title="确认清空全部记忆？"
            description={
              statusFilter === 'archived'
                ? '「清空全部」是把**生效中**的记忆归档（可恢复）—— 当前筛选是「已删除」，这里没有可归档的条目。要真正删掉它们，请用「彻底删除全部」。'
                : '所有**生效中**的记忆都会被删除（归档），AI 将不再记得关于你的任何信息。删错了还能在「已删除」里恢复。'
            }
            okText="确认清空"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void onClearAll()}
          >
            <Button danger size="small" disabled={activeCount === 0}>
              清空全部
            </Button>
          </Popconfirm>
          {/* 彻底删除 = 物理删，不可恢复。跟上面的「清空全部」分开，避免误点 */}
          <Button type="link" size="small" danger onClick={confirmPurgeAll}>
            彻底删除全部
          </Button>
        </Space>

        <Table
          rowKey="id"
          columns={columns}
          dataSource={rows ?? []}
          loading={loading}
          tableLayout="fixed"
          pagination={false}
          locale={{
            emptyText:
              loadFailed
                ? '加载失败，请点「刷新」重试'
                : rows === null
                  ? '加载中…'
                  : statusFilter === 'archived'
                    ? '没有已删除的记忆'
                    : '还没有记忆。跟 AI 聊几句，或者手动添加一条。',
          }}
        />
      </Card>

      {/* 新增 */}
      <Modal
        open={creatingOpen}
        title="添加记忆"
        okText="添加"
        cancelText="取消"
        confirmLoading={createSubmitting}
        onOk={submitCreate}
        onCancel={() => {
          setCreatingOpen(false);
          createForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical" preserve={false}>
          <Form.Item
            name="content"
            label="记忆内容"
            rules={[{ required: true, message: '内容不能为空' }]}
            extra="写成一句陈述句，例如「回答请用中文，尽量简短」。"
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

      {/* 编辑 */}
      <Modal
        open={editing !== null}
        title="编辑记忆"
        okText="保存"
        cancelText="取消"
        confirmLoading={editSubmitting}
        onOk={submitEdit}
        onCancel={() => setEditing(null)}
        destroyOnHidden
      >
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
      </Modal>
    </div>
  );
}
