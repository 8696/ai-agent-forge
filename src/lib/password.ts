import bcrypt from 'bcrypt';

/**
 * bcrypt 密码哈希 / 校验，cost=12（与 docs/12-a §A2 / §A3 一致）
 * - hashPassword：明文 → hash
 * - verifyPassword：明文 vs hash
 */

const COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
