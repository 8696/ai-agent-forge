/**
 * tests/unit/trace-span-tree.test.ts
 * 对应 src/services/trace.ts 的 span 父子关系支持（B6 多代理的调用树）
 *
 * ⚠️ 这个文件只测「句柄层」的行为（能不能指定父 span、id 是不是唯一）。
 *    「落库后 parent_span_id 对不对」要连库 —— 见
 *    tests/integration/trace-span-tree.test.ts。
 */
import { describe, it, expect } from 'vitest';
import { startTrace } from '../../src/services/trace';

describe('trace · span 父子关系（B6 调用树）', () => {
  it('不传 parent → 顶层 span', () => {
    const trace = startTrace({ tenantId: 't1', name: 'x' });
    const span = trace.span('llm.generate', 'llm');
    expect(span.id.length).toBeGreaterThan(0);
    expect(span.kind).toBe('llm');
  });

  it('传 parent → 拿到一个独立的 span（id 不跟父的一样）', () => {
    const trace = startTrace({ tenantId: 't1', name: 'x' });
    const parent = trace.span('llm.generate', 'llm');
    const child = trace.span('agent.delegate', 'agent', { agent: 'order_agent' }, parent.id);
    expect(child.id).not.toBe(parent.id);
    expect(child.kind).toBe('agent');
  });

  it('能建多层（子代理再派子代理）', () => {
    const trace = startTrace({ tenantId: 't1', name: 'x' });
    const a = trace.span('llm.generate', 'llm');
    const b = trace.span('agent.delegate', 'agent', {}, a.id);
    const c = trace.span('agent.delegate', 'agent', {}, b.id);
    const ids = new Set([a.id, b.id, c.id]);
    expect(ids.size).toBe(3);
  });

  it('子 span 的 end / fail 各自独立', () => {
    const trace = startTrace({ tenantId: 't1', name: 'x' });
    const parent = trace.span('llm.generate', 'llm');
    const child = trace.span('agent.delegate', 'agent', {}, parent.id);
    child.fail(new Error('子代理挂了'));
    // 父 span 不受影响（还能正常 end）
    expect(() => parent.end()).not.toThrow();
  });

  it('agent 是合法的 span kind', () => {
    const trace = startTrace({ tenantId: 't1', name: 'x' });
    const span = trace.span('agent.delegate', 'agent');
    expect(span.kind).toBe('agent');
  });
});
