import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

/** Phản hồi gửi OTP checkout của API KAN-28. */
export interface PurchaseOtpResponse {
  success?: boolean;
  message?: string;
  channel?: 'sms' | 'email' | 'both';
}

/** Đơn tối thiểu trả về sau khi checkout thành công. */
export interface PurchaseCreatedOrder {
  order_id?: string;
  order_code?: string;
  payment_method?: string;
  status?: string;
  total_amount?: number;
}

/** Phản hồi dùng chung cho Guest và Member checkout. */
export interface PurchaseCheckoutResponse {
  success?: boolean;
  message?: string;
  activation_required?: boolean;
  order?: PurchaseCreatedOrder;
  stripe?: { url?: string } | null;
}

/** Phản hồi xác nhận thanh toán mô phỏng đã được backend ghi nhận. */
export interface PurchasePaymentResponse {
  success?: boolean;
  message?: string;
  order?: PurchaseCreatedOrder;
}

/** Model HTTP của purchase-flow; page không trực tiếp sở hữu HttpClient. */
@Injectable({ providedIn: 'root' })
export class PurchaseFlowApiService {
  private readonly api = inject(ApiService);

  /** Yêu cầu OTP cho Guest bằng contact hiện tại. */
  sendOtp(input: { full_name: string; phone: string; email: string }): Observable<PurchaseOtpResponse> {
    return this.api.post<PurchaseOtpResponse>('/api/user/orders/otp-send', input);
  }

  /** Kiểm tra OTP với backend nhưng chưa tiêu thụ mã và chưa tạo đơn. */
  verifyOtp(phone: string, otpCode: string): Observable<PurchaseOtpResponse> {
    return this.api.post<PurchaseOtpResponse>('/api/user/orders/otp-check', {
      phone,
      otp_code: otpCode,
    });
  }

  /** Xác minh OTP và tạo đơn Guest trong một use-case backend. */
  checkoutGuest(input: Record<string, unknown>): Observable<PurchaseCheckoutResponse> {
    return this.api.post<PurchaseCheckoutResponse>('/api/user/orders/otp-verify', input);
  }

  /** Tạo đơn cho Member đang có phiên đăng nhập. */
  checkoutMember(input: Record<string, unknown>): Observable<PurchaseCheckoutResponse> {
    return this.api.post<PurchaseCheckoutResponse>('/api/user/orders', input);
  }

  /** Xác nhận kết quả VNPay demo; Guest chứng minh quyền sở hữu bằng SĐT của đơn. */
  confirmPayment(orderId: string, phone: string): Observable<PurchasePaymentResponse> {
    return this.api.post<PurchasePaymentResponse>('/api/user/orders/confirm-payment', {
      order_id: orderId,
      phone,
    });
  }

  /** Chuyển đơn online chưa thanh toán sang COD và ghi nhận ở backend. */
  switchToCod(orderId: string, phone: string): Observable<PurchasePaymentResponse> {
    return this.api.post<PurchasePaymentResponse>('/api/user/orders/switch-cod', {
      order_id: orderId,
      phone,
    });
  }
}
