import { promises as fs } from 'fs';
import path from 'path';
import { nanoid } from 'nanoid';
import { config } from '../config';

/**
 * 上传文件落盘 —— 详见 docs/16-c §C1 + docs/13-d §13.9
 *
 * 目录：./data/uploads/{tenant_id}/{nanoid}.{ext}
 *   - 同一租户下的所有上传集中在一个目录（按 tenant_id 物理隔离，便于审计 / 备份）
 *   - 文件名一律 nanoid（不存原始名，防乱码 / 路径注入 / 重复）
 *   - 原始文件名写 documents.title，扩展名只用来挑 file_type
 */

export interface SaveUploadParams {
  /** 原文件路径（koa-body 在 multipart 处理后给的临时路径） */
  tmpPath: string;
  /** 原始文件名（用于 title + file_type 推断） */
  originalFilename: string;
  /** 所属租户（路径隔离） */
  tenantId: string;
}

export interface SaveUploadResult {
  /** 数据库存的 source 字段值（tenant-relative 路径） */
  storedName: string;
  /** 绝对路径，写入 documents.file_path */
  absolutePath: string;
  /** 推断的文件类型 */
  fileType: 'pdf' | 'markdown' | 'txt';
  /** 标题 = 原始文件名（去掉扩展名） */
  title: string;
}

export async function saveUpload(params: SaveUploadParams): Promise<SaveUploadResult> {
  const ext = path.extname(params.originalFilename).toLowerCase();
  const fileType = detectFileType(ext);
  if (fileType === null) {
    throw new Error(`不支持的文件类型：${ext || '(无扩展名)'}`);
  }

  const storedName = `${nanoid(21)}${ext}`;
  const absDir = path.resolve(config.DATA_DIR, 'uploads', params.tenantId);
  await fs.mkdir(absDir, { recursive: true });
  const absPath = path.join(absDir, storedName);

  // koa-body 给的 file.filepath 是临时路径；rename 到最终目录
  await fs.rename(params.tmpPath, absPath).catch(async (e: unknown) => {
    // fallback：跨盘 / EXDEV 时 rename 失败，改成 copy + unlink
    if ((e as NodeJS.ErrnoException).code === 'EXDEV') {
      await fs.copyFile(params.tmpPath, absPath);
      await fs.unlink(params.tmpPath);
    } else {
      throw e;
    }
  });

  return {
    storedName,
    absolutePath: absPath,
    fileType,
    title: path.basename(params.originalFilename, ext),
  };
}

export function detectFileType(ext: string): 'pdf' | 'markdown' | 'txt' | null {
  if (ext === '.pdf') return 'pdf';
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (ext === '.txt') return 'txt';
  return null;
}