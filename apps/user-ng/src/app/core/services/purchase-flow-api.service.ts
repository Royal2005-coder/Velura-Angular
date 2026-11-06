import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from './api.service';

/** Server-configured payment providers; disabled methods cannot start a payment attempt. */
export interface PurchasePaymentProvider {
  code: 'COD' | 'STRIPE' | 'VNPAY' | 'MOMO';
  enabled: boolean;
  reason?: string;
  /** Môi trường của cổng: sandbox phải được dán nhãn rõ, khách không được tưởng đang trả tiền thật. */
  environment?: 'sandbox' | 'production';
  /** Simulator đang thế chỗ nhà mạng (demo không credential) — chỉ bật ở sandbox. */
  simulated?: boolean;
}

/** Phản hồi gửi OTP checkout của API KAN-28. */
export interface PurchaseOtpResponse {
  success?: boolean;
  message?: string;
  channel?: 'sms' | 'email' | 'both' | 'dev';
  /** Hạn của mã, do server trả về (AUTH-08: 300 giây). */
  expires_in?: number;
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
  /**
   * Phiên hosted của VNPay/MoMo. `qr_url` là DỮ LIỆU để vẽ mã QR (MoMo trả chuỗi NAPAS, VNPay trả
   * chính đường dẫn đã ký) — không phải ảnh, nên storefront tự render bằng thư viện `qrcode`.
   */
  payment?: {
    provider: PurchasePaymentProvider['code'];
    url?: string;
    payment_id?: string;
    expires_at?: string;
    environment?: 'sandbox' | 'production';
    qr_url?: string;
  } | null;
}

/** Kết quả server đối soát một giao dịch; browser không tự khai đã trả tiền. */
export interface PurchasePaymentVerification {
  paid?: boolean;
  payment_status?: string;
  status?: string;
  message?: string;
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

  /** Loads actual gateway configuration without exposing provider secrets to the browser. */
  providers(): Observable<{ providers: PurchasePaymentProvider[] }> {
    return this.api.get('/api/user/payments/providers');
  }

  /** Yêu cầu OTP SMS cho Guest; email chỉ là kênh bổ sung khi khách chủ động nhập. */
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
  /**
   * Reads a provider-verified result; browser query parameters and snapshots cannot assert payment.
   * VNPay/MoMo đi qua endpoint riêng của từng nhà mạng vì phải gọi API tra soát của chính họ
   * (VNPay QueryDR, MoMo /query) — `/payments/verify` chỉ đọc sổ ledger trong nước.
   */
  verifyPayment(orderId: string, orderAccessToken?: string, provider: PurchasePaymentProvider['code'] = 'STRIPE'): Observable<PurchasePaymentVerification> {
    const path = provider === 'STRIPE' ? '/api/user/payments/stripe/verify'
      : provider === 'VNPAY' || provider === 'MOMO' ? `/api/user/payments/${provider.toLowerCase()}/verify`
      : '/api/user/payments/verify';
    return this.api.post<PurchasePaymentVerification>(path, { order_id: orderId, order_access_token: orderAccessToken });
  }
}
