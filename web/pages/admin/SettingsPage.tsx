import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Row,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons';
import { PageHeader } from '../../components/shell';
import {
  configErrorMessage,
  fetchSettings,
  saveSettings,
  type SettingItem,
} from '../../lib/adminConfig';

/**
 * §5.9 租户设置 `/admin/settings` —— 通用配置页（KV 结构）
 * 详见 docs/04-c-ui-后台管理页面.md §5.9
 *
 * **页面是通用的**：后端 `/config/settings` 返回一组「配置项元信息 + 当前生效值」，
 * 这里按 category 分区渲染。加一个配置项 = 后端注册表加一条 + 这里自动多一行，
 * 前端不用改。
 *
 * 值的语义：平台默认 + 租户可覆盖；清空即回落平台默认（和 /config/models 的三态一致）。
 *
 * 刻意**不放**在这里的东西：加密密钥、SSRF 开关、上下文总预算、SSE 心跳——
 * 那是安全边界和平台成本边界，留在服务端 .env（docs/12-c §C4）。
 */

const { Text, Paragraph } = Typography;

export function SettingsPage(): ReactElement {
  const [settings, setSettings] = useState<SettingItem[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  // 本租户的基本信息（只读，docs/04-c §5.9.1）
  const [tenantInfo, setTenantInfo] = useState<{ code: string; name: string; plan: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();
  /**
   * 「恢复默认」标记掉的 key —— 保存时这些项提交 `null`（清除覆盖、回落平台默认）。
   *
   * ⚠️ **boolean 为什么需要它**（docs/04-c §5.9）：
   *    规格写的是「清空输入框再保存 = 清除覆盖」—— 数字 / 字符串有「空」态，
   *    boolean 是个 `<Switch>`，**没有第三态**。把开关拨回平台默认值只会提交一个
   *    **显式**的同值覆盖 → `overridden` 还是 true，「已覆盖」标签消不掉，
   *    永远清不掉覆盖。
   *    ⚠️ 不给 Switch 造第三态（UI 会误导：看着像「没设置」，其实是「设置为 false」）。
   *    改成一个显式的小按钮 —— 只在**该项确实被覆盖过**时才出现。
   */
  const [clearedKeys, setClearedKeys] = useState<Set<string>>(new Set());

  const reload = useCallback(async (): Promise<void> => {
    try {
      const data = await fetchSettings();
      setSettings(data.settings);
      setNotes(data.notes);
      setTenantInfo(data.tenant ?? null);
      const initial: Record<string, unknown> = {};
      for (const s of data.settings) {
        initial[s.key] = s.value;
      }
      form.setFieldsValue(initial);
      setClearedKeys(new Set());
    } catch (err: unknown) {
      message.error(configErrorMessage(err, '加载配置失败'));
    } finally {
      setLoading(false);
    }
  }, [form]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // 按 category 分区
  const grouped = useMemo(() => {
    const map = new Map<string, SettingItem[]>();
    for (const s of settings) {
      const list = map.get(s.category) ?? [];
      list.push(s);
      map.set(s.category, list);
    }
    return [...map.entries()];
  }, [settings]);

  const onSave = useCallback(async (): Promise<void> => {
    setSaving(true);
    try {
      const values = (await form.validateFields()) as Record<string, unknown>;
      // 只提交「跟原值不同」的项，减少无谓写库；清空的值提交 null 表示清除覆盖
      const payload: Record<string, unknown> = {};
      for (const s of settings) {
        const next = values[s.key];
        // ⚠️ 「恢复默认」标记过的项：**无条件**提交 null（哪怕开关已经拨回平台默认值）
        if (clearedKeys.has(s.key)) {
          payload[s.key] = null;
          continue;
        }
        if (next === s.value) {
          continue;
        }
        payload[s.key] = next === undefined || next === '' ? null : next;
      }
      if (Object.keys(payload).length === 0) {
        message.info('没有改动');
        setSaving(false);
        return;
      }
      const updated = await saveSettings(payload);
      setSettings(updated);
      const initial: Record<string, unknown> = {};
      for (const s of updated) {
        initial[s.key] = s.value;
      }
      form.setFieldsValue(initial);
      setClearedKeys(new Set());
      message.success('已保存，下一轮对话立即生效');
    } catch (err: unknown) {
      message.error(configErrorMessage(err, '保存失败'));
    } finally {
      setSaving(false);
    }
  }, [form, settings, clearedKeys]);

  /** 「恢复默认」：标记清除覆盖，并把开关拨回平台默认值（保存后生效） */
  const onRestoreDefault = useCallback(
    (s: SettingItem): void => {
      setClearedKeys((prev) => {
        const next = new Set(prev);
        next.add(s.key);
        return next;
      });
      form.setFieldValue(s.key, s.fallback);
      message.info(`「${s.label}」保存后将回落平台默认（${String(s.fallback)}）`);
    },
    [form],
  );

  /** 手动拨了开关 → 取消「恢复默认」标记（显式的新值优先） */
  const onToggleBoolean = useCallback((key: string): void => {
    setClearedKeys((prev) => {
      if (!prev.has(key)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, []);

  const onReset = useCallback((): void => {
    void reload();
  }, [reload]);

  return (
    <div>
      <PageHeader
        title="租户设置"
        subtitle="本租户的对话参数。每项都是「平台默认 + 可覆盖」，清空即回落平台默认。"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={onReset}>
              重置
            </Button>
            <Button type="primary" icon={<SaveOutlined />} loading={saving} onClick={() => void onSave()}>
              保存
            </Button>
          </Space>
        }
      />

      {notes.length > 0 && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title="说明"
          description={
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          }
        />
      )}

      {/* 基础配置（docs/04-c §5.9.1）—— 只读。
          租户名 / 租户号不在 KV 里：改它们要走平台方那边（/system/tenants），
          所以这里只展示，提示去哪改。
          ⚠️ 用 `!= null` 而不是 `!== null`：老后端不返回 tenant 时拿到的是
          undefined，只判 `!== null` 会漏过去，渲染时炸 `tenantInfo.name`。 */}
      {tenantInfo != null && (
        <Card size="small" title="基础配置" style={{ marginBottom: 16 }}>
          <Descriptions column={3} size="small">
            <Descriptions.Item label="租户名">{tenantInfo.name}</Descriptions.Item>
            <Descriptions.Item label="租户号">
              <Text code>{tenantInfo.code}</Text>
            </Descriptions.Item>
            <Descriptions.Item label="套餐">
              <Tag color={tenantInfo.plan === 'free' ? 'default' : 'blue'}>
                {tenantInfo.plan}
              </Tag>
            </Descriptions.Item>
          </Descriptions>
          <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>
            租户名和租户号由 SaaS 平台方维护（平台后台 → 租户管理里改），这里只读。
          </Paragraph>
        </Card>
      )}

      <Form form={form} layout="vertical" disabled={loading}>
        {grouped.length === 0 && !loading ? (
          <Card size="small">
            <Empty description="暂无可配置项" />
          </Card>
        ) : (
          grouped.map(([category, items]) => (
            <Card
              key={category}
              size="small"
              title={category}
              style={{ marginBottom: 16 }}
              extra={
                items.some((s) => s.overridden) && (
                  <Tag color="blue">{items.filter((s) => s.overridden).length} 项已覆盖</Tag>
                )
              }
            >
              <Row gutter={16}>
                {items.map((s) => (
                  <Col xs={24} md={12} lg={8} key={s.key}>
                    <Form.Item
                      name={s.key}
                      label={
                        <Space>
                          <span>{s.label}</span>
                          {s.overridden && <Tag color="blue">已覆盖</Tag>}
                        </Space>
                      }
                      extra={
                        <Space size={8} wrap align="center">
                          <SettingHint item={s} />
                          {/* ⚠️ 只给 boolean 加「恢复默认」——
                              数字 / 字符串本来就能清空输入框（提交 null），
                              Switch 没有「空」态，只能用这个按钮清除覆盖 */}
                          {s.type === 'boolean' && s.overridden && (
                            <Tooltip title="清除本租户的覆盖，这一项回落平台默认">
                              <Button
                                type="link"
                                size="small"
                                onClick={() => onRestoreDefault(s)}
                              >
                                恢复默认
                              </Button>
                            </Tooltip>
                          )}
                        </Space>
                      }
                      valuePropName={s.type === 'boolean' ? 'checked' : 'value'}
                    >
                      {s.type === 'boolean' ? (
                        <Switch onChange={() => onToggleBoolean(s.key)} />
                      ) : s.type === 'number' ? (
                        <InputNumber
                          {...(s.min === undefined ? {} : { min: s.min })}
                          {...(s.max === undefined ? {} : { max: s.max })}
                          style={{ width: '100%' }}
                          placeholder={`平台默认 ${String(s.fallback)}`}
                        />
                      ) : s.multiline === true ? (
                        // 「一行一条」的列表（首页推荐问题）—— 渲染成多行输入框
                        <Input.TextArea
                          allowClear
                          autoSize={{ minRows: 3, maxRows: 10 }}
                          {...(s.maxLength === undefined ? {} : { maxLength: s.maxLength })}
                          placeholder={s.fallback === '' ? '留空则不显示这一项' : String(s.fallback)}
                        />
                      ) : (
                        <Input
                          allowClear
                          {...(s.maxLength === undefined ? {} : { maxLength: s.maxLength })}
                          placeholder={`平台默认 ${String(s.fallback)}`}
                        />
                      )}
                    </Form.Item>
                  </Col>
                ))}
              </Row>
            </Card>
          ))
        )}
      </Form>

      <Paragraph type="secondary" style={{ fontSize: 12 }}>
        清空输入框再保存 = 清除这项覆盖，回到平台默认；开关类（boolean）没有「空」态，
        用该项旁边的「恢复默认」按钮清除覆盖。保存后立即生效，不用重启。
      </Paragraph>
    </div>
  );
}

function SettingHint({ item }: { item: SettingItem }): ReactElement {
  if (item.overridden) {
    return (
      <Text type="secondary" style={{ fontSize: 12 }}>
        平台默认 {String(item.fallback)} ·{' '}
        {item.updated_at === null ? '' : `最后修改 ${new Date(item.updated_at).toLocaleString('zh-CN')}`}
      </Text>
    );
  }
  return (
    <Tooltip title={item.description}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        平台默认 {String(item.fallback)}
      </Text>
    </Tooltip>
  );
}
