import { config } from "../config.js";
import { sendDirectEmail } from "../email/mailer.js";
import { callRpc, selectRows } from "../supabase.js";
import { asJsonObject, asString, isJsonObject, type JsonObject } from "../types.js";

const DB_OPTIONS = Object.freeze({ useAnonKey: false });
const EVENT_LABELS: Readonly<Record<string, string>> = Object.freeze({
  l2: "L2 · Cần phối hợp giải quyết",
  l3: "L3 · Cần CSKH tiếp nhận",
  important_update: "Cập nhật quan trọng",
  warning: "Cảnh báo bảo vệ CSKH",
  correction: "Đính chính hồ sơ",
  case_end: "Kết thúc hồ sơ"
});
/** Node timer owned by the report worker; callers may clear it during graceful shutdown. */
export type ChatReportWorkerTimer = NodeJS.Timeout;

function targets(): { email: string | null; webhook: string | null } {
  return {
    email: process.env.CHAT_REPORT_EMAIL?.trim() || process.env.SUPPORT_ALERT_TO?.trim() || null,
    webhook: process.env.CHAT_REPORT_WEBHOOK_URL?.trim() || config.n8nChatWebhookUrl?.trim() || null
  };
}

/** Persist an idempotent urgent snapshot built atomically from verified filtered database context; never accept caller/model content. */
export async function enqueueChatReport(sessionId: string, event: string): Promise<void> {
  const destination = targets();
  await callRpc("chat_enqueue_report", {
    p_session: sessionId,
    p_event: event.toLowerCase(),
    p_email: destination.email,
    p_webhook: destination.webhook
  }, DB_OPTIONS);
}

/** List delivery state for an already authorized staff session without exposing payloads, pending text, or originals. */
export async function listChatReports(sessionId: string): Promise<JsonObject[]> {
  const { rows } = await selectRows("chat_report_outbox", {
    select: "report_id,session_id,case_id,event,context_version,source_sequence,status,recipient_email,attempts,next_attempt_at,last_error,corrects_report_id,email_delivered_at,webhook_delivered_at,created_at,updated_at,delivered_at",
    session_id: `eq.${sessionId}`,
    order: "created_at.desc,report_id.desc",
    limit: 100
  }, { ...DB_OPTIONS, count: "none" });
  return rows;
}

/** Requeue an authorized staff report using explicitly configured destinations, retaining confirmed channel delivery and stable identifiers. */
export async function retryChatReport(sessionId: string, reportId: string): Promise<JsonObject> {
  const destination = targets();
  return asJsonObject(await callRpc("chat_retry_report", {
    p_session: sessionId,
    p_report: reportId,
    p_email: destination.email,
    p_webhook: destination.webhook
  }, DB_OPTIONS));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function scalar(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : asString(value);
}

function renderText(report: JsonObject, payload: JsonObject): string {
  const context = asJsonObject(payload.context);
  const messages = Array.isArray(payload.messages) ? payload.messages.filter(isJsonObject) : [];
  const warnings = Array.isArray(payload.warnings) ? payload.warnings.filter(isJsonObject) : [];
  const outcome = asJsonObject(payload.outcome);
  const intelligence = asJsonObject(payload.intelligence);
  const summaryVerification = asJsonObject(payload.summaryVerification);
  const suggestion = asJsonObject(payload.currentSuggestion);
  const linkedHistory = asJsonObject(payload.linkedHistory);
  const linkedOutcome = asJsonObject(linkedHistory.outcome);
  const facts = Array.isArray(payload.verifiedFacts) ? payload.verifiedFacts.filter(isJsonObject) : [];
  const reasons = Array.isArray(intelligence.reasons)
    ? intelligence.reasons.filter((value: unknown): value is string => typeof value === "string") : [];
  const sourceIds = Array.isArray(suggestion.sourceIds)
    ? suggestion.sourceIds.filter((value: unknown): value is string => typeof value === "string") : [];
  const approaches = Array.isArray(context.failedApproaches)
    ? context.failedApproaches.filter((value: unknown): value is string => typeof value === "string") : [];
  return [
    "KHẨN / URGENT — Báo cáo CSKH từ ngữ cảnh đã lọc và xác minh",
    `Sự kiện: ${EVENT_LABELS[asString(report.event)] || "Cập nhật hồ sơ"}`,
    `Hồ sơ: ${asString(report.case_id)}`,
    `Phiên: ${asString(report.session_id)}`,
    `Hồ sơ liên kết trước: ${asString(payload.linkedCaseId) || "Không có"}`,
    ...(payload.linkedHistory ? [
      `Lịch sử đã lọc (${asString(linkedHistory.caseId)} · v${scalar(linkedHistory.contextRevision)}): ${asString(linkedHistory.problem)}; mong muốn: ${asString(linkedHistory.wanted)}`,
      `Kết quả hồ sơ liên kết: ${asString(linkedOutcome.resolution)} · ${asString(linkedOutcome.finalSentiment)}`
    ] : []),
    `Báo cáo: ${asString(report.report_id)}`,
    `Phiên bản ngữ cảnh: ${asString(report.context_version)}`,
    `Phiên bản tin nhắn nguồn: ${scalar(report.source_sequence)}`,
    `Phiếu hỗ trợ: ${asString(payload.ticketId) || "Chưa tạo"}`,
    `Đính chính báo cáo: ${asString(report.corrects_report_id) || "Không"}`,
    `Trạng thái: ${asString(payload.handoffStatus)} · Rủi ro: ${asString(payload.risk)}`,
    `Vấn đề: ${asString(context.problem)}`,
    `Mong muốn: ${asString(context.wanted)}`,
    `Cách xử lý đã thử: ${approaches.join("; ")}`,
    `Cảm xúc: ${asString(context.sentiment)}`,
    `Độ tin cậy: ${scalar(intelligence.confidence) || "Chưa có"}`,
    `Lý do đã kiểm tra an toàn: ${reasons.join("; ") || "Chưa có"}`,
    `Bằng chứng lọc: ${asString(intelligence.filterStatus) || "Chưa có"} · nguồn ${scalar(intelligence.sourceSequence)} · cập nhật ${asString(intelligence.updatedAt)}`,
    `Xác minh quyền sở hữu: ${asString(payload.ownerVerification) || "Chưa có"}`,
    `Xác nhận tóm tắt: ${summaryVerification.confirmed === true ? "Đã xác nhận" : "Chưa có xác nhận"} · ${asString(summaryVerification.by)} · ${asString(summaryVerification.at)}`,
    "Nguồn dữ kiện đã kiểm tra phiên bản:",
    ...facts.map(fact => `${asString(fact.kind)}:${asString(fact.id)} @ ${asString(fact.version)} · phê duyệt ${fact.approved === true ? "có" : fact.approved === false ? "không" : "chưa có"}`),
    ...(payload.currentSuggestion ? [
      `Đề xuất hiện tại đã xác minh: ${asString(suggestion.text)}`,
      `Cách xử lý: ${asString(suggestion.approach)} · nguồn: ${sourceIds.join(", ")} · tin ${scalar(suggestion.sourceSequence)} · xác minh ${asString(suggestion.verifiedAt)}`
    ] : []),
    `Tin nhắn đang chờ xác minh (không được gửi): ${scalar(payload.pendingMessages)}`,
    ...warnings.map(warning => `Cảnh báo ${asString(warning.id)}: ${asString(warning.text)}${warning.resolved === true ? " (đã xử lý)" : ""}`),
    ...(payload.outcome ? [
      `Kết quả: ${asString(outcome.resolution)}`,
      `Cảm xúc cuối: ${asString(outcome.finalSentiment)}`,
      `Đánh giá: ${scalar(outcome.rating) || "Chưa đánh giá"}`
    ] : []),
    "",
    "Hội thoại đã lọc:",
    ...messages.map(message => `[${scalar(message.sequence)} · ${asString(message.sender)} · ${asString(message.messageId)} · v${scalar(message.version)} · lọc ${message.filterVerified === true ? "đã xác minh" : "chưa có chứng cứ"}] ${asString(message.text)}`)
  ].join("\n");
}

async function deliver(report: JsonObject): Promise<void> {
  const destination = targets();
  const payload = asJsonObject(report.payload);
  let emailSuccess = Boolean(report.email_delivered_at);
  let webhookSuccess = Boolean(report.webhook_delivered_at);
  const errors: string[] = [];
  if (!emailSuccess) {
    const email = asString(report.recipient_email);
    if (!email || destination.email !== email) {
      errors.push("CHAT_REPORT_EMAIL changed or is not configured; staff must retry with the configured destination");
    } else {
      const text = renderText(report, payload);
      emailSuccess = await sendDirectEmail(
        email,
        `[KHẨN/URGENT] ${EVENT_LABELS[asString(report.event)] || "CSKH"} · ${asString(report.case_id)}`,
        text,
        `<h1>KHẨN / URGENT — CSKH</h1><pre style="white-space:pre-wrap">${escapeHtml(text)}</pre>`,
        { priority: "high", messageId: `<chat-report-${asString(report.report_id)}@velura.royalai.dev>` }
      );
      if (!emailSuccess) errors.push("SMTP did not confirm recipient acceptance");
    }
  }
  const webhook = asString(report.webhook_url);
  if (webhook && !webhookSuccess) {
    if (destination.webhook !== webhook) {
      errors.push("CHAT_REPORT_WEBHOOK_URL changed; staff must retry with the configured destination");
    } else {
      try {
        const token = process.env.CHAT_REPORT_WEBHOOK_URL?.trim()
          ? process.env.CHAT_REPORT_WEBHOOK_TOKEN?.trim() : config.n8nChatWebhookToken?.trim();
        const response = await fetch(webhook, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": asString(report.report_id),
            ...(token ? { authorization: `Bearer ${token}` } : {})
          },
          redirect: "error",
          body: JSON.stringify({
            reportId: report.report_id,
            sessionId: report.session_id,
            caseId: report.case_id,
            event: report.event,
            contextVersion: report.context_version,
            correctsReportId: report.corrects_report_id,
            priority: "urgent",
            context: payload
          }),
          signal: AbortSignal.timeout(15000)
        });
        webhookSuccess = response.ok;
        if (!response.ok) errors.push(`Webhook returned HTTP ${response.status}`);
        await response.body?.cancel();
      } catch {
        errors.push("Webhook failed or timed out");
      }
    }
  }
  const completed = await callRpc("chat_complete_report", {
    p_report: report.report_id,
    p_lease: report.lease_token,
    p_email_success: emailSuccess,
    p_webhook_success: webhookSuccess,
    p_error: errors.join("; ") || null
  }, DB_OPTIONS);
  if (completed !== true) console.warn("[chat-reports] expired or replaced delivery lease", asString(report.report_id));
}

/** Start bounded concurrent delivery with database leases, six-attempt backoff, per-channel checkpoints and stable downstream deduplication IDs. */
export function startChatReportWorker(): ChatReportWorkerTimer | null {
  const configuredInterval = Number(process.env.CHAT_REPORT_WORKER_INTERVAL_MS ?? 5000);
  if (!config.supabaseServiceRoleKey || !Number.isFinite(configuredInterval) || configuredInterval <= 0) return null;
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const destination = targets();
      await callRpc("chat_activate_reports", { p_email: destination.email, p_webhook: destination.webhook }, DB_OPTIONS);
      const claimed = await callRpc("chat_claim_reports", { p_limit: 10 }, DB_OPTIONS);
      const reports = Array.isArray(claimed) ? claimed.filter(isJsonObject) : [];
      await Promise.all(reports.map(async report => {
        try {
          await deliver(report);
        } catch {
          // Do not reset other workers' leases or log provider bodies/filtered user content.
          console.error("[chat-reports] delivery checkpoint failed; lease will recover", asString(report.report_id));
        }
      }));
    } catch {
      console.error("[chat-reports] claim failed; durable reports remain queued");
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => { void run(); }, Math.max(1000, configuredInterval));
  timer.unref?.();
  return timer;
}
