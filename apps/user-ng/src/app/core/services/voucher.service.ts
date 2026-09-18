import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';
import type {
  VoucherApplyResponse,
  VoucherWalletResponse
} from '../models/voucher.interface';

/**
 * Model layer cho ví voucher.
 *
 * Toàn bộ phép tính số tiền giảm nằm ở API (`voucher-engine`), phía client không tự
 * tính lại — nếu tính hai nơi thì số hiển thị trong ví và số trừ khi đặt hàng sẽ lệch
 * nhau ngay lần đầu đổi quy tắc.
 */
@Injectable({ providedIn: 'root' })
export class VoucherService {
  private readonly api = inject(ApiService);

  /**
   * Lấy ví voucher đã đánh giá theo giá trị đơn hiện tại.
   * Dùng được cho cả khách vãng lai và thành viên.
   */
  loadWallet(orderValue: number, shippingFee: number): Observable<VoucherWalletResponse> {
    const query = `orderValue=${Math.max(0, Math.round(orderValue))}&shippingFee=${Math.max(0, Math.round(shippingFee))}`;
    return this.api.get<VoucherWalletResponse>(`/api/user/vouchers?${query}`);
  }

  /**
   * Nhờ hệ thống tự chọn mã cho số tiền giảm thực tế lớn nhất.
   */
  pickBest(orderValue: number, shippingFee: number): Observable<VoucherApplyResponse> {
    return this.api.post<VoucherApplyResponse>('/api/user/vouchers/best', {
      order_value: orderValue,
      shipping_fee: shippingFee
    });
  }

  /**
   * Áp một mã cụ thể do khách chọn hoặc tự nhập.
   */
  applyCode(code: string, orderValue: number, shippingFee: number): Observable<VoucherApplyResponse> {
    return this.api.post<VoucherApplyResponse>('/api/user/vouchers/apply', {
      code,
      order_value: orderValue,
      shipping_fee: shippingFee
    });
  }
}
