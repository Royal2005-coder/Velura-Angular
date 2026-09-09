import { DestroyRef, inject } from '@angular/core';

/**
 * Mirrors vanilla `body.page-*` / `body.admin-page` class hooks used by global CSS.
 */
export function useBodyClass(className: string): void {
  const destroyRef = inject(DestroyRef);
  document.body.classList.add(className);
  destroyRef.onDestroy(() => document.body.classList.remove(className));
}
