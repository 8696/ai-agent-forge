import type { CitationHit } from '../../types/chat';

/**
 * 检索片段 → 带编号的资料段 —— B1 检索增强（docs/12-b §B1 / §B2）
 *
 * 纯函数：编号规则在这里是**唯一真相源**，同时供
 *  - system prompt 里的 `[n]` 标注
 *  - 发给前端的 `data-citations` data part
 * 使用。两边只要走这个函数，编号就一定对得上。
 */

/** 渲染资料段需要的最小输入（不依赖 RAG 模块的具体类型，纯数据） */
export interface RenderableHit {
  doc_id: string;
  chunk_index: number;
  source: string;
  text: string;
  score: number;
  sources: string[];
}

/** 发给前端的片段正文上限：500 字符够「查看原文」用，也省带宽 */
export const CITATION_TEXT_LIMIT = 500;

export interface RagContextResult {
  /** 拼给模型的资料段正文 */
  text: string;
  /** 同编号的引用列表，直接作为 data-citations 的 hits 发出去 */
  hits: CitationHit[];
}

/**
 * 把检索命中渲染成资料段，并分配 1-based 连续编号。
 *
 * 入参必须是**已经过 token 预算裁剪**的片段（见 src/lib/token-estimate.ts 的 fitHitsToBudget）：
 * 被裁掉的片段不占编号，所以编号天然连续无洞。
 */
export function renderRagContext(hits: readonly RenderableHit[], emptyNotice: string): RagContextResult {
  if (hits.length === 0) {
    return { text: `\n## 可参考资料\n${emptyNotice}\n`, hits: [] };
  }

  const cited: CitationHit[] = [];
  const blocks = hits.map((h, i) => {
    const index = i + 1;
    const text = h.text.slice(0, CITATION_TEXT_LIMIT);
    cited.push({
      index,
      doc_id: h.doc_id,
      chunk_index: h.chunk_index,
      source: h.source,
      score: Number(h.score.toFixed(4)),
      text,
      sources: h.sources,
    });
    return `[${index}] 来源：${h.source}（第 ${h.chunk_index + 1} 段）\n${text}`;
  });

  return { text: `\n## 可参考资料\n${blocks.join('\n\n---\n\n')}\n`, hits: cited };
}