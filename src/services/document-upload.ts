import { promises as fs } from 'node:fs';
import path from 'node:path';
import { nanoid } from 'nanoid';
import { config } from '../config';
import type { DocumentFileType } from '../models';

/**
 * 上传文件落盘 —— 详见 docs/05-b-数据模型-qdrant.md §5.6.6 步骤 [2]
 *
 * 落盘路径：{DATA_DIR}/uploads/{tenant_id}/{nanoid(21)}.{ext}
 *  - 用随机文件名而不是原始文件名：原始名可能重名、可能含路径穿越字符（`../`）、可能超长
 *  - 原始文件名另存到 documents.title，那里才是给人看的
 */

export interface SavedUpload {
  /** 入库用标题（原始文件名，已去掉路径部分） */
  title: string;
  /** 磁盘文件名（随机） */
  storedName: string;
  /** 相对 DATA_DIR 的存储路径，展示用 */
  source: string;
  /** 绝对路径，解析 / 重试索引时读这里 */
  absolutePath: string;
  fileType: DocumentFileType;
  /** 落盘字节数 */
  bytes: number;
}

/** 允许上传的扩展名 → 数据库 file_type */
const EXTENSION_MAP: Record<string, DocumentFileType> = {
  '.pdf': 'pdf',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'txt',
};

export const ACCEPTED_EXTENSIONS = Object.keys(EXTENSION_MAP);

/**
 * 把 koa-body 落到临时目录的文件挪到正式目录。
 *
 * @throws Error 扩展名不支持（调用方转成 400 ValidationError）
 */
export async function saveUpload(params: {
  tmpPath: string;
  originalFilename: string;
  tenantId: string;
}): Promise<SavedUpload> {
  const { tmpPath, originalFilename, tenantId } = params;

  // 客户端可以伪造 filename（"../../etc/passwd"），只取最后一段
  const title = path.basename(originalFilename).trim();
  if (title === '' || title === '.' || title === '..') {
    throw new Error('上传文件名无效');
  }

  const ext = path.extname(title).toLowerCase();
  const fileType = EXTENSION_MAP[ext];
  if (fileType === undefined) {
    throw new Error(
      `不支持的文件类型「${ext || title}」，仅接受：${ACCEPTED_EXTENSIONS.join(' / ')}`,
    );
  }

  // tenantId 来自 JWT 不是用户输入，但仍然过一遍 basename 防止将来有人改成路径参数
  const tenantDir = path.resolve(config.DATA_DIR, 'uploads', path.basename(tenantId));
  await fs.mkdir(tenantDir, { recursive: true });

  const storedName = `${nanoid(21)}${ext}`;
  const absolutePath = path.join(tenantDir, storedName);
  await fs.rename(tmpPath, absolutePath);

  const stat = await fs.stat(absolutePath);
  return {
    title,
    storedName,
    source: path.join('uploads', path.basename(tenantId), storedName),
    absolutePath,
    fileType,
    bytes: stat.size,
  };
}

/** 删磁盘上的原始文件（删除文档 / 清理失败上传时用；文件不存在不算错） */
export async function removeUploadFile(absolutePath: string): Promise<void> {
  await fs.unlink(absolutePath).catch((err: unknown) => {
    const code = (err as { code?: string }).code;
    if (code !== 'ENOENT') {
      throw err;
    }
  });
}

/** koa-body 落 multipart 文件的临时目录 */
export function tmpUploadDir(): string {
  return path.resolve(config.DATA_DIR, 'tmp');
}

/**
 * 删掉 koa-body 落下的临时文件（上传流程抛错时调用）。
 *
 * 逐个字段、逐个文件删：表单里可能有多个文件，正常处理的那个已经被 rename 走了，
 * unlink 会 ENOENT，忽略即可。
 */
export async function removeUploadedTmpFiles(
  files: Record<string, unknown> | undefined,
): Promise<void> {
  if (files === undefined || files === null) {
    return;
  }
  for (const value of Object.values(files)) {
    const list = Array.isArray(value) ? value : [value];
    for (const item of list) {
      const filepath = (item as { filepath?: unknown } | null)?.filepath;
      if (typeof filepath === 'string' && filepath.startsWith(tmpUploadDir())) {
        // 只删自己 tmp 目录下的文件，避免传入的 filepath 被伪造后删到别处
        await fs.unlink(filepath).catch(() => {});
      }
    }
  }
}

/**
 * 清掉 DATA_DIR/tmp 里超过 TTL 的残留文件。
 *
 * 有些失败路径我们兜不住：比如文件超过 maxFileSize，formidable 会在**请求处理器
 * 之前**就中断，处理器里的 catch 根本没机会跑。这个函数由上传路由在每次请求开头调一次
 * （自愈式），保证临时目录不会无限增长。
 */
export async function cleanupStaleTmpFiles(ttlMs = 6 * 60 * 60 * 1000): Promise<number> {
  const dir = tmpUploadDir();
  let removed = 0;
  const entries = await fs.readdir(dir).catch(() => []);
  const now = Date.now();
  for (const name of entries) {
    const full = path.join(dir, name);
    const stat = await fs.stat(full).catch(() => null);
    if (stat === null || !stat.isFile() || now - stat.mtimeMs < ttlMs) {
      continue;
    }
    await fs.unlink(full).then(
      () => {
        removed += 1;
      },
      () => {},
    );
  }
  return removed;
}