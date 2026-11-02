/**
 * Refund SLA (BA AD_REFUND_03): the customer is promised the refund within 4-5 working days
 * after the warehouse confirms the returned goods. The stored deadline uses the upper bound.
 */

/** Fastest refund promise shown to customers (working days). */
export const REFUND_SLA_MIN_WORKING_DAYS = 4;
/** Latest refund promise; `refund_due_at` is stored at this bound. */
export const REFUND_SLA_MAX_WORKING_DAYS = 5;
/** Show a "sắp quá hạn" warning when less than this many hours remain. */
export const REFUND_SLA_WARNING_HOURS = 24;
/** Business calendar is Vietnam time (UTC+7, no daylight saving). */
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Adds working days (Monday-Friday in Vietnam time) and keeps the time of day.
 * Mirrors `public.velura_add_working_days` in migration 101; public holidays are not modelled.
 */
export function addWorkingDays(from: Date, days: number): Date {
  if (!Number.isFinite(from.getTime())) throw new RangeError("Invalid start date");
  if (!Number.isInteger(days) || days < 0) throw new RangeError("Working days must be a non-negative integer");
  let cursor = from.getTime();
  let added = 0;
  while (added < days) {
    cursor += DAY_MS;
    const weekday = new Date(cursor + VIETNAM_OFFSET_MS).getUTCDay();
    if (weekday !== 0 && weekday !== 6) added += 1;
  }
  return new Date(cursor);
}

/** Deadline the refund must be paid by once goods are confirmed received at `receivedAt`. */
export function refundDueAt(receivedAt: Date): Date {
  return addWorkingDays(receivedAt, REFUND_SLA_MAX_WORKING_DAYS);
}

/** Position of a refund against its deadline. */
export type RefundSlaState = "none" | "on_track" | "due_soon" | "overdue";

/** Classifies one deadline; a missing or invalid deadline means no SLA applies. */
export function refundSlaState(dueAt: string | Date | null | undefined, now: Date = new Date()): RefundSlaState {
  if (!dueAt) return "none";
  const due = dueAt instanceof Date ? dueAt.getTime() : Date.parse(dueAt);
  if (!Number.isFinite(due)) return "none";
  const remaining = due - now.getTime();
  if (remaining < 0) return "overdue";
  return remaining <= REFUND_SLA_WARNING_HOURS * 60 * 60 * 1000 ? "due_soon" : "on_track";
}
