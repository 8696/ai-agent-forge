#!/usr/bin/env tsx
/**
 * 仅用于本次调试：用 mysql2 直接连一下本地 MySQL，
 * 看能不能用 .env 里的 MYSQL_PASSWORD 跑通。
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

async function main(): Promise<void> {
  const pwdLen = (process.env.MYSQL_PASSWORD ?? '').length;
  console.log(
    `尝试连接 mysql://${process.env.MYSQL_USER}@${process.env.MYSQL_HOST}:${process.env.MYSQL_PORT}（密码长度 = ${pwdLen}）`,
  );
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST ?? 'localhost',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
    connectTimeout: 5_000,
  });
  const [rows] = await conn.query('SELECT VERSION() AS v, USER() AS u');
  console.log('连接成功：', rows);
  await conn.end();
}

main().catch((err: unknown) => {
  console.error('连接失败：', err instanceof Error ? err.message : err);
  process.exit(1);
});
