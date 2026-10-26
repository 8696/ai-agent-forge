import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Row,
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
  ThunderboltOutlined,
} from '@ant-design/icons';
import { PageHeader } from '../../components/shell';
import {
  activateModel,
  checkEndpoint,
  configErrorMessage,
  createModel,
  deleteModel,
  fetchModels,
  testModel,
  updateModel,
  MODEL_USAGE_SCOPE_LABEL,
  type ModelTestResult,
  type ModelUsageScope,
  type ProcessLlmDefaults,
  type SaveModelInput,
  type TenantModelItem,
} from '../../lib/adminConfig';

/**
 * §5.4.1 模型选择 `/admin/models`（C4）—— 详见 docs/04-c-ui-后台管理页面.md §5.4
 *
 * **模型列表**：一条模型 = 一套完整连接配置（端点 + 密钥 + 采样参数），互不共享。
 *
 * ## 用途（usage_scope）
 *  - `chat`   对话模型
 *  - `memory` 记忆抽取模型（B4）—— 抽取是独立的一次 LLM 调用，
 *    推理型模型的思考 token 全额算输出 token，一次实测 2000+ token。
 *    单独配一条便宜模型给它用，是租户唯一能压这项成本的手段。
 *  - `summary` 会话摘要模型（B1 摘要压缩）—— 摘要也是独立的一次 LLM 调用，
 *    长对话每轮最多一次。同理，租户可以单独配一条便宜模型压这项成本。
 *
 * **每个用途各自一条「启用中」**：对话走 chat 那条，抽取走 memory 那条，摘要走 summary 那条。
 * 没配 memory / summary 模型时，它们回落到对话模型（不配也能用，行为跟以前一样）。
 *
 * 为什么每条都带完整连接配置而不是共用：换个模型还要复制一遍网关和密钥的话，
 * 配置一多就乱了；而且「自建网关 + 官方 API 并存」根本没法表达。
 */

const { Text, Paragraph } = Typography;

export function ModelListPage(): ReactElement {
  const [models, setModels] = useState<TenantModelItem[]>([]);
  const [defaults, setDefaults] = useState<ProcessLlmDefaults | null>(null);
  const [notes, setNotes] = useState<string[]>([]);
  const [canStoreKey, setCanStoreKey] = useState(true);
  const [activeChat, setActiveChat] = useState<TenantModelItem | null>(null);
  const [activeMemory, setActiveMemory] = useState<TenantModelItem | null>(null);
  const [activeSummary, setActiveSummary] = useState<TenantModelItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<TenantModelItem | 'new' | null>(null);
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchModels();
      setModels(data.models);
      setDefaults(data.process_defaults);
      setNotes(data.notes);
      setCanStoreKey(data.secret_encryption_enabled);
      // `?? null`：老后端不返回这几个键时拿到的是 undefined，
      // 下面只判 `=== null`，undefined 漏过去会炸 `.name`
      setActiveChat(data.active_chat ?? null);
      setActiveMemory(data.active_memory ?? null);
      setActiveSummary(data.active_summary ?? null);
    } catch (err: unknown) {
      message.error(configErrorMessage(err, '加载模型列表失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onActivate = useCallback(
    async (row: TenantModelItem): Promise<void> => {
      try {
        await activateModel(row.id);
        message.success(
          `已启用「${row.name}」（${MODEL_USAGE_SCOPE_LABEL[row.usage_scope]}），下一轮立即生效`,
        );
        setTestResult(null);
        await reload();
      } catch (err: unknown) {
        message.error(configErrorMessage(err, '切换失败'));
      }
    },
    [reload],
  );

  const onDelete = useCallback(
    async (row: TenantModelItem): Promise<void> => {
      try {
        await deleteModel(row.id);
        message.success('已删除');
        await reload();
      } catch (err: unknown) {
        message.error(configErrorMessage(err, '删除失败'));
      }
    },
    [reload],
  );

  const onTest = useCallback(async (row: TenantModelItem): Promise<void> => {
    setTestingId(row.id);
    setTestResult(null);
    try {
      const res = await testModel(row.id);
      setTestResult(res);
      if (res.ok) {
        message.success(`连接正常 · ${res.took_ms} ms`);
      } else {
        message.error(`连接失败：${res.error ?? '未知错误'}`);
      }
    } catch (err: unknown) {
      message.error(configErrorMessage(err, '测试失败'));
    } finally {
      setTestingId(null);
    }
  }, []);

  const columns = [
    {
      title: '名称',
      dataIndex: 'name',
      render: (v: string, row: TenantModelItem) => (
        <Space>
          <Text strong>{v}</Text>
          <Tag color={row.usage_scope === 'chat' ? 'blue' : 'purple'}>
            {MODEL_USAGE_SCOPE_LABEL[row.usage_scope]}
          </Tag>
          {row.is_active && <Tag color="green">启用中</Tag>}
        </Space>
      ),
    },
    { title: '模型 id', dataIndex: 'model_id', render: (v: string) => <Text code>{v}</Text> },
    {
      title: 'Base URL',
      dataIndex: 'base_url',
      render: (v: string) => (
        <Text type="secondary" style={{ fontSize: 12 }} ellipsis={{ tooltip: v }}>
          {v}
        </Text>
      ),
    },
    {
      title: 'API Key',
      dataIndex: 'api_key_hint',
      render: (v: string | null) => (v === null ? '—' : <Text code>{v}</Text>),
    },
    {
      title: '采样',
      render: (_: unknown, row: TenantModelItem) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          temp {row.temperature ?? '默认'} · out {row.max_output_tokens ?? '默认'}
        </Text>
      ),
    },
    {
      title: '操作',
      render: (_: unknown, row: TenantModelItem) => (
        <Space size={4}>
          {!row.is_active && (
            <Button size="small" type="link" onClick={() => void onActivate(row)}>
              启用
            </Button>
          )}
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
            description="删掉后不可恢复。"
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
        title="模型选择"
        subtitle="配多个模型随时切换，对话走「启用中」那条。留空的采样参数用平台默认。"
        extra={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setEditing('new')}
            disabled={!canStoreKey}
          >
            新建模型
          </Button>
        }
      />

      {!canStoreKey && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title="服务端未配置加密密钥，不能保存 API Key"
          description="出于安全考虑，CONFIG_ENCRYPTION_KEY 没配时禁止把密钥写进数据库。请联系平台管理员在 .env 里配置后再用。"
        />
      )}

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title={
          activeChat === null
            ? `当前对话走平台默认（${defaults?.provider ?? '未配置'} · ${defaults?.llmModel ?? '未配置'}）`
            : `当前对话使用「${activeChat.name}」（${activeChat.model_id}）`
        }
        description={
          <>
            <div style={{ marginBottom: 6 }}>
              记忆抽取：
              {activeMemory === null
                ? '未单独配置，跟随对话模型'
                : `使用「${activeMemory.name}」（${activeMemory.model_id}）`}
            </div>
            <div style={{ marginBottom: 6 }}>
              会话摘要：
              {activeSummary === null
                ? '未单独配置，跟随对话模型'
                : `使用「${activeSummary.name}」（${activeSummary.model_id}）`}
            </div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>{notes.map((n) => <li key={n}>{n}</li>)}</ul>
          </>
        }
      />

      {testResult !== null && (
        <Alert
          style={{ marginBottom: 16 }}
          type={testResult.ok ? 'success' : 'error'}
          showIcon
          icon={testResult.ok ? <CheckCircleOutlined /> : undefined}
          title={
            testResult.ok
              ? `连接正常 · ${testResult.provider} · ${testResult.model} · ${testResult.took_ms} ms`
              : `连接失败：${testResult.error ?? '未知错误'}`
          }
          description={testResult.ok ? `模型回复：${testResult.output ?? ''}` : undefined}
        />
      )}

      <Card size="small">
        <Table<TenantModelItem>
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={models}
          pagination={false}
          locale={{
            emptyText: (
              <Empty description="还没有配置模型">
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setEditing('new')}>
                  新建第一个模型
                </Button>
              </Empty>
            ),
          }}
        />
      </Card>

      <ModelEditor
        target={editing}
        defaults={defaults}
        models={models}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void reload();
        }}
      />

      <Paragraph type="secondary" style={{ marginTop: 12, fontSize: 12 }}>
        <ThunderboltOutlined /> 保存 / 切换后立即生效，下一轮对话就用新配置，不用重启服务。
      </Paragraph>
    </div>
  );
}

/** 新建 / 编辑的抽屉表单 */
function ModelEditor({
  target,
  defaults,
  models,
  onClose,
  onSaved,
}: {
  target: TenantModelItem | 'new' | null;
  defaults: ProcessLlmDefaults | null;
  /** 本租户的全部模型条目 —— 「备用模型」下拉框的候选来源 */
  models: TenantModelItem[];
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; reason?: string } | null>(null);
  const isNew = target === 'new';
  const editing = target !== null && target !== 'new' ? target : null;

  // 备用模型下拉的候选：**同一用途**、且不是自己
  const watchedScope = Form.useWatch('usage_scope', form);
  const fallbackOptions = models
    .filter((m) => m.usage_scope === (watchedScope ?? 'chat'))
    .filter((m) => m.id !== editing?.id)
    .map((m) => ({ value: m.id, label: `${m.name}（${m.model_id}）` }));

  useEffect(() => {
    if (editing === null) {
      return;
    }
    form.setFieldsValue({
      name: editing.name,
      provider: editing.provider,
      model_id: editing.model_id,
      base_url: editing.base_url,
      temperature: editing.temperature,
      max_output_tokens: editing.max_output_tokens,
      prompt_cache_enabled: editing.prompt_cache_enabled,
      usage_scope: editing.usage_scope,
      fallback_model_id: editing.fallback_model_id ?? undefined,
      api_key: '',
    });
  }, [editing, form]);

  /**
   * 「测一下这个端点」—— 调 `POST /api/v1/admin/config/models/check-endpoint`。
   *
   * ⚠️ **这个端点只做静态校验**（URL 合法 / 协议 / SSRF 的私网判定 / DNS 解析），
   *    **不真的调模型**（那要花钱）。所以它不能替代「保存后试连一次」。
   */
  const onCheckEndpoint = useCallback(async (): Promise<void> => {
    const baseUrl = (form.getFieldValue('base_url') as string | undefined) ?? '';
    if (baseUrl.trim() === '') {
      message.warning('先填 Base URL');
      return;
    }
    setChecking(true);
    setCheckResult(null);
    try {
      const res = await checkEndpoint(baseUrl.trim());
      setCheckResult(res);
    } catch (err: unknown) {
      setCheckResult({ ok: false, reason: configErrorMessage(err, '校验失败') });
    } finally {
      setChecking(false);
    }
  }, [form]);

  const onOk = useCallback(async (): Promise<void> => {
    const values = (await form.validateFields()) as Record<string, unknown>;
    setSaving(true);
    try {
      const payload: SaveModelInput = {
        name: values.name as string,
        provider: (values.provider as string) ?? null,
        model_id: values.model_id as string,
        base_url: values.base_url as string,
        temperature: (values.temperature as number | null) ?? null,
        max_output_tokens: (values.max_output_tokens as number | null) ?? null,
        prompt_cache_enabled: (values.prompt_cache_enabled as boolean) ?? true,
        usage_scope: (values.usage_scope as ModelUsageScope) ?? 'chat',
        // 备用模型：null = 取消备用；undefined = 不带这个键（新建时无所谓）
        fallback_model_id: (values.fallback_model_id as string | undefined) ?? null,
      };
      const typedKey = (values.api_key as string | undefined) ?? '';
      // 编辑时留空 = 保持原密钥；只有真填了才提交
      if (typedKey !== '' || isNew) {
        payload.api_key = typedKey;
      }
      if (editing === null) {
        await createModel(payload);
        message.success('已创建');
      } else {
        await updateModel(editing.id, payload);
        message.success('已保存');
      }
      onSaved();
    } catch (err: unknown) {
      message.error(configErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  }, [editing, form, isNew, onSaved]);

  return (
    <Drawer
      open={target !== null}
      title={isNew ? '新建模型' : `编辑「${editing?.name ?? ''}」`}
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
      <Form form={form} layout="vertical" initialValues={{ usage_scope: 'chat' }}>
        <Form.Item name="name" label="名称" rules={[{ required: true, message: '给它起个名字' }]}>
          <Input placeholder="例：生产-快 / 自建网关-慢" />
        </Form.Item>

        <Form.Item
          name="usage_scope"
          label="用途"
          rules={[{ required: true, message: '选一个用途' }]}
          extra="这条模型服务于哪条链路。「记忆抽取」用来给 B4 长期记忆的自动抽取配一条便宜模型，「会话摘要」用来给 B1 长对话摘要压缩配一条便宜模型 —— 没单独配置时它们都跟随对话模型。"
        >
          <Select
            options={[
              { value: 'chat', label: '对话（主链路）' },
              { value: 'memory', label: '记忆抽取（自动抽取记忆的 LLM 调用）' },
              { value: 'summary', label: '会话摘要（长对话压缩成摘要的 LLM 调用）' },
            ]}
          />
        </Form.Item>

        <Form.Item name="provider" label="Provider 标识">
          <Input placeholder="zhipu / openai-compatible（仅用于识别，不参与调用）" allowClear />
        </Form.Item>

        <Form.Item
          name="fallback_model_id"
          label="备用模型"
          extra={
            '主模型调用失败（provider 报错 / 连不上）时自动切到它再试一次 —— ' +
            '只在「一个内容字都还没吐出去」时才切，已经吐出去的字收不回来。' +
            '备用必须是**同一用途**下的另一条（用途不同、成本也不同）。'
          }
        >
          <Select
            allowClear
            placeholder="不配（主模型失败就直接报错）"
            options={fallbackOptions}
          />
        </Form.Item>

        <Form.Item
          name="model_id"
          label="模型 id"
          rules={[{ required: true, message: '模型 id 不能为空' }]}
          extra={
            defaults?.llmModel !== undefined && defaults.llmModel !== ''
              ? `平台默认是 ${defaults.llmModel}，这里填别的会覆盖它`
              : undefined
          }
        >
          <Input placeholder="例：glm-5.3" />
        </Form.Item>

        <Form.Item
          name="base_url"
          label="Base URL（Anthropic 协议端点）"
          rules={[{ required: true, message: 'Base URL 不能为空' }]}
          extra="生产环境不允许指向内网地址（防 SSRF）；结尾的 /v1 会自动补齐"
        >
          <Input placeholder="https://open.bigmodel.cn/api/anthropic" />
        </Form.Item>

        <Space orientation="vertical" style={{ width: '100%', marginBottom: 16 }}>
          <Button onClick={() => void onCheckEndpoint()} loading={checking}>
            测一下这个端点
          </Button>
          {checkResult !== null && (
            <Alert
              type={checkResult.ok ? 'success' : 'error'}
              showIcon
              title={checkResult.ok ? '端点看起来可用' : '端点不可用'}
              description={
                checkResult.ok
                  ? '只做了静态校验（URL / 协议 / 私网拦截 / DNS 解析），没有真的调模型 —— 能不能真的对话要靠保存后「试连一次」。'
                  : checkResult.reason
              }
            />
          )}
        </Space>

        <Form.Item
          name="api_key"
          label="API Key"
          rules={isNew ? [{ required: true, message: '新建必须填 API Key' }] : []}
          extra={
            editing?.has_api_key === true
              ? `已保存（${editing.api_key_hint}）。留空表示保持不变。`
              : '填写后加密存储，保存后无法再取回原文。'
          }
        >
          <Input.Password placeholder="仅提交用，不会回显" autoComplete="new-password" />
        </Form.Item>

        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="temperature" label="Temperature">
              <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} placeholder="默认 0.2" />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="max_output_tokens" label="Max Output Tokens">
              <InputNumber min={64} max={32768} step={128} style={{ width: '100%' }} placeholder="默认 2048" />
            </Form.Item>
          </Col>
        </Row>

        <Form.Item
          name="prompt_cache_enabled"
          label="提示词缓存"
          valuePropName="checked"
          extra="给系统提示词打 cacheControl，重复提问能命中缓存省 token"
        >
          <Switch checkedChildren="开" unCheckedChildren="关" />
        </Form.Item>
      </Form>
    </Drawer>
  );
}

