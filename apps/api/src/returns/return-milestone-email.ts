import { sendDirectEmail } from "../email/mailer.js";
import { insertRow, selectOne, selectRows } from "../supabase.js";
import { asJsonObject, asNumber, asString, type JsonObject } from "../types.js";
import { REFUND_SLA_MAX_WORKING_DAYS, REFUND_SLA_MIN_WORKING_DAYS } from "./return-sla.js";

/**
 * Customer notification milestones (BA AD_AUDIT_01 / RET-15) that had no email before:
 * request received, CSKH reached the customer, warehouse received the goods and refund started.
 */
export type ReturnMilestone = "intake" | "contacted" | "received" | "refunding";

/** Outbox template code per milestone; one code per milestone keeps the dedupe query exact. */
export const RETURN_MILESTONE_TEMPLATES: Readonly<Record<ReturnMilestone, string>> = {
  intake: "return_intake_received",
  contacted: "return_contacted",
  received: "return_goods_received",
  refunding: "return_refund_processing"
};

/** Facts the templates may mention; every field is optional so a missing read never blocks the send. */
export interface ReturnMilestoneContext {
  customerName: string;
  returnCode: string;
  orderCode: string;
  /** Units the warehouse actually received, when known. */
  receivedQuantity?: number;
  /** Units the customer registered, when known. */
  registeredQuantity?: number;
  /** Refund deadline (ISO) shown on the refunding milestone. */
  refundDueAt?: string;
}

/** Rendered message; `html` stays minimal because the plain text is the source of truth. */
export interface ReturnMilestoneMessage {
  subject: string;
  text: string;
  html: string;
}

/**
 * Stable key of one milestone for one request or part. The sender refuses a second email for the
 * same key, so retries and repeated admin clicks never produce duplicate notifications.
 */
export function returnMilestoneKey(milestone: ReturnMilestone, returnId: string, returnItemId?: string): string {
  return `${milestone}:${returnItemId || returnId}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(iso: string | undefined): string {
  const time = Date.parse(iso || "");
  if (!Number.isFinite(time)) return "";
  return new Date(time).toLocaleDateString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });
}

/** One line telling the customer how many units arrived when fewer than registered. */
function partialNotice(ctx: ReturnMilestoneContext): string[] {
  if (ctx.receivedQuantity === undefined || ctx.registeredQuantity === undefined || ctx.receivedQuantity >= ctx.registeredQuantity) return [];
  return [`Số lượng thực nhận: ${ctx.receivedQuantity}/${ctx.registeredQuantity} sản phẩm. CSKH sẽ liên hệ bạn về phần còn thiếu.`];
}

/** Builds the Vietnamese subject and body of one milestone. Pure: no I/O, easy to test. */
export function buildReturnMilestoneMessage(milestone: ReturnMilestone, ctx: ReturnMilestoneContext): ReturnMilestoneMessage {
  const code = ctx.returnCode;
  const lines: string[] = [`Kính chào ${ctx.customerName},`, ""];
  let subject: string;
  switch (milestone) {
    case "intake":
      subject = `[Velura] Đã tiếp nhận yêu cầu đổi/trả ${code}`;
      lines.push(`Velura đã tiếp nhận yêu cầu đổi/trả ${code} cho đơn #${ctx.orderCode}.`,
        "CSKH sẽ liên hệ bạn trong vòng 24 giờ để xác nhận phương án xử lý.");
      break;
    case "contacted":
      subject = `[Velura] CSKH đã liên hệ về yêu cầu đổi/trả ${code}`;
      lines.push(`CSKH Velura đã liên hệ bạn về yêu cầu ${code} (đơn #${ctx.orderCode}).`,
        "Nếu cần điều chỉnh thông tin, bạn có thể phản hồi trực tiếp email này.");
      break;
    case "received":
      subject = `[Velura] Kho đã nhận hàng đổi/trả ${code}`;
      lines.push(`Kho Velura đã nhận hàng gửi về cho yêu cầu ${code} (đơn #${ctx.orderCode}).`);
      lines.push(...partialNotice(ctx), "Chúng tôi sẽ tiếp tục xử lý theo phương án đã thống nhất.");
      break;
    case "refunding": {
      subject = `[Velura] Đang hoàn tiền cho yêu cầu ${code}`;
      const due = formatDate(ctx.refundDueAt);
      lines.push(`Kho đã nhận hàng và Velura đang xử lý hoàn tiền cho yêu cầu ${code} (đơn #${ctx.orderCode}).`,
        ...partialNotice(ctx),
        `Tiền được hoàn trong ${REFUND_SLA_MIN_WORKING_DAYS}-${REFUND_SLA_MAX_WORKING_DAYS} ngày làm việc${due ? `, chậm nhất ${due}` : ""}.`);
      break;
    }
  }
  const text = lines.join("\n");
  const html = `<div style="font-family:Inter,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">${
    lines.map((line) => (line ? `<p style="color:#374151;line-height:1.6;">${escapeHtml(line)}</p>` : "")).join("")}</div>`;
  return { subject, text, html };
}

/** Data access and delivery used by the sender; tests replace it with in-memory fakes. */
export interface ReturnMilestoneDeps {
  selectOne: typeof selectOne;
  selectRows: typeof selectRows;
  insertRow: typeof insertRow;
  send: typeof sendDirectEmail;
}

const defaultDeps: ReturnMilestoneDeps = { selectOne, selectRows, insertRow, send: sendDirectEmail };

/** Optional facts for one send. */
export interface ReturnMilestoneOptions {
  returnItemId?: string;
  receivedQuantity?: number;
  registeredQuantity?: number;
  refundDueAt?: string;
}

/**
 * Sends one milestone email at most once per `returnMilestoneKey`. Returns true when the customer
 * has (now or earlier) been notified, false when nothing could be sent. Never throws: a mail
 * failure must not undo the business action that triggered it.
 */
export async function sendReturnMilestoneEmail(
  returnId: string,
  milestone: ReturnMilestone,
  options: ReturnMilestoneOptions = {},
  deps: ReturnMilestoneDeps = defaultDeps
): Promise<boolean> {
  try {
    const template = RETURN_MILESTONE_TEMPLATES[milestone];
    const eventKey = returnMilestoneKey(milestone, returnId, options.returnItemId);
    const prior = await deps.selectRows("email_outbox", {
      select: "email_id,status,metadata", template_code: `eq.${template}`,
      "metadata->>event_key": `eq.${eventKey}`, limit: 5
    }).catch(() => ({ rows: [] as JsonObject[] }));
    if (prior.rows?.some((row: JsonObject) => asString(asJsonObject(row.metadata).event_key) === eventKey && row.status === "sent")) return true;

    const ret = await deps.selectOne("return_exchange", {
      select: "return_id,order_id,user_id,return_code,tracking_return_code", return_id: `eq.${returnId}`
    });
    if (!ret) return false;
    const order = await deps.selectOne("orders", {
      select: "order_id,user_id,order_code,shipping_name,shipping_email", order_id: `eq.${asString(ret.order_id)}`
    });
    if (!order) return false;
    let email = asString(order.shipping_email).trim();
    let name = asString(order.shipping_name).trim();
    const userId = asString(ret.user_id) || asString(order.user_id);
    if ((!email || !name) && userId) {
      const user = await deps.selectOne("users", { select: "email,full_name", user_id: `eq.${userId}` }).catch(() => null);
      email = email || asString(user?.email).trim();
      name = name || asString(user?.full_name).trim();
    }
    if (!email.includes("@")) return false;

    const message = buildReturnMilestoneMessage(milestone, {
      customerName: name || "Quý khách",
      returnCode: asString(ret.return_code) || asString(ret.tracking_return_code) || returnId.slice(0, 8).toUpperCase(),
      orderCode: asString(order.order_code) || asString(ret.order_id).slice(0, 8).toUpperCase(),
      receivedQuantity: options.receivedQuantity !== undefined ? asNumber(options.receivedQuantity) : undefined,
      registeredQuantity: options.registeredQuantity !== undefined ? asNumber(options.registeredQuantity) : undefined,
      refundDueAt: options.refundDueAt
    });
    const sent = await deps.send(email, message.subject, message.text, message.html);
    await deps.insertRow("email_outbox", {
      recipient: email, template_code: template, subject: message.subject, body: message.text,
      status: sent ? "sent" : "pending", related_user_id: userId || null,
      metadata: { event_key: eventKey, return_id: returnId, return_item_id: options.returnItemId || null, milestone, sent_at: new Date().toISOString() }
    }).catch((error) => console.warn("[RETURN_MILESTONE_EMAIL] outbox failed", error));
    return sent;
  } catch (error) {
    console.error(`[RETURN_MILESTONE_EMAIL] ${milestone} failed for ${returnId}:`, error);
    return false;
  }
}
