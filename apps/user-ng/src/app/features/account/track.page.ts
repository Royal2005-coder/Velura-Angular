import { Component, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { useBodyClass } from '../../core/utils/body-class';
import { formatVnd, toPublicAsset } from '../../core/utils/money';
import { formatOrderTime } from '../../core/utils/order-time';
import { showToast } from '../../core/utils/toast';

/**
 * Bước trạng thái trong timeline hành trình đơn hàng.
 */
export interface OrderStep {
  status: string;
  label: string;
  at: string | null;
  state: 'done' | 'current' | 'upcoming';
}

/**
 * Dòng sản phẩm hiển thị trong chi tiết tra cứu đơn hàng.
 */
export interface TrackOrderItem {
  item_id?: string;
  variant_id?: string;
  product_name?: string;
  product_image?: string;
  quantity?: number;
  unit_price?: number;
  color?: string;
  size?: string;
  category_name?: string;
}

/**
 * Dữ liệu chi tiết đơn hàng trả về cho giao diện tra cứu công khai & thành viên.
 */
export interface TrackOrderResult {
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
  carrier?: string | null;
  tracking_code?: string | null;
  tracking_url?: string | null;
  cancelled_reason?: string | null;
  items?: TrackOrderItem[];
  steps?: OrderStep[];
  can_cancel?: boolean;
  can_pay_again?: boolean;
  can_request_return?: boolean;
}

/**
 * Trang tra cứu đơn hàng (KAN-38, KAN-29), hỗ trợ theo dõi tiến độ thời gian thực,
 * huỷ đơn khi đang chờ và yêu cầu đổi/trả 30 ngày cho cả khách vãng lai và thành viên.
 */
@Component({
  selector: 'app-account-track-page',
  imports: [RouterLink],
  host: { class: 'page-track-order' },
  templateUrl: './track.page.html',
})
export class AccountTrackPage {
  private readonly api = inject(ApiService);
  readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);

  readonly codeQuery = signal(this.route.snapshot.queryParamMap.get('code') || '');
  readonly contactQuery = signal(this.route.snapshot.queryParamMap.get('contact') || '');

  readonly searching = signal(false);
  readonly searched = signal(false);
  readonly order = signal<TrackOrderResult | null>(null);
  readonly searchError = signal<string | null>(null);

  /** Cancel Order state */
  readonly cancelModalOpen = signal(false);
  readonly cancelReason = signal('Thay đổi ý định');
  readonly cancelOther = signal('');
  readonly cancelling = signal(false);
  readonly cancelError = signal<string | null>(null);

  /** Return & Exchange state (U2 KAN-29) */
  readonly returnModalOpen = signal(false);
  readonly returnType = signal<'refund' | 'exchange'>('refund');
  readonly returnReason = signal('Sản phẩm bị lỗi / hỏng khi nhận');
  readonly returnNote = signal('');
  readonly submittingReturn = signal(false);
  readonly returnError = signal<string | null>(null);
  readonly returnSuccess = signal(false);

  readonly isLoggedIn = computed(() => this.auth.isLoggedIn());
  readonly items = computed(() => this.order()?.items || []);
  readonly steps = computed(() => this.order()?.steps || []);
  readonly canCancel = computed(() => this.order()?.can_cancel === true);
  readonly canPayAgain = computed(() => this.order()?.can_pay_again === true);
  readonly canRequestReturn = computed(() => {
    const o = this.order();
    return o?.can_request_return === true || (o?.status === 'delivered');
  });

  constructor() {
    useBodyClass('page-track-order');
    if (this.codeQuery().trim()) {
      this.search();
    }
  }

  onCodeInput(event: Event): void {
    this.codeQuery.set((event.target as HTMLInputElement).value);
  }

  onContactInput(event: Event): void {
    this.contactQuery.set((event.target as HTMLInputElement).value);
  }

  search(): void {
    const code = this.codeQuery().trim();
    const contact = this.contactQuery().trim();

    if (!code) {
      this.searchError.set('Vui lòng nhập mã đơn hàng (VD: VLR-2026-...)');
      return;
    }

    if (!this.auth.isLoggedIn() && !contact) {
      this.searchError.set('Vui lòng nhập số điện thoại hoặc email đặt hàng để xác thực quyền tra cứu!');
      return;
    }

    this.searching.set(true);
    this.searchError.set(null);

    const params: Record<string, string> = { code };
    if (contact) {
      params['contact'] = contact;
    }

    const queryParams = new URLSearchParams(params).toString();

    this.api
      .get<{ success?: boolean; order?: TrackOrderResult; message?: string }>(`/api/user/orders/track?${queryParams}`)
      .pipe(
        catchError((err: Error) => {
          if (this.auth.isLoggedIn()) {
            return this.api
              .get<TrackOrderResult>(`/api/user/orders/${encodeURIComponent(code)}`)
              .pipe(
                catchError(() => of(null)),
              );
          }
          this.searchError.set(err.message || 'Không tìm thấy thông tin đơn hàng hoặc thông tin liên hệ không khớp.');
          return of(null);
        }),
      )
      .subscribe((res) => {
        this.searching.set(false);
        this.searched.set(true);
        if (!res) {
          this.order.set(null);
          if (!this.searchError()) {
            this.searchError.set('Không tìm thấy đơn hàng. Vui lòng kiểm tra lại mã đơn và số điện thoại/email.');
          }
          return;
        }

        const data = (res as { order?: TrackOrderResult }).order || (res as TrackOrderResult);
        if (!data || !data.order_id) {
          this.order.set(null);
          this.searchError.set('Không tìm thấy đơn hàng. Vui lòng kiểm tra lại thông tin.');
          return;
        }

        this.searchError.set(null);
        this.order.set(data);
      });
  }

  openCancelModal(): void {
    if (!this.canCancel()) return;
    this.cancelError.set(null);
    this.cancelModalOpen.set(true);
  }

  closeCancelModal(): void {
    if (this.cancelling()) return;
    this.cancelModalOpen.set(false);
  }

  setCancelReason(event: Event): void {
    this.cancelReason.set((event.target as HTMLSelectElement).value);
  }

  setCancelOther(event: Event): void {
    this.cancelOther.set((event.target as HTMLTextAreaElement).value);
  }

  submitCancel(): void {
    const o = this.order();
    const reason = this.cancelReason() === 'Khác' ? this.cancelOther().trim() : this.cancelReason().trim();
    if (!o?.order_id || !this.canCancel() || this.cancelling()) return;

    if (reason.length < 3) {
      this.cancelError.set('Vui lòng nhập lý do hủy đơn (tối thiểu 3 ký tự).');
      return;
    }

    this.cancelling.set(true);
    this.cancelError.set(null);

    const payload = {
      order_id: o.order_id,
      code: o.order_code || o.order_id,
      contact: this.contactQuery().trim(),
      status: 'cancelled',
      cancelled_reason: reason,
    };

    const call$ = this.auth.isLoggedIn()
      ? this.api.patch<{ success?: boolean; refund?: unknown }>('/api/user/orders', payload)
      : this.api.patch<{ success?: boolean; refund?: unknown }>('/api/user/orders/track', payload);

    call$.subscribe({
      next: (result) => {
        this.cancelling.set(false);
        this.cancelModalOpen.set(false);
        showToast(result?.refund ? 'Đã hủy đơn thành công. Tiền sẽ được hoàn lại.' : 'Đã hủy đơn hàng thành công!');
        this.search();
      },
      error: (err: Error) => {
        this.cancelling.set(false);
        this.cancelError.set(err.message || 'Không thể hủy đơn hàng vào lúc này.');
      },
    });
  }

  openReturnModal(): void {
    this.returnError.set(null);
    this.returnSuccess.set(false);
    this.returnModalOpen.set(true);
  }

  closeReturnModal(): void {
    if (this.submittingReturn()) return;
    this.returnModalOpen.set(false);
  }

  setReturnType(type: 'refund' | 'exchange'): void {
    this.returnType.set(type);
  }

  setReturnReason(event: Event): void {
    this.returnReason.set((event.target as HTMLSelectElement).value);
  }

  setReturnNote(event: Event): void {
    this.returnNote.set((event.target as HTMLTextAreaElement).value);
  }

  submitReturn(): void {
    const o = this.order();
    if (!o?.order_id || this.submittingReturn()) return;

    const returnItems = (o.items || []).map((item) => ({
      order_item_id: item.item_id,
      variant_id: item.variant_id,
      quantity: item.quantity || 1,
    }));

    if (!returnItems.length) {
      this.returnError.set('Đơn hàng không có sản phẩm khả dụng để yêu cầu đổi/trả.');
      return;
    }

    this.submittingReturn.set(true);
    this.returnError.set(null);

    const payload = {
      order_id: o.order_id,
      order_code: o.order_code,
      contact: this.contactQuery().trim(),
      return_type: this.returnType(),
      reason: this.returnReason(),
      note: this.returnNote().trim(),
      items: returnItems,
    };

    const call$ = this.auth.isLoggedIn()
      ? this.api.post<{ success?: boolean; message?: string }>('/api/user/returns', payload)
      : this.api.post<{ success?: boolean; message?: string }>('/api/user/returns/guest', payload);

    call$.subscribe({
      next: () => {
        this.submittingReturn.set(false);
        this.returnSuccess.set(true);
        showToast('Yêu cầu đổi/trả hàng đã được tiếp nhận. Đội ngũ CSKH sẽ liên hệ với bạn trong 24 giờ.');
      },
      error: (err: Error) => {
        this.submittingReturn.set(false);
        this.returnError.set(err.message || 'Không thể gửi yêu cầu đổi/trả hàng. Vui lòng thử lại sau.');
      },
    });
  }

  payAgain(): void {
    const o = this.order();
    if (!o?.order_id || !this.canPayAgain()) return;

    this.api
      .post<{ stripe?: { url?: string } | null }>(`/api/user/orders/${encodeURIComponent(o.order_id)}/pay-again`, {})
      .subscribe({
        next: (result) => {
          const url = result?.stripe?.url;
          if (url && url.startsWith('https://')) {
            window.location.assign(url);
          } else {
            showToast('Không thể mở cổng thanh toán. Vui lòng liên hệ CSKH.');
          }
        },
        error: (err: Error) => {
          showToast(err.message || 'Lỗi khi mở thanh toán lại.');
        },
      });
  }

  money(amount: number | undefined): string {
    return formatVnd(amount) || '0 đ';
  }

  timeLabel(dateStr: string | null | undefined): string {
    return formatOrderTime(dateStr) || '—';
  }

  itemImage(item: TrackOrderItem): string {
    return toPublicAsset(item.product_image, '/assets/images/placeholder.jpg');
  }

  paymentMethodLabel(method: string | undefined): string {
    if (!method) return '—';
    if (method === 'COD') return 'Thanh toán khi nhận hàng (COD)';
    if (method === 'ONLINE_PAYMENT' || method === 'STRIPE') return 'Thanh toán online qua Stripe';
    if (method === 'VNPAY') return 'VNPay QR / Ngân hàng';
    if (method === 'MOMO') return 'Ví MoMo';
    return method;
  }
}
