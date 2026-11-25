import { formatVietnamDateTime, formatVietnamDeadline, parseApiDate } from './date';

describe('date utils', () => {
  it('parses Postgres naive UTC timestamps and offsets consistently', () => {
    const naiveT = parseApiDate('2026-11-25T15:44:28.318743');
    const naiveSpace = parseApiDate('2026-11-25 15:44:28.318743');
    const utcZ = parseApiDate('2026-11-25T15:44:28.318z');
    const vnOffset = parseApiDate('2026-11-25T22:44:28.318+0700');

    expect(naiveT?.toISOString()).toBe('2026-11-25T15:44:28.318Z');
    expect(naiveSpace?.toISOString()).toBe('2026-11-25T15:44:28.318Z');
    expect(utcZ?.toISOString()).toBe('2026-11-25T15:44:28.318Z');
    expect(vnOffset?.toISOString()).toBe('2026-11-25T15:44:28.318Z');
    expect(parseApiDate('')).toBeNull();
    expect(parseApiDate('not-a-date')).toBeNull();
  });

  it('formats timestamps strictly in Asia/Ho_Chi_Minh timezone', () => {
    expect(formatVietnamDateTime('2026-11-25T15:44:28.318743')).toBe('22:44:28 25/11/2026');
    expect(formatVietnamDeadline('2026-12-02T15:44:28.318Z')).toBe('22:44 02/12/2026');
    expect(formatVietnamDateTime(null)).toBe('Chưa có');
  });
});
