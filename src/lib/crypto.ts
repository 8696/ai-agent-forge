import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config';

/**
 * 租户 LLM 密钥的落库加密 —— docs/12-c §C4 / docs/10-安全方案.md §10.3
 *
 * 为什么必须加密：租户把自己的 apiKey 填进后台后，这把钥匙就能调用他们自己的额度。
 * 明文落库意味着一次 SQL 注入 / 一次备份文件泄露 / 一个能读库的低权限账号，
 * 就等于泄露所有租户的 LLM 凭据。
 *
 * 用 AES-256-GCM 而不是 AES-CTR：GCM 自带 authTag，密文被篡改（改 apiKey、
 * 换租户 id 嫁接）时解密会直接抛错，不会悄悄解出一段垃圾明文。
 *
 * **密钥来自 .env 的 CONFIG_ENCRYPTION_KEY**：
 *  - 没配 = 禁止保存 apiKey（**不是**静默降级成明文）
 *  - 生产环境必须配；配了就**永远别换**，换了对不上的旧密文解不出来
 *  - 换密钥需要一段迁移用旧密钥解开再用新密钥加密，不在本期范围
 */

const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const ALGORITHM = 'aes-256-gcm';

/** 二进制布局的版本号：未来改布局时老密文仍可识别 */
const LAYOUT_VERSION = 1;

/** 有没有配加密密钥。没配就不能保存 apiKey（只读接口仍可正常工作）。 */
export function isSecretEncryptionEnabled(): boolean {
  return config.CONFIG_ENCRYPTION_KEY !== '';
}

/**
 * 把 CONFIG_ENCRYPTION_KEY 派生成 32 字节密钥。
 *
 * 直接 sha256 而不是原样当密钥：运维配的往往是一句人类可读的短语，
 * sha256 把它规整成定长 32 字节（PBKDF2/scrypt 在这里属于过度设计：
 * 这不是从用户口令派生的密钥，是运维配的一次性密钥）。
 */
function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

/** 加密一段明文（apiKey），返回可直接落 BLOB 的 Buffer */
export function encryptSecret(plaintext: string): Buffer {
  const secret = config.CONFIG_ENCRYPTION_KEY;
  if (secret === '') {
    throw new Error(
      'CONFIG_ENCRYPTION_KEY 未配置，拒绝保存 LLM 密钥（配了才能用租户自定义 apiKey）',
    );
  }
  return encryptWith(secret, plaintext);
}

/**
 * 解密。密文被篡改 / 密钥换过 → 抛错（调用方降级成「配置不可用」，
 * 绝不能拿空密钥继续调，那样会以 401 反复重试烧配额）。
 */
export function decryptSecret(payload: Buffer): string {
  const secret = config.CONFIG_ENCRYPTION_KEY;
  if (secret === '') {
    throw new Error('CONFIG_ENCRYPTION_KEY 未配置，无法解密 LLM 密钥');
  }
  return decryptWith(secret, payload);
}

// ============================================================
// 纯函数内核 —— 密钥显式传参
//
// 为什么拆开：config 在模块加载时就 Object.freeze 了，运行时改 process.env
// 对它无效。所以「换一把密钥能不能解开」这类用例没法靠改环境变量来测，
// 只能把密钥做成参数。单测直接测这两个函数，不碰 config。
// ============================================================

export function encryptWith(secret: string, plaintext: string): Buffer {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([LAYOUT_VERSION]), iv, authTag, ciphertext]);
}

export function decryptWith(secret: string, payload: Buffer): string {
  if (payload.length < 1 + IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('密文长度不对，疑似数据损坏');
  }
  const version = payload[0];
  if (version !== LAYOUT_VERSION) {
    throw new Error(`密文格式版本不支持：${String(version)}`);
  }
  const iv = payload.subarray(1, 1 + IV_LENGTH);
  const authTag = payload.subarray(1 + IV_LENGTH, 1 + IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = payload.subarray(1 + IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, deriveKey(secret), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * 生成脱敏提示（唯一允许回显给前端的密钥形态）：`sk-…4f2a`
 *
 * 短于 8 位的不给提示 —— 太短的密钥「前后各露一点」几乎等于全露。
 */
export function secretHint(plaintext: string): string {
  const trimmed = plaintext.trim();
  if (trimmed.length < 8) {
    return '';
  }
  const head = trimmed.slice(0, 4);
  return `${head}…${trimmed.slice(-4)}`;
}