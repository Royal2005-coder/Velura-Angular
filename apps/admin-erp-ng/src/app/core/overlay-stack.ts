import { signal } from '@angular/core';

const openStack = signal<readonly object[]>([]);

/**
 * Registers an open drawer/modal in opening order and returns an idempotent release. Overlays stack
 * (a confirm modal over an order drawer or CMS editor); without an order every overlay heard the same
 * Escape, so one key press closed the confirm AND the parent behind it.
 */
export function pushOverlay(owner: object): () => void {
  openStack.update((list) => [...list, owner]);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    openStack.update((list) => {
      const index = list.lastIndexOf(owner);
      if (index < 0) return list;
      return [...list.slice(0, index), ...list.slice(index + 1)];
    });
  };
}

/**
 * True only for the most recently opened overlay — the one Escape should close and screen readers should focus.
 */
export function isTopOverlay(owner: object): boolean {
  const list = openStack();
  return list[list.length - 1] === owner;
}

/**
 * True whenever at least one modal or drawer is currently mounted in the overlay stack.
 */
export function hasOpenOverlay(): boolean {
  return openStack().length > 0;
}
