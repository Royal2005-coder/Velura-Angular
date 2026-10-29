import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, ParamMap, RouterLink } from '@angular/router';
import { catchError, forkJoin, of } from 'rxjs';
import {
  AdminErpApiService,
  AdminMemberDetail,
  AdminMemberOverview,
  AdminMemberRow,
} from '../../core/admin-erp-api.service';
import { choiceParam, textParam, watchQueryParams } from '../../core/admin-erp-deep-link';
import { adminDateTime } from '../../core/admin-erp-format';
import { useWorkspaceRefresh } from '../../core/admin-erp-refresh.service';
import {
  adminErrorMessage,
  adminListCount,
  adminListRows,
  adminOffset,
  adminRangeLabel,
} from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import {
  MEMBER_WALLET_FILTERS,
  MEMBER_WALLET_KEYS,
  MEMBER_LOCK_REASON_MIN,
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
  type MemberWalletFilter,
} from '../../core/admin-erp-members';
import { orderFocusLink, returnFocusLink, type OrderTraceLink } from '../../core/admin-erp-order-trace';
import { AdminErpDataTable, AdminTableColumn } from '../../shared/ui/admin-data-table';
import { AdminErpDrawer } from '../../shared/ui/admin-drawer';
import { AdminErpLoadingOverlay } from '../../shared/ui/admin-loading-overlay';
import { AdminErpFilterBar } from '../../shared/ui/admin-filter-bar';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AdminErpKpiCard } from '../../shared/ui/admin-kpi-card';
import { AdminErpPageHeader } from '../../shared/ui/admin-page-header';
import { AdminErpPagination } from '../../shared/ui/admin-pagination';
import { AdminErpStatusBadge } from '../../shared/ui/admin-status-badge';
import { AdminErpTab, AdminErpTabs } from '../../shared/ui/admin-tabs';

type MemberSort = 'balance' | 'name' | 'recent';

const MEMBER_SORTS: readonly MemberSort[] = ['balance', 'name', 'recent'];
const EMPTY_OVERVIEW: AdminMemberOverview = {};

/**
 * Thành viên & điểm (KAN-106).
 *
 * Ví điểm là dữ liệu tiền, nên màn hình chỉ đọc từ `loyalty_account`/`loyalty_ledger` và chỉ ghi
 * đúng một thao tác vận hành: khoá/mở tích luỹ kèm lý do (RPC ghi audit). Không có nút sửa số dư —
 * điều chỉnh điểm cần phê duyệt riêng, không phải một cú bấm trong hàng đợi.
 */
@Component({
  selector: 'app-admin-erp-members-page',
  imports: [
    RouterLink,
    AdminErpPageHeader,
    AdminErpKpiCard,
    AdminErpTabs,
    AdminErpFilterBar,
    AdminErpDataTable,
    AdminErpPagination,
    AdminErpDrawer,
    AdminErpLoadingOverlay,
    AdminErpIcon,
    AdminErpStatusBadge,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-erp-members.page.html',
  styleUrl: './admin-erp-members.page.scss',
})
export class AdminErpMembersPage {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly wallet = signal<MemberWalletFilter>('all');
  readonly search = signal('');
  readonly sort = signal<MemberSort>('balance');
  readonly rows = signal<AdminMemberRow[]>([]);
  readonly total = signal(0);
  readonly page = signal(1);
  readonly pageSize = 20;
  readonly loading = signal(true);
  readonly hasLoadedOnce = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly overviewError = signal<string | null>(null);
  readonly notice = signal<string | null>(null);
  readonly overview = signal<AdminMemberOverview>(EMPTY_OVERVIEW);

  readonly detail = signal<AdminMemberDetail | null>(null);
  readonly detailUserId = signal<string | null>(null);
  readonly detailLoading = signal(false);
  readonly detailError = signal<string | null>(null);
  readonly lockReason = signal('');
  readonly lockBusy = signal(false);
  readonly lockError = signal<string | null>(null);

  readonly detailState = computed(() => {
    const account = this.detail()?.account;
    return memberState(
      account
        ? {
            wallet_exists: true,
            accrual_locked: account.accrual_locked,
            balance_milli_points: account.balance_milli_points,
            debt_milli_points: account.debt_milli_points,
            warning_flags: account.warning_flags,
          }
        : { wallet_exists: false },
    );
  });
  readonly detailWarningText = computed(() => {
    const account = this.detail()?.account;
    if (!account) return null;
    return memberWarning({
      wallet_exists: true,
      accrual_locked: account.accrual_locked,
      balance_milli_points: account.balance_milli_points,
      debt_milli_points: account.debt_milli_points,
      warning_flags: account.warning_flags,
    });
  });

  readonly canRead = computed(() => this.session.can('read', 'members'));
  readonly canUpdate = computed(() => this.session.can('update', 'members'));

  readonly tabs = computed<readonly AdminErpTab[]>(() => {
    const counts = memberTabCounts(this.overview());
    return MEMBER_WALLET_FILTERS.map((filter) => ({ key: filter.key, label: filter.label, count: counts[filter.key] }));
  });
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize, 'thành viên'));
  readonly lockReasonMin = MEMBER_LOCK_REASON_MIN;

  readonly columns = computed<readonly AdminTableColumn[]>(() => [
    {
      key: 'member',
      label: 'Thành viên',
      value: (row) => (row as AdminMemberRow).full_name || '(chưa đặt tên)',
    },
    {
      key: 'contact',
      label: 'Liên hệ',
      value: (row) => String((row as AdminMemberRow).email || (row as AdminMemberRow).phone || '—'),
    },
    {
      key: 'points',
      label: 'Ví điểm',
      value: (row) => this.pointsLabel(row as AdminMemberRow),
      align: 'right',
      mono: true,
    },
    {
      key: 'value',
      label: 'Giá trị',
      value: (row) => memberWalletValue((row as AdminMemberRow).balance_milli_points, (row as AdminMemberRow).debt_milli_points),
      align: 'right',
      mono: true,
    },
    {
      key: 'state',
      label: 'Trạng thái',
      value: (row) => memberState(row as AdminMemberRow).label,
      badge: (row) => memberState(row as AdminMemberRow),
    },
    {
      key: 'entries',
      label: 'Bút toán',
      value: (row) => String((row as AdminMemberRow).ledger_entries ?? 0),
      align: 'right',
      mono: true,
    },
    {
      key: 'last',
      label: 'Lần cuối',
      value: (row) => this.dateTime((row as AdminMemberRow).last_ledger_at),
    },
    {
      key: 'vouchers',
      label: 'Ưu đãi',
      value: (row) => String((row as AdminMemberRow).vouchers_available ?? 0),
      align: 'right',
      mono: true,
    },
  ]);

  constructor() {
    watchQueryParams(this.route, this.destroyRef, (params) => this.applyDeepLink(params));
    useWorkspaceRefresh(() => this.reload());
  }

  /**
   * Applies an inbound deep link: the wallet tab, search/sort another workspace may know about,
   * and the member to open. Every inbound value is checked against what this screen supports.
   */
  private applyDeepLink(params: ParamMap): void {
    this.wallet.set(choiceParam(params, 'wallet', MEMBER_WALLET_KEYS, 'all') as MemberWalletFilter);
    this.search.set(textParam(params, 'q'));
    this.sort.set(choiceParam(params, 'sort', MEMBER_SORTS, 'balance') as MemberSort);
    this.page.set(1);
    this.reload();
    const focus = textParam(params, 'focus');
    if (focus) {
      this.openDetail(focus);
    }
  }

  /**
   * Loads the page plus the counter strip. A failed list request does not blank the counters.
   */
  reload(): void {
    if (!this.canRead()) {
      this.loading.set(false);
      this.rows.set([]);
      this.total.set(0);
      return;
    }
    this.loading.set(true);
    this.loadError.set(null);
    this.overviewError.set(null);
    forkJoin({
      list: this.api
        .listMembers({
          wallet: this.wallet(),
          q: this.search(),
          sort: this.sort(),
          limit: String(this.pageSize),
          offset: adminOffset(this.page(), this.pageSize),
        })
        .pipe(
          catchError((error: unknown) => {
            this.loadError.set(adminErrorMessage(error, 'Không tải được danh sách thành viên.'));
            return of({ rows: [], count: 0 });
          }),
        ),
      overview: this.api.memberOverview().pipe(
        catchError((error: unknown) => {
          this.overviewError.set(adminErrorMessage(error, 'Không tải được tổng quan ví điểm.'));
          return of(EMPTY_OVERVIEW);
        }),
      ),
    }).subscribe((payload) => {
      this.rows.set(adminListRows(payload.list));
      this.total.set(adminListCount(payload.list));
      this.overview.set(payload.overview);
      this.loading.set(false);
      this.hasLoadedOnce.set(true);
    });
  }

  setWallet(key: string): void {
    if (this.loading()) return;
    if (!MEMBER_WALLET_KEYS.includes(key as MemberWalletFilter)) return;
    this.wallet.set(key as MemberWalletFilter);
    this.page.set(1);
    this.notice.set(null);
    this.reload();
  }

  applyFilters(): void {
    this.page.set(1);
    this.reload();
  }

  resetFilters(): void {
    this.search.set('');
    this.sort.set('balance');
    this.page.set(1);
    this.reload();
  }

  goPage(page: number): void {
    this.page.set(Math.min(this.totalPages(), Math.max(1, page)));
    this.reload();
  }

  onSearchInput(event: Event): void {
    this.search.set((event.target as HTMLInputElement).value);
  }

  onSortChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as MemberSort;
    if (MEMBER_SORTS.includes(value)) {
      this.sort.set(value);
    }
  }

  /**
   * Opens the drawer for one member and loads the trail that explains the balance.
   */
  openDetail(userId: string): void {
    this.detailUserId.set(userId);
    this.detail.set(null);
    this.detailError.set(null);
    this.lockError.set(null);
    this.lockReason.set('');
    this.loadDetail(userId);
  }

  /** Table rows are untyped at the shared table boundary; stop the cast at the page edge. */
  openDetailFromRow(row: unknown): void {
    const userId = (row as AdminMemberRow | null)?.user_id;
    if (userId) this.openDetail(userId);
  }

  retryDetail(): void {
    const userId = this.detailUserId();
    if (userId) this.loadDetail(userId);
  }

  closeDetail(): void {
    this.detailUserId.set(null);
    this.detail.set(null);
    this.detailError.set(null);
    this.lockError.set(null);
    this.lockBusy.set(false);
  }

  private loadDetail(userId: string): void {
    this.detailLoading.set(true);
    this.api.memberDetail(userId).subscribe({
      next: (detail) => {
        if (this.detailUserId() !== userId) return;
        this.detail.set(detail);
        this.detailLoading.set(false);
      },
      error: (error: unknown) => {
        if (this.detailUserId() !== userId) return;
        this.detail.set(null);
        this.detailError.set(adminErrorMessage(error, 'Không tải được hồ sơ thành viên.'));
        this.detailLoading.set(false);
      },
    });
  }

  onLockReason(event: Event): void {
    this.lockReason.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Locks or unlocks accrual with the typed reason. The reason is the audit record, so it is
   * validated here before the network call and again inside the RPC.
   */
  saveLock(locked: boolean): void {
    const detail = this.detail();
    if (!detail || !this.canUpdate() || this.lockBusy()) return;
    const error = memberLockReasonError(this.lockReason());
    this.lockError.set(error);
    if (error) return;

    this.lockBusy.set(true);
    this.api.setMemberAccrualLock(detail.user.user_id, { locked, reason: this.lockReason().trim() }).subscribe({
      next: (result) => {
        this.lockBusy.set(false);
        this.lockReason.set('');
        this.notice.set(
          result.changed
            ? locked
              ? 'Đã khoá tích luỹ. Điểm mới sẽ không được cộng cho thành viên này.'
              : 'Đã mở khoá tích luỹ.'
            : 'Ví đã ở đúng trạng thái này từ trước, không ghi thêm dấu vết.',
        );
        this.reload();
        this.loadDetail(detail.user.user_id);
      },
      error: (error: unknown) => {
        this.lockBusy.set(false);
        this.lockError.set(adminErrorMessage(error, 'Không lưu được trạng thái khoá tích luỹ.'));
      },
    });
  }

  pointsLabel(row: AdminMemberRow): string {
    const balance = memberPoints((row.balance_milli_points ?? 0) - (row.debt_milli_points ?? 0));
    return `${balance.toLocaleString('vi-VN', { maximumFractionDigits: 3 })} điểm`;
  }

  state(row: AdminMemberRow): { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' } {
    return memberState(row);
  }

  warning(row: AdminMemberRow): string | null {
    return memberWarning(row);
  }

  kindMeta(kind: string | null | undefined): { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' } {
    return ledgerKindMeta(kind);
  }

  referralStatus(status: string | null | undefined): { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' } {
    return referralStatusMeta(status);
  }

  voucherStatus(status: string | null | undefined): { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' | 'info' } {
    return voucherStatusMeta(status);
  }

  referralRole = referralRoleLabel;
  voucherBenefit = voucherBenefitLabel;

  pointsLabelOf(milli: number | null | undefined): string {
    return memberPointsLabel(milli);
  }

  walletValue(balanceMilli: number | null | undefined, debtMilli: number | null | undefined): string {
    return memberWalletValue(balanceMilli, debtMilli);
  }

  signedPoints(milli: number | null | undefined): string {
    const points = memberPoints(milli);
    const prefix = points > 0 ? '+' : '';
    return `${prefix}${points.toLocaleString('vi-VN', { maximumFractionDigits: 3 })} điểm`;
  }

  isZeroEntry(milli: number | null | undefined): boolean {
    return Number(milli || 0) === 0;
  }

  orderLink(orderId: string | null | undefined): OrderTraceLink | null {
    return orderId ? orderFocusLink(orderId, 'Mở đơn hàng') : null;
  }

  returnLink(returnId: string | null | undefined): OrderTraceLink | null {
    return returnId ? returnFocusLink(returnId, 'Mở hồ sơ đổi trả') : null;
  }

  dateTime(value: string | null | undefined): string {
    return adminDateTime(value);
  }
}
