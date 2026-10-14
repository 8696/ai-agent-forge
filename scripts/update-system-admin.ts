#!/usr/bin/env tsx
/**
 * 一次性：把已存在的 platform-admin 改 email + 重置密码
 * 用 UPDATE 而非 DELETE+INSERT，保留原 id
 */
import 'dotenv/config';
import bcrypt from 'bcrypt';
import mysql from 'mysql2/promise';

const OLD_EMAIL = 'platform-admin@local.test';
const NEW_EMAIL = 'saas-admin@local.test';
const NEW_PASSWORD = 'Pass123..,';

async function main(): Promise<void> {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST ?? 'localhost',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DB ?? 'agent_platform',
  });

  const hash = await bcrypt.hash(NEW_PASSWORD, 12);

  const [result] = await conn.execute(
    `UPDATE system_users
        SET email = ?, password_hash = ?, updated_at = CURRENT_TIMESTAMP(6)
      WHERE email = ?`,
    [NEW_EMAIL, hash, OLD_EMAIL],
  );
  // @ts-expect-error mysql2 typing
  const affected = result.affectedRows;

  if (affected === 0) {
    console.log(`❌ 没找到 email=${OLD_EMAIL} 的行，未更新`);
    process.exit(2);
  }

  const [rows] = await conn.execute(
    `SELECT id, email, name, role,
            LEFT(password_hash, 7) AS hash_prefix,
            CHAR_LENGTH(password_hash) AS hash_len,
            failed_login_count, locked_until, last_login_at,
            created_at, updated_at
       FROM system_users WHERE email = ?`,
    [NEW_EMAIL],
  );
  console.log(`✅ 已更新 ${affected} 行`);
  console.log('--- 修改后的平台方账号 ---');
  console.table(rows);

  await conn.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});