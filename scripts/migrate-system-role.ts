#!/usr/bin/env tsx
/**
 * 一次性迁移：system_users.role 从 'super_admin' 改为 'system'
 *
 * 背景：docs/05 的 ENUM 是 ('super_admin')，但用户决定本产品用 'system' 作为角色名
 * （避免「super」这种过度承诺的词，也跟 URL 前缀 /system/ 一致）。
 *
 * 步骤：先扩 ENUM（super_admin + system 并存）→ UPDATE 数据 → 缩 ENUM（只留 system）
 *
 * 已执行过，再次运行幂等（第二次再跑 0 行 affected）
 */
import 'reflect-metadata';
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { config } from '../src/config';
import { getSequelize } from '../src/db';
import { SystemUser } from '../src/models';

async function main(): Promise<void> {
  getSequelize(); // 触发模型注册

  const conn = await mysql.createConnection({
    host: config.MYSQL.HOST,
    port: config.MYSQL.PORT,
    user: config.MYSQL.USER,
    password: config.MYSQL.PASSWORD,
    database: config.MYSQL.DB,
  });

  // 1) 扩 ENUM：super_admin + system 并存
  await conn.query(
    "ALTER TABLE system_users MODIFY COLUMN role ENUM('super_admin','system') NOT NULL DEFAULT 'super_admin' COMMENT '过渡：super_admin / system'",
  );
  console.log("ENUM 已扩成 ENUM('super_admin','system')");

  // 2) 数据迁移
  const [u] = await conn.execute('UPDATE system_users SET role = ? WHERE role = ?', [
    'system',
    'super_admin',
  ]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updated = (u as any).affectedRows ?? 0;
  console.log(`UPDATE 完成：${updated} 行 role 从 super_admin 改成 system`);

  // 3) 缩 ENUM：只留 system
  await conn.query(
    "ALTER TABLE system_users MODIFY COLUMN role ENUM('system') NOT NULL DEFAULT 'system' COMMENT '唯一角色：system'",
  );
  console.log("ENUM 已缩成 ENUM('system')");

  // 4) 验证
  const [rows] = await conn.query('SELECT id, email, role FROM system_users');
  console.log('当前 system_users:', rows);
  await conn.end();

  // 5) 通过模型也验证一下
  const sysUser = await SystemUser.findOne();
  console.log('SystemUser.findOne → role =', sysUser?.role);

  console.log('\n✅ 迁移完成');
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
