import type { ReactElement } from 'react';
import { Card, Col, Row, Typography } from 'antd';
import { BookOutlined, ExperimentOutlined, RightOutlined, TeamOutlined } from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { getCurrentUser } from '../../lib/auth';
import { PageHeader } from '../../components/shell/PageHeader';

const { Text } = Typography;

const ENTRIES: Array<{ title: string; desc: string; to: string; icon: ReactElement; color: string }> = [
  {
    title: '文档管理',
    desc: '上传 PDF、Markdown、TXT，写入本租户知识库。',
    to: '/admin/knowledge/documents',
    icon: <BookOutlined />,
    color: '#2f54eb',
  },
  {
    title: '检索测试',
    desc: '输入问句，查看最相近的文档片段。',
    to: '/admin/knowledge/test',
    icon: <ExperimentOutlined />,
    color: '#722ed1',
  },
  {
    title: '用户管理',
    desc: '管理本租户的后台管理员和前台用户。',
    to: '/admin/users',
    icon: <TeamOutlined />,
    color: '#13c2c2',
  },
];

export function AdminHomePage(): ReactElement {
  const user = getCurrentUser();

  return (
    <div>
      <PageHeader
        title="租户后台"
        subtitle={<>欢迎，<Text strong>{user?.email ?? user?.sub}</Text></>}
      />
      <Row gutter={[16, 16]}>
        {ENTRIES.map((e) => (
          <Col key={e.to} xs={24} sm={12} lg={8}>
            <Link to={e.to} style={{ display: 'block' }}>
              <Card hoverable styles={{ body: { padding: '18px 20px' } }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                  <span style={{ color: e.color, fontSize: 18 }}>{e.icon}</span>
                  <Text strong style={{ fontSize: 15, flex: 1 }}>
                    {e.title}
                  </Text>
                  <RightOutlined style={{ color: 'rgba(0,0,0,0.45)' }} />
                </div>
                <Text type="secondary">{e.desc}</Text>
              </Card>
            </Link>
          </Col>
        ))}
      </Row>
    </div>
  );
}
