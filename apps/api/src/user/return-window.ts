/** Days after delivery during which the buyer can open a return (matches the DB RPC and BA policy). */
export const RETURN_WINDOW_DAYS = 7;

/**
 * True inside the inclusive seven-day window from a valid delivery timestamp.
 */
export function returnWindowOpen(deliveredAt: Date, now: Date): boolean {
  const elapsed = now.getTime() - deliveredAt.getTime();
  return elapsed >= 0 && elapsed <= RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}
