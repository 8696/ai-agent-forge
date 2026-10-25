import { config } from '../config';
import { logger } from '../logger';
import { writeAuditLog } from '../lib/audit-log';
import {
  llmConfirmInjection,
  llmModerateOutput,
  maskPii,
  scanInjectionRules,
  scanSensitiveWords,
  sensitiveSummary,
  type GuardLlmConfig,
} from '../lib/security';

/**
 * 安全防护编排 —— D4（docs/12-d-需求-运维稳定.md §D4 / docs/10-安全方案.md §10.1-§10.3）
 *
 * 输入侧的顺序（**不能换**）：
 *   1. 脱敏       —— 先把身份证 / 银行卡 / 手机号换掉
 *   2. 敏感词     —— 在**脱敏后**的文本上查（脱敏会把号码变成 ***，不影响词库命中）
 *   3. 注入规则   —— 同样在脱敏后的文本上跑
 *   4. 注入二次确认 —— 规则命中时（或 always 模式下）问一次大模型
 *
 * 为什么脱敏放最前面：
 * 后面所有的审核、检索、落库、日志拿到的都是脱敏后的文本，
 * 敏感号码不会出现在任何下游环节（包括发给模型的 prompt）。
 *
 * ⚠️ 拦截语义：**命中即拒**（403），不做「打个标记继续」。
 * 理由是审核一旦变成「提示」，就等于没有；而误杀的代价
 * （用户换个说法再问一次）远小于漏放的代价。
 */

/** 被拦截时统一给用户看的文案 */
export const CONTENT_BLOCKED_MESSAGE = '内容违规';
export const INJECTION_BLOCKED_MESSAGE = '检测到提示词注入，已拒绝该请求';

/** 审核动作的分类 */
export type GuardCategory = 'sensitive' | 'injection' | 'output';

export interface GuardActor {
  tenantId: string;
  /** 可空：Session.user_id 允许为 NULL（未来 widget 匿名访问场景） */
  userId: string | null;
  /** 用于二次确认的 LLM（用租户自己的配置，不额外消耗平台凭据） */
  llm: GuardLlmConfig;
  ip?: string | null;
}

export interface InputGuardResult {
  /** 放行后的文本（已脱敏）—— 这才是允许落库 / 送进模型的内容 */
  text: string;
  /** 是否被拦截 */
  blocked: boolean;
  /** 拦截时给用户看的中文文案 */
  reason: string | null;
  /** 拦截分类 */
  category: GuardCategory | null;
  /** 脱敏命中的条数（不记内容） */
  maskedCount: number;
  /** 命中的注入规则名（不记内容） */
  ruleHits: string[];
}

/**
 * 输入侧总闸门。
 *
 * 调用方（chat-routes）拿 `result.text` 去落库和送模型；
 * `result.blocked === true` 时应当直接返回 403。
 */
export async function guardUserInput(
  rawText: string,
  actor: GuardActor,
): Promise<InputGuardResult> {
  // ---- 1. 脱敏 ----
  // ⚠️ **无条件执行，且排在最前面** —— 后面所有环节（审核 / 检索 / 落库 / 日志 / prompt）
  //    拿到的都是脱敏后的文本。
  //
  //    这里**故意不给开关**：脱敏是「写进历史库之前的最后一道防线」，
  //    一旦能通过 .env 关掉，就等于允许把身份证 / 银行卡明文存进数据库。
  //    （跟 `CONFIG_ENCRYPTION_KEY` 一个思路：安全相关的开关不给「关掉就降级成明文」的余地。）
  const masked = maskPii(rawText);
  let text = masked.text;
  const maskedCount = masked.hits.length;
  if (maskedCount > 0) {
    logger.info(
      { tenantId: actor.tenantId, userId: actor.userId, maskedCount },
      '输入里有敏感数据，已脱敏',
    );
  }

  // ---- 2. 敏感词（本地词库，零成本零延迟）----
  if (config.SECURITY.SENSITIVE_WORDS_ENABLED) {
    const scan = scanSensitiveWords(text);
    if (scan.hitCount > 0) {
      const summary = sensitiveSummary(scan);
      logger.warn(
        { tenantId: actor.tenantId, userId: actor.userId, ...summary },
        '输入命中敏感词，已拦截',
      );
      await writeAuditLog({
        tenant_id: actor.tenantId,
        user_id: actor.userId,
        action: 'CONTENT_MODERATION_BLOCKED',
        resource_type: 'message',
        details: { stage: 'input', ...summary },
        ip: actor.ip ?? null,
      });
      return {
        text,
        blocked: true,
        reason: CONTENT_BLOCKED_MESSAGE,
        category: 'sensitive',
        maskedCount,
        ruleHits: [],
      };
    }
  }

  // ---- 3 + 4. 注入检测（规则 + 大模型二次确认）----
  const ruleHits: string[] = [];
  if (config.SECURITY.INJECTION_ENABLED) {
    const scan = scanInjectionRules(text);
    ruleHits.push(...scan.hits.map((h) => h.name));

    const mode = config.SECURITY.INJECTION_LLM_MODE;
    // always = 每条都问模型；confirm = 只在规则命中时问；off = 只用规则
    const shouldAskModel =
      mode === 'always' || (mode === 'confirm' && scan.hits.length > 0);

    if (shouldAskModel) {
      const verdict = await llmConfirmInjection(text, actor.llm, config.SECURITY.GUARD_TIMEOUT_MS);

      if (!verdict.failed) {
        if (verdict.verdict) {
          logger.warn(
            {
              tenantId: actor.tenantId,
              userId: actor.userId,
              rules: scan.hits.map((h) => h.name),
              severity: scan.maxSeverity,
            },
            '注入检测拦下该输入',
          );
          await writeAuditLog({
            tenant_id: actor.tenantId,
            user_id: actor.userId,
            action: 'PROMPT_INJECTION_BLOCKED',
            resource_type: 'message',
            details: {
              rules: scan.hits.map((h) => h.name),
              severity: scan.maxSeverity,
              detected_by: 'llm',
            },
            ip: actor.ip ?? null,
          });
          return {
            text,
            blocked: true,
            reason: INJECTION_BLOCKED_MESSAGE,
            category: 'injection',
            maskedCount,
            ruleHits,
          };
        }
        // 模型认为不是注入 —— 放行。规则命中但模型放行的情况记 debug，
        // 便于回头调规则（误杀太多的时候要看这个）。
        if (scan.hits.length > 0) {
          logger.debug(
            { tenantId: actor.tenantId, rules: scan.hits.map((h) => h.name) },
            '规则命中但二次确认判定为正常放行',
          );
        }
      } else {
        // 模型判不出来（超时 / 报错 / 没配凭据）
        //   high   → 照样拦（宁可误杀一次，也不放行明确的越狱指令）
        //   medium → 放行（这类句式在正常提问里也常见）
        const failClosed = scan.maxSeverity === 'high';
        logger.warn(
          {
            tenantId: actor.tenantId,
            severity: scan.maxSeverity,
            rules: scan.hits.map((h) => h.name),
            failClosed,
          },
          '注入二次确认失败，按规则严重度降级处理',
        );
        if (failClosed) {
          await writeAuditLog({
            tenant_id: actor.tenantId,
            user_id: actor.userId,
            action: 'PROMPT_INJECTION_BLOCKED',
            resource_type: 'message',
            details: {
              rules: scan.hits.map((h) => h.name),
              severity: scan.maxSeverity,
              detected_by: 'rule_fallback',
            },
            ip: actor.ip ?? null,
          });
          return {
            text,
            blocked: true,
            reason: INJECTION_BLOCKED_MESSAGE,
            category: 'injection',
            maskedCount,
            ruleHits,
          };
        }
      }
    } else if (scan.hits.length > 0 && mode === 'off') {
      // 明确关掉了模型确认 → 规则命中就拦（这是这个模式的意义）
      await writeAuditLog({
        tenant_id: actor.tenantId,
        user_id: actor.userId,
        action: 'PROMPT_INJECTION_BLOCKED',
        resource_type: 'message',
        details: { rules: scan.hits.map((h) => h.name), severity: scan.maxSeverity },
        ip: actor.ip ?? null,
      });
      return {
        text,
        blocked: true,
        reason: INJECTION_BLOCKED_MESSAGE,
        category: 'injection',
        maskedCount,
        ruleHits,
      };
    }
  }

  return {
    text,
    blocked: false,
    reason: null,
    category: null,
    maskedCount,
    ruleHits,
  };
}

export interface OutputGuardResult {
  blocked: boolean;
  reason: string | null;
  category: GuardCategory | null;
}

/** 被输出审核拦下时，替代原文写进 messages 的文案 */
export const OUTPUT_BLOCKED_TEXT = '（该回答未通过内容审核，已被拦截）';

/**
 * 输出侧审核。
 *
 * ⚠️ **SSE 的固有约束**：回答是逐字流给浏览器的，字节发出去就收不回来。
 *    所以这一层能做到的是：
 *      - 词库命中 → 立刻判定，**不把原文写进 messages**，改写拦截文案
 *      - 大模型复核 → 只能事后判定，同样不落原文
 *    也就是说「不落库 + 前端提示替换」是能保证的，
 *    「一个字节都不发给浏览器」做不到 —— 除非放弃流式（改成先缓冲再审核）。
 *    词库那层是常开的，它在绝大多数情况下能在违规内容刚开始出现时就命中。
 */
export async function guardAssistantOutput(
  text: string,
  actor: GuardActor,
): Promise<OutputGuardResult> {
  if (text.trim() === '') {
    return { blocked: false, reason: null, category: null };
  }

  if (config.SECURITY.SENSITIVE_WORDS_ENABLED) {
    const scan = scanSensitiveWords(text);
    if (scan.hitCount > 0) {
      const summary = sensitiveSummary(scan);
      logger.warn({ tenantId: actor.tenantId, ...summary }, '模型输出命中敏感词，已拦截');
      await writeAuditLog({
        tenant_id: actor.tenantId,
        user_id: actor.userId,
        action: 'CONTENT_MODERATION_BLOCKED',
        resource_type: 'message',
        details: { stage: 'output', ...summary },
        ip: actor.ip ?? null,
      });
      return { blocked: true, reason: CONTENT_BLOCKED_MESSAGE, category: 'sensitive' };
    }
  }

  if (config.SECURITY.OUTPUT_LLM_CHECK) {
    const verdict = await llmModerateOutput(text, actor.llm, config.SECURITY.GUARD_TIMEOUT_MS);
    if (!verdict.failed && verdict.verdict) {
      logger.warn({ tenantId: actor.tenantId }, '模型输出被大模型复核拦下');
      await writeAuditLog({
        tenant_id: actor.tenantId,
        user_id: actor.userId,
        action: 'CONTENT_MODERATION_BLOCKED',
        resource_type: 'message',
        details: { stage: 'output', detected_by: 'llm' },
        ip: actor.ip ?? null,
      });
      return { blocked: true, reason: CONTENT_BLOCKED_MESSAGE, category: 'output' };
    }
    // 判不出来 → 放行（审核层自己挂了不该让所有回答都消失）
  }

  return { blocked: false, reason: null, category: null };
}
