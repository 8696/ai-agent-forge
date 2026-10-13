#!/usr/bin/env tsx
/**
 * 仅用于本次调试：建 agent_platform 库（IF NOT EXISTS）。
 */
import 'dotenv/config';
import mysql from 'mysql2/promise';

async function main(): Promise<void> {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST ?? 'localhost',
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? 'root',
    password: process.env.MYSQL_PASSWORD ?? '',
  });
  const db = process.env.MYSQL_DB ?? 'agent_platform';
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${db}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  const [rows] = await conn.query(`SHOW DATABASES LIKE '${db.replace(/'/g, "''")}'`);
  console.log(`CREATE 完，结果：`, rows);
  await conn.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
