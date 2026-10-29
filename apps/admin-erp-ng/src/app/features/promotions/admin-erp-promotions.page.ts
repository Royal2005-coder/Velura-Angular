import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { catchError, finalize, of } from 'rxjs';
import {
  AdminAuditRow,
  AdminErpApiService,
  AdminPricingStatistics,
  AdminPromotionRow,
  AdminPromotionSummary,
  AdminVoucherRow,
} from '../../core/admin-erp-api.service';
import { adminDateTime, adminMoney } from '../../core/admin-erp-format';
import { useWorkspaceRefresh } from '../../core/admin-erp-refresh.service';
import {
  adminErrorMessage,
  adminListCount,
  adminListRows,
  adminOffset,
  adminRangeLabel,
} from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { AdminErpDataTable, AdminTableColumn } from '../../shared/ui/admin-data-table';
import { AdminErpFilterBar } from '../../shared/ui/admin-filter-bar';
import { AdminErpDrawer } from '../../shared/ui/admin-drawer';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AdminErpKpiCard } from '../../shared/ui/admin-kpi-card';
import { AdminErpModal } from '../../shared/ui/admin-modal';
import { AdminErpPageHeader } from '../../shared/ui/admin-page-header';
import { AdminErpPagination } from '../../shared/ui/admin-pagination';
import { AdminErpStatusBadge } from '../../shared/ui/admin-status-badge';
import { AdminErpTab, AdminErpTabs } from '../../shared/ui/admin-tabs';

type PromoView = 'campaigns' | 'vouchers' | 'logs' | 'stats';
const EMPTY_CAMPAIGNS = { rows: [] as AdminPromotionRow[], count: 0, summary: undefined as AdminPromotionSummary | undefined };
const EMPTY_VOUCHERS = { rows: [] as AdminVoucherRow[], count: 0 };
const EMPTY_LOGS = { rows: [] as AdminAuditRow[], count: 0 };
const CODE_PATTERN = /^[A-Z0-9_-]{3,30}$/;

/**
 * Promotion campaigns, vouchers, statistics and audit on the existing pricing APIs.
 */
@Component({
  selector: 'app-admin-erp-promotions-page',
  imports: [
    AdminErpPageHeader,
    AdminErpKpiCard,
    AdminErpTabs,
    AdminErpDataTable,
    AdminErpFilterBar,
    AdminErpPagination,
    AdminErpDrawer,
    AdminErpModal,
    AdminErpStatusBadge,
    AdminErpIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-erp-promotions.page.html',
  styleUrl: './admin-erp-promotions.page.scss',
})
export class AdminErpPromotionsPage {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);

  readonly view = signal<PromoView>('campaigns');
  readonly query = signal('');
  readonly activeFilter = signal('');
  readonly campaigns = signal<AdminPromotionRow[]>([]);
  readonly campaignOptions = signal<AdminPromotionRow[]>([]);
  readonly campaignLookupError = signal<string | null>(null);
  readonly vouchers = signal<AdminVoucherRow[]>([]);
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly stats = signal<AdminPricingStatistics | null>(null);
  readonly summary = signal<AdminPromotionSummary | null>(null);
  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly page = signal(1);
  readonly pageSize = 10;
  readonly promoCount = signal(0);
  readonly voucherCount = signal(0);
  readonly logsCount = signal(0);
  readonly selectedCampaign = signal<AdminPromotionRow | null>(null);
  readonly selectedVoucher = signal<AdminVoucherRow | null>(null);
  readonly campaignFormOpen = signal(false);
  readonly editingCampaign = signal<AdminPromotionRow | null>(null);
  readonly voucherFormOpen = signal(false);
  readonly editingVoucher = signal<AdminVoucherRow | null>(null);
  readonly formError = signal<string | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly dirty = signal(false);
  readonly discardOpen = signal(false);
  readonly saving = signal(false);
  readonly actionSaving = signal(false);
  readonly statsRange = signal('30');
  readonly canMutate = computed(() => this.session.can('update', 'promotions'));
  readonly statsRanges = [
    { value: '7', label: '7 ngày' },
    { value: '30', label: '30 ngày' },
    { value: '90', label: '90 ngày' },
    { value: 'all', label: 'Toàn bộ' },
  ];

  readonly tabs = computed<readonly AdminErpTab[]>(() => [
    { key: 'campaigns', label: 'Chiến dịch', count: this.promoCount() },
    { key: 'vouchers', label: 'Voucher', count: this.voucherCount() },
    { key: 'logs', label: 'Nhật ký' },
    { key: 'stats', label: 'Thống kê' },
  ]);
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.promoCount() / this.pageSize)));
  readonly voucherPageCount = computed(() => Math.max(1, Math.ceil(this.voucherCount() / this.pageSize)));
  readonly logPageCount = computed(() => Math.max(1, Math.ceil(this.logsCount() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.promoCount(), this.page(), this.pageSize, 'chiến dịch'));
  readonly voucherRangeLabel = computed(() => adminRangeLabel(this.voucherCount(), this.page(), this.pageSize, 'voucher'));
  readonly logRangeLabel = computed(() => adminRangeLabel(this.logsCount(), this.page(), this.pageSize, 'nhật ký'));
  readonly activeCampaigns = computed(() => this.summary()?.running ?? 0);
  readonly activeVouchers = computed(() => this.summary()?.activeVouchers ?? 0);
  readonly totalBudget = computed(() => this.summary()?.totalBudget ?? 0);
  readonly issuedDiscount = computed(() => this.summary()?.issuedDiscount ?? 0);

  readonly campaignColumns: readonly AdminTableColumn[] = [
    { key: 'name', label: 'Chiến dịch', value: (row) => this.campaignName(row as AdminPromotionRow) },
    { key: 'type', label: 'Loại', value: (row) => this.campaignType(row as AdminPromotionRow) },
    {
      key: 'status',
      label: 'Vòng đời',
      value: (row) => this.lifecycleLabel(row as AdminPromotionRow),
      badge: (row) => ({ label: this.lifecycleLabel(row as AdminPromotionRow), tone: this.lifecycleTone(row as AdminPromotionRow) }),
    },
    { key: 'dates', label: 'Thời gian', value: (row) => `${this.date((row as AdminPromotionRow).start_date)} → ${this.date((row as AdminPromotionRow).end_date)}` },
    { key: 'budget', label: 'Ngân sách', value: (row) => this.budgetLabel(row as AdminPromotionRow), align: 'right' },
    { key: 'vouchers', label: 'Voucher', value: (row) => String((row as AdminPromotionRow).voucher_count ?? 0), align: 'right' },
  ];

  readonly voucherColumns: readonly AdminTableColumn[] = [
    { key: 'code', label: 'Mã', value: (row) => (row as AdminVoucherRow).code || '—' },
    { key: 'name', label: 'Tên', value: (row) => (row as AdminVoucherRow).name || '—' },
    { key: 'type', label: 'Loại', value: (row) => this.voucherType(row as AdminVoucherRow) },
    { key: 'value', label: 'Giá trị', value: (row) => this.voucherValue(row as AdminVoucherRow), align: 'right' },
    { key: 'min', label: 'Đơn tối thiểu', value: (row) => this.money((row as AdminVoucherRow).min_order_value ?? (row as AdminVoucherRow).min_order), align: 'right' },
    { key: 'used', label: 'Đã dùng', value: (row) => this.usedLabel(row as AdminVoucherRow), align: 'right' },
    {
      key: 'active',
      label: 'Trạng thái',
      value: (row) => ((row as AdminVoucherRow).is_active ? 'Đang bật' : 'Đang tắt'),
      badge: (row) => ({
        label: (row as AdminVoucherRow).is_active ? 'Đang bật' : 'Đang tắt',
        tone: (row as AdminVoucherRow).is_active ? 'success' : 'neutral',
      }),
    },
  ];

  readonly logColumns: readonly AdminTableColumn[] = [
    { key: 'time', label: 'Thời gian', value: (row) => this.date((row as AdminAuditRow).timestamp) },
    { key: 'actor', label: 'Người thao tác', value: (row) => this.actor(row as AdminAuditRow) },
    { key: 'action', label: 'Hành động', value: (row) => (row as AdminAuditRow).action_label || (row as AdminAuditRow).action || '—' },
    { key: 'target', label: 'Đối tượng', value: (row) => (row as AdminAuditRow).target_label || (row as AdminAuditRow).target_id || '—' },
  ];

  readonly statsCampaignColumns: readonly AdminTableColumn[] = [
    { key: 'name', label: 'Chiến dịch', value: (row) => (row as { name?: string }).name || '—' },
    { key: 'vouchers', label: 'Voucher', value: (row) => String((row as { vouchers?: number }).vouchers ?? 0), align: 'right' },
    { key: 'orders', label: 'Đơn', value: (row) => String((row as { orders?: number }).orders ?? 0), align: 'right' },
    { key: 'revenue', label: 'Doanh thu', value: (row) => this.money((row as { revenue?: number }).revenue), align: 'right' },
    { key: 'discount', label: 'Giảm giá', value: (row) => this.money((row as { discount?: number }).discount), align: 'right' },
  ];
  readonly topVoucherColumns: readonly AdminTableColumn[] = [
    { key: 'code', label: 'Mã', value: (row) => (row as { code?: string }).code || '—' },
    { key: 'orders', label: 'Đơn', value: (row) => String((row as { orders?: number }).orders ?? 0), align: 'right' },
    { key: 'discount', label: 'Giảm giá', value: (row) => this.money((row as { discount?: number }).discount), align: 'right' },
    { key: 'revenue', label: 'Doanh thu', value: (row) => this.money((row as { revenue?: number }).revenue), align: 'right' },
  ];

  constructor() {
    this.reload();
    this.loadCampaignOptions();
    useWorkspaceRefresh(() => this.reload());
  }

  /**
   * Loads the active promotion view.
   */
  reload(): void {
    if (this.view() === 'logs') {
      this.loadLogs();
      return;
    }
    if (this.view() === 'stats') {
      this.loadStats();
      return;
    }
    this.loading.set(true);
    this.loadError.set(null);
    const listParams: Record<string, string> = {
      limit: String(this.pageSize),
      offset: adminOffset(this.page(), this.pageSize),
    };
    if (this.query()) listParams['q'] = this.query();
    if (this.activeFilter()) listParams['isActive'] = this.activeFilter();
    if (this.view() === 'campaigns') {
      this.api.listPromotions(listParams).subscribe({
        next: (payload) => {
          this.campaigns.set(adminListRows(payload));
          this.promoCount.set(adminListCount(payload));
          this.summary.set(payload.summary || null);
          this.loading.set(false);
        },
        error: (error: unknown) => {
          this.loadError.set(adminErrorMessage(error, 'Không tải được chiến dịch.'));
          this.campaigns.set([]);
          this.loading.set(false);
        },
      });
      return;
    }
    this.api.listVouchers(listParams).subscribe({
      next: (payload) => {
        this.vouchers.set(adminListRows(payload));
        this.voucherCount.set(adminListCount(payload));
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loadError.set(adminErrorMessage(error, 'Không tải được voucher.'));
        this.vouchers.set([]);
        this.loading.set(false);
      },
    });
  }

  /**
   * Loads pricing/promotion audit rows.
   */
  loadLogs(): void {
    this.loading.set(true);
    this.api.listPricingAuditLogs({ limit: String(this.pageSize), offset: adminOffset(this.page(), this.pageSize) }).subscribe({
      next: (payload) => {
        this.logs.set(adminListRows(payload));
        this.logsCount.set(adminListCount(payload));
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loadError.set(adminErrorMessage(error, 'Không tải được nhật ký khuyến mãi.'));
        this.loading.set(false);
      },
    });
  }

  /**
   * Loads promotion statistics for the selected range.
   */
  loadStats(): void {
    this.loading.set(true);
    this.loadError.set(null);
    const params: Record<string, string> = {};
    if (this.statsRange() !== 'all') {
      const days = Number(this.statsRange());
      const now = new Date();
      params['from'] = new Date(now.getTime() - days * 86_400_000).toISOString();
      params['to'] = now.toISOString();
    }
    this.api.pricingStatistics(params).subscribe({
      next: (stats) => {
        this.stats.set(stats);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loadError.set(adminErrorMessage(error, 'Không tải được thống kê khuyến mãi.'));
        this.loading.set(false);
      },
    });
  }

  /**
   * Switches promotion views.
   */
  setView(view: string): void {
    if (this.loading()) return;
    if (!['campaigns', 'vouchers', 'logs', 'stats'].includes(view)) return;
    if (this.view() !== view) {
      this.query.set('');
      this.activeFilter.set('');
    }
    this.view.set(view as PromoView);
    this.page.set(1);
    this.reload();
  }

  /**
   * Applies the campaign/voucher search and active-state filters.
   */
  applyFilters(): void {
    this.page.set(1);
    this.reload();
  }

  /**
   * Clears the campaign/voucher filters.
   */
  resetFilters(): void {
    this.query.set('');
    this.activeFilter.set('');
    this.page.set(1);
    this.reload();
  }

  /**
   * Tracks the free-text search field.
   */
  onQueryInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /**
   * Tracks the active-state filter.
   */
  onActiveFilter(event: Event): void {
    this.activeFilter.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Loads every campaign as a lookup for the voucher form. The list endpoint caps a page at
   * 100 rows; the voucher picker must not be limited to the ten campaigns currently paged.
   */
  private loadCampaignOptions(): void {
    this.api.listPromotions({ limit: '100', offset: '0' }).subscribe({
      next: (payload) => {
        this.campaignOptions.set(adminListRows(payload));
        this.campaignLookupError.set(null);
      },
      error: (error: unknown) => {
        this.campaignOptions.set([]);
        this.campaignLookupError.set(adminErrorMessage(error, 'Không tải được danh sách chiến dịch để chọn.'));
      },
    });
  }

  /**
   * Campaign name shown in the create form; empty (not a placeholder dash) for a new campaign.
   */
  campaignFormName(): string {
    const campaign = this.editingCampaign();
    return campaign ? this.campaignName(campaign) : '';
  }

  /**
   * Moves the active list paging.
   */
  goPage(page: number): void {
    this.page.set(Math.max(1, page));
    this.reload();
  }

  /**
   * Changes the statistics range.
   */
  setStatsRange(event: Event): void {
    this.statsRange.set((event.target as HTMLSelectElement).value);
    this.loadStats();
  }

  /**
   * Opens a campaign drawer.
   */
  openCampaign(row: unknown): void {
    this.selectedCampaign.set(row as AdminPromotionRow);
    this.actionError.set(null);
  }

  /**
   * Opens a voucher drawer.
   */
  openVoucher(row: unknown): void {
    this.selectedVoucher.set(row as AdminVoucherRow);
    this.actionError.set(null);
  }

  /**
   * Closes drawers and forms. A dirty form asks before discarding typed changes.
   */
  closeOverlays(): void {
    if (this.dirty()) {
      this.discardOpen.set(true);
      return;
    }
    this.forceClose();
  }

  /**
   * Marks the open campaign/voucher form as edited.
   */
  markDirty(): void {
    this.dirty.set(true);
  }

  /**
   * Confirms discarding the typed changes and closes every overlay.
   */
  confirmDiscard(): void {
    this.discardOpen.set(false);
    this.dirty.set(false);
    this.forceClose();
  }

  /**
   * Keeps the form open after the discard prompt is cancelled.
   */
  cancelDiscard(): void {
    this.discardOpen.set(false);
  }

  private forceClose(): void {
    this.selectedCampaign.set(null);
    this.selectedVoucher.set(null);
    this.campaignFormOpen.set(false);
    this.voucherFormOpen.set(false);
    this.formError.set(null);
    this.actionError.set(null);
    this.dirty.set(false);
    this.discardOpen.set(false);
  }

  /**
   * Opens the campaign create/edit form.
   */
  openCampaignForm(): void {
    if (!this.canMutate()) return;
    this.editingCampaign.set(this.selectedCampaign());
    this.campaignFormOpen.set(true);
    this.formError.set(null);
    this.dirty.set(false);
  }

  /**
   * Opens the voucher create/edit form.
   */
  openVoucherForm(): void {
    if (!this.canMutate()) return;
    this.editingVoucher.set(this.selectedVoucher());
    this.voucherFormOpen.set(true);
    this.formError.set(null);
    this.dirty.set(false);
    this.loadCampaignOptions();
  }

  /**
   * Activates or pauses the selected campaign.
   */
  setCampaignActive(active: boolean): void {
    const campaign = this.selectedCampaign();
    const promoId = campaign?.promo_id || campaign?.promotion_id;
    if (!campaign || !promoId || !this.canMutate() || this.actionSaving()) return;
    this.actionError.set(null);
    this.actionSaving.set(true);
    const request$ = active
      ? this.api.activatePromotion(promoId, { expectedVersion: campaign.version })
      : this.api.pausePromotion(promoId, { expectedVersion: campaign.version, reason: 'Tạm dừng từ ERP workspace' });
    request$.pipe(finalize(() => this.actionSaving.set(false))).subscribe({
      next: () => {
        this.closeOverlays();
        this.reload();
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Toggles the selected voucher.
   */
  toggleVoucher(): void {
    const voucher = this.selectedVoucher();
    if (!voucher || !this.canMutate() || this.actionSaving()) return;
    this.actionError.set(null);
    this.actionSaving.set(true);
    this.api.toggleVoucher(voucher.voucher_id).pipe(finalize(() => this.actionSaving.set(false))).subscribe({
      next: () => {
        this.closeOverlays();
        this.reload();
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Submits the campaign form.
   */
  submitCampaign(event: Event): void {
    event.preventDefault();
    if (!this.canMutate()) return;
    const form = event.target as HTMLFormElement;
    const name = this.field(form, 'name').trim();
    const type = this.field(form, 'type');
    const start = this.field(form, 'startDate');
    const end = this.field(form, 'endDate');
    const budget = Number(this.field(form, 'budgetLimit') || 0);
    if (name.length < 2) {
      this.formError.set('Tên chiến dịch phải từ 2 ký tự.');
      return;
    }
    if (!start || !end || new Date(end) <= new Date(start)) {
      this.formError.set('Ngày kết thúc phải sau ngày bắt đầu.');
      return;
    }
    if (!Number.isFinite(budget) || budget < 0) {
      this.formError.set('Ngân sách phải là số không âm.');
      return;
    }
    const payload: Record<string, unknown> = {
      name,
      startDate: new Date(start).toISOString(),
      endDate: new Date(end).toISOString(),
      budgetLimit: budget,
      description: this.field(form, 'description'),
    };
    const current = this.editingCampaign();
    const promoId = current?.promo_id || current?.promotion_id;
    this.saving.set(true);
    this.formError.set(null);
    const request$ = current && promoId
      ? this.api.updatePromotion(promoId, { ...payload, expectedVersion: current.version })
      : this.api.createPromotion({ ...payload, type: type || 'product_discount' });
    request$.subscribe({
      next: () => {
        this.saving.set(false);
        this.dirty.set(false);
        this.closeOverlays();
        this.reload();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(adminErrorMessage(error, 'Không lưu được chiến dịch.'));
      },
    });
  }

  /**
   * Submits the voucher form.
   */
  submitVoucher(event: Event): void {
    event.preventDefault();
    if (!this.canMutate()) return;
    const form = event.target as HTMLFormElement;
    const current = this.editingVoucher();
    const code = this.field(form, 'code').toUpperCase();
    const type = this.field(form, 'type') || 'fixed_amount';
    const value = type === 'free_shipping' ? 0 : Number(this.field(form, 'value') || 0);
    const start = this.field(form, 'startDate');
    const end = this.field(form, 'endDate');
    if (!current && !CODE_PATTERN.test(code)) {
      this.formError.set('Mã dài 3–30 ký tự, chỉ gồm chữ không dấu, số, gạch ngang hoặc gạch dưới.');
      return;
    }
    if (type !== 'free_shipping' && (!Number.isFinite(value) || value <= 0)) {
      this.formError.set('Giá trị giảm phải lớn hơn 0.');
      return;
    }
    if (type === 'percentage' && value > 100) {
      this.formError.set('Giảm theo phần trăm không được vượt 100%.');
      return;
    }
    if (!start || !end || new Date(end) <= new Date(start)) {
      this.formError.set('Ngày kết thúc phải sau ngày bắt đầu.');
      return;
    }
    const payload: Record<string, unknown> = {
      ...(current ? {} : { code }),
      name: this.field(form, 'name') || code,
      type,
      value,
      maxDiscount: this.field(form, 'maxDiscount') ? Number(this.field(form, 'maxDiscount')) : null,
      minOrderValue: Number(this.field(form, 'minOrderValue') || 0),
      maxUses: this.field(form, 'maxUses') ? Number(this.field(form, 'maxUses')) : null,
      maxPerUser: Number(this.field(form, 'maxPerUser') || 1),
      applicableUserGroup: this.field(form, 'applicableUserGroup') || 'all_users',
      startDate: new Date(start).toISOString(),
      endDate: new Date(end).toISOString(),
      promoId: this.field(form, 'promoId') || null,
    };
    this.saving.set(true);
    this.formError.set(null);
    const request$ = current
      ? this.api.updateVoucher(current.voucher_id, { ...payload, expectedVersion: current.version })
      : this.api.createVoucher(payload);
    request$.subscribe({
      next: () => {
        this.saving.set(false);
        this.dirty.set(false);
        this.closeOverlays();
        this.reload();
      },
      error: (error: unknown) => {
        this.saving.set(false);
        this.formError.set(adminErrorMessage(error, 'Không lưu được voucher.'));
      },
    });
  }

  /**
   * Campaign display name.
   */
  campaignName(row: AdminPromotionRow): string {
    return row.promo_name || row.name || row.promo_id || '—';
  }

  /**
   * Campaign type label.
   */
  campaignType(row: AdminPromotionRow): string {
    const type = row.promo_type || row.type || '';
    const labels: Record<string, string> = {
      product_discount: 'Giảm giá sản phẩm',
      flash_sale: 'Flash Sale',
      combo_discount: 'Giảm giá Combo',
      seasonal_sale: 'Giảm giá theo mùa',
    };
    return labels[type] || type || '—';
  }

  /**
   * Lifecycle label from the API.
   */
  lifecycleLabel(row: AdminPromotionRow): string {
    if (row.lifecycle_label) return row.lifecycle_label;
    const labels: Record<string, string> = {
      scheduled: 'Đã lên lịch',
      running: 'Đang chạy',
      paused: 'Tạm dừng',
      ended: 'Đã kết thúc',
      budget_exhausted: 'Hết ngân sách',
    };
    return row.lifecycle_status ? labels[row.lifecycle_status] || row.lifecycle_status : row.is_active ? 'Đang bật' : 'Tạm dừng';
  }

  /**
   * Lifecycle tone.
   */
  lifecycleTone(row: AdminPromotionRow): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
    if (row.lifecycle_status === 'running') return 'success';
    if (row.lifecycle_status === 'paused' || row.lifecycle_status === 'scheduled') return 'warning';
    if (row.lifecycle_status === 'ended' || row.lifecycle_status === 'budget_exhausted') return 'danger';
    return 'neutral';
  }

  /**
   * Budget label with unlimited semantics.
   */
  budgetLabel(row: AdminPromotionRow): string {
    if (row.budget_unlimited) return 'Không trần';
    return `${this.money(row.total_discount_issued)} / ${this.money(row.budget_limit ?? row.budget)}`;
  }

  /**
   * Voucher type label.
   */
  voucherType(row: AdminVoucherRow): string {
    const type = row.discount_type || row.type || '';
    const labels: Record<string, string> = {
      fixed_amount: 'Số tiền',
      percentage: 'Phần trăm',
      free_shipping: 'Miễn phí giao',
    };
    return labels[type] || type || '—';
  }

  /**
   * Voucher value label.
   */
  voucherValue(row: AdminVoucherRow): string {
    const type = row.discount_type || row.type;
    const value = Number(row.discount_value ?? row.value ?? 0);
    if (type === 'percentage') return `${value}%`;
    if (type === 'free_shipping') return 'Miễn phí';
    return this.money(value);
  }

  /**
   * Used / limit label.
   */
  usedLabel(row: AdminVoucherRow): string {
    return `${row.used_count ?? 0} / ${row.usage_limit_total ?? '∞'}`;
  }

  /**
   * Money formatter.
   */
  money(value: number | null | undefined): string {
    return adminMoney(value);
  }

  /**
   * Timestamp formatter.
   */
  date(value: string | null | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Audit actor.
   */
  actor(row: AdminAuditRow): string {
    return row.actor_label || row.actor_name || row.actor_id || 'Hệ thống';
  }

  /**
   * ISO to datetime-local value.
   */
  toLocalInput(value: string | null | undefined): string {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    const offset = parsed.getTimezoneOffset() * 60_000;
    return new Date(parsed.getTime() - offset).toISOString().slice(0, 16);
  }

  private field(form: HTMLFormElement, name: string): string {
    return (form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null)?.value || '';
  }
}
