/** Days after delivery during which the buyer can open a return. */
export const RETURN_WINDOW_DAYS = 30;

/**
 * True while `now` is still inside the 30-day window that starts at delivery.
 */
export function returnWindowOpen(deliveredAt: Date, now: Date): boolean {
  const elapsed = now.getTime() - deliveredAt.getTime();
  return elapsed >= 0 && elapsed <= RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}
