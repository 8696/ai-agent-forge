import type { ReactElement } from 'react';
import { Space, Typography } from 'antd';
import { useActiveConfig } from '../lib/activeConfig';

const { Text } = Typography;

/**
 * 页脚右侧「当前激活模型」展示组件（system / admin / customer 三个 layout 共用）
 * 详见 docs/06-API接口.md §6.4 + docs/04-d-ui-系统级与公共组件.md §7.x
 *
 * 展示规则：
 *  - LLM：`provider · model`，未拿到 → 「LLM · —」
 *  - Embedding：`model · NNNd`，provider 不提供 Embedding（deepseek）→ 「Embedding · —」
 *  - 整体用 `secondary` 灰色，不抢主内容视觉
 */
export function ActiveModelsFooter(): ReactElement {
  const cfg = useActiveConfig();
  const llmText =
    cfg.provider && cfg.llmModel ? `${cfg.provider} · ${cfg.llmModel}` : '—';
  const embedText =
    cfg.embedModel && cfg.embedDimensions > 0
      ? `${cfg.embedModel} · ${cfg.embedDimensions}d`
      : '—';

  return (
    <Space size={16} wrap>
      <Text type="secondary" style={{ fontSize: 12 }}>
        LLM · <Text code style={{ fontSize: 12 }}>{llmText}</Text>
      </Text>
      <Text type="secondary" style={{ fontSize: 12 }}>
        Embedding · <Text code style={{ fontSize: 12 }}>{embedText}</Text>
      </Text>
    </Space>
  );
}
