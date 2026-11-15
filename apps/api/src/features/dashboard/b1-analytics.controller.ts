import { sendJson } from '../../http.js';
import { B1AnalyticsRepository, type B1QueryParams } from './b1-analytics.repository.js';
import type { HttpRequest, HttpResponse, JsonObject } from '../../types.js';

interface CacheEntry {
  data: JsonObject;
  expiresAt: number;
  cachedAt: string;
}

// In-Memory SWR Cache Store (10 minutes TTL)
const b1Cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 600 * 1000; // 10 phút (600s)

const repo = new B1AnalyticsRepository();

/**
 * Controller xử lý yêu cầu phân tích dữ liệu chuyên sâu cho Widget B1
 */
export class B1AnalyticsController {
  /**
   * Tính toán 4 mốc thời gian (curStart, curEnd, prevStart, prevEnd) độc lập tại Node.js
   * Tuân thủ đặc tả Section 2.1 & Chip "Xu hướng độc lập với kỳ":
   * - Khi xem Tab Thời gian với Grain 'quarter': cửa sổ 8 quý gần nhất (24 tháng)
   * - Khi xem Tab Thời gian với Grain 'month': cửa sổ 12 tháng gần nhất (12 tháng)
   * - Khi xem Tab Thời gian với Grain 'week': cửa sổ 12 tuần gần nhất (84 ngày)
   * - Grain 'day' hoặc Tab Giá / Kênh TT: theo kỳ phân tích toàn cục (range: 1d, 7d, 30d, 90d, ytd)
   */
  private static calculateDateBounds(range: string, grain?: string, from?: string, to?: string) {
    const now = new Date();
    let curEnd = new Date(now);
    let curStart = new Date(now);

    if (from && to) {
      curStart = new Date(from);
      curEnd = new Date(to);
    } else if (grain === 'quarter') {
      curStart.setMonth(now.getMonth() - 24);
    } else if (grain === 'month') {
      curStart.setMonth(now.getMonth() - 11);
    } else if (grain === 'week') {
      curStart.setDate(now.getDate() - 84);
    } else {
      switch (range) {
        case '1d':
        case 'day':
        case 'today':
          curStart.setDate(now.getDate() - 1);
          break;
        case '7d':
        case 'week':
          curStart.setDate(now.getDate() - 7);
          break;
        case '90d':
        case 'quarter':
          curStart.setDate(now.getDate() - 90);
          break;
        case 'ytd':
          curStart = new Date(now.getFullYear(), 0, 1);
          break;
        case '30d':
        case 'month':
        default:
          curStart.setDate(now.getDate() - 30);
          break;
      }
    }

    const spanMs = Math.max(86400000, curEnd.getTime() - curStart.getTime());
    const prevEnd = new Date(curStart.getTime());
    const prevStart = new Date(curStart.getTime() - spanMs);

    return {
      curStart: curStart.toISOString(),
      curEnd: curEnd.toISOString(),
      prevStart: prevStart.toISOString(),
      prevEnd: prevEnd.toISOString()
    };
  }

  /**
   * Điểm cuối chính: Phục vụ GET /api/v1/analytics/dashboard/b1
   */
  static async getB1Analytics(query: URLSearchParams): Promise<JsonObject> {
    const startTime = Date.now();

    // 1. Phân giải & Whitelist tham số
    const tabRaw = query.get('tab') || 'time_combo';
    const tab = (['time_combo', 'price_bar', 'payment_stacked'].includes(tabRaw) ? tabRaw : 'time_combo') as B1QueryParams['tab'];

    const grainRaw = query.get('grain') || 'month';
    const grain = (['day', 'week', 'month', 'quarter'].includes(grainRaw) ? grainRaw : 'month') as B1QueryParams['grain'];

    const measureRaw = query.get('measure') || 'revenue';
    const measure = (['revenue', 'profit'].includes(measureRaw) ? measureRaw : 'revenue') as B1QueryParams['measure'];

    const dimensionRaw = query.get('dimension') || 'category';
    const dimension = (['category', 'customer', 'channel'].includes(dimensionRaw) ? dimensionRaw : 'category') as B1QueryParams['dimension'];

    const range = query.get('range') || '30d';
    const fromParam = query.get('from') || undefined;
    const toParam = query.get('to') || undefined;

    // 2. Tính toán 4 mốc thời gian
    const bounds = this.calculateDateBounds(range, tab === 'time_combo' ? grain : 'day', fromParam, toParam);

    // 3. Kiểm tra Cache (SWR Cache-Aside)
    const cacheKey = `velura:bi:b1:${tab}:${grain}:${measure}:${dimension}:${range}:${fromParam || ''}_${toParam || ''}`;
    const cached = b1Cache.get(cacheKey);
    const nowMs = Date.now();

    if (cached && cached.expiresAt > nowMs) {
      return {
        ...cached.data,
        cache: {
          hit: true,
          ttl_remaining_seconds: Math.round((cached.expiresAt - nowMs) / 1000),
          latency_ms: Date.now() - startTime
        }
      };
    }

    // 4. Gọi Repository thực thi PostgreSQL CTE phù hợp theo Tab
    const queryParams: B1QueryParams = {
      tab,
      grain,
      measure,
      dimension,
      ...bounds
    };

    let chartData: JsonObject = {};
    if (tab === 'time_combo') {
      chartData = await repo.queryTimeCombo(queryParams);
    } else if (tab === 'price_bar') {
      chartData = await repo.queryPriceTiers(queryParams);
    } else {
      chartData = await repo.queryPaymentChannels(queryParams);
    }

    // 5. Đóng gói JSON Contract chuẩn hóa cho ECharts / Angular
    const responsePayload: JsonObject = {
      status: 'success',
      generated_at: new Date().toISOString(),
      query_context: {
        tab,
        grain,
        measure,
        dimension,
        date_range: {
          from: bounds.curStart,
          to: bounds.curEnd,
          comparison_from: bounds.prevStart,
          comparison_to: bounds.prevEnd
        }
      },
      chart_payload: chartData,
      cache: {
        hit: false,
        ttl_remaining_seconds: Math.round(CACHE_TTL_MS / 1000),
        latency_ms: Date.now() - startTime
      }
    };

    // 6. Ghi đè Cache 10 phút
    b1Cache.set(cacheKey, {
      data: responsePayload,
      expiresAt: nowMs + CACHE_TTL_MS,
      cachedAt: new Date().toISOString()
    });

    return responsePayload;
  }
}

/**
 * HTTP Route Handler tích hợp vào server hoặc router
 */
export async function handleB1AnalyticsRoute(
  req: HttpRequest,
  res: HttpResponse,
  url: URL,
  headers: Record<string, string>
): Promise<boolean> {
  const parts = url.pathname.split('/').filter(Boolean);
  
  // Tuyến: GET /api/v1/analytics/dashboard/b1 hoặc GET /api/v1/admin/dashboard/b1
  const isB1 = (
    (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'analytics' && parts[3] === 'dashboard' && parts[4] === 'b1') ||
    (parts[0] === 'api' && parts[1] === 'v1' && parts[2] === 'admin' && parts[3] === 'dashboard' && parts[4] === 'b1')
  );

  if (!isB1 || req.method !== 'GET') {
    return false;
  }

  try {
    const data = await B1AnalyticsController.getB1Analytics(url.searchParams);
    sendJson(res, 200, data, headers);
    return true;
  } catch (err: any) {
    sendJson(res, 500, {
      status: 'error',
      message: err?.message || 'Lỗi xử lý truy vấn Widget B1',
      generated_at: new Date().toISOString()
    }, headers);
    return true;
  }
}
