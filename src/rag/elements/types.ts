/**
 * 文档元素 —— 切块前的中间层
 *
 * 为什么要有这一层：
 * 切块器如果直接吃一坨字符，就只能按字符硬切 —— 标题、列表、代码块、表格
 * 这些「本来属于一块」的东西会被从中间劈开（这是 2026-10-27 之前的做法）。
 *
 * 这一层把不同格式的文档统一成**带类型的元素序列**：
 *   - Markdown → AST（标题层级 / 列表 / 代码 / 表格都是独立节点）
 *   - PDF      → 按页 + 按段（版面结构没了，只剩段落和页边界）
 *   - TXT      → 按段
 * 切块器只认元素类型，不再关心来源格式。
 */

/** 元素类型 —— 切块时的「不可再分」单位 */
export type DocElementType =
  | 'heading' // 标题（开启一个新的分节）
  | 'paragraph' // 段落
  | 'list' // 列表项
  | 'code' // 代码块
  | 'table' // 表格
  | 'text'; // 其它纯文本

export interface DocElement {
  type: DocElementType;
  /** 元素的纯文本内容（表格已渲染成 markdown 管道表，代码保留原文） */
  text: string;
  /** 标题层级路径，从最外层到最内层；没有标题时为空数组 */
  headingPath: string[];
  /** 标题层级 1~6；非标题为 0 */
  level: number;
  /** PDF 页码（1 起）；其它格式为 undefined */
  page?: number;
  /**
   * 是不是**弱规则猜出来的**标题（独立成段 + 短 + 不以句读结尾）。
   *
   * ⚠️ 弱标题比强标题容易误判 —— 一组并列的短行（「微信支付」/「支付宝」）
   *    每一条都满足弱规则。切块器用这个标记做「连续弱标题降级」，
   *    避免一篇文档碎成几十个只有一两行的块（见 plaintext.ts 的三遍扫描）。
   */
  weak?: boolean;
  /** 在**归一化后**全文中的字符区间 */
  charStart: number;
  charEnd: number;
}

/** 一次解析的产物：归一化后的全文 + 元素序列 */
export interface ElementDoc {
  /** 归一化后的全文（元素偏移量以它为基准） */
  text: string;
  elements: DocElement[];
}
