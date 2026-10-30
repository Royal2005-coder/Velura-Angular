import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { ApiRequestError } from '../models/api-request-error';
import {
  DemoOrder,
  DemoOrderLine,
  DemoOrderStatus,
  DemoRefundReceiver,
  DemoReturn,
  DemoReturnLine,
  RETURN_WORKFLOW_LABELS,
  RefundReceiverStatus,
  ReturnCancelledBy,
  ReturnWorkflowStatus,
} from './purchase-demo.store';
import type {
  ComboComponentItem,
  OrderAccountModel,
  RefundBankDetails,
  ReplacementChoice,
  ReturnReasonCode,
  ReturnTrackingDetail,
  ReturnTrackingEvidence,
  ReturnTrackingEvent,
  ReturnTrackingExchangeOrder,
  ReturnTrackingShipment,
} from './order-account.model';
import type { ProductSummary } from '../models/product.interface';

/** Real order status → the `DemoOrderStatus` token the KAN-31 template already renders. */
const ORDER_STATUS_MAP: Record<string, DemoOrderStatus> = {
  pending: 'pending',
  waiting_payment: 'pending_payment',
  confirmed: 'confirmed',
  processing: 'preparing',
  shipping: 'shipping',
  delivered: 'delivered',
  delivery_failed: 'delivery_failed',
  cancelled: 'cancelled',
};

/** One persisted workflow, with branch-specific progress after warehouse receipt. */
const RETURN_COMMON: ReturnWorkflowStatus[] = ['REQUESTED', 'CONTACTING', 'WAITING_RETURN', 'RETURN_IN_TRANSIT', 'RECEIVED'];

function returnStates(kind: DemoReturn['kind']): ReturnWorkflowStatus[] {
  return [...RETURN_COMMON, ...(kind === 'refund' ? ['REFUND_PROCESSING', 'REFUNDED'] : ['EXCHANGE_PREPARING', 'EXCHANGE_SHIPPING', 'COMPLETED']) as ReturnWorkflowStatus[]];
}

/** Capture authorization identity before an asynchronous operation starts. */
interface OrderContext { generation: number; userId: string | null; session: object | null; guestToken: string; }

/** A tab-scoped guest proof expires without becoming an account login token. */
interface GuestProof { token: string; phone: string; expiresAt: number; }

interface ApiOrderItem {
  item_id?: string;
  variant_id?: string;
  product_id?: string;
  product_name?: string;
  product_image?: string | null;
  size?: string | null;
  color?: string | null;
  quantity?: number;
  unit_price?: number;
  return_count?: number;
  available_quantity?: number;
  is_combo?: boolean;
  is_in_progress?: boolean;
  in_progress_return_code?: string | null;
  in_progress_status?: string | null;
  available_refund_unit_amounts?: number[];
}

interface ApiOrder {
  order_id?: string;
  order_code?: string;
  status?: string;
  created_at?: string;
  delivered_at?: string;
  shipping_name?: string;
  shipping_phone?: string;
  shipping_address?: string;
  payment_method?: string;
  payment_status?: string;
  refund_status?: string;
  refunded_amount?: number;
  can_cancel?: boolean;
  can_request_return?: boolean;
  can_pay_again?: boolean;
  subtotal?: number;
  shipping_fee?: number;
  discount_amount?: number;
  total_amount?: number;
  points_discount_amount?: number;
  voucher_discount_type?: string;
  version?: number;
  cancelled_reason?: string | null;
  items?: ApiOrderItem[];
}

interface ApiReturnItem {
  return_item_id?: string;
  version?: number;
  product_name?: string;
  item_status?: string;
  decision_status?: string;
  resolution_type?: 'refund' | 'exchange';
  replacement_variant_id?: string;
  exchange_order_id?: string;
  refund_amount?: number;
  exchange_order?: ApiReturnExchangeOrder | null;
  attention_status?: string;
  reason?: string;
  updated_at?: string;
  completed_at?: string;
  order_item_id?: string;
  variant_id?: string | null;
  quantity?: number;
}

interface ApiRefundReceiver {
  status?: string;
  bank_name?: string | null;
  account_last4?: string | null;
  account_holder?: string | null;
  submitted_at?: string | null;
  supplement_request?: string | null;
  supplement_requested_at?: string | null;
}

interface ApiReturn {
  refund_amount?: number;
  return_id?: string;
  return_code?: string;
  tracking_return_code?: string;
  order_id?: string;
  order_code?: string;
  return_type?: 'refund' | 'exchange';
  description?: string | null;
  evidence_images?: string[] | null;
  status?: string;
  rejection_reason?: string | null;
  cancelled_by?: ReturnCancelledBy | null;
  payment_method?: 'COD' | 'ONLINE_PAYMENT';
  refund_flow?: DemoReturn['refundFlow'];
  refund_receiver?: ApiRefundReceiver | null;
  created_at?: string;
  resolved_at?: string | null;
  version?: number;
  items?: ApiReturnItem[];
  refund_bank_name?: string | null;
  refund_bank_account?: string | null;
  refund_bank_holder?: string | null;
}

interface ApiReturnEvidence {
  evidence_id?: string;
  kind?: string;
  url?: string | null;
  mime_type?: string | null;
  note?: string | null;
  created_at?: string;
}

interface ApiReturnShipment {
  carrier?: string | null;
  tracking_code?: string | null;
  tracking_url?: string | null;
  label_url?: string | null;
  handover_code?: string | null;
  status?: string | null;
  picked_up_at?: string | null;
  delivered_at?: string | null;
  pickup_photo_urls?: string[] | null;
  package_video_url?: string | null;
}

interface ApiReturnEvent {
  event_type?: string;
  label?: string;
  at?: string;
  direction?: string | null;
  carrier?: string | null;
  tracking_code?: string | null;
  tracking_url?: string | null;
}

interface ApiReturnExchangeOrder {
  order_id?: string;
  order_code?: string;
  status?: string;
  carrier?: string | null;
  tracking_code?: string | null;
  tracking_url?: string | null;
  shipping_name?: string | null;
  shipping_phone?: string | null;
  shipping_address?: string | null;
  items?: Array<{ product_name?: string; quantity?: number; color?: string; size?: string }>;
}

interface ApiReturnDetail extends ApiReturn {
  status_label?: string;
  type_label?: string;
  can_cancel?: boolean;
  can_upload_packing?: boolean;
  customer_name?: string | null;
  customer_phone?: string | null;
  customer_address?: string | null;
  timeline?: ApiReturnEvent[];
  shipment?: ApiReturnShipment | null;
  exchange_shipment?: ApiReturnShipment | null;
  exchange_order?: ApiReturnExchangeOrder | null;
  evidence?: ApiReturnEvidence[];
  instructions?: string[];
}

const RECEIVER_STATUSES: RefundReceiverStatus[] = ['not_required', 'missing', 'invalid', 'supplement_requested', 'valid'];

function mapRefundReceiver(receiver: ApiRefundReceiver | null | undefined): DemoRefundReceiver | undefined {
  if (!receiver) return undefined;
  const status = RECEIVER_STATUSES.find((value) => value === receiver.status) ?? 'missing';
  return {
    status,
    bankName: receiver.bank_name || undefined,
    accountLast4: receiver.account_last4 || undefined,
    holder: receiver.account_holder || undefined,
    submittedAt: receiver.submitted_at || undefined,
    supplementRequest: receiver.supplement_request || undefined,
    supplementRequestedAt: receiver.supplement_requested_at || undefined,
  };
}

/** Client-side mirror of the server rules, for friendly messages; the server stays authoritative. */
function validateRefundReceiver(name: string, account: string, holder: string): { bankName: string; accountNumber: string; accountHolder: string } {
  const bankName = name.trim();
  const accountNumber = account.replace(/[\s-]/g, '');
  const accountHolder = holder.trim();
  if (bankName.length < 2 || bankName.length > 80) throw new Error('Tên ngân hàng/ví cần từ 2 đến 80 ký tự.');
  if (!/^\d{6,20}$/.test(accountNumber)) throw new Error('Số tài khoản chỉ gồm chữ số và dài từ 6 đến 20 số.');
  if (accountHolder.length < 2 || accountHolder.length > 100 || /\d/.test(accountHolder)) throw new Error('Tên chủ tài khoản cần từ 2 đến 100 ký tự và không chứa chữ số.');
  return { bankName, accountNumber, accountHolder };
}

function mapAddress(order: ApiOrder) {
  return {
    name: order.shipping_name || '',
    phone: order.shipping_phone || '',
    email: '',
    province: '',
    district: '',
    ward: '',
    // Real orders keep one combined address string, not separate province/district/ward.
    detail: order.shipping_address || '',
  };
}

function formatReturnCode(raw: string | undefined | null): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(trimmed)) {
    return `RET${trimmed.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  }
  return trimmed;
}

function mapOrderItem(item: ApiOrderItem): DemoOrderLine {
  const code = formatReturnCode(item.in_progress_return_code);
  return {
    product_id: item.product_id || '',
    variant_id: item.variant_id || '',
    product_name: item.product_name || 'Sản phẩm',
    product_image: item.product_image || '',
    size: item.size || '',
    color: item.color || '',
    quantity: item.quantity || 0,
    unit_price: item.unit_price || 0,
    returnCount: item.return_count ?? 0,
    availableQuantity: item.available_quantity ?? item.quantity ?? 0,
    itemId: item.item_id,
    is_combo: Boolean(item.is_combo || /combo/i.test(item.product_name || '') || /set\s+/i.test(item.product_name || '')),
    isInProgress: Boolean(item.is_in_progress),
    inProgressCode: code || undefined,
    inProgressStatus: item.in_progress_status || undefined,
    availableRefundUnitAmounts: item.available_refund_unit_amounts,
  };
}

function mapOrder(order: ApiOrder, member: boolean, userId: string | null): DemoOrder {
  const items = (order.items || []).map(mapOrderItem);
  return {
    id: order.order_code || order.order_id || '',
    orderId: order.order_id,
    expectedVersion: order.version,
    member,
    userId: member ? userId || undefined : undefined,
    address: mapAddress(order),
    items,
    status: ORDER_STATUS_MAP[order.status || ''] ?? 'pending',
    payment: order.payment_method?.toUpperCase() === 'COD' ? 'COD'
      : ['STRIPE', 'ONLINE_PAYMENT'].includes(order.payment_method?.toUpperCase() || '') ? 'STRIPE'
      : order.payment_method?.toUpperCase() === 'MOMO' ? 'MOMO' : 'VNPAY',
    paymentState: ['paid', 'refund_pending', 'refunded', 'partially_refunded'].includes(order.payment_status || '') ? 'paid'
      : order.payment_status === 'failed' ? 'failed' : order.payment_status === 'expired' ? 'expired'
      : order.status === 'cancelled' ? 'cancelled' : 'pending',
    subtotal: order.subtotal || 0,
    shipping: order.shipping_fee || 0,
    discount: order.discount_amount || 0,
    total: order.total_amount || 0,
    pointsDiscount: typeof order.points_discount_amount === 'number' && Number.isFinite(order.points_discount_amount) ? order.points_discount_amount : 0,
    voucherDiscountType: order.voucher_discount_type,
    voucher: '',
    createdAt: order.created_at || new Date().toISOString(),
    deliveredAt: order.delivered_at || undefined,
    refund: order.refund_status === 'completed' || order.payment_status === 'refunded' ? 'completed'
      : order.refund_status === 'pending' || order.payment_status === 'refund_pending' ? 'pending' : undefined,
    cancellationReason: order.cancelled_reason || undefined,
    refundedAmount: typeof order.refunded_amount === 'number' && Number.isFinite(order.refunded_amount) ? order.refunded_amount : undefined,
    can_cancel: order.can_cancel,
    can_request_return: order.can_request_return,
    can_pay_again: order.can_pay_again,
  };
}

function mapReturnItem(item: ApiReturnItem): DemoReturnLine {
  return {
    variantId: item.variant_id || '', quantity: item.quantity || 0,
    returnItemId: item.return_item_id, expectedVersion: item.version, orderItemId: item.order_item_id, productName: item.product_name,
    itemStatus: item.item_status, decisionStatus: item.decision_status, resolutionType: item.resolution_type,
    replacementVariantId: item.replacement_variant_id, exchangeOrderId: item.exchange_order_id,
    exchangeOrderCode: item.exchange_order?.order_code, exchangeOrderStatus: item.exchange_order?.status,
    exchangeTrackingCode: item.exchange_order?.tracking_code || undefined, exchangeTrackingUrl: item.exchange_order?.tracking_url || undefined,
    refundAmount: item.refund_amount, attentionStatus: item.attention_status, reason: item.reason,
    updatedAt: item.updated_at, completedAt: item.completed_at,
  };
}

function mapReturn(row: ApiReturn): DemoReturn {
  const status = row.status && row.status in RETURN_WORKFLOW_LABELS ? row.status as ReturnWorkflowStatus : 'NEEDS_SUPPORT';
  const kind = row.return_type || 'refund';
  const cancelledBy = row.cancelled_by || undefined;
  // A CANCELLED row the customer did not end themself was refused (or stopped) by CSKH/system. Legacy rows
  // without `cancelled_by` count as customer-cancelled unless they carry a refusal reason.
  const customerCancelled = status === 'CANCELLED' && (cancelledBy === 'customer' || (!cancelledBy && !row.rejection_reason));
  const rejected = status === 'REJECTED' || (status === 'CANCELLED' && !customerCancelled);
  const endedAt = row.resolved_at || row.created_at || new Date().toISOString();
  return {
    id: formatReturnCode(row.return_code || row.tracking_return_code || row.return_id),
    returnId: row.return_id,
    expectedVersion: row.version,
    orderId: row.order_code || row.order_id || '',
    kind,
    items: (row.items || []).map(mapReturnItem),
    ...(row.refund_bank_name && row.refund_bank_account ? {
      bank: { name: row.refund_bank_name, last4: row.refund_bank_account.slice(-4), holder: row.refund_bank_holder || '' }
    } : {}),
    reason: row.description || '',
    evidenceNames: row.evidence_images || [],
    stage: returnStates(kind).indexOf(status),
    status,
    refundAmount: typeof row.refund_amount === 'number' && Number.isFinite(row.refund_amount) ? row.refund_amount : undefined,
    createdAt: row.created_at || new Date().toISOString(),
    completedAt: ['REFUNDED', 'COMPLETED'].includes(status) ? row.resolved_at || undefined : undefined,
    cancelledAt: customerCancelled ? endedAt : undefined,
    cancellationReason: customerCancelled ? row.rejection_reason || undefined : undefined,
    rejectedAt: rejected ? endedAt : undefined,
    rejectionReason: rejected || status === 'NEEDS_SUPPORT' ? row.rejection_reason || undefined : undefined,
    cancelledBy,
    paymentMethod: row.payment_method,
    refundFlow: row.refund_flow,
    refundReceiver: mapRefundReceiver(row.refund_receiver),
  };
}

function mapTrackingShipment(row: ApiReturnShipment | null | undefined): ReturnTrackingShipment | null {
  if (!row) return null;
  return {
    carrier: row.carrier || null,
    trackingCode: row.tracking_code || null,
    trackingUrl: row.tracking_url || null,
    labelUrl: row.label_url || null,
    handoverCode: row.handover_code || null,
    status: row.status || null,
    pickedUpAt: row.picked_up_at || null,
    deliveredAt: row.delivered_at || null,
    pickupPhotoUrls: Array.isArray(row.pickup_photo_urls) ? row.pickup_photo_urls.filter(Boolean) : [],
    packageVideoUrl: row.package_video_url || null,
  };
}

function mapTrackingEvidence(row: ApiReturnEvidence): ReturnTrackingEvidence {
  return {
    evidenceId: row.evidence_id,
    kind: row.kind,
    url: row.url || null,
    mimeType: row.mime_type || null,
    note: row.note || null,
    createdAt: row.created_at,
  };
}

function mapReturnTracking(row: ApiReturnDetail): ReturnTrackingDetail {
  const timeline: ReturnTrackingEvent[] = (row.timeline || []).map((event) => ({
    eventType: event.event_type || 'status',
    label: event.label || '',
    at: event.at,
    direction: event.direction || null,
    carrier: event.carrier || null,
    trackingCode: event.tracking_code || null,
    trackingUrl: event.tracking_url || null,
  }));
  const exchangeOrder: ReturnTrackingExchangeOrder | null = row.exchange_order ? {
    orderId: row.exchange_order.order_id,
    orderCode: row.exchange_order.order_code,
    status: row.exchange_order.status,
    carrier: row.exchange_order.carrier || null,
    trackingCode: row.exchange_order.tracking_code || null,
    trackingUrl: row.exchange_order.tracking_url || null,
    shippingName: row.exchange_order.shipping_name || null,
    shippingPhone: row.exchange_order.shipping_phone || null,
    shippingAddress: row.exchange_order.shipping_address || null,
    items: (row.exchange_order.items || []).map((item) => ({
      productName: item.product_name, quantity: item.quantity, color: item.color, size: item.size
    }))
  } : null;
  return {
    returnId: row.return_id || '',
    returnCode: row.return_code || row.tracking_return_code || '',
    orderCode: row.order_code || null,
    status: row.status || 'NEEDS_SUPPORT',
    statusLabel: row.status_label || RETURN_WORKFLOW_LABELS[(row.status || 'NEEDS_SUPPORT') as ReturnWorkflowStatus] || row.status || '',
    typeLabel: row.type_label || (row.return_type === 'exchange' ? 'Đổi hàng' : 'Hoàn tiền'),
    canCancel: row.can_cancel === true,
    canUploadPacking: row.can_upload_packing === true,
    customerName: row.customer_name || null,
    customerPhone: row.customer_phone || null,
    customerAddress: row.customer_address || null,
    timeline,
    shipment: mapTrackingShipment(row.shipment),
    exchangeShipment: mapTrackingShipment(row.exchange_shipment),
    exchangeOrder,
    evidence: (row.evidence || []).map(mapTrackingEvidence),
    instructions: row.instructions || [],
    items: (row.items || []).map(mapReturnItem),
  };
}

/**
 * Real, HTTP-backed Model for `OrderFlowPage` in production (`?preview=1` keeps using
 * `PurchaseDemoStore` through `OrderAccountPreviewAdapter` instead). Every method maps the
 * real `apps/api` JSON straight into the `DemoOrder`/`DemoReturn` shape the KAN-31 template
 * already renders, so the page and HTML barely change. No business rule is re-implemented
 * here — the server is authoritative; this layer only translates shapes and surfaces the
 * server's own error messages.
 */
@Injectable({ providedIn: 'root' })
export class OrderAccountApiStore implements OrderAccountModel {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly destroyRef = inject(DestroyRef);

  readonly member = computed(() => this.auth.isLoggedIn());
  readonly userId = computed(() => this.auth.session()?.userId || null);
  readonly verifiedPhone = signal('');
  readonly maskedEmail = signal('');
  readonly maskedPhone = signal('');
  readonly otpChannel = signal<'sms' | 'email' | 'both'>('email');
  readonly developmentOtp = signal('');
  readonly otpExpiresIn = signal(60);
  readonly orders = signal<DemoOrder[]>([]);
  readonly requests = signal<DemoReturn[]>([]);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly guestOtpRequired = true;
  readonly replacementsLoading = signal(false);
  readonly replacementsError = signal('');
  private readonly replacementByProduct = signal<Record<string, ReplacementChoice[]>>({});
  private readonly comboComponentsByProduct = signal<Record<string, ComboComponentItem[]>>({});
  private replacementVersion = 0;
  readonly cancellableBeforeStage = 3;
  readonly supportsBankInfo = true;
  private generation = 0;
  private refreshVersion = 0;
  private lookupVersion = 0;
  private challenge: { phone: string } | { order_code: string } | null = null;
  private guestProof = this.readGuestProof();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    if (this.guestProof && !this.member()) this.verifiedPhone.set(this.guestProof.phone);
    this.scheduleExpiry();
    effect(() => {
      const userId = this.auth.session()?.userId || null;
      untracked(() => {
        this.generation++;
        this.orders.set([]);
        this.requests.set([]);
        this.replacementByProduct.set({});
        this.replacementsLoading.set(false);
        this.replacementsError.set('');
        this.error.set('');
        if (userId) this.clearGuestSession();
        if (userId || this.guestToken()) void this.refresh();
        else this.loading.set(false);
      });
    });
    this.destroyRef.onDestroy(() => clearTimeout(this.expiryTimer));
  }

  /** Only the latest refresh from the active account or verified guest session is accepted. */
  async refresh(): Promise<void> {
    const context = this.context();
    if (!context.userId && !context.guestToken) return;
    const version = ++this.refreshVersion;
    this.loading.set(true);
    this.error.set('');
    try {
      if (context.userId) await Promise.all([this.loadOrders(context, version), this.loadReturns(context, version)]);
      else { await this.loadOrders(context, version); if (this.current(context) && version === this.refreshVersion) await this.loadReturns(context, version); }
    }
    catch (error) { if (this.current(context) && version === this.refreshVersion) this.error.set(orderAccountErrorMessage(error)); }
    finally { if (this.current(context) && version === this.refreshVersion) this.loading.set(false); }
  }

  /** Confirms that the current member or verified guest owns the presented order. */
  canAccess(order: DemoOrder): boolean {
    if (this.member()) return order.userId === this.userId();
    return !order.member && !!this.guestToken() && this.orders().some((row) => row === order);
  }

  /** Start one challenge by phone or order code without exposing any order data. */
  async sendOtp(value: string, mode: 'phone' | 'code' = 'phone'): Promise<void> {
    if (this.member()) throw new Error('Vui lòng mở đơn hàng của tài khoản đã đăng nhập.');
    const context = this.context();
    const challenge = mode === 'code' ? { order_code: value.trim() } : { phone: value.trim() };
    const response = await firstValueFrom(this.api.post<{ success?: boolean; message?: string; masked_phone?: string; masked_email?: string; channel?: 'sms' | 'email' | 'both'; development_otp?: string; expires_in?: number }>('/api/user/orders/track-otp-send', challenge));
    this.assertCurrent(context);
    if (!response.success) throw new Error(response.message || 'Chưa gửi được mã xác thực.');
    this.maskedPhone.set(response.masked_phone || '');
    this.maskedEmail.set(response.masked_email || '');
    this.otpChannel.set('sms');
    this.developmentOtp.set(response.development_otp || '');
    this.otpExpiresIn.set(response.expires_in || 60);
    this.challenge = challenge;
  }

  /** Verify once; keep a 15-minute proof in this tab for owned orders and return actions. */
  async verifyOtp(otpCode: string): Promise<void> {
    if (!this.challenge) throw new Error('Vui lòng gửi mã xác thực trước.');
    const context = this.context();
    const response = await firstValueFrom(this.api.post<{ success?: boolean; phone?: string; guest_access_token?: string; message?: string }>('/api/user/orders/track-otp-verify', { ...this.challenge, otp_code: otpCode }));
    this.assertCurrent(context);
    if (!response.success || !response.guest_access_token || !response.phone) throw new Error(response.message || 'Mã xác thực không hợp lệ.');
    this.generation++;
    this.guestProof = { token: response.guest_access_token, phone: response.phone, expiresAt: Date.now() + 15 * 60 * 1000 };
    sessionStorage.setItem('guest_order_session', JSON.stringify(this.guestProof));
    sessionStorage.setItem('velura_guest_review_phone', response.phone);
    sessionStorage.setItem('velura_guest_review_token', response.guest_access_token);
    this.verifiedPhone.set(response.phone);
    this.orders.set([]);
    this.requests.set([]);
    this.scheduleExpiry();
    await this.refresh();
    if (this.error()) throw new Error(this.error());
  }

  /** Load a guest order after its verified session authorizes ownership. */
  async lookupGuest(code: string, contact: string): Promise<void> {
    const context = this.context();
    if (context.userId || !context.guestToken) throw new Error('Vui lòng xác thực số điện thoại đặt hàng trước.');
    const version = ++this.lookupVersion;
    const data = await firstValueFrom(
      this.api.get<{ success?: boolean; order?: ApiOrder }>(
        `/api/user/orders/track?code=${encodeURIComponent(code)}&guest_access_token=${encodeURIComponent(context.guestToken)}`,
      ),
    );
    if (!this.current(context) || version !== this.lookupVersion) return;
    const order = data.order;
    if (!order?.order_id) throw new Error('Không tìm thấy đơn hàng.');
    this.upsertOrder(mapOrder(order, false, null));
  }

  /** Loads a cold-linked order into the shared presentation state. */
  async ensureOrderLoaded(id: string): Promise<void> {
    if (this.orders().some((row) => row.id === id || row.orderId === id)) return;
    const context = this.context();
    if (!context.userId) { await this.lookupGuest(id, this.verifiedPhone()); return; }
    const data = await firstValueFrom(this.api.get<ApiOrder>(`/api/user/orders/${encodeURIComponent(id)}`));
    if (!this.current(context)) return;
    if (!data?.order_id) return;
    this.upsertOrder(mapOrder(data, true, context.userId));
  }

  /** Load an existing payment order with server ownership checks, including a scoped checkout proof. */
  async loadPaymentOrder(id: string, scopedGuestToken?: string): Promise<DemoOrder> {
    const context = this.context();
    const token = context.guestToken || scopedGuestToken || '';
    if (!context.userId && !token) throw new Error('Vui lòng xác thực chủ đơn trước khi tiếp tục thanh toán.');
    const data = context.userId
      ? await firstValueFrom(this.api.get<ApiOrder>(`/api/user/orders/${encodeURIComponent(id)}`))
      : (await firstValueFrom(this.api.get<{ order?: ApiOrder }>(`/api/user/orders/track?code=${encodeURIComponent(id)}&guest_access_token=${encodeURIComponent(token)}`))).order;
    this.assertCurrent(context);
    if (!data?.order_id) throw new Error('Không tìm thấy đơn hàng cần thanh toán.');
    return mapOrder(data, !!context.userId, context.userId);
  }

  /** Cancels an owned order with its current optimistic-concurrency version. */
  async cancel(orderId: string, reason: string): Promise<void> {
    const order = this.orders().find((row) => row.id === orderId);
    if (!order) throw new Error('Không tìm thấy đơn hàng.');
    if (!this.canAccess(order)) throw new Error('Vui lòng xác thực chủ đơn trước.');
    const context = this.context();
    if (context.userId) {
      if (!order.expectedVersion) throw new Error('Dữ liệu đơn chưa sẵn sàng, vui lòng tải lại.');
      await firstValueFrom(
        this.api.patch('/api/user/orders', {
          order_id: order.orderId,
          status: 'cancelled',
          cancelled_reason: reason,
          expectedVersion: order.expectedVersion,
        }),
      );
    } else {
      await firstValueFrom(
        this.api.patch('/api/user/orders/track', {
          order_code: order.id,
          guest_access_token: context.guestToken,
          reason,
        }),
      );
    }
    this.assertCurrent(context);
    await this.refreshOrder(orderId, context);
  }

  /** Uploads mandatory private initial images/video and submits the selected original-unit quantity. */
  async createReturn(
    orderId: string,
    kind: DemoReturn['kind'],
    items: DemoReturnLine[],
    reason: string,
    evidence: Array<{ name: string; file?: File }>,
    reasonCode?: ReturnReasonCode,
    bank?: RefundBankDetails,
  ): Promise<DemoReturn> {
    const order = this.orders().find((row) => row.id === orderId);
    if (!order) throw new Error('Không tìm thấy đơn hàng.');
    if (!this.canAccess(order)) throw new Error('Vui lòng xác thực chủ đơn trước.');
    const context = this.context();
    if (items.some((item) => {
      const line = order.items.find((row) => row.variant_id === item.variantId);
      return !line || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > line.availableQuantity;
    })) throw new Error('Số lượng vượt quá số lượng còn khả dụng đổi/trả.');
    if (kind === 'refund' && items.some((item) => {
      const line = order.items.find((row) => row.variant_id === item.variantId);
      return line?.is_combo && item.quantity < line.quantity;
    })) {
      throw new Error('Sản phẩm Combo phải hoàn trả nguyên bộ, không tách lẻ số lượng.');
    }
    if (kind === 'exchange' && items.some((item) => {
      const line = order.items.find((row) => row.variant_id === item.variantId);
      if (line?.is_combo) {
        return !item.replacement && !item.comboReplacements;
      }
      const choice = line && this.replacementChoices(line).find((row) => row.id === item.replacementVariantId);
      return !choice || (choice.stock ?? 0) < item.quantity;
    })) throw new Error('Vui lòng chọn variant cùng sản phẩm còn đủ số lượng để đổi.');
    const evidenceFiles = evidence.map((item) => item.file).filter((file): file is File => !!file);
    if (!reason.trim() && !reasonCode) throw new Error('Vui lòng nhập lý do đổi/trả.');
    if (!evidenceFiles.some((file) => file.type.startsWith('image/')) || !evidenceFiles.some((file) => file.type.startsWith('video/'))) {
      throw new Error('Cần ít nhất một ảnh và một video ban đầu.');
    }
    const uploaded = await this.uploadEvidence(evidenceFiles, order.orderId || '');
    this.assertCurrent(context);
    const exchangeNote = kind === 'exchange'
      ? items
          .filter((item) => item.replacement)
          .map((item) => `${this.describeLine(order, item.variantId)} → ${item.replacement}`)
          .join('; ')
      : '';
    const description = [reason, exchangeNote].filter(Boolean).join('. ') || undefined;
    const body = {
      return_type: kind,
      reason_code: reasonCode,
      ...(bank ? {
        refund_bank_name: bank.bankName,
        refund_bank_account: bank.accountNumber,
        refund_bank_holder: bank.accountHolder,
      } : {}),
      description,
      evidence_images: uploaded.images,
      evidence_videos: uploaded.videos,
      items: items.map((item) => ({
        order_item_id: this.orderItemIdFor(order, item.variantId),
        quantity: item.quantity,
        ...(kind === 'exchange' && item.replacementVariantId ? { replacement_variant_id: item.replacementVariantId } : {}),
        ...(item.comboReplacements && item.replacement ? { replacement_text: item.replacement } : {}),
      })),
    };
    const data = context.userId
      ? await firstValueFrom(
          this.api.post<{ success?: boolean; return?: ApiReturn }>('/api/user/returns', {
            ...body,
            order_id: order.orderId,
          }),
        )
      : await firstValueFrom(
          this.api.post<{ success?: boolean; return?: ApiReturn }>('/api/user/returns/guest', {
            ...body,
            order_code: order.id,
            guest_access_token: context.guestToken,
          }),
        );
    this.assertCurrent(context);
    if (!data.success || !data.return?.return_id) throw new Error('Chưa ghi nhận được yêu cầu đổi trả. Vui lòng thử lại.');
    const created = { ...mapReturn(data.return), orderId: order.id };
    this.requests.update((rows) => [created, ...rows]);
    void this.refresh();
    return created;
  }

  /** Cancels an unshipped return request with its current optimistic-concurrency version. */
  async cancelRequest(id: string): Promise<void> {
    const request = this.requests().find((row) => row.id === id);
    if (!request) throw new Error('Không tìm thấy yêu cầu đổi/trả.');
    if (!request.status || !['REQUESTED', 'CONTACTING', 'WAITING_RETURN'].includes(request.status)) throw new Error('Yêu cầu đã chuyển sang xử lý hàng, không thể tự hủy.');
    const order = this.orders().find((row) => row.id === request.orderId);
    if (!order || !this.canAccess(order)) throw new Error('Vui lòng xác thực chủ đơn trước.');
    const context = this.context();
    if (!request.expectedVersion) {
      throw new Error('Dữ liệu yêu cầu chưa sẵn sàng, vui lòng tải lại.');
    }
    await firstValueFrom(
      this.api.post(context.userId ? '/api/user/returns/cancel' : '/api/user/returns/guest-cancel', {
        return_id: request.returnId,
        expectedVersion: request.expectedVersion,
        ...(context.userId ? {} : { guest_access_token: context.guestToken }),
      }),
    );
    this.assertCurrent(context);
    await this.refresh();
  }

  /**
   * Saves the COD refund receiving account through the member or verified-guest endpoint, then reloads
   * the requests so the server-computed `refundReceiver` state replaces the local one.
   */
  async saveBank(id: string, name: string, account: string, holder: string): Promise<void> {
    const request = this.requests().find((row) => row.id === id);
    if (!request?.returnId) throw new Error('Không tìm thấy yêu cầu đổi/trả.');
    const order = this.orders().find((row) => row.id === request.orderId);
    if (!order || !this.canAccess(order)) throw new Error('Vui lòng xác thực chủ đơn trước.');
    const receiver = validateRefundReceiver(name, account, holder);
    const context = this.context();
    const response = await firstValueFrom(
      this.api.post<{ success?: boolean; message?: string }>(
        context.userId ? '/api/user/returns/refund-receiver' : '/api/user/returns/guest-refund-receiver',
        {
          return_id: request.returnId,
          ...(context.userId ? {} : { guest_access_token: context.guestToken }),
          bank_name: receiver.bankName,
          account_number: receiver.accountNumber,
          account_holder: receiver.accountHolder,
        },
      ),
    );
    this.assertCurrent(context);
    if (!response.success) throw new Error(response.message || 'Chưa lưu được thông tin nhận hoàn tiền. Vui lòng thử lại.');
    await this.refresh();
  }

  /**
   * Loads the real return detail: carrier shipment, pickup evidence, packing evidence, timeline
   * and the linked replacement order. Member and verified-guest paths use their own endpoint.
   */
  async getReturnTracking(returnId: string): Promise<ReturnTrackingDetail> {
    const context = this.context();
    const path = context.userId
      ? `/api/user/returns/${encodeURIComponent(returnId)}`
      : `/api/user/returns/guest/${encodeURIComponent(returnId)}?guest_access_token=${encodeURIComponent(context.guestToken)}`;
    const data = await firstValueFrom(this.api.get<{ return?: ApiReturnDetail }>(path));
    this.assertCurrent(context);
    if (!data.return?.return_id) throw new Error('Không tải được thông tin theo dõi hoàn trả.');
    return mapReturnTracking(data.return);
  }

  /**
   * Uploads one packing photo/video to the private evidence bucket; the API returns a signed
   * URL for immediate display while the stored file keeps its private coordinates.
   */
  async uploadReturnEvidence(
    returnId: string,
    file: File,
    kind: 'packing_photo' | 'packing_video',
    note = '',
  ): Promise<ReturnTrackingEvidence> {
    const context = this.context();
    const params = new URLSearchParams({ kind });
    if (note) params.set('note', note);
    if (!context.userId) params.set('guest_access_token', context.guestToken);
    const path = context.userId
      ? `/api/user/returns/${encodeURIComponent(returnId)}/evidence`
      : `/api/user/returns/guest/${encodeURIComponent(returnId)}/evidence`;
    const form = new FormData();
    form.append('file', file, file.name);
    const data = await firstValueFrom(this.api.post<{ evidence?: ApiReturnEvidence }>(`${path}?${params.toString()}`, form));
    this.assertCurrent(context);
    if (!data.evidence) throw new Error('Chưa lưu được bằng chứng đóng gói.');
    return mapTrackingEvidence(data.evidence);
  }

  /** Directs unavailable replacement choices to CSKH because no real mutation exists yet. */
  async replaceUnavailable(): Promise<void> {
    throw new Error('Vui lòng liên hệ CSKH để chọn variant thay thế.');
  }

  /** Compatibility labels reflect real choices only; no fabricated alternative sizes or colors. */
  replacements(line: DemoOrderLine): string[] {
    return this.replacementChoices(line).map((choice) => choice.label);
  }

  /** Read current same-product inventory before presenting exchange choices. */
  async loadReplacementChoices(orderId: string): Promise<void> {
    const order = this.orders().find((row) => row.id === orderId);
    if (!order || !this.canAccess(order)) throw new Error('Vui lòng xác thực chủ đơn trước.');
    const context = this.context();
    const version = ++this.replacementVersion;
    this.replacementsLoading.set(true);
    this.replacementsError.set('');
    this.replacementByProduct.set({});
    this.comboComponentsByProduct.set({});
    try {
      const ids = [...new Set(order.items.map((line) => line.product_id).filter(Boolean))];
      const products = await Promise.all(ids.map(async (id) => {
        const product = await firstValueFrom(this.api.get<ProductSummary>(`/api/user/products/${encodeURIComponent(id)}`));
        if (product.product_id !== id) throw new Error('Dữ liệu sản phẩm đổi hàng không khớp.');
        return product;
      }));
      this.assertCurrent(context);
      if (version !== this.replacementVersion) return;
      this.replacementByProduct.set(Object.fromEntries(products.map((product) => [product.product_id, (product.variants || [])
        .filter((variant) => (variant.stock_quantity || 0) > 0)
        .map((variant) => ({ id: variant.variant_id, label: [variant.size, variant.color].filter(Boolean).join(' / '), stock: variant.stock_quantity }))])));
      const comboMap: Record<string, ComboComponentItem[]> = {};
      for (const product of products) {
        if (product.is_combo && product.combo_components?.length) {
          comboMap[product.product_id] = product.combo_components.map((comp) => ({
            productId: comp.product_id,
            name: comp.name,
            quantity: comp.quantity || 1,
            choices: (comp.variants || [])
              .filter((v) => (v.stock_quantity || 0) > 0)
              .map((v) => ({
                id: v.variant_id,
                label: [v.size, v.color].filter(Boolean).join(' / '),
                stock: v.stock_quantity,
              })),
          }));
        }
      }
      this.comboComponentsByProduct.set(comboMap);
    } catch (error) {
      if (this.current(context) && version === this.replacementVersion) this.replacementsError.set(orderAccountErrorMessage(error));
    } finally { if (this.current(context) && version === this.replacementVersion) this.replacementsLoading.set(false); }
  }

  /** Exclude the original variant and unavailable inventory without inferring substitutes. */
  replacementChoices(line: DemoOrderLine): ReplacementChoice[] {
    return (this.replacementByProduct()[line.product_id] || []).filter((choice) => choice.id !== line.variant_id);
  }

  /** Present components with choices for combo lines. */
  comboComponents(line: DemoOrderLine): ComboComponentItem[] {
    const fromMap = this.comboComponentsByProduct()[line.product_id];
    if (fromMap && fromMap.length > 0) return fromMap;

    if (line.sub_items?.length) {
      return line.sub_items.map((sub) => ({
        productId: sub.product_id,
        name: sub.product_name,
        quantity: sub.quantity || 1,
        originalSize: sub.size,
        originalColor: sub.color,
        choices: (sub.available_variants || [])
          .filter((v) => (v.stock_quantity || 0) > 0)
          .map((v) => ({
            id: v.variant_id,
            label: [v.size, v.color].filter(Boolean).join(' / '),
            stock: v.stock_quantity,
          })),
      }));
    }

    return [];
  }

  /** Present the canonical refund or exchange branch after the common receipt workflow. */
  timeline(kind: DemoReturn['kind']): string[] {
    return returnStates(kind).map((state) => RETURN_WORKFLOW_LABELS[state]);
  }

  private async loadOrders(context: OrderContext, version: number): Promise<void> {
    const path = context.userId ? '/api/user/orders' : `/api/user/orders/guest?guest_access_token=${encodeURIComponent(context.guestToken)}`;
    const data = await firstValueFrom(this.api.get<{ orders?: ApiOrder[] }>(path));
    if (this.current(context) && version === this.refreshVersion) {
      this.orders.set((data.orders || []).map((order) => mapOrder(order, !!context.userId, context.userId)));
    }
  }

  private async loadReturns(context: OrderContext, version: number): Promise<void> {
    const responses = context.userId
      ? [await firstValueFrom(this.api.get<{ returns?: ApiReturn[] }>('/api/user/returns'))]
      : await Promise.all(this.orders().filter((row) => row.orderId).map((order) => firstValueFrom(
          this.api.get<{ returns?: ApiReturn[] }>(`/api/user/returns/guest?order_id=${encodeURIComponent(order.orderId!)}&guest_access_token=${encodeURIComponent(context.guestToken)}`),
        )));
    if (this.current(context) && version === this.refreshVersion) {
      const rows = responses.flatMap((data) => data.returns || []);
      const mappedReturns = rows.map((row) => {
        const mapped = mapReturn(row);
        return { ...mapped, orderId: this.orders().find((order) => order.orderId === row.order_id)?.id || mapped.orderId };
      });
      this.requests.set(mappedReturns);
    }
  }

  private async refreshOrder(id: string, context: OrderContext): Promise<void> {
    const data = context.userId
      ? await firstValueFrom(this.api.get<ApiOrder>(`/api/user/orders/${encodeURIComponent(id)}`))
      : (await firstValueFrom(this.api.get<{ order?: ApiOrder }>(`/api/user/orders/track?code=${encodeURIComponent(id)}&guest_access_token=${encodeURIComponent(context.guestToken)}`))).order;
    if (this.current(context) && data?.order_id) this.upsertOrder(mapOrder(data, !!context.userId, context.userId));
  }

  private context(): OrderContext { return { generation: this.generation, userId: this.userId(), session: this.auth.session(), guestToken: this.member() ? '' : this.guestToken() }; }

  /** Forward the verified guest session to an owned unpaid order's payment action. */
  guestAccessToken(): string { return this.member() ? '' : this.guestToken(); }

  private current(context: OrderContext): boolean {
    return context.generation === this.generation && context.userId === this.userId() && context.session === this.auth.session()
      && (context.userId !== null || context.guestToken === this.guestToken());
  }

  private assertCurrent(context: OrderContext): void {
    if (!this.current(context)) throw new Error('Phiên xác thực đã thay đổi. Vui lòng mở lại đơn hàng.');
  }

  private guestToken(): string {
    if (this.guestProof && this.guestProof.expiresAt <= Date.now()) this.clearGuestSession();
    return this.guestProof?.token || '';
  }

  private clearGuestSession(): void {
    this.generation++;
    clearTimeout(this.expiryTimer);
    this.guestProof = null;
    this.challenge = null;
    this.verifiedPhone.set('');
    this.orders.set([]);
    this.requests.set([]);
    sessionStorage.removeItem('guest_order_session');
    this.loading.set(false);
  }

  private scheduleExpiry(): void {
    clearTimeout(this.expiryTimer);
    if (this.guestProof) this.expiryTimer = setTimeout(() => this.clearGuestSession(), Math.max(0, this.guestProof.expiresAt - Date.now()));
  }

  private readGuestProof(): GuestProof | null {
    try {
      const proof = JSON.parse(sessionStorage.getItem('guest_order_session') || 'null') as GuestProof | null;
      if (proof && typeof proof.token === 'string' && typeof proof.phone === 'string' && Number.isFinite(proof.expiresAt)
        && proof.expiresAt > Date.now() && proof.expiresAt <= Date.now() + 15 * 60 * 1000) return proof;
    } catch { /* Invalid persisted data cannot authorize a guest. */ }
    sessionStorage.removeItem('guest_order_session');
    return null;
  }

  private upsertOrder(order: DemoOrder): void {
    this.orders.update((rows) => {
      const next = rows.filter((row) => row.id !== order.id);
      return [order, ...next];
    });
  }

  private orderItemIdFor(order: DemoOrder, variantId: string): string | undefined {
    return order.items.find((item) => item.variant_id === variantId)?.itemId;
  }

  private describeLine(order: DemoOrder, variantId: string): string {
    const line = order.items.find((item) => item.variant_id === variantId);
    return line ? `${line.product_name} (${line.size}/${line.color})` : variantId;
  }

  private async uploadEvidence(files: File[], orderId: string): Promise<{ images: string[]; videos: string[] }> {
    const context = this.context();
    const uploaded: { images: string[]; videos: string[] } = { images: [], videos: [] };
    for (const file of files) {
      this.assertCurrent(context);
      const video = file.type.startsWith('video/');
      const params = new URLSearchParams({ purpose: 'return', order_id: orderId, kind: video ? 'request_video' : 'request_photo' });
      if (!context.userId) params.set('guest_access_token', context.guestToken);
      const formData = new FormData();
      formData.append('file', file, file.name);
      const result = await firstValueFrom(this.api.post<{ storage_ref?: string }>(`/api/user/upload/evidence?${params}`, formData));
      this.assertCurrent(context);
      if (!result.storage_ref) throw new Error('Chưa tải được bằng chứng riêng tư.');
      (video ? uploaded.videos : uploaded.images).push(result.storage_ref);
    }
    return uploaded;
  }
}

/** Narrows a thrown value to a readable message, matching the other pages' error handlers. */
export function orderAccountErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Có lỗi xảy ra, vui lòng thử lại.';
}
