import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { Card, Typography } from 'antd';

const { Title, Paragraph } = Typography;

/**
 * 首页占位 —— 业务内容在 Step 13 后落（docs/04-UI需求.md §3.2）
 */
export function HomePage(): ReactElement {
  return (
    <Card style={{ maxWidth: 720 }}>
      <Title level={3}>AgentForge</Title>
      <Paragraph>多租户的 AI 文档问答平台。</Paragraph>
      <Paragraph type="secondary">
        首页业务内容（聊天挂件 / 后台入口）将在 <code>docs/04-UI需求.md §3</code> 落地。
      </Paragraph>
      <Paragraph>
        临时入口：<Link to="/dev/probe">调试工具</Link>（看后端健康 + 测试 LLM 提供商）
      </Paragraph>
    </Card>
  );
}
