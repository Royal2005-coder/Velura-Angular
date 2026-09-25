import { Component, computed, inject, input, output, signal } from '@angular/core';
import {
  AdminApiService,
  AdminCategoryRow,
  AdminPromotionRow,
  AdminVoucherRow,
} from '../../core/admin-api.service';
import { adminErrorMessage } from '../../core/admin-http';

/** Một dòng trong cây danh mục, đã tính sẵn độ sâu để thụt lề. */
export interface CategoryOption {
  id: string;
  name: string;
  depth: number;
}

/** Mã chỉ gồm chữ hoa, số, gạch ngang và gạch dưới, như mã khách gõ ở bước thanh toán. */
const CODE_PATTERN = /^[A-Z0-9_-]{3,30}$/;

/**
 * Xếp danh mục thành cây theo `parent_id`, cha đứng trước các con.
 *
 * Danh mục mồ côi (cha đã bị xoá) vẫn hiện ở gốc, để mã đang gắn với nó không bị mất
 * dấu trên form. Có vòng lặp dữ liệu thì mỗi nút chỉ in một lần.
 */
export function flattenCategoryTree(rows: AdminCategoryRow[]): CategoryOption[] {
  const ids = new Set(rows.map((row) => row.category_id));
  const children = new Map<string, AdminCategoryRow[]>();
  const roots: AdminCategoryRow[] = [];
  for (const row of rows) {
    const parent = row.parent_id && ids.has(row.parent_id) ? row.parent_id : null;
    if (!parent) {
      roots.push(row);
      continue;
    }
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  const byName = (a: AdminCategoryRow, b: AdminCategoryRow) => a.name.localeCompare(b.name, 'vi');
  const seen = new Set<string>();
  const out: CategoryOption[] = [];
  const walk = (row: AdminCategoryRow, depth: number): void => {
    if (seen.has(row.category_id)) return;
    seen.add(row.category_id);
    out.push({ id: row.category_id, name: row.name, depth });
    for (const child of [...(children.get(row.category_id) ?? [])].sort(byName)) walk(child, depth + 1);
  };
  for (const root of [...roots].sort(byName)) walk(root, 0);
  return out;
}

/** Đọc `applicable_categories` (mảng JSON hoặc chuỗi JSON) thành danh sách mã danh mục. */
export function voucherCategoryIds(value: unknown): string[] {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
}

/**
 * Form tạo và sửa một mã giảm giá.
 *
 * Trước đây bảng mã chỉ có một dòng nhập nhanh (mã, loại, giá trị, đơn tối thiểu, đối
 * tượng) và không sửa được gì sau khi phát. Trần giảm, tổng lượt, lượt mỗi khách, danh
 * mục áp dụng, khung thời gian và chiến dịch cha đều phải chỉnh thẳng trong cơ sở dữ
 * liệu. Form này nói đúng những gì engine chọn mã ở bước thanh toán đang đọc.
 *
 * `voucher` null là tạo mới. Mã (`code`) chỉ đặt lúc tạo vì khách có thể đã lưu mã đó.
 */
@Component({
  selector: 'app-voucher-form',
  templateUrl: './voucher-form.html',
})
export class VoucherForm {
  private readonly api = inject(AdminApiService);

  readonly voucher = input<AdminVoucherRow | null>(null);
  readonly campaigns = input<AdminPromotionRow[]>([]);
  readonly categories = input<AdminCategoryRow[]>([]);
  readonly canMutate = input(false);

  readonly saved = output<void>();
  readonly closed = output<void>();

  readonly saving = signal(false);
  readonly saveError = signal<string | null>(null);
  readonly discountType = signal('fixed_amount');
  readonly promoId = signal('');
  readonly selectedCategories = signal<string[]>([]);

  readonly isEdit = computed(() => !!this.voucher());
  readonly title = computed(() => (this.isEdit() ? `Sửa mã ${this.voucher()?.code ?? ''}` : 'Tạo mã giảm giá'));
  readonly categoryOptions = computed(() => flattenCategoryTree(this.categories()));
  /** Trần giảm chỉ có nghĩa với mã phần trăm; mã cố định đã tự là trần của chính nó. */
  readonly showMaxDiscount = computed(() => this.discountType() === 'percentage');
  readonly showValue = computed(() => this.discountType() !== 'free_shipping');

  /**
   * Chiến dịch cha còn phát được bao nhiêu mã (KAN-54).
   *
   * RPC mới là nơi chốt trần. Con số này chỉ để người vận hành biết trước, khỏi điền
   * cả form rồi mới nhận `VOUCHER_LIMIT_REACHED`. Mã đang sửa vốn đã thuộc chiến dịch
   * đó thì không tính là phát thêm.
   */
  readonly campaignCapacity = computed<string | null>(() => {
    const id = this.promoId();
    if (!id) return null;
    const campaign = this.campaigns().find((row) => (row.promo_id || row.promotion_id) === id);
    if (!campaign) return null;
    const allowed = Number(campaign.max_vouchers_allowed || 0);
    if (allowed <= 0) return 'Chiến dịch không đặt trần số mã.';
    const alreadyInside = this.voucher()?.promo_id === id;
    const remaining = Math.max(0, allowed - Number(campaign.voucher_count || 0));
    if (alreadyInside) return `Chiến dịch phát tối đa ${allowed} mã, mã này đã nằm trong đó.`;
    if (remaining === 0) return `Chiến dịch đã phát đủ ${allowed} mã. Nâng trần số mã của chiến dịch trước.`;
    return `Chiến dịch còn phát được ${remaining} mã (trần ${allowed}).`;
  });
  readonly campaignFull = computed(() => {
    const id = this.promoId();
    const campaign = this.campaigns().find((row) => (row.promo_id || row.promotion_id) === id);
    if (!campaign || this.voucher()?.promo_id === id) return false;
    const allowed = Number(campaign.max_vouchers_allowed || 0);
    return allowed > 0 && Number(campaign.voucher_count || 0) >= allowed;
  });

  ngOnInit(): void {
    const current = this.voucher();
    this.discountType.set(current?.discount_type || current?.type || 'fixed_amount');
    this.promoId.set(current?.promo_id || '');
    this.selectedCategories.set(voucherCategoryIds(current?.applicable_categories));
  }

  campaignLabel(row: AdminPromotionRow): string {
    return row.promo_name || row.name || row.promo_id || '—';
  }

  campaignValue(row: AdminPromotionRow): string {
    return row.promo_id || row.promotion_id || '';
  }

  isCategorySelected(id: string): boolean {
    return this.selectedCategories().includes(id);
  }

  toggleCategory(id: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.selectedCategories.update((current) =>
      checked ? [...current.filter((value) => value !== id), id] : current.filter((value) => value !== id),
    );
  }

  onTypeChange(event: Event): void {
    this.discountType.set((event.target as HTMLSelectElement).value);
  }

  onCampaignChange(event: Event): void {
    this.promoId.set((event.target as HTMLSelectElement).value);
  }

  /** Chuyển ISO sang giá trị mà input datetime-local đọc được (giờ địa phương). */
  toLocalInput(value: string | undefined | null): string {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    const offsetMs = parsed.getTimezoneOffset() * 60_000;
    return new Date(parsed.getTime() - offsetMs).toISOString().slice(0, 16);
  }

  close(): void {
    this.closed.emit();
  }

  /**
   * Kiểm trước những gì RPC sẽ từ chối, rồi gửi. Mã mới luôn ở trạng thái bật nhưng chỉ
   * có hiệu lực trong khung thời gian và khi chiến dịch cha đang chạy.
   */
  submit(event: Event): void {
    event.preventDefault();
    if (!this.canMutate()) {
      this.saveError.set('Vai trò hiện tại không được sửa khuyến mãi.');
      return;
    }
    const form = event.target as HTMLFormElement;
    const read = (field: string): string =>
      ((form.elements.namedItem(field) as HTMLInputElement | null)?.value || '').trim();
    const payload = this.buildPayload(read);
    if (typeof payload === 'string') {
      this.saveError.set(payload);
      return;
    }

    this.saving.set(true);
    this.saveError.set(null);
    const current = this.voucher();
    const request$ = current
      ? this.api.updateVoucher(current.voucher_id, { ...payload, ...this.clearFlags(current, payload), expectedVersion: current.version })
      : this.api.createVoucher(payload);
    request$.subscribe({
      next: () => {
        this.saving.set(false);
        this.saved.emit();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.saveError.set(adminErrorMessage(error, 'Không lưu được mã giảm giá.'));
      },
    });
  }

  /** Dựng body gửi API, hoặc trả câu báo lỗi đầu tiên. */
  private buildPayload(read: (field: string) => string): Record<string, unknown> | string {
    const code = read('code').toUpperCase();
    if (!this.isEdit() && !CODE_PATTERN.test(code)) {
      return 'Mã dài 3 đến 30 ký tự, chỉ gồm chữ không dấu, số, gạch ngang hoặc gạch dưới.';
    }
    const type = this.discountType();
    const value = type === 'free_shipping' ? 0 : Number(read('value'));
    if (type !== 'free_shipping' && (!Number.isFinite(value) || value <= 0)) {
      return 'Giá trị giảm phải lớn hơn 0.';
    }
    if (type === 'percentage' && value > 100) return 'Giảm theo phần trăm không được vượt 100%.';

    const minOrderValue = Number(read('minOrderValue') || 0);
    const maxDiscountRaw = read('maxDiscount');
    const maxDiscount = this.showMaxDiscount() && maxDiscountRaw ? Number(maxDiscountRaw) : null;
    if (minOrderValue < 0 || (maxDiscount !== null && maxDiscount < 0)) return 'Số tiền không được là số âm.';

    const maxUsesRaw = read('maxUses');
    const maxUses = maxUsesRaw ? Number(maxUsesRaw) : null;
    const maxPerUser = Number(read('maxPerUser') || 1);
    if ((maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) || !Number.isInteger(maxPerUser) || maxPerUser < 1) {
      return 'Số lượt dùng phải là số nguyên từ 1 trở lên.';
    }
    const used = Number(this.voucher()?.used_count || 0);
    if (maxUses !== null && maxUses < used) return `Mã đã được dùng ${used} lượt, tổng lượt mới không được thấp hơn.`;

    const startLocal = read('startDate');
    const endLocal = read('endDate');
    if (!startLocal || !endLocal) return 'Phải có cả ngày bắt đầu và ngày kết thúc.';
    const startDate = new Date(startLocal);
    const endDate = new Date(endLocal);
    if (endDate <= startDate) return 'Ngày kết thúc phải sau ngày bắt đầu.';
    if (this.campaignFull()) return 'Chiến dịch đã phát đủ số mã tối đa. Chọn chiến dịch khác hoặc nâng trần trước.';

    const categories = this.selectedCategories();
    return {
      ...(this.isEdit() ? {} : { code }),
      name: read('name') || code,
      type,
      value,
      maxDiscount,
      minOrderValue,
      maxUses,
      maxPerUser,
      applicableUserGroup: read('applicableUserGroup') || 'all_users',
      // Tạo mới không chọn danh mục thì để trống hẳn; lúc sửa, mảng rỗng là lệnh xoá.
      applicableCategories: categories.length ? categories : this.isEdit() ? [] : null,
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      promoId: this.promoId() || null,
    };
  }

  /**
   * Trường "không giới hạn" bỏ trống lúc sửa phải gửi cờ xoá, vì với RPC null nghĩa là
   * giữ nguyên chứ không phải bỏ trần.
   */
  private clearFlags(current: AdminVoucherRow, payload: Record<string, unknown>): Record<string, boolean> {
    return {
      clearMaxDiscount: payload['maxDiscount'] === null && current.max_discount_amount != null,
      clearMaxUses: payload['maxUses'] === null && current.usage_limit_total != null,
      clearPromo: !payload['promoId'] && !!current.promo_id,
    };
  }
}
