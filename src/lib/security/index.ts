/**
 * 安全检测 barrel —— D4（docs/12-d-需求-运维稳定.md §D4）
 *
 * 分三层，层层递进：
 *   1. 脱敏（mask）        —— 把身份证 / 银行卡 / 手机号换掉，无条件执行
 *   2. 本地规则（sensitive-words / injection）—— 零成本、零延迟，挡住绝大多数
 *   3. 大模型确认（llm-guard）—— 规则存疑时再问一次模型，挡住变形绕过
 *
 * 编排逻辑在 src/services/security-guard.ts（那里还要写审计日志）。
 */
export {
  maskPii,
  maskPiiText,
  looksLikeBankCard,
  luhnValid,
  MASK_PLACEHOLDER,
  type PiiType,
  type PiiHit,
  type MaskResult,
} from './mask';

export {
  scanSensitiveWords,
  sensitiveSummary,
  SENSITIVE_WORDS,
  SENSITIVE_CATEGORY_LABELS,
  type SensitiveCategory,
  type SensitiveWordHit,
  type SensitiveScanResult,
} from './sensitive-words';

export {
  scanInjectionRules,
  INJECTION_RULES,
  type InjectionSeverity,
  type InjectionRule,
  type InjectionRuleHit,
  type InjectionScanResult,
} from './injection';

export {
  llmConfirmInjection,
  llmModerateOutput,
  parseVerdict,
  type GuardLlmConfig,
  type LlmVerdict,
} from './llm-guard';
