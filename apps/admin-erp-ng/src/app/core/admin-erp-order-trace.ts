import type {
  AdminAuditRow,
  AdminOrderAction,
  AdminOrderEvent,
  AdminOrderRow,
  AdminReturnRow,
} from './admin-erp-api.service';
import { returnStatusLabel } from './admin-erp-service-desk';

/** Vietnamese label for each `order_event.action` code the state machine writes. */
export const ORDER_EVENT_LABELS: Readonly<Record<string, string>> = {
  order_created: 'Tạo đơn',
  call_confirm: 'Gọi xác nhận',
  confirm_cod: 'Xác nhận đơn',
  auto_confirm_cod: 'Tự xác nhận COD',
  start_processing: 'Bắt đầu chuẩn bị hàng',
  record_shortage: 'Ghi nhận thiếu hàng',
  upsert_shipment: 'Tạo/cập nhật vận đơn',
  confirm_handover: 'Bàn giao đơn vị vận chuyển',
  carrier_note: 'Ghi chú liên hệ đơn vị vận chuyển',
  update_tracking: 'Cập nhật tracking',
  void_shipment: 'Vô hiệu vận đơn',
  carrier_delivered: 'Đơn vị vận chuyển báo giao thành công',
  carrier_failed_returned: 'Đơn vị vận chuyển báo giao thất bại, hoàn hàng',
  carrier_failed_retrying: 'Đơn vị vận chuyển báo giao thất bại, giao lại',
  record_failure_reason: 'Ghi lý do giao thất bại',
  confirm_return_to_stock: 'Xác nhận hàng hoàn kho',
  cancel: 'Hủy đơn',
  customer_cancel: 'Khách hủy đơn',
  to_waiting_payment: 'Chờ thanh toán',
  payment_succeeded: 'Thanh toán thành công',
  payment_expired: 'Hết hạn thanh toán',
  stripe_refund_succeeded: 'Hoàn tiền Stripe thành công',
  stripe_refund_failed: 'Hoàn tiền Stripe thất bại',
};

const CALL_RESULT_LABELS: Readonly<Record<string, string>> = {
  reached: 'Liên hệ được',
  no_answer: 'Không nghe máy',
  customer_requests_cancel: 'Khách yêu cầu hủy',
};

/** Business meaning of one row in the linked order timeline. */
export type OrderTraceOrigin = 'order' | 'return' | 'audit';
export type OrderTraceTone = 'info' | 'success' | 'warning' | 'danger' | 'neutral';

/** A link to another ERP workspace that keeps the operator inside one trace. */
export interface OrderTraceLink {
  readonly label: string;
  readonly commands: readonly string[];
  readonly query: Readonly<Record<string, string>>;
}

export interface OrderTraceEntry {
  readonly id: string;
  readonly at: string;
  readonly title: string;
  readonly actor: string;
  readonly detail: string;
  readonly origin: OrderTraceOrigin;
  readonly tone: OrderTraceTone;
  readonly links: readonly OrderTraceLink[];
  /** Pipeline step this fact belongs to; empty when it belongs to no single step. */
  readonly stage?: string;
}

/** Known values an action form can be seeded from, so the operator never re-types them. */
export interface OrderActionPrefill {
  readonly note: string;
  readonly carrier: string;
  readonly trackingCode: string;
  readonly trackingUrl: string;
}

const DEDUPE_WINDOW_MS = 60_000;

/**
 * Deep link to one order drawer inside the orders workspace.
 */
export function orderFocusLink(orderId: string, label = 'Mở đơn hàng'): OrderTraceLink {
  return { label, commands: ['/orders'], query: { focus: orderId } };
}

/**
 * Deep link to the returns workspace filtered to one source order.
 */
export function returnsForOrderLink(orderId: string, label = 'Đổi trả của đơn này'): OrderTraceLink {
  return { label, commands: ['/returns'], query: { order_id: orderId } };
}

/**
 * Deep link to one return record inside the returns workspace.
 */
export function returnFocusLink(returnId: string, label = 'Mở hồ sơ đổi trả'): OrderTraceLink {
  return { label, commands: ['/returns'], query: { focus: returnId } };
}

/**
 * Deep link to the audit workspace scoped to one order.
 */
export function logsForOrderLink(orderId: string): OrderTraceLink {
  return { label: 'Nhật ký kiểm tra', commands: ['/logs'], query: { module: 'orders', target: orderId } };
}

function timeOf(value: string | undefined | null): number {
  const parsed = Date.parse(String(value || ''));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function traceTone(action: string, toStatus?: string | null): OrderTraceTone {
  if (action === 'carrier_delivered' || action === 'payment_succeeded' || action === 'confirm_return_to_stock') return 'success';
  if (action.includes('failed') || action === 'cancel' || action === 'customer_cancel' || action === 'payment_expired' || toStatus === 'cancelled') {
    return 'danger';
  }
  if (action === 'record_shortage' || action === 'record_failure_reason' || action === 'void_shipment') return 'warning';
  return 'info';
}

function eventActor(event: AdminOrderEvent): string {
  if (event.actor_type === 'system') return 'Hệ thống';
  if (event.actor_type === 'customer') return 'Khách hàng';
  return event.actor_role || event.actor_id || 'Admin';
}

function eventDetail(event: AdminOrderEvent): string {
  const payload = (event.payload || {}) as Record<string, unknown>;
  const parts: string[] = [];
  const callResult = CALL_RESULT_LABELS[String(event.result || '')] || '';
  if (callResult) parts.push(callResult);
  const provider = String(payload['provider'] || '');
  const carrier = String(payload['carrier'] || '');
  const tracking = String(payload['tracking_code'] || payload['trackingCode'] || '');
  if (carrier || tracking || provider) parts.push(['Vận đơn', provider, carrier, tracking].filter(Boolean).join(' · '));
  const shortage = String(payload['shortage'] || payload['quantity_short'] || '');
  if (shortage) parts.push(`Thiếu ${shortage}`);
  const reason = String(payload['cancel_reason'] || payload['failure_reason'] || payload['reason'] || '');
  if (reason) parts.push(reason);
  if (event.note) parts.push(event.note);
  return parts.filter(Boolean).join(' — ');
}

/**
 * Order events are the authoritative business trail; each one becomes one timeline row.
 */
export function eventTrace(events: readonly AdminOrderEvent[]): OrderTraceEntry[] {
  return events.map((event, index) => ({
    id: `event:${event.event_id || `${event.action || index}:${event.created_at || index}`}`,
    at: String(event.created_at || ''),
    title: ORDER_EVENT_LABELS[String(event.action || '')] || event.action || 'Sự kiện đơn hàng',
    actor: eventActor(event),
    detail: eventDetail(event),
    origin: 'order' as OrderTraceOrigin,
    tone: traceTone(String(event.action || ''), event.to_status),
    links: [],
    stage: stageForAction(String(event.action || ''), event.to_status, event.from_status),
  }));
}

const STAGE_BY_STATUS: Readonly<Record<string, string>> = {
  pending: 'pending',
  waiting_payment: 'pending',
  confirmed: 'confirmed',
  processing: 'processing',
  shipping: 'shipping',
  delivered: 'delivered',
  delivery_failed: 'delivery_failed',
  cancelled: 'cancelled',
};

const STAGE_BY_ACTION: Readonly<Record<string, string>> = {
  call_confirm: 'pending',
  payment_succeeded: 'pending',
  payment_failed: 'pending',
  payment_expired: 'pending',
  confirm_cod: 'confirmed',
  start_processing: 'confirmed',
  upsert_shipment: 'processing',
  confirm_handover: 'processing',
  void_shipment: 'processing',
  update_tracking: 'shipping',
  carrier_note: 'shipping',
  carrier_delivered: 'shipping',
  carrier_failed_retrying: 'shipping',
  record_failure_reason: 'delivery_failed',
  confirm_return_to_stock: 'delivery_failed',
  cancel: 'cancelled',
  customer_cancel: 'cancelled',
  retry_refund: 'cancelled',
};

function stageForAction(action: string, toStatus?: string | null, fromStatus?: string | null): string {
  return (
    STAGE_BY_STATUS[String(toStatus || '')] ||
    (action === 'cancel' || action === 'customer_cancel' ? STAGE_BY_STATUS[String(fromStatus || '')] : '') ||
    STAGE_BY_ACTION[action] ||
    ''
  );
}

function stageOfAudit(row: AdminAuditRow, action: string): string {
  for (const value of [row.new_value, row.old_value]) {
    if (value && typeof value === 'object') {
      const status = String((value as Record<string, unknown>)['status'] || '');
      if (STAGE_BY_STATUS[status]) return STAGE_BY_STATUS[status];
    }
  }
  return STAGE_BY_ACTION[action] || '';
}

/**
 * Return records attached to the order, so refunds and exchanges appear in the same trail.
 */
export function returnTrace(returns: readonly AdminReturnRow[]): OrderTraceEntry[] {
  return returns
    .filter((row) => !!row.return_id)
    .map((row) => {
      const status = String(row.status || '');
      const detail = [
        row.request_type === 'exchange' ? 'Đổi hàng' : 'Hoàn tiền',
        row.refund_amount ? `Số tiền hoàn ${row.refund_amount}` : '',
        row.tracking_return_code ? `Hàng về ${row.tracking_return_code}` : '',
        row.exchange_tracking_code ? `Hàng đổi đi ${row.exchange_tracking_code}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      const links: OrderTraceLink[] = [returnFocusLink(row.return_id, 'Mở hồ sơ đổi trả')];
      if (row.exchange_order_id) links.push(orderFocusLink(row.exchange_order_id, 'Đơn đổi'));
      return {
        id: `return:${row.return_id}`,
        at: String(row.created_at || row.resolved_at || ''),
        title: `Đổi trả ${row.return_id.slice(0, 8)} — ${returnStatusLabel(status)}`,
        actor: row.customer_name || row.customer_phone || 'Khách hàng',
        detail,
        origin: 'return' as OrderTraceOrigin,
        tone: status === 'COMPLETED' ? 'success' : status === 'CANCELLED' ? 'neutral' : status === 'NEEDS_SUPPORT' ? 'danger' : 'warning',
        links,
      };
    });
}

function auditAction(row: AdminAuditRow): string {
  const next = row.new_value as { action?: unknown } | null;
  return String(next?.action || row.action || '');
}

/**
 * Audit rows add the acting person's identity to trail entries the state machine already wrote.
 */
export function auditTrace(rows: readonly AdminAuditRow[]): OrderTraceEntry[] {
  return rows
    .filter((row) => !!row.timestamp)
    .map((row) => {
      const action = auditAction(row);
      return {
        id: `audit:${row.audit_id || `${action}:${row.timestamp}`}`,
        at: String(row.timestamp || ''),
        title: ORDER_EVENT_LABELS[action] || row.action_label || row.action || 'Thao tác quản trị',
        actor: row.actor_label || row.actor_name || row.actor_id || 'Hệ thống',
        detail: [row.change_summary, row.reason].filter((value): value is string => !!value).join(' — '),
        origin: 'audit' as OrderTraceOrigin,
        tone: traceTone(action),
        links: [],
        stage: stageOfAudit(row, action),
      };
    });
}

/**
 * Merges events, returns and audit into one newest-first trail.
 *
 * The state machine writes an `audit_log` row for every manual action, so an audit row that
 * carries the same action code within a minute of its event is the same fact twice: the event
 * wins, and the audit row only contributes the actor identity it knows and the event does not.
 */
export function mergeOrderTrace(...sources: ReadonlyArray<readonly OrderTraceEntry[]>): OrderTraceEntry[] {
  const entries = sources.flat().filter((entry) => !!entry.at);
  const events = entries.filter((entry) => entry.origin === 'order');
  const folded = new Map<string, string>();
  const duplicates = new Set<string>();
  for (const audit of entries.filter((entry) => entry.origin === 'audit')) {
    const twin = events.find((event) => event.title === audit.title && Math.abs(timeOf(event.at) - timeOf(audit.at)) <= DEDUPE_WINDOW_MS);
    if (!twin || folded.has(twin.id)) {
      continue;
    }
    folded.set(twin.id, audit.actor || twin.actor);
    duplicates.add(audit.id);
  }
  return entries
    .filter((entry) => !duplicates.has(entry.id))
    .map((entry) => (folded.has(entry.id) ? { ...entry, actor: folded.get(entry.id) || entry.actor } : entry))
    .sort((a, b) => timeOf(b.at) - timeOf(a.at));
}

/**
 * Order actions the operator can take right now, in the state machine's own order.
 */
export function allowedAction(order: AdminOrderRow | null, code: string): AdminOrderAction | null {
  return (order?.allowed_actions || []).find((action) => action.code === code) ?? null;
}

function lastEventValue(events: readonly AdminOrderEvent[], keys: readonly string[]): string {
  for (const event of [...events].sort((a, b) => timeOf(b.created_at) - timeOf(a.created_at))) {
    const payload = (event.payload || {}) as Record<string, unknown>;
    for (const key of keys) {
      const value = payload[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return '';
}

/**
 * Why the carrier failed the last delivery attempt, read from the event the carrier wrote.
 */
function lastCarrierFailure(events: readonly AdminOrderEvent[]): string {
  const failed = events
    .filter((event) => String(event.action || '').startsWith('carrier_failed'))
    .sort((a, b) => timeOf(b.created_at) - timeOf(a.created_at))[0];
  if (!failed) return '';
  return lastEventValue([failed], ['failure_reason', 'reason', 'status_description', 'tracking_note']) || String(failed.note || '');
}

/**
 * Seeds an action form with the facts the order already holds: shipment data, the tracked
 * reason of the last carrier failure, and a note drafted from those facts. Every value stays
 * editable — this removes re-typing, it never removes the operator's decision.
 */
export function actionPrefill(action: AdminOrderAction | null, order: AdminOrderRow | null): OrderActionPrefill {
  const empty: OrderActionPrefill = { note: '', carrier: '', trackingCode: '', trackingUrl: '' };
  if (!action || !order) return empty;
  const events = order.events || [];
  const wantsShipment = action.fields.includes('shipment') || action.fields.includes('tracking');
  const carrier = wantsShipment ? String(order.carrier || '') : '';
  const trackingCode = wantsShipment ? String(order.tracking_code || '') : '';
  const trackingUrl = wantsShipment ? String(order.tracking_url || '') : '';
  const code = order.order_code || order.order_id.slice(0, 8);
  const shipment = carrier || trackingCode ? `${carrier || 'đơn vị vận chuyển'} ${trackingCode || ''}`.trim() : '';
  const notes: Record<string, string> = {
    upsert_shipment: trackingCode ? `Tạo lại vận đơn ${shipment} cho đơn ${code}` : `Tạo vận đơn cho đơn ${code}`,
    update_tracking: trackingCode ? `Cập nhật tracking ${shipment} cho đơn ${code}` : `Cập nhật tracking cho đơn ${code}`,
    confirm_handover: trackingCode ? `Bàn giao ${shipment} cho đơn ${code}` : `Bàn giao đơn ${code}`,
    start_processing: `Bắt đầu chuẩn bị hàng đơn ${code}`,
    confirm_cod: `Xác nhận đơn COD ${code}`,
    carrier_note: `Ghi nhận liên hệ đơn vị vận chuyển ${shipment || code}`,
    record_failure_reason: `Giao thất bại đơn ${code}: ${lastCarrierFailure(events) || 'chưa rõ lý do'}`,
    confirm_return_to_stock: `Xác nhận hàng hoàn về kho đơn ${code}${lastCarrierFailure(events) ? ` — ${lastCarrierFailure(events)}` : ''}`,
    retry_refund: `Thử hoàn tiền lại đơn ${code}`,
    cancel: `Hủy đơn ${code}`,
  };
  return { note: notes[action.code] || '', carrier, trackingCode, trackingUrl };
}

/**
 * Whether the shipment form should offer to hand the parcel over in the same step.
 *
 * The API keeps `upsert_shipment` status-neutral and requires a second `confirm_handover`
 * call, so an operator who prints a label today must reopen a modal and re-justify the same
 * fact. The chain only runs while the freshly returned order still allows handover.
 */
export function handoverFollowUp(order: AdminOrderRow | null, shipment: { carrier: string; trackingCode: string }): AdminOrderAction | null {
  if (!order || !shipment.trackingCode.trim() || order.shipment_voided_at) return null;
  if (order.status !== 'processing') return null;
  return allowedAction(order, 'confirm_handover');
}

/**
 * Note for the chained handover action, built from the shipment facts just stored.
 */
export function handoverNote(carrier: string, trackingCode: string, orderCode: string): string {
  const shipment = [carrier, trackingCode].filter(Boolean).join(' · ');
  return `Bàn giao ${shipment || orderCode} cho đơn vị vận chuyển (tạo vận đơn cùng thao tác)`;
}
