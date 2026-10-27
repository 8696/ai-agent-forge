import { config } from '../config';
import { normalizeWhitespace } from './normalize';
import { buildPlainElements } from './elements/plaintext';
import type { DocElement, DocElementType, ElementDoc } from './elements/types';

/**
 * 文档拆块 —— 详见 docs/05-b-数据模型-qdrant.md §5.6
 *
 * ## 为什么按「字符数」而不是 token 数切
 *  - 中文 1 字 ≈ 1~2 token，英文 1 词 ≈ 1~2 token，字符数对两者都够用且可预测
 *  - 引入 tiktoken / 某种 tokenizer 会把「换 provider 要重算历史文档的块」变成常态问题
 *  - 实际影响精度的因素是「有没有在语义边界断开」和「overlap 够不够」，不是精确 token 计数
 *
 * ## 切分策略（2026-10-27 改版：结构感知）
 *
 * 旧版是「拍平成字符 → 按 800 字滑窗 → 尽量切在段落/句子边界」，
 * 问题是**标题、列表、代码块、表格这些「本来属于一块」的东西会被从中间劈开**。
 *
 * 新版改成三层：
 *   1. **元素层**（src/rag/elements/）：先按格式把文档解析成带类型的元素序列
 *      （Markdown 走 AST，PDF 按页 + 段，TXT 按段）—— 结构在这一层被保住
 *   2. **按标题分节**：标题开启一个新节，**块不跨节**
 *   3. **节内按元素聚合成块**：装不下才切单个元素，且按元素类型分别切
 *      （表格按行 + 重复表头 / 代码按行 / 段落按句）
 *
 * 每块开头拼上**标题路径面包屑**（如 `产品手册 > 退款政策`）——
 * 这样即使一节被切成 5 块，每块都知道自己在文档的哪个位置（检索和模型都受益）。
 */

export interface Chunk {
  /** 块在文档内的序号，0-based */
  index: number;
  text: string;
  /**
   * **正文部分**（不含面包屑和重叠区）在归一化全文中的字符区间。
   *
   * ⚠️ 块的完整文本 = 面包屑 + 重叠区 + 正文，前两段**不在原文里**，
   *    所以这个区间对应的是「正文的出处」，不是「整块文本的出处」。
   *    人工编辑之后它更是**仅供参考**（编辑后的文字不再对应原文）。
   */
  charStart: number;
  charEnd: number;
  /** 该块所属的标题层级路径（面包屑），没有标题时为空数组 */
  headingPath: string[];
  /** 该块由哪些类型的元素拼成（调试 / 统计用） */
  elementTypes: DocElementType[];
  /**
   * 该块是**本节**的第几块（1 起）—— 一节被切成 N 块时用得上。
   *
   * ⚠️ 它的用处是「让模型知道这块是长章节的中间部分」：
   *    同一节的 N 块内容互相独立、面包屑一模一样，光看文本分不出先后。
   */
  sectionChunkIndex: number;
  /** 本节一共切成了几块 */
  sectionChunkTotal: number;
}

export interface SplitOptions {
  /** 单块字符上限（**含**面包屑），默认 config.CHUNK_SIZE */
  size?: number;
  /** 相邻块的重叠字符数，默认 config.CHUNK_OVERLAP */
  overlap?: number;
  /** 面包屑的最外层（如文档标题），会拼在标题路径前面 */
  root?: string[];
}

/** 元素之间的分隔符（也是「元素边界」的标记） */
const SEP = '\n\n';
const SEP_LEN = 2;

/**
 * 面包屑最多占块长的多少。
 *
 * 面包屑是要**进块文本**的（进向量、进引用卡片），不能无限长 ——
 * 它的长度直接吃掉正文预算。这里限死在 1/3，剩下的给正文。
 */
const BREADCRUMB_SHARE = 1 / 3;

/**
 * 哪些元素类型可以当「重叠区」被带到下一块。
 *
 * - 段落 / 列表项 / 纯文本：带得走（整块带走，或按句子边界切尾巴）
 * - 表格：走 `carryTableTail` —— **带表头 + 尾部行**
 * - 代码：走 `carryCodeTail` —— **带尾部行**
 *
 * ⚠️ **2026-10-27 改**：以前表格和代码**完全不带**重叠区（理由是「碎片没意义」）。
 *    但那等于「凡是以表格 / 代码结尾的块，后面的块跟它零重叠」——
 *    而表格 / 代码后面紧跟着的往往正是解释性正文（「上表说明了…」），
 *    恰恰是最需要上下文的地方。
 *
 *    改法不是「把碎表格切两半」（那还是碎片），而是**带上一块的整个尾部元素**
 *    （表格带表头 + 尾行，代码带尾行）—— 元素边界天然对齐，不产生碎片。
 */
const CARRY_FRIENDLY_TYPES: ReadonlySet<DocElementType> = new Set(['paragraph', 'list', 'text']);

/** 面包屑最长保留多少字符（超了从**前面**截，保留最具体的层级） */
const MAX_BREADCRUMB_LEN = 200;
/** 单元（打包的最小单位） */
interface Unit {
  text: string;
  type: DocElementType;
  /** 来自一个完整元素（没被内部再切）→ 可以作为重叠区携带 */
  charStart: number;
  charEnd: number;
}

/** 切片的产物（元素内部的某一段） */
interface Piece {
  text: string;
  charStart: number;
  charEnd: number;
}

/** 句子（带偏移量） */
interface Sentence {
  text: string;
  start: number;
  end: number;
}

/**
 * 拆块主入口（元素路径）—— 切块器的正式入口
 *
 * @param doc 元素序列（由 buildElements 产出）
 */
export function splitByElements(doc: ElementDoc, options: SplitOptions = {}): Chunk[] {
  const size = options.size ?? config.CHUNK_SIZE;
  const overlap = options.overlap ?? config.CHUNK_OVERLAP;
  if (size <= 0) {
    throw new Error(`拆块 size 必须为正数，收到 ${size}`);
  }
  const root = options.root ?? [];

  const chunks = packSections(groupBySection(doc.elements), { size, overlap, root });
  if (chunks.length > 0) {
    return chunks;
  }

  // 全文只有标题没有正文（比如一份目录）→ 退成「按段落切纯文本」，
  // 宁可切得糙也不能一份文档切出 0 块（那会让索引直接失败）
  const fallback = packSections(groupBySection(doc.elements, { keepHeadings: true }), {
    size,
    overlap,
    root,
  });
  return fallback;
}

/**
 * 兼容入口：纯文本 → 元素 → 切块
 *
 * 旧调用方（和「结构解析失败」的兜底路径）走这里。
 */
export function splitByChunk(rawText: string, options: SplitOptions = {}): Chunk[] {
  return splitByElements(buildPlainElements(rawText), options);
}

/**
 * 一条人工编辑 —— 重新索引时靠它把编辑搬回新切出来的块。
 */
export interface PreservedEdit {
  /** 编辑前这块在归一化原文里的区间（闭开区间 [start, end)） */
  sourceCharStart: number;
  sourceCharEnd: number;
  /** 编辑后的完整块文本（面包屑 + 正文） */
  text: string;
}

export interface PreservedResult {
  chunks: Chunk[];
  /** 有多少条人工编辑**没能**搬回来（切法变了 → 对不上） */
  unmatched: number;
}

/**
 * 重新索引时把人工编辑搬回新切出来的块。
 *
 * ## 怎么对回去 —— 按**源区间重叠度**配对
 *
 *   - 旧的人工编辑块覆盖 [start, end)
 *   - 新切出来的块也覆盖 [start, end)
 *   - 交集长度 / 旧块长度 ≥ 0.5 → 认为是同一段
 *
 * ⚠️ **为什么用重叠度而不是 chunk_index 对齐**：重新索引可能换了切法
 * （改了 CHUNK_SIZE、改了标题识别规则），块的序号会整体漂移 —— 按序号对齐
 * 会把编辑搬到**完全不相干的一段文字**上，那比丢掉更糟。
 *
 * ⚠️ **一对一**：一个旧编辑块最多认领一个新块，一个新块最多被一个旧编辑块认领
 * （贪心：重叠度高的先配）。切法变了之后，旧块常常横跨新块的两三段 ——
 *    这时只搬走最像的那一段，剩下的报告出来，不硬塞。
 *
 * ⚠️ **搬回来的文本整体替换**（含面包屑）—— 用户编辑时看到的就是这个整体。
 *    章节归属变了的话，面包屑会略微过时；宁可跟用户看到的一致，也不要拼出一个
 *    用户从没见过的文本。
 */
export function applyPreservedEdits(chunks: Chunk[], edits: PreservedEdit[]): PreservedResult {
  if (edits.length === 0) {
    return { chunks, unmatched: 0 };
  }

  /** 交集长度（两个闭开区间的重叠部分） */
  const overlap = (aStart: number, aEnd: number, bStart: number, bEnd: number): number => {
    const start = Math.max(aStart, bStart);
    const end = Math.min(aEnd, bEnd);
    return Math.max(0, end - start);
  };

  /**
   * 重叠率 = 交集长度 / max(旧块长度, 新块长度)
   *
   * ⚠️ **分母取大的那个** —— 只看「旧块有没有落进新块」是不够的：
   *    旧块 [0,100) 整个落进新块 [0,1000) 里，但如果分母取小的那个，比例是 100%
   *    —— 直接把编辑搬过去会把新块多出的那 900 字**抹掉**。
   *    取大的那个 → 100/1000 = 10% → 不搬，正确。
   */
  const ratio = (edit: PreservedEdit, chunk: Chunk): number => {
    const oldLen = edit.sourceCharEnd - edit.sourceCharStart;
    const newLen = chunk.charEnd - chunk.charStart;
    if (oldLen <= 0 || newLen <= 0) {
      return 0;
    }
    const common = Math.max(oldLen, newLen);
    return overlap(edit.sourceCharStart, edit.sourceCharEnd, chunk.charStart, chunk.charEnd) / common;
  };

  const THRESHOLD = 0.5;

  // 候选对（重叠率 ≥ 阈值），按重叠率降序贪心配对
  const candidates: Array<{ editIndex: number; chunkIndex: number; ratio: number }> = [];
  for (let e = 0; e < edits.length; e += 1) {
    const edit = edits[e];
    if (edit === undefined) {
      continue;
    }
    for (let c = 0; c < chunks.length; c += 1) {
      const chunk = chunks[c];
      if (chunk === undefined) {
        continue;
      }
      const r = ratio(edit, chunk);
      if (r >= THRESHOLD) {
        candidates.push({ editIndex: e, chunkIndex: c, ratio: r });
      }
    }
  }
  candidates.sort((a, b) => b.ratio - a.ratio);

  const usedEdits = new Set<number>();
  const usedChunks = new Set<number>();
  /** editIndex → chunkIndex（贪心配对的结果） */
  const pairing = new Map<number, number>();
  for (const cand of candidates) {
    if (usedEdits.has(cand.editIndex) || usedChunks.has(cand.chunkIndex)) {
      continue;
    }
    usedEdits.add(cand.editIndex);
    usedChunks.add(cand.chunkIndex);
    pairing.set(cand.editIndex, cand.chunkIndex);
  }

  // 搬回去
  const next = chunks.map((chunk) => ({ ...chunk }));
  for (const [editIndex, chunkIndex] of pairing) {
    const edit = edits[editIndex];
    const target = next[chunkIndex];
    if (edit === undefined || target === undefined) {
      continue;
    }
    target.text = edit.text;
  }

  return { chunks: next, unmatched: edits.length - pairing.size };
}

// ===== 分节 =====

interface Section {
  /** 标题路径（不含 root） */
  path: string[];
  elements: DocElement[];
}

/**
 * 按标题分节。
 *
 * 标题元素**不进内容** —— 它以「面包屑」的形式出现在块首（见 buildBreadcrumb），
 * 否则同一串标题会同时出现在面包屑和正文里（重复的噪声 token）。
 */
function groupBySection(
  elements: DocElement[],
  options: { keepHeadings?: boolean } = {},
): Section[] {
  const sections: Section[] = [];
  let current: Section | null = null;

  for (const element of elements) {
    if (element.type === 'heading' && !options.keepHeadings) {
      current = { path: [...element.headingPath], elements: [] };
      sections.push(current);
      continue;
    }
    if (current === null) {
      current = { path: [], elements: [] };
      sections.push(current);
    }
    current.elements.push(element);
  }

  return sections;
}

// ===== 面包屑 =====

/** 拼面包屑：`[root..., path...]` → `A > B > C` */
function buildBreadcrumb(root: string[], path: string[], limit: number): string {
  const parts = [...root, ...path].map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length === 0) {
    return '';
  }
  const joined = parts.join(' > ');
  if (joined.length <= limit) {
    return joined;
  }
  // 超长 → 保留最内层的层级（最具体的信息比最外层的有用）
  const kept: string[] = [];
  let length = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i] as string;
    if (length + part.length > limit) {
      break;
    }
    kept.unshift(part);
    length += part.length + 3;
  }
  return kept.length > 0 ? kept.join(' > ') : (parts[parts.length - 1] as string);
}

// ===== 打包 =====

interface PackContext {
  size: number;
  overlap: number;
  root: string[];
}

/**
 * 把若干分节打成块。
 *
 * 单节内的打包过程：
 *   1. 面包屑占掉一部分预算，剩下的给正文
 *   2. 元素逐个往当前块里塞，塞不下就换块（换块时带上上一块的尾巴当上下文）
 *   3. 单个元素本身就超预算 → 先在元素内部切开（按类型分别切），再逐片打包
 */
function packSections(sections: Section[], ctx: PackContext): Chunk[] {
  const chunks: Chunk[] = [];

  for (const section of sections) {
    // 本节产出的块在 chunks 里的起点 —— 结束后回填「第 i/N 块」
    const sectionStart = chunks.length;
    // 面包屑最多占块长的 1/3（再长就把正文挤没了）
    const breadcrumbLimit = Math.min(MAX_BREADCRUMB_LEN, Math.floor(ctx.size * BREADCRUMB_SHARE));
    const breadcrumb = buildBreadcrumb(ctx.root, section.path, breadcrumbLimit);
    const breadcrumbCost = breadcrumb === '' ? 0 : breadcrumb.length + SEP_LEN;

    // 给重叠区预留空间：单元按「最坏情况下的正文预算」切，保证任何时候都放得下
    const carryLimit = Math.min(ctx.overlap, Math.floor(ctx.size / 4));
    const carryReserve = carryLimit + SEP_LEN;

    /**
     * 只有「这一节要切成多块」时才需要给重叠区留位置。
     * 整节能塞进一块的话（最常见的情况）就把预算全用上，别浪费 1/4。
     */
    const sectionLen = section.elements.reduce((sum, el) => sum + el.text.length + SEP_LEN, 0);
    const singleChunk = sectionLen + breadcrumbCost <= ctx.size;
    const unitBudget = singleChunk
      ? Math.max(ctx.size - breadcrumbCost, 1)
      : Math.max(ctx.size - breadcrumbCost - carryReserve, 1);

    const units = expandUnits(section.elements, unitBudget, ctx.overlap);

    let buf: Unit[] = [];
    let bufLen = 0;
    /** 下一块要带的上下文（上一块的尾巴） */
    let carry = '';
    let carryLen = 0;
    // 正文预算 = 块长 - 面包屑 - 重叠区（下限 1 → 保证块长永远不超 size）
    let contentBudget = Math.max(ctx.size - breadcrumbCost - carryLen, 1);

    const emit = (): void => {
      if (buf.length === 0) {
        return;
      }
      const content = buf.map((unit) => unit.text).join(SEP);
      const first = buf[0] as Unit;
      const last = buf[buf.length - 1] as Unit;
      const parts = [breadcrumb, carry, content].filter((part) => part !== '');
      chunks.push({
        index: chunks.length,
        text: parts.join(SEP),
        charStart: first.charStart,
        charEnd: last.charEnd,
        headingPath: [...section.path],
        elementTypes: buf.map((unit) => unit.type),
        // 事后按「本节切成了几块」回填
        sectionChunkIndex: 0,
        sectionChunkTotal: 0,
      });
      // 为下一块准备重叠区
      carry = computeCarry(buf, carryLimit);
      carryLen = carry === '' ? 0 : carry.length + SEP_LEN;
      buf = [];
      bufLen = 0;
      contentBudget = Math.max(ctx.size - breadcrumbCost - carryLen, 1);
    };

    for (const unit of units) {
      const cost = unit.text.length + SEP_LEN;
      if (bufLen + cost <= contentBudget) {
        buf.push(unit);
        bufLen += cost;
        continue;
      }
      // 装不下 → 先把当前块发出去
      emit();
      if (bufLen + cost <= contentBudget) {
        buf.push(unit);
        bufLen += cost;
        continue;
      }
      // 还是装不下（单元本身超预算）→ 这个单元自己成一块
      buf = [unit];
      bufLen = unit.text.length;
      emit();
    }
    emit();

    // 回填「第 i/N 块」—— 同一节的块内容互相独立，靠这个才知道先后
    const sectionCount = chunks.length - sectionStart;
    for (let i = sectionStart; i < chunks.length; i += 1) {
      const c = chunks[i];
      if (c !== undefined) {
        c.sectionChunkIndex = i - sectionStart + 1;
        c.sectionChunkTotal = sectionCount;
      }
    }
  }

  return chunks;
}

/**
 * 计算下一块要带的重叠区。
 *
 * **按元素携带，不按字符切碎片** —— 这是 2026-10-27 改版的关键之一：
 * 旧版是把上一块的尾巴按字符截断，下一块开头就是一个半句话。
 * 现在：
 *   1. 尾部元素整块放得下 → 整块带走（元素边界天然对齐）
 *   2. 尾部元素太长放不下 → 只带它的**句子对齐**的尾巴（不会从半句话开始）
 *   3. 尾部是表格 → 带「表头 + 尾部行」（跟切表格时一个待遇）
 *   4. 尾部是代码 → 带「尾部行」（不带函数头 —— 头在上一块里已经有了）
 */
function computeCarry(units: Unit[], limit: number): string {
  if (limit <= 0 || units.length === 0) {
    return '';
  }
  const last = units[units.length - 1] as Unit;
  if (last.type === 'table') {
    return carryTableTail(last.text, limit);
  }
  if (last.type === 'code') {
    /**
     * 代码：**整体带走（带得下才带）**。
     *
     * ⚠️ **不带半截** —— 半截代码 + 一个开着的围栏，模型看到的是坏代码，
     *    比不带更糟。所以要么整个代码块带走，要么不带。
     */
    return last.text.length <= limit ? last.text : '';
  }
  if (!CARRY_FRIENDLY_TYPES.has(last.type)) {
    return '';
  }
  if (last.text.length <= limit) {
    // 整块带走（能多带一个就多带一个）
    const carried: string[] = [];
    let length = 0;
    for (let i = units.length - 1; i >= 0; i--) {
      const unit = units[i] as Unit;
      if (!CARRY_FRIENDLY_TYPES.has(unit.type)) {
        break;
      }
      if (length + unit.text.length + SEP_LEN > limit) {
        break;
      }
      carried.unshift(unit.text);
      length += unit.text.length + SEP_LEN;
    }
    return carried.join(SEP);
  }
  // 元素太长 → 带它的句子对齐尾巴
  return carryTail(last.text, limit);
}

/**
 * 表格的尾巴 —— **表头 + 尾部若干行**。
 *
 * 没有表头的尾行模型读不懂（「张三 | 200 | 已退款」是什么？）。
 * 跟 `splitTable` 一个待遇：每一片都重复表头。
 */
function carryTableTail(text: string, limit: number): string {
  const lines = splitLines(text);
  if (lines.length < 3) {
    return '';
  }
  const header = lines[0] as LineSpan;
  const separator = lines[1] as LineSpan;
  const headLen = header.text.length + separator.text.length + 2;
  // 表头都放不下 → 宁可不带（带一个残缺的表头更糟）
  if (headLen >= limit) {
    return '';
  }
  const carried: string[] = [];
  let length = headLen;
  for (let i = lines.length - 1; i >= 2; i -= 1) {
    const row = lines[i] as LineSpan;
    if (length + row.text.length + 1 > limit) {
      break;
    }
    carried.unshift(row.text);
    length += row.text.length + 1;
  }
  if (carried.length === 0) {
    return '';
  }
  return [header.text, separator.text, ...carried].join('\n');
}

/**
 * 代码的**整体**重叠区 —— 见 `computeCarry` 里 code 分支的说明。
 *
 * 代码块被切成多片时，每一片都是**闭合的完整代码块**（见 `splitCode`），
 * 所以整体带走是安全的 —— 不会出现「开着的围栏」。
 */

/** 取一段文本的尾巴，并回退到句子边界（下一块不会从半句话开始） */
function carryTail(text: string, limit: number): string {
  const tail = text.slice(-limit);
  const start = findSentenceStart(tail);
  return start >= 0 ? tail.slice(start) : tail;
}

/** 在尾巴里找「句子从这里开始」的位置 */
function findSentenceStart(tail: string): number {
  const match = /[。！？；…!?;]|\.\s|\n/.exec(tail);
  return match ? match.index + match[0].length : -1;
}

// ===== 元素展开 =====

/**
 * 把元素展开成「单元」—— 超预算的元素在内部切开。
 *
 * 切法按元素类型分：
 *   - 表格 → 按行切，每片**重复表头**（否则后半截的表没有列名，读不懂）
 *   - 代码 → 按行切（代码重复粘贴比缺上下文更糟，所以代码不重叠）
 *   - 列表 → 按行切（列表项本身已经是独立元素了）
 *   - 段落 → 按句切（保证不切半句）
 */
function expandUnits(elements: DocElement[], budget: number, overlap: number): Unit[] {
  const units: Unit[] = [];
  for (const element of elements) {
    if (element.text.length <= budget) {
      units.push({
        text: element.text,
        type: element.type,
        charStart: element.charStart,
        charEnd: element.charEnd,
      });
      continue;
    }
    for (const piece of splitOversized(element, budget, overlap)) {
      units.push({
        text: piece.text,
        type: element.type,
        charStart: piece.charStart,
        charEnd: piece.charEnd,
      });
    }
  }
  return units;
}

function splitOversized(element: DocElement, budget: number, overlap: number): Piece[] {
  switch (element.type) {
    case 'table':
      return splitTable(element, budget);
    case 'code':
      return splitCode(element, budget);
    case 'list':
      return splitByLines(element, budget);
    default:
      return splitBySentences(element, budget, overlap);
  }
}

/**
 * 代码按行切 —— **每一片都是闭合的完整代码块**。
 *
 * ## 为什么每片都要带围栏
 *
 * 代码块的文本形如：
 * ```
 * ```ts
 * const a = 1;
 * ```
 * ```
 * 按行裸切的话，围栏只在第一片（开头）和最后一片（结尾）——
 * 中间那几片就是**开着的围栏**，模型看到的是坏代码，
 * 而且「这段是什么语言」也丢了（一段 Python 和一段 JSON 在向量里长得一样）。
 *
 * 所以每一片都补上：**首行围栏（带语言标记）+ 本片的行 + 收尾围栏**。
 */
function splitCode(element: DocElement, budget: number): Piece[] {
  const lines = splitLines(element.text);
  const fenceLine = lines[0];
  const closingLine = lines[lines.length - 1];
  // 不是标准围栏结构（少于 3 行 / 首尾不是围栏）→ 退成按行切
  if (lines.length < 3 || fenceLine === undefined || closingLine === undefined) {
    return splitByLines(element, budget);
  }
  const fence = fenceLine.text;
  const closing = closingLine.text;
  const body = lines.slice(1, lines.length - 1);
  // 围栏本身也要算进预算（每片都得带上）
  const overhead = fence.length + 1 + closing.length + 1;
  const bodyBudget = Math.max(1, budget - overhead);

  const pieces: Piece[] = [];
  let buf: LineSpan[] = [];
  let bufLen = 0;

  const flush = (): void => {
    if (buf.length === 0) {
      return;
    }
    const first = buf[0] as LineSpan;
    const last = buf[buf.length - 1] as LineSpan;
    pieces.push({
      text: [fence, ...buf.map((line) => line.text), closing].join('\n'),
      charStart: element.charStart + first.start,
      charEnd: element.charStart + last.end,
    });
    buf = [];
    bufLen = 0;
  };

  for (const line of body) {
    if (line.text.length > bodyBudget) {
      // 单行就超预算 → 硬切（每一片照样补上围栏）
      flush();
      for (const cut of hardCut(line.text, bodyBudget, element.charStart + line.start)) {
        pieces.push({
          text: [fence, cut.text, closing].join('\n'),
          charStart: cut.charStart,
          charEnd: cut.charEnd,
        });
      }
      continue;
    }
    if (bufLen + line.text.length + 1 > bodyBudget) {
      flush();
    }
    buf.push(line);
    bufLen += line.text.length + 1;
  }
  flush();

  return pieces;
}

// ===== 元素内部切分 =====

/** 带偏移量的行 */
interface LineSpan {
  text: string;
  start: number;
  end: number;
}

/** 按行切分并记录每行在原文中的区间 */
function splitLines(text: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push({ text: text.slice(start, i), start, end: i });
      start = i + 1;
    }
  }
  if (start < text.length) {
    lines.push({ text: text.slice(start), start, end: text.length });
  }
  return lines;
}

/** 按行打包（代码块 / 列表） */
function splitByLines(element: DocElement, budget: number): Piece[] {
  const lines = splitLines(element.text);
  const pieces: Piece[] = [];
  let buf: LineSpan[] = [];
  let bufLen = 0;

  const flush = (): void => {
    if (buf.length === 0) {
      return;
    }
    const first = buf[0] as LineSpan;
    const last = buf[buf.length - 1] as LineSpan;
    pieces.push({
      text: buf.map((line) => line.text).join('\n'),
      charStart: element.charStart + first.start,
      charEnd: element.charStart + last.end,
    });
    buf = [];
    bufLen = 0;
  };

  for (const line of lines) {
    if (line.text.length > budget) {
      flush();
      pieces.push(...hardCut(line.text, budget, element.charStart + line.start));
      continue;
    }
    if (bufLen + line.text.length + 1 > budget) {
      flush();
    }
    buf.push(line);
    bufLen += line.text.length + 1;
  }
  flush();
  return pieces;
}

/**
 * 表格按行切 —— **每片都带上表头**。
 *
 * 没有表头的表格后半截，模型看到的是一堆没有列名的值（「张三 | 200 | 已退款」）。
 */
function splitTable(element: DocElement, budget: number): Piece[] {
  const lines = splitLines(element.text);
  if (lines.length < 3) {
    // 不是标准管道表（少于表头 + 分隔行 + 一行数据）→ 退成按行切
    return splitByLines(element, budget);
  }
  const header = lines[0] as LineSpan;
  const separator = lines[1] as LineSpan;
  const rows = lines.slice(2);
  const headLen = header.text.length + separator.text.length + 2;

  const pieces: Piece[] = [];
  let buf: LineSpan[] = [];
  let bufLen = headLen;

  const flush = (): void => {
    if (buf.length === 0) {
      return;
    }
    const first = buf[0] as LineSpan;
    const last = buf[buf.length - 1] as LineSpan;
    pieces.push({
      text: [header.text, separator.text, ...buf.map((line) => line.text)].join('\n'),
      charStart: element.charStart + Math.min(first.start, header.start),
      charEnd: element.charStart + last.end,
    });
    buf = [];
    bufLen = headLen;
  };

  for (const row of rows) {
    if (row.text.length + headLen > budget) {
      // 单行就超预算 → 硬切（表头跟着第一片）
      flush();
      pieces.push(...hardCut(row.text, budget, element.charStart + row.start));
      continue;
    }
    if (bufLen + row.text.length + 1 > budget) {
      flush();
    }
    buf.push(row);
    bufLen += row.text.length + 1;
  }
  flush();
  return pieces;
}

/**
 * 句子切分 —— 保证不切半句。
 *
 * 句末标点：中文 `。！？；…`、英文 `!?;`、英文句号（后面必须是空白或结尾）。
 * 换行也算句边界（列表项、诗行、表格行都是一行一个语义单元）。
 */
function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  let start = 0;

  const isTerminator = (ch: string): boolean => '。！？；…!?;'.includes(ch);
  /** 跟在句末标点后面的收尾符号，要算进这一句 */
  const isClosing = (ch: string): boolean => '"\'”’）)」』】》'.includes(ch);

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    let end = -1;
    if (isTerminator(ch)) {
      end = i + 1;
    } else if (ch === '.') {
      // 英文句号：后面是空白或结尾才算（"3.5" 不是句号）
      if (i + 1 >= text.length || /\s/.test(text[i + 1] as string)) {
        end = i + 1;
      }
    } else if (ch === '\n') {
      end = i + 1;
    }
    if (end < 0) {
      continue;
    }
    while (end < text.length && isClosing(text[end] as string)) {
      end += 1;
    }
    const piece = text.slice(start, end);
    if (piece.trim() !== '') {
      sentences.push({ text: piece, start, end });
    }
    start = end;
    i = end - 1;
  }

  if (start < text.length) {
    const piece = text.slice(start);
    if (piece.trim() !== '') {
      sentences.push({ text: piece, start, end: text.length });
    }
  }
  return sentences;
}

/** 按句打包（段落 / 纯文本） */
function splitBySentences(element: DocElement, budget: number, overlap: number): Piece[] {
  const sentences = splitSentences(element.text);
  const pieces: Piece[] = [];
  let buf: Sentence[] = [];
  let bufLen = 0;

  const flush = (): void => {
    if (buf.length === 0) {
      return;
    }
    const first = buf[0] as Sentence;
    const last = buf[buf.length - 1] as Sentence;
    pieces.push({
      text: buf.map((sentence) => sentence.text).join(''),
      charStart: element.charStart + first.start,
      charEnd: element.charStart + last.end,
    });
    buf = [];
    bufLen = 0;
  };

  for (const sentence of sentences) {
    if (sentence.text.length > budget) {
      // 单句就超预算 → 硬切（没有句边界可用）
      flush();
      pieces.push(...hardCut(sentence.text, budget, element.charStart + sentence.start, overlap));
      continue;
    }
    if (bufLen + sentence.text.length > budget) {
      flush();
    }
    buf.push(sentence);
    bufLen += sentence.text.length;
  }
  flush();
  return pieces;
}

/**
 * 硬切 —— 最后手段：单句/单行本身就超预算时的兜底。
 *
 * 句子被硬切意味着「不切半句」这个保证在这条路径上失效了，
 * 但它只在「一个句子超过整块预算」时发生（正常文档里几乎不会有）。
 */
function hardCut(
  text: string,
  budget: number,
  base: number,
  overlap: number = 0,
): Piece[] {
  const pieces: Piece[] = [];
  const step = Math.max(1, budget - Math.min(overlap, Math.floor(budget / 4)));
  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + budget, text.length);
    pieces.push({ text: text.slice(pos, end), charStart: base + pos, charEnd: base + end });
    if (end >= text.length) {
      break;
    }
    pos = Math.max(end - Math.min(overlap, Math.floor(budget / 4)), pos + 1);
  }
  return pieces;
}
