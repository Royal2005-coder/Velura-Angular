import { ChangeDetectionStrategy, Component, ElementRef, HostListener, computed, effect, inject, input, output, viewChild } from '@angular/core';
import { AdminErpConfirmService } from '../../core/admin-erp-confirm.service';
import { lockBodyScroll } from '../../core/body-scroll-lock';
import { isTopOverlay, pushOverlay } from '../../core/overlay-stack';

let modalSequence = 0;

/**
 * Accessible modal shell: backdrop close, Escape, initial focus, reactive inert stacking, and a Tab trap.
 */
@Component({
  selector: 'app-erp-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div class="modal-backdrop" [class.modal-backdrop--elevated]="elevated()" (mousedown)="onBackdrop($event)">
        <section
          #panel
          class="modal-panel"
          [class]="'modal-panel modal-panel--' + size()"
          role="dialog"
          aria-modal="true"
          [attr.aria-labelledby]="titleId"
          [attr.aria-busy]="busy()"
          [attr.inert]="!isTop() ? '' : null"
          tabindex="-1"
          (keydown)="onPanelKeydown($event)"
        >
          <header class="modal-head">
            <h2 [id]="titleId">{{ title() }}</h2>
            <button class="erp-icon-btn" type="button" aria-label="Đóng" [disabled]="busy()" (click)="close()">×</button>
          </header>
          <div class="modal-body"><ng-content /></div>
          <footer class="modal-foot"><ng-content select="[footer]" /></footer>
        </section>
      </div>
    }
  `,
  styles: [
    `
      .modal-backdrop {
        position: fixed;
        inset: 0;
        z-index: 80;
        display: grid;
        place-items: center;
        padding: 20px;
        background: rgba(15, 23, 42, 0.45);
        backdrop-filter: blur(2px);
      }
      .modal-backdrop--elevated {
        z-index: 120;
      }
      .modal-panel {
        display: grid;
        /* Head and footer stay put; only the body scrolls, so Save is always reachable. */
        grid-template-rows: auto minmax(0, 1fr) auto;
        width: min(100%, 560px);
        max-height: min(86vh, 760px);
        overflow: hidden;
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-xl);
        background: var(--erp-surface);
        box-shadow: var(--erp-shadow-modal);
      }
      .modal-panel--sm {
        width: min(100%, 420px);
      }
      .modal-panel--lg {
        width: min(100%, 820px);
      }
      .modal-panel--xl {
        width: min(100%, 1180px);
        max-height: min(92vh, 980px);
      }
      .modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 18px 24px;
        border-bottom: 1px solid var(--erp-line);
      }
      h2 {
        font-family: var(--erp-display);
        font-size: 18px;
        font-weight: 600;
        color: var(--erp-ink);
      }
      .modal-body {
        overflow-y: auto;
        padding: 20px 24px;
      }
      .modal-foot {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 14px 20px;
        border-top: 1px solid var(--erp-line);
        background: var(--erp-surface-muted);
      }
      .modal-foot:empty {
        display: none;
      }
    `,
  ],
})
export class AdminErpModal {
  readonly open = input(false);
  readonly title = input.required<string>();
  readonly size = input<'sm' | 'md' | 'lg' | 'xl'>('md');
  /** Unsaved edits inside: closing asks "Bỏ thay đổi?" first. */
  readonly dirty = input(false);
  /** A save is in flight: closing is blocked so a half-finished write can't be abandoned. */
  readonly busy = input(false);
  /** Raises z-index above standard workspace modals (used by stacked confirm dialogs). */
  readonly elevated = input(false);
  readonly titleId = `erp-modal-title-${++modalSequence}`;
  protected readonly isTop = computed(() => !this.open() || isTopOverlay(this));
  private readonly confirm = inject(AdminErpConfirmService);
  readonly closed = output<void>();
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private lastFocused: HTMLElement | null = null;

  constructor() {
    effect((onCleanup) => {
      if (!this.open()) {
        return;
      }
      this.lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const releaseScroll = lockBodyScroll();
      const releaseOverlay = pushOverlay(this);
      queueMicrotask(() => this.panel()?.nativeElement.focus());
      onCleanup(() => {
        releaseScroll();
        releaseOverlay();
        const target = this.lastFocused;
        this.lastFocused = null;
        if (target?.isConnected) {
          target.focus();
        }
      });
    });
  }

  /**
   * Asks the owner to close, honouring the busy/dirty guards; the owner decides whether to unmount.
   */
  async close(): Promise<void> {
    if (this.busy()) return;
    if (this.dirty() && !(await this.confirm.discardChanges())) return;
    this.closed.emit();
  }

  /**
   * Closes only when the backdrop itself is clicked.
   */
  onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) {
      this.close();
    }
  }

  /**
   * Keeps keyboard focus inside the dialog.
   */
  onPanelKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab') {
      return;
    }
    const focusable = this.panel()?.nativeElement.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (!focusable?.length) {
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /** Escape closes only the topmost overlay (a nested confirm closes before its parent). */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open() && isTopOverlay(this)) {
      this.close();
    }
  }
}
