import { Component, computed, inject, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AdminApiService, AdminPricingStatistics, AdminProductRow, AdminPromotionRow, AdminVoucherRow } from '../../core/admin-api.service';
import { adminErrorMessage, adminListCount, adminListRows, adminOffset, adminRangeLabel } from '../../core/admin-http';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminEmptyState } from '../../shared/admin-empty-state';
import { AdminPagination } from '../../shared/admin-pagination';
import { CampaignForm } from './campaign-form';

@Component({
  selector: 'app-admin-promotions-page',
  imports: [AdminEmptyState, AdminPagination, CampaignForm],
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
  readonly stats = signal<AdminPricingStatistics | null>(null);
  readonly statsLoading = signal(false);
  readonly statsError = signal<string | null>(null);

  /** Form tạo/sửa chiến dịch. `editing` bằng null nghĩa là đang tạo mới. */
  readonly formOpen = signal(false);
  readonly editing = signal<AdminPromotionRow | null>(null);

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
    if (view === 'stats' && !this.stats() && !this.statsLoading()) {
      this.loadStats();
    }
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
   * Phần trăm ngân sách chiến dịch đã tiêu, dùng cho thanh tiến độ.
   *
   * Trước migration 025 con số này luôn bằng 0 vì tổng tiền đã giảm không có nơi nào
   * cộng dồn. Giờ nó phản ánh số tiền thật đã phát ra cho khách.
   */
  campaignBudgetPercent(row: AdminPromotionRow): number {
    const limit = Number(row.budget_limit ?? row.budget ?? 0);
    if (limit <= 0) return 0;
    const issued = Number(row.total_discount_issued || 0);
    return Math.min(100, Math.round((issued * 100) / limit));
  }

  /** Ngân sách sắp cạn — cảnh báo trước khi chiến dịch tự dừng. */
  isBudgetNearLimit(row: AdminPromotionRow): boolean {
    const percent = this.campaignBudgetPercent(row);
    return percent >= 80 && percent < 100;
  }

  /** Ngân sách đã cạn: hệ thống tự dừng chiến dịch. */
  isBudgetExhausted(row: AdminPromotionRow): boolean {
    return this.campaignBudgetPercent(row) >= 100;
  }

  /**
   * Trạng thái vòng đời thật của chiến dịch.
   *
   * Bản cũ chỉ đọc cờ bật/tắt nên một chiến dịch đã hết hạn vẫn hiện "Đang hoạt động"
   * mãi mãi, dù mã của nó đã bị từ chối ở bước thanh toán — hai nơi nói hai chuyện
   * khác nhau về cùng một chiến dịch.
   */
  campaignLifecycle(row: AdminPromotionRow): 'scheduled' | 'running' | 'ended' | 'paused' | 'budget_exhausted' {
    const now = Date.now();
    const start = this.toTime(row.start_date || row.starts_at);
    const end = this.toTime(row.end_date || row.ends_at);

    if (end !== null && now > end) return 'ended';
    if (this.isBudgetExhausted(row)) return 'budget_exhausted';
    if (!this.isCampaignActive(row)) {
      return start !== null && now < start ? 'scheduled' : 'paused';
    }
    if (start !== null && now < start) return 'scheduled';
    return 'running';
  }

  /** Nhãn tiếng Việt cho trạng thái vòng đời. */
  campaignLifecycleLabel(row: AdminPromotionRow): string {
    const labels: Record<string, string> = {
      scheduled: 'Đã lên lịch',
      running: 'Đang chạy',
      ended: 'Đã kết thúc',
      paused: 'Tạm dừng thủ công',
      budget_exhausted: 'Hết ngân sách',
    };
    return labels[this.campaignLifecycle(row)] ?? 'Không rõ';
  }

  private toTime(value: unknown): number | null {
    if (!value) return null;
    const time = new Date(String(value)).getTime();
    return Number.isNaN(time) ? null : time;
  }

  /**
   * Tải số liệu thống kê cho tab Thống kê.
   */
  loadStats(): void {
    this.statsLoading.set(true);
    this.statsError.set(null);
    this.api.pricingStatistics().subscribe({
      next: (payload) => {
        this.statsLoading.set(false);
        this.stats.set(payload);
      },
      error: (error: unknown) => {
        this.statsLoading.set(false);
        this.statsError.set(adminErrorMessage(error));
      },
    });
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

  /** Mở form tạo chiến dịch mới. */
  openCreate(): void {
    this.editing.set(null);
    this.formOpen.set(true);
  }

  /** Mở form sửa một chiến dịch có sẵn. */
  openEdit(row: AdminPromotionRow): void {
    this.editing.set(row);
    this.formOpen.set(true);
  }

  /** Đóng form, không lưu gì. */
  closeForm(): void {
    this.formOpen.set(false);
    this.editing.set(null);
  }

  /**
   * Lưu xong thì đóng form và tải lại bảng — bản ghi vừa lưu đã tăng `version`, giữ
   * lại bản cũ trên màn hình sẽ khiến thao tác kế tiếp vấp lỗi phiên bản.
   */
  onCampaignSaved(): void {
    this.closeForm();
    this.reload();
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
