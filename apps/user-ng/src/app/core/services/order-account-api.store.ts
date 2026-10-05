import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { ApiRequestError } from '../models/api-request-error';
import {
  DemoOrder,
  DemoOrderLine,
  DemoOrderStatus,
  DemoReturn,
  DemoReturnLine,
  RETURN_WORKFLOW_LABELS,
  ReturnWorkflowStatus,
} from './purchase-demo.store';
import type { ComboComponentItem, OrderAccountModel, ReplacementChoice, ReturnReasonCode } from './order-account.model';
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
  version?: number;
  cancelled_reason?: string | null;
  items?: ApiOrderItem[];
}

interface ApiReturnItem {
  order_item_id?: string;
  variant_id?: string | null;
  quantity?: number;
}

interface ApiReturn {
  refund_amount?: number;
  return_id?: string;
  tracking_return_code?: string;
  order_id?: string;
  order_code?: string;
  return_type?: 'refund' | 'exchange';
  description?: string | null;
  evidence_images?: string[] | null;
  status?: string;
  rejection_reason?: string | null;
  created_at?: string;
  resolved_at?: string | null;
  version?: number;
  items?: ApiReturnItem[];
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

function mapOrderItem(item: ApiOrderItem): DemoOrderLine {
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
    inProgressCode: item.in_progress_return_code || undefined,
    inProgressStatus: item.in_progress_status || undefined,
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
  return { variantId: item.variant_id || '', quantity: item.quantity || 0 };
}

function mapReturn(row: ApiReturn): DemoReturn {
  const status = row.status && row.status in RETURN_WORKFLOW_LABELS ? row.status as ReturnWorkflowStatus : 'NEEDS_SUPPORT';
  const kind = row.return_type || 'refund';
  return {
    id: row.tracking_return_code || row.return_id || '',
    returnId: row.return_id,
    expectedVersion: row.version,
    orderId: row.order_code || row.order_id || '',
    kind,
    items: (row.items || []).map(mapReturnItem),
    reason: row.description || '',
    evidenceNames: row.evidence_images || [],
    stage: returnStates(kind).indexOf(status),
    status,
    refundAmount: typeof row.refund_amount === 'number' && Number.isFinite(row.refund_amount) ? row.refund_amount : undefined,
    createdAt: row.created_at || new Date().toISOString(),
    completedAt: ['REFUNDED', 'COMPLETED'].includes(status) ? row.resolved_at || undefined : undefined,
    cancelledAt: status === 'CANCELLED' ? row.resolved_at || row.created_at || undefined : undefined,
    rejectionReason: status === 'NEEDS_SUPPORT' ? row.rejection_reason || undefined : undefined,
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
  readonly supportsBankInfo = false;
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
    const response = await firstValueFrom(this.api.post<{ success?: boolean; message?: string; masked_email?: string }>('/api/user/orders/track-otp-send', challenge));
    this.assertCurrent(context);
    if (!response.success) throw new Error(response.message || 'Chưa gửi được mã xác thực.');
    this.maskedEmail.set(response.masked_email || '');
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

  /** Uploads optional evidence and creates a real return request for selected order lines. */
  async createReturn(
    orderId: string,
    kind: DemoReturn['kind'],
    items: DemoReturnLine[],
    reason: string,
    evidence: Array<{ name: string; file?: File }>,
    reasonCode?: ReturnReasonCode,
  ): Promise<DemoReturn> {
    const order = this.orders().find((row) => row.id === orderId);
    if (!order) throw new Error('Không tìm thấy đơn hàng.');
    if (!this.canAccess(order)) throw new Error('Vui lòng xác thực chủ đơn trước.');
    const context = this.context();
    if (items.some((item) => {
      const line = order.items.find((row) => row.variant_id === item.variantId);
      return line?.isInProgress;
    })) {
      throw new Error('Sản phẩm đã chọn đang có yêu cầu đổi/trả đang xử lý. Vui lòng chờ hoàn tất.');
    }
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
    const evidenceUrls = await this.uploadEvidence(evidenceFiles);
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
      description,
      evidence_images: evidenceUrls,
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
    const created = { ...mapReturn(data.return || {}), orderId: order.id, items: items.map((item) => ({ ...item })) };
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

  /** Rejects unsupported COD bank capture rather than pretending sensitive data was persisted. */
  async saveBank(): Promise<void> {
    throw new Error('Chưa hỗ trợ lưu thông tin nhận hoàn tiền trực tuyến — CSKH sẽ liên hệ để thu thập.');
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
    if (this.current(context) && version === this.refreshVersion) this.orders.set((data.orders || []).map((order) => mapOrder(order, !!context.userId, context.userId)));
  }

  private async loadReturns(context: OrderContext, version: number): Promise<void> {
    const responses = context.userId
      ? [await firstValueFrom(this.api.get<{ returns?: ApiReturn[] }>('/api/user/returns'))]
      : await Promise.all(this.orders().filter((row) => row.orderId).map((order) => firstValueFrom(
          this.api.get<{ returns?: ApiReturn[] }>(`/api/user/returns/guest?order_id=${encodeURIComponent(order.orderId!)}&guest_access_token=${encodeURIComponent(context.guestToken)}`),
        )));
    if (this.current(context) && version === this.refreshVersion) {
      const rows = responses.flatMap((data) => data.returns || []);
      this.requests.set(rows.map((row) => {
        const mapped = mapReturn(row);
        return { ...mapped, orderId: this.orders().find((order) => order.orderId === row.order_id)?.id || mapped.orderId };
      }));
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

  private async uploadEvidence(files: File[]): Promise<string[]> {
    const context = this.context();
    const urls: string[] = [];
    for (const file of files) {
      this.assertCurrent(context);
      const formData = new FormData();
      formData.append('file', file);
      const result = await firstValueFrom(
        this.api.post<{ success?: boolean; url?: string }>('/api/user/upload/evidence', formData),
      );
      this.assertCurrent(context);
      if (result?.url) urls.push(result.url);
    }
    return urls;
  }
}

/** Narrows a thrown value to a readable message, matching the other pages' error handlers. */
export function orderAccountErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Có lỗi xảy ra, vui lòng thử lại.';
}
