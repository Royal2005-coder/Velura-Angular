import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { formatVnd } from '../../core/utils/money';
import { useBodyClass } from '../../core/utils/body-class';
import { formatOrderTime } from '../../core/utils/order-time';

/** Một mốc trên timeline, do API dựng từ lịch sử trạng thái (KAN-39 FR-08). */
export interface OrderStep {
  status: string;
  label: string;
  at: string | null;
  state: 'done' | 'current' | 'upcoming';
}

interface OrderLine {
  item_id?: string;
  product_name?: string;
  quantity?: number;
  unit_price?: number;
  category_name?: string;
}

/**
 * Đơn như API storefront trả về. Nhãn trạng thái, timeline và các cờ được làm gì đều do
 * API tính từ State Machine; trang này không giữ bảng trạng thái riêng.
 */
export interface MemberOrderDetail {
  order_id?: string;
  order_code?: string;
  status?: string;
  status_label?: string;
  created_at?: string;
  payment_method?: string;
  shipping_name?: string;
  shipping_phone?: string;
  shipping_address?: string;
  subtotal?: number;
  shipping_fee?: number;
  discount_amount?: number;
  total_amount?: number;
  tracking_code?: string | null;
  carrier?: string | null;
  tracking_url?: string | null;
  cancelled_reason?: string | null;
  items?: OrderLine[];
  steps?: OrderStep[];
  can_cancel?: boolean;
  can_pay_again?: boolean;
  pay_again_until?: string | null;
}

@Component({
  selector: 'app-account-order-detail-page',
  imports: [RouterLink],
  host: { class: 'page-order-detail' },
  templateUrl: './order-detail.page.html',
})
export class AccountOrderDetailPage {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly orderRef = this.route.snapshot.paramMap.get('id') || '';

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly order = signal<MemberOrderDetail | null>(null);
  readonly notice = signal<string | null>(null);
  readonly cancelOpen = signal(false);
  readonly cancelReason = signal('Thay đổi ý định');
  readonly cancelOther = signal('');
  readonly cancelling = signal(false);
  readonly cancelError = signal<string | null>(null);
  readonly paying = signal(false);
  readonly payError = signal<string | null>(null);

  readonly statusLabel = computed(() => this.order()?.status_label || '—');
  readonly canCancel = computed(() => this.order()?.can_cancel === true);
  readonly canPayAgain = computed(() => this.order()?.can_pay_again === true);
  readonly steps = computed(() => this.order()?.steps || []);
  readonly items = computed(() => this.order()?.items || []);
  readonly codeLabel = computed(() => {
    const order = this.order();
    return order?.order_code || order?.order_id || '—';
  });
  readonly dateLabel = computed(() => `Ngày đặt: ${formatOrderTime(this.order()?.created_at) || '—'}`);
  readonly payDeadline = computed(() => formatOrderTime(this.order()?.pay_again_until));
  readonly paymentLabel = computed(() => {
    const method = this.order()?.payment_method;
    if (method === 'COD') return 'Thanh toán khi nhận hàng (COD)';
    if (method === 'ONLINE_PAYMENT') return 'Thanh toán online (Stripe)';
    return method || '—';
  });

  constructor() {
    useBodyClass('page-order-detail');
    const stripe = this.route.snapshot.queryParamMap?.get('stripe');
    if (stripe === 'success') {
      this.notice.set('Stripe đã nhận thanh toán. Trạng thái đơn cập nhật ngay khi Stripe xác nhận, thường trong vài giây.');
    } else if (stripe === 'cancel') {
      this.notice.set('Bạn đã dừng thanh toán. Đơn vẫn giữ trong 24 giờ để thanh toán lại.');
    }
    this.load();
  }

  load(): void {
    this.api
      .get<MemberOrderDetail>(`/api/user/orders/${encodeURIComponent(this.orderRef)}`)
      .pipe(catchError(() => of(null)))
      .subscribe((order) => {
        this.loading.set(false);
        if (!order?.order_id) {
          this.loadError.set('Không tìm thấy đơn hàng.');
          this.order.set(null);
          return;
        }
        this.loadError.set(null);
        this.order.set(order);
      });
  }

  /**
   * Mở hộp thoại huỷ. Nút chỉ hiện khi API cho phép (BR-03).
   */
  openCancel(): void {
    if (!this.canCancel()) return;
    this.cancelError.set(null);
    this.cancelOpen.set(true);
  }

  closeCancel(): void {
    if (this.cancelling()) return;
    this.cancelOpen.set(false);
  }

  setCancelReason(event: Event): void {
    this.cancelReason.set((event.target as HTMLSelectElement).value);
  }

  setCancelOther(event: Event): void {
    this.cancelOther.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Huỷ đơn. API kiểm lại trạng thái; đơn đã trả tiền được hoàn tự động.
   */
  submitCancel(): void {
    const order = this.order();
    const reason = this.cancelReason() === 'Khác' ? this.cancelOther().trim() : this.cancelReason().trim();
    if (!order?.order_id || !this.canCancel() || this.cancelling()) return;
    if (reason.length < 3) {
      this.cancelError.set('Nhập lý do hủy.');
      return;
    }
    this.cancelling.set(true);
    this.cancelError.set(null);
    this.api
      .patch<{ refund?: { status?: string } | null }>('/api/user/orders', {
        order_id: order.order_id,
        status: 'cancelled',
        cancelled_reason: reason,
      })
      .subscribe({
        next: (result) => {
          this.cancelling.set(false);
          this.cancelOpen.set(false);
          this.notice.set(result?.refund
            ? 'Đơn đã được hủy. Tiền sẽ hoàn về phương thức thanh toán ban đầu.'
            : 'Đơn đã được hủy.');
          this.load();
        },
        error: (error: Error) => {
          this.cancelling.set(false);
          this.cancelError.set(error.message || 'Không hủy được đơn.');
          this.load();
        },
      });
  }

  /**
   * Mở lại trang thanh toán Stripe cho đơn đang chờ thanh toán (trong 24 giờ).
   */
  payAgain(): void {
    const order = this.order();
    if (!order?.order_id || !this.canPayAgain() || this.paying()) return;
    this.paying.set(true);
    this.payError.set(null);
    this.api.post<{ stripe?: { url?: string } | null }>(`/api/user/orders/${encodeURIComponent(order.order_id)}/pay-again`, {}).subscribe({
      next: (result) => {
        const url = result?.stripe?.url;
        if (url && url.startsWith('https://')) {
          window.location.assign(url);
          return;
        }
        this.paying.set(false);
        this.payError.set('Không mở được trang thanh toán. Thử lại sau ít phút.');
      },
      error: (error: Error) => {
        this.paying.set(false);
        this.payError.set(error.message || 'Không mở được trang thanh toán.');
      },
    });
  }

  money(value: number | undefined): string {
    return formatVnd(value) || '0₫';
  }

  stepTime(step: OrderStep): string {
    return formatOrderTime(step.at);
  }
}
