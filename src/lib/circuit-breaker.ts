/**
 * 熔断器（Circuit Breaker）—— docs/12-d-需求-运维稳定.md §D5
 *
 * D5 的需求句是「限流 + **熔断** + 审计日志」——
 * 限流挡的是「刷太快」，熔断挡的是「上游已经挂了，还在往里冲」。
 * 上游挂了的时候继续发请求，只会得到一堆超时，
 * 用户等 30 秒拿到一句「生成失败」，而上游根本恢复不了。
 *
 * 三个状态：
 *   closed     正常（默认）—— 请求照发
 *   open       已断开 —— 连续失败够了，直接快速失败，不再打上游
 *   half-open  半开 —— 冷却期过了，放**一个**请求过去探活；成功就闭合，失败就继续断开
 *
 * 为什么不上 Redis / 熔断库：跟限流一个取舍（docs/03-b §B.5「进程内 Map，不上 Redis」）。
 * 熔断是**尽力而为的降级** —— 断错了顶多多拒一会儿，不影响数据正确性，
 * 所以多实例部署时「每个实例各断各的」可以接受。
 *
 * 按**端点**分桶（key = provider + base_url）：
 *  - 某个租户自己的 LLM 端点挂了 → 只断它自己，不影响别的租户
 *  - 平台默认端点挂了 → 所有用它的租户一起断（上游确实是同一个）
 */

import { config } from '../config';

export type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * 熔断期间拒绝请求时抛的错。
 *
 * 单独一个类型，是为了前端能拿到一句**说人话**的提示
 * （「正在恢复中」而不是笼统的「生成失败」）——
 * 上游挂了和「你这轮问得不好」是两回事。
 */
export class CircuitOpenError extends Error {
  constructor(public readonly endpoint: string) {
    super(`LLM 端点熔断中：${endpoint}`);
    this.name = 'CircuitOpenError';
  }
}

export interface BreakerConfig {
  /** 连续失败多少次就断开 */
  failureThreshold: number;
  /** 断开后多久进入半开（毫秒） */
  cooldownMs: number;
}

export class CircuitBreaker {
  private state_: BreakerState = 'closed';
  private consecutiveFailures = 0;
  /** 断开的时间点（冷却期从这儿算） */
  private openedAt = 0;
  /** 半开状态下探活请求是否已经在飞 */
  private probeInFlight = false;

  constructor(private readonly cfg: BreakerConfig) {}

  get state(): BreakerState {
    return this.state_;
  }

  /** 连续失败次数（调试 / 指标用） */
  get failures(): number {
    return this.consecutiveFailures;
  }

  /**
   * 这次请求放不放行。
   *
   * ⚠️ **有副作用**：半开时会把「探活名额」占掉 —— 同一个端点并发来一堆请求时，
   * 只有第一个能过去，其余全部快速失败（不然冷却期一过就又是一次洪峰）。
   */
  allowRequest(): boolean {
    if (this.state_ === 'open') {
      if (Date.now() - this.openedAt < this.cfg.cooldownMs) {
        return false;
      }
      // 冷却期到了 → 进半开，放一个探活请求
      this.state_ = 'half-open';
      this.probeInFlight = false;
    }
    if (this.state_ === 'half-open') {
      if (this.probeInFlight) {
        return false;
      }
      this.probeInFlight = true;
      return true;
    }
    return true;
  }

  /** 请求成功 —— 闭合，连续失败计数清零 */
  recordSuccess(): void {
    this.state_ = 'closed';
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }

  /**
   * 请求失败 —— 连续失败到阈值就断开。
   *
   * 半开状态下的失败**立刻**重新断开（不等阈值）：
   * 探活都失败了，说明上游还没好，没必要再攒失败次数。
   */
  recordFailure(): void {
    this.probeInFlight = false;
    if (this.state_ === 'half-open') {
      this.state_ = 'open';
      this.openedAt = Date.now();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.cfg.failureThreshold) {
      this.state_ = 'open';
      this.openedAt = Date.now();
      this.consecutiveFailures = 0;
    }
  }

  /** 手动复位（运维用 / 测试用） */
  reset(): void {
    this.state_ = 'closed';
    this.consecutiveFailures = 0;
    this.probeInFlight = false;
  }
}

/** 端点 key → 熔断器 */
const breakers = new Map<string, CircuitBreaker>();

/**
 * 取（并按需创建）某个端点的熔断器。
 *
 * key 建议用 `provider + '|' + base_url` —— 同 provider 不同端点算不同的上游。
 */
export function getBreaker(key: string): CircuitBreaker {
  let breaker = breakers.get(key);
  if (breaker === undefined) {
    breaker = new CircuitBreaker({
      failureThreshold: config.CIRCUIT_BREAKER.FAILURE_THRESHOLD,
      cooldownMs: config.CIRCUIT_BREAKER.COOLDOWN_MS,
    });
    breakers.set(key, breaker);
  }
  return breaker;
}

/** 清掉全部熔断器（测试用 / 运维复位用） */
export function resetAllBreakers(): void {
  breakers.clear();
}
