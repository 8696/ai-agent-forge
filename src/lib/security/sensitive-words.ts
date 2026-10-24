/**
 * 敏感词库 + 输入/输出审核的第一道（本地词库）—— docs/10-安全方案.md §10.2
 *
 * 四类：暴力 / 色情 / 政治 / 歧视（文档里定的四类，不多不少）。
 *
 * **为什么放 TS 模块而不是 JSON 文件**：
 * 本项目后端用 `tsc` 编译成 ESM（package.json 是 `"type": "module"`），
 * ESM 下 `import data from './x.json'` 需要 import assertion，Node 20 之前不认；
 * 而运行时 `fs.readFileSync` 又要求把 JSON 一起拷进 dist（构建脚本没这一步）。
 * 用 TS 模块就跟着 tsc 一起编译进 dist，没有路径 / 断言 / 拷贝这三类坑。
 * 词库本身仍然是一个**纯数据文件**，改词不用碰逻辑代码。
 *
 * ⚠️ 词表命中 = 硬拦截。宁可漏一点，也不要误伤正常业务提问：
 *   - 只收「明确违规」的组合词，不收「政治」「暴力」这类中性词
 *   - 拿不准的词不写进来 —— 误杀一个正常用户的问法，代价远大于漏一条
 */

export type SensitiveCategory = 'violence' | 'porn' | 'politics' | 'discrimination';

export const SENSITIVE_CATEGORY_LABELS: Record<SensitiveCategory, string> = {
  violence: '暴力',
  porn: '色情',
  politics: '政治敏感',
  discrimination: '歧视',
};

/**
 * 敏感词表 —— 分类 → 词条
 *
 * 改词表时注意：命中后是**直接拒绝请求**（403），不是打个标记放行，
 * 所以每个词都要经得起「这是不是一个正常业务场景会出现的词」的检验。
 */
export const SENSITIVE_WORDS: Record<SensitiveCategory, readonly string[]> = {
  violence: [
    '杀人',
    '砍人',
    '买枪',
    '枪支买卖',
    '制造炸弹',
    '制作炸弹',
    '爆炸物',
    '恐怖袭击',
    '血腥视频',
    '虐待他人',
    '教人自杀',
    '自杀方法',
    '怎么弄死',
    '杀掉他',
  ],
  porn: [
    '色情',
    '裸照',
    '裸体',
    '情色',
    '淫秽',
    '偷拍裙底',
    '裸聊',
    '成人视频',
    '黄色网站',
    '色情小说',
  ],
  politics: [
    '恐怖组织',
    '分裂国家',
    '颠覆政权',
    '煽动颠覆',
    '暴乱策划',
    '制造动乱',
    '招募极端分子',
  ],
  discrimination: [
    '种族歧视',
    '民族歧视',
    '地域歧视',
    '性别歧视',
    '宗教歧视',
    '仇恨言论',
    '种族灭绝',
    '劣等民族',
  ],
};

/** 一次命中 */
export interface SensitiveWordHit {
  category: SensitiveCategory;
  /** 分类的中文名（给日志 / 告警用） */
  label: string;
  /** 命中的词条本身 —— 只在内存里流转，不写进 audit_logs */
  word: string;
  /** 在原文里的起始下标 */
  index: number;
}

export interface SensitiveScanResult {
  hits: SensitiveWordHit[];
  /** 命中了几条（同一词出现多次只算一条） */
  hitCount: number;
}

/**
 * 扫描文本里的敏感词。
 *
 * 用朴素子串匹配：中文没有词边界，Aho-Corasick 在这个词表规模（~40 条）上
 * 反而是过度设计。每条词 O(文本长度)，40 条词就是 40 次扫描，
 * 对一条几千字的输入也就几十微秒。
 */
export function scanSensitiveWords(text: string): SensitiveScanResult {
  const hits: SensitiveWordHit[] = [];
  const seen = new Set<string>();

  for (const [category, words] of Object.entries(SENSITIVE_WORDS) as Array<
    [SensitiveCategory, readonly string[]]
  >) {
    for (const word of words) {
      if (seen.has(word)) {
        continue;
      }
      const index = text.indexOf(word);
      if (index === -1) {
        continue;
      }
      seen.add(word);
      hits.push({
        category,
        label: SENSITIVE_CATEGORY_LABELS[category],
        word,
        index,
      });
    }
  }

  return { hits, hitCount: hits.length };
}

/**
 * 写审计日志时用的安全摘要 —— **不含命中的词本身**。
 * 违规内容进 audit_logs 等于把违规内容复制一份到日志表里，不合适。
 */
export function sensitiveSummary(result: SensitiveScanResult): {
  count: number;
  categories: SensitiveCategory[];
} {
  const categories = [...new Set(result.hits.map((h) => h.category))];
  return { count: result.hitCount, categories };
}
