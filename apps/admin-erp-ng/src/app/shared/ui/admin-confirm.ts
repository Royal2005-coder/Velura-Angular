import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { AdminErpConfirmService } from '../../core/admin-erp-confirm.service';
import { AdminErpModal } from './admin-modal';

/** Renders the confirm dialog once, in the shell. */
@Component({
  selector: 'app-erp-confirm-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminErpModal],
  template: `
    @if (confirm.pending(); as request) {
      <app-erp-modal [open]="true" [elevated]="true" [title]="request.title" size="sm" (closed)="cancel()">
        @if (request.message) {
          <p class="confirm__message">{{ request.message }}</p>
        }
        @if (request.requireReason) {
          <label class="erp-field confirm__reason">
            <span>{{ request.reasonLabel || 'Lý do (ghi vào nhật ký)' }}</span>
            <textarea
              class="erp-textarea"
              rows="3"
              [value]="reason()"
              (input)="onReason($event)"
            ></textarea>
            <small class="erp-hint">Tối thiểu {{ minLength() }} ký tự.</small>
          </label>
        }
        <div footer class="confirm__actions">
          <button type="button" class="erp-btn erp-btn--ghost" (click)="cancel()">Huỷ</button>
          <button
            type="button"
            class="erp-btn"
            [class.erp-btn--danger]="request.tone === 'danger'"
            [class.erp-btn--primary]="request.tone !== 'danger'"
            [disabled]="!canConfirm()"
            (click)="accept()"
          >
            {{ request.confirmLabel || 'Xác nhận' }}
          </button>
        </div>
      </app-erp-modal>
    }
  `,
  styles: [
    `
      .confirm__message { margin: 0 0 4px; color: var(--erp-text); line-height: 1.55; }
      .confirm__reason { margin-top: 12px; }
      .confirm__actions { display: flex; gap: 8px; justify-content: flex-end; width: 100%; }
    `,
  ],
})
export class AdminErpConfirmHost {
  protected readonly confirm = inject(AdminErpConfirmService);
  protected readonly reason = signal('');
  protected readonly minLength = computed(() => this.confirm.pending()?.reasonMinLength ?? 5);
  protected readonly canConfirm = computed(() => {
    const request = this.confirm.pending();
    return !request?.requireReason || this.reason().trim().length >= this.minLength();
  });

  constructor() {
    effect(() => {
      this.confirm.pending();
      untracked(() => this.reason.set(''));
    });
  }

  protected onReason(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
  }

  protected accept(): void {
    if (!this.canConfirm()) return;
    const reason = this.reason().trim();
    this.reason.set('');
    this.confirm.answer({ confirmed: true, reason });
  }

  protected cancel(): void {
    this.reason.set('');
    this.confirm.answer({ confirmed: false, reason: '' });
  }
}
