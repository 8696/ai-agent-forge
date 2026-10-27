import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  Upload,
  message,
  theme,
} from 'antd';
import type { TableColumnsType } from 'antd';
import {
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import { PageHeader } from '../../components/shell/PageHeader';
import { fetchPromptVersions, type PromptVersionItem } from '../../lib/adminConfig';
import {
  createDataset,
  deleteDataset,
  evaluationErrorMessage,
  fetchDataset,
  fetchDatasets,
  startRun,
  type EvaluationDataset,
  type EvaluationDatasetItem,
} from '../../lib/adminEvaluation';

const { Paragraph, Text } = Typography;

const JSONL_EXAMPLE = `{"question": "年假可以跨年结转吗？", "reference_answer": "最多可结转 5 天", "scenario": "年假", "difficulty": "medium"}
{"question": "发票什么时候截止提交？", "reference_answer": "次月 15 日前", "scenario": "报销", "difficulty": "easy"}`;

/**
 * /admin/evaluation/datasets —— 评测集管理（D1）
 *
 * 评测集 = 一组题目（question + 可选参考答案）。
 * 跑批时用**租户当前的提示词 + 知识库**回答这些题，再让大模型当裁判打分。
 *
 * UI 详见 docs/04-c-ui-后台管理页面.md §5.6.1
 */
export function EvaluationDatasetsPage(): ReactElement {
  // 颜色走 antd token —— 写死浅色的话，深色模式下几乎看不见
  const { token } = theme.useToken();
  const [rows, setRows] = useState<EvaluationDataset[] | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const [creatingOpen, setCreatingOpen] = useState(false);
  const [createForm] = Form.useForm<{
    name: string;
    version?: string;
    description?: string;
    jsonl: string;
  }>();
  const [createSubmitting, setCreateSubmitting] = useState(false);

  const [detail, setDetail] = useState<{ dataset: EvaluationDataset; items: EvaluationDatasetItem[] } | null>(
    null,
  );

  // ===== 跑评测（可选指定提示词版本）=====
  const [runTarget, setRunTarget] = useState<EvaluationDataset | null>(null);
  /**
   * 跑批用哪个提示词版本：
   * - `__active__`  = 跟随租户当前生效的版本（默认，跟以前一样）
   * - `__builtin__` = 显式用内置默认提示词
   * - 具体版本号     = 用那个版本
   */
  const [runVersionKey, setRunVersionKey] = useState<string>('__active__');
  const [promptVersions, setPromptVersions] = useState<PromptVersionItem[]>([]);
  const [runSubmitting, setRunSubmitting] = useState(false);

  /** 组件还活着吗 —— 避免卸载后 setState */
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = async (): Promise<void> => {
    setErrMsg(null);
    try {
      const res = await fetchDatasets();
      if (!aliveRef.current) return;
      setRows(res);
    } catch (err: unknown) {
      if (!aliveRef.current) return;
      setRows(null);
      setErrMsg(evaluationErrorMessage(err, '加载评测集失败'));
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const openDetail = async (row: EvaluationDataset): Promise<void> => {
    try {
      const res = await fetchDataset(row.id);
      if (!aliveRef.current) return;
      setDetail(res);
    } catch (err: unknown) {
      if (!aliveRef.current) return;
      message.error(evaluationErrorMessage(err, '加载评测集详情失败'));
    }
  };

  const submitCreate = async (): Promise<void> => {
    const v = await createForm.validateFields().catch(() => null);
    if (v === null) return;
    setCreateSubmitting(true);
    try {
      const res = await createDataset({
        name: v.name,
        version: v.version,
        description: v.description ?? null,
        jsonl: v.jsonl,
      });
      message.success(
        res.skipped.length > 0
          ? `已创建「${res.name}」，${res.item_count} 条题目（${res.skipped.length} 行被跳过）`
          : `已创建「${res.name}」，${res.item_count} 条题目`,
      );
      setCreatingOpen(false);
      createForm.resetFields();
      await load();
    } catch (err: unknown) {
      message.error(evaluationErrorMessage(err, '创建评测集失败'));
    } finally {
      setCreateSubmitting(false);
    }
  };

  const runNow = async (row: EvaluationDataset): Promise<void> => {
    try {
      // ⚠️ undefined（不传）= 跟随当前生效版本；null = 显式内置默认；字符串 = 指定版本
      const promptVersion =
        runVersionKey === '__active__'
          ? undefined
          : runVersionKey === '__builtin__'
            ? null
            : runVersionKey;
      const run = await startRun(row.id, promptVersion);
      setRunTarget(null);
      message.success(
        `已开始评测（${run.total_items} 题），跑完后去「评测结果」页看分数`,
      );
    } catch (err: unknown) {
      message.error(evaluationErrorMessage(err, '触发评测失败'));
    } finally {
      setRunSubmitting(false);
    }
  };

  /** 打开「跑评测」弹窗 —— 同时把可选的提示词版本拉出来 */
  const openRun = async (row: EvaluationDataset): Promise<void> => {
    setRunTarget(row);
    setRunVersionKey('__active__');
    setRunSubmitting(false);
    try {
      setPromptVersions(await fetchPromptVersions());
    } catch (err: unknown) {
      setPromptVersions([]);
      message.error(evaluationErrorMessage(err, '加载提示词版本失败'));
    }
  };

  const onDelete = async (row: EvaluationDataset): Promise<void> => {
    try {
      await deleteDataset(row.id);
      message.success(`已删除「${row.name}」`);
      await load();
    } catch (err: unknown) {
      message.error(evaluationErrorMessage(err, '删除失败'));
    }
  };

  const columns: TableColumnsType<EvaluationDataset> = [
    {
      title: '名称',
      dataIndex: 'name',
      key: 'name',
      ellipsis: true,
      render: (name: string, row) => (
        <Space size={6}>
          <span style={{ fontWeight: 500 }}>{name}</span>
          <Tag>{row.version}</Tag>
        </Space>
      ),
    },
    {
      title: '题目条数',
      dataIndex: 'item_count',
      key: 'item_count',
      width: 110,
      render: (v: number) => v.toLocaleString('zh-CN'),
    },
    {
      title: '跑过次数',
      dataIndex: 'run_count',
      key: 'run_count',
      width: 100,
    },
    {
      title: '最近总分',
      dataIndex: 'latest_score',
      key: 'latest_score',
      width: 110,
      render: (v: number | null) =>
        v === null ? <span style={{ color: token.colorTextTertiary }}>未跑过</span> : `${v.toFixed(2)} / 5`,
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 180,
      render: (t: string) => new Date(t).toLocaleString(),
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      render: (_: unknown, row) => (
        <Space onClick={(e) => e.stopPropagation()}>
          <Button type="link" size="small" onClick={() => void openDetail(row)}>
            查看
          </Button>
          <Button
            type="link"
            size="small"
            icon={<PlayCircleOutlined />}
            onClick={() => void openRun(row)}
          >
            跑评测
          </Button>
          <Popconfirm
            title={`确认删除「${row.name}」？`}
            description="题目和历史跑批记录会一起删掉，不可撤销。"
            okText="确认"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => void onDelete(row)}
          >
            <Button type="link" size="small" danger>
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
        title="评测集"
        subtitle="一组用来衡量回答质量的题目。跑评测时用租户当前的提示词 + 知识库回答，再让大模型当裁判打分。"
        breadcrumb={[{ title: '首页' }, { title: '评测' }, { title: '评测集' }]}
        extra={
          <>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={() => setCreatingOpen(true)}
            >
              新建评测集
            </Button>
          </>
        }
      />

      {errMsg !== null && (
        <Alert type="error" showIcon title={errMsg} style={{ marginBottom: 16 }} />
      )}

      <Card styles={{ body: { padding: 16 } }}>
        <Table
          rowKey="id"
          columns={columns}
          dataSource={rows ?? []}
          loading={rows === null}
          tableLayout="fixed"
          pagination={false}
          onRow={(row) => ({
            onClick: () => {
              void openDetail(row);
            },
            style: { cursor: 'pointer' },
          })}
          locale={{ emptyText: rows === null ? '加载中…' : '还没有评测集，上传一份跑跑看' }}
        />
      </Card>

      {/* 跑评测 —— 可选指定提示词版本（A/B 对比的前提） */}
      <Modal
        open={runTarget !== null}
        title={`跑评测 · ${runTarget?.name ?? ''}`}
        width={560}
        okText="开始评测"
        cancelText="取消"
        confirmLoading={runSubmitting}
        onOk={() => {
          if (runTarget === null) return;
          setRunSubmitting(true);
          void runNow(runTarget);
        }}
        onCancel={() => setRunTarget(null)}
        destroyOnHidden
      >
        <Paragraph type="secondary" style={{ fontSize: 13 }}>
          默认用租户<strong>当前生效</strong>的提示词跑。想比较两个版本的效果，
          就用同一个评测集分别跑两次（各选一个版本），再去「评测 → 版本对比」页看差异。
        </Paragraph>
        <div style={{ marginBottom: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            提示词版本
          </Text>
        </div>
        <Select
          style={{ width: '100%' }}
          value={runVersionKey}
          onChange={(v: string) => setRunVersionKey(v)}
          options={[
            { value: '__active__', label: '跟随当前生效的版本' },
            { value: '__builtin__', label: '内置默认提示词' },
            ...promptVersions.map((p) => ({
              value: p.version,
              label: `${p.version}${p.status === 'production' ? '（生效中）' : ''}${
                p.status === 'draft' ? '（草稿）' : ''
              }`,
            })),
          ]}
        />
      </Modal>

      {/* 新建 */}
      <Modal
        open={creatingOpen}
        title="新建评测集"
        width={720}
        okText="创建"
        cancelText="取消"
        confirmLoading={createSubmitting}
        onOk={() => void submitCreate()}
        onCancel={() => {
          setCreatingOpen(false);
          createForm.resetFields();
        }}
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }} align="start">
            <Form.Item
              name="name"
              label="名称"
              rules={[{ required: true, message: '请输入名称' }]}
              style={{ flex: 1 }}
            >
              <Input placeholder="例：员工手册回归集" />
            </Form.Item>
            <Form.Item name="version" label="版本" style={{ width: 120 }}>
              <Input placeholder="v1" />
            </Form.Item>
          </Space>
          <Form.Item name="description" label="备注">
            <Input placeholder="这批评测想验证什么（可选）" />
          </Form.Item>
          <Form.Item
            name="jsonl"
            label="题目（JSONL，每行一条）"
            rules={[{ required: true, message: '请粘贴题目' }]}
            extra="每行一个 JSON 对象，至少包含 question；reference_answer / scenario / difficulty 可选。坏行会被跳过，不会影响其它行。"
          >
            <Input.TextArea rows={10} placeholder={JSONL_EXAMPLE} style={{ fontFamily: 'monospace' }} />
          </Form.Item>
          <Upload
            accept=".jsonl,.txt,.json"
            maxCount={1}
            showUploadList={false}
            beforeUpload={(file) => {
              void file.text().then((text) => {
                createForm.setFieldValue('jsonl', text);
                message.success(`已读入 ${file.name}`);
              });
              return false;
            }}
          >
            <Button icon={<UploadOutlined />}>从文件读入 JSONL</Button>
          </Upload>
        </Form>
      </Modal>

      {/* 详情抽屉 */}
      <Drawer
        open={detail !== null}
        title={detail === null ? '' : `评测集 · ${detail.dataset.name}`}
        size={720}
        onClose={() => setDetail(null)}
        destroyOnHidden
      >
        {detail !== null && (
          <>
            <Paragraph type="secondary">
              共 {detail.dataset.item_count} 条题目，这里预览前 {detail.items.length} 条。
            </Paragraph>
            {detail.items.map((item, idx) => (
              <Card key={item.id} size="small" style={{ marginBottom: 8 }}>
                <Space orientation="vertical" size={4} style={{ width: '100%' }}>
                  <Space wrap size={6}>
                    <Text strong>{idx + 1}.</Text>
                    {item.scenario !== null && <Tag color="blue">{item.scenario}</Tag>}
                    {item.difficulty !== null && <Tag>{item.difficulty}</Tag>}
                  </Space>
                  <Text>{item.question}</Text>
                  {item.reference_answer !== null && (
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      参考答案：{item.reference_answer}
                    </Text>
                  )}
                </Space>
              </Card>
            ))}
          </>
        )}
      </Drawer>
    </div>
  );
}
