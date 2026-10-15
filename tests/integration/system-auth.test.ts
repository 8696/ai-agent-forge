/**
 * tests/integration/system-auth.test.ts
 * 对应 src/gateway/system/auth-routes.ts（1 个端点：POST /login）
 * 详见 docs/18-测试流程规范.md §18.3
 *
 * （/me + /change-password 端点已删除，测试同步移除）
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { allHttpFromTokensFile, loginSystem, type AllHttp } from '../helpers';

const BASE = `http://localhost:${process.env.PORT ?? '3099'}`;

describe('system-auth-routes', () => {
  let http: AllHttp;

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
  });

  describe('POST /api/v1/system/login', () => {
    it('200 + JWT token', async () => {
      const fresh = await loginSystem();
      const r = await axios.post(
        `${BASE}/api/v1/system/login`,
        { email: 'platform-admin@local.test', password: 'PlatformAdmin-123!' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(200);
      expect((r.data as { token: string }).token).toMatch(/^eyJ/);
      expect(fresh).toMatch(/^eyJ/);
    });

    it('401 密码错', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/system/login`,
        { email: 'platform-admin@local.test', password: 'wrong-password' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(401);
    });

    it('401 邮箱不存在（防枚举）', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/system/login`,
        { email: 'nobody@local.test', password: 'whatever' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(401);
    });
  });
});
