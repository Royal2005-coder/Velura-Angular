import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { ApiService } from './api.service';
import type {
  CartItemRef,
  CheckoutQuote,
  VoucherApplyResponse,
  VoucherWalletResponse
} from '../models/voucher.interface';

/** Lựa chọn mã của khách cho một lần báo giá. */
export interface QuoteVoucherChoice {
  voucherId?: string | null;
  code?: string | null;
  decline?: boolean;
}

/**
 * Model layer cho ví voucher và báo giá.
 *
 * Toàn bộ phép tính số tiền nằm ở API, phía client không tự tính lại — nếu tính hai
 * nơi thì số hiển thị và số trừ khi đặt hàng sẽ lệch nhau ngay lần đầu đổi quy tắc.
 *
 * Mọi lời gọi nhận thêm dòng giỏ hàng. Có dòng hàng thì máy chủ tự tính giá trị đơn từ
 * bảng giá và xét được mã theo danh mục; thiếu dòng hàng thì mã theo danh mục bị báo
 * là chưa có sản phẩm phù hợp.
 */
@Injectable({ providedIn: 'root' })
export class VoucherService {
  private readonly api = inject(ApiService);

  /**
   * Lấy ví voucher đã đánh giá theo giỏ hàng hiện tại.
   * Dùng được cho cả khách vãng lai và thành viên.
   */
  loadWallet(orderValue: number, shippingFee: number, items: readonly CartItemRef[] = []): Observable<VoucherWalletResponse> {
    const params = new URLSearchParams({
      orderValue: String(Math.max(0, Math.round(orderValue))),
      shippingFee: String(Math.max(0, Math.round(shippingFee)))
    });
    const compact = compactItems(items);
    if (compact) params.set('items', compact);
    return this.api.get<VoucherWalletResponse>(`/api/user/vouchers?${params.toString()}`);
  }

  /**
   * Nhờ hệ thống tự chọn mã cho số tiền giảm thực tế lớn nhất.
   */
  pickBest(orderValue: number, shippingFee: number, items: readonly CartItemRef[] = []): Observable<VoucherApplyResponse> {
    return this.api.post<VoucherApplyResponse>('/api/user/vouchers/best', {
      order_value: orderValue,
      shipping_fee: shippingFee,
      items: toWireItems(items)
    });
  }

  /**
   * Áp một mã cụ thể do khách chọn hoặc tự nhập.
   */
  applyCode(code: string, orderValue: number, shippingFee: number, items: readonly CartItemRef[] = []): Observable<VoucherApplyResponse> {
    return this.api.post<VoucherApplyResponse>('/api/user/vouchers/apply', {
      code,
      order_value: orderValue,
      shipping_fee: shippingFee,
      items: toWireItems(items)
    });
  }

  /**
   * Báo giá đúng các con số sẽ ghi vào đơn — màn Tóm tắt đơn đọc từ đây (U1-13).
   */
  quote(items: readonly CartItemRef[], shippingMethod: string, choice: QuoteVoucherChoice): Observable<CheckoutQuote> {
    return this.api
      .post<{ success: boolean; quote: CheckoutQuote }>('/api/user/checkout/quote', {
        items: toWireItems(items),
        shipping_method: shippingMethod,
        voucher_id: choice.voucherId || null,
        code: choice.code || null,
        decline_voucher: choice.decline === true
      })
      .pipe(map((response) => response.quote));
  }
}

function toWireItems(items: readonly CartItemRef[]): CartItemRef[] {
  return items
    .filter((item) => item.variant_id && item.quantity > 0)
    .map((item) => ({ variant_id: item.variant_id, quantity: Math.round(item.quantity) }));
}

/** Dạng gọn `<variant_id>:<số lượng>,...` cho query string. */
function compactItems(items: readonly CartItemRef[]): string {
  return toWireItems(items).map((item) => `${item.variant_id}:${item.quantity}`).join(',');
}
