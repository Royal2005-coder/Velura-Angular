import { DestroyRef, inject } from '@angular/core';

/**
 * Applies a body class for the lifetime of the calling component.
 */
export function useBodyClass(className: string): void {
  const destroyRef = inject(DestroyRef);
  document.body.classList.add(className);
  destroyRef.onDestroy(() => document.body.classList.remove(className));
}
