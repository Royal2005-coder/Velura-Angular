const DATE_TIME = new Intl.DateTimeFormat('vi-VN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Ho_Chi_Minh' });

/** Mốc thời gian Postgres không kèm múi giờ là giờ UTC. */
function parseTimestamp(value: string): Date {
  const iso = value.replace(' ', 'T');
  return new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`);
}

/**
 * Giờ Việt Nam của một mốc trên đơn hàng, chuỗi rỗng khi thiếu hoặc sai định dạng.
 */
export function formatOrderTime(value: string | null | undefined): string {
  if (!value) return '';
  const date = parseTimestamp(value);
  return Number.isNaN(date.getTime()) ? '' : DATE_TIME.format(date);
}
