#!/usr/bin/env tsx
/**
 * 一次性：插第一个 system_user（docs/05 §5.1 备注里说手工建）
 * 不幂等；重复跑会因为 email UNIQUE 报错，但报错可读就说明已存在
 */
import 'dotenv/config';
import bcrypt from 'bcrypt';
import { nanoid } from 'nanoid';
import { config } from '../src/config';
import mysql from 'mysql2/promise';

async function main(): Promise<void> {
  const conn = await mysql.createConnection({
    host: config.MYSQL.HOST,
    port: config.MYSQL.PORT,
    user: config.MYSQL.USER,
    password: config.MYSQL.PASSWORD,
    database: config.MYSQL.DB,
  });

  const email = 'platform-admin@local.test';
  const password = 'platform-admin-pw-123';
  const id = nanoid(21);
  const hash = await bcrypt.hash(password, 12);

  try {
    await conn.execute(
      `INSERT INTO system_users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, 'system')`,
      [id, email, hash, '平台初始 admin'],
    );
    console.log(`✅ 已插入 system_users：email=${email} password=${password} id=${id}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Duplicate')) {
      console.log(`ℹ️  system_users.${email} 已存在，跳过`);
    } else {
      throw e;
    }
  }
  await conn.end();
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
