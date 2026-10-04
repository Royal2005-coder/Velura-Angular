import { DOCUMENT } from '@angular/common';
import { DestroyRef, Injectable, inject } from '@angular/core';

/** Refreshes visible workspace data without losing filters, navigation or drafts. */
@Injectable({ providedIn: 'root' })
export class AdminRefreshService {
  private readonly document = inject(DOCUMENT);
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRefresh = 0;
  private readonly onFocus = () => { if (Date.now() - this.lastRefresh >= 5_000) this.refresh(); };
  private readonly onVisibility = () => { if (!this.document.hidden) this.onFocus(); };

  /** Registers one active workspace and stops polling when it is destroyed. */
  register(refresh: () => void, destroyRef: DestroyRef): void {
    this.listeners.add(refresh);
    if (!this.timer) {
      this.document.defaultView?.addEventListener('focus', this.onFocus);
      this.document.addEventListener('visibilitychange', this.onVisibility);
      this.timer = setInterval(() => this.refresh(), 30_000);
    }
    destroyRef.onDestroy(() => {
      this.listeners.delete(refresh);
      if (!this.listeners.size && this.timer) {
        clearInterval(this.timer);
        this.timer = null;
        this.document.defaultView?.removeEventListener('focus', this.onFocus);
        this.document.removeEventListener('visibilitychange', this.onVisibility);
      }
    });
  }

  /** Updates authorised page data only while the browser tab is visible. */
  refresh(): void {
    if (this.document.hidden) return;
    this.lastRefresh = Date.now();
    for (const refresh of this.listeners) refresh();
  }
}
