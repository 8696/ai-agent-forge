import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../../config';

/**
 * 公开挂件的「匿名会话凭证」 —— E1（docs/12-e-需求-业务接入与平台运营.md §E1）
 *
 * ======================== 匿名会话怎么归属 ========================
 *
 * 挂件是**免登录**的：访客打开 `/widget/:tenantCode` 就能聊，没有账号、没有邮箱。
 * 那「这段对话属于谁」就得有个约定，否则：
 *   - 换个访客可能读到上一个人的对话
 *   - 关掉浏览器再打开，历史就找不回来了（E1 的验收明确要求「历史还在」）
 *
 * 本项目的方案：**会话 id 本身是主键，但对外暴露的不是裸的会话 id，而是一枚
 * 「签过名的匿名 token」**。token 形如：
 *
 *     w1.<session_id>.<sig>
 *     sig = base64url( HMAC-SHA256( key, "w1:" + session_id ) )
 *     key = sha256( JWT_SECRET + ":widget-session" )
 *
 * 前端把 token 存在 localStorage 里（key = `widget_token:<tenantCode>`），
 * 每次请求放在 `X-Widget-Token` 头里。后端从 token 里解出会话 id，
 * 再按 (id, tenant_id, user_id IS NULL, channel='widget') 查库。
 *
 * 为什么不用「裸会话 id 当凭证」：
 *   裸 id 一旦泄露（出现在 URL 里 → 落到 nginx 访问日志 / Referer 头 / 截图），
 *   任何人都能拿它读走整段对话。签名 token 把「知道 id」和「持有凭证」分成两件事：
 *   泄露 id 本身什么都做不了，必须同时拿到 token。
 *   而 token 只在请求头里走，不会进 URL。
 *
 * 为什么不用「再发一个随机 token 存库、跟 session_id 解耦」：
 *   那需要一张新表或 sessions 上一个新列（visitor_token）——
 *   本期不改表结构（sessions.metadata 是 JSON，但按 metadata 查库没法走索引，
 *   每次请求全表扫 sessions，量大了扛不住）。
 *   签名的会话 id 达到了同等效果：一个不可伪造、不可枚举（session id 本身是 nanoid(21)）、
 *   不需要额外存储的凭证。
 *
 * 已知取舍（写在这里免得以后有人踩）：
 *   - token **不过期**：它的有效期就是会话本身的有效期。
 *     用户清掉 localStorage 就等于放弃这段对话（但库里的消息还在，只是没人认领）。
 *   - 服务端的 JWT_SECRET 一换，所有挂件 token 全部失效（用户要重新开会话）。
 *     这是刻意的：换密钥意味着「怀疑泄露」，让旧凭证失效是想要的行为。
 *   - token 里没有租户信息，但**用不上**：会话查库时强制带 tenant_id 过滤，
 *     A 租户的 token 拿到 B 租户的 URL 上查不到（跨租户天然隔离）。
 */

/** token 版本号：格式变了就换版本，老 token 直接判无效（不用做兼容） */
const TOKEN_VERSION = 'w1';

/** 签名用的密钥：从 JWT_SECRET 派生，避免跟 JWT 本体混用 */
function signingKey(): Buffer {
  return createHash('sha256')
    .update(`${config.JWT_SECRET}:widget-session`, 'utf8')
    .digest();
}

function sign(sessionId: string): string {
  return createHmac('sha256', signingKey())
    .update(`${TOKEN_VERSION}:${sessionId}`, 'utf8')
    .digest('base64url');
}

/**
 * 给一个会话 id 签发匿名 token。
 */
export function signWidgetToken(sessionId: string): string {
  return `${TOKEN_VERSION}.${sessionId}.${sign(sessionId)}`;
}

/**
 * 校验 token，返回它对应的会话 id；无效一律返回 null。
 *
 * 用了 timingSafeEqual 做定长比较 —— 避免「逐字节比对直到不同」的时序侧信道。
 */
export function verifyWidgetToken(token: string): string | null {
  if (typeof token !== 'string' || token === '') {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [version, sessionId, sig] = parts;
  if (version !== TOKEN_VERSION || sessionId === undefined || sig === undefined) {
    return null;
  }
  if (sessionId === '' || sig === '') {
    return null;
  }
  const expected = Buffer.from(sign(sessionId), 'utf8');
  const actual = Buffer.from(sig, 'utf8');
  if (expected.length !== actual.length) {
    return null;
  }
  if (!timingSafeEqual(expected, actual)) {
    return null;
  }
  return sessionId;
}
