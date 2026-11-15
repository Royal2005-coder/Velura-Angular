import { ChangeDetectionStrategy, Component, Injectable, inject, signal } from '@angular/core';

/** Visual meaning of a toast; errors stay longer and are announced assertively. */
export type AdminToastTone = 'success' | 'error' | 'warning' | 'info';

/** One transient notification about the result of an operator action. */
export interface AdminToast {
  readonly id: number;
  readonly tone: AdminToastTone;
  readonly message: string;
}

/**
 * One place to report the outcome of a mutation ("Đã lưu", "Không lưu được: …"), so every module gives the
 * same feedback in the same corner instead of each page inventing its own banner.
 */
@Injectable({ providedIn: 'root' })
export class AdminErpToastService {
  private sequence = 0;
  private readonly items = signal<readonly AdminToast[]>([]);
  /** Toasts currently on screen, oldest first. */
  readonly toasts = this.items.asReadonly();

  /** Confirms a completed action. */
  success(message: string): void {
    this.show('success', message);
  }

  /** Reports a failed action; kept on screen longer so it can be read. */
  error(message: string): void {
    this.show('error', message);
  }

  /** Neutral or cautionary information. */
  info(message: string, tone: 'info' | 'warning' = 'info'): void {
    this.show(tone, message);
  }

  /** Removes a toast early (close button). */
  dismiss(id: number): void {
    this.items.update((list) => list.filter((toast) => toast.id !== id));
  }

  private show(tone: AdminToastTone, message: string): void {
    const id = ++this.sequence;
    // At most 4 visible: a burst of results must not bury the screen.
    this.items.update((list) => [...list.slice(-3), { id, tone, message }]);
    setTimeout(() => this.dismiss(id), tone === 'error' ? 7000 : 3500);
  }
}

/** Renders the toast stack once, in the shell. */
@Component({
  selector: 'app-erp-toast-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="toast-stack" aria-live="polite">
      @for (toast of toasts.toasts(); track toast.id) {
        <div class="toast" [class]="'toast toast--' + toast.tone" [attr.role]="toast.tone === 'error' ? 'alert' : 'status'">
          <span class="toast__dot" aria-hidden="true"></span>
          <span class="toast__message">{{ toast.message }}</span>
          <button type="button" class="toast__close" aria-label="Đóng thông báo" (click)="toasts.dismiss(toast.id)">×</button>
        </div>
      }
    </div>
  `,
  styles: [
    `
      .toast-stack {
        position: fixed;
        right: 20px;
        bottom: 20px;
        z-index: 1200;
        display: grid;
        gap: 8px;
        width: min(380px, calc(100vw - 32px));
        pointer-events: none;
      }
      .toast {
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: start;
        gap: 10px;
        padding: 12px 12px 12px 14px;
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-md);
        background: var(--erp-surface);
        box-shadow: var(--erp-shadow-md);
        color: var(--erp-text);
        font-size: 13.5px;
        line-height: 1.45;
        pointer-events: auto;
        animation: toast-in 160ms ease-out;
      }
      .toast__dot {
        width: 8px;
        height: 8px;
        margin-top: 6px;
        border-radius: 50%;
        background: var(--erp-info);
      }
      .toast--success .toast__dot { background: var(--erp-success); }
      .toast--error { border-color: var(--erp-danger-line); }
      .toast--error .toast__dot { background: var(--erp-danger); }
      .toast--warning .toast__dot { background: var(--erp-warning); }
      .toast__close {
        width: 28px;
        height: 28px;
        border: 0;
        border-radius: var(--erp-radius-sm);
        background: transparent;
        color: var(--erp-muted);
        font-size: 18px;
        line-height: 1;
        cursor: pointer;
      }
      .toast__close:hover { background: var(--erp-surface-muted); }
      @keyframes toast-in {
        from { transform: translateY(6px); opacity: 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .toast { animation: none; }
      }
    `,
  ],
})
export class AdminErpToastHost {
  protected readonly toasts = inject(AdminErpToastService);
}
