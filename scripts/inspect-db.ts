#!/usr/bin/env tsx
/**
 * 仅用于本次调试：SHOW TABLES + 展示两张表的 DDL
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

  const [tables] = await conn.query('SHOW TABLES');
  console.log('表：', tables);

  for (const table of ['tenants', 'users'] as const) {
    const [cols] = await conn.query(`SHOW FULL COLUMNS FROM \`${table}\``);
    console.log(`\n=== ${table} 列定义 ===`);
    for (const row of cols as Array<Record<string, unknown>>) {
      console.log(
        `  ${String(row['Field'])}  ${String(row['Type'])}  null=${String(row['Null'])}  default=${row['Default'] === null ? '∅' : String(row['Default'])}`,
      );
    }
  }

  await conn.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
