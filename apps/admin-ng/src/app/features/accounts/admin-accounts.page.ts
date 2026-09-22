import { Component, computed, inject, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { AdminAccountRow, AdminApiService, AdminAuditRow, AdminRoleRequestRow } from '../../core/admin-api.service';
import { adminDateTime, adminInitials, adminWordCount } from '../../core/admin-format';
import { adminErrorMessage, adminListCount, adminListRows, adminOffset, adminRangeLabel } from '../../core/admin-http';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminEmptyState } from '../../shared/admin-empty-state';
import { AdminIcon } from '../../shared/admin-icon';
import { AdminPagination } from '../../shared/admin-pagination';
import { AdminTableSkeleton } from '../../shared/admin-table-skeleton';

type AccountTab = 'all' | 'members' | 'admins' | 'locked' | 'unverified' | 'promotions' | 'logs';
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
const EMPTY_ACCOUNTS = { rows: [] as AdminAccountRow[], count: 0 };
const EMPTY_REQUESTS = { rows: [] as AdminRoleRequestRow[], count: 0 };
const EMPTY_LOGS = { rows: [] as AdminAuditRow[], count: 0 };

@Component({
  selector: 'app-admin-accounts-page',
  imports: [AdminEmptyState, AdminIcon, AdminPagination, AdminTableSkeleton],
  templateUrl: './admin-accounts.page.html',
})
export class AdminAccountsPage {
  private readonly api = inject(AdminApiService);
  private readonly session = inject(AdminSessionService);

  readonly tab = signal<AccountTab>('all');
  readonly query = signal('');
  readonly roleFilter = signal('');
  readonly statusFilter = signal('');
  readonly rows = signal<AdminAccountRow[]>([]);
  readonly requests = signal<AdminRoleRequestRow[]>([]);
  readonly logs = signal<AdminAuditRow[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly loading = signal(true);
  /**
   * Phân biệt lần tải đầu với lần tải lại.
   *
   * Lần đầu chưa có gì để hiện thì vẽ khung xương. Từ lần thứ hai — đổi bộ lọc, sang
   * trang, đổi tab — giữ nguyên bảng cũ và chỉ làm mờ đi, vì xoá sạch bảng rồi vẽ lại
   * khiến thao tác lọc có cảm giác chậm hơn thực tế.
   */
  readonly hasLoadedOnce = signal(false);
  readonly showSkeleton = computed(() => this.loading() && !this.hasLoadedOnce());
  readonly isRefreshing = computed(() => this.loading() && this.hasLoadedOnce());
  readonly page = signal(1);
  readonly logsPage = signal(1);
  readonly pageSize = 10;
  readonly total = signal(0);
  readonly allCount = signal(0);
  readonly memberCount = signal(0);
  readonly adminCount = signal(0);
  readonly lockedCount = signal(0);
  readonly unverifiedCount = signal(0);
  readonly pendingCount = signal(0);
  /**
   * Các chỉ số đầu trang có cần tính lại không.
   *
   * Bật lên ở lần tải đầu và sau mỗi thao tác tạo/khoá/mở/đổi vai trò — tức đúng
   * những lúc con số có thể đã khác. Phân trang, đổi tab và đổi bộ lọc thì không:
   * năm truy vấn này đếm trên toàn bộ tài khoản, không theo bộ lọc của bảng.
   */
  private readonly countsStale = signal(true);
  readonly requestTotal = signal(0);
  readonly logsCount = signal(0);
  readonly selected = signal<AdminAccountRow | null>(null);
  readonly actionType = signal<AccountAction>(null);
  readonly requestAction = signal<RequestDecision>(null);
  readonly selectedRequest = signal<AdminRoleRequestRow | null>(null);
  readonly actionError = signal<string | null>(null);
  readonly lockType = signal<'temporary' | 'permanent'>('temporary');
  readonly targetRole = signal<'member' | 'admin'>('member');
  readonly wordHint = signal('Số từ: 0 / tối thiểu 11 từ');
  readonly createOpen = signal(false);
  readonly createRole = signal<'member' | 'admin'>('member');
  readonly createError = signal<string | null>(null);
  readonly createdAccount = signal<{ email?: string; phone?: string; temporary_password?: string } | null>(null);
  readonly canMutate = computed(() => this.session.canMutate('accounts'));
  readonly adminRoles = ADMIN_ROLES;
  readonly paged = computed(() => this.rows());
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize, 'tài khoản'));
  readonly pagedLogs = computed(() => this.logs());
  readonly logPageCount = computed(() => Math.max(1, Math.ceil(this.logsCount() / this.pageSize)));
  readonly logRangeLabel = computed(() => adminRangeLabel(this.logsCount(), this.logsPage(), this.pageSize, 'nhật ký'));
  readonly requestPageCount = computed(() => Math.max(1, Math.ceil(this.requestTotal() / this.pageSize)));
  readonly requestRangeLabel = computed(() => adminRangeLabel(this.requestTotal(), this.page(), this.pageSize, 'yêu cầu'));

  constructor() {
    this.reload();
  }

  /**
   * Reloads the active accounts tab from server-paged APIs.
   */
  reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    const pageParams = { limit: String(this.pageSize), offset: adminOffset(this.page(), this.pageSize) };
    const tab = this.tab();
    forkJoin({
      accounts:
        tab === 'promotions' || tab === 'logs'
          ? of(EMPTY_ACCOUNTS)
          : this.api.listAccounts(this.accountListParams(pageParams)).pipe(
              catchError((error: unknown) => {
                this.loadError.set(adminErrorMessage(error));
                return of(EMPTY_ACCOUNTS);
              }),
            ),
      requests:
        tab === 'promotions'
          ? this.api.listRoleRequests({ status: 'pending', ...pageParams }).pipe(catchError(() => of(EMPTY_REQUESTS)))
          : this.api.listRoleRequests({ status: 'pending', limit: '1' }).pipe(catchError(() => of(EMPTY_REQUESTS))),
      logs:
        tab === 'logs'
          ? this.api
              .listAccountAuditLogs({ limit: String(this.pageSize), offset: adminOffset(this.logsPage(), this.pageSize) })
              .pipe(catchError(() => of(EMPTY_LOGS)))
          : of(EMPTY_LOGS),
      // Năm truy vấn đếm chỉ chạy khi số liệu có thể đã đổi. Bấm sang trang không làm
      // tổng số tài khoản thay đổi, nên chạy lại chúng ở mỗi lần phân trang là năm
      // vòng gọi mạng thừa trước khi bảng kịp hiện ra.
      all: this.countQuery({}),
      members: this.countQuery({ role: 'member' }),
      admins: this.countQuery({ role: 'admin' }),
      // `lockState` thay cho `isActive=false`: tài khoản bỏ dở OTP cũng có
      // `is_active=false` nhưng không phải bị khoá, và cần đếm riêng.
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
      if (this.countsStale()) {
        const counts = [payload.all, payload.members, payload.admins, payload.locked, payload.unverified];
        // Chỉ ghi nhận khi cả năm truy vấn đều thành công. Một truy vấn hỏng trả về
        // payload rỗng, ghi vào là dựng số 0 lên màn hình; đánh dấu hết cũ luôn thì con
        // số 0 đó nằm lại cho tới lần thao tác ghi tiếp theo — có thể là rất lâu sau,
        // hoặc không bao giờ trong phiên làm việc đó. Thà giữ nguyên số cũ và thử lại
        // ở lần tải sau.
        if (counts.every((entry) => entry.ok)) {
          this.allCount.set(adminListCount(payload.all.payload));
          this.memberCount.set(adminListCount(payload.members.payload));
          this.adminCount.set(adminListCount(payload.admins.payload));
          this.lockedCount.set(adminListCount(payload.locked.payload));
          this.unverifiedCount.set(adminListCount(payload.unverified.payload));
          this.countsStale.set(false);
        }
      }
      this.loading.set(false);
      this.hasLoadedOnce.set(true);
    });
  }

  /**
   * Một truy vấn đếm, kèm thông tin nó có thành công hay không.
   *
   * `catchError` nuốt lỗi để `forkJoin` còn hoàn tất được phần danh sách, nên nếu không
   * kèm cờ `ok` thì phía nhận không phân biệt được "đếm được 0" với "gọi hỏng".
   * Trả về `ok: true` mà không gọi gì khi số liệu chưa cũ — lúc đó giá trị không được
   * dùng tới.
   */
  private countQuery(params: Record<string, string>) {
    if (!this.countsStale()) {
      return of({ ok: true, payload: EMPTY_ACCOUNTS });
    }
    return this.api.listAccounts({ ...params, limit: '1' }).pipe(
      map((payload) => ({ ok: true, payload })),
      catchError(() => of({ ok: false, payload: EMPTY_ACCOUNTS })),
    );
  }

  /**
   * Switches the original accounts tablist and reloads the matching list.
   */
  setTab(tab: AccountTab): void {
    this.tab.set(tab);
    this.page.set(1);
    this.logsPage.set(1);
    this.closeOverlays();
    this.reload();
  }

  /**
   * Applies the original account filter bar on the server list.
   */
  applyFilters(event: Event): void {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    this.query.set((form.elements.namedItem('q') as HTMLInputElement | null)?.value.trim() || '');
    this.roleFilter.set((form.elements.namedItem('role') as HTMLSelectElement | null)?.value || '');
    this.statusFilter.set((form.elements.namedItem('status') as HTMLSelectElement | null)?.value || '');
    this.page.set(1);
    this.reload();
  }

  /**
   * Clears the original account filters and reloads.
   */
  resetFilters(event: Event): void {
    event.preventDefault();
    this.query.set('');
    this.roleFilter.set('');
    this.statusFilter.set('');
    this.page.set(1);
    this.reload();
  }

  /**
   * Moves account or role-request pagination.
   */
  goPage(page: number): void {
    this.page.set(Math.max(1, page));
    this.reload();
  }

  /**
   * Moves account-log pagination.
   */
  goLogsPage(page: number): void {
    this.logsPage.set(Math.max(1, page));
    this.reload();
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
    if (!this.canMutate()) {
      return;
    }
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
    if (!this.canMutate()) {
      return;
    }
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
   * Syncs the role select used by the create-account modal.
   */
  onCreateRole(event: Event): void {
    this.createRole.set((event.target as HTMLSelectElement).value === 'admin' ? 'admin' : 'member');
  }

  /**
   * Closes the create-account modal and refreshes the list when an account was created.
   */
  closeCreate(): void {
    const created = this.createdAccount();
    this.createOpen.set(false);
    this.createError.set(null);
    this.createdAccount.set(null);
    if (created) {
      this.reloadWithCounts();
    }
  }

  /**
   * Tải lại bảng và tính lại các chỉ số đầu trang.
   *
   * Dùng sau những thao tác làm đổi số liệu; phân trang thuần thì gọi `reload()`.
   */
  private reloadWithCounts(): void {
    this.countsStale.set(true);
    this.reload();
  }

  /**
   * Submits the new-account form through the admin API.
   */
  submitCreate(event: Event): void {
    event.preventDefault();
    if (!this.canMutate()) {
      return;
    }
    const form = event.target as HTMLFormElement;
    const fullName = (form.elements.namedItem('fullName') as HTMLInputElement | null)?.value.trim() || '';
    const email = (form.elements.namedItem('email') as HTMLInputElement | null)?.value.trim() || '';
    const phone = (form.elements.namedItem('phone') as HTMLInputElement | null)?.value.trim() || '';
    const password = (form.elements.namedItem('password') as HTMLInputElement | null)?.value || '';
    const role = this.createRole();
    const adminRole = role === 'admin' ? (form.elements.namedItem('adminRole') as HTMLSelectElement | null)?.value || '' : null;
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
        this.reloadWithCounts();
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Approves or rejects a role-upgrade request.
   */
  submitRequest(event: Event): void {
    event.preventDefault();
    if (!this.canMutate()) {
      return;
    }
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
        this.reloadWithCounts();
      },
      error: (error: unknown) => this.actionError.set(adminErrorMessage(error)),
    });
  }

  /**
   * Số đếm trên chip tab, hoặc dấu gạch khi chưa có số thật.
   *
   * Các signal đếm khởi tạo bằng 0 và render ngay, nên người vận hành thấy "0 / 0 / 0"
   * nháy lên rồi mới nhảy sang số đúng — trông như dữ liệu rỗng chứ không như đang tải.
   */
  kpi(value: number): string {
    return this.hasLoadedOnce() ? String(value) : '—';
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
    // Không có `lock_type` thì tài khoản chưa bao giờ bị khoá — nó đang chờ xác minh
    // OTP. Gọi đó là "Khóa tạm thời" khiến admin bấm mở khoá và vô tình bỏ qua xác thực.
    if (!row.lock_type) {
      return 'unverified';
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
    if (key === 'unverified') {
      return 'Chưa xác thực';
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

  private accountListParams(pageParams: Record<string, string>): Record<string, string> {
    const tab = this.tab();
    let role = '';
    if (tab === 'members') {
      role = 'member';
    } else if (tab === 'admins') {
      role = 'admin';
    } else if (this.roleFilter()) {
      role = this.roleFilter();
    }
    // "Bị khoá" đọc `lock_type`, không đọc `is_active`: tài khoản đăng ký dở OTP cũng
    // có `is_active=false` nhưng thuộc tab "Chưa xác thực".
    let isActive = '';
    let lockState = '';
    if (tab === 'locked' || this.statusFilter() === 'locked') {
      lockState = 'locked';
    } else if (tab === 'unverified' || this.statusFilter() === 'unverified') {
      lockState = 'unverified';
    } else if (this.statusFilter() === 'active') {
      isActive = 'true';
    }
    return {
      q: this.query(),
      role,
      isActive,
      lockState,
      ...pageParams,
    };
  }
}
