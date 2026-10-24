import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { catchError, forkJoin, map, of } from 'rxjs';
import {
  AdminAccountRow,
  AdminAuditRow,
  AdminErpApiService,
  AdminRoleRequestRow,
} from '../../core/admin-erp-api.service';
import { adminDateTime, adminInitials, adminWordCount } from '../../core/admin-erp-format';
import {
  adminErrorMessage,
  adminListCount,
  adminListRows,
  adminOffset,
  adminRangeLabel,
} from '../../core/admin-erp-http';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { AdminBadgeTone } from '../../shared/ui/admin-status-badge';
import { AdminErpDataTable, AdminTableColumn } from '../../shared/ui/admin-data-table';
import { AdminErpDrawer } from '../../shared/ui/admin-drawer';
import { AdminErpFilterBar } from '../../shared/ui/admin-filter-bar';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AdminErpKpiCard } from '../../shared/ui/admin-kpi-card';
import { AdminErpModal } from '../../shared/ui/admin-modal';
import { AdminErpPageHeader } from '../../shared/ui/admin-page-header';
import { AdminErpPagination } from '../../shared/ui/admin-pagination';
import { AdminErpStatusBadge } from '../../shared/ui/admin-status-badge';
import { AdminErpTab, AdminErpTabs } from '../../shared/ui/admin-tabs';

type AccountTab = 'all' | 'members' | 'admins' | 'locked' | 'unverified' | 'promotions' | 'logs';
type AccountAction = 'lock' | 'unlock' | 'role' | null;

const ROLE_LABELS: Record<string, string> = {
  admin_viewer: 'Admin xem dữ liệu',
  admin_operator_sanpham: 'Admin sản phẩm',
  admin_operator_donhang: 'Admin đơn hàng',
  admin_operator_cskh_dt: 'Admin CSKH đổi trả',
  admin_operator_gia_km: 'Admin giá và khuyến mãi',
  admin_operator_danhgia_review: 'Admin đánh giá',
  super_admin: 'Super admin',
};
const ADMIN_ROLES = Object.keys(ROLE_LABELS);
const EMPTY_ACCOUNTS = { rows: [] as AdminAccountRow[], count: 0 };
const EMPTY_REQUESTS = { rows: [] as AdminRoleRequestRow[], count: 0 };
const EMPTY_LOGS = { rows: [] as AdminAuditRow[], count: 0 };

/**
 * Account directory and RBAC workspace. Writes are capability-gated and every
 * mutation keeps the API's expectedVersion contract.
 */
@Component({
  selector: 'app-admin-erp-accounts-page',
  imports: [
    AdminErpPageHeader,
    AdminErpKpiCard,
    AdminErpTabs,
    AdminErpFilterBar,
    AdminErpDataTable,
    AdminErpPagination,
    AdminErpDrawer,
    AdminErpModal,
    AdminErpStatusBadge,
    AdminErpIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-erp-accounts.page.html',
  styleUrl: './admin-erp-accounts.page.scss',
})
export class AdminErpAccountsPage {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);

  readonly tab = signal<AccountTab>('all');
  readonly query = signal('');
  readonly roleFilter = signal('');
  readonly statusFilter = signal('');
  readonly rows = signal<AdminAccountRow[]>([]);
  readonly requests = signal<AdminRoleRequestRow[]>([]);
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly loading = signal(true);
  readonly hasLoadedOnce = signal(false);
  readonly page = signal(1);
  readonly logsPage = signal(1);
  readonly requestPage = signal(1);
  readonly pageSize = 10;
  readonly total = signal(0);
  readonly requestTotal = signal(0);
  readonly logsCount = signal(0);
  readonly allCount = signal(0);
  readonly memberCount = signal(0);
  readonly adminCount = signal(0);
  readonly lockedCount = signal(0);
  readonly unverifiedCount = signal(0);
  readonly pendingCount = signal(0);

  readonly selected = signal<AdminAccountRow | null>(null);
  readonly selectedRequest = signal<AdminRoleRequestRow | null>(null);
  readonly selectedLog = signal<AdminAuditRow | null>(null);
  readonly actionType = signal<AccountAction>(null);
  readonly actionError = signal<string | null>(null);
  readonly lockType = signal<'temporary' | 'permanent'>('temporary');
  readonly targetRole = signal<'member' | 'admin'>('member');
  readonly wordHint = signal('Số từ: 0 / tối thiểu 11 từ');
  readonly createOpen = signal(false);
  readonly createRole = signal<'member' | 'admin'>('member');
  readonly createError = signal<string | null>(null);
  readonly createdAccount = signal<{ email?: string; phone?: string; temporary_password?: string } | null>(null);
  readonly canMutate = computed(() => this.session.can('update', 'accounts'));
  readonly adminRoles = ADMIN_ROLES;
  readonly moduleOptions = [
    { value: '', label: 'Tất cả loại' },
    { value: 'member', label: 'Thành viên' },
    { value: 'admin', label: 'Quản trị viên' },
  ];
  readonly statusOptions = [
    { value: '', label: 'Tất cả trạng thái' },
    { value: 'active', label: 'Đang hoạt động' },
    { value: 'locked', label: 'Bị khóa' },
    { value: 'unverified', label: 'Chưa xác thực' },
  ];

  readonly tabs = computed<readonly AdminErpTab[]>(() => [
    { key: 'all', label: 'Tất cả', count: this.countOrDash(this.allCount()) },
    { key: 'members', label: 'Thành viên', count: this.countOrDash(this.memberCount()) },
    { key: 'admins', label: 'Quản trị viên', count: this.countOrDash(this.adminCount()) },
    { key: 'locked', label: 'Bị khóa', count: this.countOrDash(this.lockedCount()) },
    { key: 'unverified', label: 'Chưa xác thực', count: this.countOrDash(this.unverifiedCount()) },
    { key: 'promotions', label: 'Nâng quyền', count: this.countOrDash(this.pendingCount()) },
    { key: 'logs', label: 'Nhật ký' },
  ]);

  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  readonly requestPageCount = computed(() => Math.max(1, Math.ceil(this.requestTotal() / this.pageSize)));
  readonly logPageCount = computed(() => Math.max(1, Math.ceil(this.logsCount() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize, 'tài khoản'));
  readonly requestRangeLabel = computed(() => adminRangeLabel(this.requestTotal(), this.requestPage(), this.pageSize, 'yêu cầu'));
  readonly logRangeLabel = computed(() => adminRangeLabel(this.logsCount(), this.logsPage(), this.pageSize, 'nhật ký'));

  readonly accountColumns: readonly AdminTableColumn[] = [
    {
      key: 'person',
      label: 'Tài khoản',
      value: (row) => {
        const account = row as AdminAccountRow;
        return account.full_name || account.email || account.phone || '—';
      },
    },
    {
      key: 'contact',
      label: 'Liên hệ',
      value: (row) => {
        const account = row as AdminAccountRow;
        return account.email || account.phone || '—';
      },
    },
    {
      key: 'role',
      label: 'Vai trò',
      value: (row) => this.roleText(row as AdminAccountRow),
      badge: (row) => ({
        label: this.roleText(row as AdminAccountRow),
        tone: (row as AdminAccountRow).role === 'admin' ? 'info' : 'neutral',
      }),
    },
    {
      key: 'status',
      label: 'Trạng thái',
      value: (row) => this.statusLabel(row as AdminAccountRow),
      badge: (row) => ({ label: this.statusLabel(row as AdminAccountRow), tone: this.statusTone(row as AdminAccountRow) }),
    },
    { key: 'created', label: 'Ngày tạo', value: (row) => this.date((row as AdminAccountRow).created_at) },
    { key: 'lastLogin', label: 'Đăng nhập gần nhất', value: (row) => this.date((row as AdminAccountRow).last_login_at) },
  ];

  readonly requestColumns: readonly AdminTableColumn[] = [
    { key: 'request', label: 'Yêu cầu', value: (row) => String((row as AdminRoleRequestRow).request_id).slice(0, 12) },
    { key: 'user', label: 'Tài khoản đích', value: (row) => String((row as AdminRoleRequestRow).target_user_id || '—') },
    {
      key: 'role',
      label: 'Vai trò yêu cầu',
      value: (row) => this.adminRoleLabel(String((row as AdminRoleRequestRow).requested_role || '')),
    },
    { key: 'expires', label: 'Hết hạn', value: (row) => this.date((row as AdminRoleRequestRow).expires_at) },
    {
      key: 'status',
      label: 'Trạng thái',
      value: (row) => String((row as AdminRoleRequestRow).status || '—'),
      badge: (row) => ({ label: String((row as AdminRoleRequestRow).status || '—'), tone: 'warning' as AdminBadgeTone }),
    },
  ];

  readonly logColumns: readonly AdminTableColumn[] = [
    { key: 'time', label: 'Thời gian', value: (row) => this.date((row as AdminAuditRow).timestamp) },
    { key: 'actor', label: 'Người thao tác', value: (row) => this.actor(row as AdminAuditRow) },
    { key: 'action', label: 'Hành động', value: (row) => this.action(row as AdminAuditRow) },
    { key: 'target', label: 'Đối tượng', value: (row) => this.target(row as AdminAuditRow) },
    {
      key: 'result',
      label: 'Kết quả',
      value: (row) => String((row as AdminAuditRow).result || '—'),
      badge: (row) => {
        const result = String((row as AdminAuditRow).result || '');
        return result ? { label: result, tone: result === 'success' ? ('success' as AdminBadgeTone) : ('warning' as AdminBadgeTone) } : null;
      },
    },
  ];

  constructor() {
    this.reload();
  }

  /**
   * Reloads the active account tab and the count chips.
   */
  reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    const tab = this.tab();
    const pageParams = { limit: String(this.pageSize), offset: adminOffset(this.page(), this.pageSize) };

    forkJoin({
      accounts:
        tab === 'promotions' || tab === 'logs'
          ? of(EMPTY_ACCOUNTS)
          : this.api.listAccounts(this.accountListParams(pageParams)).pipe(
              catchError((error: unknown) => {
                this.loadError.set(adminErrorMessage(error, 'Không tải được danh sách tài khoản.'));
                return of(EMPTY_ACCOUNTS);
              }),
            ),
      requests:
        tab === 'promotions'
          ? this.api
              .listRoleRequests({ status: 'pending', limit: String(this.pageSize), offset: adminOffset(this.requestPage(), this.pageSize) })
              .pipe(catchError(() => of(EMPTY_REQUESTS)))
          : this.api.listRoleRequests({ status: 'pending', limit: '1' }).pipe(catchError(() => of(EMPTY_REQUESTS))),
      logs:
        tab === 'logs'
          ? this.api
              .listAccountAuditLogs({ limit: String(this.pageSize), offset: adminOffset(this.logsPage(), this.pageSize) })
              .pipe(catchError(() => of(EMPTY_LOGS)))
          : of(EMPTY_LOGS),
      all: this.countQuery({}),
      members: this.countQuery({ role: 'member' }),
      admins: this.countQuery({ role: 'admin' }),
      locked: this.countQuery({ lockState: 'locked' }),
      unverified: this.countQuery({ lockState: 'unverified' }),
    }).subscribe((payload) => {
      if (tab !== 'promotions' && tab !== 'logs') {
        this.rows.set(adminListRows(payload.accounts));
        this.total.set(adminListCount(payload.accounts));
      }
      this.requests.set(adminListRows(payload.requests));
      this.requestTotal.set(adminListCount(payload.requests));
      this.pendingCount.set(adminListCount(payload.requests));
      if (tab === 'logs') {
        this.logs.set(adminListRows(payload.logs));
        this.logsCount.set(adminListCount(payload.logs));
      }
      if ([payload.all, payload.members, payload.admins, payload.locked, payload.unverified].every((entry) => entry.ok)) {
        this.allCount.set(adminListCount(payload.all.payload));
        this.memberCount.set(adminListCount(payload.members.payload));
        this.adminCount.set(adminListCount(payload.admins.payload));
        this.lockedCount.set(adminListCount(payload.locked.payload));
        this.unverifiedCount.set(adminListCount(payload.unverified.payload));
      }
      this.loading.set(false);
      this.hasLoadedOnce.set(true);
    });
  }

  /**
   * Switches account tabs and resets paging.
   */
  setTab(tab: string): void {
    if (!['all', 'members', 'admins', 'locked', 'unverified', 'promotions', 'logs'].includes(tab)) {
      return;
    }
    this.tab.set(tab as AccountTab);
    this.page.set(1);
    this.logsPage.set(1);
    this.requestPage.set(1);
    this.closeOverlays();
    this.reload();
  }

  /**
   * Applies server-side account filters.
   */
  applyFilters(): void {
    this.page.set(1);
    this.reload();
  }

  /**
   * Clears account filters.
   */
  resetFilters(): void {
    this.query.set('');
    this.roleFilter.set('');
    this.statusFilter.set('');
    this.page.set(1);
    this.reload();
  }

  /**
   * Moves account paging.
   */
  goPage(page: number): void {
    this.page.set(Math.max(1, page));
    this.reload();
  }

  /**
   * Moves role-request paging.
   */
  goRequestPage(page: number): void {
    this.requestPage.set(Math.max(1, page));
    this.reload();
  }

  /**
   * Moves account-log paging.
   */
  goLogsPage(page: number): void {
    this.logsPage.set(Math.max(1, page));
    this.reload();
  }

  /**
   * Opens the account detail drawer.
   */
  openDetail(row: unknown): void {
    this.selected.set(row as AdminAccountRow);
    this.actionType.set(null);
  }

  /**
   * Opens the account log detail drawer.
   */
  openLog(row: unknown): void {
    this.selectedLog.set(row as AdminAuditRow);
  }

  /**
   * Opens the lock/unlock/role modal for an account.
   */
  openAction(type: Exclude<AccountAction, null>): void {
    const row = this.selected();
    if (!this.canMutate() || !row) {
      return;
    }
    this.actionType.set(type);
    this.actionError.set(null);
    this.lockType.set('temporary');
    this.targetRole.set(row.role === 'admin' ? 'admin' : 'member');
    this.wordHint.set('Số từ: 0 / tối thiểu 11 từ');
  }

  /**
   * Opens the approve/reject modal for a role request.
   */
  openRequest(row: unknown): void {
    if (!this.canMutate()) {
      return;
    }
    this.selectedRequest.set(row as AdminRoleRequestRow);
    this.actionError.set(null);
    this.wordHint.set('Số từ: 0 / tối thiểu 11 từ');
  }

  /**
   * Closes drawers and action modals.
   */
  closeOverlays(): void {
    this.selected.set(null);
    this.selectedLog.set(null);
    this.selectedRequest.set(null);
    this.actionType.set(null);
    this.actionError.set(null);
  }

  /**
   * Opens the create-account modal.
   */
  openCreate(): void {
    if (!this.canMutate()) {
      return;
    }
    this.createOpen.set(true);
    this.createRole.set('member');
    this.createError.set(null);
    this.createdAccount.set(null);
  }

  /**
   * Closes the create modal and refreshes counts when an account was created.
   */
  closeCreate(): void {
    const created = this.createdAccount();
    this.createOpen.set(false);
    this.createError.set(null);
    this.createdAccount.set(null);
    if (created) {
      this.reload();
    }
  }

  /**
   * Submits the create-account form.
   */
  submitCreate(event: Event): void {
    event.preventDefault();
    if (!this.canMutate()) {
      return;
    }
    const form = event.target as HTMLFormElement;
    const fullName = this.field(form, 'fullName').value.trim();
    const email = this.field(form, 'email').value.trim();
    const phone = this.field(form, 'phone').value.trim();
    const password = this.field(form, 'password').value;
    const role = this.createRole();
    const adminRole = role === 'admin' ? this.field(form, 'adminRole').value : '';
    if (!fullName) {
      this.createError.set('Vui lòng nhập họ tên.');
      return;
    }
    if (!email && !phone) {
      this.createError.set('Vui lòng nhập email hoặc số điện thoại.');
      return;
    }
    this.api
      .createAccount({
        fullName,
        email: email || undefined,
        phone: phone || undefined,
        password: password || undefined,
        role,
        adminRole: role === 'admin' ? adminRole : null,
      })
      .subscribe({
        next: (created) => {
          this.createError.set(null);
          this.createdAccount.set({ email: created.email, phone: created.phone, temporary_password: created.temporary_password });
        },
        error: (error: unknown) => this.createError.set(adminErrorMessage(error)),
      });
  }

  /**
   * Submits lock/unlock/role change.
   */
  submitAction(event: Event): void {
    event.preventDefault();
    if (!this.canMutate()) {
      return;
    }
    const row = this.selected();
    const type = this.actionType();
    if (!row || !type || !row.version) {
      this.actionError.set('Thiếu phiên bản tài khoản để thao tác.');
      return;
    }
    const form = event.target as HTMLFormElement;
    const reason = this.field(form, 'reason').value.trim();
    if (type !== 'role' && adminWordCount(reason) <= 10) {
      this.actionError.set(`Lý do quá ngắn, hiện tại ${adminWordCount(reason)} từ, yêu cầu tối thiểu 11 từ.`);
      return;
    }
    const request$ =
      type === 'lock'
        ? this.api.lockAccount(row.user_id, {
            lockType: this.lockType(),
            reason,
            expectedVersion: row.version,
            lockedUntil:
              this.lockType() === 'temporary'
                ? new Date(this.field(form, 'lockedUntil').value).toISOString()
                : null,
          })
        : type === 'unlock'
          ? this.api.unlockAccount(row.user_id, { reason, expectedVersion: row.version })
          : this.api.changeAccountRole(row.user_id, {
              role: this.targetRole(),
              adminRole: this.targetRole() === 'admin' ? this.field(form, 'adminRole').value || null : null,
              expectedVersion: row.version,
            });
    request$.subscribe({
      next: () => {
        this.closeOverlays();
        this.reload();
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Submits approve/reject for a role request.
   */
  submitRequest(decision: 'approve' | 'reject', form: HTMLFormElement): void {
    if (!this.canMutate()) {
      return;
    }
    const row = this.selectedRequest();
    if (!row || !row.version) {
      this.actionError.set('Thiếu phiên bản yêu cầu để thao tác.');
      return;
    }
    const note = this.field(form, 'note').value.trim();
    if (decision === 'reject' && adminWordCount(note) <= 10) {
      this.actionError.set(`Ghi chú từ chối quá ngắn, hiện tại ${adminWordCount(note)} từ, yêu cầu tối thiểu 11 từ.`);
      return;
    }
    this.api.reviewRoleRequest(row.request_id, decision, { expectedVersion: row.version, note }).subscribe({
      next: () => {
        this.closeOverlays();
        this.reload();
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Updates the lock type control.
   */
  onLockType(event: Event): void {
    this.lockType.set((event.target as HTMLSelectElement).value === 'permanent' ? 'permanent' : 'temporary');
  }

  /**
   * Updates the target role control.
   */
  onTargetRole(event: Event): void {
    this.targetRole.set((event.target as HTMLSelectElement).value === 'admin' ? 'admin' : 'member');
  }

  /**
   * Updates the create role control.
   */
  onCreateRole(event: Event): void {
    this.createRole.set((event.target as HTMLSelectElement).value === 'admin' ? 'admin' : 'member');
  }

  /**
   * Updates the word-count hint on reason/note fields.
   */
  onReasonInput(event: Event): void {
    const count = adminWordCount((event.target as HTMLTextAreaElement).value);
    this.wordHint.set(`Số từ: ${count} / tối thiểu 11 từ`);
  }

  /**
   * Updates the account query filter.
   */
  onQueryInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /**
   * Updates the account role filter.
   */
  onRoleFilter(event: Event): void {
    this.roleFilter.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Updates the account status filter.
   */
  onStatusFilter(event: Event): void {
    this.statusFilter.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Title for the account action modal.
   */
  actionTitle(): string {
    const type = this.actionType();
    if (type === 'role') return 'Thay đổi vai trò';
    if (type === 'lock') return 'Khóa tài khoản';
    if (type === 'unlock') return 'Mở khóa tài khoản';
    return 'Thao tác tài khoản';
  }

  /**
   * KPI display that stays honest before the first successful load.
   */
  kpi(value: number): string {
    return this.hasLoadedOnce() ? value.toLocaleString('vi-VN') : '—';
  }

  /**
   * Role label for admins.
   */
  roleText(row: AdminAccountRow): string {    if (row.role !== 'admin') {
      return 'Member';
    }
    return ROLE_LABELS[row.admin_role || ''] || row.admin_role || 'Admin';
  }

  /**
   * Status key for badges.
   */
  statusKey(row: AdminAccountRow): string {
    if (row.is_active) {
      return 'active';
    }
    if (!row.lock_type) {
      return 'unverified';
    }
    return row.lock_type === 'permanent' ? 'locked_perm' : 'locked_temp';
  }

  /**
   * Status label for badges.
   */
  statusLabel(row: AdminAccountRow): string {
    const key = this.statusKey(row);
    if (key === 'active') return 'Đang hoạt động';
    if (key === 'unverified') return 'Chưa xác thực';
    return key === 'locked_perm' ? 'Khóa vĩnh viễn' : 'Khóa tạm thời';
  }

  /**
   * Status tone for badges.
   */
  statusTone(row: AdminAccountRow): AdminBadgeTone {
    const key = this.statusKey(row);
    if (key === 'active') return 'success';
    if (key === 'unverified') return 'warning';
    return 'danger';
  }

  /**
   * Initials for the drawer avatar.
   */
  initials(row: AdminAccountRow): string {
    return adminInitials(row.full_name || row.email || row.phone, 'KH');
  }

  /**
   * Formats a timestamp.
   */
  date(value: string | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Role label for admin-role selects.
   */
  adminRoleLabel(role: string): string {
    return ROLE_LABELS[role] || role || '—';
  }

  /**
   * Stringifies an audit snapshot.
   */
  jsonValue(value: unknown): string {
    try {
      return JSON.stringify(value || {});
    } catch {
      return String(value);
    }
  }

  /**
   * Actor label for the account log.
   */
  actor(row: AdminAuditRow): string {
    return row.actor_label || row.actor_name || row.actor_id || 'Hệ thống';
  }

  /**
   * Action label for the account log.
   */
  action(row: AdminAuditRow): string {
    return row.action_label || row.action || '—';
  }

  /**
   * Target label for the account log.
   */
  target(row: AdminAuditRow): string {
    return row.target_label || row.target_id || '—';
  }

  private accountListParams(pageParams: Record<string, string>): Record<string, string> {
    const tab = this.tab();
    let role = '';
    if (tab === 'members') role = 'member';
    else if (tab === 'admins') role = 'admin';
    else if (this.roleFilter()) role = this.roleFilter();
    let isActive = '';
    let lockState = '';
    if (tab === 'locked' || this.statusFilter() === 'locked') lockState = 'locked';
    else if (tab === 'unverified' || this.statusFilter() === 'unverified') lockState = 'unverified';
    else if (this.statusFilter() === 'active') isActive = 'true';
    return { q: this.query(), role, isActive, lockState, ...pageParams };
  }

  private countQuery(params: Record<string, string>) {
    return this.api.listAccounts({ ...params, limit: '1' }).pipe(
      map((payload) => ({ ok: true, payload })),
      catchError(() => of({ ok: false, payload: EMPTY_ACCOUNTS })),
    );
  }

  private countOrDash(value: number): number | undefined {
    return this.hasLoadedOnce() ? value : undefined;
  }

  private field(form: HTMLFormElement, name: string): HTMLInputElement {
    return (form.elements.namedItem(name) as HTMLInputElement | null) ?? document.createElement('input');
  }
}
