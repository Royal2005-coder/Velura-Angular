import { Injectable, computed, inject, signal } from '@angular/core';
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
} from './purchase-demo.store';
import type { OrderAccountModel } from './order-account.model';

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

/** `return_exchange.status` → the stage index into `timeline()` below (5 customer-facing stages). */
const RETURN_STAGE_MAP: Record<string, number> = {
  pending: 0,
  approved: 1,
  shipping_back: 2,
  received: 3,
  completed: 4,
};

/** The real `return_exchange` row written when a customer cancels before shipping (U2-24). */
const SELF_CANCEL_REASON = 'Đã hủy bởi khách hàng';

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
    payment: order.payment_method === 'COD' ? 'COD' : 'VNPAY',
    paymentState: order.status === 'cancelled' ? 'cancelled' : 'paid',
    subtotal: order.subtotal || 0,
    shipping: order.shipping_fee || 0,
    discount: order.discount_amount || 0,
    total: order.total_amount || 0,
    voucher: '',
    createdAt: order.created_at || new Date().toISOString(),
    deliveredAt: order.delivered_at || undefined,
    refund: order.status === 'cancelled' && order.payment_method !== 'COD' ? 'pending' : undefined,
    cancellationReason: order.cancelled_reason || undefined,
  };
}

function mapReturnItem(item: ApiReturnItem): DemoReturnLine {
  return { variantId: item.variant_id || '', quantity: item.quantity || 0 };
}

function mapReturn(row: ApiReturn): DemoReturn {
  const status = row.status || 'pending';
  const selfCancelled = status === 'rejected' && row.rejection_reason === SELF_CANCEL_REASON;
  const cskhRejected = status === 'rejected' && !selfCancelled;
  return {
    id: row.tracking_return_code || row.return_id || '',
    returnId: row.return_id,
    expectedVersion: row.version,
    orderId: row.order_code || row.order_id || '',
    kind: row.return_type || 'refund',
    items: (row.items || []).map(mapReturnItem),
    reason: row.description || '',
    evidenceNames: row.evidence_images || [],
    stage: RETURN_STAGE_MAP[status] ?? 0,
    createdAt: row.created_at || new Date().toISOString(),
    completedAt: status === 'completed' ? row.resolved_at || undefined : undefined,
    cancelledAt: selfCancelled ? row.resolved_at || undefined : undefined,
    rejectedAt: cskhRejected ? row.resolved_at || undefined : undefined,
    rejectionReason: cskhRejected ? row.rejection_reason || undefined : undefined,
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

  readonly member = computed(() => this.auth.isLoggedIn());
  readonly userId = computed(() => this.auth.session()?.userId || null);
  readonly verifiedPhone = signal('');
  readonly orders = signal<DemoOrder[]>([]);
  readonly requests = signal<DemoReturn[]>([]);
  readonly cancellableBeforeStage = 2;
  readonly supportsBankInfo = false;

  constructor() {
    if (this.member()) {
      void this.loadOrders();
      void this.loadReturns();
    }
  }

  /** Confirms that the current member or verified guest owns the presented order. */
  canAccess(order: DemoOrder): boolean {
    if (this.member()) return order.userId === this.userId();
    return !order.member && !!this.verifiedPhone();
  }

  /** No OTP endpoint exists for order lookup — real guest access goes through `lookupGuest`. */
  async sendOtp(): Promise<void> {
    throw new Error('Guest lookup chỉ cần mã đơn và số điện thoại/email, không cần mã OTP.');
  }

  async verifyOtp(): Promise<void> {
    throw new Error('Guest lookup chỉ cần mã đơn và số điện thoại/email, không cần mã OTP.');
  }

  /** Loads one guest order after the backend validates its code and contact pair. */
  async lookupGuest(code: string, contact: string): Promise<void> {
    const data = await firstValueFrom(
      this.api.get<{ success?: boolean; order?: ApiOrder }>(
        `/api/user/orders/track?code=${encodeURIComponent(code)}&contact=${encodeURIComponent(contact)}`,
      ),
    );
    const order = data.order;
    if (!order?.order_id) throw new Error('Không tìm thấy đơn hàng.');
    this.verifiedPhone.set(contact);
    this.upsertOrder(mapOrder(order, false, null));
  }

  /** Loads a cold-linked order into the shared presentation state. */
  async ensureOrderLoaded(id: string): Promise<void> {
    if (this.orders().some((row) => row.id === id)) return;
    const data = await firstValueFrom(this.api.get<ApiOrder>(`/api/user/orders/${encodeURIComponent(id)}`));
    if (!data?.order_id) return;
    this.upsertOrder(mapOrder(data, this.member(), this.userId()));
  }

  /** Cancels an owned order with its current optimistic-concurrency version. */
  async cancel(orderId: string, reason: string): Promise<void> {
    const order = this.orders().find((row) => row.id === orderId);
    if (!order) throw new Error('Không tìm thấy đơn hàng.');
    if (this.member()) {
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
          contact: this.verifiedPhone(),
          reason,
        }),
      );
    }
    await this.refreshOrder(orderId);
  }

  /** Uploads optional evidence and creates a real return request for selected order lines. */
  async createReturn(
    orderId: string,
    kind: DemoReturn['kind'],
    items: DemoReturnLine[],
    reason: string,
    evidence: Array<{ name: string; file?: File }>,
  ): Promise<DemoReturn> {
    const order = this.orders().find((row) => row.id === orderId);
    if (!order) throw new Error('Không tìm thấy đơn hàng.');
    const evidenceFiles = evidence.map((item) => item.file).filter((file): file is File => !!file);
    const evidenceUrls = await this.uploadEvidence(evidenceFiles);
    const exchangeNote = kind === 'exchange'
      ? items
          .filter((item) => item.replacement)
          .map((item) => `${this.describeLine(order, item.variantId)} → ${item.replacement}`)
          .join('; ')
      : '';
    const description = [reason, exchangeNote].filter(Boolean).join('. ') || undefined;
    const body = {
      return_type: kind,
      description,
      evidence_images: evidenceUrls,
      items: items.map((item) => ({
        order_item_id: this.orderItemIdFor(order, item.variantId),
        quantity: item.quantity,
      })),
    };
    const data = this.member()
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
            contact: this.verifiedPhone(),
          }),
        );
    const created = { ...mapReturn(data.return || {}), orderId: order.id, items: items.map((item) => ({ ...item })) };
    this.requests.update((rows) => [created, ...rows]);
    return created;
  }

  /** Cancels an unshipped return request with its current optimistic-concurrency version. */
  async cancelRequest(id: string): Promise<void> {
    const request = this.requests().find((row) => row.id === id);
    if (!request) throw new Error('Không tìm thấy yêu cầu đổi/trả.');
    if (!request.expectedVersion) {
      throw new Error('Dữ liệu yêu cầu chưa sẵn sàng, vui lòng tải lại.');
    }
    await firstValueFrom(
      this.api.post('/api/user/returns/cancel', {
        return_id: request.returnId,
        expectedVersion: request.expectedVersion,
      }),
    );
    await this.loadReturns();
  }

  /** Rejects unsupported COD bank capture rather than pretending sensitive data was persisted. */
  async saveBank(): Promise<void> {
    throw new Error('Chưa hỗ trợ lưu thông tin nhận hoàn tiền trực tuyến — CSKH sẽ liên hệ để thu thập.');
  }

  /** Directs unavailable replacement choices to CSKH because no real mutation exists yet. */
  async replaceUnavailable(): Promise<void> {
    throw new Error('Vui lòng liên hệ CSKH để chọn variant thay thế.');
  }

  /** Presents the limited replacement wishes that can be recorded in the request description. */
  replacements(line: DemoOrderLine): string[] {
    // Khác sản phẩm khác (not fetched here); the create-return flow trusts the server to
    // reject a variant outside the order's own product rather than pre-filtering client-side.
    return [`${line.size} khác`, `${line.color} khác`].filter(Boolean);
  }

  /** Maps the six persisted return statuses onto customer-facing timeline labels. */
  timeline(kind: DemoReturn['kind']): string[] {
    return [
      'Đã ghi nhận',
      'Đã duyệt yêu cầu',
      'Hàng đang về Velura',
      'Velura đã nhận hàng',
      kind === 'refund' ? 'Đã hoàn tiền' : 'Hoàn tất',
    ];
  }

  private async loadOrders(): Promise<void> {
    const data = await firstValueFrom(this.api.get<{ orders?: ApiOrder[] }>('/api/user/orders'));
    this.orders.set((data.orders || []).map((order) => mapOrder(order, true, this.userId())));
  }

  private async loadReturns(): Promise<void> {
    const data = await firstValueFrom(this.api.get<{ returns?: ApiReturn[] }>('/api/user/returns'));
    this.requests.set((data.returns || []).map(mapReturn));
  }

  private async refreshOrder(id: string): Promise<void> {
    const data = await firstValueFrom(this.api.get<ApiOrder>(`/api/user/orders/${encodeURIComponent(id)}`));
    if (data?.order_id) this.upsertOrder(mapOrder(data, this.member(), this.userId()));
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
    const urls: string[] = [];
    for (const file of files) {
      const formData = new FormData();
      formData.append('file', file);
      const result = await firstValueFrom(
        this.api.post<{ success?: boolean; url?: string }>('/api/user/upload/evidence', formData),
      );
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
