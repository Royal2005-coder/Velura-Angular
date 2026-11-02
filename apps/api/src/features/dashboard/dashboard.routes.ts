import { sendJson } from '../../http.js';
import { requirePermission } from '../../rbac.js';
import {
  getDashboardSlaMetrics,
  getInventoryAlerts,
  getModuleHealth
} from './dashboard.service.js';
import type { RouteArgs } from '../../types.js';

/**
 * Điều hướng các route liên quan đến Dashboard Insight:
 * 1. SLA Metrics (Widget Q2): GET /api/v1/admin/dashboard/sla-metrics (và alias /api/dashboard/sla-metrics)
 * 2. Inventory Alerts (Widget Q5): GET /api/v1/admin/dashboard/inventory-alerts (và alias /api/dashboard/inventory-alerts)
 * 3. Module Health (Widget Q1): GET /api/v1/admin/dashboard/module-health (và alias /api/dashboard/module-health)
 */
export async function handleDashboardSlaRoute({
  req,
  res,
  parts,
  context,
  headers
}: Pick<RouteArgs, 'req' | 'res' | 'parts' | 'context' | 'headers'>): Promise<boolean> {
  if (req.method !== 'GET') {
    return false;
  }

  // Phân tích đường dẫn
  const isV1Admin = parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'admin' && parts[3] === 'dashboard';
  const isDirect = parts[0] === 'api' && parts[1] === 'dashboard';

  let subResource: string | null = null;
  if (isV1Admin && parts.length === 5) {
    subResource = parts[4];
  } else if (isDirect && parts.length === 3) {
    subResource = parts[2];
  }

  if (!subResource) {
    return false;
  }

  // 1. SLA Metrics (Widget Q2)
  if (subResource === 'sla-metrics') {
    if (context && isV1Admin) {
      requirePermission(context, 'dashboard', 'read');
    }
    const responseData = await getDashboardSlaMetrics();
    sendJson(res, 200, responseData, headers);
    return true;
  }

  // 2. Inventory Alerts (Widget Q5)
  if (subResource === 'inventory-alerts') {
    if (context && isV1Admin) {
      requirePermission(context, 'dashboard', 'read');
    }
    const responseData = await getInventoryAlerts();
    sendJson(res, 200, responseData, headers);
    return true;
  }

  // 3. Module Health (Widget Q1)
  if (subResource === 'module-health') {
    if (context && isV1Admin) {
      requirePermission(context, 'dashboard', 'read');
    }
    const responseData = await getModuleHealth();
    sendJson(res, 200, responseData, headers);
    return true;
  }

  return false;
}
