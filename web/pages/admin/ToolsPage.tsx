import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Radio,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  ApiOutlined,
  CheckCircleOutlined,
  EditOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { PageHeader } from '../../components/shell';
import {
  createTool,
  deleteTool,
  fetchBuiltinTools,
  fetchTools,
  testTool,
  toolErrorMessage,
  updateTool,
  type BuiltinToolInfo,
  type ToolItem,
  type ToolTestResult,
} from '../../lib/adminTools';

/**
 * §5.5 工具管理 `/admin/tools`（C2）—— 详见 docs/04-c-ui-后台管理页面.md §5.5
 *
 * ## 这页在做什么
 *
 * 平台内置的工具**实现在代码里**，这一页做的是**注册**：
 * 给它起个调用名、写一段描述、决定用不用。
 *
 * **描述是给模型看的** —— 它直接决定模型调不调这个工具。
 * 同一个内置工具，餐饮租户该写「查这个门店的订单」，物流租户该写「查运单轨迹」。
 * 所以「改描述」是这页最值钱的功能，改完**下一轮对话立刻生效**（不用重启）。
 *
 * ## 支持的两类
 *
 * - `builtin` —— 平台内置实现（实现在代码里，这一页做的是「注册」）
 * - `http` —— **本地 mock 接口**：保留 url / method 的配置形状，
 *   但平台**不真的发请求**（真出网是跨系统 + 出网策略问题，见 12-e 需求裁定表 #2）。
 *   租户填的接口地址只用来展示和生成确定性 mock 响应。
 *
 * ⚠️ `mcp` **不支持** —— 涉及多个系统（租户那边得自己跑 MCP server），
 * 见 12-e 需求裁定表 #1。
 */

const { Text, Paragraph } = Typography;

export function ToolsPage(): ReactElement {
  const [tools, setTools] = useState<ToolItem[]>([]);
  const [builtins, setBuiltins] = useState<BuiltinToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ToolItem | 'new' | null>(null);
  const [testResult, setTestResult] = useState<ToolTestResult | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [rows, impls] = await Promise.all([fetchTools(), fetchBuiltinTools()]);
      setTools(rows);
      setBuiltins(impls);
    } catch (err: unknown) {
      message.error(toolErrorMessage(err, '加载工具列表失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onToggle = useCallback(
    async (row: ToolItem): Promise<void> => {
      try {
        await updateTool(row.id, { enabled: !row.enabled });
        message.success(
          row.enabled
            ? `已禁用「${row.name}」，下一轮对话不再调用它`
            : `已启用「${row.name}」，下一轮对话立即生效`,
        );
        await reload();
      } catch (err: unknown) {
        message.error(toolErrorMessage(err, '操作失败'));
      }
    },
    [reload],
  );

  const onTest = useCallback(async (row: ToolItem): Promise<void> => {
    setTestingId(row.id);
    setTestResult(null);
    try {
      const res = await testTool(row.id);
      setTestResult(res);
      if (res.ok) {
        message.success(`调用正常 · ${res.took_ms} ms`);
      } else {
        message.error(`调用失败：${res.error ?? '未知错误'}`);
      }
    } catch (err: unknown) {
      message.error(toolErrorMessage(err, '试连失败'));
    } finally {
      setTestingId(null);
    }
  }, []);

  const onDelete = useCallback(
    async (row: ToolItem): Promise<void> => {
      try {
        await deleteTool(row.id);
        message.success(`已删除「${row.name}」`);
        await reload();
      } catch (err: unknown) {
        message.error(toolErrorMessage(err, '删除失败'));
      }
    },
    [reload],
  );

  const columns = [
    {
      title: '调用名',
      dataIndex: 'name',
      render: (v: string, row: ToolItem) => (
        <Space>
          <Text strong>{v}</Text>
          <Tag color="blue">{row.type}</Tag>
          {row.type === 'http' && <Tag color="cyan">本地 mock</Tag>}
          {row.enabled ? <Tag color="green">启用中</Tag> : <Tag>已禁用</Tag>}
          {row.requires_confirmation && <Tag color="orange">需确认</Tag>}
        </Space>
      ),
    },
    {
      title: '实现',
      dataIndex: 'builtin_label',
      render: (v: string | null, row: ToolItem) =>
        row.type === 'http' ? (
          <Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: row.url ?? '' }}>
            {`${row.method ?? 'GET'} ${row.url ?? '—'}`}
          </Text>
        ) : v === null ? (
          <Text type="secondary">—</Text>
        ) : (
          <Text>{v}</Text>
        ),
    },
    {
      title: '描述（模型看到的就是这段）',
      dataIndex: 'description',
      render: (v: string | null) => (
        <Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: v }}>
          {v ?? '—'}
        </Text>
      ),
    },
    {
      title: '操作',
      render: (_: unknown, row: ToolItem) => (
        <Space size={4}>
          <Button size="small" type="link" onClick={() => void onToggle(row)}>
            {row.enabled ? '禁用' : '启用'}
          </Button>
          <Button
            size="small"
            type="text"
            icon={<ApiOutlined />}
            loading={testingId === row.id}
            onClick={() => void onTest(row)}
          />
          <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEditing(row)} />
          <Popconfirm
            title={`删除「${row.name}」？`}
            description="删掉后 AI 就不再有这个工具了。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void onDelete(row)}
          >
            <Button size="small" type="link" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="工具管理"
        subtitle="注册 AI 可以调用的工具。描述决定模型什么时候调它 —— 写清楚，模型才用得上。"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
            注册工具
          </Button>
        }
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title="工具 = 模型能调的函数。注册之后 AI 在对话里会真的去调它，而不是凭空编一个结果。"
        description="本轮提供的是平台内置的电商客服工具（订单状态 / 商品信息 / 物流轨迹 / 可用优惠 / 知识库清单 / 提交退款申请）。「http」「mcp」两类（调租户自己的接口）还没开放。"
      />

      {testResult !== null && (
        <Alert
          style={{ marginBottom: 16 }}
          type={testResult.ok ? 'success' : 'error'}
          showIcon
          icon={testResult.ok ? <CheckCircleOutlined /> : undefined}
          title={testResult.ok ? `调用正常 · ${testResult.took_ms} ms` : `调用失败：${testResult.error ?? '未知错误'}`}
          description={
            testResult.ok ? (
              <Text code style={{ fontSize: 12 }}>
                {JSON.stringify(testResult.output)}
              </Text>
            ) : undefined
          }
        />
      )}

      <Card size="small">
        <Table<ToolItem>
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={tools}
          pagination={false}
          locale={{
            emptyText: (
              <Empty description="还没有注册任何工具">
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
                  注册第一个工具
                </Button>
              </Empty>
            ),
          }}
        />
      </Card>

      <ToolEditor
        target={editing}
        builtins={builtins}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void reload();
        }}
      />
    </div>
  );
}

/**
 * 注册 / 编辑抽屉。
 *
 * 编辑时**只能改描述、启停、敏感标记** —— 调用名和实现注册后不改
 * （改调用名等于换了个工具，模型的历史认知全废）。
 */
function ToolEditor({
  target,
  builtins,
  onClose,
  onSaved,
}: {
  target: ToolItem | 'new' | null;
  builtins: BuiltinToolInfo[];
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const isNew = target === 'new';
  const editing = target !== null && target !== 'new' ? target : null;

  // 跟随表单里的「类型」切换显示 —— 选了 http 就把内置下拉框换成接口配置
  const watchedType = Form.useWatch('type', form);
  const isHttp = editing !== null ? editing.type === 'http' : watchedType === 'http';

  useEffect(() => {
    if (editing === null) {
      return;
    }
    form.setFieldsValue({
      type: editing.type,
      name: editing.name,
      description: editing.description ?? '',
      builtin: editing.builtin ?? undefined,
      url: editing.url ?? '',
      method: editing.method ?? 'GET',
      enabled: editing.enabled,
      requires_confirmation: editing.requires_confirmation,
    });
  }, [editing, form]);

  const onOk = useCallback(async (): Promise<void> => {
    const values = (await form.validateFields()) as Record<string, unknown>;
    setSaving(true);
    try {
      const base = {
        description: String(values.description ?? ''),
        enabled: values.enabled === undefined ? true : Boolean(values.enabled),
        requires_confirmation:
          values.requires_confirmation === undefined
            ? undefined
            : Boolean(values.requires_confirmation),
      };

      if (editing === null) {
        if (values.type === 'http') {
          await createTool({
            name: String(values.name ?? ''),
            type: 'http',
            url: String(values.url ?? ''),
            method: String(values.method ?? 'GET'),
            mock_status: values.mock_status === undefined ? 200 : Number(values.mock_status),
            ...base,
          });
        } else {
          await createTool({
            name: String(values.name ?? ''),
            type: 'builtin',
            builtin: String(values.builtin ?? ''),
            ...base,
          });
        }
        message.success('已注册，下一轮对话立即生效');
      } else {
        // 编辑：调用名和类型注册后不改（改调用名等于换了个工具，模型的历史认知全废）
        // 但 http 工具的接口配置可以改 —— url / method 不是模型的调用名
        if (editing.type === 'http') {
          await updateTool(editing.id, {
            description: base.description,
            enabled: base.enabled,
            requires_confirmation: base.requires_confirmation,
            url: values.url === undefined ? undefined : String(values.url),
            method: values.method === undefined ? undefined : String(values.method),
            mock_status:
              values.mock_status === undefined ? undefined : Number(values.mock_status),
          });
        } else {
          await updateTool(editing.id, {
            description: base.description,
            enabled: base.enabled,
            requires_confirmation: base.requires_confirmation,
          });
        }
        message.success('已保存，下一轮对话立即生效');
      }
      onSaved();
    } catch (err: unknown) {
      message.error(toolErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  }, [editing, form, onSaved]);

  return (
    <Drawer
      open={target !== null}
      title={isNew ? '注册工具' : `编辑「${editing?.name ?? ''}」`}
      size={480}
      onClose={onClose}
      extra={
        <Space>
          <Button onClick={onClose}>取消</Button>
          <Button type="primary" loading={saving} onClick={() => void onOk()}>
            保存
          </Button>
        </Space>
      }
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        initialValues={{ enabled: true, requires_confirmation: false, type: 'builtin', method: 'GET' }}
      >
        {isNew && (
          <Form.Item
            name="type"
            label="类型"
            extra="「http 接口」是本地 mock：平台不会真的向那个地址发请求，只按参数生成模拟响应。"
          >
            <Radio.Group>
              <Radio value="builtin">内置实现</Radio>
              <Radio value="http">http 接口（本地 mock）</Radio>
            </Radio.Group>
          </Form.Item>
        )}

        {!isHttp ? (
          <Form.Item
            name="builtin"
            label="内置工具"
            rules={[{ required: true, message: '选一个平台内置工具' }]}
            extra="工具的实现在平台代码里，这里选的是「用哪一个」。"
          >
            <Select
              placeholder="选一个内置工具"
              disabled={!isNew}
              options={builtins.map((b) => ({
                value: b.key,
                label: `${b.name}（${b.key}）${b.sensitive ? ' · 敏感' : ''}`,
              }))}
            />
          </Form.Item>
        ) : (
          <>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              message="本地 mock 接口"
              description="平台不会真的向这个地址发请求 —— 它只用来展示和生成确定性模拟响应。真接外部系统是跨系统的事，本平台不做。"
            />
            <Form.Item
              name="url"
              label="接口地址"
              rules={[
                { required: true, message: '填一个目标地址' },
                { pattern: /^https?:\/\/\S+$/, message: '要 http:// 或 https:// 开头' },
              ]}
              extra="例：https://api.example.com/orders/{order_no}"
            >
              <Input placeholder="https://api.example.com/orders/{order_no}" />
            </Form.Item>
            <Form.Item name="method" label="方法">
              <Select
                options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => ({
                  value: m,
                  label: m,
                }))}
              />
            </Form.Item>
            <Form.Item
              name="mock_status"
              label="模拟状态码"
              extra="默认 200。填非 2xx（比如 500）可以演示「接口调不通」时 AI 怎么应对。"
            >
              <InputNumber min={100} max={599} style={{ width: '100%' }} />
            </Form.Item>
          </>
        )}

        <Form.Item
          name="name"
          label="调用名"
          rules={[
            { required: true, message: '给模型一个调用名' },
            {
              pattern: /^[a-z][a-z0-9_-]{1,63}$/,
              message: '小写字母开头，只能含小写字母 / 数字 / 下划线 / 短横线，长度 2~64',
            },
          ]}
          extra="模型调用时用的就是这个名字，只能是英文标识符。"
        >
          <Input placeholder="例：query_order_status" disabled={!isNew} />
        </Form.Item>

        <Form.Item
          name="description"
          label="描述"
          extra="这段话是模型看的 —— 写清楚「什么时候该调它」，模型才调得对。"
        >
          <Input.TextArea
            rows={4}
            placeholder="例：查询一个订单的当前状态、物流承运商和预计送达时间。当用户问「订单 XX 到哪了」时使用。"
          />
        </Form.Item>

        <Form.Item name="enabled" label="启用" valuePropName="checked">
          <Switch checkedChildren="启用" unCheckedChildren="禁用" />
        </Form.Item>

        <Form.Item
          name="requires_confirmation"
          label="需要用户确认"
          valuePropName="checked"
          extra="勾上后，AI 调用这个工具前会先问用户「确认吗」，用户点了才真正执行。"
        >
          <Switch checkedChildren="需确认" unCheckedChildren="直接执行" />
        </Form.Item>

        {editing !== null && (
          <Paragraph type="secondary" style={{ fontSize: 12 }}>
            调用名和类型注册后不能再改 —— 改调用名等于换了个工具，模型的历史认知就全废了。
            需要换实现的话，删掉重新注册一个。
          </Paragraph>
        )}
      </Form>
    </Drawer>
  );
}
