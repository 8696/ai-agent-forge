import type { ReactElement } from 'react';
import { Space, Tag, Typography } from 'antd';
import { ApiOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { useActiveConfig } from '../lib/activeConfig';

const { Text } = Typography;

/**
 * 页脚右侧「当前激活模型」展示组件（system / admin / customer 三个 layout 共用）
 * 详见 docs/04-a §0.2 + docs/06-API接口.md §6.4 + docs/04-d §7.x
 *
 * 展示规则：
 *  - LLM：`provider · model`，未拿到 → 「—」
 *  - Embedding：`model · NNNd`，provider 不提供 Embedding → 「—」
 *  - 用 AntD `<Tag>` 区分角色，配色 LLM primary / Embedding purple
 */
export function ActiveModelsFooter(): ReactElement {
  const cfg = useActiveConfig();
  const llmText = cfg.provider && cfg.llmModel ? `${cfg.provider} · ${cfg.llmModel}` : '—';
  const embedText =
    cfg.embedModel && cfg.embedDimensions > 0
      ? `${cfg.embedModel} · ${cfg.embedDimensions}d`
      : '—';

  return (
    <Space size={8} wrap align="center">
      <Text type="secondary" style={{ fontSize: 12 }}>
        当前激活
      </Text>
      <Tag
        color="blue"
        icon={<ThunderboltOutlined />}
        style={{ marginInlineEnd: 0, fontWeight: 500 }}
      >
        LLM · {llmText}
      </Tag>
      <Tag
        color="purple"
        icon={<ApiOutlined />}
        style={{ marginInlineEnd: 0, fontWeight: 500 }}
      >
        Embedding · {embedText}
      </Tag>
    </Space>
  );
}
