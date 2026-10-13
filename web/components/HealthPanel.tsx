import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import axios from 'axios';
import { Alert, Spin } from 'antd';

interface HealthResponse {
  ok: boolean;
  db: string;
  uptime: number;
}

export function HealthPanel(): ReactElement {
  const [data, setData] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    axios
      .get<HealthResponse>('/api/health')
      .then((r) => setData(r.data))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'unknown'));
  }, []);

  if (error !== null) {
    return <Alert type="error" message={`无法连接后端：${error}`} />;
  }
  if (data === null) {
    return <Spin tip="检查中..." />;
  }
  return (
    <Alert
      type={data.ok ? 'success' : 'warning'}
      showIcon
      message={`后端正常 · db=${data.db} · uptime=${data.uptime}s`}
    />
  );
}
