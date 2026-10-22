import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  Input,
  Modal,
  Popconfirm,
  Row,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { CopyOutlined, PlusOutlined, RollbackOutlined, UploadOutlined } from '@ant-design/icons';
import { PageHeader } from '../../components/shell';
import {
  configErrorMessage,
  createPromptVersion,
  deletePromptVersion,
  fetchBuiltinPrompt,
  fetchPromptVersion,
  fetchPromptVersions,
  publishPromptVersion,
  rollbackPromptVersion,
  updatePromptDraft,
  type PromptStatus,
  type PromptVersionItem,
} from '../../lib/adminConfig';

/**
 * §5.4.2 提示词配置 `/admin/model/prompt`（C3）
 * —— 详见 docs/04-c-ui-后台管理页面.md §5.4
 *
 * 版本流转：draft（可编辑）→ publish → production（当前生效，其余转 archived）。
 * 生产中的版本**不能直接改** —— 已经被真实用户用过了，静默改等于让线上行为
 * 无预告地漂移；必须「复制成新草稿 → 发布」。所以每条历史版本都带「以此新建草稿」。
 */

const { Text, Paragraph } = Typography;

const STATUS_META: Record<PromptStatus, { label: string; color: string }> = {
  draft: { label: '草稿', color: 'default' },
  production: { label: '生产中', color: 'green' },
  archived: { label: '已归档', color: 'orange' },
};

export function PromptEditorPage(): ReactElement {
  const [versions, setVersions] = useState<PromptVersionItem[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [description, setDescription] = useState('');
  const [builtin, setBuiltin] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newVersion, setNewVersion] = useState('');
  const [saving, setSaving] = useState(false);

  /** 切版本时按需拉正文（列表接口不返回 content） */
  const selectVersion = useCallback(async (version: string): Promise<void> => {
    try {
      const full = await fetchPromptVersion(version);
      setSelected(full.version);
      setContent(full.content);
      setDescription(full.description ?? '');
      setError(null);
    } catch (err: unknown) {
      message.error(configErrorMessage(err, '读取版本内容失败'));
    }
  }, []);

  const reload = useCallback(
    async (keepVersion?: string): Promise<void> => {
      try {
        const list = await fetchPromptVersions();
        setVersions(list);
        setError(null);
        const target = keepVersion ?? selected;
        if (target !== undefined && target !== null) {
          await selectVersion(target);
        }
      } catch (err: unknown) {
        setError(configErrorMessage(err, '加载提示词版本失败'));
      } finally {
        setLoading(false);
      }
    },
    [selected, selectVersion],
  );

  useEffect(() => {
    void (async () => {
      setLoading(true);
      try {
        const [list, def] = await Promise.all([fetchPromptVersions(), fetchBuiltinPrompt()]);
        setVersions(list);
        setBuiltin(def.content);
        setError(null);
        const prod = list.find((v) => v.status === 'production') ?? list[0];
        if (prod !== undefined) {
          const full = await fetchPromptVersion(prod.version);
          setSelected(full.version);
          setContent(full.content);
          setDescription(full.description ?? '');
        } else {
          setSelected(null);
          setContent(def.content);
        }
      } catch (err: unknown) {
        setError(configErrorMessage(err, '加载提示词失败'));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const onSaveDraft = useCallback(async (): Promise<void> => {
    if (selected === null) {
      message.info('先在左侧选一个版本');
      return;
    }
    const target = versions.find((v) => v.version === selected);
    if (target === undefined) {
      message.error('版本不存在');
      return;
    }
    if (target.status !== 'draft') {
      message.warning(`「${target.status === 'production' ? '生产中' : '已归档'}」的版本不能直接改，请用「以此新建草稿」`);
      return;
    }
    setSaving(true);
    try {
      await updatePromptDraft(selected, { content, description });
      message.success('草稿已保存（发布后才对用户生效）');
      await reload(selected);
    } catch (err: unknown) {
      message.error(configErrorMessage(err, '保存草稿失败'));
    } finally {
      setSaving(false);
    }
  }, [content, description, reload, selected, versions]);

  const onPublish = useCallback(
    async (version: string): Promise<void> => {
      try {
        await publishPromptVersion(version);
        message.success(`已发布 ${version}，立即对所有用户生效`);
        await reload(version);
      } catch (err: unknown) {
        message.error(configErrorMessage(err, '发布失败'));
      }
    },
    [reload],
  );

  const onRollback = useCallback(
    async (version: string): Promise<void> => {
      try {
        await rollbackPromptVersion(version);
        message.success(`已回滚到 ${version}`);
        await reload(version);
      } catch (err: unknown) {
        message.error(configErrorMessage(err, '回滚失败'));
      }
    },
    [reload],
  );

  const onCreate = useCallback(async (): Promise<void> => {
    if (newVersion.trim() === '') {
      message.warning('版本号不能为空');
      return;
    }
    try {
      await createPromptVersion({
        version: newVersion.trim(),
        content: content === '' ? builtin : content,
        ...(description === '' ? {} : { description }),
      });
      message.success(`草稿 ${newVersion.trim()} 已创建`);
      setNewOpen(false);
      setNewVersion('');
      await reload(newVersion.trim());
    } catch (err: unknown) {
      message.error(configErrorMessage(err, '创建失败'));
    }
  }, [builtin, content, description, newVersion, reload]);

  const selectedMeta = versions.find((v) => v.version === selected) ?? null;

  return (
    <div>
      <PageHeader
        title="提示词配置"
        subtitle="每个租户自己一套系统提示词，多版本并存。草稿可反复改，发布后立即对所有用户生效。"
        extra={
          <Button icon={<PlusOutlined />} onClick={() => setNewOpen(true)}>
            新建版本
          </Button>
        }
      />

      {error !== null && (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} />
      )}

      <Row gutter={16}>
        <Col xs={24} lg={7}>
          <Card
            size="small"
            title={`版本（${versions.length}）`}
            styles={{ body: { maxHeight: 560, overflowY: 'auto' } }}
          >
            {loading ? (
              <Text type="secondary">加载中…</Text>
            ) : versions.length === 0 ? (
              <Empty description="还没有自定义版本">
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setNewOpen(true)}>
                  新建第一个版本
                </Button>
              </Empty>
            ) : (
              <Space orientation="vertical" size={6} style={{ width: '100%' }}>
                {versions.map((v) => (
                  <Flex
                    key={v.id}
                    align="center"
                    gap={6}
                    style={{
                      padding: '8px 10px',
                      borderRadius: 6,
                      cursor: 'pointer',
                      background: v.version === selected ? 'rgba(47,84,235,0.08)' : undefined,
                    }}
                    onClick={() => void selectVersion(v.version)}
                  >
                    <Text strong style={{ flex: 1, minWidth: 0 }} ellipsis>
                      {v.version}
                    </Text>
                    <Tag color={STATUS_META[v.status].color}>{STATUS_META[v.status].label}</Tag>
                    {v.in_use && <Tag color="blue">生效中</Tag>}
                  </Flex>
                ))}
              </Space>
            )}

            {versions.length === 0 && (
              <Alert
                style={{ marginTop: 12 }}
                type="info"
                message="当前用的是内置默认提示词"
                description="新建一个版本并发布，即可完全自定义本租户的回答风格与规则。"
              />
            )}
          </Card>
        </Col>

        <Col xs={24} lg={17}>
          <Card
            size="small"
            title={selected === null ? '内置默认提示词（只读）' : `编辑 ${selected}`}
            extra={
              selected !== null && (
                <Space>
                  {selectedMeta?.status === 'draft' && (
                    <Button type="primary" loading={saving} onClick={() => void onSaveDraft()}>
                      保存草稿
                    </Button>
                  )}
                  {selectedMeta?.status !== 'production' && (
                    <Button icon={<UploadOutlined />} onClick={() => void onPublish(selected)}>
                      发布
                    </Button>
                  )}
                </Space>
              )
            }
          >
            {selected === null && (
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 12 }}
                message="这是内置默认提示词"
                description="点「新建版本」复制一份，就能在后台编辑自己的版本了。"
              />
            )}

            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              <Input
                placeholder="这个版本改了什么（便于回溯）"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={selected === null || selectedMeta?.status !== 'draft'}
              />

              <Input.TextArea
                value={content === '' ? builtin : content}
                onChange={(e) => setContent(e.target.value)}
                disabled={selected === null || selectedMeta?.status !== 'draft'}
                autoSize={{ minRows: 18, maxRows: 30 }}
                style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }}
              />

              <Text type="secondary" style={{ fontSize: 12 }}>
                支持占位符 <code>{'{{tenantName}}'}</code>，保存时会自动替换成本租户名称。
              </Text>

              {selected !== null && selectedMeta?.status === 'production' && (
                <Alert
                  type="warning"
                  showIcon
                  message="这是当前生效的版本"
                  description="生产中的版本不能直接改（避免线上行为无预告地漂移）。想调整请「以此新建草稿」，改完再发布。"
                />
              )}

              {selected !== null && selectedMeta?.status === 'archived' && (
                <Alert
                  type="info"
                  showIcon
                  message="这是历史版本"
                  description="可以直接点「发布」把它切回生产，或先复制成新草稿再改。"
                />
              )}
            </Space>

            {versions.length > 1 && selected !== null && (
              <Space style={{ marginTop: 12 }} wrap>
                <Button
                  icon={<RollbackOutlined />}
                  disabled={selectedMeta?.status === 'production'}
                  onClick={() => void onRollback(selected)}
                >
                  回滚到 {selected}
                </Button>
                <Button
                  icon={<CopyOutlined />}
                  onClick={() => {
                    setNewVersion(`${selected}-copy`);
                    setContent(content === '' ? builtin : content);
                    setNewOpen(true);
                  }}
                >
                  以此新建草稿
                </Button>
                <Popconfirm
                  title={`删除版本 ${selected}？`}
                  description="删掉后不能恢复。生产中的版本不能删。"
                  okText="删除"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  disabled={selectedMeta?.status === 'production'}
                  onConfirm={() => {
                    void (async () => {
                      try {
                        await deletePromptVersion(selected);
                        message.success('已删除');
                        setSelected(null);
                        await reload();
                      } catch (err: unknown) {
                        message.error(configErrorMessage(err, '删除失败'));
                      }
                    })();
                  }}
                >
                  <Button danger>删除该版本</Button>
                </Popconfirm>
              </Space>
            )}
          </Card>
        </Col>
      </Row>

      <Modal
        open={newOpen}
        title="新建提示词版本"
        okText="创建草稿"
        cancelText="取消"
        onOk={() => void onCreate()}
        onCancel={() => setNewOpen(false)}
      >
        <Paragraph type="secondary" style={{ fontSize: 12 }}>
          版本号只能字母数字和 - _（1~20 位），租户内唯一。当前编辑器里的内容会作为初始值。
        </Paragraph>
        <Input
          placeholder="例：v2"
          value={newVersion}
          onChange={(e) => setNewVersion(e.target.value)}
        />
      </Modal>
    </div>
  );
}