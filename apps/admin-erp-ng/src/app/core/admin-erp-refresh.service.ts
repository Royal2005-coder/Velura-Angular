import { DestroyRef, Injectable, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject } from 'rxjs';

/**
 * Shell-level refresh bus. The topbar "Làm mới" asks the active workspace to reread its data
 * with the current filters instead of reloading the whole SPA and losing operator context.
 */
@Injectable({ providedIn: 'root' })
export class AdminErpRefreshService {
  private readonly source = new Subject<void>();

  /** Emits once per topbar refresh request. Workspaces unsubscribe on destroy. */
  readonly requests$ = this.source.asObservable();

  /** Asks the active workspace to reload its current dataset. */
  request(): void {
    this.source.next();
  }
}

/**
 * Subscribes a routed workspace to the shell refresh bus. Call it from the page constructor so
 * the subscription shares the component lifetime.
 */
export function useWorkspaceRefresh(reload: () => void): void {
  const refresh = inject(AdminErpRefreshService);
  const destroyRef = inject(DestroyRef);
  refresh.requests$.pipe(takeUntilDestroyed(destroyRef)).subscribe(reload);
}
