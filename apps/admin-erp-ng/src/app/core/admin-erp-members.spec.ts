import {
  ledgerKindMeta,
  memberLockReasonError,
  memberPoints,
  memberPointsLabel,
  memberState,
  memberTabCounts,
  memberWalletValue,
  memberWarning,
  referralRoleLabel,
  referralStatusMeta,
  voucherBenefitLabel,
  voucherStatusMeta,
} from './admin-erp-members';

describe('member loyalty display rules', () => {
  it('treats the wallet unit as milli-points: 1000 milli = 1 điểm = 1.000đ', () => {
    expect(memberPoints(90_900_000)).toBe(90_900);
    expect(memberPointsLabel(850_000)).toBe('850 điểm');
    expect(memberWalletValue(90_900_000, 0)).toBe('90.900.000đ');
    expect(memberWalletValue(100_000, 300_000)).toBe('-200.000đ');
  });

  it('labels one wallet state per row, ordered by operational urgency', () => {
    expect(memberState({ wallet_exists: false })).toEqual({ label: 'Chưa có ví', tone: 'neutral' });
    expect(memberState({ wallet_exists: true, accrual_locked: true, warning_flags: 2 })).toEqual({
      label: 'Khoá tích luỹ',
      tone: 'danger',
    });
    expect(memberState({ wallet_exists: true, balance_milli_points: 100_000, debt_milli_points: 300_000 })).toEqual({
      label: 'Đang nợ điểm',
      tone: 'warning',
    });
    expect(memberState({ wallet_exists: true, balance_milli_points: 5_000, warning_flags: 1 })).toEqual({
      label: 'Có cảnh báo',
      tone: 'warning',
    });
    expect(memberState({ wallet_exists: true, balance_milli_points: 5_000 })).toEqual({
      label: 'Đang tích luỹ',
      tone: 'success',
    });
  });

  it('names every ledger kind 073 can write', () => {
    expect(ledgerKindMeta('earn').label).toBe('Cộng điểm khi giao');
    expect(ledgerKindMeta('clawback').tone).toBe('danger');
    expect(ledgerKindMeta('debt_repayment').label).toBe('Bù nợ điểm');
    expect(ledgerKindMeta(null).label).toBe('Bút toán');
  });

  it('maps referral, voucher and benefit vocabulary from the RPC', () => {
    expect(referralStatusMeta('pending').label).toBe('Chờ đơn đủ điều kiện');
    expect(referralStatusMeta('successful').tone).toBe('success');
    expect(referralStatusMeta('reversed').tone).toBe('danger');
    expect(referralRoleLabel('referrer')).toBe('Người giới thiệu');
    expect(voucherBenefitLabel('referrer_reward')).toBe('Thưởng cho người giới thiệu');
    expect(voucherStatusMeta('revoked').tone).toBe('danger');
  });

  it('derives tab counts without inventing a wallet for members who never earned', () => {
    expect(memberTabCounts({ members: 129, with_wallet: 7, negative_accounts: 0, locked_accounts: 0 })).toEqual({
      all: 129,
      has: 7,
      none: 122,
      negative: 0,
      locked: 0,
    });
    expect(memberTabCounts({}).none).toBe(0);
  });

  it('requires an auditable reason before locking or unlocking', () => {
    expect(memberLockReasonError('ngắn')).not.toBeNull();
    expect(memberLockReasonError('   ngắn  ')).not.toBeNull();
    expect(memberLockReasonError('xác minh với khách qua hotline')).toBeNull();
  });

  it('surfaces the balance problems an operator has to act on', () => {
    expect(memberWarning({ wallet_exists: true, accrual_locked: true })).toContain('Tích luỹ đang bị khoá');
    expect(memberWarning({ wallet_exists: true, balance_milli_points: 1, debt_milli_points: 2 })).toContain('Ví đang âm');
    expect(memberWarning({ wallet_exists: true, warning_flags: 1 })).toContain('cờ cảnh báo');
    expect(memberWarning({ wallet_exists: true })).toBeNull();
  });
});
