import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AdminApiService, AdminInsightBoardModel, AdminInsightRange, AdminInsightSeverity } from '../core/admin-api.service';
import { emptyInsightBoard } from '../core/admin-insight-state';

const SEVERITY_LABEL: Record<AdminInsightSeverity, string> = {
  critical: 'Chặn hoạch định',
  high: 'Cần điều hướng',
  watch: 'Theo dõi',
  ok: 'Giữ hướng',
};

/**
 * Module insight dashboard. Loads `/api/v1/admin/insights` for one scope and period.
 */
@Component({
  selector: 'app-admin-insight-board',
  imports: [RouterLink],
  template: `
    <section class="insight-board" [attr.aria-label]="title()">
      <header class="insight-board__head">
        <div>
          <span class="dashboard-eyebrow">{{ eyebrow() }}</span>
          <h2>{{ displayBoard().headline || title() }}</h2>
        </div>
        @if (showRange()) {
          <div class="dashboard-time-filter" role="group" aria-label="Khoảng thời gian">
            <button type="button" [class.is-active]="range() === 'day'" (click)="setRange('day')">Ngày</button>
            <button type="button" [class.is-active]="range() === 'week'" (click)="setRange('week')">Tuần</button>
            <button type="button" [class.is-active]="range() === 'month'" (click)="setRange('month')">Tháng</button>
          </div>
        }
      </header>
      @if (isLoading()) {
        <p class="admin-note">Đang đọc phản hồi khách hàng trong kỳ…</p>
      } @else if (!displayBoard().questions.length) {
        <p class="admin-note">Chưa có insight cho kỳ này. Đổi ngày / tuần / tháng rồi thử lại.</p>
      } @else {
        <div class="insight-board__questions">
          @for (item of displayBoard().questions; track item.id) {
            <article class="insight-question" [class]="'insight-question--' + item.severity">
              <div class="insight-question__meta">
                <span class="admin-badge" [class]="'admin-badge--' + badgeTone(item.severity)">{{ severityLabel(item.severity) }}</span>
                <h3>{{ item.question }}</h3>
              </div>
              <p>{{ item.answer }}</p>
              <dl class="insight-evidence">
                @for (row of item.evidence; track row.label) {
                  <div>
                    <dt>{{ row.label }}</dt>
                    <dd>{{ row.value }}</dd>
                  </div>
                }
              </dl>
            </article>
          }
        </div>
        <div class="insight-board__actions">
          <h3>Việc hoạch định</h3>
          @for (action of displayBoard().actions; track action.id) {
            <article class="insight-action">
              <div>
                <strong>{{ action.title }}</strong>
                <p>{{ action.reason }}</p>
                <small>{{ action.clientSteer }}</small>
              </div>
              <a [routerLink]="action.route">{{ action.routeLabel }}</a>
            </article>
          }
        </div>
      }
    </section>
  `,
})
export class AdminInsightBoard {
  private readonly api = inject(AdminApiService);

  readonly scope = input('');
  readonly title = input('Dashboard phân hệ');
  readonly eyebrow = input('Câu hỏi quản trị');
  readonly showRange = input(true);
  readonly boardInput = input<AdminInsightBoardModel | null>(null, { alias: 'board' });
  readonly loadingInput = input(false, { alias: 'loading' });
  readonly rangeInput = input<AdminInsightRange>('week', { alias: 'range' });

  readonly range = signal<AdminInsightRange>('week');
  readonly loadedBoard = signal<AdminInsightBoardModel>(emptyInsightBoard());
  readonly loadedLoading = signal(false);
  readonly displayBoard = computed(() => this.boardInput() ?? this.loadedBoard());
  readonly isLoading = computed(() => (this.scope() ? this.loadedLoading() : this.loadingInput()));

  constructor() {
    effect(() => {
      const scope = this.scope();
      const range = this.range();
      if (!scope) {
        return;
      }
      untracked(() => this.reload(scope, range));
    });
  }

  /**
   * Applies a fixed day / week / month window for this module board.
   */
  setRange(range: AdminInsightRange): void {
    this.range.set(range);
  }

  /**
   * Maps severity onto the existing admin badge tone.
   */
  badgeTone(severity: AdminInsightSeverity): string {
    if (severity === 'critical' || severity === 'high') return 'danger';
    if (severity === 'watch') return 'warning';
    return 'success';
  }

  /**
   * Human label for a severity code.
   */
  severityLabel(severity: AdminInsightSeverity): string {
    return SEVERITY_LABEL[severity];
  }

  private reload(scope: string, range: AdminInsightRange): void {
    this.loadedLoading.set(true);
    this.api.insights({ scope, range }).subscribe({
      next: (payload) => {
        this.loadedBoard.set(payload.board);
        this.loadedLoading.set(false);
      },
      error: () => {
        this.loadedBoard.set(emptyInsightBoard(scope));
        this.loadedLoading.set(false);
      },
    });
  }
}
