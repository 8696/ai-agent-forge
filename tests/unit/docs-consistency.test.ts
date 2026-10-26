import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { BUILTIN_TOOLS } from '../../src/tools/builtin/registry';
import { SETTINGS_REGISTRY } from '../../src/services/tenant-settings';

/**
 * **文档里的数字不许过期** —— 守住三类最容易被悄悄写错的计数
 *
 * ## 为什么要有这个
 *
 * 2026-10-26 的一次文档↔代码对照审计查出 5 处「文档写一套、代码做另一套」，
 * 其中 3 处是**纯数字过期**（审的人没读代码，读者照着文档会数错）：
 *
 *  - 内置工具写了「6 个」，代码里其实 **8 个**（清单表还漏列了 2 行）
 *  - 通用配置项写了「21 项」，代码里其实 **22 项**（21 可见 + 1 隐藏）
 *  - `data-*` part 写了「四种」，代码里其实 **五种**
 *
 * 数字过期本身不致命，但**它会骗到下一个改这块代码的人** ——
 * 比如照着「6 个工具」的清单去加第 7 个，结果第 8 个没人知道它存在。
 *
 * ## 这个测试守什么
 *
 * 只守**能机械核对**的计数，不做内容正确性判断：
 *  1. 内置工具：代码里的 key 集合 == 文档清单表里的 key 集合
 *  2. 通用配置项：registry 的条数 == 文档里写的条数
 *  3. `data-*` part：代码里发出的类型集合 == 文档里列的类型集合
 *
 * ⚠️ **改了任一边忘了另一边，这个测试就会红** —— 那是它该做的：
 * 提醒你「文档也得改」，而不是让数字慢慢漂。
 */
const DOCS = path.resolve(__dirname, '../../docs');
const SRC = path.resolve(__dirname, '../../src');

function doc(name: string): string {
  return readFileSync(path.join(DOCS, name), 'utf8');
}

/** 取一段 markdown 表格里第一列用反引号包着的 key */
function tableKeys(markdown: string, tableHead: string): string[] {
  const start = markdown.indexOf(tableHead);
  expect(start, `找不到表格：${tableHead}`).toBeGreaterThan(-1);
  const rows = markdown.slice(start).split('\n');
  const keys: string[] = [];
  for (const row of rows.slice(1)) {
    const m = /^\|\s*`([a-z_]+)`\s*\|/.exec(row);
    if (m === null) {
      // 表头分隔行 / 空行之后就是表尾了
      if (keys.length > 0) break;
      continue;
    }
    keys.push(m[1] as string);
  }
  return keys;
}

describe('文档数字 · 内置工具', () => {
  it('文档清单表列出的 key 集合 == 代码里注册的内置工具', () => {
    const docKeys = tableKeys(doc('12-b-需求-ai对话能力.md'), '**内置工具清单**');
    const codeKeys = Object.keys(BUILTIN_TOOLS).sort();
    expect(docKeys.sort()).toEqual(codeKeys);
  });

  it('文档正文写的个数 == 代码里的个数', () => {
    const text = doc('12-b-需求-ai对话能力.md');
    const m = /内置工具的实现（\*\*(\d+) 个\*\*）/.exec(text);
    expect(m, '12-b 的「实现落在哪」表里应写着内置工具的个数').not.toBeNull();
    expect(Number(m?.[1])).toBe(Object.keys(BUILTIN_TOOLS).length);
  });
});

describe('文档数字 · 通用配置项', () => {
  it('12-e 写的 registry 条数 == 代码里的条数', () => {
    const text = doc('12-e-需求-业务接入与平台运营.md');
    const m = /SETTINGS_REGISTRY` 声明 \*\*(\d+) 项\*\*/.exec(text);
    expect(m, '12-e §E2 应写着 SETTINGS_REGISTRY 的条数').not.toBeNull();
    expect(Number(m?.[1])).toBe(SETTINGS_REGISTRY.length);
  });

  it('「可见 + 隐藏」的拆分也对得上', () => {
    const text = doc('12-e-需求-业务接入与平台运营.md');
    const hidden = SETTINGS_REGISTRY.filter((s) => s.hidden === true);
    const visible = SETTINGS_REGISTRY.length - hidden.length;
    const m = /\*\*(\d+) 项可见\*\* \+ 1 项隐藏/.exec(text);
    expect(m, '12-e §E2 应写着「N 项可见 + 1 项隐藏」').not.toBeNull();
    expect(Number(m?.[1])).toBe(visible);
    expect(hidden.length).toBe(1);
  });
});

describe('文档数字 · data-* part', () => {
  it('代码里发出的 data part 类型 == 12-b 列的那些', () => {
    const chatSrc = readFileSync(path.join(SRC, 'services/chat.ts'), 'utf8');
    const codeTypes = new Set(
      [...chatSrc.matchAll(/type:\s*'(data-[a-z-]+)'/g)].map((m) => m[1] as string),
    );
    expect(codeTypes.size).toBeGreaterThan(0);

    const text = doc('12-b-需求-ai对话能力.md');
    const start = text.indexOf('对话链路下发的');
    expect(start, '12-b §B1 应有「对话链路下发的 data-* part」那条').toBeGreaterThan(-1);
    const bullet = text.slice(start, text.indexOf('\n- ', start));
    const docTypes = new Set([...bullet.matchAll(/`(data-[a-z-]+)`/g)].map((m) => m[1] as string));

    expect([...docTypes].sort()).toEqual([...codeTypes].sort());
  });

  it('文档写的「共 N 种」== 实际列出来的个数', () => {
    const text = doc('12-b-需求-ai对话能力.md');
    const start = text.indexOf('对话链路下发的');
    const bullet = text.slice(start, text.indexOf('\n- ', start));
    const numeral = /共([一二三四五六七八九十])种/.exec(bullet);
    expect(numeral, '12-b §B1 应写着「共 N 种」').not.toBeNull();
    const CN: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    const stated = CN[numeral?.[1] as string];
    const listed = new Set([...bullet.matchAll(/`(data-[a-z-]+)`/g)].map((m) => m[1] as string)).size;
    expect(stated).toBe(listed);
  });
});
