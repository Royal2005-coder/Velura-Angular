let locks = 0;
let previousOverflow = '';

/**
 * Locks page scrolling while at least one modal/drawer is open. The lock is reference-counted:
 * stacking two overlays used to capture `overflow: hidden` as the "previous" value, so closing
 * them in the wrong order restored `hidden` and left the whole workspace unscrollable until a
 * reload (UAT promotions freeze). Returns an idempotent release function.
 */
export function lockBodyScroll(): () => void {
  if (locks === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  locks += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    locks = Math.max(0, locks - 1);
    if (locks === 0) {
      document.body.style.overflow = previousOverflow;
    }
  };
}
