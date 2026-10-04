import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

/** Phản hồi gửi OTP checkout của API KAN-28. */
export interface PurchaseOtpResponse {
  success?: boolean;
  message?: string;
  channel?: 'sms' | 'email' | 'both';
  /** Signed challenge proof, valid only for this checkout phone. */
  guest_checkout_token?: string;
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
  /** Grants a guest access to the newly created order without logging into a member account. */
  order_access_token?: string;
  order?: PurchaseCreatedOrder;
  stripe?: { url?: string } | null;
}

/** Result of an authorized payment-method change persisted by the backend. */
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

  /** Chuyển đơn online chưa thanh toán sang COD và ghi nhận ở backend. */
  switchToCod(orderId: string, phone: string, orderAccessToken?: string): Observable<PurchasePaymentResponse> {
    return this.api.post<PurchasePaymentResponse>('/api/user/orders/switch-cod', {
      order_id: orderId,
      phone,
      order_access_token: orderAccessToken,
    });
  }
  /** Retries the existing unpaid order through a server-created gateway session. */
  retryPayment(orderId: string, phone: string, orderAccessToken?: string): Observable<PurchaseCheckoutResponse> {
    return this.api.post<PurchaseCheckoutResponse>('/api/user/orders/retry-payment', { order_id: orderId, phone, order_access_token: orderAccessToken });
  }
  /** Reads a provider-verified result; browser query parameters and snapshots cannot assert payment. */
  verifyPayment(orderId: string, orderAccessToken?: string): Observable<{ paid?: boolean; payment_status?: string }> {
    return this.api.post('/api/user/payments/stripe/verify', { order_id: orderId, order_access_token: orderAccessToken });
  }
}
