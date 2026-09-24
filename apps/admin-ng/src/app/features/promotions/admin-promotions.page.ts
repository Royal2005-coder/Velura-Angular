import { Component, computed, inject, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import {
  AdminApiService,
  AdminAuditRow,
  AdminCategoryRow,
  AdminPricingStatistics,
  AdminProductRow,
  AdminPromotionListPayload,
  AdminPromotionRow,
  AdminPromotionSummary,
  AdminVoucherRow,
} from '../../core/admin-api.service';
import { adminDateTime } from '../../core/admin-format';
import { adminErrorMessage, adminListCount, adminListRows, adminOffset, adminRangeLabel } from '../../core/admin-http';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminEmptyState } from '../../shared/admin-empty-state';
import { AdminPagination } from '../../shared/admin-pagination';
import { CampaignForm } from './campaign-form';
import { VoucherForm, voucherCategoryIds } from './voucher-form';

@Component({
  selector: 'app-admin-promotions-page',
  imports: [AdminEmptyState, AdminPagination, CampaignForm, VoucherForm],
  templateUrl: './admin-promotions.page.html',
})
export class AdminPromotionsPage {
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionService);

  readonly view = signal<'campaigns' | 'vouchers' | 'bundles' | 'logs' | 'stats'>('campaigns');
  readonly promotions = signal<AdminPromotionRow[]>([]);
  readonly vouchers = signal<AdminVoucherRow[]>([]);
  readonly bundles = signal<AdminProductRow[]>([]);
  /**
   * Chiến dịch loại `combo_discount` — phần thật sự thuộc phân hệ khuyến mãi.
   *
   * Tách khỏi `bundles` (sản phẩm có cờ `is_combo`) vì hai thứ này chưa liên kết được
   * với nhau: bảng `promotion_product` tồn tại nhưng chưa đường ghi nào điền vào
   * (GA-A4-02 / KAN-68). Hiển thị chung một bảng như trước là để người vận hành hiểu
   * nhầm rằng sản phẩm combo đang chịu tác động của chiến dịch combo.
   */
  readonly comboCampaigns = signal<AdminPromotionRow[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly loading = signal(true);
  readonly page = signal(1);
  readonly pageSize = 10;
  readonly promoCount = signal(0);
  readonly voucherCount = signal(0);
  readonly canMutate = computed(() => this.session.canMutate('promotions'));
  /**
   * Toàn bộ chiến dịch (tối đa 100) cho ô chọn chiến dịch cha và bộ lọc bảng mã.
   * `promotions()` chỉ là trang đang xem nên không dùng được cho việc này.
   */
  readonly allCampaigns = signal<AdminPromotionRow[]>([]);
  readonly categories = signal<AdminCategoryRow[]>([]);
  /** Lọc bảng mã theo chiến dịch: rỗng là tất cả, `none` là mã đứng riêng. */
  readonly voucherPromoFilter = signal('');
  readonly voucherFormOpen = signal(false);
  readonly editingVoucher = signal<AdminVoucherRow | null>(null);
  readonly stats = signal<AdminPricingStatistics | null>(null);
  readonly statsLoading = signal(false);
  readonly statsError = signal<string | null>(null);

  // Tab "Nhật ký" trước đây là một khung rỗng cố định với dòng chữ "Nhật ký khuyến mãi
  // nằm trong phân hệ Nhật ký hệ thống" — trong khi API đã có sẵn
  // `/api/v1/admin/pricing/audit-logs` trả về đúng nhật ký của phân hệ này.
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly logsCount = signal(0);
  readonly logsLoading = signal(false);
  readonly logsError = signal<string | null>(null);
  readonly logPageCount = computed(() => Math.max(1, Math.ceil(this.logsCount() / this.pageSize)));
  readonly logRange = computed(() => adminRangeLabel(this.logsCount(), this.page(), this.pageSize, 'nhật ký'));

  /** Form tạo/sửa chiến dịch. `editing` bằng null nghĩa là đang tạo mới. */
  readonly formOpen = signal(false);
  readonly editing = signal<AdminPromotionRow | null>(null);

  /**
   * Chỉ số do API tính trên toàn bộ chiến dịch.
   *
   * Trước đây năm con số này là `computed` cộng trên `promotions()` — tức trên đúng 10
   * bản ghi của trang đang xem. Với 8 chiến dịch thì tình cờ đúng; sang trang 2 hoặc
   * khi có hơn 10 chiến dịch thì mọi con số ở đầu trang đều sai.
   */
  readonly summary = signal<AdminPromotionSummary | null>(null);
  readonly activeCampaigns = computed(() => this.summary()?.running ?? 0);
  readonly pendingCampaigns = computed(() => {
    const s = this.summary();
    if (!s) return 0;
    return s.scheduled + s.paused + s.ended + s.budgetExhausted;
  });
  readonly activeVouchers = computed(() => this.summary()?.activeVouchers ?? 0);
  readonly issuedDiscount = computed(() => this.summary()?.issuedDiscount ?? 0);
  readonly totalBudget = computed(() => this.summary()?.totalBudget ?? 0);
  /** Có chiến dịch nào không đặt trần ngân sách hay không — để chú thích tổng ngân sách. */
  readonly hasUnbudgetedCampaigns = computed(() => {
    const s = this.summary();
    return Boolean(s && s.total > s.budgetedCampaigns);
  });
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
    if (view === 'logs') {
      this.loadLogs();
    }
  }

  /**
   * Tải nhật ký phân hệ giá & khuyến mãi.
   */
  loadLogs(): void {
    this.logsLoading.set(true);
    this.logsError.set(null);
    this.api
      .listPricingAuditLogs({ limit: String(this.pageSize), offset: adminOffset(this.page(), this.pageSize) })
      .subscribe({
        next: (payload) => {
          this.logs.set(adminListRows(payload));
          this.logsCount.set(adminListCount(payload));
          this.logsLoading.set(false);
        },
        error: (error: unknown) => {
          this.logsError.set(adminErrorMessage(error));
          this.logsLoading.set(false);
        },
      });
  }

  /**
   * Thời điểm của một dòng nhật ký, đọc theo giờ Việt Nam.
   */
  logTime(value: string | undefined): string {
    return adminDateTime(value);
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
          : this.view() === 'logs'
            ? this.logPageCount()
            : this.campaignPageCount();
    this.page.set(Math.min(count, Math.max(1, page)));
    if (this.view() === 'logs') {
      this.loadLogs();
      return;
    }
    if (this.view() !== 'bundles' && this.view() !== 'stats') {
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
    return this.campaignLifecycle(row) === 'running';
  }

  /**
   * Chiến dịch có thao tác bật/tắt nào hợp lệ không.
   *
   * Chiến dịch đã hết hạn hoặc cạn ngân sách thì RPC từ chối cả hai chiều, nên ẩn nút
   * đi thay vì mời bấm rồi trả lỗi `OUTSIDE_DATE_RANGE`.
   */
  canToggleCampaign(row: AdminPromotionRow): boolean {
    return Boolean(row.can_pause || row.can_activate);
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
    // Không đặt trần thì nói thẳng là không giới hạn; "0đ / 0đ" khiến admin tưởng
    // chiến dịch hỏng dữ liệu.
    if (row.budget_unlimited) {
      return `${this.money(row.total_discount_issued)} / Không giới hạn`;
    }
    return `${this.money(row.total_discount_issued)} / ${this.money(row.budget_limit ?? row.budget)}`;
  }

  /**
   * Số mã của chiến dịch, vì đó là thứ quyết định chiến dịch có tác dụng thật hay không.
   */
  voucherCoverage(row: AdminPromotionRow): string {
    const total = row.voucher_count ?? 0;
    if (!total) return 'Chưa có mã nào';
    return `${row.active_voucher_count ?? 0}/${total} mã còn hiệu lực`;
  }

  /** Cảnh báo do API tính sẵn cho từng chiến dịch. */
  campaignWarnings(row: AdminPromotionRow): Array<{ code: string; level: string; message: string }> {
    return row.warnings ?? [];
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
    return row.lifecycle_status ?? 'paused';
  }

  /** Nhãn tiếng Việt cho trạng thái vòng đời. */
  campaignLifecycleLabel(row: AdminPromotionRow): string {
    return row.lifecycle_label || 'Không rõ';
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
   * Who may use the code at checkout: guests, members, or both.
   */
  voucherAudience(row: AdminVoucherRow): string {
    const group = row.applicable_user_group || 'all_users';
    if (group === 'guest') {
      return 'Khách vãng lai';
    }
    if (group === 'all_users') {
      return 'Mọi khách';
    }
    return 'Thành viên';
  }

  /** Tên chiến dịch cha của một mã, để bảng mã nói mã thuộc đợt nào. */
  voucherCampaign(row: AdminVoucherRow): string {
    if (!row.promo_id) return 'Mã đứng riêng';
    const campaign = this.allCampaigns().find((item) => (item.promo_id || item.promotion_id) === row.promo_id);
    return campaign ? this.campaignName(campaign) : 'Chiến dịch không còn';
  }

  /** Danh mục áp dụng, hoặc "Cả giỏ" khi mã không giới hạn danh mục. */
  voucherScope(row: AdminVoucherRow): string {
    const ids = voucherCategoryIds(row.applicable_categories);
    if (!ids.length) return 'Cả giỏ';
    const names = ids.map((id) => this.categories().find((item) => item.category_id === id)?.name || 'Danh mục đã xoá');
    return names.join(', ');
  }

  /** Mức giảm kèm trần giảm, vì với mã phần trăm hai số này phải đọc cùng nhau. */
  voucherCap(row: AdminVoucherRow): string {
    if ((row.discount_type || row.type) !== 'percentage') return '—';
    return row.max_discount_amount != null ? this.money(row.max_discount_amount) : 'Không giới hạn';
  }

  /** Khung thời gian hiệu lực của mã. */
  voucherPeriod(row: AdminVoucherRow): string {
    return `${this.date(row.start_date)} - ${this.date(row.end_date || row.expires_at)}`;
  }

  setVoucherPromoFilter(event: Event): void {
    this.voucherPromoFilter.set((event.target as HTMLSelectElement).value);
    this.page.set(1);
    this.reload();
  }

  openVoucherCreate(): void {
    this.editingVoucher.set(null);
    this.voucherFormOpen.set(true);
  }

  openVoucherEdit(row: AdminVoucherRow): void {
    this.editingVoucher.set(row);
    this.voucherFormOpen.set(true);
  }

  closeVoucherForm(): void {
    this.voucherFormOpen.set(false);
    this.editingVoucher.set(null);
  }

  /** Lưu xong thì tải lại: mã vừa sửa đã tăng `version`, số mã của chiến dịch cũng đổi. */
  onVoucherSaved(): void {
    this.closeVoucherForm();
    this.reload();
  }

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
    const request$ = row.can_pause
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
    const voucherParams = this.voucherPromoFilter() ? { ...pageParams, promoId: this.voucherPromoFilter() } : pageParams;
    forkJoin({
      promotions: this.api.listPromotions(pageParams).pipe(catchError((error: unknown) => {
        this.loadError.set(adminErrorMessage(error));
        return of({ rows: [] as AdminPromotionRow[], count: 0, summary: undefined } as AdminPromotionListPayload);
      })),
      vouchers: this.api.listVouchers(voucherParams).pipe(catchError((error: unknown) => {
        this.loadError.set(adminErrorMessage(error));
        return of({ rows: [] as AdminVoucherRow[], count: 0 });
      })),
      allCampaigns: this.api
        .listPromotions({ limit: '100' })
        .pipe(catchError(() => of({ rows: [] as AdminPromotionRow[], count: 0 } as AdminPromotionListPayload))),
      categories: this.api.listCategories().pipe(catchError(() => of({ rows: [] as AdminCategoryRow[] }))),
      products: this.api.listProducts({ isCombo: 'true', limit: '100' }).pipe(catchError(() => of({ rows: [] as AdminProductRow[] }))),
      // Tab Combo trước đây chỉ liệt kê sản phẩm có cờ `is_combo` và gọi đó là combo
      // khuyến mãi. Đó là hai thứ khác nhau: chiến dịch loại `combo_discount` mới là
      // phần thuộc phân hệ này. Lấy cả hai để nói đúng từng thứ là gì.
      comboCampaigns: this.api
        .listPromotions({ type: 'combo_discount', limit: '100' })
        .pipe(catchError(() => of({ rows: [] as AdminPromotionRow[], count: 0 } as AdminPromotionListPayload))),
    }).subscribe((payload) => {
      this.promotions.set(adminListRows(payload.promotions));
      this.summary.set(payload.promotions.summary ?? null);
      this.vouchers.set(adminListRows(payload.vouchers));
      this.promoCount.set(adminListCount(payload.promotions));
      this.voucherCount.set(adminListCount(payload.vouchers));
      this.bundles.set(adminListRows(payload.products).filter((row) => row.is_combo));
      this.comboCampaigns.set(adminListRows(payload.comboCampaigns));
      this.allCampaigns.set(adminListRows(payload.allCampaigns));
      this.categories.set(adminListRows(payload.categories));
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
