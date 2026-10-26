import { QueryTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { listTables, listTableCharsets } from './helpers/schema';

/**
 * 显式规范所有表的字符集 / 排序规则 / 引擎
 *
 * ## 为什么需要这个迁移
 *
 * 12-a §A1 承诺「MySQL 8.0（InnoDB 引擎、utf8mb4 字符集）」，
 * 但**这个承诺以前是靠环境碰巧对**成立的：
 *
 * - `src/db.ts` 里的 `define: { charset: 'utf8mb4' }` 只对 `Model.sync()` 生效，
 *   而全仓**从不调用 sync**（建表走 umzug 迁移）；
 * - 迁移文件本身**不指定** charset / engine；
 * - 所以建出来的表实际继承的是 **MySQL 服务器 / 数据库的默认配置**。
 *
 * docker-compose 里写了 `--character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci`，
 * 所以按文档起的环境是对的 —— 但**换个方式建的库**（本地手搓的、云厂商自建的、
 * 用别的 compose 文件起的）就可能默认成 `utf8mb3` / `latin1`，
 * 届时中文的租户名 / 用户昵称会**静默存成问号**，而且没有任何报错。
 *
 * ## 这个迁移做什么
 *
 * 1. 把**数据库**的默认字符集改成 utf8mb4（以后新建的表自动继承对的）
 * 2. 把**每张已有表** CONVERT TO utf8mb4 + utf8mb4_unicode_ci
 * 3. 把每张表的引擎统一成 InnoDB
 *
 * 幂等：已经是目标字符集 + InnoDB 的表会跳过（不重复重建表）。
 * ⚠️ CONVERT TO CHARACTER SET 会**重建表**，大表上会锁一会儿 ——
 *    这是「一次性把历史数据也转过来」的代价，不转的话旧行仍然是坏的编码。
 */
const CHARSET = 'utf8mb4';
const COLLATION = 'utf8mb4_unicode_ci';
const ENGINE = 'InnoDB';

export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const sequelize = queryInterface.sequelize;

  // ---- 1. 数据库默认字符集（以后新建的表自动继承）----
  const [dbRow] = await sequelize.query<{ db: string | null }>(
    'SELECT DATABASE() AS db',
    { type: QueryTypes.SELECT },
  );
  const db = dbRow?.db ?? null;
  if (db === null || db === '') {
    // 连了但没选库 —— 没法改库级默认，跳过（表级转换还是要做）
  } else {
    await sequelize.query(
      `ALTER DATABASE \`${db.replace(/`/g, '``')}\` ` +
        `CHARACTER SET ${CHARSET} COLLATE ${COLLATION}`,
    );
  }

  // ---- 2. 每张表：字符集 + 引擎 ----
  const tables = await listTables(queryInterface);
  const charsets = await listTableCharsets(queryInterface);

  for (const table of tables) {
    const current = charsets.get(table);
    const charsetOk = current?.collation?.startsWith(`${CHARSET}_`) === true;
    const engineOk = current?.engine?.toUpperCase() === ENGINE;
    if (charsetOk && engineOk) {
      continue;
    }
    await sequelize.query(
      `ALTER TABLE \`${table.replace(/`/g, '``')}\` ` +
        `CONVERT TO CHARACTER SET ${CHARSET} COLLATE ${COLLATION}, ENGINE=${ENGINE}`,
    );
  }
};

/**
 * 回滚做不了 —— 字符集转换是**有损方向不可逆**的：
 * 已经转成 utf8mb4 的数据没法「转回」utf8mb3（utf8mb4 是超集，
 * 反向转换对多字节字符是破坏性的）。
 *
 * 真要回退只能重建库。这里显式留一个空实现，让 `yarn migrate:undo` 不会炸。
 */
export const down: MigrationFn<QueryInterface> = async () => {
  // noop —— 见上方说明
};
