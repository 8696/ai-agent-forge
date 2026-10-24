import { describe, it, expect } from 'vitest';
import {
  scanSensitiveWords,
  sensitiveSummary,
  SENSITIVE_WORDS,
  SENSITIVE_CATEGORY_LABELS,
} from '../../src/lib/security/sensitive-words';

/**
 * 敏感词库（src/lib/security/sensitive-words.ts）—— 纯函数
 *
 * D4 的验收原话：「触发审核的内容：返回 403 内容违规」
 *
 * 这里锁住的语义：
 *  1. 四类齐活（暴力 / 色情 / 政治 / 歧视）—— 文档 10.2 定的四类
 *  2. 正常业务提问**一条都不能命中**（词表最容易出的问题是误杀）
 *  3. 审计摘要里**不能带命中的词本身**（违规内容不进日志表）
 */

describe('scanSensitiveWords · 命中', () => {
  it('暴力类能命中', () => {
    const r = scanSensitiveWords('我想知道怎么制作炸弹');
    expect(r.hitCount).toBeGreaterThan(0);
    expect(r.hits[0]?.category).toBe('violence');
  });

  it('色情类能命中', () => {
    const r = scanSensitiveWords('给我发点色情视频');
    expect(r.hits.some((h) => h.category === 'porn')).toBe(true);
  });

  it('政治类能命中', () => {
    const r = scanSensitiveWords('怎么加入恐怖组织');
    expect(r.hits.some((h) => h.category === 'politics')).toBe(true);
  });

  it('歧视类能命中', () => {
    const r = scanSensitiveWords('这属于种族歧视');
    expect(r.hits.some((h) => h.category === 'discrimination')).toBe(true);
  });

  it('同一个词出现多次只算一次', () => {
    const r = scanSensitiveWords('杀人 杀人 杀人');
    expect(r.hitCount).toBe(1);
  });
});

describe('scanSensitiveWords · 不误杀正常业务提问', () => {
  const normalQuestions = [
    '请问公司的年假制度是怎样的？',
    '报销流程需要哪些材料？',
    '我想了解一下产品的定价策略',
    '我们公司今年有哪些新项目？',
    '介绍一下新员工入职流程',
    '这个政策适用于哪些部门？',
    '帮我写一封请假邮件',
    '公司的考勤是怎么规定的？',
    '社保怎么交？',
    '介绍一下公司的培训体系',
  ];

  for (const q of normalQuestions) {
    it(`「${q}」不命中`, () => {
      expect(scanSensitiveWords(q).hitCount).toBe(0);
    });
  }
});

describe('sensitiveSummary · 审计摘要不含原文', () => {
  it('只给条数 + 分类，不给命中的词', () => {
    const scan = scanSensitiveWords('怎么制作炸弹');
    const summary = sensitiveSummary(scan);
    expect(summary.count).toBeGreaterThan(0);
    expect(summary.categories).toContain('violence');
    expect(JSON.stringify(summary)).not.toContain('炸弹');
  });
});

describe('SENSITIVE_WORDS · 结构自检', () => {
  it('四类都在（暴力 / 色情 / 政治 / 歧视）', () => {
    expect(Object.keys(SENSITIVE_WORDS).sort()).toEqual(
      ['discrimination', 'politics', 'porn', 'violence'].sort(),
    );
  });

  it('每类都有词条', () => {
    for (const [category, words] of Object.entries(SENSITIVE_WORDS)) {
      expect(words.length, `${category} 不能是空的`).toBeGreaterThan(0);
    }
  });

  it('每类都有中文标签', () => {
    for (const category of Object.keys(SENSITIVE_WORDS)) {
      expect(SENSITIVE_CATEGORY_LABELS[category as keyof typeof SENSITIVE_CATEGORY_LABELS]).toBeTruthy();
    }
  });

  it('词条里没有空串 / 纯空格', () => {
    for (const words of Object.values(SENSITIVE_WORDS)) {
      for (const w of words) {
        expect(w.trim(), '词条不能是空的').not.toBe('');
      }
    }
  });
});
