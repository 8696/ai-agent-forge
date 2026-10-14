import type { ReactElement } from 'react';
import { Link } from 'react-router-dom';
import { Result, Button } from 'antd';

export function NotFoundPage(): ReactElement {
  return (
    <Result
      status="404"
      title="404"
      subTitle="页面不存在"
      extra={
        <Link to="/">
          <Button type="primary">回首页</Button>
        </Link>
      }
    />
  );
}
