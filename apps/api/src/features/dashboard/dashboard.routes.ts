import { sendJson } from '../../http.js';
import { requirePermission } from '../../rbac.js';
import {
  getDashboardSlaMetrics,
  getInventoryAlerts,
  getModuleHealth
} from './dashboard.service.js';
import { getMacroKpis } from './macro-kpis.service.js';
import { getB2Analytics } from './b2-analytics.service.js';
import { handleB1AnalyticsRoute } from './b1-analytics.controller.js';
import type { RouteArgs } from '../../types.js';

/**
 * Điều hướng các route liên quan đến Dashboard Insight:
 * 1. SLA Metrics (Widget Q2): GET /api/v1/admin/dashboard/sla-metrics (và alias /api/dashboard/sla-metrics)
 * 2. Inventory Alerts (Widget Q5): GET /api/v1/admin/dashboard/inventory-alerts (và alias /api/dashboard/inventory-alerts)
 * 3. Module Health (Widget Q1): GET /api/v1/admin/dashboard/module-health (và alias /api/dashboard/module-health)
 * 4. Macro KPIs (5 Macro KPIs): GET /api/v1/analytics/macro-kpis (và alias /api/v1/admin/dashboard/macro-kpis)
 * 5. B1 Analytics (Doanh thu & Tăng trưởng): GET /api/v1/analytics/dashboard/b1 (và /api/v1/admin/dashboard/b1)
 * 6. B2 Analytics (Danh mục & Nhân khẩu): GET /api/v1/analytics/dashboard/b2 (và /api/v1/admin/dashboard/b2)
 */
export async function handleDashboardSlaRoute({
  req,
  res,
  url,
  parts,
  context,
  headers
}: Pick<RouteArgs, 'req' | 'res' | 'url' | 'parts' | 'context' | 'headers'>): Promise<boolean> {
  if (req.method !== 'GET') {
    return false;
  }

  // Tuyến B1: Phân tích Doanh thu & Tăng trưởng (Widget B1)
  if (await handleB1AnalyticsRoute(req, res, url, headers)) {
    return true;
  }

  // Tuyến B2: Phân tích Danh mục & Nhân khẩu (Widget B2)
  if (
    (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'analytics' && parts[3] === 'dashboard' && parts[4] === 'b2') ||
    (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'analytics' && parts[3] === 'b2')
  ) {
    if (context?.authUser?.id) {
      requirePermission(context, 'dashboard', 'read');
    }
    const tab = url?.searchParams?.get('tab') || 'category';
    const range = url?.searchParams?.get('range') || '7d';
    const startDate = url?.searchParams?.get('from') || url?.searchParams?.get('startDate') || undefined;
    const endDate = url?.searchParams?.get('to') || url?.searchParams?.get('endDate') || undefined;
    const responseData = await getB2Analytics({ tab, range, startDate, endDate });
    sendJson(res, 200, responseData, headers);
    return true;
  }

  // Tuyến 0: GET /api/v1/analytics/macro-kpis
  if (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'analytics' && parts[3] === 'macro-kpis') {
    if (context?.authUser?.id) {
      requirePermission(context, 'dashboard', 'read');
    }
    const range = url?.searchParams?.get('range') || '30d';
    const startDate = url?.searchParams?.get('startDate') || url?.searchParams?.get('from') || undefined;
    const endDate = url?.searchParams?.get('endDate') || url?.searchParams?.get('to') || undefined;
    const responseData = await getMacroKpis({ range, startDate, endDate });
    sendJson(res, 200, responseData, headers);
    return true;
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

  // 0. Macro KPIs (Alias)
  if (subResource === 'macro-kpis') {
    if (context?.authUser?.id && isV1Admin) {
      requirePermission(context, 'dashboard', 'read');
    }
    const range = url?.searchParams?.get('range') || '30d';
    const startDate = url?.searchParams?.get('startDate') || url?.searchParams?.get('from') || undefined;
    const endDate = url?.searchParams?.get('endDate') || url?.searchParams?.get('to') || undefined;
    const responseData = await getMacroKpis({ range, startDate, endDate });
    sendJson(res, 200, responseData, headers);
    return true;
  }

  // 0.1 B2 Analytics (Alias)
  if (subResource === 'b2') {
    if (context?.authUser?.id && isV1Admin) {
      requirePermission(context, 'dashboard', 'read');
    }
    const tab = url?.searchParams?.get('tab') || 'category';
    const range = url?.searchParams?.get('range') || '7d';
    const startDate = url?.searchParams?.get('from') || url?.searchParams?.get('startDate') || undefined;
    const endDate = url?.searchParams?.get('to') || url?.searchParams?.get('endDate') || undefined;
    const responseData = await getB2Analytics({ tab, range, startDate, endDate });
    sendJson(res, 200, responseData, headers);
    return true;
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
