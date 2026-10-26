/**
 * tests/integration/alert-rules.test.ts
 * 对应 src/gateway/admin/observability-routes.ts 的 GET /observability/alerts/rules
 *          + src/services/alerts.ts 的阈值读取
 * 详见 docs/04-c-ui-后台管理页面.md §5.7.4、docs/12-e 需求裁定表 #9
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { allHttpFromTokensFile, type AllHttp } from '../helpers';

interface AlertRule {
  key: 'p95_latency' | 'error_rate' | 'single_cost';
  name: string;
  condition: string;
  unit: 'ms' | 'percent' | 'usd';
  threshold: number;
  default_threshold: number;
  current_value: number | null;
  firing: boolean;
}

describe('告警规则（04-c §5.7.4）', () => {
  let http: AllHttp;

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
  });

  /**
   * ⚠️ **每个用例后把阈值覆盖清掉** —— 这些用例会改租户设置，
   *    万一某个用例中途失败、没走到「复原」那步，库里就留下脏值，
   *    **下一个用例（乃至下一次跑测试）全被污染**。
   *    2026-10-26 真踩过：一次失败把 p95 阈值留在 0，
   *    后面「阈值没配过时 = 平台默认值」直接就红了。
   */
  afterEach(async () => {
    await http.acmeAdmin.put('/config/settings', {
      alert_p95_latency_ms: null,
      alert_error_rate: null,
      alert_single_cost_usd: null,
    });
  });

  const rules = async (): Promise<AlertRule[]> => {
    const r = await http.acmeAdmin.get<{ rules: AlertRule[] }>('/observability/alerts/rules');
    expect(r.status).toBe(200);
    return r.data.rules;
  };

  it('200 + 三条固定规则', async () => {
    const list = await rules();
    expect(list).toHaveLength(3);
    expect(list.map((r) => r.key).sort()).toEqual(['error_rate', 'p95_latency', 'single_cost']);
    for (const r of list) {
      expect(r.name.length).toBeGreaterThan(0);
      expect(r.condition.length).toBeGreaterThan(0);
      expect(r.default_threshold).toBeGreaterThan(0);
    }
  });

  it('阈值没配过时 = 平台默认值', async () => {
    const list = await rules();
    for (const r of list) {
      expect(r.threshold).toBe(r.default_threshold);
    }
  });

  it('⚠️ 阈值设 0 = 关掉这一条（不是「用回默认值」）', async () => {
    // 2026-10-26 修的 bug：以前 `v > 0 ? v : 默认值`，
    // 跟配置项说明写的「设 0 = 不看这一项」对不上 —— 设 0 反而用回默认值。
    const before = await rules();
    const target = before.find((r) => r.key === 'p95_latency');
    expect(target).toBeDefined();

    await http.acmeAdmin.put('/config/settings', { alert_p95_latency_ms: 0 });

    const after = await rules();
    const row = after.find((r) => r.key === 'p95_latency');
    expect(row?.threshold).toBe(0);
    // 关掉之后不可能「触发中」
    expect(row?.firing).toBe(false);

    // 复原
    await http.acmeAdmin.put('/config/settings', {
      alert_p95_latency_ms: target!.default_threshold,
    });
    const restored = await rules();
    expect(restored.find((r) => r.key === 'p95_latency')?.threshold).toBe(
      target!.default_threshold,
    );
  });

  it('改阈值 → 立刻生效（下一个请求就看到新值）', async () => {
    await http.acmeAdmin.put('/config/settings', { alert_error_rate: 0.42 });
    const list = await rules();
    expect(list.find((r) => r.key === 'error_rate')?.threshold).toBeCloseTo(0.42, 5);

    await http.acmeAdmin.put('/config/settings', { alert_error_rate: null });
    const restored = await rules();
    expect(restored.find((r) => r.key === 'error_rate')?.threshold).toBe(
      restored.find((r) => r.key === 'error_rate')?.default_threshold,
    );
  });

  it('无 token → 401', async () => {
    const r = await http.acmeAdmin.get('/observability/alerts/rules', {
      headers: { authorization: 'Bearer invalid' },
      validateStatus: () => true,
    });
    expect(r.status).toBe(401);
  });
});
