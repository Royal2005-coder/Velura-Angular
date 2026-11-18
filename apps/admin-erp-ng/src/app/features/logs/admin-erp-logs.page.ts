import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink, type ParamMap } from '@angular/router';
import { catchError, forkJoin, of } from 'rxjs';
import { type ListQuery, choiceParam, queryMatches, textParam, watchQueryParams, writeQueryParams } from '../../core/admin-erp-deep-link';
import { AdminAuditRow, AdminErpApiService } from '../../core/admin-erp-api.service';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';
import { adminDateTime } from '../../core/admin-erp-format';
import { useWorkspaceRefresh } from '../../core/admin-erp-refresh.service';
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

const LOG_TABS: readonly LogTab[] = ['all', 'admin', 'system', 'ai'];
const PAGE_SIZES = [10, 20, 50] as const;
const DEFAULT_PAGE_SIZE = 10;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const EMPTY_LOGS = { rows: [] as AdminAuditRow[], count: 0 };

/** A link from an audit row to the record it touched, in the workspace that owns that record. */
export interface AuditRecordLink {
  readonly label: string;
  readonly commands: readonly string[];
  readonly query: Readonly<Record<string, string>>;
}

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
  { value: 'vouchers', label: 'Voucher' },
  { value: 'content', label: 'Nội dung' },
  { value: 'members', label: 'Thành viên' },
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
    RouterLink,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './admin-erp-logs.page.html',
  styleUrl: './admin-erp-logs.page.scss',
})
export class AdminErpLogsPage {
  private readonly api = inject(AdminErpApiService);
  private readonly session = inject(AdminErpSessionService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  /** Set after the first URL read; later URL changes equal to the screen state are our own writes. */
  private urlApplied = false;

  readonly tab = signal<LogTab>('all');
  readonly query = signal('');
  readonly module = signal('');
  readonly actorFilter = signal('');
  readonly fromDate = signal('');
  readonly toDate = signal('');
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
  readonly pageSizes = PAGE_SIZES;
  readonly pageSize = signal<number>(DEFAULT_PAGE_SIZE);
  readonly selected = signal<AdminAuditRow | null>(null);
  /** Position of the open audit row in the current page, for drawer prev/next. */
  readonly selectedIndex = computed(() => {
    const current = this.selected();
    return current ? this.rows().findIndex((row) => row === current || (!!row.audit_id && row.audit_id === current.audit_id)) : -1;
  });
  readonly hasPrev = computed(() => this.selectedIndex() > 0);
  readonly hasNext = computed(() => {
    const index = this.selectedIndex();
    return index >= 0 && index < this.rows().length - 1;
  });
  /** Links from the open audit row to the record, order and customer it concerns. */
  readonly selectedLinks = computed(() => {
    const row = this.selected();
    return row ? auditRecordLinks(row) : [];
  });
  /** Only offer modules this role operates; the API rejects the rest with 403 anyway. */
  readonly moduleOptions = computed(() => {
    const allowed = this.session.session()?.allowedModules || [];
    if (allowed.includes('*')) {
      return MODULE_OPTIONS;
    }
    return MODULE_OPTIONS.filter((option) => !option.value || allowed.includes(String(option.value)));
  });

  readonly tabs = computed<readonly AdminErpTab[]>(() => [
    { key: 'all', label: 'Tất cả', count: this.allCount() },
    { key: 'admin', label: 'Thao tác Admin', count: this.adminCount() },
    { key: 'system', label: 'Sự kiện hệ thống', count: this.systemCount() },
    { key: 'ai', label: 'Nhật ký AI', count: this.aiCount() },
  ]);
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize(), 'nhật ký'));
  /** Any filter beyond the defaults is active (drives the empty-state "Xoá bộ lọc"). */
  readonly hasFilters = computed(
    () => !!(this.query() || this.module() || this.actorFilter() || this.fromDate() || this.toDate() || this.targetScope()),
  );
  readonly failureCount = computed(() => this.rows().filter((row) => this.isFailure(row)).length);
  readonly blockedCount = computed(() => this.rows().filter((row) => this.isBlocked(row)).length);
  readonly securityCount = computed(() => this.rows().filter((row) => this.isSecurity(row)).length);

  readonly columns: readonly AdminTableColumn[] = [
    {
      key: 'time',
      label: 'Thời gian',
      icon: 'clock',
      mono: true,
      value: (row) => this.date((row as AdminAuditRow).timestamp),
    },
    {
      key: 'actor',
      label: 'Người thực hiện',
      icon: 'user',
      truncate: '190px',
      value: (row) => this.actor(row as AdminAuditRow),
      subtext: (row) => this.role(row as AdminAuditRow),
    },
    {
      key: 'module',
      label: 'Phân hệ',
      icon: 'layers',
      value: (row) => this.moduleLabel(row as AdminAuditRow),
      cellIcon: (row) => {
        const mod = String((row as AdminAuditRow).module || '').toLowerCase();
        if (mod.includes('order')) return { name: 'shopping-bag', tone: 'accent' };
        if (mod.includes('return') || mod.includes('ticket')) return { name: 'return', tone: 'warning' };
        if (mod.includes('product')) return { name: 'box', tone: 'info' };
        if (mod.includes('pric')) return { name: 'coins', tone: 'success' };
        if (mod.includes('promo') || mod.includes('voucher')) return { name: 'ticket', tone: 'accent' };
        if (mod.includes('auth') || mod.includes('account')) return { name: 'shield-user', tone: 'info' };
        return { name: 'activity', tone: 'neutral' };
      },
    },
    {
      key: 'action',
      label: 'Hành động',
      icon: 'activity',
      truncate: '220px',
      value: (row) => this.action(row as AdminAuditRow),
    },
    {
      key: 'target',
      label: 'Đối tượng',
      icon: 'hash',
      truncate: '230px',
      value: (row) => this.target(row as AdminAuditRow),
      copyValue: (row) => String((row as AdminAuditRow).target_id || ''),
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
      copyValue: (row) => (row as AdminAuditRow).ip_address || '',
      mono: true,
    },
  ];
  /** Stable row identity so reloads keep the focused row. */
  readonly rowId = (row: unknown): string => {
    const audit = row as AdminAuditRow;
    return audit.audit_id || `${audit.timestamp}|${audit.action}|${audit.target_id}`;
  };

  constructor() {
    watchQueryParams(this.route, this.destroyRef, (params) => this.applyDeepLink(params));
    useWorkspaceRefresh(() => this.reload());
  }

  /**
   * The URL is the source of truth for tab, filters, record scope, page and page size, so Back,
   * refresh and links from other workspaces (`?module=orders&target=<id>`) reopen the same trail.
   * Our own `writeQueryParams` echoes back here; those echoes are skipped.
   */
  private applyDeepLink(params: ParamMap): void {
    if (this.urlApplied && queryMatches(params, this.currentQuery())) return;
    this.urlApplied = true;
    this.tab.set(choiceParam(params, 'tab', LOG_TABS, 'all') as LogTab);
    this.module.set(choiceParam(params, 'module', MODULE_OPTIONS.map((option) => String(option.value))));
    this.targetScope.set(textParam(params, 'target'));
    this.query.set(textParam(params, 'q'));
    this.actorFilter.set(textParam(params, 'actor'));
    this.fromDate.set(dateParam(params, 'from'));
    this.toDate.set(dateParam(params, 'to'));
    this.pageSize.set(Number(choiceParam(params, 'size', PAGE_SIZES.map(String), String(DEFAULT_PAGE_SIZE))));
    this.page.set(Math.max(1, Number.parseInt(params.get('page') || '1', 10) || 1));
    this.selected.set(null);
    this.reload();
  }

  /**
   * Drops the record scope coming from a deep link.
   */
  clearTarget(): void {
    this.targetScope.set('');
    this.page.set(1);
    this.syncUrl();
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
    if (this.loading()) return;
    if ((LOG_TABS as readonly string[]).includes(tab)) {
      this.tab.set(tab as LogTab);
      this.page.set(1);
      this.syncUrl();
      this.reload();
    }
  }

  /**
   * Applies the server-side search and module filters.
   */
  applyFilters(): void {
    this.page.set(1);
    this.syncUrl();
    this.reload();
  }

  /**
   * Clears filters and reloads the first page.
   */
  resetFilters(): void {
    this.query.set('');
    this.module.set('');
    this.actorFilter.set('');
    this.fromDate.set('');
    this.toDate.set('');
    this.targetScope.set('');
    this.page.set(1);
    this.syncUrl();
    this.reload();
  }

  /**
   * Moves the server page.
   */
  goPage(page: number): void {
    this.page.set(Math.max(1, page));
    this.syncUrl();
    this.reload();
  }

  /**
   * Changes rows per page and restarts from the first page.
   */
  setPageSize(size: number): void {
    this.pageSize.set(size);
    this.page.set(1);
    this.syncUrl();
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
   * Opens the previous audit row of the current page without closing the drawer.
   */
  openPrev(): void {
    const index = this.selectedIndex();
    if (index > 0) this.selected.set(this.rows()[index - 1]);
  }

  /**
   * Opens the next audit row of the current page without closing the drawer.
   */
  openNext(): void {
    const index = this.selectedIndex();
    if (index >= 0 && index < this.rows().length - 1) this.selected.set(this.rows()[index + 1]);
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
      actor: this.actorFilter(),
      from: this.fromDate() ? new Date(this.fromDate()).toISOString() : '',
      to: this.toDate() ? new Date(this.toDate()).toISOString() : '',
      targetId: this.targetScope(),
      scope: this.module() || this.tab() === 'all' ? '' : this.tab(),
      limit: String(this.pageSize()),
      offset: adminOffset(this.page(), this.pageSize()),
    };
  }

  /** The trail's view as URL params; defaults are neutral so a plain `/logs` stays clean. */
  private currentQuery(): ListQuery {
    return {
      tab: this.tab() === 'all' ? '' : this.tab(),
      q: this.query(),
      module: this.module(),
      actor: this.actorFilter(),
      from: this.fromDate(),
      to: this.toDate(),
      target: this.targetScope(),
      page: this.page() > 1 ? this.page() : '',
      size: this.pageSize() === DEFAULT_PAGE_SIZE ? '' : this.pageSize(),
    };
  }

  private syncUrl(): void {
    writeQueryParams(this.router, this.route, this.currentQuery());
  }

  /**
   * Tracks the actor filter (UAT: lọc theo người thực hiện).
   */
  onActorInput(event: Event): void {
    this.actorFilter.set((event.target as HTMLInputElement).value);
  }

  /**
   * Tracks the inclusive start of the time range.
   */
  onFromDate(event: Event): void {
    this.fromDate.set((event.target as HTMLInputElement).value);
  }

  /**
   * Tracks the inclusive end of the time range.
   */
  onToDate(event: Event): void {
    this.toDate.set((event.target as HTMLInputElement).value);
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

function dateParam(params: ParamMap, name: string): string {
  const value = params.get(name) || '';
  return DATE_PATTERN.test(value) ? value : '';
}

function payloadId(row: AdminAuditRow, ...keys: string[]): string {
  for (const snapshot of [row.new_value, row.old_value]) {
    if (!snapshot || typeof snapshot !== 'object') continue;
    for (const key of keys) {
      const value = (snapshot as Record<string, unknown>)[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  return '';
}

/** The searchable part of an enriched target label ("Tên (email)" → email, "CODE — tên" → CODE). */
function labelSearch(label: string | undefined, separator: 'email' | 'code' | 'name'): string {
  const text = String(label || '').trim();
  if (!text) return '';
  if (separator === 'email') return text.match(/\(([^()\s]+@[^()\s]+)\)$/)?.[1] || (text.includes('@') ? text : '');
  if (separator === 'code') return text.split(' — ')[0].trim();
  return text;
}

/**
 * Maps an audit row to the workspaces that own what it touched, using the query params each target
 * page reads (`focus` opens the record drawer). Workspaces without a get-by-id API resolve `focus`
 * against their loaded list, so the link also carries a search (`q`) that brings the record onto it.
 */
export function auditRecordLinks(row: AdminAuditRow): AuditRecordLink[] {
  const module = String(row.module || '').toLowerCase();
  const target = row.target_id || '';
  const links: AuditRecordLink[] = [];
  const productId = row.product_id || (['products', 'product', 'inventory', 'pricing'].includes(module) ? target : '');
  if (target) {
    if (module === 'orders') links.push({ label: 'Mở đơn hàng', commands: ['/orders'], query: { focus: target } });
    else if (module === 'returns' || module === 'return_exchange') links.push({ label: 'Mở hồ sơ đổi trả', commands: ['/returns'], query: { focus: target } });
    else if (module === 'support' || module === 'support_tickets') links.push({ label: 'Mở phiếu hỗ trợ', commands: ['/returns'], query: { tab: 'tickets', focus: target } });
    else if (module === 'reviews') links.push({ label: 'Mở đánh giá', commands: ['/reviews'], query: { focus: target } });
    else if (module === 'promotions') links.push({ label: 'Mở chiến dịch', commands: ['/promotions'], query: withSearch({ tab: 'campaigns', focus: target }, labelSearch(row.target_label, 'name')) });
    else if (module === 'vouchers') links.push({ label: 'Mở voucher', commands: ['/promotions'], query: withSearch({ tab: 'vouchers', focus: target }, labelSearch(row.target_label, 'code')) });
    else if (module === 'accounts' || module === 'auth') links.push({ label: 'Mở tài khoản', commands: ['/accounts'], query: withSearch({ focus: target }, labelSearch(row.target_label, 'email')) });
    else if (module === 'members') links.push({ label: 'Mở thành viên', commands: ['/members'], query: { focus: target } });
    else if (module === 'content') links.push({ label: 'Mở bài viết', commands: ['/content'], query: { focus: target } });
  }
  if (productId) links.push({ label: 'Mở sản phẩm', commands: ['/products'], query: { focus: productId } });
  const orderId = module === 'orders' ? '' : payloadId(row, 'order_id', 'source_order_id');
  if (orderId) links.push({ label: 'Mở đơn hàng', commands: ['/orders'], query: { focus: orderId } });
  const customerId = ['members', 'accounts', 'auth'].includes(module) ? '' : payloadId(row, 'customer_id', 'user_id');
  if (customerId) links.push({ label: 'Mở khách hàng', commands: ['/members'], query: { focus: customerId } });
  return links;
}

function withSearch(query: Record<string, string>, q: string): Record<string, string> {
  return q ? { ...query, q } : query;
}
