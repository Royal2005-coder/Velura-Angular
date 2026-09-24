import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { formatVnd } from '../../core/utils/money';
import { useBodyClass } from '../../core/utils/body-class';
import { environment } from '../../../environments/environment';
import { customerCanCancel, orderStatusLabel } from './order-status';

interface MemberOrderDetail {
  order_id?: string;
  order_code?: string;
  tracking_code?: string;
  status?: string;
  created_at?: string;
  payment_method?: string;
  subtotal?: number;
  shipping_fee?: number;
  discount_amount?: number;
  total_amount?: number;
  confirmed_at?: string;
  preparing_at?: string;
  shipping_at?: string;
  delivered_at?: string;
  cancelled_at?: string;
  cancelled_reason?: string;
  items?: MemberOrderDetailItem[];
}

interface MemberOrderDetailItem {
  product_name?: string;
  product_image?: string;
  quantity?: number;
  unit_price?: number;
  variant_name?: string;
}

interface OrderTimelineStep {
  key: string;
  label: string;
  time?: string;
  state: 'completed' | 'active' | 'pending' | 'failed';
  reason?: string;
}

@Component({
  selector: 'app-account-order-detail-page',
  imports: [DatePipe, RouterLink],
  host: { class: 'page-order-detail' },
  templateUrl: './order-detail.page.html',
})
export class AccountOrderDetailPage {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly order = signal<MemberOrderDetail | null>(null);
  readonly cancelOpen = signal(false);
  readonly cancelReason = signal('Thay đổi ý định');
  readonly cancelOther = signal('');
  readonly cancelling = signal(false);
  readonly cancelError = signal<string | null>(null);

  readonly statusLabel = computed(() => orderStatusLabel(this.order()?.status));
  readonly statusClass = computed(() => {
    const status = (this.order()?.status || '').toLowerCase();
    if (['delivered', 'completed'].includes(status)) return 'detail-status-badge--delivered';
    if (['cancelled', 'canceled', 'failed_delivery', 'delivery_failed'].includes(status)) return 'detail-status-badge--cancelled';
    if (['shipping', 'delivering', 'in_transit'].includes(status)) return 'detail-status-badge--shipping';
    return 'detail-status-badge--pending';
  });
  readonly canCancel = computed(() => customerCanCancel(this.order()?.status));
  readonly isCompleted = computed(() => {
    const status = (this.order()?.status || '').toLowerCase();
    return ['delivered', 'completed', 'success', 'done'].some((s) => status.includes(s));
  });
  readonly timeline = computed<OrderTimelineStep[]>(() => {
    const order = this.order();
    const status = order?.status || 'pending';
    const time = (value?: string): string | undefined => value;
    const created = { key: 'created', label: 'Đặt hàng thành công', time: time(order?.created_at) };
    const confirmed = { key: 'confirmed', label: 'Đã xác nhận', time: time(order?.confirmed_at) };
    const preparing = { key: 'preparing', label: 'Đang chuẩn bị hàng', time: time(order?.preparing_at) };
    const shipping = { key: 'shipping', label: 'Đang giao hàng', time: time(order?.shipping_at) };
    const delivered = { key: 'delivered', label: 'Giao thành công', time: time(order?.delivered_at) };

    if (status === 'cancelled' || status === 'canceled') {
      return [
        { ...created, state: 'completed' },
        ...(order?.confirmed_at ? [{ ...confirmed, state: 'completed' as const }] : []),
        {
          key: 'cancelled',
          label: 'Đã hủy',
          time: time(order?.cancelled_at),
          state: 'failed',
          reason: order?.cancelled_reason,
        },
      ];
    }

    if (status === 'delivered' || status === 'completed') {
      return [
        { ...created, state: 'completed' },
        { ...confirmed, state: 'completed' },
        { ...preparing, state: 'completed' },
        { ...shipping, state: 'completed' },
        { ...delivered, state: 'active' },
      ];
    }

    const steps = [created, confirmed, preparing, shipping, delivered];
    const activeKey = status === 'waiting_payment' ? 'confirmed' : status === 'processing' ? 'preparing' : status;
    const activeIndex = Math.max(0, steps.findIndex((step) => step.key === activeKey));
    return steps.map((step, index) => ({
      ...step,
      time: index <= activeIndex ? step.time : undefined,
      state: index < activeIndex ? 'completed' : index === activeIndex ? 'active' : 'pending',
    }));
  });
  readonly codeLabel = computed(() => {
    const order = this.order();
    return order?.tracking_code || order?.order_id || '—';
  });
  readonly dateLabel = computed(() => {
    const value = this.order()?.created_at;
    if (!value) {
      return 'Ngày đặt: —';
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return 'Ngày đặt: —';
    }
    const formatted = new Intl.DateTimeFormat('vi-VN', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'Asia/Ho_Chi_Minh',
    }).format(date);
    return `Ngày đặt: ${formatted}`;
  });

  constructor() {
    useBodyClass('page-order-detail');
    const id = this.route.snapshot.paramMap.get('id') || 'ord-101';
    this.api
      .get<MemberOrderDetail>(`/api/user/orders/${id}`)
      .pipe(catchError(() => of(null)))
      .subscribe((order) => {
        this.loading.set(false);
        if (order && (order.order_id || order.status)) {
          this.order.set(order);
        } else if (environment.mockAuth) {
          this.order.set(this.createMockOrder(id));
        } else {
          this.loadError.set('Không tìm thấy thông tin đơn hàng.');
        }
      });
  }

  /**
   * Opens the cancel dialog. Hidden once the parcel is with the carrier.
   */
  openCancel(): void {
    if (!this.canCancel()) {
      return;
    }
    this.cancelError.set(null);
    this.cancelOpen.set(true);
  }

  /**
   * Closes the cancel dialog without changing the order.
   */
  closeCancel(): void {
    if (this.cancelling()) {
      return;
    }
    this.cancelOpen.set(false);
  }

  /**
   * Reads the reason select. "Khác" asks for a free-text reason.
   */
  setCancelReason(event: Event): void {
    this.cancelReason.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Reads the free-text reason used when the buyer picks "Khác".
   */
  setCancelOther(event: Event): void {
    this.cancelOther.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Cancels the order through the same PATCH the API already allows before shipping.
   */
  submitCancel(): void {
    const order = this.order();
    const reason = this.cancelReason() === 'Khác' ? this.cancelOther().trim() : this.cancelReason().trim();
    if (!order?.order_id || !this.canCancel() || this.cancelling()) {
      return;
    }
    if (reason.length < 3) {
      this.cancelError.set('Nhập lý do hủy.');
      return;
    }
    this.cancelling.set(true);
    this.cancelError.set(null);
    this.api
      .patch<{ status?: string }>('/api/user/orders', {
        order_id: order.order_id,
        status: 'cancelled',
        cancelled_reason: reason,
      })
      .subscribe({
        next: () => {
          this.cancelling.set(false);
          this.cancelOpen.set(false);
          this.order.set({ ...order, status: 'cancelled' });
        },
        error: (error: Error) => {
          this.cancelling.set(false);
          this.cancelError.set(error.message || 'Không hủy được đơn.');
        },
      });
  }

  /**
   * Formats a money field from the order row.
   */
  money(value: number | undefined): string {
    return formatVnd(value) || '0₫';
  }

  /**
   * Whether this stored status still lets the buyer cancel. Exposed for the page spec.
   */
  allowsCancel(status: string | undefined): boolean {
    return customerCanCancel(status);
  }

  private createMockOrder(id: string): MemberOrderDetail {
    const base = {
      order_id: id,
      payment_method: 'Thanh toán COD',
      subtotal: 599000,
      shipping_fee: 30000,
      discount_amount: 30000,
      total_amount: 599000,
      created_at: '2026-09-20T09:15:00Z',
      confirmed_at: '2026-09-20T10:20:00Z',
      preparing_at: '2026-09-20T14:30:00Z',
      shipping_at: '2026-09-21T08:15:00Z',
      items: [
        { product_name: 'Áo sơ mi linen trắng Velura', product_image: '/assets/images/about_01.jpg', quantity: 2, unit_price: 284500 },
        { product_name: 'Quần suông ống rộng màu be', product_image: '/assets/images/about_02.jpg', quantity: 1, unit_price: 300000 },
      ],
    };

    if (id === 'ord-103') {
      return { ...base, order_code: 'CM555888', tracking_code: 'VTP-771239', status: 'completed', delivered_at: '2026-09-22T15:45:00Z' };
    }
    if (id === 'ord-104') {
      return { ...base, order_code: 'CM333222', tracking_code: undefined, status: 'cancelled', cancelled_at: '2026-09-20T11:00:00Z', cancelled_reason: 'Khách hàng thay đổi ý định.' };
    }
    if (id === 'ord-102') {
      return { ...base, order_code: 'CM987654', tracking_code: 'GHN-89218492', status: 'pending', created_at: '2026-09-22T14:15:00Z', confirmed_at: undefined, preparing_at: undefined, shipping_at: undefined };
    }
    return { ...base, order_code: 'CM123456', tracking_code: 'VN18492048291', status: 'shipping' };
  }
}
