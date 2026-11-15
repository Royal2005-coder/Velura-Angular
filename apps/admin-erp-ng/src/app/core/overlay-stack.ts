const open: object[] = [];

/**
 * Registers an open drawer/modal in opening order and returns an idempotent release. Overlays stack
 * (a confirm modal over an order drawer); without an order every overlay heard the same Escape, so
 * one key press closed the confirm AND the drawer behind it and threw away the operator's context.
 */
export function pushOverlay(owner: object): () => void {
  open.push(owner);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const index = open.lastIndexOf(owner);
    if (index >= 0) {
      open.splice(index, 1);
    }
  };
}

/**
 * True only for the most recently opened overlay — the one Escape should close.
 */
export function isTopOverlay(owner: object): boolean {
  return open[open.length - 1] === owner;
}
