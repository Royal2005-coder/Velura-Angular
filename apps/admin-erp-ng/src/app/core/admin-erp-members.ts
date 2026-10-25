import { adminMoney } from './admin-erp-format';

/**
 * Bộ lọc ví của workspace thành viên. Giá trị trùng đúng tham số `wallet` mà
 * `admin_list_members` chấp nhận, để UI và SQL không có hai bộ từ vựng.
 */
export type MemberWalletFilter = 'all' | 'has' | 'none' | 'negative' | 'locked';

export const MEMBER_WALLET_KEYS: readonly MemberWalletFilter[] = ['all', 'has', 'none', 'negative', 'locked'];

export const MEMBER_WALLET_FILTERS: readonly { key: MemberWalletFilter; label: string; hint: string }[] = [
  { key: 'all', label: 'Tất cả', hint: 'Mọi tài khoản vai trò thành viên' },
  { key: 'has', label: 'Có ví', hint: 'Đã từng phát sinh điểm' },
  { key: 'none', label: 'Chưa có ví', hint: 'Chưa giao dịch đủ điều kiện tích luỹ' },
  { key: 'negative', label: 'Nợ điểm', hint: 'Số dư âm sau khi thu hồi theo trả hàng' },
  { key: 'locked', label: 'Khoá tích luỹ', hint: 'Đang bị dừng cộng điểm' },
];

export type MemberTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

export interface MemberStateInput {
  wallet_exists?: boolean;
  accrual_locked?: boolean;
  balance_milli_points?: number;
  debt_milli_points?: number;
  warning_flags?: number;
}

/**
 * Điểm hiển thị = milli-points / 1000. Một điểm đổi được 1.000đ, nên giá trị ví
 * bằng đúng số milli (balance − debt) và không phải nhân thêm lần nào nữa.
 */
export function memberPoints(milli: number | null | undefined): number {
  return Math.round(Number(milli || 0)) / 1000;
}

export function memberPointsLabel(milli: number | null | undefined): string {
  return `${memberPoints(milli).toLocaleString('vi-VN', { maximumFractionDigits: 3 })} điểm`;
}

/** Giá trị quy đổi của ví, cùng đơn vị với số dư milli (1 điểm = 1.000đ). */
export function memberWalletValue(balanceMilli: number | null | undefined, debtMilli: number | null | undefined): string {
  return adminMoney(Number(balanceMilli || 0) - Number(debtMilli || 0));
}

/**
 * Trạng thái vận hành của một ví, theo thứ tự ưu tiên: chưa có ví → bị khoá →
 * đang nợ điểm → có cảnh báo → bình thường. Một dòng chỉ mang đúng một nhãn.
 */
export function memberState(row: MemberStateInput): { label: string; tone: MemberTone } {
  if (!row.wallet_exists) return { label: 'Chưa có ví', tone: 'neutral' };
  if (row.accrual_locked) return { label: 'Khoá tích luỹ', tone: 'danger' };
  if (Number(row.balance_milli_points || 0) < Number(row.debt_milli_points || 0)) {
    return { label: 'Đang nợ điểm', tone: 'warning' };
  }
  if (Number(row.warning_flags || 0) > 0) return { label: 'Có cảnh báo', tone: 'warning' };
  return { label: 'Đang tích luỹ', tone: 'success' };
}

/**
 * Nhãn cho từng loại bút toán trong `loyalty_ledger`. Production hiện chỉ có 'earn';
 * 'clawback' và 'debt_repayment' là hai loại mà migration 073 sinh ra.
 */
export function ledgerKindMeta(kind: string | null | undefined): { label: string; tone: MemberTone } {
  switch (kind) {
    case 'earn':
      return { label: 'Cộng điểm khi giao', tone: 'success' };
    case 'clawback':
      return { label: 'Thu hồi theo trả hàng', tone: 'danger' };
    case 'debt_repayment':
      return { label: 'Bù nợ điểm', tone: 'warning' };
    case 'expire':
      return { label: 'Hết hạn điểm', tone: 'neutral' };
    case 'adjust':
      return { label: 'Điều chỉnh có lý do', tone: 'info' };
    default:
      return { label: kind || 'Bút toán', tone: 'neutral' };
  }
}

/** 073 ghi `successful`, 061 ánh xạ `completed` sang qualified khi trả về storefront. */
export function referralStatusMeta(status: string | null | undefined): { label: string; tone: MemberTone } {
  switch (status) {
    case 'pending':
      return { label: 'Chờ đơn đủ điều kiện', tone: 'warning' };
    case 'successful':
    case 'completed':
      return { label: 'Đã hoàn tất', tone: 'success' };
    case 'reversed':
      return { label: 'Đã thu hồi', tone: 'danger' };
    default:
      return { label: status || '—', tone: 'neutral' };
  }
}

export function referralRoleLabel(role: string | null | undefined): string {
  return role === 'referrer' ? 'Người giới thiệu' : role === 'referred' ? 'Được giới thiệu' : '—';
}

export function voucherBenefitLabel(benefit: string | null | undefined): string {
  switch (benefit) {
    case 'referred_signup':
      return 'Quà đăng ký qua giới thiệu';
    case 'referrer_reward':
      return 'Thưởng cho người giới thiệu';
    default:
      return benefit || 'Ưu đãi thành viên';
  }
}

export function voucherStatusMeta(status: string | null | undefined): { label: string; tone: MemberTone } {
  switch (status) {
    case 'available':
      return { label: 'Còn hiệu lực', tone: 'success' };
    case 'used':
      return { label: 'Đã dùng', tone: 'neutral' };
    case 'revoked':
      return { label: 'Đã thu hồi', tone: 'danger' };
    default:
      return { label: status || '—', tone: 'neutral' };
  }
}

/**
 * Đếm cho tab. "Chưa có ví" = tổng thành viên − số ví, vì mỗi ví gắn 1-1 với user.
 */
export function memberTabCounts(overview: {
  members?: number;
  with_wallet?: number;
  negative_accounts?: number;
  locked_accounts?: number;
}): Record<MemberWalletFilter, number> {
  const members = Number(overview.members || 0);
  const wallets = Number(overview.with_wallet || 0);
  return {
    all: members,
    has: wallets,
    none: Math.max(0, members - wallets),
    negative: Number(overview.negative_accounts || 0),
    locked: Number(overview.locked_accounts || 0),
  };
}

/** Cùng ngưỡng 8 ký tự với RPC, để form báo lỗi trước khi gọi mạng. */
export const MEMBER_LOCK_REASON_MIN = 8;

export function memberLockReasonError(reason: string): string | null {
  return reason.trim().length < MEMBER_LOCK_REASON_MIN
    ? `Cần lý do tối thiểu ${MEMBER_LOCK_REASON_MIN} ký tự để lưu dấu vết vận hành.`
    : null;
}

/**
 * Cảnh báo dữ liệu đáng chú ý trên một dòng thành viên. Trả `null` khi không có gì bất thường.
 */
export function memberWarning(row: {
  wallet_exists?: boolean;
  accrual_locked?: boolean;
  balance_milli_points?: number;
  debt_milli_points?: number;
  warning_flags?: number;
}): string | null {
  if (row.accrual_locked) return 'Tích luỹ đang bị khoá: điểm mới sẽ không được cộng cho tới khi mở khoá.';
  if (Number(row.balance_milli_points || 0) < Number(row.debt_milli_points || 0)) {
    return 'Ví đang âm: điểm đã dùng/đã hết hạn vượt số điểm còn lại. Khoản nợ này sẽ trừ vào lần tích luỹ kế tiếp.';
  }
  if (Number(row.warning_flags || 0) > 0) return 'Ví có cờ cảnh báo từ lần thu hồi điểm trước.';
  return null;
}
