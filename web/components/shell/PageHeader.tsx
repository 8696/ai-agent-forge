import type { ReactElement, ReactNode } from 'react';
import { Breadcrumb, Space, Typography } from 'antd';
import type { BreadcrumbProps } from 'antd';

const { Title, Text } = Typography;

interface PageHeaderProps {
  /** 主标题 */
  title: ReactNode;
  /** 副文案 / 描述 */
  subtitle?: ReactNode;
  /** 面包屑（不传就不渲染这一行） */
  breadcrumb?: BreadcrumbProps['items'];
  /** 右上角操作区（按钮组） */
  extra?: ReactNode;
}

/**
 * 统一页面头部 —— 取代各页散乱的 <Title> + <Paragraph> + 操作按钮
 *
 * 用法：
 *   <PageHeader
 *     title="用户管理"
 *     subtitle="列本租户所有用户…"
 *     breadcrumb={[{ title: '首页' }, { title: '用户' }, { title: '用户管理' }]}
 *     extra={[<Button key="r" onClick={load}>刷新</Button>, <Button key="c" type="primary">+ 新建</Button>]}
 *   />
 */
export function PageHeader(props: PageHeaderProps): ReactElement {
  const hasExtra = props.extra !== undefined && props.extra !== null;

  return (
    <div style={{ marginBottom: 24 }}>
      {props.breadcrumb !== undefined && (
        <div style={{ marginBottom: 12 }}>
          <Breadcrumb items={props.breadcrumb} />
        </div>
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <Title
            level={3}
            style={{ marginBottom: props.subtitle === undefined ? 0 : 6, fontSize: 22 }}
          >
            {props.title}
          </Title>
          {props.subtitle !== undefined && (
            <Text type="secondary" style={{ fontSize: 14 }}>
              {props.subtitle}
            </Text>
          )}
        </div>
        {hasExtra && (
          <Space wrap style={{ flexShrink: 0 }}>
            {props.extra}
          </Space>
        )}
      </div>
    </div>
  );
}
