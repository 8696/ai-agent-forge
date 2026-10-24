import { describe, it, expect } from 'vitest';
import { signWidgetToken, verifyWidgetToken } from '../../src/gateway/public/widget-token';

/**
 * 公开挂件的匿名会话 token —— E1
 *
 * 覆盖三件最容易出事的事：
 *  1. 签发 / 校验闭环：签出来的 token 能解回会话 id
 *  2. **篡改即失效**：改了会话 id 或改了签名，都必须判无效
 *     （这就是「不用裸会话 id 当凭证」的全部意义）
 *  3. 格式不对的输入（空串 / 少段 / 版本不对）一律判无效，不能抛异常
 */
describe('widget-token · 匿名会话凭证', () => {
  const SID = 'V1StGXR8_Z5jdHi6B-myT';

  it('签发 → 校验 → 拿回同一个会话 id', () => {
    const token = signWidgetToken(SID);
    expect(verifyWidgetToken(token)).toBe(SID);
  });

  it('token 是三段式：版本.会话 id.签名', () => {
    const token = signWidgetToken(SID);
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('w1');
    expect(parts[1]).toBe(SID);
    expect(parts[2]).not.toBe('');
  });

  it('会话 id 一改，签名就对不上 → 判无效', () => {
    const token = signWidgetToken(SID);
    const parts = token.split('.');
    const forged = `${parts[0]}.${'V1StGXR8_Z5jdHi6B-myX'}.${parts[2]}`;
    expect(verifyWidgetToken(forged)).toBeNull();
  });

  it('签名一改 → 判无效', () => {
    const token = signWidgetToken(SID);
    const parts = token.split('.');
    const forged = `${parts[0]}.${parts[1]}.${parts[2]?.slice(0, -1)}x`;
    expect(verifyWidgetToken(forged)).toBeNull();
  });

  it('版本号不对 → 判无效（格式升级时老 token 直接作废）', () => {
    const token = signWidgetToken(SID);
    const parts = token.split('.');
    expect(verifyWidgetToken(`w0.${parts[1]}.${parts[2]}`)).toBeNull();
  });

  it('空串 / 残缺 / 多余段 → 判无效，不抛异常', () => {
    expect(verifyWidgetToken('')).toBeNull();
    expect(verifyWidgetToken('w1')).toBeNull();
    expect(verifyWidgetToken('w1.abc')).toBeNull();
    expect(verifyWidgetToken('w1..sig')).toBeNull();
    expect(verifyWidgetToken('a.b.c.d')).toBeNull();
    expect(verifyWidgetToken('not-a-token')).toBeNull();
  });

  it('不同会话 id 签出不同的 token', () => {
    expect(signWidgetToken('a')).not.toBe(signWidgetToken('b'));
  });

  it('同一个会话 id 签出同一个 token（刷新页面不用换 token）', () => {
    expect(signWidgetToken(SID)).toBe(signWidgetToken(SID));
  });
});
