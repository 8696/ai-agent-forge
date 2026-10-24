import { describe, it, expect } from 'vitest';
import {
  averageScore,
  judgeDimensionLabel,
  normalizeDifficulty,
  parseEvaluationJsonl,
  parseJudgeScores,
  SCORE_DROP_THRESHOLD,
} from '../../src/services/evaluation';

/**
 * 评测的纯逻辑 —— D1（docs/12-d-需求-运维稳定.md §D1）
 *
 * 这三块都是**不碰网络也不碰数据库**的纯函数，所以可以随便喂奇怪输入：
 *   parseEvaluationJsonl  上传的 JSONL 解析（坏行要能被跳过，不能整份传不上去）
 *   parseJudgeScores      裁判输出的解析（裁判不一定会乖乖只输出 JSON）
 *   averageScore          四维平均
 */

describe('parseEvaluationJsonl', () => {
  it('正常行：解析出题目 + 可选字段', () => {
    const text = [
      '{"question":"年假可以跨年结转吗？","reference_answer":"最多 5 天","scenario":"年假","difficulty":"medium"}',
      '{"question":"发票什么时候截止提交？"}',
    ].join('\n');

    const res = parseEvaluationJsonl(text);
    expect(res.errors).toEqual([]);
    expect(res.items).toHaveLength(2);
    expect(res.items[0]).toEqual({
      question: '年假可以跨年结转吗？',
      reference_answer: '最多 5 天',
      scenario: '年假',
      difficulty: 'medium',
    });
    // 第二条只有 question：其余字段补 null
    expect(res.items[1]).toEqual({
      question: '发票什么时候截止提交？',
      reference_answer: null,
      scenario: null,
      difficulty: null,
    });
  });

  it('空行和纯空白行直接跳过（不报错）', () => {
    const res = parseEvaluationJsonl('\n\n   \n{"question":"a"}\n\n');
    expect(res.items).toHaveLength(1);
    expect(res.errors).toHaveLength(0);
  });

  it('坏行被跳过，好行照常入库（200 条里错 1 行不能整份失败）', () => {
    const text = [
      '{"question":"第 1 题"}',
      '{question: 少了引号}', // ← 坏行
      '{"question":"第 3 题"}',
    ].join('\n');

    const res = parseEvaluationJsonl(text);
    expect(res.items.map((i) => i.question)).toEqual(['第 1 题', '第 3 题']);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]?.line).toBe(2);
  });

  it('question 缺失或为空 → 记为坏行', () => {
    const res = parseEvaluationJsonl(
      ['{"reference_answer":"有答案但没题目"}', '{"question":"   "}', '{"question":"好题"}'].join('\n'),
    );
    expect(res.items).toHaveLength(1);
    expect(res.errors).toHaveLength(2);
    expect(res.errors[0]?.line).toBe(1);
    expect(res.errors[1]?.line).toBe(2);
  });

  it('不是 JSON 对象的行（数组 / 数字 / null）→ 记为坏行', () => {
    const res = parseEvaluationJsonl(['[1,2,3]', '42', 'null', '"字符串"'].join('\n'));
    expect(res.items).toHaveLength(0);
    expect(res.errors).toHaveLength(4);
  });

  it('空的 reference_answer / scenario 归一成 null（不是空字符串）', () => {
    const res = parseEvaluationJsonl(
      '{"question":"q","reference_answer":"   ","scenario":"","difficulty":"  "}',
    );
    expect(res.items[0]?.reference_answer).toBeNull();
    expect(res.items[0]?.scenario).toBeNull();
    expect(res.items[0]?.difficulty).toBeNull();
  });

  it('difficulty 统一转小写', () => {
    const res = parseEvaluationJsonl('{"question":"q","difficulty":"HARD"}');
    expect(res.items[0]?.difficulty).toBe('hard');
  });
});

describe('normalizeDifficulty', () => {
  it('只认 easy / medium / hard，其它当 null', () => {
    expect(normalizeDifficulty('easy')).toBe('easy');
    expect(normalizeDifficulty('MEDIUM')).toBe('medium');
    expect(normalizeDifficulty('Hard')).toBe('hard');
    expect(normalizeDifficulty('地狱级')).toBeNull();
    expect(normalizeDifficulty(null)).toBeNull();
  });
});

describe('parseJudgeScores', () => {
  it('干净的 JSON 直接解析', () => {
    const res = parseJudgeScores(
      '{"accuracy":4,"completeness":3,"style":5,"safety":5,"reason":"漏了一个条件"}',
    );
    expect(res).not.toBeNull();
    expect(res?.scores).toEqual({ accuracy: 4, completeness: 3, style: 5, safety: 5 });
    expect(res?.reason).toBe('漏了一个条件');
  });

  it('带 ```json 围栏也能解析', () => {
    const res = parseJudgeScores(
      '```json\n{"accuracy":5,"completeness":5,"style":4,"safety":5,"reason":"很好"}\n```',
    );
    expect(res?.scores.accuracy).toBe(5);
    expect(res?.reason).toBe('很好');
  });

  it('前后有解释文字也能解析（取第一个 { 到最后一个 }）', () => {
    const res = parseJudgeScores(
      '好的，以下是评分：\n{"accuracy":3,"completeness":3,"style":3,"safety":5,"reason":"一般"}\n希望对你有帮助。',
    );
    expect(res?.scores.accuracy).toBe(3);
  });

  it('分数越界要夹到 0~5', () => {
    const res = parseJudgeScores('{"accuracy":9,"completeness":-2,"style":3,"safety":5}');
    expect(res?.scores.accuracy).toBe(5);
    expect(res?.scores.completeness).toBe(0);
  });

  it('缺一个维度 → 用中位数 3 兜底（一条维度缺失不该毁掉整条打分）', () => {
    const res = parseJudgeScores('{"accuracy":5,"reason":"只有准确性"}');
    expect(res?.scores.accuracy).toBe(5);
    expect(res?.scores.completeness).toBe(3);
    expect(res?.scores.style).toBe(3);
    expect(res?.scores.safety).toBe(3);
  });

  it('维度不是数字 → 兜底 3', () => {
    const res = parseJudgeScores('{"accuracy":"很好","completeness":null}');
    expect(res?.scores.accuracy).toBe(3);
    expect(res?.scores.completeness).toBe(3);
  });

  it('小数会被取整', () => {
    const res = parseJudgeScores('{"accuracy":4.4,"completeness":3.6,"style":5,"safety":5}');
    expect(res?.scores.accuracy).toBe(4);
    expect(res?.scores.completeness).toBe(4);
  });

  it('reason 不是字符串 → null', () => {
    const res = parseJudgeScores('{"accuracy":5,"completeness":5,"style":5,"safety":5,"reason":123}');
    expect(res?.reason).toBeNull();
  });

  it('完全解析不出来 → null（调用方按「裁判不可用」处理）', () => {
    expect(parseJudgeScores('')).toBeNull();
    expect(parseJudgeScores('裁判服务挂了')).toBeNull();
    expect(parseJudgeScores('{ 这不是 json')).toBeNull();
    expect(parseJudgeScores('[1,2,3]')).toBeNull();
  });
});

describe('averageScore', () => {
  it('四维平均', () => {
    expect(
      averageScore({ accuracy: 4, completeness: 3, style: 5, safety: 5 }),
    ).toBe(4.25);
  });

  it('四维都是 5 → 5', () => {
    expect(averageScore({ accuracy: 5, completeness: 5, style: 5, safety: 5 })).toBe(5);
  });
});

describe('judgeDimensionLabel', () => {
  it('四个维度都有中文名', () => {
    expect(judgeDimensionLabel('accuracy')).toBe('准确性');
    expect(judgeDimensionLabel('completeness')).toBe('完整性');
    expect(judgeDimensionLabel('style')).toBe('风格');
    expect(judgeDimensionLabel('safety')).toBe('安全性');
  });
});

describe('SCORE_DROP_THRESHOLD', () => {
  it('阈值是 10%（需求验收：分数下降 ≥ 10% 要告警）', () => {
    expect(SCORE_DROP_THRESHOLD).toBe(0.1);
  });
});
