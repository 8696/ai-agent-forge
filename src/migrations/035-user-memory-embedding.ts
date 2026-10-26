import { type QueryInterface } from 'sequelize';
import type { MigrationFn } from 'umzug';
import { listColumns } from './helpers/schema';

/**
 * `user_memories` 加两列 —— 记忆的向量召回（迁移 035）
 *
 * ## 为什么加
 *
 * B4 的「记忆检索」那一项一直挂着（docs/07-c 模块 10 · docs/12-b §B4）：
 * 注入哪几条记忆是**固定顺序**（用户写的 > 管理员写的 > 自动抽的，
 * 同档按置信度、再按更新时间），不是「跟当前问题相关不相关」。
 *
 * 后果很具体：用户攒了 50 条记忆时，本轮问「报销流程」，
 * 排在前面的是**刚写的那条**「我喜欢简洁的回答」，
 * 真正相关的「发票抬头是 XX 公司」排在第 20 位，topK=8 根本轮不到它。
 *
 * 加了这两列就能按余弦相似度排序。
 *
 * ## 为什么是这两列
 *
 *   embedding        JSON NULL    记忆正文的向量（**归一化后**存 → 余弦 = 点积）
 *   embedding_model  VARCHAR(64)  生成它的 embedding 模型名
 *
 * ⚠️ **`embedding_model` 不是冗余字段**：
 *    换 embedding 模型后旧向量作废 —— 两套模型的向量混在一起算相似度没有意义。
 *    读的时候模型名对不上就当「没有向量」，重新算。
 *
 * ⚠️ **为什么存在这张表上，而不是另起一张向量表 / 放 Qdrant**：
 *   - `user_memories` 有 tenant_id 列 → Sequelize 的租户作用域钩子自动补过滤，
 *     **向量存在这一行里就自动继承了租户隔离**（A1 的运行时强制）。
 *     放 Qdrant 得重新手写一遍租户过滤 —— 那等于给自己开一个跨租户的口子。
 *   - 单个用户最多 50 条自动记忆 + 手写的那几条，几百条向量在 DB 里算余弦是毫秒级，
 *     用不上 ANN 索引，也不用多维护一个 collection。
 *   - 换 embedding 模型时只要重算这一列，不用重建 collection。
 *
 * ## ⚠️ 部署顺序
 *
 * **最好先跑这个迁移，再上新代码。**
 *
 * 但**代码先上线也不会挂**：启动时会探一次这两列在不在（见
 * `src/services/memory-relevance.ts` 的 `probeUserMemoryEmbeddingColumns`），
 * 不在就把这两列**从模型里摘掉**（`Model.removeAttribute`），
 * 之后所有对 user_memories 的查询退回老行为（固定顺序的记忆排序），不会挂。
 *
 * ⚠️ **摘列是关键** —— 只改 WHERE 没用（列清单来自模型定义）。
 */
export const up: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  const cols = await listColumns(queryInterface, 'user_memories');

  if (!cols.has('embedding')) {
    await queryInterface.sequelize.query(
      'ALTER TABLE user_memories ADD COLUMN embedding JSON NULL ' +
        "COMMENT '记忆正文的向量（归一化后的 float 数组）—— 用于按当前问题做相关性排序；NULL = 还没算'",
    );
  }

  if (!cols.has('embedding_model')) {
    await queryInterface.sequelize.query(
      'ALTER TABLE user_memories ADD COLUMN embedding_model VARCHAR(64) NULL ' +
        "COMMENT '生成 embedding 的模型名 —— 换 embedding 模型后据此判定旧向量作废'",
    );
  }
};

export const down: MigrationFn<QueryInterface> = async ({ context: queryInterface }) => {
  await queryInterface.sequelize.query('ALTER TABLE user_memories DROP COLUMN embedding_model');
  await queryInterface.sequelize.query('ALTER TABLE user_memories DROP COLUMN embedding');
};
