import { config } from "../config.js";
import { createProductRepository, type ProductRepository } from "./product-repository.js";
import { retryDueLowStockAlerts } from "./product-service.js";

/** One scheduled pass: re-queue due low-stock alert emails (TH6) even when nobody opens the product list. */
export async function runLowStockAlertRetryPass(repository: ProductRepository): Promise<void> {
  await retryDueLowStockAlerts(repository);
}

/**
 * Periodically retry low-stock alert emails recorded in `low_stock_alert_retry`.
 * Returns the interval handle, or null when disabled (no service key or interval <= 0).
 */
export function startLowStockAlertRetry(
  options: { intervalMs?: number; repository?: ProductRepository } = {}
): ReturnType<typeof setInterval> | null {
  const intervalMs = options.intervalMs ?? config.lowStockRetryIntervalMs;
  if (!config.supabaseServiceRoleKey || !(intervalMs > 0)) return null;
  const repository = options.repository ?? createProductRepository();
  const run = () => runLowStockAlertRetryPass(repository).catch(() => console.error("[low-stock-retry] pass failed"));
  void run();
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return timer;
}
