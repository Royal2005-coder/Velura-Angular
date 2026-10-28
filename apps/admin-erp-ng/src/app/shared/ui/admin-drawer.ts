import { ChangeDetectionStrategy, Component, ElementRef, HostListener, effect, input, output, viewChild } from '@angular/core';

/**
 * Right-side detail drawer with backdrop close, Escape and a Tab trap.
 */
@Component({
  selector: 'app-erp-drawer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (open()) {
      <div class="drawer-backdrop" (mousedown)="onBackdrop($event)">
        <aside
          #panel
          class="drawer-panel"
          [class]="'drawer-panel--' + size()"
          role="dialog"
          aria-modal="true"
          aria-labelledby="erp-drawer-title"
          tabindex="-1"
          (keydown)="onPanelKeydown($event)"
        >
          <header class="drawer-head">
            <h2 id="erp-drawer-title">{{ title() }}</h2>
            <button class="erp-icon-btn" type="button" aria-label="Đóng" (click)="close()">×</button>
          </header>
          <div class="drawer-body"><ng-content /></div>
          <footer class="drawer-foot"><ng-content select="[footer]" /></footer>
        </aside>
      </div>
    }
  `,
  styles: [
    `
      .drawer-backdrop {
        position: fixed;
        inset: 0;
        z-index: 70;
        display: flex;
        justify-content: flex-end;
        background: rgba(36, 31, 28, 0.42);
      }
      .drawer-panel {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        width: min(92vw, 520px);
        height: 100%;
        border-left: 1px solid var(--erp-line);
        background: var(--erp-surface);
        box-shadow: -24px 0 60px -30px rgba(36, 31, 28, 0.6);
        animation: drawer-in 160ms ease-out;
      }
      .drawer-panel--lg {
        width: min(96vw, 760px);
      }
      .drawer-panel--sm {
        width: min(90vw, 400px);
      }
      .drawer-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        padding: 16px 18px;
        border-bottom: 1px solid var(--erp-line);
      }
      h2 {
        font-family: var(--erp-display);
        font-size: 20px;
        font-weight: 600;
        color: var(--erp-ink);
      }
      .drawer-body {
        overflow-y: auto;
        padding: 18px;
      }
      .drawer-foot {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        padding: 12px 18px;
        border-top: 1px solid var(--erp-line);
        background: var(--erp-surface-muted);
      }
      .drawer-foot:empty {
        display: none;
      }
      @keyframes drawer-in {
        from {
          transform: translateX(24px);
          opacity: 0.6;
        }
      }
    `,
  ],
})
export class AdminErpDrawer {
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
   * Emits close so the owner controls mount state.
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
   * Keeps focus inside the drawer while open.
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
