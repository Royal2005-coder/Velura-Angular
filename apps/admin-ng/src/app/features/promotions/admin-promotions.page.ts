import { Component, computed, inject, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AdminApiService, AdminProductRow, AdminPromotionRow, AdminVoucherRow } from '../../core/admin-api.service';
import { adminErrorMessage, adminListCount, adminListRows, adminOffset, adminRangeLabel } from '../../core/admin-http';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminEmptyState } from '../../shared/admin-empty-state';
import { AdminIcon } from '../../shared/admin-icon';
import { AdminPagination } from '../../shared/admin-pagination';

@Component({
  selector: 'app-admin-promotions-page',
  imports: [AdminEmptyState, AdminIcon, AdminPagination],
  templateUrl: './admin-promotions.page.html',
})
export class AdminPromotionsPage {
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionService);

  readonly view = signal<'campaigns' | 'vouchers' | 'bundles' | 'logs' | 'stats'>('campaigns');
  readonly promotions = signal<AdminPromotionRow[]>([]);
  readonly vouchers = signal<AdminVoucherRow[]>([]);
  readonly bundles = signal<AdminProductRow[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly loading = signal(true);
  readonly page = signal(1);
  readonly pageSize = 10;
  readonly promoCount = signal(0);
  readonly voucherCount = signal(0);
  readonly canMutate = computed(() => this.session.canMutate('promotions'));

  readonly activeCampaigns = computed(() => this.promotions().filter((row) => this.isCampaignActive(row)).length);
  readonly pendingCampaigns = computed(() => this.promotions().length - this.activeCampaigns());
  readonly activeVouchers = computed(() => this.vouchers().filter((row) => row.is_active !== false).length);
  readonly issuedDiscount = computed(() =>
    this.promotions().reduce((sum, row) => sum + Number(row.total_discount_issued || 0), 0),
  );
  readonly totalBudget = computed(() =>
    this.promotions().reduce((sum, row) => sum + Number(row.budget_limit ?? row.budget ?? 0), 0),
  );
  readonly campaignPageCount = computed(() => Math.max(1, Math.ceil(this.promoCount() / this.pageSize)));
  readonly voucherPageCount = computed(() => Math.max(1, Math.ceil(this.voucherCount() / this.pageSize)));
  readonly bundlePageCount = computed(() => Math.max(1, Math.ceil(this.bundles().length / this.pageSize)));
  readonly pagedCampaigns = computed(() => this.promotions());
  readonly pagedVouchers = computed(() => this.vouchers());
  readonly pagedBundles = computed(() => this.slicePage(this.bundles()));
  readonly campaignRange = computed(() => adminRangeLabel(this.promoCount(), this.page(), this.pageSize, 'chiến dịch'));
  readonly voucherRange = computed(() => adminRangeLabel(this.voucherCount(), this.page(), this.pageSize, 'mã giảm giá'));
  readonly bundleRange = computed(() => this.rangeText(this.bundles().length, 'combo'));

  constructor() {
    this.reload();
  }

  /**
   * Switches the original promotion workspace.
   */
  setView(view: 'campaigns' | 'vouchers' | 'bundles' | 'logs' | 'stats'): void {
    this.view.set(view);
    this.page.set(1);
  }

  /**
   * Moves promotion-list pagination.
   */
  goPage(page: number): void {
    const count =
      this.view() === 'vouchers'
        ? this.voucherPageCount()
        : this.view() === 'bundles'
          ? this.bundlePageCount()
          : this.campaignPageCount();
    this.page.set(Math.min(count, Math.max(1, page)));
    if (this.view() !== 'bundles' && this.view() !== 'logs' && this.view() !== 'stats') {
      this.reload();
    }
  }

  /**
   * Formats VND for promotion KPIs.
   */
  money(value: number | undefined): string {
    return `${Number(value || 0).toLocaleString('vi-VN')}₫`;
  }

  /**
   * Whether a campaign is live in the original promotions table.
   */
  isCampaignActive(row: AdminPromotionRow): boolean {
    return row.is_active !== false && row.status !== 'inactive';
  }

  /**
   * Campaign title used by the original table.
   */
  campaignName(row: AdminPromotionRow): string {
    return row.promo_name || row.name || row.promo_id || row.promotion_id || '—';
  }

  /**
   * Campaign type label used by the original table.
   */
  campaignType(row: AdminPromotionRow): string {
    const type = row.promo_type || row.type || '';
    if (type === 'flash_sale') {
      return 'Flash Sale';
    }
    if (type === 'combo_discount') {
      return 'Giảm giá Combo';
    }
    if (type === 'product_discount') {
      return 'Giảm giá sản phẩm';
    }
    if (type === 'seasonal_sale') {
      return 'Giảm giá theo mùa';
    }
    return type || '—';
  }

  /**
   * Campaign window used by the original table.
   */
  campaignPeriod(row: AdminPromotionRow): string {
    return `${this.date(row.start_date || row.starts_at)} - ${this.date(row.end_date || row.ends_at)}`;
  }

  /**
   * Budget used / limit for the original table.
   */
  campaignBudget(row: AdminPromotionRow): string {
    return `${this.money(row.total_discount_issued)} / ${this.money(row.budget_limit ?? row.budget)}`;
  }

  /**
   * Voucher discount display.
   */
  voucherValue(row: AdminVoucherRow): string {
    const type = row.discount_type || row.type;
    const value = row.discount_value ?? row.value ?? 0;
    if (type === 'percentage') {
      return `${value}%`;
    }
    if (type === 'free_shipping') {
      return 'Miễn phí vận chuyển';
    }
    return this.money(value);
  }

  /**
   * Campaign status label used by the original table.
   */
  campaignStatus(row: AdminPromotionRow): string {
    return this.isCampaignActive(row) ? 'Đang hoạt động' : 'Tạm dừng';
  }

  /**
   * Voucher status label used by the original table.
   */
  voucherStatus(row: AdminVoucherRow): string {
    return row.is_active === false ? 'Tạm dừng' : 'Đang hoạt động';
  }

  /**
   * Voucher type label used by the original table.
   */
  voucherType(row: AdminVoucherRow): string {
    const type = row.discount_type || row.type || '';
    if (type === 'percentage') {
      return 'Theo phần trăm';
    }
    if (type === 'fixed_amount') {
      return 'Số tiền cố định';
    }
    if (type === 'free_shipping') {
      return 'Miễn phí vận chuyển';
    }
    return type || '—';
  }

  /**
   * Combo status label used by the original table.
   */
  bundleStatus(row: AdminProductRow): string {
    return row.status === 'on_sale' ? 'Đang hoạt động' : 'Tạm dừng';
  }

  /**
   * Voucher usage counter for the original table.
   */
  voucherUsage(row: AdminVoucherRow): string {
    return `${row.used_count || 0} / ${row.usage_limit_total || '∞'}`;
  }

  /**
   * Selling price shown on combo rows.
   */
  sellingPrice(basePrice: number | undefined, salePrice: number | null | undefined): string {
    return this.money(salePrice || basePrice);
  }

  /**
   * Activates or pauses a campaign through the original promotions API.
   */
  toggleCampaign(row: AdminPromotionRow): void {
    const promoId = row.promo_id || row.promotion_id;
    if (!promoId || row.version == null) {
      this.loadError.set('Thiếu phiên bản chiến dịch để thao tác.');
      return;
    }
    const request$ = this.isCampaignActive(row)
      ? this.api.pausePromotion(promoId, { expectedVersion: row.version })
      : this.api.activatePromotion(promoId, { expectedVersion: row.version });
    request$.subscribe({
      next: () => this.reload(),
      error: (error: unknown) => this.loadError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Toggles a voucher through the original promotions API.
   */
  toggleVoucher(row: AdminVoucherRow): void {
    this.api.toggleVoucher(row.voucher_id).subscribe({
      next: () => this.reload(),
      error: (error: unknown) => this.loadError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Reloads campaigns and vouchers after a mutation.
   */
  reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    const pageParams = { limit: String(this.pageSize), offset: adminOffset(this.page(), this.pageSize) };
    forkJoin({
      promotions: this.api.listPromotions(pageParams).pipe(catchError((error: unknown) => {
        this.loadError.set(adminErrorMessage(error));
        return of({ rows: [] as AdminPromotionRow[], count: 0 });
      })),
      vouchers: this.api.listVouchers(pageParams).pipe(catchError(() => of({ rows: [] as AdminVoucherRow[], count: 0 }))),
      products: this.api.listProducts({ isCombo: 'true', limit: '100' }).pipe(catchError(() => of({ rows: [] as AdminProductRow[] }))),
    }).subscribe((payload) => {
      this.promotions.set(adminListRows(payload.promotions));
      this.vouchers.set(adminListRows(payload.vouchers));
      this.promoCount.set(adminListCount(payload.promotions));
      this.voucherCount.set(adminListCount(payload.vouchers));
      this.bundles.set(adminListRows(payload.products).filter((row) => row.is_combo));
      this.loading.set(false);
    });
  }

  /**
   * Formats a date with the original admin locale.
   */
  date(value: string | undefined): string {
    if (!value) {
      return '—';
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  }

  private slicePage<T>(rows: T[]): T[] {
    const start = (this.page() - 1) * this.pageSize;
    return rows.slice(start, start + this.pageSize);
  }

  private rangeText(total: number, noun: string): string {
    if (!total) {
      return `Hiển thị 0 - 0 / 0 ${noun}`;
    }
    const start = (this.page() - 1) * this.pageSize + 1;
    const end = Math.min(this.page() * this.pageSize, total);
    return `Hiển thị ${start} - ${end} / ${total} ${noun}`;
  }
}
