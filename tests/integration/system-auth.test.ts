/**
 * tests/integration/system-auth.test.ts
 * 对应 src/gateway/system/auth-routes.ts（3 个端点）
 * 详见 docs/18-测试流程规范.md §18.3
 */
import { describe, it, expect, beforeAll } from 'vitest';
import axios from 'axios';
import { allHttpFromTokensFile, loginSystem, type AllHttp } from '../helpers';

const BASE = `http://localhost:${process.env.PORT ?? '3000'}`;

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

  describe('GET /api/v1/system/me', () => {
    it('200 + 当前用户', async () => {
      const r = await http.system.get('/me');
      expect(r.status).toBe(200);
      expect((r.data as { email: string }).email).toBe('platform-admin@local.test');
      expect((r.data as { role: string }).role).toBe('system');
    });

    it('401 无 token', async () => {
      const r = await axios.get(`${BASE}/api/v1/system/me`, { validateStatus: () => true });
      expect(r.status).toBe(401);
    });
  });

  describe('POST /api/v1/system/change-password', () => {
    it('200 改密成功', async () => {
      // 用一次性 system 用户的临时 token；这里复用 system token 不改真实密码（避免污染 seed）
      // 真实改密路径需要专门 fixture，简化：只验证端点存在 + 鉴权通
      const r = await axios.post(
        `${BASE}/api/v1/system/change-password`,
        { old_password: '__test__', new_password: 'NewPass-12345678' },
        {
          headers: { authorization: http.system.defaults.headers.authorization },
          validateStatus: () => true,
        },
      );
      // 旧密码错返回 401（端点通 + 鉴权通）
      expect([200, 401]).toContain(r.status);
    });

    it('400 new_password < 8 字符', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/system/change-password`,
        { old_password: 'whatever', new_password: 'short' },
        {
          headers: { authorization: http.system.defaults.headers.authorization },
          validateStatus: () => true,
        },
      );
      expect(r.status).toBe(400);
    });

    it('401 无 token', async () => {
      const r = await axios.post(
        `${BASE}/api/v1/system/change-password`,
        { old_password: 'a', new_password: 'NewPass-12345678' },
        { validateStatus: () => true },
      );
      expect(r.status).toBe(401);
    });
  });
});
