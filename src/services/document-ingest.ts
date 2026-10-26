import { Document, type DocumentFileType } from '../models';
import { logger } from '../logger';
import { writeAuditLog } from '../lib/audit-log';
import { ValidationError } from '../lib/errors';
import { removeUploadFile, saveUpload } from './document-upload';
import { extractText } from './document-parse';
import { ingestDocument } from '../rag/ingest';
import { bm25RemoveDoc } from '../rag/bm25';
import { deleteDocumentPoints } from '../rag/qdrant';

/**
 * 文档入库 / 删除的**共享实现**
 *
 * 两处调用方：
 *   - admin 后台：src/gateway/admin/knowledge-routes.ts（登录用户传 id）
 *   - 对外 API 的 admin 档：src/gateway/public/admin-api-routes.ts（API Key，没有登录用户）
 *
 * ⚠️ **为什么要抽出来**：两条路要做的事完全一样（落盘 → 建行 → 拆块 → 向量化 → 记审计），
 *    抄一份的话两边迟早长歪 —— 同一个坑（比如「建行失败要回收文件」）要修两次。
 *    这里抽一份，两边共用，行为必然一致。
 *
 * 跨租户：所有查询 / 写入都带 actor.tenantId；调用方拿到的 tenantId 必须已经是校验过的
 *        （admin 路由来自 JWT，public 路由来自 API Key 鉴权结果）。
 */

/** 触发这次操作的人 / 系统 */
export interface DocumentActor {
  /** 所属租户 —— 文档挂在这个租户名下 */
  tenantId: string;
  /**
   * 触发者用户 id。
   * admin 后台 = 登录用户 id；对外 API（API Key）**没有登录用户** → null。
   */
  uploadedBy: string | null;
  /** 来源：admin 后台 / api（对外 API Key） */
  via: 'admin' | 'api';
  /** 对外 API 时记下是哪把钥匙触发的（审计用） */
  apiKeyId?: string | undefined;
}

/** koa-body 解析出来的上传文件（只用到这两个字段） */
export interface UploadedFileLike {
  filepath: string;
  originalFilename?: string;
}

/**
 * 上传 → 落盘 → 建行 → 同步索引。
 *
 * @throws ValidationError 文件名非法 / 扩展名不支持（400）
 */
export async function ingestUpload(params: {
  actor: DocumentActor;
  file: UploadedFileLike;
  ip?: string | undefined;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const { actor } = params;
  const originalFilename = params.file.originalFilename ?? '';
  if (originalFilename.trim() === '') {
    throw new ValidationError('缺少原始文件名');
  }

  let saved: Awaited<ReturnType<typeof saveUpload>>;
  try {
    saved = await saveUpload({
      tmpPath: params.file.filepath,
      originalFilename,
      tenantId: actor.tenantId,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    // 类型不支持是用户能自己解决的问题 → 400；磁盘写失败是服务端问题 → 原样抛
    if (message.includes('不支持的文件类型') || message.includes('文件名无效')) {
      throw new ValidationError(message);
    }
    throw err;
  }

  let doc: Document;
  try {
    doc = await Document.create({
      tenant_id: actor.tenantId,
      title: saved.title,
      source: saved.source,
      file_type: saved.fileType,
      file_path: saved.absolutePath,
      status: 'indexing',
      uploaded_by: actor.uploadedBy,
      metadata: {
        bytes: saved.bytes,
        // 对外 API 传进来的文档留个来源标记 —— 后台列表上能看出「这份是 API 同步来的」
        ...(actor.via === 'api' ? { via: 'api_key', api_key_id: actor.apiKeyId ?? null } : {}),
      },
    });
  } catch (err: unknown) {
    // 文件已经从 tmp rename 到正式目录了，但 DB 里没有对应行 → 管理员在 UI 上
    // 永远看不到也删不掉它。建行失败就把文件收回去，避免留下无主文件。
    await removeUploadFile(saved.absolutePath).catch(() => {});
    throw err;
  }

  await writeAuditLog({
    tenant_id: actor.tenantId,
    user_id: actor.uploadedBy,
    action: 'DOCUMENT_UPLOAD',
    resource_type: 'document',
    resource_id: doc.id,
    details: {
      title: saved.title,
      file_type: saved.fileType,
      bytes: saved.bytes,
      via: actor.via,
      ...(actor.apiKeyId !== undefined ? { api_key_id: actor.apiKeyId } : {}),
    },
    ip: params.ip ?? null,
  });

  return indexDocument(doc, actor, params.ip);
}

/**
 * 解析 → 拆块 → 向量化 → 入库，并回填 documents 状态。
 *
 * 索引失败**不抛 5xx**：文件已经落地、DB 行已经建好，调用方拿得到 id 去展示「失败」状态，
 * 可以改完重试或直接删掉。抛 5xx 的话调用方只能显示「上传失败」，反而丢掉了已创建的记录。
 */
export async function indexDocument(
  doc: Document,
  actor: DocumentActor,
  ip?: string | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const parsed = await extractText(doc.file_path as string, doc.file_type as DocumentFileType);
    const result = await ingestDocument({
      documentId: doc.id,
      tenantId: actor.tenantId,
      title: doc.title,
      text: parsed.text,
    });

    await doc.update({
      status: 'ready',
      chunk_count: result.chunkCount,
      error_message: null,
      metadata: { ...(doc.metadata ?? {}), pages: parsed.pages },
    });

    return {
      status: 201,
      body: {
        id: doc.id,
        title: doc.title,
        file_type: doc.file_type,
        status: 'ready',
        chunk_count: result.chunkCount,
        pages: parsed.pages,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const brief = message.slice(0, 500);

    await doc
      .update({ status: 'failed', chunk_count: 0, error_message: brief })
      .catch((updateErr: unknown) => {
        logger.error({ docId: doc.id, err: updateErr }, '回填索引失败状态出错');
      });

    await writeAuditLog({
      tenant_id: actor.tenantId,
      user_id: actor.uploadedBy,
      action: 'DOCUMENT_INDEX_FAILED',
      resource_type: 'document',
      resource_id: doc.id,
      details: { title: doc.title, error: brief },
      ip: ip ?? null,
    });

    return {
      status: 200,
      body: {
        id: doc.id,
        title: doc.title,
        file_type: doc.file_type,
        status: 'failed',
        chunk_count: 0,
        error: brief,
      },
    };
  }
}

/**
 * 删文档：Qdrant points + BM25 索引 + 磁盘文件 + DB 行。
 *
 * **向量 / 索引先删，DB 行最后删**：中途失败时 DB 里还留着记录，
 * 调用方能看到并重试，不会出现「DB 没记录但向量还在被检索命中」的幽灵数据。
 *
 * @returns 清理失败项（文件 / 向量清理失败要告诉调用方，但 DB 行已经删了、重试也没法重来，
 *          所以要明确提示「需要人工清理」，而不是假装成功）
 */
export async function removeDocument(doc: Document, tenantId: string): Promise<string[]> {
  const failures: string[] = [];

  await deleteDocumentPoints(doc.id).catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`qdrant:${message}`);
    logger.error({ docId: doc.id, err: message }, '删 Qdrant points 失败');
  });

  try {
    bm25RemoveDoc(tenantId, doc.id);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    failures.push(`bm25:${message}`);
    logger.error({ docId: doc.id, err: message }, '删 BM25 索引失败');
  }

  if (doc.file_path !== null) {
    await removeUploadFile(doc.file_path).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`file:${message}`);
      logger.error({ docId: doc.id, err: message }, '删磁盘文件失败');
    });
  }

  await doc.destroy();

  return failures;
}
