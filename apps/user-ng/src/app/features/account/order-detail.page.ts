import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { formatVnd } from '../../core/utils/money';
import { useBodyClass } from '../../core/utils/body-class';
import { customerCanCancel, orderStatusLabel } from './order-status';

interface MemberOrderDetail {
  order_id?: string;
  tracking_code?: string;
  status?: string;
  created_at?: string;
  payment_method?: string;
  subtotal?: number;
  shipping_fee?: number;
  discount_amount?: number;
  total_amount?: number;
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

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly order = signal<MemberOrderDetail | null>(null);
  readonly cancelOpen = signal(false);
  readonly cancelReason = signal('Thay đổi ý định');
  readonly cancelOther = signal('');
  readonly cancelling = signal(false);
  readonly cancelError = signal<string | null>(null);

  readonly statusLabel = computed(() => orderStatusLabel(this.order()?.status));
  readonly canCancel = computed(() => customerCanCancel(this.order()?.status));
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
    const id = this.route.snapshot.paramMap.get('id') || '';
    this.api
      .get<MemberOrderDetail>(`/api/user/orders/${id}`)
      .pipe(catchError(() => of(null)))
      .subscribe((order) => {
        this.loading.set(false);
        if (!order?.order_id && !order?.status) {
          this.loadError.set('Không tìm thấy đơn hàng.');
          this.order.set(null);
          return;
        }
        this.order.set(order);
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
}
