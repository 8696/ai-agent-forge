import { normalizeWhitespace } from '../normalize';
import type { DocElement, ElementDoc } from './types';

/**
 * 纯文本 / PDF → 元素序列
 *
 * 这两种格式**没有结构标记**：TXT 只有换行，PDF 连换行都是版面猜出来的。
 * 能拿到的结构只有两级：
 *   1. **段落**（空行分隔）—— 一定能拿到
 *   2. **标题** —— 只能靠启发式猜
 *
 * ⚠️ **启发式是有代价的**：猜错了会出现「某个短句被当成标题」，
 * 后果是多一层面包屑（检索时多一个噪声词），**不会**导致内容丢失或错切。
 * 所以这里刻意做得保守 —— 只认强模式，弱规则要求「独立成段 + 短 + 不以句读结尾」。
 */

/** 强标题模式 —— 一眼就是标题，不用猜 */
const STRONG_HEADING_PATTERNS: RegExp[] = [
  // 第一章 / 第 3 节 / 第二篇 / 第 5 条
  /^第\s*[〇零一二三四五六七八九十百千两\d]+\s*[篇部章节節条條回卷]/,
  // （一） / (1)
  /^[（(]\s*[〇零一二三四五六七八九十百千两\d]+\s*[)）]/,
  // 一、 / 二.
  /^[〇零一二三四五六七八九十百千两]+\s*[、.．]\s*\S/,
];

/**
 * 多级数字标题（1.2 xxx / 1.2.3 xxx）。
 *
 * ⚠️ **必须要求两级**：`1. 商品七天内无理由` 是一**列表项**不是标题，
 * 单级数字跟列表项没法区分，两级以上（`1.2`）才是章节编号。
 */
const NUMERIC_HEADING_PATTERN = /^\d+\.\d+(\.\d+)*\s+\S/;

/** 列表项标记 —— 命中就不是标题 */
const LIST_MARKER_PATTERN = /^([-*+•]\s+|\d+[.)、]\s+)/;

/** 以句读结尾 = 是个句子，不是标题 */
const ENDS_WITH_PUNCTUATION = /[。！？；，、,.!?:：]$/;

/** 弱规则的长度上限 —— 比这长就当正文 */
const WEAK_HEADING_MAX_LEN = 40;

/** 猜标题层级（1 最外层） */
function guessHeadingLevel(raw: string): number {
  if (/^第\s*[〇零一二三四五六七八九十百千两\d]+\s*[篇部]/.test(raw)) {
    return 1;
  }
  if (/^第\s*[〇零一二三四五六七八九十百千两\d]+\s*[章章节]/.test(raw)) {
    return 2;
  }
  if (/^第\s*[〇零一二三四五六七八九十百千两\d]+\s*[条條回卷]/.test(raw)) {
    return 3;
  }
  if (NUMERIC_HEADING_PATTERN.test(raw)) {
    // 1.2 → 2 级，1.2.3 → 3 级
    const depth = raw.split(/\s+/)[0]?.split('.').length ?? 2;
    return Math.min(3, Math.max(2, depth));
  }
  // （一）/ 一、 → 2 级
  return 2;
}

/**
 * 这一行是不是标题？**是哪种标题？**
 *
 * @returns `'strong'` = 强模式（一眼就是标题）｜`'weak'` = 弱规则猜的 ｜`null` = 正文
 */
function headingKind(line: string, prevBlank: boolean, nextBlank: boolean): 'strong' | 'weak' | null {
  const text = line.trim();
  if (text.length === 0 || text.length > WEAK_HEADING_MAX_LEN) {
    return null;
  }
  // 列表项永远不是标题
  if (LIST_MARKER_PATTERN.test(text)) {
    return null;
  }
  // 以句读结尾 = 句子
  if (ENDS_WITH_PUNCTUATION.test(text)) {
    return null;
  }
  if (STRONG_HEADING_PATTERNS.some((re) => re.test(text))) {
    return 'strong';
  }
  if (NUMERIC_HEADING_PATTERN.test(text)) {
    return 'strong';
  }
  // 弱规则：独立成段（前后都是空行）+ 短
  return prevBlank && nextBlank ? 'weak' : null;
}

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

interface ParagraphScan {
  elements: DocElement[];
  /** 扫描后的标题栈（跨页延续 —— 章节标题在第 1 页，内容在第 2 页也是同一节） */
  stack: string[];
}

/** 一个段落的分类结果（第一遍的产物） */
interface ClassifiedPara {
  /** null = 正文；'strong' = 强模式标题；'weak' = 弱规则猜的标题 */
  kind: 'strong' | 'weak' | null;
  /** 猜出来的标题层级（正文为 0） */
  level: number;
  /** 段落的原始文本 */
  text: string;
  charStart: number;
  charEnd: number;
}

/**
 * 把一段文本按空行切成段落，并识别标题。
 *
 * **三遍**：
 *   1. **分类** —— 每个段落是「强标题 / 弱标题 / 正文」
 *   2. **去碎片** —— 连续 ≥2 个弱标题**全部降级为正文**
 *   3. **建栈** —— 只有真标题才进标题栈
 *
 * ## 为什么第 2 遍要做「连续弱标题降级」
 *
 * 弱规则是「独立成段 + 短 + 不以句读结尾」—— PDF 抽出来的文本里，
 * 一组并列的短行（「微信支付」/「支付宝」/「银行卡」）**每一条都满足**。
 * 结果是每条各自成一节 → 各自成一个块 → 一篇文档碎成几十个只有一两行的块
 * （每块还各要一次 embedding 调用）。
 *
 * 判据：**一串短行是一组并列项，不是层级标题。**
 * 真标题（`第一章` / `一、` / `1.2 `）走强模式，天然不在这一串里 —— 不受影响。
 */
function scanParagraphs(text: string, stack: string[], page?: number): ParagraphScan {
  const lines = splitLines(text);
  const paras = classifyParagraphs(text, lines);

  // 第 2 遍：连续弱标题降级（原地改写 paras）
  demoteWeakRuns(paras);

  // 第 3 遍：维护标题栈 + 产出元素
  const elements: DocElement[] = [];
  let currentStack = [...stack];

  for (const para of paras) {
    if (para.kind !== null) {
      const title = para.text.trim();
      currentStack = currentStack.slice(0, Math.max(0, para.level - 1));
      currentStack.push(title);
      elements.push({
        type: 'heading',
        text: title,
        headingPath: [...currentStack],
        level: para.level,
        ...(para.kind === 'weak' ? { weak: true } : {}),
        ...(page !== undefined ? { page } : {}),
        charStart: para.charStart,
        charEnd: para.charEnd,
      });
    } else {
      elements.push({
        type: 'paragraph',
        text: para.text,
        headingPath: [...currentStack],
        level: 0,
        ...(page !== undefined ? { page } : {}),
        charStart: para.charStart,
        charEnd: para.charEnd,
      });
    }
  }

  return { elements, stack: currentStack };
}

/** 第一遍：把文本按空行切成段落，逐段分类 */
function classifyParagraphs(text: string, lines: LineSpan[]): ClassifiedPara[] {
  const paras: ClassifiedPara[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.text.trim() === '') {
      i += 1;
      continue;
    }
    // 收集连续非空行 = 一个段落
    const paraStart = line.start;
    let end = i;
    while (end < lines.length && (lines[end]?.text.trim() ?? '') !== '') {
      end += 1;
    }
    const lastLine = lines[end - 1];
    const paraEnd = lastLine?.end ?? paraStart;
    const raw = text.slice(paraStart, paraEnd);

    const isSingleLine = end - i === 1;
    const prevBlank = i === 0 || (lines[i - 1]?.text.trim() ?? '') === '';
    const nextBlank = end >= lines.length || (lines[end]?.text.trim() ?? '') === '';
    const kind = isSingleLine ? headingKind(raw, prevBlank, nextBlank) : null;

    paras.push({
      kind,
      level: kind === null ? 0 : guessHeadingLevel(raw),
      text: raw,
      charStart: paraStart,
      charEnd: paraEnd,
    });
    i = end;
  }

  return paras;
}

/**
 * 第二遍：**连续 ≥2 个弱标题全部降级为正文**。
 *
 * 「连续」= 两个弱标题之间没有夹着正文段落。
 */
function demoteWeakRuns(paras: ClassifiedPara[]): void {
  let runStart = -1;

  const flush = (endExclusive: number): void => {
    if (runStart >= 0 && endExclusive - runStart >= 2) {
      for (let k = runStart; k < endExclusive; k += 1) {
        const p = paras[k];
        if (p !== undefined) {
          p.kind = null;
          p.level = 0;
        }
      }
    }
    runStart = -1;
  };

  for (let i = 0; i < paras.length; i += 1) {
    if (paras[i]?.kind === 'weak') {
      if (runStart < 0) {
        runStart = i;
      }
    } else {
      flush(i);
    }
  }
  flush(paras.length);
}

/** TXT → 元素序列 */
export function buildPlainElements(rawText: string): ElementDoc {
  const text = normalizeWhitespace(rawText);
  if (text.length === 0) {
    return { text, elements: [] };
  }
  const { elements } = scanParagraphs(text, []);
  return { text, elements };
}

/**
 * PDF → 元素序列
 *
 * PDF 的结构信息只剩两样：**页边界**和**段落**。页边界是硬边界
 * （章节、换页），所以每页单独扫，标题栈跨页延续。
 *
 * ⚠️ 页码标记（pdf-parse 默认在每页后面插 `-- 1 of 12 --`）**不能进正文** ——
 * 那是纯噪声，会进向量、会出现在引用卡片里。调用方（document-parse）负责关掉它。
 */
export function buildPdfElements(pageTexts: string[]): ElementDoc {
  const pages = pageTexts.map((page) => normalizeWhitespace(page));
  // 每页归一化后各自 trim 掉了尾部换行，用 '\n\n' 拼起来不会产生 '\n\n\n'
  const text = pages.join('\n\n');
  if (text.length === 0) {
    return { text, elements: [] };
  }

  const elements: DocElement[] = [];
  let stack: string[] = [];
  let base = 0;

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i] ?? '';
    const scanned = scanParagraphs(page, stack, i + 1);
    stack = scanned.stack;
    for (const element of scanned.elements) {
      elements.push({
        ...element,
        charStart: element.charStart + base,
        charEnd: element.charEnd + base,
      });
    }
    base += page.length + 2; // + '\n\n'
  }

  return { text, elements };
}
