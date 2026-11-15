import { ChangeDetectionStrategy, Component, ElementRef, HostListener, effect, inject, input, output, viewChild } from '@angular/core';
import { AdminErpConfirmService } from '../../core/admin-erp-confirm.service';
import { lockBodyScroll } from '../../core/body-scroll-lock';
import { isTopOverlay, pushOverlay } from '../../core/overlay-stack';

let drawerSequence = 0;

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
          [attr.aria-labelledby]="titleId"
          [attr.aria-busy]="busy()"
          tabindex="-1"
          (keydown)="onPanelKeydown($event)"
        >
          <header class="drawer-head">
            <h2 [id]="titleId">{{ title() }}</h2>
            <span class="drawer-head__actions">
              @if (navigable()) {
                <button class="erp-icon-btn" type="button" aria-label="Bản ghi trước (K)" title="Bản ghi trước (K)" [disabled]="!hasPrev() || busy()" (click)="goPrev()">‹</button>
                <button class="erp-icon-btn" type="button" aria-label="Bản ghi sau (J)" title="Bản ghi sau (J)" [disabled]="!hasNext() || busy()" (click)="goNext()">›</button>
              }
              <button class="erp-icon-btn" type="button" aria-label="Đóng" [disabled]="busy()" (click)="close()">×</button>
            </span>
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
        background: rgba(42, 20, 28, 0.45);
      }
      .drawer-panel {
        display: grid;
        grid-template-rows: auto minmax(0, 1fr) auto;
        width: min(92vw, 520px);
        height: 100%;
        border-left: 1px solid var(--erp-line);
        border-radius: var(--erp-radius-xl) 0 0 var(--erp-radius-xl);
        background: var(--erp-surface);
        box-shadow: var(--erp-shadow-modal);
        overflow: hidden;
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
      .drawer-head__actions {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      h2 {
        font-family: var(--erp-display);
        font-size: 18px;
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
  /** Unsaved edits inside: closing or moving to another record asks "Bỏ thay đổi?" first. */
  readonly dirty = input(false);
  /** A save is in flight: closing/navigating is blocked. */
  readonly busy = input(false);
  /** Show previous/next record controls (queue processing without closing the drawer). */
  readonly navigable = input(false);
  readonly hasPrev = input(false);
  readonly hasNext = input(false);
  readonly closed = output<void>();
  readonly prev = output<void>();
  readonly next = output<void>();
  readonly titleId = `erp-drawer-title-${++drawerSequence}`;
  private readonly confirm = inject(AdminErpConfirmService);
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
   * Asks the owner to close, honouring the busy/dirty guards; the owner controls mount state.
   */
  async close(): Promise<void> {
    if (await this.mayLeave()) this.closed.emit();
  }

  /** Moves to the previous record in the owner's list. */
  async goPrev(): Promise<void> {
    if (this.hasPrev() && (await this.mayLeave())) this.prev.emit();
  }

  /** Moves to the next record in the owner's list. */
  async goNext(): Promise<void> {
    if (this.hasNext() && (await this.mayLeave())) this.next.emit();
  }

  private async mayLeave(): Promise<boolean> {
    if (this.busy()) return false;
    return !this.dirty() || this.confirm.discardChanges();
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
    const typing = !!(event.target as HTMLElement | null)?.closest('input, textarea, select, [contenteditable="true"]');
    if (this.navigable() && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.key === 'j' || event.key === 'J') {
        event.preventDefault();
        void this.goNext();
        return;
      }
      if (event.key === 'k' || event.key === 'K') {
        event.preventDefault();
        void this.goPrev();
        return;
      }
    }
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

  /** Escape closes only the topmost overlay, so a confirm over this drawer closes alone. */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.open() && isTopOverlay(this)) {
      this.close();
    }
  }
}
