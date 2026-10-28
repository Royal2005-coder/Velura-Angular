import { ChangeDetectionStrategy, Component, ElementRef, HostListener, effect, input, output, viewChild } from '@angular/core';

/**
 * Accessible modal shell: backdrop close, Escape, initial focus and a Tab trap.
 */
@Component({
  selector: 'app-erp-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div class="modal-backdrop" (mousedown)="onBackdrop($event)">
        <section
          #panel
          class="modal-panel"
          [class]="'modal-panel--' + size()"
          role="dialog"
          aria-modal="true"
          aria-labelledby="erp-modal-title"
          tabindex="-1"
          (keydown)="onPanelKeydown($event)"
        >
          <header class="modal-head">
            <h2 id="erp-modal-title">{{ title() }}</h2>
            <button class="erp-icon-btn" type="button" aria-label="Đóng" (click)="close()">×</button>
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
        background: rgba(36, 31, 28, 0.48);
      }
      .modal-panel {
        display: grid;
        width: min(100%, 560px);
        max-height: min(86vh, 760px);
        overflow: auto;
        border: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-lg);
        background: var(--erp-surface);
        box-shadow: 0 30px 80px -30px rgba(36, 31, 28, 0.6);
      }
      .modal-panel--sm {
        width: min(100%, 420px);
      }
      .modal-panel--lg {
        width: min(100%, 820px);
      }
      .modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 18px 20px;
        border-bottom: 1px solid var(--erp-line);
      }
      h2 {
        font-family: var(--erp-display);
        font-size: 20px;
        font-weight: 600;
      }
      .modal-body {
        padding: 20px;
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
  readonly size = input<'sm' | 'md' | 'lg'>('md');
  readonly closed = output<void>();
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private lastFocused: HTMLElement | null = null;

  constructor() {
    effect((onCleanup) => {
      if (!this.open()) {
        return;
      }
      this.lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      queueMicrotask(() => this.panel()?.nativeElement.focus());
      onCleanup(() => {
        document.body.style.overflow = previousOverflow;
        const target = this.lastFocused;
        this.lastFocused = null;
        if (target?.isConnected) {
          target.focus();
        }
      });
    });
  }

  /**
   * Emits close so the owner decides whether to keep the modal mounted.
   */
  close(): void {
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

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open()) {
      this.close();
    }
  }
}
