#!/usr/bin/env tsx
/**
 * 验证 system_users 里平台方账号写入正确
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

async function main(): Promise<void> {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST ?? 'localhost',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    database: process.env.MYSQL_DB ?? 'agent_platform',
  });

  const [cols] = await conn.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'system_users'
      ORDER BY ORDINAL_POSITION`,
    [process.env.MYSQL_DB ?? 'agent_platform'],
  );
  console.log('--- system_users 表结构 ---');
  console.table(cols);

  const [rows] = await conn.execute(
    `SELECT id, email, name, role,
            LEFT(password_hash, 7) AS hash_prefix,
            CHAR_LENGTH(password_hash) AS hash_len,
            failed_login_count,
            locked_until,
            last_login_at,
            created_at
       FROM system_users
      WHERE email = ?`,
    ['platform-admin@local.test'],
  );
  console.log('--- 写入的平台方账号 ---');
  console.table(rows);

  await conn.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});