import { Component, computed, inject, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AdminAccountRow, AdminApiService, AdminAuditRow, AdminRoleRequestRow } from '../../core/admin-api.service';
import { adminDateTime, adminInitials, adminWordCount } from '../../core/admin-format';
import { adminErrorMessage, adminListRows } from '../../core/admin-http';
import { AdminIcon } from '../../shared/admin-icon';
import { AdminPagination } from '../../shared/admin-pagination';

type AccountTab = 'all' | 'members' | 'admins' | 'locked' | 'promotions' | 'logs';
type AccountAction = 'lock' | 'unlock' | 'role' | null;
type RequestDecision = 'approve' | 'reject' | null;

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

@Component({
  selector: 'app-admin-accounts-page',
  imports: [AdminIcon, AdminPagination],
  templateUrl: './admin-accounts.page.html',
})
export class AdminAccountsPage {
  private readonly api = inject(AdminApiService);

  readonly tab = signal<AccountTab>('all');
  readonly query = signal('');
  readonly roleFilter = signal('');
  readonly statusFilter = signal('');
  readonly rows = signal<AdminAccountRow[]>([]);
  readonly requests = signal<AdminRoleRequestRow[]>([]);
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly page = signal(1);
  readonly logsPage = signal(1);
  readonly pageSize = 10;
  readonly selected = signal<AdminAccountRow | null>(null);
  readonly actionType = signal<AccountAction>(null);
  readonly requestAction = signal<RequestDecision>(null);
  readonly selectedRequest = signal<AdminRoleRequestRow | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly lockType = signal<'temporary' | 'permanent'>('temporary');
  readonly targetRole = signal<'member' | 'admin'>('member');
  readonly wordHint = signal('Số từ: 0 / tối thiểu 11 từ');

  readonly members = computed(() => this.rows().filter((row) => this.groupOf(row) === 'members'));
  readonly admins = computed(() => this.rows().filter((row) => this.groupOf(row) === 'admins'));
  readonly total = computed(() => this.rows().length);
  readonly memberCount = computed(() => this.members().length);
  readonly adminCount = computed(() => this.admins().length);
  readonly activeCount = computed(() => this.rows().filter((row) => Boolean(row.is_active)).length);
  readonly lockedCount = computed(() => this.rows().filter((row) => !row.is_active).length);
  readonly pendingCount = computed(() => this.requests().filter((row) => row.status === 'pending').length);
  readonly adminRoles = ADMIN_ROLES;
  readonly filtered = computed(() => {
    const tab = this.tab();
    const query = this.query().toLowerCase();
    const role = this.roleFilter();
    const status = this.statusFilter();
    return this.rows().filter((row) => {
      const group = this.groupOf(row);
      if (tab === 'members' && group !== 'members') {
        return false;
      }
      if (tab === 'admins' && group !== 'admins') {
        return false;
      }
      if (tab === 'locked' && row.is_active) {
        return false;
      }
      if (role && row.role !== role) {
        return false;
      }
      if (status === 'active' && !row.is_active) {
        return false;
      }
      if (status === 'locked' && row.is_active) {
        return false;
      }
      const haystack = `${row.full_name || ''} ${row.email || ''} ${row.phone || ''}`.toLowerCase();
      return !query || haystack.includes(query);
    });
  });
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.filtered().length / this.pageSize)));
  readonly paged = computed(() => {
    const rows = this.filtered();
    const page = Math.min(this.page(), this.pageCount());
    const start = (page - 1) * this.pageSize;
    return rows.slice(start, start + this.pageSize);
  });
  readonly rangeLabel = computed(() => this.rangeText(this.filtered().length, Math.min(this.page(), this.pageCount()), 'tài khoản'));
  readonly pagedLogs = computed(() => {
    const page = Math.min(this.logsPage(), this.logPageCount());
    const start = (page - 1) * this.pageSize;
    return this.logs().slice(start, start + this.pageSize);
  });
  readonly logPageCount = computed(() => Math.max(1, Math.ceil(this.logs().length / this.pageSize)));
  readonly logRangeLabel = computed(() => this.rangeText(this.logs().length, Math.min(this.logsPage(), this.logPageCount()), 'nhật ký'));

  constructor() {
    this.reload();
  }

  /**
   * Reloads accounts, role requests, and account logs from the original APIs.
   */
  reload(): void {
    this.loadError.set(null);
    forkJoin({
      accounts: this.api.listAccounts({ limit: '100' }).pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error));
          return of({ rows: [] as AdminAccountRow[] });
        }),
      ),
      requests: this.api.listRoleRequests({ limit: '100' }).pipe(catchError(() => of({ rows: [] as AdminRoleRequestRow[] }))),
      logs: this.api.listAccountAuditLogs({ limit: '100' }).pipe(catchError(() => of({ rows: [] as AdminAuditRow[] }))),
    }).subscribe((payload) => {
      this.rows.set(adminListRows(payload.accounts));
      this.requests.set(adminListRows(payload.requests));
      this.logs.set(adminListRows(payload.logs));
    });
  }

  /**
   * Switches the original accounts tablist.
   */
  setTab(tab: AccountTab): void {
    this.tab.set(tab);
    this.page.set(1);
    this.closeOverlays();
  }

  /**
   * Applies the original account filter bar.
   */
  applyFilters(event: Event): void {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    this.query.set((form.elements.namedItem('q') as HTMLInputElement | null)?.value.trim() || '');
    this.roleFilter.set((form.elements.namedItem('role') as HTMLSelectElement | null)?.value || '');
    this.statusFilter.set((form.elements.namedItem('status') as HTMLSelectElement | null)?.value || '');
    this.page.set(1);
  }

  /**
   * Clears the original account filters.
   */
  resetFilters(event: Event): void {
    event.preventDefault();
    this.query.set('');
    this.roleFilter.set('');
    this.statusFilter.set('');
    this.page.set(1);
  }

  /**
   * Moves account pagination.
   */
  goPage(page: number): void {
    this.page.set(Math.min(this.pageCount(), Math.max(1, page)));
  }

  /**
   * Moves account-log pagination.
   */
  goLogsPage(page: number): void {
    this.logsPage.set(Math.min(this.logPageCount(), Math.max(1, page)));
  }

  /**
   * Opens the original account detail drawer.
   */
  openDetail(userId: string): void {
    this.selected.set(this.rows().find((row) => row.user_id === userId) || null);
    this.actionType.set(null);
  }

  /**
   * Opens lock, unlock, or role-change modal.
   */
  openAction(type: Exclude<AccountAction, null>, userId: string): void {
    const row = this.rows().find((item) => item.user_id === userId) || null;
    this.selected.set(row);
    this.actionType.set(type);
    this.actionError.set(null);
    this.lockType.set('temporary');
    this.targetRole.set(row?.role === 'admin' ? 'admin' : 'member');
    this.wordHint.set('Số từ: 0 / tối thiểu 11 từ');
  }

  /**
   * Opens approve/reject for a role request.
   */
  openRequest(decision: Exclude<RequestDecision, null>, requestId: string): void {
    this.selectedRequest.set(this.requests().find((row) => row.request_id === requestId) || null);
    this.requestAction.set(decision);
    this.actionError.set(null);
    this.wordHint.set('Số từ: 0 / tối thiểu 11 từ');
  }

  /**
   * Closes drawers and action modals.
   */
  closeOverlays(): void {
    this.selected.set(null);
    this.actionType.set(null);
    this.requestAction.set(null);
    this.selectedRequest.set(null);
    this.actionError.set(null);
  }

  /**
   * Syncs the lock-type select used by the original lock modal.
   */
  onLockType(event: Event): void {
    this.lockType.set((event.target as HTMLSelectElement).value === 'permanent' ? 'permanent' : 'temporary');
  }

  /**
   * Syncs the role select used by the original role modal.
   */
  onTargetRole(event: Event): void {
    this.targetRole.set((event.target as HTMLSelectElement).value === 'admin' ? 'admin' : 'member');
  }

  /**
   * Updates the original 11-word counter.
   */
  onReasonInput(event: Event): void {
    const count = adminWordCount((event.target as HTMLTextAreaElement).value);
    this.wordHint.set(`Số từ: ${count} / tối thiểu 11 từ`);
  }

  /**
   * Submits lock, unlock, or role change through the original admin APIs.
   */
  submitAction(event: Event): void {
    event.preventDefault();
    const row = this.selected();
    const type = this.actionType();
    if (!row || !type || !row.version) {
      this.actionError.set('Thiếu phiên bản tài khoản để thao tác.');
      return;
    }
    const form = event.target as HTMLFormElement;
    const reason = (form.elements.namedItem('reason') as HTMLTextAreaElement | null)?.value.trim() || '';
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
                ? new Date((form.elements.namedItem('lockedUntil') as HTMLInputElement).value).toISOString()
                : null,
          })
        : type === 'unlock'
          ? this.api.unlockAccount(row.user_id, { reason, expectedVersion: row.version })
          : this.api.changeAccountRole(row.user_id, {
              role: this.targetRole(),
              adminRole:
                this.targetRole() === 'admin'
                  ? (form.elements.namedItem('adminRole') as HTMLSelectElement).value || null
                  : null,
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
   * Approves or rejects a role-upgrade request.
   */
  submitRequest(event: Event): void {
    event.preventDefault();
    const row = this.selectedRequest();
    const decision = this.requestAction();
    if (!row || !decision || !row.version) {
      this.actionError.set('Thiếu phiên bản yêu cầu để thao tác.');
      return;
    }
    const form = event.target as HTMLFormElement;
    const note = (form.elements.namedItem('note') as HTMLTextAreaElement | null)?.value.trim() || '';
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
   * Member vs admin group used by the original tabs.
   */
  groupOf(row: AdminAccountRow): 'members' | 'admins' {
    return row.role === 'admin' ? 'admins' : 'members';
  }

  /**
   * Role label used by the original table.
   */
  roleText(row: AdminAccountRow): string {
    if (row.role !== 'admin') {
      return 'Member';
    }
    return ROLE_LABELS[row.admin_role || ''] || row.admin_role || 'Admin';
  }

  /**
   * Status key used by the original badges.
   */
  statusKey(row: AdminAccountRow): string {
    if (row.is_active) {
      return 'active';
    }
    return row.lock_type === 'permanent' ? 'locked_perm' : 'locked_temp';
  }

  /**
   * Status label used by the original badges.
   */
  statusLabel(row: AdminAccountRow): string {
    const key = this.statusKey(row);
    if (key === 'active') {
      return 'Đang hoạt động';
    }
    return key === 'locked_perm' ? 'Khóa vĩnh viễn' : 'Khóa tạm thời';
  }

  /**
   * Stable row key for the original accounts table.
   */
  rowKey(row: AdminAccountRow, index: number): string {
    return row.user_id || row.email || row.phone || String(index);
  }

  /**
   * Initials for the original person cell.
   */
  initials(row: AdminAccountRow): string {
    return adminInitials(row.full_name || row.email || row.phone, 'KH');
  }

  /**
   * Formats an account timestamp.
   */
  date(value: string | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Role label for the original admin-role select.
   */
  adminRoleLabel(role: string): string {
    return ROLE_LABELS[role] || role;
  }

  /**
   * Stringifies an audit payload for the account log table.
   */
  jsonValue(value: unknown): string {
    return JSON.stringify(value || {});
  }

  private rangeText(total: number, page: number, noun: string): string {
    if (!total) {
      return `Hiển thị 0 - 0 / 0 ${noun}`;
    }
    const start = (page - 1) * this.pageSize + 1;
    const end = Math.min(page * this.pageSize, total);
    return `Hiển thị ${start} - ${end} / ${total} ${noun}`;
  }
}
