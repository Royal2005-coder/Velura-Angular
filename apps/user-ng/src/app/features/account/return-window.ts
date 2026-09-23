/** Days after delivery during which the buyer can open a return. Matches the API. */
export const RETURN_WINDOW_DAYS = 30;

export interface ReturnableOrder {
  status?: string;
  delivered_at?: string;
  updated_at?: string;
  created_at?: string;
}

/**
 * Delivered or completed orders still inside the 30-day window.
 */
export function isReturnableOrder(order: ReturnableOrder, now = new Date()): boolean {
  if (order.status !== 'delivered' && order.status !== 'completed') {
    return false;
  }
  const raw = order.delivered_at || order.updated_at || order.created_at;
  if (!raw) {
    return true;
  }
  const delivered = new Date(raw);
  if (Number.isNaN(delivered.getTime())) {
    return true;
  }
  const elapsed = now.getTime() - delivered.getTime();
  return elapsed >= 0 && elapsed <= RETURN_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}
