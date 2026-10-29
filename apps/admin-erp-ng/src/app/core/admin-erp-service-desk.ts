/**
 * Return, ticket and chat rules the API enforces, mirrored here so CSKH sees the reason
 * before a request is sent. Values copy `apps/api/src/returns/return-constants.ts` and the
 * chatbot service; the server stays the authority and its error remains the fallback.
 */
import { AdminReturnItemAction, AdminReturnLine, AdminReturnRow, AdminReturnStatus, AdminTicketRow } from './admin-erp-api.service';
import { AdminTone } from './admin-erp-status-labels';

/** Canonical Vietnamese labels for stored return workflow codes. */
export const RETURN_STATUS_LABELS: Readonly<Record<string, string>> = {
  REQUESTED: 'Chờ xử lý',
  CONTACTING: 'Đang liên hệ',
  APPROVED: 'Đã duyệt',
  IN_PROGRESS: 'Đang xử lý từng phần',
  PARTIALLY_APPROVED: 'Duyệt một phần',
  REJECTED: 'Đã từ chối',
  RETURN_SHIPPING: 'Hàng đang gửi về',
  REFUND_PENDING: 'Đang chờ hoàn tiền',
  WAITING_RETURN: 'Chờ khách gửi hàng',
  RETURN_IN_TRANSIT: 'Hàng đang gửi về',
  RECEIVED: 'Kho đã nhận & kiểm hàng',
  REFUND_PROCESSING: 'Đang hoàn tiền',
  REFUNDED: 'Đã hoàn tiền',
  EXCHANGE_PREPARING: 'Đang chuẩn bị hàng đổi',
  EXCHANGE_SHIPPING: 'Đang giao hàng đổi',
  COMPLETED: 'Hoàn tất',
  CANCELLED: 'Đã hủy',
  NEEDS_SUPPORT: 'Cần hỗ trợ',
};

const RETURN_STATUS_TONES: Readonly<Record<string, AdminTone>> = {
  REQUESTED: 'warning',
  CONTACTING: 'warning',
  APPROVED: 'info',
  IN_PROGRESS: 'info',
  PARTIALLY_APPROVED: 'warning',
  REJECTED: 'danger',
  RETURN_SHIPPING: 'info',
  REFUND_PENDING: 'warning',
  WAITING_RETURN: 'info',
  RETURN_IN_TRANSIT: 'info',
  RECEIVED: 'info',
  REFUND_PROCESSING: 'warning',
  REFUNDED: 'success',
  EXCHANGE_PREPARING: 'warning',
  EXCHANGE_SHIPPING: 'info',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
  NEEDS_SUPPORT: 'danger',
};

/** Open states keep return quota reserved on the original order line. */
export const OPEN_RETURN_STATUSES: readonly AdminReturnStatus[] = [
  'REQUESTED',
  'CONTACTING',
  'IN_PROGRESS',
  'PARTIALLY_APPROVED',
  'WAITING_RETURN',
  'RETURN_IN_TRANSIT',
  'RECEIVED',
  'REFUND_PROCESSING',
  'EXCHANGE_PREPARING',
  'EXCHANGE_SHIPPING',
  'NEEDS_SUPPORT',
];

/** Reasons a customer can pick; the API stores the code and shows the label. */
export const RETURN_REASONS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'error', label: 'Sản phẩm bị lỗi sản xuất' },
  { code: 'size', label: 'Không vừa kích cỡ' },
  { code: 'color', label: 'Sai màu sắc' },
  { code: 'mismatch', label: 'Sản phẩm khác với mô tả' },
  { code: 'damaged', label: 'Hàng bị hư hỏng trong vận chuyển' },
  { code: 'mind_change', label: 'Thay đổi ý định mua hàng' },
  { code: 'other', label: 'Lý do khác' },
];

/** Outreach outcomes the contact endpoint accepts. */
export const CONTACT_RESULTS: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'reached', label: 'Liên hệ được' },
  { code: 'no_answer', label: 'Không liên hệ được' },
  { code: 'waiting_customer', label: 'Chờ khách bổ sung' },
];

/** Labels for `refund_receiver_status`. */
export const REFUND_RECEIVER_STATUS_LABELS: Readonly<Record<string, string>> = {
  not_required: 'Không cần thông tin nhận tiền',
  missing: 'Chưa có thông tin nhận tiền',
  invalid: 'Thông tin nhận tiền không hợp lệ',
  supplement_requested: 'Đã yêu cầu khách bổ sung',
  valid: 'Thông tin nhận tiền hợp lệ',
};

export const REFUND_FLOW_LABELS: Readonly<Record<string, string>> = {
  cod_manual: 'Hoàn tiền COD: chuyển khoản thủ công có đối soát',
  stripe_auto: 'Hoàn tiền tự động qua Stripe',
  manual_transfer: 'Chuyển khoản thủ công qua cổng thanh toán online',
  none: 'Đổi hàng, không hoàn tiền',
};

/** Support ticket states, identical to `SUPPORT_TICKET_STATUSES`. */
export const TICKET_STATUSES: readonly string[] = ['open', 'processing', 'resolved', 'closed'];

/** `SUPPORT_TICKET_TRANSITIONS` from the API. */
export const TICKET_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  open: ['processing', 'closed'],
  processing: ['resolved', 'closed'],
  resolved: ['closed'],
  closed: [],
};

/** The state each ticket action writes, so a button only appears when the step is legal. */
export const TICKET_ACTION_TARGET: Readonly<Record<'reply' | 'resolve' | 'close', string>> = {
  reply: 'processing',
  resolve: 'resolved',
  close: 'closed',
};

export const TICKET_PRIORITY_LABELS: Readonly<Record<string, string>> = {
  low: 'Thấp',
  normal: 'Thường',
  high: 'Cao',
  urgent: 'Khẩn',
};

/** Chat handoff states used by the queue filter. */
export const HANDOFF_STATUSES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'ai', label: 'Bot đang trả lời' },
  { code: 'requested', label: 'Khách yêu cầu nhân viên' },
  { code: 'assigned', label: 'Đã phân công' },
  { code: 'closed', label: 'Đã kết thúc' },
];

/** Review decisions the chat endpoint accepts; each is audited with the staff id. */
export const CHAT_REVIEW_ACTIONS = [
  'correction',
  'outcome',
  'supervisor',
  'moderate',
  'summary',
  'resolve',
  'reopen',
  'refilter',
  'offer',
  'report_retry',
] as const;

export const CHAT_RISK_TONES: Readonly<Record<string, AdminTone>> = {
  green: 'success',
  yellow: 'warning',
  orange: 'warning',
  red: 'danger',
};

/** Minimum characters for notes, reasons and supplement requests. */
export const MIN_NOTE_LENGTH = 10;

/** Minimum characters of a bank transfer reference recorded on a manual refund. */
export const MIN_TRANSFER_REFERENCE_LENGTH = 6;

/** Longest message the chat endpoints accept. */
export const MAX_CHAT_TEXT = 2000;

/** Allowed classification values, mirrored from the review endpoint. */
export const CHAT_CLASSIFICATION_FIELDS = {
  intent: ['facts', 'catalog', 'policy_problem', 'order', 'human'],
  level: ['L0', 'L1', 'L2', 'L3'],
  issue: ['general', 'catalog', 'sizing', 'delivery', 'return', 'payment', 'cancellation'],
  sentiment: ['positive', 'neutral', 'negative'],
  risk: ['green', 'yellow', 'orange', 'red'],
  moderation: ['none', 'abuse', 'threat', 'illegal', 'sensitive'],
} as const;

/**
 * Vietnamese return status label, keeping unknown backend codes visible.
 */
export function returnStatusLabel(status: string | null | undefined): string {
  const key = String(status || '');
  if (!key) {
    return '—';
  }
  return RETURN_STATUS_LABELS[key] || key;
}

/**
 * Badge tone for a return status.
 */
export function returnStatusTone(status: string | null | undefined): AdminTone {
  return RETURN_STATUS_TONES[String(status || '')] || 'neutral';
}


/**
 * Whether the ticket action is legal from its stored state.
 */
export function canTicketAction(ticket: AdminTicketRow | null, action: 'reply' | 'resolve' | 'close'): boolean {
  const target = TICKET_ACTION_TARGET[action];
  return (TICKET_TRANSITIONS[String(ticket?.status || '')] || []).includes(target);
}

/**
 * A chat-linked ticket is worked in its canonical chat session, not through the ticket API.
 */
export function isChatGovernedTicket(ticket: AdminTicketRow | null): boolean {
  return Boolean(ticket?.chat_session_id);
}



/**
 * Outreach may be logged on any live return; terminal ones are history.
 */
export function contactAllowed(row: AdminReturnRow | null): boolean {
  return Boolean(row && !['REFUNDED', 'COMPLETED', 'CANCELLED', 'REJECTED'].includes(String(row.status)));
}


/**
 * COD refunds stay blocked until the customer supplies valid payout details.
 */
export function refundReceiverBlocked(row: AdminReturnRow | null): boolean {
  return row?.payment_kind === 'cod' && row.refund_receiver_status !== 'valid';
}

/**
 * Payout-detail supplement is only meaningful for a live COD refund.
 */
export function refundInfoAllowed(row: AdminReturnRow | null): boolean {
  return Boolean(row && row.payment_kind === 'cod' && contactAllowed(row));
}


/**
 * Whether a return status still reserves line quota, for the queue KPI.
 */
export function isReturnOpen(status: string | null | undefined): boolean {
  return OPEN_RETURN_STATUSES.includes(String(status) as AdminReturnStatus);
}

/**
 * Label of a `payment_kind` channel, matching the wording used by the refund flow hints.
 */
export function paymentKindLabel(kind: string | null | undefined): string {
  const labels: Record<string, string> = { cod: 'COD', stripe: 'Stripe', other_online: 'Cổng online' };
  return labels[String(kind || '')] || 'Chưa xác định';
}

/**
 * True when the note meets the API minimum; the same rule is checked again server-side.
 */
export function noteIsReady(value: string, minimum = MIN_NOTE_LENGTH): boolean {
  return value.trim().length >= minimum;
}


/** Gateway execution status describes only the selected item operation. */
export function gatewayNote(refund: { status: string; message?: string } | null): string {
  if (!refund) {
    return 'Cổng không trả về trạng thái. Kiểm lại giao dịch trước khi thử lại.';
  }
  if (refund.status === 'refunded') {
    return 'Stripe đã hoàn tiền cho phần hàng này. Các phần khác giữ nguyên tiến độ.';
  }
  if (refund.status === 'requested') {
    return 'Đã gửi yêu cầu hoàn tiền tới Stripe; chờ cổng xác nhận.';
  }
  if (refund.status === 'skipped') {
    return 'Cổng bỏ qua giao dịch này; kiểm tra lại số tiền hoàn.';
  }
  return refund.message || 'Hoàn tiền qua Stripe thất bại. Kiểm lại giao dịch rồi thử lại.';
}

/** Decision labels stay separate from logistics progress on mixed requests. */
export function returnDecisionLabel(value: string | null | undefined): string {
  const labels: Readonly<Record<string, string>> = {
    pending: 'Chờ duyệt', approved: 'Đã duyệt', rejected: 'Từ chối',
    PENDING: 'Chờ duyệt', APPROVED: 'Đã duyệt', REJECTED: 'Từ chối',
    PARTIALLY_APPROVED: 'Duyệt một phần',
  };
  return labels[String(value || '')] || value || 'Chờ duyệt';
}

/** Item actions never infer eligibility from the immutable request type or aggregate stage. */
export function returnItemActions(line: AdminReturnLine, canApprove: boolean): readonly AdminReturnItemAction[] {
  const status = line.item_status;
  if (['COMPLETED', 'REJECTED', 'CANCELLED'].includes(String(status))) return [];
  if (line.decision_status === 'pending') return canApprove ? ['approve', 'reject'] : [];
  if (line.decision_status !== 'approved') return [];
  const actions: AdminReturnItemAction[] = [];
  if (status === 'APPROVED') actions.push('wait_return');
  if (status === 'WAITING_RETURN') actions.push('pickup');
  if (status === 'RETURN_SHIPPING') actions.push('receive');
  if (status === 'NEEDS_SUPPORT') actions.push('resolve');
  if (line.resolution_type === 'exchange') {
    if (!line.exchange_order_id) {
      actions.push('change_variant');
      if (status === 'RECEIVED') actions.push('prepare_exchange');
    }
    const cancellableExchange = !line.exchange_order_id
      || ['confirmed', 'pending', 'cancelled', 'delivery_failed'].includes(String(line.exchange_order?.status));
    if (cancellableExchange && (!line.exchange_order_id || status === 'EXCHANGE_PREPARING' || status === 'NEEDS_SUPPORT')) actions.push('convert_refund');
  }
  if (status === 'EXCHANGE_PREPARING') actions.push('ship_exchange');
  if (status === 'EXCHANGE_SHIPPING' && line.exchange_order?.status === 'delivered') actions.push('complete_exchange');
  if (status !== 'NEEDS_SUPPORT') actions.push('needs_support');
  if (['REQUESTED', 'APPROVED', 'WAITING_RETURN'].includes(String(status))) actions.push('stop');
  return actions;
}

/** Money is scoped to a QA-accepted refund part, never the parent request. */
export function itemRefundAllowed(line: AdminReturnLine): boolean {
  return line.decision_status === 'approved' && line.resolution_type === 'refund'
    && ['RECEIVED', 'REFUND_PENDING'].includes(String(line.item_status));
}

/** Contact SLA uses the server deadline; waiting for the customer does not erase business progress. */
export function returnContactOverdue(row: AdminReturnRow, now = Date.now()): boolean {
  const deadline = Date.parse(row.contact_due_at || '');
  return contactAllowed(row) && Number.isFinite(deadline) && deadline < now;
}
