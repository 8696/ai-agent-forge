import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { CircuitBreaker, CircuitOpenError, getBreaker, resetAllBreakers } from '../../src/lib/circuit-breaker';

/**
 * 熔断器（Circuit Breaker）—— docs/12-d §D5
 *
 * D5 的需求句是「限流 + 熔断 + 审计日志」，熔断这块之前完全没实现。
 *
 * 锁住的核心语义：
 *  1. 连续失败到阈值才断开（不是第一次失败就断 —— 偶发失败很常见）
 *  2. 断开期间**不再打上游**（这是熔断的意义：快速失败，别再烧 30 秒超时）
 *  3. 冷却期后半开，只放**一个**探活请求（不是放一批）
 *  4. 探活成功 → 闭合；探活失败 → 继续断开并重新计时
 */

describe('熔断器 · 状态机', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    // 用可控的阈值和冷却期，不依赖进程配置
    breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('初始状态是 closed，请求照发', () => {
    expect(breaker.state).toBe('closed');
    expect(breaker.allowRequest()).toBe(true);
  });

  it('失败没到阈值不断开', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
    expect(breaker.allowRequest()).toBe(true);
  });

  it('连续失败到阈值就断开', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
  });

  it('断开期间不再打上游（快速失败）', () => {
    for (let i = 0; i < 3; i += 1) breaker.recordFailure();
    expect(breaker.allowRequest()).toBe(false);
    expect(breaker.allowRequest()).toBe(false);
  });

  it('中途成功会清零连续失败计数', () => {
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.failures).toBe(0);
    // 计数清零后再失败两次也不该断开（阈值 3）
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.state).toBe('closed');
  });

  it('冷却期后进半开，只放一个探活请求', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure();
    expect(breaker.allowRequest()).toBe(false);

    vi.advanceTimersByTime(1200);
    // 第一个 = 探活请求，放行
    expect(breaker.allowRequest()).toBe(true);
    expect(breaker.state).toBe('half-open');
    // 第二个 = 探活还在飞，快速失败（不然冷却期一过又是一波洪峰）
    expect(breaker.allowRequest()).toBe(false);
  });

  it('探活成功 → 闭合', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure();
    vi.advanceTimersByTime(1200);
    expect(breaker.allowRequest()).toBe(true);

    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.allowRequest()).toBe(true);
  });

  it('探活失败 → 继续断开，并重新计时', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 3; i += 1) breaker.recordFailure();
    vi.advanceTimersByTime(1200);
    expect(breaker.allowRequest()).toBe(true);

    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    // 冷却期重新开始 —— 半开就失败的不该马上再放
    expect(breaker.allowRequest()).toBe(false);

    vi.advanceTimersByTime(1200);
    expect(breaker.allowRequest()).toBe(true);
  });

  it('reset 能手动复位', () => {
    for (let i = 0; i < 3; i += 1) breaker.recordFailure();
    expect(breaker.state).toBe('open');
    breaker.reset();
    expect(breaker.state).toBe('closed');
    expect(breaker.allowRequest()).toBe(true);
  });
});

describe('熔断器 · 注册表', () => {
  beforeEach(() => {
    resetAllBreakers();
  });

  it('同一个 key 拿到同一个实例', () => {
    expect(getBreaker('zhipu|https://a.example.com')).toBe(getBreaker('zhipu|https://a.example.com'));
  });

  it('不同 key 是不同实例（按端点分桶）', () => {
    expect(getBreaker('zhipu|https://a.example.com')).not.toBe(
      getBreaker('zhipu|https://b.example.com'),
    );
  });
});

describe('CircuitOpenError', () => {
  it('带端点信息，名字对得上（前端靠 instanceof 分流提示语）', () => {
    const err = new CircuitOpenError('zhipu|https://a.example.com');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CircuitOpenError');
    expect(err.endpoint).toBe('zhipu|https://a.example.com');
    expect(err.message).toContain('zhipu');
  });
});
