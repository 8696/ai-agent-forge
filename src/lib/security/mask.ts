/**
 * 敏感数据脱敏 —— docs/10-安全方案.md §10.3 / docs/12-d-需求-运维稳定.md §D4
 *
 * 目标：**写进 messages 表之前**把身份证 / 银行卡 / 手机号换成 `***`，
 * 让这些号码不落到对话历史、结构化日志和审计详情里。
 *
 * 三类各一套正则，按「长 → 短」顺序替换：
 *   身份证（18 / 15 位）→ 银行卡（13~19 位）→ 手机号（11 位）
 *
 * 顺序不能换：银行卡的正则 `\d{13,19}` 会命中 18 位身份证，
 * 先替换身份证，后面就不会把身份证当成卡号。
 *
 * 边界用 `(?<!\d)` / `(?!\d)` 而不是 `\b`：
 * `\b` 判的是「左右是不是单词字符」，中文跟数字混排时边界位置经常判错；
 * 断言只看数字，语义明确，也不会把长数字串的一部分误当成一个号。
 *
 * ⚠️ 银行卡额外过一道 Luhn 校验 + 卡号前缀白名单：
 *    否则一串 16 位随机数字（订单号、工号拼接）会被当成卡号抹掉。
 */

export type PiiType = 'id_card' | 'bank_card' | 'phone';

export interface PiiHit {
  type: PiiType;
  /** 脱敏后的占位符（命中内容本身不外传，避免二次泄漏） */
  masked: string;
  /** 命中处的原始长度（只记长度，不记内容） */
  length: number;
}

export interface MaskResult {
  /** 脱敏后的文本 */
  text: string;
  /** 命中明细（按出现顺序） */
  hits: PiiHit[];
}

/** 统一的脱敏占位符 */
export const MASK_PLACEHOLDER = '***';

/** 18 位身份证（含末位 X） */
const ID_CARD_18 = /(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9Xx])/g;

/**
 * 15 位身份证（老版，无校验码，年份只有两位）
 *
 * ⚠️ 年份必须写成**两位**（`\d{2}`）而不是 18 位那版的四位（`(?:19|20)\d{2}`）：
 *    写成四位的话这个正则实际吃 17 位，会把「少一位的 18 位身份证」也误判成身份证。
 */
const ID_CARD_15 = /(?<!\d)\d{6}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}(?!\d)/g;

/** 银行卡候选：13~19 位连续数字 */
const BANK_CARD = /(?<!\d)\d{13,19}(?!\d)/g;

/** 中国大陆手机号 */
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g;

/** 卡号前缀（用来兜住「用户打错了一位」的真实卡号——Luhn 会挂但前缀对） */
const BANK_CARD_PREFIX = /^(?:62|4|5[1-5]|3[47]|35|36|30|38|39|6011|65)/;

/** Luhn 校验（银行卡标准校验位算法） */
export function luhnValid(digits: string): boolean {
  if (digits.length === 0 || !/^\d+$/.test(digits)) {
    return false;
  }
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) {
        d -= 9;
      }
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** 是不是一张像样的卡号：长度对 + （Luhn 过 或 卡号前缀对） */
export function looksLikeBankCard(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }
  return luhnValid(digits) || BANK_CARD_PREFIX.test(digits);
}

/**
 * 替换一轮：正则命中的部分，符合条件的换成占位符，其余原样保留。
 */
function replacePass(
  text: string,
  pattern: RegExp,
  type: PiiType,
  hits: PiiHit[],
  accept: (matched: string) => boolean,
): string {
  // 正则带 /g 是有状态的，每次用之前重置 lastIndex
  pattern.lastIndex = 0;
  return text.replace(pattern, (matched: string) => {
    if (!accept(matched)) {
      return matched;
    }
    hits.push({ type, masked: MASK_PLACEHOLDER, length: matched.length });
    return MASK_PLACEHOLDER;
  });
}

/**
 * 对一段文本做脱敏。
 *
 * 用法：**在写库之前**调用，返回的 `text` 才是允许落库 / 送进模型的版本。
 */
export function maskPii(text: string): MaskResult {
  const hits: PiiHit[] = [];
  let out = text;

  out = replacePass(out, ID_CARD_18, 'id_card', hits, () => true);
  out = replacePass(out, ID_CARD_15, 'id_card', hits, () => true);
  out = replacePass(out, BANK_CARD, 'bank_card', hits, looksLikeBankCard);
  out = replacePass(out, PHONE, 'phone', hits, () => true);

  return { text: out, hits };
}

/** 只要脱敏后的文本（不需要明细时用这个） */
export function maskPiiText(text: string): string {
  return maskPii(text).text;
}
