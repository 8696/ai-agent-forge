import { describe, it, expect } from 'vitest';
import {
  maskPii,
  maskPiiText,
  looksLikeBankCard,
  luhnValid,
  MASK_PLACEHOLDER,
} from '../../src/lib/security/mask';

/**
 * 敏感数据脱敏（src/lib/security/mask.ts）—— 纯函数，不碰网络
 *
 * D4 的验收原话：「我的身份证是 110101199001011234」→「写入 messages 时变 ***」
 *
 * 这里锁住几条最容易在重构时悄悄坏掉的语义：
 *  1. 身份证 / 银行卡 / 手机号都要被换掉
 *  2. **长数字串里不该出现手机号**（订单号 16 位不是手机号，别乱抹）
 *  3. 卡号要过 Luhn / 前缀校验 —— 否则随机长数字会被当成卡号抹掉
 *  4. 脱敏是幂等的：已经变成 *** 的文本再脱敏一次不能变化
 */

describe('maskPii · 身份证', () => {
  it('18 位身份证被换成占位符', () => {
    const r = maskPii('我的身份证是 110101199001011234');
    expect(r.text).toBe(`我的身份证是 ${MASK_PLACEHOLDER}`);
    expect(r.hits).toHaveLength(1);
    expect(r.hits[0]?.type).toBe('id_card');
  });

  it('末位是 X 的身份证也能识别', () => {
    const r = maskPii('身份证 11010119900101123X');
    expect(r.text).not.toContain('11010119900101123X');
    expect(r.hits[0]?.type).toBe('id_card');
  });

  it('15 位老身份证也能识别', () => {
    const r = maskPii('老身份证 110101900101123');
    expect(r.text).not.toContain('110101900101123');
    expect(r.hits[0]?.type).toBe('id_card');
  });

  it('17 位（少一位）不当作身份证', () => {
    const r = maskPii('编号 11010119900101123');
    expect(r.hits).toHaveLength(0);
  });

  it('命中信息里只记长度，不记内容', () => {
    const r = maskPii('110101199001011234');
    expect(r.hits[0]).toEqual({ type: 'id_card', masked: MASK_PLACEHOLDER, length: 18 });
    expect(JSON.stringify(r.hits)).not.toContain('110101');
  });
});

describe('maskPii · 银行卡', () => {
  it('银联卡号被换掉', () => {
    const r = maskPii('卡号 6222021234567890123');
    expect(r.text).toBe(`卡号 ${MASK_PLACEHOLDER}`);
    expect(r.hits[0]?.type).toBe('bank_card');
  });

  it('Luhn 通过的 Visa 卡号被换掉', () => {
    // 4111111111111111 —— 教科书里的测试卡号，Luhn 有效
    expect(luhnValid('4111111111111111')).toBe(true);
    const r = maskPii('card 4111111111111111');
    expect(r.text).not.toContain('4111111111111111');
  });

  it('Luhn 不过 + 前缀不对的 16 位数字**不**被当成卡号', () => {
    // 1234567890123456：Luhn 失败（和是 64），前缀 12 也不是卡号 BIN
    expect(luhnValid('1234567890123456')).toBe(false);
    expect(looksLikeBankCard('1234567890123456')).toBe(false);
    const r = maskPii('订单号 1234567890123456');
    expect(r.text).toContain('1234567890123456');
  });

  it('短数字串（12 位）不当作卡号', () => {
    expect(looksLikeBankCard('123456789012')).toBe(false);
    const r = maskPii('编号 123456789012');
    expect(r.hits).toHaveLength(0);
  });
});

describe('maskPii · 手机号', () => {
  it('11 位手机号被换掉', () => {
    const r = maskPii('我的手机号是 13800138000');
    expect(r.text).toBe(`我的手机号是 ${MASK_PLACEHOLDER}`);
    expect(r.hits[0]?.type).toBe('phone');
  });

  it('嵌在更长数字串里的 11 位不被单独抹掉', () => {
    const r = maskPii('订单号 138001380001234');
    expect(r.hits).toHaveLength(0);
  });

  it('不是 1 开头的 11 位数字不是手机号', () => {
    const r = maskPii('工号 23800138000');
    expect(r.hits).toHaveLength(0);
  });
});

describe('maskPii · 整体行为', () => {
  it('正常文本一个字都不改', () => {
    const text = '请问公司的年假制度是怎样的？';
    const r = maskPii(text);
    expect(r.text).toBe(text);
    expect(r.hits).toHaveLength(0);
  });

  it('一段话里的多种敏感信息都会被换掉', () => {
    const r = maskPii('身份证 110101199001011234，手机 13800138000，卡号 6222021234567890123');
    expect(r.text).not.toContain('110101199001011234');
    expect(r.text).not.toContain('13800138000');
    expect(r.text).not.toContain('6222021234567890123');
    expect(r.hits).toHaveLength(3);
  });

  it('幂等：脱敏后再脱敏结果不变', () => {
    const once = maskPiiText('身份证 110101199001011234');
    expect(maskPiiText(once)).toBe(once);
  });

  it('空串安全', () => {
    expect(maskPii('')).toEqual({ text: '', hits: [] });
  });
});
