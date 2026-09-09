import { callRpc } from "./supabase.js";
import { HttpError } from "./http.js";

const BUSINESS_TIMEZONE_OFFSET_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_CUSTOM_RANGE_DAYS = 366;

function localDateParts(now = new Date()) {
  const vietnam = new Date(now.getTime() + BUSINESS_TIMEZONE_OFFSET_MS);
  return {
    year: vietnam.getUTCFullYear(),
    month: vietnam.getUTCMonth(),
    day: vietnam.getUTCDate()
  };
}

function vietnamMidnightUtc(year, month, day) {
  return new Date(Date.UTC(year, month, day) - BUSINESS_TIMEZONE_OFFSET_MS);
}

function parseBusinessDate(value, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) {
    throw new HttpError(400, "INVALID_DASHBOARD_DATE", `${fieldName} phải có định dạng YYYY-MM-DD`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const parsed = vietnamMidnightUtc(year, month - 1, day);
  const check = new Date(parsed.getTime() + BUSINESS_TIMEZONE_OFFSET_MS);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new HttpError(400, "INVALID_DASHBOARD_DATE", `${fieldName} không phải ngày hợp lệ`);
  }
  return parsed;
}

export function resolveDashboardPeriod(searchParams, now = new Date()) {
  const fromValue = searchParams?.get("from");
  const toValue = searchParams?.get("to");
  const requestedRange = searchParams?.get("range") || "week";

  if (fromValue || toValue) {
    if (!fromValue || !toValue) {
      throw new HttpError(400, "INCOMPLETE_DASHBOARD_RANGE", "Cần chọn đủ ngày bắt đầu và ngày kết thúc");
    }
    const from = parseBusinessDate(fromValue, "Ngày bắt đầu");
    const to = new Date(parseBusinessDate(toValue, "Ngày kết thúc").getTime() + DAY_MS);
    const days = Math.round((to - from) / DAY_MS);
    if (to <= from || days > MAX_CUSTOM_RANGE_DAYS) {
      throw new HttpError(400, "INVALID_DASHBOARD_RANGE", "Khoảng thời gian phải từ 1 đến 366 ngày");
    }
    return { range: "custom", from, to, days };
  }

  if (!["day", "week", "month"].includes(requestedRange)) {
    throw new HttpError(400, "INVALID_DASHBOARD_RANGE", "Khoảng xem chỉ hỗ trợ ngày, tuần, tháng hoặc tùy chọn");
  }

  const { year, month, day } = localDateParts(now);
  const today = vietnamMidnightUtc(year, month, day);
  const days = requestedRange === "day" ? 1 : requestedRange === "week" ? 7 : 30;
  const from = new Date(today.getTime() - (days - 1) * DAY_MS);
  const to = new Date(today.getTime() + DAY_MS);
  return { range: requestedRange, from, to, days };
}

export async function buildDashboardSummary(searchParams, now = new Date()) {
  const period = resolveDashboardPeriod(searchParams, now);
  const summary = await callRpc("get_admin_dashboard_summary", {
    p_from: period.from.toISOString(),
    p_to: period.to.toISOString()
  });

  if (!summary || typeof summary !== "object") {
    throw new HttpError(502, "INVALID_DASHBOARD_SUMMARY", "Supabase không trả về dữ liệu dashboard hợp lệ");
  }

  // A percentage/point comparison is undefined when the previous period has
  // no orders. The SQL returns null for count/revenue deltas; normalize every
  // related comparison here so the UI never presents a fabricated increase.
  if (summary.business?.comparisons?.orderCountPct === null) {
    summary.business.comparisons.completionRatePoints = null;
  }

  return {
    ...summary,
    range: period.range,
    from: period.from.toISOString(),
    to: new Date(period.to.getTime() - 1).toISOString(),
    periodDays: period.days
  };
}
