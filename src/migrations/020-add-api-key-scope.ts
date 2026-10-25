import { DataTypes, type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { listColumns } from './helpers/schema';

/**
 * 给 api_keys 加 scope 列 —— API Key 权限分级（docs/10-安全方案.md §10 API Key 段）
 *
 * ## 起因
 *
 * 规格里明写着「API Key：每个租户一个，权限按 scope 分（只读 / 写入 / 管理员）」，
 * 但 `api_keys` 表**从来没有 scope 列** —— 一把 key 能调该租户的全部对外端点。
 * 对外的 key 是**发到客户系统里**的（E1 的挂件 / REST API 接入方），
 * 一次泄露就是「整租户的问答能力 + token 花费」全敞。
 *
 * ## 语义
 *
 *  - read  = 只读。只能调只读端点（目前是知识库检索）。
 *           **不能发起对话** —— 不花钱、不留会话记录、不写 messages。
 *  - write = 写入（默认）。只读端点 + 发起对话（POST /chat、/chat/stream）。
 *           **存量 key 全部是这个语义** —— 加列时默认给 write，行为不变。
 *  - admin = 管理员。预留：对外 API 目前没有 admin 专属端点，
 *           等于暂时跟 write 一样，但以后加管理类端点时不用再改表。
 *
 * 包含关系：write ⊇ read，admin ⊇ write。
 *
 * ## 幂等
 *
 *  - 列不存在 → 建
 *  - 列已存在 → 跳过
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const columns = await listColumns(queryInterface, 'api_keys');
  if (columns.has('scope')) {
    return;
  }

  await queryInterface.addColumn('api_keys', 'scope', {
    type: DataTypes.ENUM('read', 'write', 'admin'),
    allowNull: false,
    defaultValue: 'write',
    comment:
      '权限分级：read=只读（不能发起对话） / write=可发起对话（默认，存量 key 都是这个） / admin=管理员（预留）',
  });
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const columns = await listColumns(queryInterface, 'api_keys');
  if (!columns.has('scope')) {
    return;
  }

  // 收窄 ENUM 之前先把用 admin 的行降级 —— 不然 ENUM 收窄会失败
  await queryInterface.sequelize.query(
    "UPDATE api_keys SET scope = 'write' WHERE scope = 'admin'",
  );
  await queryInterface.removeColumn('api_keys', 'scope');
};
