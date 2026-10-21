const auditWrites = new Map<string, number>();
const MODULE_PATTERN = /^[a-z0-9_-]{1,50}$/;

/**
 * Records one API-side audit_log write result without exposing row contents.
 */
export function recordAuditWrite(module: unknown, result: "success" | "failure"): void {
  const key = `${safeModule(module)}|${result}`;
  auditWrites.set(key, (auditWrites.get(key) ?? 0) + 1);
}

/**
 * Renders the process-local audit write counters in Prometheus text format.
 */
export function renderAuditMetrics(): string[] {
  const lines = ["# TYPE velura_audit_writes_total counter"];
  for (const [key, count] of [...auditWrites.entries()].sort()) {
    const [module, result] = key.split("|");
    lines.push(`velura_audit_writes_total{module="${module}",result="${result}"} ${count}`);
  }
  return lines;
}

/**
 * Clears process-local counters so tests remain deterministic.
 */
export function resetAuditMetricsForTest(): void {
  auditWrites.clear();
}

function safeModule(value: unknown): string {
  const module = String(value ?? "").toLowerCase();
  return MODULE_PATTERN.test(module) ? module : "other";
}
