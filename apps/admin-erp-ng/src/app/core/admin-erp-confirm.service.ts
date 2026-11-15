import { Injectable, signal } from '@angular/core';

/** What a consequential or irreversible action asks the operator before it runs. */
export interface AdminConfirmOptions {
  title: string;
  message?: string;
  /** Button label naming the action ("Khoá tài khoản"), never a bare "OK". */
  confirmLabel?: string;
  /** `danger` for destructive/irreversible actions. */
  tone?: 'danger' | 'primary';
  /** Require a written reason (audit trail); the confirm button stays disabled until it is long enough. */
  requireReason?: boolean;
  reasonLabel?: string;
  reasonMinLength?: number;
}

/** Operator decision; `reason` is the trimmed text when a reason was requested. */
export interface AdminConfirmResult {
  confirmed: boolean;
  reason: string;
}

/** A confirmation waiting for the operator, with the resolver of its promise. */
export interface AdminPendingConfirm extends AdminConfirmOptions {
  resolve: (result: AdminConfirmResult) => void;
}

/**
 * Promise-based confirmation for consequential actions: `if (!(await confirm.ask({...})).confirmed) return;`.
 * One dialog style everywhere (rendered by `app-erp-confirm-host` in the shell), the action named on the
 * button, and an optional mandatory reason.
 */
@Injectable({ providedIn: 'root' })
export class AdminErpConfirmService {
  private readonly current = signal<AdminPendingConfirm | null>(null);
  /** The confirmation currently waiting for the operator, if any. */
  readonly pending = this.current.asReadonly();

  /** Opens the dialog; a newer request cancels an unanswered older one. */
  ask(options: AdminConfirmOptions): Promise<AdminConfirmResult> {
    this.current()?.resolve({ confirmed: false, reason: '' });
    // Executor form: this app's TS lib predates ES2024 `Promise.withResolvers`.
    return new Promise<AdminConfirmResult>((resolve) => this.current.set({ ...options, resolve }));
  }

  /** Resolves the open dialog (used by the host). */
  answer(result: AdminConfirmResult): void {
    const pending = this.current();
    this.current.set(null);
    pending?.resolve(result);
  }

  /** Standard "discard unsaved changes?" question used by modals/drawers with `[dirty]`. */
  async discardChanges(): Promise<boolean> {
    const result = await this.ask({
      title: 'Bỏ thay đổi chưa lưu?',
      message: 'Các thay đổi trong biểu mẫu này sẽ mất nếu đóng bây giờ.',
      confirmLabel: 'Bỏ thay đổi',
      tone: 'danger',
    });
    return result.confirmed;
  }
}
