import { budgetReachedMessage, voucherCapacity, voucherMaxDiscount } from './voucher-budget';

describe('voucher budget conversion', () => {
  it('floors budget divided by the per-voucher cap and subtracts issued codes', () => {
    expect(voucherCapacity(1_000_000, 30_000, 3)).toEqual({ status: 'limited', max: 33, issued: 3, remaining: 30 });
    expect(voucherCapacity(100_000, 100_000, 5)).toEqual({ status: 'limited', max: 1, issued: 5, remaining: 0 });
  });

  it('treats zero budget as unlimited and flags a missing cap', () => {
    expect(voucherCapacity(0, null, 2)).toEqual({ status: 'unlimited' });
    expect(voucherCapacity(500_000, null, 0)).toEqual({ status: 'cap_required' });
  });

  it('derives the per-use maximum for each voucher type', () => {
    expect(voucherMaxDiscount({ type: 'fixed_amount', value: 50_000, maxDiscount: null })).toBe(50_000);
    expect(voucherMaxDiscount({ type: 'percentage', value: 10, maxDiscount: null })).toBeNull();
    expect(voucherMaxDiscount({ type: 'percentage', value: 10, maxDiscount: 40_000 })).toBe(40_000);
    expect(voucherMaxDiscount({ type: 'free_shipping', value: 0, maxDiscount: null })).toBe(50_000);
  });

  it('words the budget-ceiling message as the server does', () => {
    expect(budgetReachedMessage(10, 10)).toBe('Đã phát 10/10 mã, chạm trần ngân sách');
  });
});
