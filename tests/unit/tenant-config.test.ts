import { describe, it, expect } from 'vitest';
import {
  encryptWith,
  decryptWith,
  isSecretEncryptionEnabled,
  secretHint,
} from '../../src/lib/crypto';
import { isPrivateAddress, checkLlmEndpoint } from '../../src/lib/llm-endpoint';
import { mergeSettings } from '../../src/services/llm-settings';
import {
  coerceSettingValue,
  SETTINGS_REGISTRY,
  type SettingSpec,
} from '../../src/services/tenant-settings';

/**
 * 租户级配置（C3 / C4）的纯逻辑 —— 不碰数据库、不发网络请求
 *
 * 锁住三条最容易在重构时悄悄坏掉的语义：
 *  1. **密钥永不以明文出库**：解密必须还原原文，而密文本身不含原文
 *  2. **配置优先级**：租户配置 → .env 进程默认，**每一项独立回落**
 *     （租户只填了 model 没填 base_url 时，base_url 要走 .env 而不是变成空）
 *  3. **SSRF 闸门**：生产环境不能把租户的 base_url 指向内网 / 云元数据地址
 */

// 加解密内核是纯函数（密钥显式传参），所以这里不用碰 config / process.env ——
// config 在模块加载时就 Object.freeze 了，运行时改 process.env 对它无效。
const KEY = 'test-encryption-key-for-unit-test-only-32chars';
const OTHER_KEY = 'a-completely-different-key-32-chars';

const PROCESS_DEFAULTS = {
  llmApiKey: 'process-key',
  llmBaseUrl: 'https://process.example.com/anthropic/v1',
  llmModel: 'process-model',
  provider: 'zhipu' as const,
  temperature: 0.2,
  maxOutputTokens: 2048,
  retrievalTopK: 5,
  maxHistoryTurns: 10,
  promptCacheEnabled: true,
};

describe('crypto · 密钥加解密', () => {
  it('解密还原原文', () => {
    const key = 'sk-tenant-secret-1234567890';
    expect(decryptWith(KEY, encryptWith(KEY, key))).toBe(key);
  });

  it('密文里不含明文（base64 / utf8 都搜不到）', () => {
    const key = 'sk-super-secret-value-abcdef';
    const enc = encryptWith(KEY, key);
    expect(enc.toString('utf8')).not.toContain(key);
    expect(enc.toString('base64')).not.toContain(key);
    expect(enc.includes(Buffer.from(key, 'utf8'))).toBe(false);
  });

  it('两次加密同一明文产出不同密文（随机 IV）', () => {
    const a = encryptWith(KEY, 'same-key-value-here');
    const b = encryptWith(KEY, 'same-key-value-here');
    expect(a.equals(b)).toBe(false);
    expect(decryptWith(KEY, a)).toBe(decryptWith(KEY, b));
  });

  it('密文被篡改时解密抛错（GCM authTag 生效）', () => {
    const enc = encryptWith(KEY, 'sk-value-to-tamper-1234');
    const tampered = Buffer.from(enc);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    expect(() => decryptWith(KEY, tampered)).toThrow();
  });

  it('换一把密钥解不开（密钥轮换期必须能识别出来）', () => {
    const enc = encryptWith(KEY, 'sk-value-1234567890');
    expect(() => decryptWith(OTHER_KEY, enc)).toThrow();
  });

  it('密文被截断时抛错而不是解出垃圾', () => {
    const enc = encryptWith(KEY, 'sk-value-1234567890');
    expect(() => decryptWith(KEY, enc.subarray(0, 5))).toThrow();
  });

  it('密钥是否可用读的是 config（具体值取决于本机 .env）', () => {
    expect(typeof isSecretEncryptionEnabled()).toBe('boolean');
  });

  it('脱敏串不泄露中间内容', () => {
    expect(secretHint('sk-abcdefghijklmnop')).toBe('sk-a…mnop');
    // 太短的密钥不给提示（露头露尾几乎等于全露）
    expect(secretHint('short')).toBe('');
  });
});

describe('llm-endpoint · SSRF 闸门', () => {
  it('识别内网 / 特殊用途地址', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true);
    expect(isPrivateAddress('10.1.2.3')).toBe(true);
    expect(isPrivateAddress('172.16.0.1')).toBe(true);
    expect(isPrivateAddress('192.168.1.1')).toBe(true);
    // 云元数据地址 —— 这是最危险的一个
    expect(isPrivateAddress('169.254.169.254')).toBe(true);
    expect(isPrivateAddress('100.64.0.1')).toBe(true);
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('::ffff:10.0.0.1')).toBe(true);
  });

  it('公网地址不算内网', () => {
    expect(isPrivateAddress('1.1.1.1')).toBe(false);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
    expect(isPrivateAddress('2606:4700::1111')).toBe(false);
  });

  it('非 http(s) 协议一律拒（file:// / gopher:// 都能读本地文件）', async () => {
    expect((await checkLlmEndpoint('file:///etc/passwd')).ok).toBe(false);
    expect((await checkLlmEndpoint('gopher://127.0.0.1:6379/_INFO')).ok).toBe(false);
  });

  it('不是合法 URL 直接拒', async () => {
    expect((await checkLlmEndpoint('not a url')).ok).toBe(false);
  });

  it('development 下放开内网（本地 mock 网关能调）', async () => {
    const r = await checkLlmEndpoint('http://127.0.0.1:11434/anthropic/v1');
    expect(r.ok).toBe(true);
  });
});

describe('mergeSettings · 三层配置合并', () => {
  const PROCESS = {
    llm: {
      llmApiKey: 'process-key',
      llmBaseUrl: 'https://process.example.com/anthropic/v1',
      llmModel: 'process-model',
      provider: 'zhipu' as const,
    },
    temperature: 0.2,
    maxOutputTokens: 2048,
    retrievalTopK: 5,
    maxHistoryTurns: 10,
    retrievalTokenBudget: 2500,
    contextTokenBudget: 8000,
    summaryTokenBudget: 600,
    summaryEnabled: true,
    maxInputChars: 2000,
    thinkingBudgetTokens: 0,
    promptCacheEnabled: true,
    rerankEnabled: true,
  };

  const model = (over: Partial<Parameters<typeof mergeSettings>[0]> = {}) => ({
    provider: 'custom' as const,
    model_id: 'tenant-model',
    base_url: 'https://tenant.example.com/anthropic/v1',
    apiKey: 'tenant-key',
    temperature: null,
    max_output_tokens: null,
    prompt_cache_enabled: true,
    ...over,
  });

  it('没有租户模型时全走进程默认', () => {
    const s = mergeSettings(null, {}, PROCESS);
    expect(s.model).toBe('process-model');
    expect(s.apiKey).toBe('process-key');
    expect(s.source).toBe('process-default');
    expect(s.modelEntryId).toBe(null);
  });

  it('模型条目的字段逐项覆盖进程默认', () => {
    const s = mergeSettings(model({ temperature: 0.9, max_output_tokens: 4096 }), {}, PROCESS);
    expect(s.model).toBe('tenant-model');
    expect(s.baseUrl).toBe('https://tenant.example.com/anthropic/v1');
    expect(s.apiKey).toBe('tenant-key');
    expect(s.temperature).toBe(0.9);
    expect(s.maxOutputTokens).toBe(4096);
    expect(s.source).toBe('tenant-model');
  });

  it('模型条目里为 null 的采样参数回落进程默认', () => {
    const s = mergeSettings(model(), {}, PROCESS);
    expect(s.temperature).toBe(0.2);
    expect(s.maxOutputTokens).toBe(2048);
  });

  it('KV 值在「没有模型条目」时也生效', () => {
    const s = mergeSettings(null, { retrieval_top_k: 9, max_history_turns: 3 }, PROCESS);
    expect(s.retrievalTopK).toBe(9);
    expect(s.maxHistoryTurns).toBe(3);
    expect(s.source).toBe('process-default');
  });

  it('KV 覆盖模型条目所在的那一层（模型不碰检索/历史参数）', () => {
    const s = mergeSettings(model(), { retrieval_top_k: 8, prompt_version: 'v3' }, PROCESS);
    expect(s.retrievalTopK).toBe(8);
    expect(s.promptVersion).toBe('v3');
    expect(s.model).toBe('tenant-model');
  });

  it('KV 值类型不对时回落默认（宁可少调也别崩）', () => {
    const s = mergeSettings(null, { retrieval_top_k: 'abc' as never, max_history_turns: null }, PROCESS);
    expect(s.retrievalTopK).toBe(5);
    expect(s.maxHistoryTurns).toBe(10);
  });

  it('降级原因原样透传给调用方', () => {
    const s = mergeSettings(model(), {}, PROCESS, '密钥解不开');
    expect(s.degraded).toBe('密钥解不开');
  });

  it('四个预算项也能被租户覆盖', () => {
    const s = mergeSettings(
      null,
      { retrieval_token_budget: 4000, context_token_budget: 16000, max_input_chars: 500, thinking_budget_tokens: 2048 },
      PROCESS,
    );
    expect(s.retrievalTokenBudget).toBe(4000);
    expect(s.contextTokenBudget).toBe(16000);
    expect(s.maxInputChars).toBe(500);
    expect(s.thinkingBudgetTokens).toBe(2048);
  });

  it('预算项类型不对时回落默认，不让坏值带崩对话', () => {
    const s = mergeSettings(null, { context_token_budget: 'abc' as never }, PROCESS);
    expect(s.contextTokenBudget).toBe(8000);
  });

  it('base_url 存储时已 normalize，这里不再重复拼 /v1', () => {
    const s = mergeSettings(model({ base_url: 'https://x.example.com/anthropic/v1' }), {}, PROCESS);
    expect(s.baseUrl).toBe('https://x.example.com/anthropic/v1');
  });
});

describe('coerceSettingValue · KV 写入校验', () => {
  const spec = (over: Partial<SettingSpec> = {}): SettingSpec => ({
    key: 'k',
    label: '测试项',
    category: '测试',
    description: '',
    type: 'number',
    min: 1,
    max: 10,
    fallback: 5,
    ...over,
  });

  it('数字接受 string 与 number', () => {
    expect(coerceSettingValue(spec(), '7')).toBe('7');
    expect(coerceSettingValue(spec(), 7)).toBe('7');
  });

  it('非数字 / 超范围直接拒（不能让坏值进库）', () => {
    expect(() => coerceSettingValue(spec(), 'abc')).toThrow();
    expect(() => coerceSettingValue(spec(), 0)).toThrow();
    expect(() => coerceSettingValue(spec(), 99)).toThrow();
  });

  it('布尔只认 true / false，不认 "true" 字符串', () => {
    expect(coerceSettingValue(spec({ type: 'boolean' }), true)).toBe('true');
    expect(() => coerceSettingValue(spec({ type: 'boolean' }), 'true')).toThrow();
  });
});

describe('SETTINGS_REGISTRY · 注册表', () => {
  it('每个项的 fallback 与 .env 默认值对得上', () => {
    const f = (key: string): unknown => SETTINGS_REGISTRY.find((s) => s.key === key)?.fallback;
    expect(f('retrieval_top_k')).toBe(5);
    expect(f('max_history_turns')).toBe(10);
    expect(f('retrieval_token_budget')).toBe(2500);
    expect(f('context_token_budget')).toBe(8000);
    expect(f('max_input_chars')).toBe(2000);
    expect(f('thinking_budget_tokens')).toBe(0);
  });

  it('key 不重复', () => {
    const keys = SETTINGS_REGISTRY.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('不含安全边界类参数（加密密钥 / SSRF 开关必须留在 .env）', () => {
    const keys = SETTINGS_REGISTRY.map((s) => s.key);
    expect(keys).not.toContain('config_encryption_key');
    expect(keys).not.toContain('config_allow_private_llm_endpoint');
    expect(keys).not.toContain('allow_private_endpoint');
  });

  it('不含已在模型条目里存在的采样参数（避免两个地方各存一份）', () => {
    const keys = SETTINGS_REGISTRY.map((s) => s.key);
    expect(keys).not.toContain('temperature');
    expect(keys).not.toContain('max_output_tokens');
  });

  it('不含传输层 / 内部估算参数', () => {
    const keys = SETTINGS_REGISTRY.map((s) => s.key);
    expect(keys).not.toContain('keepalive_ms');
    expect(keys).not.toContain('budget_safety_ratio');
    expect(keys).not.toContain('system_token_budget');
  });
});

/**
 * 回归：`prompt_version` 必须留在 SETTINGS_REGISTRY 里
 *
 * ⚠️ **这条曾经坏过，而且坏得很安静**：
 * `prompt_version` 一度只出现在「读」的一侧（llm-settings 读它、
 * config-routes 写它），却**没注册进 SETTINGS_REGISTRY**。后果是：
 *   - 写：`saveSettings` 抛 ValidationError → 发布 / 回滚接口返 400
 *   - 读：`getSettingValue` 直接 return null → 对话永远用内置默认提示词
 * 而后台页面上「发布」按钮点了报错，看起来像偶发失败，不像功能整体没通。
 *
 * 这里锁死四件事，任一被改坏都会红：
 *   1. 它在 registry 里（读侧不再被静默过滤）
 *   2. 它是 hidden 的（通用配置页不给自由输入框）
 *   3. 按 string 类型做值校验
 *   4. mergeSettings 能把它透传成 promptVersion
 */
describe('prompt_version · 提示词生效指针（C3）', () => {
  it('在 registry 里（否则读写两端都拿不到它）', () => {
    const spec = SETTINGS_REGISTRY.find((s) => s.key === 'prompt_version');
    expect(spec).toBeDefined();
    expect(spec?.type).toBe('string');
  });

  it('是 hidden 的 —— 由「提示词配置」页管理，不在通用配置页露出', () => {
    const spec = SETTINGS_REGISTRY.find((s) => s.key === 'prompt_version');
    expect(spec?.hidden).toBe(true);
  });

  it('按 string 做值校验（超长报错）', () => {
    const spec = SETTINGS_REGISTRY.find((s) => s.key === 'prompt_version');
    expect(spec).toBeDefined();
    expect(coerceSettingValue(spec!, 'chat-v2')).toBe('chat-v2');
    expect(() => coerceSettingValue(spec!, 'x'.repeat(200))).toThrow();
  });

  it('mergeSettings 把它透传成 promptVersion（读侧端到端）', () => {
    const PROCESS = {
      llm: {
        llmApiKey: 'process-key',
        llmBaseUrl: 'https://process.example.com/anthropic/v1',
        llmModel: 'process-model',
        provider: 'zhipu' as const,
      },
      temperature: 0.2,
      maxOutputTokens: 2048,
      retrievalTopK: 5,
      maxHistoryTurns: 10,
      retrievalTokenBudget: 2500,
      contextTokenBudget: 8000,
      summaryTokenBudget: 2000,
      summaryEnabled: true,
      maxInputChars: 4000,
      thinkingBudgetTokens: 2048,
      rerankEnabled: true,
      promptCacheEnabled: true,
    };
    const merged = mergeSettings(null, { prompt_version: 'chat-v9' }, PROCESS);
    expect(merged.promptVersion).toBe('chat-v9');
  });

  it('没配时是 null（回落内置默认提示词，不报错）', () => {
    const PROCESS = {
      llm: {
        llmApiKey: 'process-key',
        llmBaseUrl: 'https://process.example.com/anthropic/v1',
        llmModel: 'process-model',
        provider: 'zhipu' as const,
      },
      temperature: 0.2,
      maxOutputTokens: 2048,
      retrievalTopK: 5,
      maxHistoryTurns: 10,
      retrievalTokenBudget: 2500,
      contextTokenBudget: 8000,
      summaryTokenBudget: 2000,
      summaryEnabled: true,
      maxInputChars: 4000,
      thinkingBudgetTokens: 2048,
      rerankEnabled: true,
      promptCacheEnabled: true,
    };
    const merged = mergeSettings(null, {}, PROCESS);
    expect(merged.promptVersion).toBeNull();
  });
});

/**
 * 「一行一条」的多行列表配置 —— 目前只有「首页推荐问题」用它
 *
 * ⚠️ 2026-10-25 补：上限**一直有实现**（写入路径 `coerceSettingValue` 里），
 *    但没有测试锁住 —— 哪天有人把那段校验删了，测试不会红。
 */
describe('多行列表配置 · 行数 / 每行长度上限', () => {
  const spec = SETTINGS_REGISTRY.find((s) => s.key === 'home_suggested_questions');
  const specOf = (): SettingSpec => {
    if (spec === undefined) throw new Error('找不到 home_suggested_questions 配置项');
    return spec;
  };

  it('推荐问题确实是 multiline 类型', () => {
    expect(specOf().type).toBe('string');
    expect(specOf().multiline).toBe(true);
  });

  it('8 条以内正常存（去掉空行和首尾空白）', () => {
    const raw = ['  年假几天  ', '', '报销怎么走', '  ', '迟到怎么算'].join('\n');
    const stored = coerceSettingValue(specOf(), raw);
    expect(stored).toBe('年假几天\n报销怎么走\n迟到怎么算');
  });

  it('超过 8 条 → 400', () => {
    const raw = Array.from({ length: 9 }, (_, i) => `问题${i + 1}`).join('\n');
    expect(() => coerceSettingValue(specOf(), raw)).toThrow(/最多 8 行/);
  });

  it('正好 8 条 → 通过（边界值别误伤）', () => {
    const raw = Array.from({ length: 8 }, (_, i) => `问题${i + 1}`).join('\n');
    expect(coerceSettingValue(specOf(), raw).split('\n')).toHaveLength(8);
  });

  it('每条超过 100 字 → 400', () => {
    const raw = 'x'.repeat(101);
    expect(() => coerceSettingValue(specOf(), raw)).toThrow(/每行不能超过 100/);
  });

  it('正好 100 字 → 通过（边界值别误伤）', () => {
    const raw = 'x'.repeat(100);
    expect(coerceSettingValue(specOf(), raw)).toHaveLength(100);
  });

  it('整串超过 maxLength → 400（先于逐行校验）', () => {
    // 21 行 × 100 字 = 2100+ > maxLength 2000
    // （maxLength 的校验排在 multiline 校验之前，所以先撞它）
    const raw = Array.from({ length: 21 }, () => 'y'.repeat(100)).join('\n');
    expect(() => coerceSettingValue(specOf(), raw)).toThrow(/不能超过 2000 个字符/);
  });
});
