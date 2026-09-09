import { Component, computed, inject, signal } from '@angular/core';
import { forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { AdminAccountRow, AdminApiService, AdminAuditRow } from '../../core/admin-api.service';
import { adminDateTime } from '../../core/admin-format';
import { adminErrorMessage, adminListRows } from '../../core/admin-http';
import { AdminIcon } from '../../shared/admin-icon';
import { AdminPagination } from '../../shared/admin-pagination';

const ADMIN_MODULES = ['accounts', 'products', 'orders', 'pricing', 'promotions', 'vouchers', 'returns', 'reviews', 'support'];

@Component({
  selector: 'app-admin-logs-page',
  imports: [AdminIcon, AdminPagination],
  templateUrl: './admin-logs.page.html',
})
export class AdminLogsPage {
  private readonly api = inject(AdminApiService);

  readonly tab = signal<'all' | 'admin' | 'system' | 'ai'>('all');
  readonly query = signal('');
  readonly module = signal('');
  readonly rows = signal<AdminAuditRow[]>([]);
  readonly accounts = signal<AdminAccountRow[]>([]);
  readonly loadError = signal<string | null>(null);
  readonly page = signal(1);
  readonly pageSize = 10;

  readonly todayCount = computed(() => {
    const today = new Date().toDateString();
    return this.rows().filter((row) => row.timestamp && new Date(row.timestamp).toDateString() === today).length;
  });
  readonly successCount = computed(() => this.rows().filter((row) => !this.isFailure(row) && !this.isBlocked(row)).length);
  readonly failureCount = computed(() => this.rows().filter((row) => this.isFailure(row)).length);
  readonly blockedCount = computed(() => this.rows().filter((row) => this.isBlocked(row)).length);
  readonly securityCount = computed(() => this.rows().filter((row) => this.isSecurity(row)).length);
  readonly adminCount = computed(() => this.rows().filter((row) => ADMIN_MODULES.includes(row.module || '')).length);
  readonly systemCount = computed(() => this.rows().filter((row) => row.module === 'system' || !row.module).length);
  readonly aiCount = computed(() => this.rows().filter((row) => row.module === 'ai').length);
  readonly filtered = computed(() => {
    const tab = this.tab();
    const query = this.query().toLowerCase();
    const module = this.module();
    return this.rows().filter((row) => {
      if (tab === 'admin' && !ADMIN_MODULES.includes(row.module || '')) {
        return false;
      }
      if (tab === 'system' && row.module && row.module !== 'system') {
        return false;
      }
      if (tab === 'ai' && row.module !== 'ai') {
        return false;
      }
      if (module && row.module !== module) {
        return false;
      }
      const haystack = `${row.action || ''} ${row.target_id || ''} ${row.actor_name || ''} ${row.actor_id || ''}`.toLowerCase();
      return !query || haystack.includes(query);
    });
  });
  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.filtered().length / this.pageSize)));
  readonly paged = computed(() => {
    const start = (this.page() - 1) * this.pageSize;
    return this.filtered().slice(start, start + this.pageSize);
  });
  readonly rangeLabel = computed(() => {
    const total = this.filtered().length;
    if (!total) {
      return 'Hiển thị 0 - 0 / 0 nhật ký';
    }
    const start = (this.page() - 1) * this.pageSize + 1;
    const end = Math.min(this.page() * this.pageSize, total);
    return `Hiển thị ${start} - ${end} / ${total} nhật ký`;
  });

  constructor() {
    forkJoin({
      logs: this.api.listAuditLogs({ limit: '1000' }).pipe(
        catchError((error: unknown) => {
          this.loadError.set(adminErrorMessage(error));
          return of({ rows: [] as AdminAuditRow[] });
        }),
      ),
      accounts: this.api.listAccounts({ limit: '100' }).pipe(catchError(() => of({ rows: [] as AdminAccountRow[] }))),
    }).subscribe((payload) => {
      this.rows.set(adminListRows(payload.logs));
      this.accounts.set(adminListRows(payload.accounts));
    });
  }

  /**
   * Switches the original system-log tablist.
   */
  setTab(tab: 'all' | 'admin' | 'system' | 'ai'): void {
    this.tab.set(tab);
    this.page.set(1);
  }

  /**
   * Applies the original log search field.
   */
  onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value.trim());
    this.page.set(1);
  }

  /**
   * Applies the original module filter.
   */
  onModule(event: Event): void {
    this.module.set((event.target as HTMLSelectElement).value);
    this.page.set(1);
  }

  /**
   * Clears search and module filters.
   */
  resetFilters(): void {
    this.query.set('');
    this.module.set('');
    this.page.set(1);
  }

  /**
   * Moves log pagination.
   */
  goPage(page: number): void {
    this.page.set(Math.min(this.pageCount(), Math.max(1, page)));
  }

  /**
   * Formats an audit timestamp with the original admin locale.
   */
  date(value: string | undefined): string {
    return adminDateTime(value);
  }

  /**
   * Actor label for the original log table, joined from accounts like vanilla logs.js.
   */
  actor(row: AdminAuditRow): string {
    const account = this.accounts().find((item) => item.user_id === row.actor_id);
    if (account) {
      return `${account.full_name || 'Admin'} (${account.email || row.actor_id})`;
    }
    return row.actor_name || row.actor_id || 'system';
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
