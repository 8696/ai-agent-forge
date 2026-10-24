/**
 * 提示词注入检测（规则层）—— docs/10-安全方案.md §10.1 / docs/12-d-需求-运维稳定.md §D4
 *
 * 规则命中**不等于**一定拦截：还要过一道大模型二次确认（见 llm-guard.ts）。
 * 规则的作用是「把可疑输入挑出来送去确认」，同时在 LLM 挂掉时充当兜底。
 *
 * 每条规则带 severity：
 *   - `high`   明确在索取系统提示词 / 要求进入无限制模式 → LLM 不可用时**照样拦**
 *   - `medium` 只是「扮演」「你现在是」这类可能出现在正常提问里的句式
 *               → LLM 不可用时放行（宁可漏也不误杀正常业务提问）
 *
 * 规则同时覆盖中英文：租户可能用英文提需求。
 */

export type InjectionSeverity = 'high' | 'medium';

export interface InjectionRule {
  /** 规则名（写进审计日志，定位用） */
  name: string;
  severity: InjectionSeverity;
  /** 正则源码（用 /u + 忽略大小写） */
  pattern: RegExp;
}

export interface InjectionRuleHit {
  name: string;
  severity: InjectionSeverity;
}

export interface InjectionScanResult {
  hits: InjectionRuleHit[];
  /** 命中的最高严重度 */
  maxSeverity: InjectionSeverity | null;
}

/**
 * 规则表
 *
 * 写正则时的两个坑：
 *  1. 中文没有 `\b`，「忽略之前的指令」中间的空格 / 全角空格都要能匹配 → 用 `[\s　]*`
 *  2. 关键词之间可能夹任意空白和标点（「输出 你的 system prompt」）
 */
export const INJECTION_RULES: readonly InjectionRule[] = [
  // ---- high：明确索取系统提示 / 内部指令 ----
  {
    // 中英混着说也要抓到（「输出你的 system prompt」是验收里那条原话）
    name: 'reveal_system_prompt',
    severity: 'high',
    pattern:
      /(输出|打印|显示|复述|重复|告诉我|贴出|给我看|背诵|泄露|泄漏|reveal|print|show|output|repeat|display|tell\s+me)[\s\S]{0,24}(system[\s　_-]*prompt|系统[\s　]*(提示词?|指令|设定|规则)|你(的|们)?[\s　]*(提示词?|指令|设定|规则|上下文|system)|your[\s　]+(system[\s　]+)?(prompt|instructions?|rules?)|initial[\s　]+instructions)/i,
  },
  {
    // 中文：动词和目标必须紧挨着（中间只允许「之前 / 以上的」这类连接词），
    // 放太宽会把「忽略细节，我要知道报销要求」这种正常提问也命中
    name: 'ignore_previous_zh',
    severity: 'high',
    pattern:
      /(忽略|无视|忘记|抛弃|别管|不要理)[\s　]*(之前|以上|前面|先前|上述|全部|所有)?[\s　]*(的)?[\s　]*(指令|命令|提示词?|设定|规则|要求|限制)/,
  },
  {
    name: 'ignore_previous_en',
    severity: 'high',
    pattern:
      /(ignore|disregard|forget|override)[\s\S]{0,16}(all\s+|the\s+)?(previous|prior|above|earlier)[\s\S]{0,8}(instructions?|prompts?|rules?|guidelines?)/i,
  },
  {
    name: 'unrestricted_mode',
    severity: 'high',
    pattern:
      /(开发者模式|developer\s*mode|越狱|jailbreak|无限制模式|不受限制|解除限制|自由模式)/i,
  },
  {
    name: 'dan_persona',
    severity: 'high',
    pattern: /(^|[\s　,，。])DAN([\s　]|$|模式|mode)/i,
  },
  {
    name: 'bypass_safety',
    severity: 'high',
    pattern: /(绕过|跳过|规避|无视)[\s　]*(安全|审核|过滤|检测|防护|策略|限制)/,
  },
  {
    name: 'secret_exfil',
    severity: 'high',
    pattern:
      /(你的|你的这个)?[\s　]*(api[\s　_-]*key|密钥|token|口令|密码)[\s　]*(是什么|是多少|是多少？|给我|告诉我|发给我)/i,
  },
  {
    name: 'reveal_context_zh',
    severity: 'high',
    pattern: /(你的|当前|完整)[\s　]*(上下文|对话历史|历史消息|知识库原文|原始文档)[\s　]*(是什么|内容|全部|给我)/,
  },
  {
    name: 'act_as_unrestricted',
    severity: 'high',
    pattern:
      /(act|behave|pretend|roleplay)[\s\S]{0,24}(unrestricted|unfiltered|no\s+rules|dan|jailbreak)/i,
  },

  // ---- medium：正常提问也可能出现的句式 ----
  {
    name: 'persona_switch_zh',
    severity: 'medium',
    pattern: /(你现在是|从现在起你是|假装你是|扮演|代入|进入角色|切换到)[\s　]*(一个|一位|那种|什么)?/,
  },
  {
    name: 'roleplay_en',
    severity: 'medium',
    pattern: /(act\s+as|pretend\s+to\s+be|you\s+are\s+now|roleplay\s+as)\s/i,
  },
  {
    name: 'system_role_claim',
    severity: 'medium',
    pattern: /(\[system\]|<\|system\|>|<\|im_start\|>system|系统消息\s*[:：])/i,
  },
  {
    name: 'repeat_previous',
    severity: 'medium',
    pattern: /(重复|再(说|写)一遍)(上面|之前|上面那|前面那)[\s　]*(的)?[\s　]*(内容|文字|指令|话)/,
  },
];

/**
 * 扫描文本里有没有命中注入规则。
 *
 * 规则正则带 /g 会带状态，每次扫描前重置 lastIndex。
 */
export function scanInjectionRules(text: string): InjectionScanResult {
  const hits: InjectionRuleHit[] = [];

  for (const rule of INJECTION_RULES) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(text)) {
      hits.push({ name: rule.name, severity: rule.severity });
    }
  }

  const maxSeverity = hits.some((h) => h.severity === 'high') ? 'high' : hits.length > 0 ? 'medium' : null;
  return { hits, maxSeverity };
}
