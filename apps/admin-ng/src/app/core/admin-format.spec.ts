import { adminDateTime } from './admin-format';

describe('adminDateTime', () => {
  it('reads a timezone-less timestamp as UTC, not as local time', () => {
    // Lược đồ dùng TIMESTAMP không múi giờ và API ghi chuỗi UTC, nên PostgREST trả về
    // chuỗi không có Z. Nếu parse theo giờ địa phương thì mọi nhật ký hiện chậm đúng
    // 7 tiếng ở UTC+7 — đúng lỗi UAT ADM-LOG-01.
    const fromDatabase = adminDateTime('2026-09-20T16:32:15');
    const sameMomentExplicit = adminDateTime('2026-09-20T16:32:15Z');

    expect(fromDatabase).toBe(sameMomentExplicit);
    // 16:32 UTC là 23:32 giờ Việt Nam.
    expect(fromDatabase).toContain('23:32');
  });

  it('keeps an explicit offset instead of forcing UTC on it', () => {
    expect(adminDateTime('2026-09-20T16:32:15+07:00')).toContain('16:32');
  });

  it('accepts the space-separated form Postgres sometimes returns', () => {
    expect(adminDateTime('2026-09-20 16:32:15')).toContain('23:32');
  });

  it('shows a dash for empty or unparseable values rather than Invalid Date', () => {
    expect(adminDateTime(null)).toBe('—');
    expect(adminDateTime('')).toBe('—');
    expect(adminDateTime('khong-phai-ngay')).toBe('—');
  });
});
