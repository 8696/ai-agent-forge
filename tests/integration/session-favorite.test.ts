/**
 * tests/integration/session-favorite.test.ts
 * 对应 src/gateway/customer/chat-routes.ts 的 PATCH /sessions/:id/favorite
 *          + GET /sessions?favorite=true
 * 详见 docs/12-e-需求-业务接入与平台运营.md 需求裁定表 #7
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { allHttpFromTokensFile, type AllHttp } from '../helpers';

describe('会话收藏（12-e 裁定表 #7）', () => {
  let http: AllHttp;

  beforeAll(async () => {
    http = await allHttpFromTokensFile();
  });

  const newSession = async (client = http.acmeCustomer): Promise<string> => {
    const r = await client.post<{ id: string }>('/sessions');
    expect(r.status).toBe(201);
    return r.data.id;
  };

  it('收藏 → 列表里 favorite=true', async () => {
    const id = await newSession();
    const r = await http.acmeCustomer.patch<{ id: string; favorite: boolean }>(
      `/sessions/${id}/favorite`,
      {},
      { validateStatus: () => true },
    );
    expect(r.status).toBe(200);
    expect(r.data.favorite).toBe(true);

    const list = await http.acmeCustomer.get<{ sessions: Array<{ id: string; favorite: boolean }> }>(
      '/sessions',
      { params: { page_size: 100 } },
    );
    const row = list.data.sessions.find((s) => s.id === id);
    expect(row?.favorite).toBe(true);
  });

  it('再调一次（不带 body）→ 切换成取消收藏', async () => {
    const id = await newSession();
    await http.acmeCustomer.patch(`/sessions/${id}/favorite`, {});
    const r = await http.acmeCustomer.patch<{ favorite: boolean }>(
      `/sessions/${id}/favorite`,
      {},
      { validateStatus: () => true },
    );
    expect(r.status).toBe(200);
    expect(r.data.favorite).toBe(false);
  });

  it('带 favorite=true → 设成指定状态（不是切换）', async () => {
    const id = await newSession();
    const r = await http.acmeCustomer.patch<{ favorite: boolean }>(
      `/sessions/${id}/favorite`,
      { favorite: true },
      { validateStatus: () => true },
    );
    expect(r.data.favorite).toBe(true);
    const again = await http.acmeCustomer.patch<{ favorite: boolean }>(
      `/sessions/${id}/favorite`,
      { favorite: true },
      { validateStatus: () => true },
    );
    expect(again.data.favorite).toBe(true);
  });

  it('?favorite=true → 只回收藏的会话', async () => {
    const id = await newSession();
    await http.acmeCustomer.patch(`/sessions/${id}/favorite`, { favorite: true });

    const list = await http.acmeCustomer.get<{
      sessions: Array<{ id: string; favorite: boolean }>;
    }>('/sessions', { params: { favorite: 'true', page_size: 100 } });
    expect(list.data.sessions.length).toBeGreaterThan(0);
    expect(list.data.sessions.every((s) => s.favorite)).toBe(true);
    expect(list.data.sessions.some((s) => s.id === id)).toBe(true);
  });

  it('别人的会话 → 404（不能收藏别人的）', async () => {
    const id = await newSession();
    const r = await http.globCustomer.patch(
      `/sessions/${id}/favorite`,
      {},
      { validateStatus: () => true },
    );
    expect(r.status).toBe(404);
  });

  it('无 token → 401', async () => {
    const id = await newSession();
    const r = await http.acmeCustomer.patch(
      `/sessions/${id}/favorite`,
      {},
      { headers: { authorization: 'Bearer invalid' }, validateStatus: () => true },
    );
    expect(r.status).toBe(401);
  });
});
