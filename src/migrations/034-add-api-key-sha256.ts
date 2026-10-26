import { QueryTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';

/**
 * api_keys 加一列 `key_sha256` —— 确定性哈希定位（补 12-e §E1「已知边界」那条）
 *
 * ## 为什么加
 *
 * 原来鉴权是「prefix 粗筛 + bcrypt 逐个比对」：
 *   - key_prefix 只存前 8 位（"ak_" + 5 位随机 ≈ 30 bit）
 *   - api_keys 上只有复合索引 (tenant_id, key_prefix)，
 *     **单独按 prefix 查走不了索引 → 每次鉴权都全表扫**，key 一多就慢。
 *
 * 12-e §E1「已知边界」里点名的正解就是「加一列 sha256 确定性哈希」——
 * 这一列就是那个东西。
 *
 * ## 这一列干什么（**不是**用来当凭证的）
 *
 *   key_sha256 = sha256(完整 key) 的 hex（64 位）
 *
 * 凭证判定**仍然是 bcrypt**。这一列只负责**定位**：
 *   - 快路径：sha256 精确命中 → 走唯一索引，O(log n)，只对 1 行跑 bcrypt
 *   - 慢路径（仅存量 key）：`key_sha256 IS NULL` 且前缀匹配
 *     → 索引区间只扫「还没回填的存量行」，不是全表
 *   - 存量 key **第一次鉴权成功时回填** sha256 → 下次就走快路径（自愈）
 *
 * ⚠️ 为什么存 sha256 不算泄密：
 *    key 是 nanoid(32)（约 190 bit 熵），不是人选的口令，sha256 不可逆推 ——
 *    GitHub / Stripe 等都是这么存 API token 的。
 *    就算数据库被拖库，攻击者拿到 sha256 还得过 bcrypt 这一关。
 *
 * ## 索引
 *
 *   idx_api_keys_sha256 UNIQUE (key_sha256)
 *   - UNIQUE：sha256 天然唯一；MySQL 的唯一索引**允许多个 NULL**，
 *     所以存量行不回填也不冲突、不受影响
 *   - 慢路径的 `key_sha256 IS NULL` 也能用这个索引做区间扫描（存量行本来就少）
 *
 * ## ⚠️ 部署顺序
 *
 * **最好先跑这个迁移，再上新代码** —— 跑完之后鉴权走的是「sha256 索引点查」，
 * 又快又准。
 *
 * 但**代码先上线也不会挂**：新代码启动时会探一次这列在不在，
 * 不在就把这一列**从模型里摘掉**（`Model.removeAttribute`），
 * 之后所有对 api_keys 的查询都退回老行为（前缀粗筛 + bcrypt）——
 * 只是慢一点（走全表扫）。
 *
 * ⚠️ **为什么必须摘列、而不是只改 WHERE**：
 *    Sequelize 的 SELECT 列清单来自**模型定义**，不是查询里写了什么。
 *    列不存在时，**任何**对 api_keys 的查询都会报
 *    `Unknown column 'key_sha256' in 'field list'` ——
 *    不只是鉴权那一条（后台的密钥列表 / 改权限 / 撤销同样会挂）。
 *
 * 降级行为的端到端验证：`node scripts/check-api-key-degradation.mjs`
 * （在一个 scratch 库里制造「代码新、schema 旧」的状态逐条验）。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const sequelize = queryInterface.sequelize;

  const [cols] = await sequelize.query<{ COLUMN_NAME: string }>(
    'SELECT COLUMN_NAME FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: ['api_keys', 'key_sha256'], type: QueryTypes.SELECT },
  );
  if (!Array.isArray(cols) || cols.length === 0) {
    await sequelize.query(
      'ALTER TABLE api_keys ADD COLUMN key_sha256 CHAR(64) NULL ' +
        "COMMENT '完整 key 的 sha256（十六进制）—— 只用于索引定位，凭证判定仍是 bcrypt；存量行为 NULL'",
    );
  }

  const [idx] = await sequelize.query<{ INDEX_NAME: string }>(
    'SELECT INDEX_NAME FROM information_schema.STATISTICS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    { replacements: ['api_keys', 'idx_api_keys_sha256'], type: QueryTypes.SELECT },
  );
  if (!Array.isArray(idx) || idx.length === 0) {
    await sequelize.query('CREATE UNIQUE INDEX idx_api_keys_sha256 ON api_keys (key_sha256)');
  }

  // scope 列的注释还写着「admin=预留」—— 那一档现在有真端点了（知识库管理），
  // 顺手把注释改对，免得以后看 schema 的人被误导。
  const [scopeCols] = await sequelize.query<{ COLUMN_COMMENT: string }>(
    'SELECT COLUMN_COMMENT FROM information_schema.COLUMNS ' +
      'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    { replacements: ['api_keys', 'scope'], type: QueryTypes.SELECT },
  );
  const currentComment =
    Array.isArray(scopeCols) && scopeCols.length > 0 ? scopeCols[0].COLUMN_COMMENT : '';
  if (!currentComment.includes('知识库管理')) {
    await sequelize.query(
      "ALTER TABLE api_keys MODIFY COLUMN scope ENUM('read','write','admin') NOT NULL DEFAULT 'write' " +
        "COMMENT '权限分级：read=只读（不能发起对话）/ write=可发起对话（默认） / " +
        "admin=知识库管理（可上传 / 删除本租户文档）'",
    );
  }
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.query('DROP INDEX idx_api_keys_sha256 ON api_keys');
  await queryInterface.sequelize.query('ALTER TABLE api_keys DROP COLUMN key_sha256');
};
