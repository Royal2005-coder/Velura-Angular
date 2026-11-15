import type { JsonObject } from '../../types.js';

export interface B1QueryParams {
  tab: 'time_combo' | 'price_bar' | 'payment_stacked';
  grain: 'day' | 'week' | 'month' | 'quarter';
  measure: 'revenue' | 'profit';
  dimension: 'category' | 'customer' | 'channel';
  curStart: string;
  curEnd: string;
  prevStart: string;
  prevEnd: string;
}

interface RawTimeComboRow {
  bucket_date: Date | string;
  revenue: number | string | null;
  cogs: number | string | null;
  profit: number | string | null;
  metric_val: number | string | null;
  order_count: number | string | null;
  prev_metric_val: number | string | null;
  margin_pct: number | string | null;
}

interface RawPriceSegment {
  dimension_name: string;
  metric_val: number | string | null;
  revenue: number | string | null;
  profit: number | string | null;
  share_pct: number | string | null;
}

interface RawPriceTierRow {
  tier_code: string;
  tier_label: string;
  tier_metric_val: number | string | null;
  tier_revenue: number | string | null;
  tier_profit: number | string | null;
  tier_orders: number | string | null;
  margin_pct: number | string | null;
  segments: RawPriceSegment[] | null;
}

interface RawPaymentChannelRow {
  code: string;
  name: string;
  revenue: number | string | null;
  total_orders: number | string | null;
  gateway_fee_rate: number | string | null;
  return_rate_pct: number | string | null;
  net_cash_flow: number | string | null;
  share_pct: number | string | null;
}

interface PgClientInstance {
  connect: () => Promise<void>;
  query: <T = unknown>(sql: string, params?: unknown[]) => Promise<{ rows: T[]; rowCount: number }>;
  end: () => Promise<void>;
}

/**
 * Ngăn chặn SQL Injection thông qua Whitelist Record Mappers
 * Tuyệt đối không nhận chuỗi thô từ URL query truyền thẳng vào SQL
 */
const DIMENSION_CONFIG = {
  category: {
    idCol: 'COALESCE(c.category_id::text, \'other\')',
    nameCol: 'COALESCE(c.name, \'Khác\')',
    joinClause: `
      LEFT JOIN product p ON oi.product_name = p.name
      LEFT JOIN category c ON p.category_id = c.category_id
    `
  },
  customer: {
    idCol: 'COALESCE(u.tier, \'regular\')',
    nameCol: `
      CASE 
        WHEN u.tier = 'vip' THEN 'VIP'
        WHEN u.tier = 'loyal' THEN 'Thân thiết'
        WHEN u.tier = 'potential' THEN 'Tiềm năng'
        ELSE 'Khách mới'
      END
    `,
    joinClause: `
      LEFT JOIN users u ON o.user_id = u.user_id
    `
  },
  channel: {
    idCol: 'COALESCE(o.payment_method::text, \'COD\')',
    nameCol: `
      CASE 
        WHEN o.payment_method::text = 'bank_transfer' THEN 'QR Bank'
        WHEN o.payment_method::text = 'momo' THEN 'MoMo'
        WHEN o.payment_method::text = 'credit_card' THEN 'Thẻ Visa/Master'
        ELSE 'COD'
      END
    `,
    joinClause: ''
  }
} as const;

const MEASURE_EXPRESSIONS = {
  revenue: '(oi.unit_price * oi.quantity)',
  profit: '((oi.unit_price * 0.52) * oi.quantity)'
} as const;

/**
 * Tầng Repository quản lý truy vấn SQL PostgreSQL trực tiếp cho Widget B1
 */
export class B1AnalyticsRepository {
  private async getClient(): Promise<PgClientInstance> {
    const pgModule = await (Function('return import("pg")')() as Promise<{
      default?: { Client: new (opts: unknown) => PgClientInstance };
      Client?: new (opts: unknown) => PgClientInstance;
    }>);
    const ClientClass = pgModule?.default?.Client || pgModule?.Client;
    if (!ClientClass) {
      throw new Error('PostgreSQL client library not found');
    }
    const client = new ClientClass({
      connectionString: process.env.SUPABASE_DB_URL,
      ssl: { rejectUnauthorized: false }
    });
    await client.connect();
    return client;
  }

  /**
   * TAB 1: Thời gian — Chuỗi thời gian liên tục với generate_series (No Data Gaps)
   * Parameterized bindings: $1 = curStart, $2 = curEnd, $3 = prevStart, $4 = prevEnd
   */
  async queryTimeCombo(params: B1QueryParams): Promise<JsonObject> {
    const client = await this.getClient();
    try {
      const stepInterval = params.grain === 'day' 
        ? '1 day' 
        : (params.grain === 'week' ? '1 week' : (params.grain === 'quarter' ? '3 month' : '1 month'));
      const dateTruncGrain = params.grain === 'day' 
        ? 'day' 
        : (params.grain === 'week' ? 'week' : (params.grain === 'quarter' ? 'quarter' : 'month'));
      const measureExpr = MEASURE_EXPRESSIONS[params.measure] || MEASURE_EXPRESSIONS.revenue;

      const sql = `
        WITH time_spine AS (
          SELECT generate_series(
            DATE_TRUNC('${dateTruncGrain}', $1::timestamptz)::date, 
            $2::date, 
            '${stepInterval}'::interval
          )::date AS bucket_date
        ),
        cur_period_orders AS (
          SELECT 
            DATE_TRUNC('${dateTruncGrain}', o.created_at)::date AS bucket_date,
            SUM(oi.unit_price * oi.quantity) AS revenue,
            SUM(COALESCE(oi.unit_price * 0.48, 0) * oi.quantity) AS cogs,
            SUM(${measureExpr}) AS metric_val,
            COUNT(DISTINCT o.order_id) AS order_count
          FROM orders o
          JOIN order_item oi ON o.order_id = oi.order_id
          WHERE o.created_at >= $1::timestamptz 
            AND o.created_at <= $2::timestamptz
            AND o.status::text IN ('confirmed', 'processing', 'shipping', 'delivered', 'completed')
          GROUP BY DATE_TRUNC('${dateTruncGrain}', o.created_at)::date
        ),
        prev_time_spine AS (
          SELECT generate_series(
            DATE_TRUNC('${dateTruncGrain}', $3::timestamptz)::date, 
            $4::date, 
            '${stepInterval}'::interval
          )::date AS prev_bucket_date
        ),
        prev_period_orders AS (
          SELECT 
            DATE_TRUNC('${dateTruncGrain}', o.created_at)::date AS prev_bucket_date,
            SUM(${measureExpr}) AS prev_metric_val
          FROM orders o
          JOIN order_item oi ON o.order_id = oi.order_id
          WHERE o.created_at >= $3::timestamptz 
            AND o.created_at < $4::timestamptz
            AND o.status::text IN ('confirmed', 'processing', 'shipping', 'delivered', 'completed')
          GROUP BY DATE_TRUNC('${dateTruncGrain}', o.created_at)::date
        ),
        prev_spine_joined AS (
          SELECT 
            pts.prev_bucket_date,
            ROW_NUMBER() OVER (ORDER BY pts.prev_bucket_date ASC) AS r_idx,
            COALESCE(p.prev_metric_val, 0) AS prev_metric_val
          FROM prev_time_spine pts
          LEFT JOIN prev_period_orders p ON pts.prev_bucket_date = p.prev_bucket_date
        ),
        spine_joined AS (
          SELECT 
            ts.bucket_date,
            ROW_NUMBER() OVER (ORDER BY ts.bucket_date ASC) AS r_idx,
            COALESCE(c.revenue, 0) AS revenue,
            COALESCE(c.cogs, 0) AS cogs,
            COALESCE(c.metric_val, 0) AS metric_val,
            COALESCE(c.order_count, 0) AS order_count
          FROM time_spine ts
          LEFT JOIN cur_period_orders c ON ts.bucket_date = c.bucket_date
        )
        SELECT 
          sj.bucket_date::text AS bucket_date,
          sj.revenue,
          sj.cogs,
          (sj.revenue - sj.cogs) AS profit,
          sj.metric_val,
          sj.order_count,
          COALESCE(psj.prev_metric_val, 0) AS prev_metric_val,
          CASE 
            WHEN sj.revenue > 0 THEN ROUND(((sj.revenue - sj.cogs) / sj.revenue::numeric) * 100, 1)
            ELSE 0 
          END AS margin_pct
        FROM spine_joined sj
        LEFT JOIN prev_spine_joined psj ON sj.r_idx = psj.r_idx
        ORDER BY sj.bucket_date ASC;
      `;

      const result = await client.query<RawTimeComboRow>(sql, [params.curStart, params.curEnd, params.prevStart, params.prevEnd]);
      return {
        rows: result.rows.map((r: RawTimeComboRow) => ({
          bucket_date: String(r.bucket_date).slice(0, 10),
          revenue: Number(r.revenue || 0),
          cogs: Number(r.cogs || 0),
          profit: Number(r.profit || 0),
          metric_val: Number(r.metric_val || 0),
          order_count: Number(r.order_count || 0),
          prev_metric_val: Number(r.prev_metric_val || 0),
          margin_pct: Number(r.margin_pct || 0)
        })),
        count: result.rowCount
      };
    } finally {
      await client.end().catch(() => {});
    }
  }

  /**
   * TAB 2: Tầng giá — Động cơ phân tích theo Measure & Dimension (Dynamic Group By với Whitelist)
   */
  async queryPriceTiers(params: B1QueryParams): Promise<JsonObject> {
    const client = await this.getClient();
    try {
      const dimConfig = DIMENSION_CONFIG[params.dimension] || DIMENSION_CONFIG.category;
      const measureExpr = MEASURE_EXPRESSIONS[params.measure] || MEASURE_EXPRESSIONS.revenue;

      const sql = `
        WITH price_tagged AS (
          SELECT 
            oi.item_id,
            o.order_id,
            ${measureExpr} AS line_metric,
            (oi.unit_price * oi.quantity) AS line_revenue,
            ((oi.unit_price * 0.52) * oi.quantity) AS line_profit,
            CASE 
              WHEN oi.unit_price < 300000 THEN 'TIER_1'
              WHEN oi.unit_price BETWEEN 300000 AND 500000 THEN 'TIER_2'
              WHEN oi.unit_price BETWEEN 500000 AND 700000 THEN 'TIER_3'
              ELSE 'TIER_4'
            END AS tier_code,
            CASE 
              WHEN oi.unit_price < 300000 THEN '< 300k'
              WHEN oi.unit_price BETWEEN 300000 AND 500000 THEN '300k - 500k'
              WHEN oi.unit_price BETWEEN 500000 AND 700000 THEN '500k - 700k'
              ELSE '> 700k'
            END AS tier_label,
            ${dimConfig.nameCol} AS dim_label
          FROM orders o
          JOIN order_item oi ON o.order_id = oi.order_id
          ${dimConfig.joinClause}
          WHERE o.created_at >= $1::timestamptz 
            AND o.created_at <= $2::timestamptz
            AND o.status::text IN ('confirmed', 'processing', 'shipping', 'delivered', 'completed')
        ),
        tier_totals AS (
          SELECT 
            tier_code,
            tier_label,
            SUM(line_metric) AS tier_metric_val,
            SUM(line_revenue) AS tier_revenue,
            SUM(line_profit) AS tier_profit,
            COUNT(DISTINCT order_id) AS tier_orders
          FROM price_tagged
          GROUP BY tier_code, tier_label
        ),
        dimension_segs AS (
          SELECT 
            tier_code,
            dim_label,
            SUM(line_metric) AS seg_metric_val,
            SUM(line_revenue) AS seg_revenue,
            SUM(line_profit) AS seg_profit
          FROM price_tagged
          GROUP BY tier_code, dim_label
        )
        SELECT 
          t.tier_code,
          t.tier_label,
          t.tier_metric_val,
          t.tier_revenue,
          t.tier_profit,
          t.tier_orders,
          CASE 
            WHEN t.tier_revenue > 0 THEN ROUND((t.tier_profit::numeric / t.tier_revenue::numeric) * 100, 1)
            ELSE 0 
          END AS margin_pct,
          jsonb_agg(
            jsonb_build_object(
              'dimension_name', ds.dim_label,
              'metric_val', ds.seg_metric_val,
              'revenue', ds.seg_revenue,
              'profit', ds.seg_profit,
              'share_pct', CASE 
                WHEN t.tier_metric_val > 0 THEN ROUND((ds.seg_metric_val::numeric / t.tier_metric_val::numeric) * 100, 1)
                ELSE 0 
              END
            ) ORDER BY ds.seg_metric_val DESC
          ) AS segments
        FROM tier_totals t
        JOIN dimension_segs ds ON t.tier_code = ds.tier_code
        GROUP BY t.tier_code, t.tier_label, t.tier_metric_val, t.tier_revenue, t.tier_profit, t.tier_orders
        ORDER BY t.tier_code ASC;
      `;

      const result = await client.query<RawPriceTierRow>(sql, [params.curStart, params.curEnd]);
      return {
        tiers: result.rows.map((r: RawPriceTierRow) => ({
          tier_code: r.tier_code,
          tier_label: r.tier_label,
          tier_metric_val: Number(r.tier_metric_val || 0),
          tier_revenue: Number(r.tier_revenue || 0),
          tier_profit: Number(r.tier_profit || 0),
          tier_orders: Number(r.tier_orders || 0),
          margin_pct: Number(r.margin_pct || 0),
          segments: Array.isArray(r.segments) ? r.segments.map((s: RawPriceSegment) => ({
            dimension_name: s.dimension_name,
            metric_val: Number(s.metric_val || 0),
            revenue: Number(s.revenue || 0),
            profit: Number(s.profit || 0),
            share_pct: Number(s.share_pct || 0)
          })) : []
        })),
        count: result.rowCount
      };
    } finally {
      await client.end().catch(() => {});
    }
  }

  /**
   * TAB 3: Kênh Thanh Toán — Dòng tiền, Phí cổng & Tỷ lệ hoàn COD
   */
  async queryPaymentChannels(params: B1QueryParams): Promise<JsonObject> {
    const client = await this.getClient();
    try {
      const sql = `
        WITH channel_stats AS (
          SELECT 
            o.payment_method::text AS raw_method,
            CASE 
              WHEN o.payment_method::text = 'bank_transfer' THEN 'QR Bank'
              WHEN o.payment_method::text = 'momo' THEN 'MoMo'
              WHEN o.payment_method::text = 'credit_card' THEN 'Thẻ'
              ELSE 'COD'
            END AS channel_name,
            COUNT(DISTINCT o.order_id) AS total_orders,
            SUM(o.total_amount) AS revenue,
            CASE 
              WHEN o.payment_method::text = 'bank_transfer' THEN 0.5
              WHEN o.payment_method::text = 'momo' THEN 1.8
              WHEN o.payment_method::text = 'credit_card' THEN 2.2
              ELSE 1.2
            END AS gateway_fee_rate,
            COUNT(DISTINCT CASE WHEN o.status::text IN ('delivery_failed', 'cancelled') THEN o.order_id END) AS returned_orders
          FROM orders o
          WHERE o.created_at >= $1::timestamptz 
            AND o.created_at <= $2::timestamptz
            AND o.status::text IN ('confirmed', 'processing', 'shipping', 'delivered', 'completed')
          GROUP BY o.payment_method
        ),
        grand_total AS (
          SELECT SUM(revenue) AS total_all_rev FROM channel_stats
        )
        SELECT 
          cs.raw_method AS code,
          cs.channel_name AS name,
          cs.revenue,
          cs.total_orders,
          cs.gateway_fee_rate,
          ROUND((cs.returned_orders::numeric / NULLIF(cs.total_orders, 0)::numeric) * 100, 1) AS return_rate_pct,
          ROUND((cs.revenue * (1 - cs.gateway_fee_rate / 100.0)), 0) AS net_cash_flow,
          ROUND((cs.revenue::numeric / NULLIF(gt.total_all_rev, 0)::numeric) * 100, 1) AS share_pct
        FROM channel_stats cs
        CROSS JOIN grand_total gt
        ORDER BY cs.revenue DESC;
      `;

      const result = await client.query<RawPaymentChannelRow>(sql, [params.curStart, params.curEnd]);
      return {
        channels: result.rows.map((r: RawPaymentChannelRow) => ({
          code: r.code,
          name: r.name,
          revenue: Number(r.revenue || 0),
          total_orders: Number(r.total_orders || 0),
          gateway_fee_rate: Number(r.gateway_fee_rate || 0),
          return_rate_pct: Number(r.return_rate_pct || 0),
          net_cash_flow: Number(r.net_cash_flow || 0),
          share_pct: Number(r.share_pct || 0)
        })),
        count: result.rowCount
      };
    } finally {
      await client.end().catch(() => {});
    }
  }
}
