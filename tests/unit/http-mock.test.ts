/**
 * tests/unit/http-mock.test.ts
 * 对应 src/tools/http-mock.ts（http 类型的工具 —— 本地 mock，不真出网）
 * 详见 docs/12-e-需求-业务接入与平台运营.md 需求裁定表 #2 / #3
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  HTTP_METHODS,
  buildHttpInputSchema,
  createHttpToolImpl,
  type HttpToolConfig,
} from '../../src/tools/http-mock';

const ctx = { tenantId: 'tenant-a', sessionId: null, userId: null };

describe('http 工具 · 本地 mock', () => {
  describe('配置校验', () => {
    it('没 url → 返回 null（不让模型调一个必然失败的工具）', () => {
      expect(createHttpToolImpl({}, 'x')).toBeNull();
      expect(createHttpToolImpl({ url: '   ' }, 'x')).toBeNull();
    });

    it('method 不认识 → 返回 null', () => {
      expect(createHttpToolImpl({ url: 'https://a.com/x', method: 'TRACE' }, 'x')).toBeNull();
    });

    it('method 合法（大小写不敏感）→ 造得出实现', () => {
      expect(createHttpToolImpl({ url: 'https://a.com/x', method: 'post' }, 'x')).not.toBeNull();
      expect(createHttpToolImpl({ url: 'https://a.com/x' }, 'x')).not.toBeNull();
      for (const m of HTTP_METHODS) {
        expect(createHttpToolImpl({ url: 'https://a.com/x', method: m }, 'x')).not.toBeNull();
      }
    });
  });

  describe('入参 schema', () => {
    it('没声明字段 → 自由对象（模型传什么收什么）', () => {
      const schema = buildHttpInputSchema(undefined);
      expect(schema.safeParse({ anything: 1 }).success).toBe(true);
      expect(schema.safeParse({ a: 'b', c: [1, 2] }).success).toBe(true);
    });

    it('声明了必填字段 → 缺了就过不了', () => {
      const schema = buildHttpInputSchema([
        { name: 'order_no', type: 'string', required: true },
        { name: 'amount', type: 'number' },
      ]);
      expect(schema.safeParse({ order_no: 'SO-1' }).success).toBe(true);
      // 缺必填 → 失败
      expect(schema.safeParse({ amount: 1 }).success).toBe(false);
      // 类型不对 → 失败
      expect(schema.safeParse({ order_no: 'SO-1', amount: 'x' }).success).toBe(false);
    });

    it('可选字段缺了不影响', () => {
      const schema = buildHttpInputSchema([{ name: 'note', type: 'string' }]);
      expect(schema.safeParse({}).success).toBe(true);
    });

    it('脏数据丢掉而不是让整个工具崩掉', () => {
      const schema = buildHttpInputSchema([
        { name: 'ok_field', type: 'string' },
        { name: '', type: 'string' },
        { name: 'bad name', type: 'string' },
        { name: 'x', type: 'number' } as never,
        'not an object' as never,
        null as never,
      ]);
      // 只有 ok_field 进了 schema
      expect(schema.safeParse({ ok_field: 'v' }).success).toBe(true);
      // 非法字段名没被当成必填
      expect(schema.safeParse({}).success).toBe(true);
    });

    it('整个 input_fields 不是数组 → 当没声明', () => {
      const schema = buildHttpInputSchema('not an array' as never);
      expect(schema.safeParse({ x: 1 }).success).toBe(true);
    });
  });

  describe('响应', () => {
    const config: HttpToolConfig = { url: 'https://api.example.com/orders', method: 'GET' };

    it('确定性：同样的调用两次 → 一样的结果', async () => {
      const impl = createHttpToolImpl(config, 'q');
      expect(impl).not.toBeNull();
      const a = await impl!.execute(ctx, { order_no: 'SO-1' });
      const b = await impl!.execute(ctx, { order_no: 'SO-1' });
      expect(a).toEqual(b);
    });

    it('不同租户 → 不同结果（不串数据）', async () => {
      const impl = createHttpToolImpl(config, 'q');
      const a = await impl!.execute(ctx, { order_no: 'SO-1' });
      const b = await impl!.execute({ ...ctx, tenantId: 'tenant-b' }, { order_no: 'SO-1' });
      expect(a).not.toEqual(b);
    });

    it('响应里有 url / method / 回显入参', async () => {
      const impl = createHttpToolImpl(config, 'q');
      const out = (await impl!.execute(ctx, { order_no: 'SO-1' })) as Record<string, unknown>;
      expect(out.url).toBe('https://api.example.com/orders');
      expect(out.method).toBe('GET');
      expect(out.mocked).toBe(true);
      expect((out.data as Record<string, unknown>).query).toEqual({ order_no: 'SO-1' });
    });

    it('租户写了 mock_response → 用它', async () => {
      const impl = createHttpToolImpl(
        { ...config, mock_response: { items: [1, 2, 3] } },
        'q',
      );
      const out = (await impl!.execute(ctx, {})) as Record<string, unknown>;
      expect(out.data).toEqual({ items: [1, 2, 3] });
    });

    it('状态码非 2xx → 抛错（上层降级成 tool result，不中断整轮）', async () => {
      const impl = createHttpToolImpl({ ...config, mock_status: 500 }, 'q');
      await expect(impl!.execute(ctx, {})).rejects.toThrow('500');
    });

    it('状态码 2xx → 正常返回', async () => {
      const impl = createHttpToolImpl({ ...config, mock_status: 404 }, 'q');
      await expect(impl!.execute(ctx, {})).rejects.toThrow('404');
      const ok = createHttpToolImpl({ ...config, mock_status: 201 }, 'q');
      await expect(ok!.execute(ctx, {})).resolves.toBeDefined();
    });

    it('描述里说明「是本地 mock、不会真发请求」', () => {
      const impl = createHttpToolImpl(config, 'q');
      expect(impl?.description).toContain('mock');
      expect(impl?.description).toContain('不会真的');
    });
  });

  describe('zod 兼容性', () => {
    it('生成的 schema 是 zod 的对象（能被 AI SDK 用）', () => {
      const schema = buildHttpInputSchema([{ name: 'a', type: 'string' }]);
      expect(schema).toBeInstanceOf(z.ZodType);
    });
  });
});
