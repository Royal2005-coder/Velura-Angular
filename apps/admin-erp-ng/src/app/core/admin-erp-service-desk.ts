/**
 * Return, ticket and chat rules the API enforces, mirrored here so CSKH sees the reason
 * before a request is sent. Values copy `apps/api/src/returns/return-constants.ts` and the
 * chatbot service; the server stays the authority and its error remains the fallback.
 */
import { AdminReturnRow, AdminReturnStatus, AdminTicketRow } from './admin-erp-api.service';
import { AdminTone } from './admin-erp-status-labels';

/** Canonical Vietnamese labels for stored return workflow codes. */
export const RETURN_STATUS_LABELS: Readonly<Record<string, string>> = {
  REQUESTED: 'Chờ xử lý',
  CONTACTING: 'Đang liên hệ',
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
  'WAITING_RETURN',
  'RETURN_IN_TRANSIT',
  'RECEIVED',
  'REFUND_PROCESSING',
  'EXCHANGE_PREPARING',
  'EXCHANGE_SHIPPING',
  'NEEDS_SUPPORT',
];

/** `RETURN_TRANSITIONS` from the API, quoted so the UI cannot offer a step the RPC rejects. */
export const RETURN_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  REQUESTED: ['CONTACTING', 'CANCELLED'],
  CONTACTING: ['WAITING_RETURN', 'CANCELLED', 'NEEDS_SUPPORT'],
  WAITING_RETURN: ['RETURN_IN_TRANSIT', 'CANCELLED'],
  RETURN_IN_TRANSIT: ['RECEIVED', 'NEEDS_SUPPORT'],
  RECEIVED: ['REFUND_PROCESSING', 'EXCHANGE_PREPARING', 'NEEDS_SUPPORT'],
  REFUND_PROCESSING: ['REFUNDED', 'NEEDS_SUPPORT'],
  REFUNDED: ['COMPLETED'],
  EXCHANGE_PREPARING: ['EXCHANGE_SHIPPING', 'NEEDS_SUPPORT'],
  EXCHANGE_SHIPPING: ['COMPLETED', 'NEEDS_SUPPORT'],
  COMPLETED: [],
  CANCELLED: [],
  NEEDS_SUPPORT: ['CONTACTING', 'CANCELLED'],
};

/** Refund states are advanced by gateway evidence, never by an operator pressing a button. */
export const GATEWAY_ONLY_STATUSES: readonly string[] = ['REFUND_PROCESSING', 'REFUNDED'];

/** Steps that require a tracking code: the return leg and the replacement leg. */
export const TRACKING_REQUIRED_STATUSES: readonly string[] = ['RETURN_IN_TRANSIT', 'EXCHANGE_SHIPPING'];

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
 * Steps the return can take from its stored state.
 */
export function allowedReturnTransitions(status: string | null | undefined): readonly string[] {
  return RETURN_TRANSITIONS[String(status || '')] || [];
}

/**
 * Steps an operator may set by hand; gateway states are excluded because the RPC rejects them.
 * `EXCHANGE_PREPARING` only applies to exchange slips, so a refund slip never sees that choice.
 */
export function manualReturnTransitions(
  status: string | null | undefined,
  returnType?: string | null,
): readonly string[] {
  return allowedReturnTransitions(status).filter(
    (value) =>
      !GATEWAY_ONLY_STATUSES.includes(value) &&
      !(value === 'EXCHANGE_PREPARING' && returnType != null && String(returnType) !== 'exchange'),
  );
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

/** States a return can still be rejected or cancelled from. */
export const RETURN_REJECTABLE_STATUSES: readonly string[] = [
  'REQUESTED',
  'CONTACTING',
  'WAITING_RETURN',
  'NEEDS_SUPPORT',
  'pending',
];

/** Terminal states: no outreach, no approval, no supplement request. */
export const RETURN_CLOSED_STATUSES: readonly string[] = ['REFUNDED', 'COMPLETED', 'CANCELLED'];

/**
 * Kho đã nhận hàng và QA đạt. Đây là điều kiện duy nhất để tạo đơn đổi hoặc hoàn tiền:
 * trạng thái RECEIVED mà thiếu kết quả QA thì API vẫn chặn, nên UI cũng không được mời bấm.
 */
export function warehouseQaPassed(row: AdminReturnRow | null): boolean {
  return String(row?.status || '') === 'RECEIVED' && row?.condition_check_result === 'qa_pass';
}

/**
 * An exchange can be prepared only after warehouse QA passed and it is an exchange.
 */
export function exchangeApprovalAllowed(row: AdminReturnRow | null): boolean {
  return Boolean(row && row.return_type === 'exchange' && warehouseQaPassed(row));
}

/** Bước kế tiếp của một phiếu, để drawer chỉ mời đúng một hành động thay vì mời bấm sớm. */
export interface ReturnNextStep {
  readonly flow:
    | 'contact'
    | 'receipt'
    | 'exchange'
    | 'status'
    | 'gateway'
    | 'refund-info'
    | 'shipment'
    | 'pickup'
    | 'exchange-shipment';
  readonly label: string;
  readonly hint: string;
  readonly target?: string;
}

/**
 * Bước tiếp theo theo đúng thứ tự nghiệp vụ hiện hành: liên hệ → chờ hàng → kho nhận & QA →
 * hoàn tiền/đổi hàng → hoàn tất. Không còn bước "duyệt trước khi nhận hàng": DB chỉ cho
 * RECEIVED + QA đạt đi tiếp, và tiền chỉ rời cổng/tài khoản sau bước đó.
 */
export function nextReturnStep(row: AdminReturnRow | null): ReturnNextStep | null {
  const status = String(row?.status || '');
  const isExchange = row?.return_type === 'exchange';
  const isStripe = row?.refund_flow === 'stripe_auto';
  switch (status) {
    case 'REQUESTED':
      return { flow: 'contact', label: 'Ghi nhận liên hệ', hint: 'Gọi khách và lưu kết quả liên hệ trước khi chuyển bước.' };
    case 'CONTACTING':
      return {
        flow: 'status',
        target: 'WAITING_RETURN',
        label: 'Chờ khách gửi hàng',
        hint: 'Đã thống nhất phương án; chuyển sang chờ hàng về kho.',
      };
    case 'WAITING_RETURN':
      if (row?.shipment?.status === 'label_ready') {
        return {
          flow: 'pickup',
          label: 'Xác nhận ĐVVC lấy hàng',
          hint: 'Quét mã phiếu hoàn, chụp ảnh kiện hàng niêm phong và xác nhận ĐVVC đã lấy hàng.',
        };
      }
      return {
        flow: 'shipment',
        label: 'Tạo vận đơn hoàn',
        hint: 'Chọn ĐVVC, nhập mã vận đơn và in phiếu gửi hoàn để khách dán lên kiện hàng.',
      };
    case 'RETURN_IN_TRANSIT':
      return {
        flow: 'receipt',
        label: 'Kho nhận hàng & QA',
        hint: 'Nhận hàng, chụp ảnh minh chứng và xác nhận QA đạt. Hoàn tiền chỉ mở sau bước này.',
      };
    case 'RECEIVED':
      if (row?.condition_check_result !== 'qa_pass') {
        return { flow: 'receipt', label: 'Hoàn tất QA', hint: 'Phiếu đã nhận nhưng chưa có kết quả QA đạt.' };
      }
      if (isExchange) {
        return {
          flow: 'exchange',
          label: 'Duyệt đổi hàng',
          hint: 'QA đạt; tạo đơn đổi và giữ tồn kho cho hàng thay thế trong một giao dịch.',
        };
      }
      if (row?.refund_flow === 'cod_manual' && row?.refund_receiver_status !== 'valid') {
        return {
          flow: 'refund-info',
          label: 'Xin thông tin nhận tiền',
          hint: 'Khách chưa có tài khoản nhận hoàn tiền; gửi yêu cầu bổ sung trước khi chuyển khoản.',
        };
      }
      return {
        flow: 'gateway',
        label: isStripe ? 'Hoàn tiền qua Stripe' : 'Ghi nhận chuyển khoản hoàn tiền',
        hint: isStripe
          ? 'Cổng Stripe hoàn tiền và xác nhận kết quả; không cần bước duyệt trung gian.'
          : 'Kế toán chuyển khoản cho khách, sau đó ghi nhận mã giao dịch và chứng từ.',
      };
    case 'REFUND_PROCESSING':
      return {
        flow: 'gateway',
        label: isStripe ? 'Chạy lại hoàn tiền qua cổng' : 'Ghi nhận chuyển khoản hoàn tiền',
        hint: 'Khoản hoàn đang chờ xác nhận tiền ra; hoàn tất bằng chứng từ của cổng hoặc chuyển khoản.',
      };
    case 'REFUNDED':
      return { flow: 'status', target: 'COMPLETED', label: 'Hoàn tất phiếu', hint: 'Tiền đã hoàn; đóng phiếu.' };
    case 'EXCHANGE_PREPARING':
      return {
        flow: 'exchange-shipment',
        label: 'Giao hàng đổi',
        hint: 'Tạo vận đơn cho đơn đổi; mã vận đơn được ghi đồng thời lên đơn đổi và phiếu hoàn.',
      };
    case 'EXCHANGE_SHIPPING':
      return { flow: 'status', target: 'COMPLETED', label: 'Hoàn tất đổi hàng', hint: 'Khách đã nhận hàng đổi; đóng phiếu.' };
    default:
      return null;
  }
}

/**
 * Rejection is only offered while the return is still in a rejectable state.
 */
export function rejectAllowed(row: AdminReturnRow | null): boolean {
  return Boolean(row && RETURN_REJECTABLE_STATUSES.includes(String(row.status)));
}

/**
 * Outreach may be logged on any live return; terminal ones are history.
 */
export function contactAllowed(row: AdminReturnRow | null): boolean {
  return Boolean(row && !RETURN_CLOSED_STATUSES.includes(String(row.status)));
}

/**
 * Refund money moves only after the warehouse accepted the goods.
 */
export function gatewayRefundAllowed(row: AdminReturnRow | null): boolean {
  if (!row) {
    return false;
  }
  const status = String(row.status || '');
  return (status === 'RECEIVED' || status === 'REFUND_PROCESSING') && row.condition_check_result === 'qa_pass';
}

/**
 * The Stripe button only exists for a Stripe-captured order; other channels use the manual record.
 */
export function stripeRefundAllowed(row: AdminReturnRow | null): boolean {
  return Boolean(row && row.return_type !== 'exchange' && row.payment_kind === 'stripe' && gatewayRefundAllowed(row));
}

/**
 * Manual transfer reconciliation applies to captured payments outside Stripe (COD, MoMo, VNPay).
 */
export function manualRefundAllowed(row: AdminReturnRow | null): boolean {
  if (!row || !gatewayRefundAllowed(row)) {
    return false;
  }
  if (row.payment_kind === 'stripe') {
    return false;
  }
  const status = String(row.payment?.payment_status || '');
  return (row.refund_flow === 'cod_manual' || row.refund_flow === 'manual_transfer') && ['paid', 'refund_pending'].includes(status);
}

/**
 * COD refunds stay blocked until the customer supplies valid payout details.
 */
export function refundReceiverBlocked(row: AdminReturnRow | null): boolean {
  return row?.refund_flow === 'cod_manual' && row.refund_receiver_status !== 'valid';
}

/**
 * Payout-detail supplement is only meaningful for a live COD refund.
 */
export function refundInfoAllowed(row: AdminReturnRow | null): boolean {
  return Boolean(
    row &&
      row.refund_flow === 'cod_manual' &&
      !RETURN_CLOSED_STATUSES.includes(String(row.status)),
  );
}

/**
 * The warehouse receipt step is the only way into `RECEIVED`, and only from transit.
 */
export function receiptAllowed(row: AdminReturnRow | null): boolean {
  return String(row?.status || '') === 'RETURN_IN_TRANSIT';
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

/**
 * Proof must be a data URL or an http(s) URL the API can store.
 */
export function proofIsUsable(value: string): boolean {
  return /^(https?:\/\/|data:image\/)/.test(value.trim());
}

/**
 * Gateway answer in operator language. Approval and execution are separate API calls, so the same
 * wording is used by the manual "refund through Stripe" button and by the chained step.
 */
export function gatewayNote(refund: { status: string; message?: string } | null): string {
  if (!refund) {
    return 'Cổng không trả về trạng thái. Kiểm lại giao dịch trước khi thử lại.';
  }
  if (refund.status === 'refunded') {
    return 'Stripe đã hoàn tiền. Phiếu sẽ được đánh dấu hoàn tất theo luồng.';
  }
  if (refund.status === 'requested') {
    return 'Đã gửi yêu cầu hoàn tiền tới Stripe; chờ cổng xác nhận.';
  }
  if (refund.status === 'skipped') {
    return 'Cổng bỏ qua giao dịch này; kiểm tra lại số tiền hoàn.';
  }
  return refund.message || 'Hoàn tiền qua Stripe thất bại. Kiểm lại giao dịch rồi thử lại.';
}
