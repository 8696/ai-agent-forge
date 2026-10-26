/**
 * tests/unit/llm-failover.test.ts
 * 对应 src/lib/llm-failover.ts（C4 备用模型 failover）
 * 详见 docs/12-c-需求-管理员可配置.md §C4
 */
import { describe, it, expect, vi } from 'vitest';
import { failoverTextStream, withModelFallback } from '../../src/lib/llm-failover';

/** 造一个只吐给定 chunk 的流 */
function streamOf(
  chunks: Array<{ type: string; delta?: string }>,
): ReadableStream<{ type: string; delta?: string }> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(c);
      }
      controller.close();
    },
  });
}

/** 把流读干，收集所有 chunk */
async function drain<T extends { type: string }>(s: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const reader = s.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return out;
    }
    out.push(value);
  }
}

describe('LLM failover', () => {
  describe('非流式（withModelFallback）', () => {
    it('主模型成功 → 不碰备用', async () => {
      const call = vi.fn(async () => 'ok');
      const out = await withModelFallback({
        primary: { provider: 'p', apiKey: 'k', baseUrl: 'u', model: 'm1' },
        fallback: { provider: 'p', apiKey: 'k', baseUrl: 'u', model: 'm2' },
        call,
      });
      expect(out).toBe('ok');
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('主模型失败 → 切备用重试一次', async () => {
      const call = vi
        .fn()
        .mockRejectedValueOnce(new Error('主模型挂了'))
        .mockResolvedValueOnce('备用成功');
      const out = await withModelFallback({
        primary: { provider: 'p', apiKey: 'k', baseUrl: 'u', model: 'm1' },
        fallback: { provider: 'p', apiKey: 'k', baseUrl: 'u', model: 'm2' },
        call,
      });
      expect(out).toBe('备用成功');
      expect(call).toHaveBeenCalledTimes(2);
    });

    it('没配备用 → 直接抛（不吞错误）', async () => {
      const call = vi.fn().mockRejectedValue(new Error('挂了'));
      await expect(
        withModelFallback({
          primary: { provider: 'p', apiKey: 'k', baseUrl: 'u', model: 'm1' },
          fallback: null,
          call,
        }),
      ).rejects.toThrow('挂了');
      expect(call).toHaveBeenCalledTimes(1);
    });

    it('备用也失败 → 抛备用的错（不无限重试）', async () => {
      const call = vi.fn().mockRejectedValue(new Error('都挂了'));
      await expect(
        withModelFallback({
          primary: { provider: 'p', apiKey: 'k', baseUrl: 'u', model: 'm1' },
          fallback: { provider: 'p', apiKey: 'k', baseUrl: 'u', model: 'm2' },
          call,
        }),
      ).rejects.toThrow('都挂了');
      expect(call).toHaveBeenCalledTimes(2);
    });

    it('切备用时回调被调用', async () => {
      const onFailover = vi.fn();
      const call = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValueOnce('ok');
      await withModelFallback({
        primary: { provider: 'p', apiKey: 'k', baseUrl: 'u', model: 'm1' },
        fallback: { provider: 'p', apiKey: 'k', baseUrl: 'u', model: 'm2' },
        call,
        onFailover,
      });
      expect(onFailover).toHaveBeenCalledTimes(1);
    });
  });

  describe('流式（failoverTextStream）', () => {
    it('正常流 → 原样透出，正文累积正确', async () => {
      const { stream, text } = failoverTextStream({
        primary: streamOf([
          { type: 'text-delta', delta: '你好' },
          { type: 'text-delta', delta: '世界' },
        ]),
        startFallback: null,
        onSwitch: () => undefined,
      });
      const chunks = await drain(stream);
      expect(chunks).toHaveLength(2);
      expect(await text).toBe('你好世界');
    });

    it('没配备用 → error chunk 原样透出', async () => {
      const { stream } = failoverTextStream({
        primary: streamOf([{ type: 'error' }]),
        startFallback: null,
        onSwitch: () => undefined,
      });
      const chunks = await drain(stream);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.type).toBe('error');
    });

    it('还没吐内容就报错 → 切备用，error chunk 不透出', async () => {
      const onSwitch = vi.fn();
      const onFailover = vi.fn();
      const { stream, text } = failoverTextStream({
        primary: streamOf([{ type: 'error' }]),
        startFallback: () => ({
          stream: streamOf([{ type: 'text-delta', delta: '备用模型答的' }]),
          usage: Promise.resolve({ inputTokens: 1 }),
        }),
        onSwitch,
        onFailover,
      });
      const chunks = await drain(stream);
      expect(chunks).toHaveLength(1);
      expect(chunks[0]?.type).toBe('text-delta');
      expect(await text).toBe('备用模型答的');
      expect(onSwitch).toHaveBeenCalledTimes(1);
      expect(onFailover).toHaveBeenCalledTimes(1);
    });

    it('⚠️ 已经吐过内容 → 不切（吐出去的字收不回来）', async () => {
      const onSwitch = vi.fn();
      const startFallback = vi.fn();
      const { stream } = failoverTextStream({
        primary: streamOf([
          { type: 'text-delta', delta: '已经说了一半' },
          { type: 'error' },
        ]),
        startFallback: startFallback as never,
        onSwitch,
      });
      const chunks = await drain(stream);
      expect(startFallback).not.toHaveBeenCalled();
      expect(onSwitch).not.toHaveBeenCalled();
      // 已吐的内容 + 错误都在
      expect(chunks.map((c) => c.type)).toEqual(['text-delta', 'error']);
    });

    it('切备用后 usage 换成备用的', async () => {
      let switchedUsage: unknown = null;
      const { stream } = failoverTextStream({
        primary: streamOf([{ type: 'error' }]),
        startFallback: () => ({
          stream: streamOf([{ type: 'text-delta', delta: 'x' }]),
          usage: Promise.resolve({ inputTokens: 42 }),
        }),
        onSwitch: (u) => {
          switchedUsage = u;
        },
      });
      await drain(stream);
      expect(switchedUsage).not.toBeNull();
      await expect(switchedUsage as Promise<{ inputTokens: number }>).resolves.toEqual({
        inputTokens: 42,
      });
    });

    it('备用自己也失败 → 透出备用的 error', async () => {
      const { stream } = failoverTextStream({
        primary: streamOf([{ type: 'error' }]),
        startFallback: () => ({
          stream: streamOf([{ type: 'error' }]),
          usage: Promise.resolve({ inputTokens: 0 }),
        }),
        onSwitch: () => undefined,
      });
      const chunks = await drain(stream);
      expect(chunks.map((c) => c.type)).toEqual(['error']);
    });
  });
});
