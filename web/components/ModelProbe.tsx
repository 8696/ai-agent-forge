import { useState } from 'react';
import type { ReactElement } from 'react';
import axios from 'axios';
import { Alert, Button, Card, Select, Space, Typography } from 'antd';

const { Text } = Typography;

type Provider = 'minimax' | 'zhipu' | 'deepseek' | 'qwen' | 'custom';

type ProbeResult =
  | {
      ok: true;
      provider: Provider;
      model: string;
      baseUrl: string;
      text: string;
      usage: unknown;
      durationMs: number;
    }
  | { ok: false; provider: Provider; error: string };

const PROVIDER_OPTIONS: Array<{ value: Provider; label: string }> = [
  { value: 'minimax', label: 'minimax' },
  { value: 'zhipu', label: 'zhipu' },
  { value: 'deepseek', label: 'deepseek' },
  { value: 'qwen', label: 'qwen' },
  { value: 'custom', label: 'custom' },
];

export function ModelProbe(): ReactElement {
  const [provider, setProvider] = useState<Provider>('minimax');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);

  const onProbe = async (): Promise<void> => {
    setLoading(true);
    setResult(null);
    try {
      const res = await axios.post<ProbeResult>('/api/_dev/probe/llm', { provider });
      setResult(res.data);
    } catch (e: unknown) {
      const axiosErr = e as { response?: { data?: ProbeResult }; message?: string };
      if (axiosErr.response?.data !== undefined) {
        setResult(axiosErr.response.data);
      } else {
        setResult({ ok: false, provider, error: axiosErr.message ?? 'unknown' });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card title="LLM 探活（dev 工具）" size="small" style={{ marginTop: 16, maxWidth: 720 }}>
      <Space>
        <Text>提供商：</Text>
        <Select
          value={provider}
          onChange={(v) => setProvider(v)}
          options={PROVIDER_OPTIONS}
          style={{ width: 160 }}
        />
        <Button type="primary" loading={loading} onClick={onProbe}>
          测一下
        </Button>
      </Space>

      {result !== null && (
        <div style={{ marginTop: 12 }}>
          {result.ok ? (
            <Alert
              type="success"
              showIcon
              message={`✓ ${result.provider} · ${result.model} · ${result.durationMs}ms`}
              description={
                <div style={{ fontSize: 12 }}>
                  <div>
                    base: <Text code>{result.baseUrl}</Text>
                  </div>
                  <div>
                    text: <Text code>{JSON.stringify(result.text)}</Text>
                  </div>
                  <div>
                    usage: <Text code>{JSON.stringify(result.usage)}</Text>
                  </div>
                </div>
              }
            />
          ) : (
            <Alert
              type="error"
              showIcon
              message={`✗ ${result.provider} 探活失败`}
              description={
                <Text code style={{ fontSize: 12 }}>
                  {result.error}
                </Text>
              }
            />
          )}
        </div>
      )}
    </Card>
  );
}
