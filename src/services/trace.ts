import { nanoid } from 'nanoid';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sequelize } from '../db';
import { Span, Trace } from '../models';
import { logger } from '../logger';
import { config } from '../config';

/**
 * Trace / Span 采集 —— D2 观测（docs/12-d-需求-运维稳定.md §D2）
 *
 * ## 为什么是「结束时一次性写」而不是「实时写」
 * 一条对话链路会产生 1 条 trace + 5~6 条 span。实时写 = 6 次 INSERT 夹在
 * 用户等待的路径上（其中 2 次在流式响应期间），每一次都要等 MySQL 往返。
 *
 * 改成：trace 开始时只在内存里攒，结束时**一个事务里把 trace + spans 一起写掉**
 * （2 次 INSERT）。代价是「进程在请求中途被 kill 就丢这一条 trace」——
 * 这个代价可以接受：进程崩了本身就要靠日志和僵尸 streaming 行去查。
 *
 * ## 为什么写库失败只 warn 不抛
 * 观测是**旁路**：它挂了不该让用户的对话失败。所以这里吞掉异常，
 * 最多 warn 一行（真出问题时能从日志里看到「trace 丢了」）。
 *
 * ## 跨租户
 * tenant_id 一律由调用方从 JWT 取（handle 创建时定死），span 也冗余一份，
 * 这样「按租户查 span」不用 join traces。
 */

/**
 * trace 类型。
 *
 * - `chat`       一次对话请求（含检索 / LLM / 守卫 / 成本几段 span）
 * - `api`        纯 API 调用
 * - `evaluation` D1 评测跑批
 * - `memory`     B4 记忆抽取 —— **独立的一条 trace**，
 *   不挂在对话那条上：对话 trace 的 duration_ms 要保持「用户感知的耗时」，
 *   把抽取塞进去会污染 p95 延迟指标。
 * - `summary`    B1 会话摘要 —— 同样是独立的一条 trace，理由跟 memory 一样：
 *   摘要是一次额外的 LLM 调用，耗时几秒，挂在对话 trace 上会把 p95 拉飞。
 */
export type TraceKind = 'chat' | 'api' | 'evaluation' | 'memory' | 'summary';

export type SpanKind = 'http' | 'retrieval' | 'llm' | 'guard' | 'cost' | 'storage' | 'step';

export interface TraceUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  total_tokens?: number;
  cost?: number;
}

export interface StartTraceInput {
  tenantId: string;
  userId?: string | null;
  sessionId?: string | null;
  name: string;
  kind?: TraceKind;
  channel?: string | null;
  provider?: string | null;
  model?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface EndTraceInput {
  status?: 'success' | 'error';
  usage?: TraceUsage | null;
  error?: unknown;
  metadata?: Record<string, unknown> | null;
  provider?: string | null;
  model?: string | null;
}

interface SpanState {
  id: string;
  name: string;
  kind: SpanKind;
  startedAt: Date;
  endedAt: Date | null;
  durationMs: number | null;
  status: 'success' | 'error';
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  errorMessage: string | null;
}

export interface SpanHandle {
  readonly id: string;
  readonly name: string;
  readonly kind: SpanKind;
  /** 结束这一段并记录出参摘要 */
  end(output?: Record<string, unknown> | null): void;
  /** 结束这一段并标记为失败 */
  fail(error: unknown, output?: Record<string, unknown> | null): void;
}

export interface TraceHandle {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly name: string;
  readonly kind: TraceKind;
  readonly channel: string | null;
  /** 开一个 span（挂在这条 trace 下） */
  span(name: string, kind: SpanKind, input?: Record<string, unknown> | null): SpanHandle;
  /** 结束 trace 并落库（重复调用只生效一次） */
  end(input?: EndTraceInput): Promise<void>;
  /** 结束 trace 并标记为失败 */
  fail(error: unknown): Promise<void>;
}

function errorSummary(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // 只留摘要：错误消息可能带内部路径 / 堆栈片段，落库前先截断
  return raw.slice(0, 500);
}

/**
 * 开始一条 trace。
 *
 * 观测整个关掉时（TRACE_ENABLED=false）返回一个**空实现** handle ——
 * 调用方不用到处判空。
 */
export function startTrace(input: StartTraceInput): TraceHandle {
  if (!config.OBSERVABILITY.TRACE_ENABLED) {
    return disabledTrace();
  }

  const id = nanoid(21);
  const startedAt = new Date();
  const spans: SpanState[] = [];
  let ended = false;

  const handle: TraceHandle = {
    id,
    tenantId: input.tenantId,
    userId: input.userId ?? null,
    sessionId: input.sessionId ?? null,
    name: input.name,
    kind: input.kind ?? 'chat',
    channel: input.channel ?? null,

    span(name: string, kind: SpanKind, spanInput?: Record<string, unknown> | null): SpanHandle {
      const state: SpanState = {
        id: nanoid(21),
        name,
        kind,
        startedAt: new Date(),
        endedAt: null,
        durationMs: null,
        status: 'success',
        input: spanInput ?? null,
        output: null,
        errorMessage: null,
      };
      spans.push(state);

      const close = (status: 'success' | 'error', output: Record<string, unknown> | null, err: unknown): void => {
        if (state.endedAt !== null) {
          return;
        }
        state.endedAt = new Date();
        state.durationMs = state.endedAt.getTime() - state.startedAt.getTime();
        state.status = status;
        state.output = output;
        state.errorMessage = err === undefined ? null : errorSummary(err);
      };

      return {
        id: state.id,
        name,
        kind,
        end(output?: Record<string, unknown> | null): void {
          close('success', output ?? null, undefined);
        },
        fail(err: unknown, output?: Record<string, unknown> | null): void {
          close('error', output ?? null, err);
        },
      };
    },

    async end(endInput?: EndTraceInput): Promise<void> {
      if (ended) {
        return;
      }
      ended = true;

      const endedAt = new Date();
      const usage = endInput?.usage ?? null;
      const totalTokens =
        usage?.total_tokens ??
        (usage === null
          ? 0
          : (usage.input_tokens ?? 0) +
            (usage.output_tokens ?? 0) +
            (usage.cache_read_tokens ?? 0) +
            (usage.cache_write_tokens ?? 0));

      const status = endInput?.status ?? 'success';
      const metadata = mergeMetadata(input.metadata, endInput?.metadata);

      const traceRow = {
        id,
        tenant_id: input.tenantId,
        user_id: input.userId ?? null,
        session_id: input.sessionId ?? null,
        name: input.name,
        kind: input.kind ?? 'chat',
        status,
        channel: input.channel ?? null,
        provider: endInput?.provider ?? input.provider ?? null,
        model: endInput?.model ?? input.model ?? null,
        input_tokens: usage?.input_tokens ?? 0,
        output_tokens: usage?.output_tokens ?? 0,
        cache_read_tokens: usage?.cache_read_tokens ?? 0,
        cache_write_tokens: usage?.cache_write_tokens ?? 0,
        total_tokens: totalTokens,
        cost: usage?.cost ?? 0,
        duration_ms: endedAt.getTime() - startedAt.getTime(),
        error_message: endInput?.error === undefined ? null : errorSummary(endInput.error),
        metadata,
        started_at: startedAt,
        ended_at: endedAt,
      };

      try {
        await sequelize.transaction(async (tx) => {
          await Trace.create(traceRow, { transaction: tx });

          if (spans.length > 0) {
            await Span.bulkCreate(
              spans.map((s) => ({
                id: s.id,
                trace_id: id,
                tenant_id: input.tenantId,
                parent_span_id: null,
                name: s.name,
                kind: s.kind,
                status: s.status,
                duration_ms: s.durationMs,
                input: s.input,
                output: s.output,
                error_message: s.errorMessage,
                started_at: s.startedAt,
                ended_at: s.endedAt,
              })),
              { transaction: tx },
            );
          }
        });
      } catch (err: unknown) {
        // 观测是旁路 —— 写失败不该让用户的对话失败
        logger.warn(
          { err: errorSummary(err), traceId: id, tenantId: input.tenantId },
          'trace 落库失败（已丢弃，不影响主流程）',
        );
      }

      // 本地 JSONL 副本（docs/09-观测方案.md §9.1「trace 数据写 MySQL + 本地 JSON 文件」）
      await appendTraceJsonl(traceRow, spans);
    },

    async fail(err: unknown): Promise<void> {
      await handle.end({ status: 'error', error: err });
    },
  };

  return handle;
}

function mergeMetadata(
  base: Record<string, unknown> | null | undefined,
  extra: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (base === null || base === undefined) {
    return extra ?? null;
  }
  if (extra === null || extra === undefined) {
    return base;
  }
  return { ...base, ...extra };
}

// ============================================================
// 本地 JSONL 副本（docs/09-观测方案.md §9.1）
// ============================================================

/**
 * 往 `logs/trace-YYYY-MM-DD.jsonl` 追加一行 trace 记录。
 *
 * 为什么 MySQL 之外还要一份文件：
 *  - D2 的验收写的是「日志文件多一条 JSON，含 traceId / tenantId / tokens / duration」
 *  - 文件能直接被 `tail -f | jq` 消费，MySQL 里的表不适合实时跟
 *
 * 写失败只 debug 一行：文件是副本，MySQL 才是真相来源，
 * 磁盘满 / 目录不可写都不该影响用户的对话。
 */
async function appendTraceJsonl(
  traceRow: Record<string, unknown>,
  spans: SpanState[],
): Promise<void> {
  if (!config.OBSERVABILITY.TRACE_FILE_ENABLED) {
    return;
  }
  try {
    const dir = path.resolve(process.cwd(), 'logs');
    await fs.mkdir(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    const file = path.join(dir, `trace-${day}.jsonl`);

    const payload = {
      traceId: traceRow['id'],
      tenantId: traceRow['tenant_id'],
      userId: traceRow['user_id'],
      sessionId: traceRow['session_id'],
      name: traceRow['name'],
      kind: traceRow['kind'],
      status: traceRow['status'],
      channel: traceRow['channel'],
      provider: traceRow['provider'],
      model: traceRow['model'],
      inputTokens: traceRow['input_tokens'],
      outputTokens: traceRow['output_tokens'],
      totalTokens: traceRow['total_tokens'],
      cost: traceRow['cost'],
      durationMs: traceRow['duration_ms'],
      errorMessage: traceRow['error_message'],
      startedAt: (traceRow['started_at'] as Date).toISOString(),
      endedAt: (traceRow['ended_at'] as Date).toISOString(),
      spans: spans.map((s) => ({
        spanId: s.id,
        name: s.name,
        kind: s.kind,
        status: s.status,
        durationMs: s.durationMs,
      })),
    };

    await fs.appendFile(file, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch (err: unknown) {
    logger.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'trace JSONL 副本写入失败（已忽略）',
    );
  }
}

/** 观测关闭时的空实现 —— 调用方不需要判空 */
function disabledTrace(): TraceHandle {
  const noopSpan = (): SpanHandle => ({
    id: '',
    name: '',
    kind: 'step',
    end: () => undefined,
    fail: () => undefined,
  });
  return {
    id: '',
    tenantId: '',
    userId: null,
    sessionId: null,
    name: '',
    kind: 'chat',
    channel: null,
    span: noopSpan,
    end: async () => undefined,
    fail: async () => undefined,
  };
}

/**
 * 用一个 span 包住一段异步逻辑，自动记耗时。
 *
 * 失败时 span 记为 error 并**继续往上抛** —— span 不改变控制流。
 */
export async function withSpan<T>(
  handle: TraceHandle,
  name: string,
  kind: SpanKind,
  fn: (span: SpanHandle) => Promise<T>,
  input?: Record<string, unknown> | null,
): Promise<T> {
  const span = handle.span(name, kind, input);
  try {
    const result = await fn(span);
    span.end();
    return result;
  } catch (err: unknown) {
    span.fail(err);
    throw err;
  }
}
