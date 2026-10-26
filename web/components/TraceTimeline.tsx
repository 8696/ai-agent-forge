import type { ReactElement } from 'react';
import { useState } from 'react';
import { Card, Empty, Space, Tag, Typography, theme } from 'antd';
import type { TraceSpan } from '../lib/adminObservability';

const { Text } = Typography;

/** span 的 kind → 中文名 + 颜色 */
const SPAN_KIND_META: Record<string, { label: string; color: string }> = {
  http: { label: 'HTTP 路由', color: 'blue' },
  retrieval: { label: '知识库检索', color: 'cyan' },
  llm: { label: '模型调用', color: 'purple' },
  guard: { label: '安全审核', color: 'volcano' },
  cost: { label: '成本记账', color: 'gold' },
  storage: { label: '存储', color: 'green' },
  step: { label: '步骤', color: 'default' },
  agent: { label: '子代理', color: 'geekblue' },
};

export function spanMeta(kind: string): { label: string; color: string } {
  return SPAN_KIND_META[kind] ?? { label: kind, color: 'default' };
}

/**
 * Trace 的 span 时间线 —— docs/04-d-ui-系统级与公共组件.md §7
 *
 * 每个 span 一行（检索 / 模型调用 / 记账…），点开看入参出参摘要。
 *
 * 「哪一步慢」是这一页存在的唯一理由 —— 总耗时只能告诉你「有问题」，
 * 时间线才能告诉你「问题在哪」。
 *
 * ## 调用树（B6 多代理）
 *
 * ⚠️ **2026-10-26**：span 现在支持父子关系（`parent_span_id`）——
 *    多代理的子代理调用挂在主 agent 的 `llm.generate` span 下面，
 *    这里按父子关系**缩进渲染**，一眼能看出「哪个代理被派了什么活」。
 *
 *    没有 `parent_span_id` 的 span（老数据 / 顶层 span）当根节点。
 *    父节点不在列表里的（理论上不会）也当根节点 —— 不让数据异常把 span 弄丢。
 */
export function TraceTimeline({ spans }: { spans: TraceSpan[] }): ReactElement {
  /** 展开中的 span id（null = 都没展开） */
  const [openSpan, setOpenSpan] = useState<string | null>(null);

  if (spans.length === 0) {
    return <Empty description="这次调用没有记录 span" />;
  }

  const byId = new Map(spans.map((s) => [s.id, s]));
  const childrenOf = new Map<string | null, TraceSpan[]>();
  for (const span of spans) {
    const parent =
      span.parent_span_id !== null && byId.has(span.parent_span_id)
        ? span.parent_span_id
        : null;
    const list = childrenOf.get(parent);
    if (list === undefined) {
      childrenOf.set(parent, [span]);
    } else {
      list.push(span);
    }
  }

  const renderBranch = (span: TraceSpan, depth: number): ReactElement => {
    const meta = spanMeta(span.kind);
    const expanded = openSpan === span.id;
    const children = childrenOf.get(span.id) ?? [];
    return (
      <div key={span.id} style={{ marginLeft: depth === 0 ? 0 : 20 }}>
        {depth > 0 && (
          <Text type="secondary" style={{ fontSize: 11, marginLeft: 2 }}>
            └
          </Text>
        )}
        <Card
          size="small"
          style={{ marginBottom: 8 }}
          styles={{ body: { padding: 12 } }}
          onClick={() => setOpenSpan(expanded ? null : span.id)}
        >
          <Space orientation="vertical" size={6} style={{ width: '100%' }}>
            <Space wrap size={8}>
              <Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace' }}>
                {new Date(span.started_at).toLocaleTimeString()}
              </Text>
              <Tag color={meta.color}>{meta.label}</Tag>
              <Text strong>{span.name}</Text>
              <Text type="secondary">{span.duration_ms ?? 0} ms</Text>
              {span.status === 'error' && <Tag color="red">失败</Tag>}
              {children.length > 0 && (
                <Tag color="geekblue">{children.length} 个子调用</Tag>
              )}
            </Space>
            {span.error_message !== null && (
              <Text type="danger" style={{ fontSize: 12 }}>
                {span.error_message}
              </Text>
            )}
            {expanded && (
              <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                <JsonBlock title="入参" value={span.input} />
                <JsonBlock title="出参" value={span.output} />
              </Space>
            )}
          </Space>
        </Card>
        {children.map((child) => renderBranch(child, depth + 1))}
      </div>
    );
  };

  const roots = childrenOf.get(null) ?? [];
  return <>{roots.map((span) => renderBranch(span, 0))}</>;
}

/** 入参 / 出参的 JSON 展示块 */
export function JsonBlock({
  title,
  value,
}: {
  title: string;
  value: Record<string, unknown> | null;
}): ReactElement {
  // 颜色走 antd token —— 写死浅色的话，深色模式下几乎看不见
  const { token } = theme.useToken();
  if (value === null || Object.keys(value).length === 0) {
    return (
      <div>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {title}：（无）
        </Text>
      </div>
    );
  }
  return (
    <div style={{ width: '100%' }}>
      <Text type="secondary" style={{ fontSize: 12 }}>
        {title}
      </Text>
      <pre
        style={{
          margin: '4px 0 0',
          padding: 8,
          borderRadius: 6,
          background: token.colorFillQuaternary,
          fontSize: 12,
          maxHeight: 260,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
