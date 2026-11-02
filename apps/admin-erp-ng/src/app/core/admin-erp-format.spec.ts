import { adminKpiMoney } from './admin-erp-format';

describe('adminKpiMoney', () => {
  it('shows an em dash, never 0đ, when the observation is missing', () => {
    expect(adminKpiMoney(null)).toBe('—');
    expect(adminKpiMoney(undefined)).toBe('—');
    expect(adminKpiMoney(Number.NaN)).toBe('—');
  });

  it('keeps a real zero and compacts real amounts', () => {
    expect(adminKpiMoney(0)).toBe('0đ');
    expect(adminKpiMoney(12_000_000)).toBe('12Mđ');
    expect(adminKpiMoney(450_000)).toBe('450Kđ');
  });
});
