import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, type ParamMap } from '@angular/router';
import { catchError, forkJoin, of, skip } from 'rxjs';
import { AdminAuditRow, AdminErpApiService } from '../../core/admin-erp-api.service';
import { adminDateTime } from '../../core/admin-erp-format';
import {
  adminErrorMessage,
  adminListCount,
  adminListRows,
  adminOffset,
  adminRangeLabel,
} from '../../core/admin-erp-http';
import {
  AUDIT_MODULE_LABELS,
  AUDIT_RESULT_LABELS,
  AdminTone,
  auditResultTone,
  statusLabelFrom,
} from '../../core/admin-erp-status-labels';
import { AdminErpDataTable, AdminTableColumn } from '../../shared/ui/admin-data-table';
import { AdminErpDrawer } from '../../shared/ui/admin-drawer';
import { AdminErpFilterBar } from '../../shared/ui/admin-filter-bar';
import { AdminErpIcon } from '../../shared/ui/admin-erp-icon';
import { AdminErpKpiCard } from '../../shared/ui/admin-kpi-card';
import { AdminErpPageHeader } from '../../shared/ui/admin-page-header';
import { AdminErpPagination } from '../../shared/ui/admin-pagination';
import { AdminErpStatusBadge } from '../../shared/ui/admin-status-badge';
import { AdminErpTab, AdminErpTabs } from '../../shared/ui/admin-tabs';

type LogTab = 'all' | 'admin' | 'system' | 'ai';

const EMPTY_LOGS = { rows: [] as AdminAuditRow[], count: 0 };

const MODULE_OPTIONS = [
  { value: '', label: 'Tất cả phân hệ' },
  { value: 'accounts', label: 'Tài khoản' },
  { value: 'products', label: 'Sản phẩm' },
  { value: 'orders', label: 'Đơn hàng' },
  { value: 'reviews', label: 'Đánh giá' },
  { value: 'returns', label: 'Đổi trả' },
  { value: 'support', label: 'Hỗ trợ' },
  { value: 'pricing', label: 'Giá bán' },
  { value: 'promotions', label: 'Khuyến mãi' },
  { value: 'auth', label: 'Xác thực' },
  { value: 'ai', label: 'AI' },
  { value: 'system', label: 'Hệ thống' },
];

/**
 * Server-paged system audit workspace. Counts, tabs and filters come from the API.
 */
@Component({
  selector: 'app-admin-erp-logs-page',
  imports: [
    AdminErpPageHeader,
    AdminErpKpiCard,
    AdminErpTabs,
    AdminErpFilterBar,
    AdminErpDataTable,
    AdminErpPagination,
    AdminErpDrawer,
    AdminErpStatusBadge,
    AdminErpIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-erp-logs.page.html',
  styleUrl: './admin-erp-logs.page.scss',
})
export class AdminErpLogsPage {
  private readonly api = inject(AdminErpApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly tab = signal<LogTab>('all');
  readonly query = signal('');
  readonly module = signal('');
  readonly targetScope = signal('');
  readonly rows = signal<AdminAuditRow[]>([]);
  readonly total = signal(0);
  readonly allCount = signal(0);
  readonly adminCount = signal(0);
  readonly systemCount = signal(0);
  readonly aiCount = signal(0);
  readonly loading = signal(true);
  readonly hasLoadedOnce = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly page = signal(1);
  readonly pageSize = 10;
  readonly selected = signal<AdminAuditRow | null>(null);
  readonly moduleOptions = MODULE_OPTIONS;

  readonly tabs = computed<readonly AdminErpTab[]>(() => [
    { key: 'all', label: 'Tất cả', count: this.allCount() },
    { key: 'admin', label: 'Thao tác Admin', count: this.adminCount() },
    { key: 'system', label: 'Sự kiện hệ thống', count: this.systemCount() },
    { key: 'ai', label: 'Nhật ký AI', count: this.aiCount() },
  ]);
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize, 'nhật ký'));
  readonly failureCount = computed(() => this.rows().filter((row) => this.isFailure(row)).length);
  readonly blockedCount = computed(() => this.rows().filter((row) => this.isBlocked(row)).length);
  readonly securityCount = computed(() => this.rows().filter((row) => this.isSecurity(row)).length);

  readonly columns: readonly AdminTableColumn[] = [
    {
      key: 'time',
      label: 'Thời gian',
      width: '150px',
      mono: true,
      value: (row) => this.date((row as AdminAuditRow).timestamp),
    },
    {
      key: 'actor',
      label: 'Người thực hiện',
      value: (row) => this.actor(row as AdminAuditRow),
    },
    {
      key: 'role',
      label: 'Vai trò',
      value: (row) => this.role(row as AdminAuditRow),
    },
    {
      key: 'module',
      label: 'Phân hệ',
      value: (row) => this.moduleLabel(row as AdminAuditRow),
    },
    {
      key: 'action',
      label: 'Hành động',
      value: (row) => this.action(row as AdminAuditRow),
    },
    {
      key: 'target',
      label: 'Đối tượng',
      value: (row) => this.target(row as AdminAuditRow),
    },
    {
      key: 'result',
      label: 'Kết quả',
      value: (row) => this.resultLabel(row as AdminAuditRow),
      badge: (row) => {
        const audit = row as AdminAuditRow;
        const result = String(audit.result || '').toLowerCase();
        return result
          ? { label: statusLabelFrom(AUDIT_RESULT_LABELS, result), tone: auditResultTone(result) }
          : null;
      },
    },
    {
      key: 'ip',
      label: 'IP',
      value: (row) => (row as AdminAuditRow).ip_address || '—',
      mono: true,
    },
  ];

  constructor() {
    this.applyDeepLink(this.route.snapshot.queryParamMap);
    this.route.queryParamMap.pipe(skip(1), takeUntilDestroyed(this.destroyRef)).subscribe((params) => this.applyDeepLink(params));
  }

  /**
   * Scopes the trail to one record when another workspace links here, so an operator lands on
   * the audit of the order or return they were reading instead of the whole log.
   */
  private applyDeepLink(params: ParamMap): void {
    this.module.set(params.get('module') || '');
    this.targetScope.set(params.get('target') || '');
    this.query.set(params.get('q') || '');
    this.page.set(1);
    this.reload();
  }

  /**
   * Drops the record scope coming from a deep link.
   */
  clearTarget(): void {
    this.targetScope.set('');
    this.page.set(1);
    this.reload();
  }

  /**
   * Reloads the server list and all tab counts for the active filters.
   */
  reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    const params = this.listParams();
    forkJoin({
      logs: this.api.listAuditLogs(params).pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error, 'Không tải được nhật ký hệ thống.'));
          return of(EMPTY_LOGS);
        }),
      ),
      all: this.api.listAuditLogs({ limit: '1' }).pipe(catchError(() => of(EMPTY_LOGS))),
      admin: this.api.listAuditLogs({ scope: 'admin', limit: '1' }).pipe(catchError(() => of(EMPTY_LOGS))),
      system: this.api.listAuditLogs({ scope: 'system', limit: '1' }).pipe(catchError(() => of(EMPTY_LOGS))),
      ai: this.api.listAuditLogs({ scope: 'ai', limit: '1' }).pipe(catchError(() => of(EMPTY_LOGS))),
    }).subscribe((payload) => {
      this.rows.set(adminListRows(payload.logs));
      this.total.set(adminListCount(payload.logs));
      this.allCount.set(adminListCount(payload.all));
      this.adminCount.set(adminListCount(payload.admin));
      this.systemCount.set(adminListCount(payload.system));
      this.aiCount.set(adminListCount(payload.ai));
      this.loading.set(false);
      this.hasLoadedOnce.set(true);
    });
  }

  /**
   * Switches tabs and resets pagination.
   */
  setTab(tab: string): void {
    if (tab === 'all' || tab === 'admin' || tab === 'system' || tab === 'ai') {
      this.tab.set(tab);
      this.page.set(1);
      this.reload();
    }
  }

  /**
   * Applies the server-side search and module filters.
   */
  applyFilters(): void {
    this.page.set(1);
    this.reload();
  }

  /**
   * Clears filters and reloads the first page.
   */
  resetFilters(): void {
    this.query.set('');
    this.module.set('');
    this.targetScope.set('');
    this.page.set(1);
    this.reload();
  }

  /**
   * Moves the server page.
   */
  goPage(page: number): void {
    this.page.set(Math.max(1, page));
    this.reload();
  }

  /**
   * Opens the audit detail drawer.
   */
  openRow(row: unknown): void {
    this.selected.set(row as AdminAuditRow);
  }

  /**
   * Closes the audit detail drawer.
   */
  closeDrawer(): void {
    this.selected.set(null);
  }

  /**
   * Updates the free-text query from the filter control.
   */
  onQueryInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /**
   * Updates the module filter from the filter control.
   */
  onModuleChange(event: Event): void {
    this.module.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Formats a timestamp in Vietnam time.
   */
  date(value: string | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Prefers the enriched actor label from the API.
   */
  actor(row: AdminAuditRow): string {
    return row.actor_label || row.actor_name || row.actor_id || 'Hệ thống';
  }

  /**
   * Actor role label for the detail/table.
   */
  role(row: AdminAuditRow): string {
    return row.actor_role_label || row.actor_role || '—';
  }

  /**
   * Module label in Vietnamese.
   */
  moduleLabel(row: AdminAuditRow): string {
    return statusLabelFrom(AUDIT_MODULE_LABELS, row.module);
  }

  /**
   * Action label from the API, preserving unknown codes.
   */
  action(row: AdminAuditRow): string {
    return row.action_label || row.action || '—';
  }

  /**
   * Target label or short id.
   */
  target(row: AdminAuditRow): string {
    return row.target_label || row.target_id || '—';
  }

  /**
   * Result label, defaulting to success when the backend does not store a result.
   */
  resultLabel(row: AdminAuditRow): string {
    return row.result ? statusLabelFrom(AUDIT_RESULT_LABELS, row.result) : '—';
  }

  /**
   * Result badge tone for the detail drawer.
   */
  resultTone(row: AdminAuditRow): AdminTone {
    return auditResultTone(row.result);
  }

  /**
   * Pretty-prints a snapshot for the detail drawer.
   */
  json(value: unknown): string {
    if (value === null || value === undefined) {
      return '—';
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  /**
   * Formats a count in the Vietnamese locale.
   */
  num(value: number): string {
    return Number(value || 0).toLocaleString('vi-VN');
  }

  private listParams(): Record<string, string> {
    return {
      q: this.query(),
      module: this.module(),
      targetId: this.targetScope(),
      scope: this.module() || this.tab() === 'all' ? '' : this.tab(),
      limit: String(this.pageSize),
      offset: adminOffset(this.page(), this.pageSize),
    };
  }

  private isFailure(row: AdminAuditRow): boolean {
    const action = String(row.action || '').toLowerCase();
    return action.includes('fail') || action.includes('error') || row.result === 'failure';
  }

  private isBlocked(row: AdminAuditRow): boolean {
    const action = String(row.action || '').toLowerCase();
    return action.includes('block') || action.includes('deny') || action.includes('refuse');
  }

  private isSecurity(row: AdminAuditRow): boolean {
    const action = String(row.action || '').toLowerCase();
    return action.includes('auth') || action.includes('login') || action.includes('role') || action.includes('permission');
  }
}
