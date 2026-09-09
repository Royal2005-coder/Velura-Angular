import { DestroyRef, inject } from '@angular/core';

/**
 * Applies vanilla `body.admin-page` so admin.css typography and scrollbars match.
 */
export function useBodyClass(className: string): void {
  const destroyRef = inject(DestroyRef);
  document.body.classList.add(className);
  destroyRef.onDestroy(() => document.body.classList.remove(className));
}
