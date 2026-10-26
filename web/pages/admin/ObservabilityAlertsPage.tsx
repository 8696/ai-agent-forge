import type { ReactElement } from 'react';
import { useCallback, useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Empty,
  Flex,
  InputNumber,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { PageHeader } from '../../components/shell/PageHeader';
import { fetchAlertRules, type AlertRuleItem } from '../../lib/adminObservability';
import { fetchAlerts, saveSettings, type AdminAlert } from '../../lib/adminConfig';

const { Text, Paragraph } = Typography;

/**
 * /admin/observability/alerts —— 告警规则（04-c §5.7.4）
 *
 * 三条**固定**规则：p95 延迟 / 错误率 / 单条对话成本。
 * 租户能改的是**阈值**和**启停**（阈值设 0 = 关掉这一条）。
 *
 * ## 与原规格的差异
 *
 * 原规格写的是「规则名 / 条件 / 触发次数 / 启停 +『新建规则』弹窗」。
 * **「新建规则」没做** —— 那要一张规则表 + 一套条件表达式（DSL），
 * 跟现在的「三条固定阈值」不是一个量级。
 * 现在这页给的是**阈值可配 + 启停 + 当前状态 + 当前触发的告警列表**。
 *
 * ## 阈值存哪儿
 *
 * 存在租户设置里（`alert_p95_latency_ms` / `alert_error_rate` /
 * `alert_single_cost_usd`），跟通用配置页是**同一份** ——
 * 这页改完，通用配置页里看到的也是新值。
 */

/** 规则 key → 配置项 key */
const SETTING_KEY: Record<AlertRuleItem['key'], string> = {
  p95_latency: 'alert_p95_latency_ms',
  error_rate: 'alert_error_rate',
  single_cost: 'alert_single_cost_usd',
};

/** 阈值单位（输入框的步长 / 后缀） */
const UNIT_META: Record<
  AlertRuleItem['unit'],
  { suffix: string; step: number; decimals: number; max: number }
> = {
  ms: { suffix: 'ms', step: 500, decimals: 0, max: 120000 },
  percent: { suffix: '%', step: 1, decimals: 1, max: 100 },
  usd: { suffix: '$', step: 0.05, decimals: 4, max: 1000 },
};

/** percent 存的是小数（0.05），显示和输入用百分数 */
function toDisplay(rule: AlertRuleItem): number {
  return rule.unit === 'percent' ? rule.threshold * 100 : rule.threshold;
}

function fromDisplay(rule: AlertRuleItem, display: number): number {
  return rule.unit === 'percent' ? display / 100 : display;
}

export function ObservabilityAlertsPage(): ReactElement {
  const [rules, setRules] = useState<AlertRuleItem[]>([]);
  const [alerts, setAlerts] = useState<AdminAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setErrMsg(null);
    try {
      const [r, a] = await Promise.all([fetchAlertRules(), fetchAlerts()]);
      setRules(r);
      setAlerts(a);
    } catch (err: unknown) {
      setErrMsg(err instanceof Error ? err.message : '加载告警规则失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 改阈值并保存 */
  const saveThreshold = useCallback(
    async (rule: AlertRuleItem, displayValue: number | null): Promise<void> => {
      const key = SETTING_KEY[rule.key];
      setSavingKey(rule.key);
      try {
        // null = 清除覆盖（回落到平台默认）；0 = 关掉这一条
        const payload: Record<string, unknown> = {
          [key]: displayValue === null ? null : fromDisplay(rule, displayValue),
        };
        await saveSettings(payload);
        message.success(
          displayValue === null ? '已回落到平台默认阈值' : '已保存，下一轮立即生效',
        );
        await load();
      } catch (err: unknown) {
        message.error(err instanceof Error ? err.message : '保存失败');
      } finally {
        setSavingKey(null);
      }
    },
    [load],
  );

  /** 启停：开 = 恢复默认阈值（当前是 0 的话），关 = 阈值设 0 */
  const toggleRule = useCallback(
    async (rule: AlertRuleItem, enabled: boolean): Promise<void> => {
      if (enabled) {
        const display =
          rule.threshold > 0
            ? toDisplay(rule)
            : rule.unit === 'percent'
              ? rule.default_threshold * 100
              : rule.default_threshold;
        await saveThreshold(rule, display);
      } else {
        await saveThreshold(rule, 0);
      }
    },
    [saveThreshold],
  );

  return (
    <div>
      <PageHeader
        title="告警规则"
        subtitle="配置什么时候该告警。阈值改动立刻生效，不用重启。"
        extra={
          <Space>
            <Button icon={<ReloadOutlined />} onClick={() => void load()}>
              刷新
            </Button>
            <Button type="primary" href="/admin/settings">
              去通用配置页
            </Button>
          </Space>
        }
      />

      {errMsg !== null && (
        <Alert type="error" showIcon message={errMsg} style={{ marginBottom: 16 }} />
      )}

      <Spin spinning={loading}>
        <Space orientation="vertical" size={16} style={{ width: '100%' }}>
          <Card title="阈值规则" size="small">
            <Space orientation="vertical" size={12} style={{ width: '100%' }}>
              {rules.length === 0 ? (
                <Empty description="没有可配置的规则" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : (
                rules.map((rule) => {
                  const meta = UNIT_META[rule.unit];
                  const enabled = rule.threshold > 0;
                  return (
                    <Flex key={rule.key} align="center" gap={16} wrap>
                      <div style={{ flex: 1, minWidth: 260 }}>
                        <Space size={8}>
                          <Text strong>{rule.name}</Text>
                          {rule.firing ? (
                            <Tag color="red">触发中</Tag>
                          ) : enabled ? (
                            <Tag color="green">正常</Tag>
                          ) : (
                            <Tag>已关闭</Tag>
                          )}
                        </Space>
                        <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
                          {rule.condition}
                          {rule.current_value !== null && (
                            <>
                              {' · '}今天实际值：
                              {rule.unit === 'percent'
                                ? `${(rule.current_value * 100).toFixed(1)}%`
                                : rule.unit === 'ms'
                                  ? `${rule.current_value} ms`
                                  : `$${rule.current_value.toFixed(4)}`}
                            </>
                          )}
                        </Paragraph>
                      </div>
                      <Space>
                        <Tooltip title={enabled ? '关掉这一条（阈值设 0）' : '打开这一条'}>
                          <Switch
                            checked={enabled}
                            loading={savingKey === rule.key}
                            onChange={(v) => void toggleRule(rule, v)}
                          />
                        </Tooltip>
                        <InputNumber
                          value={toDisplay(rule)}
                          min={0}
                          max={meta.max}
                          step={meta.step}
                          precision={meta.decimals}
                          addonAfter={meta.suffix}
                          disabled={!enabled}
                          style={{ width: 150 }}
                          onChange={(v) => {
                            if (v === null) {
                              void saveThreshold(rule, null);
                              return;
                            }
                            void saveThreshold(rule, v);
                          }}
                        />
                      </Space>
                    </Flex>
                  );
                })
              )}
            </Space>
          </Card>

          <Card title="当前触发的告警" size="small">
            {alerts.length === 0 ? (
              <Empty description="当前没有告警" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : (
              <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                {alerts.map((a) => (
                  <Alert
                    key={a.id}
                    type={a.level === 'error' ? 'error' : 'warning'}
                    showIcon
                    message={a.title}
                    description={
                      <>
                        <Paragraph style={{ marginBottom: 4 }}>{a.detail}</Paragraph>
                        {a.created_at !== null && (
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            {new Date(a.created_at).toLocaleString('zh-CN')}
                          </Text>
                        )}
                      </>
                    }
                  />
                ))}
              </Space>
            )}
          </Card>
        </Space>
      </Spin>
    </div>
  );
}
