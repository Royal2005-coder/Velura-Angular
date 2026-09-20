import { Component, computed, inject, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AdminApiService, AdminAuditRow } from '../../core/admin-api.service';
import { adminDateTime } from '../../core/admin-format';
import { adminErrorMessage, adminListCount, adminListRows, adminOffset, adminRangeLabel } from '../../core/admin-http';
import { AdminEmptyState } from '../../shared/admin-empty-state';
import { AdminIcon } from '../../shared/admin-icon';
import { AdminPagination } from '../../shared/admin-pagination';

type LogTab = 'all' | 'admin' | 'system' | 'ai';

const EMPTY_LOGS = { rows: [] as AdminAuditRow[], count: 0 };

@Component({
  selector: 'app-admin-logs-page',
  imports: [AdminEmptyState, AdminIcon, AdminPagination],
  templateUrl: './admin-logs.page.html',
})
export class AdminLogsPage {
  private readonly api = inject(AdminApiService);

  readonly tab = signal<LogTab>('all');
  readonly query = signal('');
  readonly module = signal('');
  readonly rows = signal<AdminAuditRow[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly loading = signal(true);
  readonly page = signal(1);
  readonly pageSize = 10;
  readonly total = signal(0);
  readonly allCount = signal(0);
  readonly adminCount = signal(0);
  readonly systemCount = signal(0);
  readonly aiCount = signal(0);

  readonly todayCount = computed(() => {
    const today = new Date().toDateString();
    return this.rows().filter((row) => row.timestamp && new Date(row.timestamp).toDateString() === today).length;
  });
  readonly successCount = computed(() => this.rows().filter((row) => !this.isFailure(row) && !this.isBlocked(row)).length);
  readonly failureCount = computed(() => this.rows().filter((row) => this.isFailure(row)).length);
  readonly blockedCount = computed(() => this.rows().filter((row) => this.isBlocked(row)).length);
  readonly securityCount = computed(() => this.rows().filter((row) => this.isSecurity(row)).length);
  readonly paged = computed(() => this.rows());
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  readonly rangeLabel = computed(() => adminRangeLabel(this.total(), this.page(), this.pageSize, 'nhật ký'));

  constructor() {
    this.reload();
  }

  /**
   * Reloads the server-paged audit list for the active tab and filters.
   */
  reload(): void {
    this.loading.set(true);
    this.loadError.set(null);
    const listParams = this.listParams();
    forkJoin({
      logs: this.api.listAuditLogs(listParams).pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error));
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
    });
  }

  /**
   * Switches the original system-log tablist and reloads.
   */
  setTab(tab: LogTab): void {
    this.tab.set(tab);
    this.page.set(1);
    this.reload();
  }

  /**
   * Applies search and module filters on the server list.
   */
  applyFilters(event: Event): void {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    this.query.set((form.elements.namedItem('q') as HTMLInputElement | null)?.value.trim() || '');
    this.module.set((form.elements.namedItem('module') as HTMLSelectElement | null)?.value || '');
    this.page.set(1);
    this.reload();
  }

  /**
   * Clears search and module filters.
   */
  resetFilters(): void {
    this.query.set('');
    this.module.set('');
    this.page.set(1);
    this.reload();
  }

  /**
   * Moves log pagination.
   */
  goPage(page: number): void {
    this.page.set(Math.max(1, page));
    this.reload();
  }

  /**
   * Formats an audit timestamp with the original admin locale.
   */
  date(value: string | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Actor label for the log table.
   *
   * Tên người thao tác do API tra sẵn. Trước đây trang này tự join với một trang 100
   * tài khoản tải kèm, nên mọi thao tác của người ngoài 100 dòng đó hiện ra UUID.
   */
  actor(row: AdminAuditRow): string {
    return row.actor_label || row.actor_name || row.actor_id || 'Hệ thống';
  }

  private listParams(): Record<string, string> {
    return {
      q: this.query(),
      module: this.module(),
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
