#!/usr/bin/env tsx
/**
 * 调试用：直接打 MiniMax 的 Anthropic 协议端点，看返回什么。
 * 不走 Vercel AI SDK，绕开它的 baseURL 处理逻辑。
 */
import 'dotenv/config';

const BASE = process.env.MINIMAX_ANTHROPIC_BASE_URL ?? '';
const KEY = process.env.MINIMAX_API_KEY ?? '';
const MODEL = process.env.MINIMAX_ANTHROPIC_MODEL ?? '';

if (!BASE || !KEY) {
  console.error('MINIMAX_ANTHROPIC_BASE_URL / MINIMAX_API_KEY 未配置');
  process.exit(1);
}

console.log(`BASE = ${BASE}`);
console.log(`MODEL = ${MODEL}`);
console.log(`KEY len = ${KEY.length}`);

// Vercel AI SDK 走 createAnthropic 时，会把 baseURL 拼成 ${baseURL}/v1/messages
// 所以默认它会打到 `${BASE}/v1/messages` —— 我们直接试
const candidates: Array<{ label: string; url: string; body: unknown }> = [
  {
    label: '1. SDK 默认: ${BASE}/v1/messages',
    url: `${BASE}/v1/messages`,
    body: {
      model: MODEL,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'reply with single word: pong' }],
    },
  },
  {
    label: '2. 直挂 messages 端点: ${BASE}/messages',
    url: `${BASE}/messages`,
    body: {
      model: MODEL,
      max_tokens: 32,
      messages: [{ role: 'user', content: 'reply with single word: pong' }],
    },
  },
  {
    label: '3. 试 ${BASE}/ 本身（看根信息）',
    url: `${BASE}/`,
    body: null,
  },
];

for (const c of candidates) {
  console.log(`\n[试] ${c.label}`);
  console.log(`     url = ${c.url}`);
  try {
    const res = await fetch(c.url, {
      method: c.body === null ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
      },
      body: c.body === null ? null : JSON.stringify(c.body),
    });
    const text = await res.text();
    const snippet = text.slice(0, 400).replace(/\n/g, ' ');
    console.log(`     status = ${res.status} ${res.statusText}`);
    console.log(`     body   = ${snippet}${text.length > 400 ? '... (截断)' : ''}`);
  } catch (err: unknown) {
    console.log(`     error  = ${err instanceof Error ? err.message : String(err)}`);
  }
}
