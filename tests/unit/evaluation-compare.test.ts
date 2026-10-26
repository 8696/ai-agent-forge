import { describe, it, expect } from 'vitest';
import {
  matchComparisonItems,
  type ComparisonResultRow,
} from '../../src/services/evaluation';

/**
 * A/B 对比的**逐题配对** —— 纯逻辑（docs/12-e 裁定表 表 4）
 *
 * 这一层单独拎出来测，因为它决定「对比报告靠不靠谱」：
 * 配对错了（比如把 A 的第 1 题配到 B 的第 3 题），
 * 上面的汇总分数再漂亮也是错的。
 *
 * 配对规则：
 *   1. 同一个评测集 → 按 `item_id` 配（精确）
 *   2. 配不上 → 按题目文本配（兜底）
 *   3. **一对一** —— B 侧每条明细最多被领走一次
 */

function row(
  itemId: string | null,
  question: string,
  scores: Partial<{ accuracy: number; completeness: number; style: number; safety: number }> = {},
  judgeReason: string | null = null,
): ComparisonResultRow {
  return {
    item_id: itemId,
    question,
    answer: `答案：${question}`,
    scores: {
      accuracy: scores.accuracy ?? 3,
      completeness: scores.completeness ?? 3,
      style: scores.style ?? 3,
      safety: scores.safety ?? 3,
    },
    judge_reason: judgeReason,
  };
}

/** 四维全 4 分 = 总分 4 */
const ALL4 = { accuracy: 4, completeness: 4, style: 4, safety: 4 };
/** 四维全 2 分 = 总分 2 */
const ALL2 = { accuracy: 2, completeness: 2, style: 2, safety: 2 };

describe('matchComparisonItems · 配对', () => {
  it('同一个评测集：按 item_id 精确配对', () => {
    const a = [row('i1', '年假几天', ALL4), row('i2', '发票截止', ALL4)];
    const b = [row('i1', '年假几天', ALL2), row('i2', '发票截止', ALL2)];

    const items = matchComparisonItems(a, b, true);

    expect(items).toHaveLength(2);
    // 配对的题：B 分更低 → verdict = worse，差值 = 2 - 4 = -2
    expect(items[0]?.a?.scores.accuracy).toBe(4);
    expect(items[0]?.b?.scores.accuracy).toBe(2);
    expect(items[0]?.delta).toBe(-2);
    expect(items[0]?.verdict).toBe('worse');
    expect(items[1]?.verdict).toBe('worse');
  });

  it('item_id 对不上时按题目文本兜底', () => {
    const a = [row('i1', '年假几天', ALL4)];
    // B 的 item_id 完全不同（换了评测集或重新导入过），但题目一样
    const b = [row('x99', '年假几天', ALL2)];

    const items = matchComparisonItems(a, b, false);

    expect(items).toHaveLength(1);
    expect(items[0]?.b).not.toBeNull();
    expect(items[0]?.verdict).toBe('worse');
  });

  it('题目文本也一样兜底（sameDataset=false 时不按 item_id 配）', () => {
    const a = [row('i1', '年假几天', ALL4)];
    const b = [row('i1', '年假几天', ALL2)];

    // sameDataset=true 且 item_id 相同 → 也能配上
    expect(matchComparisonItems(a, b, true)[0]?.b).not.toBeNull();
    // sameDataset=false → 只能靠题目文本，同样配上
    expect(matchComparisonItems(a, b, false)[0]?.b).not.toBeNull();
  });

  it('一对一：同一道题出现两次，B 侧两条不会被同一条领走两次', () => {
    const a = [row(null, '重复题', ALL4), row(null, '重复题', ALL4)];
    const b = [row(null, '重复题', ALL2), row(null, '重复题', ALL4)];

    const items = matchComparisonItems(a, b, false);

    expect(items).toHaveLength(2);
    // 第一条 A 领走了 B 的第一条（2 分），第二条 A 领走 B 的第二条（4 分）
    expect(items[0]?.b?.scores.accuracy).toBe(2);
    expect(items[1]?.b?.scores.accuracy).toBe(4);
    expect(items[0]?.verdict).toBe('worse');
    expect(items[1]?.verdict).toBe('same');
  });

  it('B 多出一道题 → only_b', () => {
    const a = [row('i1', '年假几天', ALL4)];
    const b = [row('i1', '年假几天', ALL4), row('i2', '只有 B 有的题', ALL4)];

    const items = matchComparisonItems(a, b, true);

    expect(items).toHaveLength(2);
    const onlyB = items.find((i) => i.question === '只有 B 有的题');
    expect(onlyB?.verdict).toBe('only_b');
    expect(onlyB?.a).toBeNull();
    expect(onlyB?.delta).toBeNull();
  });

  it('A 多出一道题 → only_a', () => {
    const a = [row('i1', '年假几天', ALL4), row('i2', '只有 A 有的题', ALL4)];
    const b = [row('i1', '年假几天', ALL4)];

    const items = matchComparisonItems(a, b, true);

    const onlyA = items.find((i) => i.question === '只有 A 有的题');
    expect(onlyA?.verdict).toBe('only_a');
    expect(onlyA?.b).toBeNull();
    expect(onlyA?.delta).toBeNull();
  });

  it('差值方向是 B - A（B 更好 → 正数 + better）', () => {
    const a = [row('i1', '题', ALL2)];
    const b = [row('i1', '题', ALL4)];

    const items = matchComparisonItems(a, b, true);

    expect(items[0]?.delta).toBe(2);
    expect(items[0]?.verdict).toBe('better');
  });

  it('持平：差值在 0.01 以内算 same', () => {
    const a = [row('i1', '题', { accuracy: 4, completeness: 4, style: 4, safety: 4 })];
    const b = [row('i1', '题', { accuracy: 4, completeness: 4, style: 4, safety: 3.99 })];

    const items = matchComparisonItems(a, b, true);

    expect(items[0]?.verdict).toBe('same');
  });

  it('空的一侧不炸：没有 B 的明细也能返回', () => {
    const items = matchComparisonItems([row('i1', '题', ALL4)], [], true);
    expect(items).toHaveLength(1);
    expect(items[0]?.verdict).toBe('only_a');
  });

  it('裁判漏写某个维度 → 那一维按 3 算，不当 0 分', () => {
    const a: ComparisonResultRow[] = [
      {
        item_id: 'i1',
        question: '题',
        answer: '答案',
        scores: { accuracy: 5, completeness: 5, style: 5, safety: 5 },
        judge_reason: null,
      },
    ];
    const b: ComparisonResultRow[] = [
      {
        item_id: 'i1',
        question: '题',
        answer: '答案',
        // 缺 safety —— 库里的老数据可能这样
        scores: { accuracy: 5, completeness: 5, style: 5 } as never,
        judge_reason: null,
      },
    ];

    const items = matchComparisonItems(a, b, true);

    // B 的 safety 补成 3 → (5+5+5+3)/4 = 4.5，比 A 的 5 低 0.5
    expect(items[0]?.b?.scores.safety).toBe(3);
    expect(items[0]?.delta).toBe(-0.5);
  });
});
