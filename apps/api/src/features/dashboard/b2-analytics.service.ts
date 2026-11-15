import type { JsonObject } from '../../types.js';

export interface B2SegmentItem {
  id: string;
  label: string;
  revenue: number;
  revenue_formatted: string;
  share_pct: number;
  share_formatted: string;
  prev_revenue: number;
  yoy_pct: number | null;
  yoy_formatted: string;
  is_new: boolean;
  trend_direction: 'up' | 'down' | 'flat' | 'new';
  color: string;
  order_count?: number;
  items_count?: number;
}

export interface B2DataPayload {
  status: 'success' | 'error';
  meta: {
    widget: 'B2';
    tab: 'category' | 'demographic';
    period: {
      range: string;
      cur_from: string;
      cur_to: string;
      prev_from: string;
      prev_to: string;
    };
    total_revenue: number;
    total_revenue_formatted: string;
    cached_at: string;
    cache_ttl_seconds: number;
  };
  data: B2SegmentItem[];
  error?: string;
}

interface CacheEntry {
  data: B2DataPayload;
  expiresAt: number;
}

// In-Memory Cache Store with 10-Minute TTL (600s)
const b2Cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 600 * 1000;

const CATEGORY_COLORS = ['#7D263D', '#A94D68', '#4266A8', '#B96A25', '#2E7D65', '#64748B', '#0D9488'];
const DEMOGRAPHIC_COLORS = ['#7D263D', '#A94D68', '#4266A8', '#B96A25', '#2E7D65', '#D97706', '#6366F1', '#64748B', '#94A3B8'];

function formatVnd(val: number): string {
  if (Math.abs(val) >= 1_000_000_000) {
    return (val / 1_000_000_000).toFixed(2).replace(/\.00$/, '') + ' tỷ đ';
  }
  if (Math.abs(val) >= 1_000_000) {
    return (val / 1_000_000).toFixed(1).replace(/\.0$/, '') + ' tr đ';
  }
  if (Math.abs(val) >= 1_000) {
    return (val / 1_000).toFixed(0) + 'k đ';
  }
  return val.toLocaleString('vi-VN') + ' đ';
}

function resolvePeriodDates(range = '7d', from?: string, to?: string) {
  const now = new Date();
  let curEnd: Date;
  let curStart: Date;
  let prevEnd: Date;
  let prevStart: Date;

  if (from && to) {
    curStart = new Date(from);
    curEnd = new Date(to);
    const spanMs = Math.max(86_400_000, curEnd.getTime() - curStart.getTime());
    prevEnd = curStart;
    prevStart = new Date(curStart.getTime() - spanMs);
  } else {
    let days = 7;
    if (range === 'day' || range === 'today' || range === '1d') {
      days = 1;
    } else if (range === 'week' || range === '7d') {
      days = 7;
    } else if (range === 'month' || range === '30d') {
      days = 30;
    }

    curEnd = now;
    curStart = new Date(curEnd.getTime() - days * 24 * 60 * 60 * 1000);
    prevEnd = curStart;
    prevStart = new Date(prevEnd.getTime() - days * 24 * 60 * 60 * 1000);
  }

  return { curStart, curEnd, prevStart, prevEnd, range };
}

/**
 * Single-pass CTE for Category Breakdown (Tab 1)
 */
const SQL_B2_CATEGORY_ANALYTICS = `
WITH period_params AS (
  SELECT 
    $1::timestamptz AS cur_start,
    $2::timestamptz AS cur_end,
    $3::timestamptz AS prev_start,
    $4::timestamptz AS prev_end
),
classified_order_items AS (
  SELECT 
    COALESCE(
      c.category_id::text,
      CASE
        WHEN foi.product_name ILIKE '%Áo Khoác%' OR foi.product_name ILIKE '%Blazer%' THEN 'cat_aokhoac'
        WHEN foi.product_name ILIKE '%Áo%' THEN 'cat_ao'
        WHEN foi.product_name ILIKE '%Quần%' THEN 'cat_quan'
        WHEN foi.product_name ILIKE '%Đầm%' OR foi.product_name ILIKE '%Váy%' THEN 'cat_dam'
        WHEN foi.product_name ILIKE '%Set%' THEN 'cat_set'
        ELSE 'cat_other'
      END
    ) AS segment_id,
    COALESCE(
      c.name,
      CASE
        WHEN foi.product_name ILIKE '%Áo Khoác%' OR foi.product_name ILIKE '%Blazer%' THEN 'Áo khoác'
        WHEN foi.product_name ILIKE '%Áo%' THEN 'Áo'
        WHEN foi.product_name ILIKE '%Quần%' THEN 'Quần'
        WHEN foi.product_name ILIKE '%Đầm%' OR foi.product_name ILIKE '%Váy%' THEN 'Đầm & Váy'
        WHEN foi.product_name ILIKE '%Set%' THEN 'Set đồ'
        ELSE 'Phụ kiện'
      END
    ) AS segment_label,
    (foi.subtotal_item - foi.allocated_discount) AS net_item_revenue,
    CASE 
      WHEN fo.created_at >= p.cur_start  AND fo.created_at <= p.cur_end  THEN 'CURRENT'
      WHEN fo.created_at >= p.prev_start AND fo.created_at <= p.prev_end THEN 'PREVIOUS'
      ELSE NULL 
    END AS period_flag
  FROM public.fact_orders fo
  CROSS JOIN period_params p
  INNER JOIN public.fact_order_items foi ON fo.order_id = foi.order_id
  LEFT JOIN public.product pr ON foi.product_name = pr.name
  LEFT JOIN public.category c ON pr.category_id = c.category_id
  WHERE fo.is_valid_order = TRUE 
    AND fo.status IN ('completed', 'delivered')
    AND (
      (fo.created_at >= p.cur_start AND fo.created_at <= p.cur_end)
      OR
      (fo.created_at >= p.prev_start AND fo.created_at <= p.prev_end)
    )
),
aggregated_by_segment AS (
  SELECT 
    segment_id,
    segment_label,
    SUM(CASE WHEN period_flag = 'CURRENT' THEN net_item_revenue ELSE 0 END) AS cur_revenue,
    SUM(CASE WHEN period_flag = 'PREVIOUS' THEN net_item_revenue ELSE 0 END) AS prev_revenue,
    COUNT(CASE WHEN period_flag = 'CURRENT' THEN 1 ELSE NULL END) AS items_count
  FROM classified_order_items
  WHERE period_flag IS NOT NULL
  GROUP BY segment_id, segment_label
),
totals AS (
  SELECT SUM(cur_revenue) AS total_cur_revenue FROM aggregated_by_segment
)
SELECT 
  a.segment_id AS id,
  a.segment_label AS label,
  ROUND(COALESCE(a.cur_revenue, 0))::bigint AS revenue,
  CASE 
    WHEN t.total_cur_revenue = 0 OR t.total_cur_revenue IS NULL THEN 0.0
    ELSE ROUND((a.cur_revenue / t.total_cur_revenue) * 100, 1)
  END AS share_pct,
  ROUND(COALESCE(a.prev_revenue, 0))::bigint AS prev_revenue,
  CASE 
    WHEN a.prev_revenue = 0 AND a.cur_revenue > 0 THEN NULL
    WHEN a.prev_revenue = 0 AND a.cur_revenue = 0 THEN 0.0
    WHEN a.prev_revenue > 0 AND a.cur_revenue = 0 THEN -100.0
    ELSE ROUND(((a.cur_revenue - a.prev_revenue) / a.prev_revenue) * 100, 1)
  END AS yoy_pct,
  CASE 
    WHEN a.prev_revenue = 0 AND a.cur_revenue > 0 THEN TRUE 
    ELSE FALSE 
  END AS is_new,
  CASE 
    WHEN a.prev_revenue = 0 AND a.cur_revenue > 0 THEN 'new'
    WHEN a.cur_revenue > a.prev_revenue THEN 'up'
    WHEN a.cur_revenue < a.prev_revenue THEN 'down'
    ELSE 'flat'
  END AS trend_direction,
  a.items_count::int AS items_count
FROM aggregated_by_segment a
CROSS JOIN totals t
WHERE a.cur_revenue > 0 OR a.prev_revenue > 0
ORDER BY a.cur_revenue DESC;
`;

/**
 * Single-pass CTE for Demographics Breakdown (Tab 2)
 */
const SQL_B2_DEMOGRAPHIC_ANALYTICS = `
WITH period_params AS (
  SELECT 
    $1::timestamptz AS cur_start,
    $2::timestamptz AS cur_end,
    $3::timestamptz AS prev_start,
    $4::timestamptz AS prev_end
),
classified_orders AS (
  SELECT 
    CASE
      WHEN fo.user_id IS NULL OR c.user_id IS NULL OR fo.user_id = '00000000-0000-0000-0000-000000000000'::uuid THEN 'guest'
      WHEN c.dob IS NULL THEN 'missing_dob'
      WHEN c.gender = 'female' AND DATE_PART('year', age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, c.dob)) BETWEEN 18 AND 24 THEN 'f_18_24'
      WHEN c.gender = 'female' AND DATE_PART('year', age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, c.dob)) BETWEEN 25 AND 34 THEN 'f_25_34'
      WHEN c.gender = 'female' AND DATE_PART('year', age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, c.dob)) BETWEEN 35 AND 44 THEN 'f_35_44'
      WHEN c.gender = 'female' AND DATE_PART('year', age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, c.dob)) >= 45 THEN 'f_45_plus'
      WHEN c.gender = 'male'   AND DATE_PART('year', age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, c.dob)) BETWEEN 18 AND 24 THEN 'm_18_24'
      WHEN c.gender = 'male'   AND DATE_PART('year', age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, c.dob)) BETWEEN 25 AND 34 THEN 'm_25_34'
      WHEN c.gender = 'male'   AND DATE_PART('year', age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, c.dob)) >= 35 THEN 'm_35_plus'
      ELSE 'other'
    END AS segment_id,
    CASE
      WHEN fo.user_id IS NULL OR c.user_id IS NULL OR fo.user_id = '00000000-0000-0000-0000-000000000000'::uuid THEN 'Khách vãng lai (Guest)'
      WHEN c.dob IS NULL THEN 'Thành viên chưa có ngày sinh'
      WHEN c.gender = 'female' AND DATE_PART('year', age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, c.dob)) BETWEEN 18 AND 24 THEN 'Nữ 18 – 24 tuổi'
      WHEN c.gender = 'female' AND DATE_PART('year', age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, c.dob)) BETWEEN 25 AND 34 THEN 'Nữ 25 – 34 tuổi'
      WHEN c.gender = 'female' AND DATE_PART('year', age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, c.dob)) BETWEEN 35 AND 44 THEN 'Nữ 35 – 44 tuổi'
      WHEN c.gender = 'female' AND DATE_PART('year', age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, c.dob)) >= 45 THEN 'Nữ ≥ 45 tuổi'
      WHEN c.gender = 'male'   AND DATE_PART('year', age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, c.dob)) BETWEEN 18 AND 24 THEN 'Nam 18 – 24 tuổi'
      WHEN c.gender = 'male'   AND DATE_PART('year', age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, c.dob)) BETWEEN 25 AND 34 THEN 'Nam 25 – 34 tuổi'
      WHEN c.gender = 'male'   AND DATE_PART('year', age((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date, c.dob)) >= 35 THEN 'Nam ≥ 35 tuổi'
      ELSE 'Nhóm khác'
    END AS segment_label,
    fo.net_amount,
    CASE 
      WHEN fo.created_at >= p.cur_start  AND fo.created_at <= p.cur_end  THEN 'CURRENT'
      WHEN fo.created_at >= p.prev_start AND fo.created_at <= p.prev_end THEN 'PREVIOUS'
      ELSE NULL 
    END AS period_flag
  FROM public.fact_orders fo
  CROSS JOIN period_params p
  LEFT JOIN public.dim_customer c ON fo.user_id = c.user_id
  WHERE fo.is_valid_order = TRUE 
    AND fo.status IN ('completed', 'delivered')
    AND (
      (fo.created_at >= p.cur_start AND fo.created_at <= p.cur_end)
      OR
      (fo.created_at >= p.prev_start AND fo.created_at <= p.prev_end)
    )
),
aggregated_by_segment AS (
  SELECT 
    segment_id,
    segment_label,
    SUM(CASE WHEN period_flag = 'CURRENT' THEN net_amount ELSE 0 END) AS cur_revenue,
    SUM(CASE WHEN period_flag = 'PREVIOUS' THEN net_amount ELSE 0 END) AS prev_revenue,
    COUNT(CASE WHEN period_flag = 'CURRENT' THEN 1 ELSE NULL END) AS order_count
  FROM classified_orders
  WHERE period_flag IS NOT NULL
  GROUP BY segment_id, segment_label
),
totals AS (
  SELECT SUM(cur_revenue) AS total_cur_revenue FROM aggregated_by_segment
)
SELECT 
  a.segment_id AS id,
  a.segment_label AS label,
  ROUND(COALESCE(a.cur_revenue, 0))::bigint AS revenue,
  CASE 
    WHEN t.total_cur_revenue = 0 OR t.total_cur_revenue IS NULL THEN 0.0
    ELSE ROUND((a.cur_revenue / t.total_cur_revenue) * 100, 1)
  END AS share_pct,
  ROUND(COALESCE(a.prev_revenue, 0))::bigint AS prev_revenue,
  CASE 
    WHEN a.prev_revenue = 0 AND a.cur_revenue > 0 THEN NULL
    WHEN a.prev_revenue = 0 AND a.cur_revenue = 0 THEN 0.0
    WHEN a.prev_revenue > 0 AND a.cur_revenue = 0 THEN -100.0
    ELSE ROUND(((a.cur_revenue - a.prev_revenue) / a.prev_revenue) * 100, 1)
  END AS yoy_pct,
  CASE 
    WHEN a.prev_revenue = 0 AND a.cur_revenue > 0 THEN TRUE 
    ELSE FALSE 
  END AS is_new,
  CASE 
    WHEN a.prev_revenue = 0 AND a.cur_revenue > 0 THEN 'new'
    WHEN a.cur_revenue > a.prev_revenue THEN 'up'
    WHEN a.cur_revenue < a.prev_revenue THEN 'down'
    ELSE 'flat'
  END AS trend_direction,
  a.order_count::int AS order_count
FROM aggregated_by_segment a
CROSS JOIN totals t
WHERE a.cur_revenue > 0 OR a.prev_revenue > 0
ORDER BY a.cur_revenue DESC;
`;

export async function getB2Analytics(options: {
  tab?: string;
  range?: string;
  startDate?: string;
  endDate?: string;
}): Promise<B2DataPayload> {
  const normalizedTab = options.tab === 'demographic' ? 'demographic' : 'category';
  const { curStart, curEnd, prevStart, prevEnd, range } = resolvePeriodDates(
    options.range,
    options.startDate,
    options.endDate
  );

  const cacheKey = `velura:bi:b2:${normalizedTab}:${range}:${curStart.getTime()}_${curEnd.getTime()}`;
  const now = Date.now();
  const cached = b2Cache.get(cacheKey);

  if (cached && cached.expiresAt > now) {
    return cached.data;
  }

  if (!process.env.SUPABASE_DB_URL) {
    throw new Error('SUPABASE_DB_URL is not configured');
  }

  const pgModule = await (Function('return import("pg")')() as Promise<{
    default?: { Client: new (opts: unknown) => any };
    Client?: new (opts: unknown) => any;
  }>);
  const ClientClass = pgModule?.default?.Client || pgModule?.Client;
  if (!ClientClass) {
    throw new Error('pg module not found');
  }

  const client = new ClientClass({
    connectionString: process.env.SUPABASE_DB_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    const sql = normalizedTab === 'demographic' ? SQL_B2_DEMOGRAPHIC_ANALYTICS : SQL_B2_CATEGORY_ANALYTICS;
    const params = [
      curStart.toISOString(),
      curEnd.toISOString(),
      prevStart.toISOString(),
      prevEnd.toISOString(),
    ];

    const result = await client.query(sql, params);
    const colorPalette = normalizedTab === 'demographic' ? DEMOGRAPHIC_COLORS : CATEGORY_COLORS;

    let totalRevenue = 0;
    const items: B2SegmentItem[] = result.rows.map((row: any, idx: number) => {
      const revenue = Number(row.revenue) || 0;
      totalRevenue += revenue;
      const sharePct = Number(row.share_pct) || 0;
      const prevRevenue = Number(row.prev_revenue) || 0;
      const yoyPct = row.yoy_pct !== null && row.yoy_pct !== undefined ? Number(row.yoy_pct) : null;
      const isNew = Boolean(row.is_new);
      const trendDir: 'up' | 'down' | 'flat' | 'new' = row.trend_direction || (isNew ? 'new' : 'flat');

      let yoyFormatted = '–';
      if (isNew) {
        yoyFormatted = 'Mới';
      } else if (yoyPct !== null) {
        const sign = yoyPct > 0 ? '+' : '';
        yoyFormatted = `${sign}${yoyPct}%`;
      }

      return {
        id: String(row.id),
        label: String(row.label),
        revenue,
        revenue_formatted: formatVnd(revenue),
        share_pct: sharePct,
        share_formatted: `${sharePct.toFixed(1)}%`,
        prev_revenue: prevRevenue,
        yoy_pct: yoyPct,
        yoy_formatted: yoyFormatted,
        is_new: isNew,
        trend_direction: trendDir,
        color: colorPalette[idx % colorPalette.length],
        order_count: row.order_count ? Number(row.order_count) : undefined,
        items_count: row.items_count ? Number(row.items_count) : undefined,
      };
    });

    const responsePayload: B2DataPayload = {
      status: 'success',
      meta: {
        widget: 'B2',
        tab: normalizedTab,
        period: {
          range,
          cur_from: curStart.toISOString(),
          cur_to: curEnd.toISOString(),
          prev_from: prevStart.toISOString(),
          prev_to: prevEnd.toISOString(),
        },
        total_revenue: totalRevenue,
        total_revenue_formatted: formatVnd(totalRevenue),
        cached_at: new Date().toISOString(),
        cache_ttl_seconds: 600,
      },
      data: items,
    };

    b2Cache.set(cacheKey, {
      data: responsePayload,
      expiresAt: now + CACHE_TTL_MS,
    });

    return responsePayload;
  } finally {
    await client.end().catch(() => {});
  }
}
