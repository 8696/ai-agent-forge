import dayjs from 'dayjs';

/**
 * 消息时间戳格式化 —— docs/04-b §4.2「用户消息右上角小时间戳」
 *
 * 规则：
 *  - 今天的消息 → 只显示「HH:mm」
 *  - 今年的消息 → 「MM-DD HH:mm」
 *  - 更早的       → 「YYYY-MM-DD HH:mm」
 *
 * 走浏览器本地时区（用户看到的时间应该跟他表上的时间一致）。
 */
export function formatMessageTime(iso: string | undefined): string | null {
  if (iso === undefined || iso === '') {
    return null;
  }
  const t = dayjs(iso);
  if (!t.isValid()) {
    return null;
  }
  const now = dayjs();
  if (t.isSame(now, 'day')) {
    return t.format('HH:mm');
  }
  if (t.isSame(now, 'year')) {
    return t.format('MM-DD HH:mm');
  }
  return t.format('YYYY-MM-DD HH:mm');
}
