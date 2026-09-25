import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { CartLine } from '../../core/services/cart.store';
import { CheckoutStore } from '../../core/services/checkout.store';
import { formatVnd, toPublicAsset } from '../../core/utils/money';
import { showToast } from '../../core/utils/toast';
import { useBodyClass } from '../../core/utils/body-class';
import { VoucherWallet } from '../../shared/voucher-wallet/voucher-wallet';
import { VoucherService } from '../../core/services/voucher.service';
import { ApiRequestError } from '../../core/models/api-request-error';
import type {
  AppliedVoucher,
  CartItemRef,
  CheckoutQuote,
  VoucherChangedDetails
} from '../../core/models/voucher.interface';

interface MemberProfile {
  full_name?: string;
  email?: string;
  phone?: string;
  saved_addresses?: Array<{
    name?: string;
    phone?: string;
    detail?: string;
    address?: string;
    is_default?: boolean;
  }>;
}

interface PlaceOrderResponse {
  stripe?: { url?: string };
  success?: boolean;
  message?: string;
  order?: {
    order_id?: string;
    order_code?: string;
    payment_method?: string;
    shipping_address?: string;
  };
}

@Component({
  selector: 'app-checkout-shipping-page',
  imports: [RouterLink, VoucherWallet],
  host: { style: 'display:block' },
  templateUrl: './checkout-shipping.page.html',
})
export class CheckoutShippingPage {
  private readonly checkout = inject(CheckoutStore);
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly vouchers = inject(VoucherService);

  readonly submitting = signal(false);
  readonly payment = signal(this.checkout.methods().paymentMethod === 'MOMO' ? 'momo' : this.checkout.methods().paymentMethod === 'VNPAY' ? 'vnpay' : 'cod');
  readonly shipping = signal(this.checkout.methods().shippingMethod || 'standard');
  readonly name = signal(this.checkout.shipping().name);
  readonly phone = signal(this.checkout.shipping().phone);
  readonly email = signal(this.checkout.shipping().email);
  readonly province = signal('');
  readonly district = signal('');
  readonly ward = signal('');
  readonly detail = signal(this.checkout.shipping().address);
  readonly note = signal(this.checkout.shipping().note || '');
  readonly voucherError = signal<string | null>(null);
  /** Mã ví đang áp. Ví là nơi chọn; trang chỉ ghi lại để báo giá và đặt đơn. */
  readonly selectedVoucherId = signal<string | null>(localStorage.getItem('checkout_voucher_id'));
  /** Mã đã chọn ở giỏ hàng, để ví ở trang này áp đúng mã đó thay vì tự chọn lại. */
  readonly initialVoucherId = localStorage.getItem('checkout_voucher_id');
  /** Khách chủ động bỏ mã. Khác với mã tự mất hiệu lực: bỏ mã thì không tự áp lại. */
  readonly declinedVoucher = signal(localStorage.getItem('checkout_voucher_declined') === '1');
  /** Đọc một lần: đã bỏ mã ở giỏ thì ví trang này không tự áp mã tốt nhất. */
  readonly autoApplyVoucher = !this.declinedVoucher();
  /** Báo giá của máy chủ, nguồn duy nhất cho mọi con số trên màn Tóm tắt đơn (U1-13). */
  readonly quote = signal<CheckoutQuote | null>(null);
  readonly quoteLoading = signal(false);
  /** Câu báo khi mã khách chọn vừa hết hiệu lực lúc đặt đơn (D1). */
  readonly voucherNotice = signal<string | null>(null);

  /** Quản lý chỉnh sửa biến thể và cảnh báo tồn kho ngay trong tóm tắt đơn. */
  readonly editingVariantId = signal<string | null>(null);
  readonly variantChoices = signal<Array<{ variant_id: string; size?: string; color?: string; stock_quantity?: number }>>([]);
  readonly loadingVariants = signal(false);
  readonly outOfStockVariantIds = signal<Set<string>>(new Set());

  readonly items = this.checkout.checkoutItems;
  readonly cartRefs = computed<CartItemRef[]>(() =>
    this.items().map((line) => ({ variant_id: line.variant_id, quantity: line.quantity }))
  );
  /** Ước tính tạm trước khi có báo giá, chỉ để ví mã có giá trị đơn mà chấm. */
  private readonly localSubtotal = computed(() =>
    this.items().reduce((sum, line) => sum + line.unit_price * line.quantity, 0)
  );
  readonly subtotal = computed(() => this.quote()?.subtotal ?? this.localSubtotal());
  readonly freeship = computed(() => this.quote()?.free_shipping_shortfall === 0);
  readonly freeShippingThreshold = computed(() => this.quote()?.free_shipping_threshold ?? null);
  readonly freeShippingShortfall = computed(() => this.quote()?.free_shipping_shortfall ?? 0);
  readonly shippingFee = computed(() => this.quote()?.shipping_fee ?? 0);
  readonly discount = computed(() => this.quote()?.discount_amount ?? 0);
  readonly total = computed(() => this.quote()?.total_amount ?? 0);
  readonly quoteReady = computed(() => this.quote() !== null && !this.quoteLoading());
  readonly subtotalLabel = computed(() => formatVnd(this.subtotal()) || '0 đ');
  readonly shippingLabel = computed(() => {
    if (!this.quote()) return 'Đang tính…';
    return this.shippingFee() === 0 ? 'Miễn phí' : formatVnd(this.shippingFee());
  });
  readonly discountLabel = computed(() => (this.discount() > 0 ? `-${formatVnd(this.discount())}` : ''));
  readonly totalLabel = computed(() => (this.quote() ? formatVnd(this.total()) || '0 đ' : 'Đang tính…'));
  readonly standardFeeLabel = computed(() => this.feeLabel('30.000đ'));
  readonly expressFeeLabel = computed(() => this.feeLabel('50.000đ'));
  /** "Mua thêm X để được miễn phí vận chuyển" — ngưỡng lấy từ máy chủ, không viết cứng. */
  readonly freeShippingHint = computed(() => {
    const shortfall = this.freeShippingShortfall();
    if (!this.quote() || this.freeship() || shortfall <= 0) return null;
    return `Mua thêm ${formatVnd(shortfall)} để được miễn phí vận chuyển`;
  });
  readonly freeShippingProgress = computed(() => {
    const threshold = this.freeShippingThreshold();
    if (!threshold) return 0;
    return Math.min(100, Math.round((this.subtotal() / threshold) * 100));
  });
  readonly submitLabel = computed(() =>
    this.auth.isLoggedIn() ? 'Xác nhận đặt hàng' : 'Nhận mã OTP & Đặt hàng',
  );

  constructor() {
    useBodyClass('page-checkout');
    if (this.route.snapshot.queryParamMap.get('stripe') === 'cancel') {
      showToast('Giao dịch Stripe đã bị hủy. Bạn có thể chọn lại phương thức thanh toán.');
    }
    // Báo giá lại mỗi khi giỏ, cách giao hoặc lựa chọn mã đổi. Theo dõi nội dung giỏ chứ
    // không theo dõi tham chiếu mảng để không gọi lặp.
    effect(() => {
      const cartKey = this.cartRefs().map((item) => `${item.variant_id}:${item.quantity}`).join(',');
      const shipping = this.shipping();
      const voucherId = this.selectedVoucherId();
      const declined = this.declinedVoucher();
      untracked(() => this.refreshQuote(cartKey, shipping, voucherId, declined));
    });
    if (this.auth.isLoggedIn()) {
      this.api
        .get<MemberProfile>('/api/user/profile')
        .pipe(catchError(() => of(null)))
        .subscribe((profile) => this.prefillProfile(profile));
    }
  }

  /**
   * Updates a shipping form field from the original checkout inputs.
   */
  setField(field: 'name' | 'phone' | 'email' | 'province' | 'district' | 'ward' | 'detail' | 'note', event: Event): void {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    const fields = {
      name: this.name,
      phone: this.phone,
      email: this.email,
      province: this.province,
      district: this.district,
      ward: this.ward,
      detail: this.detail,
      note: this.note,
    };
    fields[field].set(value);
  }

  /**
   * Selects a shipping option from the original option cards.
   */
  setShipping(value: string): void {
    this.shipping.set(value);
  }

  /**
   * Selects a payment option from the original option cards.
   */
  setPayment(value: string): void {
    this.payment.set(value);
  }

  /**
   * Nhận kết quả từ Ví Voucher: mã được áp hoặc bị bỏ.
   *
   * Ví quyết định mã nào đang áp; số tiền giảm thì lấy từ báo giá của máy chủ, không lấy
   * con số ví đang hiển thị, để màn Tóm tắt đơn khớp đúng số ghi vào đơn.
   */
  onVoucherApplied(voucher: AppliedVoucher | null): void {
    this.voucherError.set(null);
    this.voucherNotice.set(null);
    this.selectedVoucherId.set(voucher?.voucher_id ?? null);
    if (voucher) {
      localStorage.setItem('checkout_voucher_id', voucher.voucher_id);
    } else {
      localStorage.removeItem('checkout_voucher_id');
    }
    localStorage.removeItem('checkout_discount');
  }

  /** Ví báo khách chủ động bỏ mã hoặc chọn lại mã. */
  onVoucherDeclined(declined: boolean): void {
    this.declinedVoucher.set(declined);
    if (declined) {
      localStorage.setItem('checkout_voucher_declined', '1');
    } else {
      localStorage.removeItem('checkout_voucher_declined');
    }
  }

  /**
   * Resolves a checkout thumbnail for Angular public assets.
   */
  imageUrl(line: CartLine): string {
    return toPublicAsset(line.product_image, '/assets/images/placeholder.jpg');
  }

  /**
   * Formats the total price for a line.
   */
  lineTotal(line: CartLine): string {
    return formatVnd(line.unit_price * line.quantity) || '0 đ';
  }

  /**
   * Changes the quantity of a line item directly in checkout.
   */
  changeItemQty(line: CartLine, delta: number): void {
    const next = line.quantity + delta;
    if (next <= 0) {
      this.removeItem(line);
      return;
    }
    this.checkout.updateItemQty(line.variant_id, next);
    if (this.outOfStockVariantIds().has(line.variant_id)) {
      this.outOfStockVariantIds.update((set) => {
        const copy = new Set(set);
        copy.delete(line.variant_id);
        return copy;
      });
    }
  }

  /**
   * Removes a line item from checkout and syncs with persistent cart.
   */
  removeItem(line: CartLine): void {
    this.checkout.removeItem(line.variant_id);
    this.outOfStockVariantIds.update((set) => {
      const copy = new Set(set);
      copy.delete(line.variant_id);
      return copy;
    });
    if (this.editingVariantId() === line.variant_id) {
      this.editingVariantId.set(null);
      this.variantChoices.set([]);
    }
  }

  /**
   * Toggles the variant selector dropdown for a line item.
   */
  toggleVariants(line: CartLine): void {
    if (this.editingVariantId() === line.variant_id) {
      this.editingVariantId.set(null);
      this.variantChoices.set([]);
      return;
    }
    this.editingVariantId.set(line.variant_id);
    this.variantChoices.set([]);
    this.loadingVariants.set(true);
    this.api
      .get<{ variants?: Array<{ variant_id: string; size?: string; color?: string; stock_quantity?: number }> }>(
        `/api/user/products/${line.product_id}`
      )
      .subscribe({
        next: (product) => {
          this.loadingVariants.set(false);
          this.variantChoices.set(product.variants || []);
        },
        error: () => {
          this.loadingVariants.set(false);
          this.variantChoices.set([]);
        },
      });
  }

  /**
   * Replaces a line item with another variant.
   */
  pickVariant(line: CartLine, option: { variant_id: string; size?: string; color?: string }): void {
    if (option.variant_id === line.variant_id) {
      this.editingVariantId.set(null);
      return;
    }
    this.checkout.replaceItemVariant(line.variant_id, {
      ...line,
      variant_id: option.variant_id,
      color: option.color,
      size: option.size,
    });
    this.editingVariantId.set(null);
    this.variantChoices.set([]);
    this.outOfStockVariantIds.update((set) => {
      const copy = new Set(set);
      copy.delete(line.variant_id);
      return copy;
    });
  }

  /**
   * Saves shipping fields and places the order or sends guest OTP.
   */
  submit(): void {
    if (this.submitting()) {
      return;
    }
    const name = this.name().trim();
    const phone = this.phone().trim();
    const email = this.email().trim();
    const address = this.composeAddress();
    if (!name || !phone || !address || (!this.auth.isLoggedIn() && !email)) {
      showToast('Vui lòng điền đầy đủ Họ tên, Số điện thoại, Email và Địa chỉ giao hàng!');
      return;
    }
    if (this.payment() === 'vnpay' || this.payment() === 'momo') {
      showToast('VNPay và MoMo chưa bật. Chọn COD hoặc thẻ Stripe.');
      return;
    }
    if (!this.auth.isLoggedIn() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      showToast('Email không hợp lệ. Mã OTP được gửi tới email, không gửi qua số điện thoại.');
      return;
    }
    if (!/^0\d{9}$/.test(phone.replace(/\s/g, ''))) {
      showToast('Số điện thoại không hợp lệ (10 số, bắt đầu bằng 0)!');
      return;
    }
    const items = this.items();
    if (!items.length) {
      showToast('Giỏ hàng không có sản phẩm để thanh toán.');
      return;
    }
    if (!this.quoteReady()) {
      showToast('Đang tính lại tổng tiền, vui lòng đợi trong giây lát.');
      return;
    }
    const paymentMethod = this.payment().toUpperCase();
    this.checkout.saveShipping({ name, phone, email, address, note: this.note().trim() });
    this.checkout.saveMethods({
      shippingMethod: this.shipping(),
      shippingFee: this.shippingFee(),
      paymentMethod,
    });

    const payload = {
      shipping_name: name,
      shipping_phone: phone,
      shipping_address: address,
      shipping_fee: this.shippingFee(),
      voucher_id: this.declinedVoucher() ? null : this.selectedVoucherId(),
      decline_voucher: this.declinedVoucher(),
      // Máy chủ tự tính lại mọi con số; gửi kèm chỉ để đối chiếu trong nhật ký.
      discount_amount: this.discount(),
      subtotal: this.subtotal(),
      total_amount: this.total(),
      payment_method: paymentMethod,
      shipping_email: email,
      items,
    };

    this.submitting.set(true);
    if (this.auth.isLoggedIn()) {
      this.api.post<PlaceOrderResponse>('/api/user/orders', payload).subscribe({
        next: (res) => {
          if (!res.success || !res.order) {
            this.submitting.set(false);
            showToast(res.message || 'Đặt hàng thất bại');
            return;
          }
          if (res.stripe?.url) {
            this.checkout.saveCreatedOrder({
              order_id: res.order.order_id,
              order_code: res.order.order_code,
              payment_method: res.order.payment_method,
              shipping_address: res.order.shipping_address,
              shipping_method: this.shipping(),
            });
            this.checkout.completeCheckout(items);
            window.location.assign(res.stripe.url);
            return;
          }
          this.finishOrder(res.order, items, paymentMethod);
        },
        error: (error: Error) => {
          this.submitting.set(false);
          if (this.handleVoucherChanged(error)) return;
          if (error instanceof ApiRequestError && error.code === 'INSUFFICIENT_STOCK') {
            const details = error.details as { items?: Array<{ variant_id: string }> } | undefined;
            if (details?.items?.length) {
              const ids = new Set(details.items.map((i) => i.variant_id));
              this.outOfStockVariantIds.set(ids);
            }
          }
          showToast(error.message || 'Đặt hàng thất bại');
        },
      });
      return;
    }

    this.api
      .post<{ success?: boolean; message?: string }>('/api/user/orders/otp-send', {
        phone,
        email,
        full_name: name,
      })
      .subscribe({
        next: (res) => {
          this.submitting.set(false);
          if (!res.success) {
            showToast(res.message || 'Không thể gửi mã xác thực');
            return;
          }
          this.checkout.saveGuestPayload({
            phone,
            shipping_name: name,
            shipping_address: address,
            shipping_fee: this.shippingFee(),
            voucher_id: payload.voucher_id,
            decline_voucher: payload.decline_voucher,
            discount_amount: payload.discount_amount,
            subtotal: payload.subtotal,
            total_amount: payload.total_amount,
            payment_method: paymentMethod,
            email,
            items,
          });
          showToast('Mã xác thực OTP đã được gửi!');
          void this.router.navigateByUrl('/checkout/otp');
        },
        error: (error: Error) => {
          this.submitting.set(false);
          showToast(error.message || 'Không thể gửi mã xác thực');
        },
      });
  }

  /**
   * Mã khách chọn vừa hết hiệu lực lúc đặt đơn: máy chủ không tạo đơn mà trả 409 kèm
   * mã thay thế. Chuyển sang mã đó, báo giá lại và để khách bấm đặt hàng lần nữa với
   * tổng mới đã thấy trên màn hình (D1). Trả true nếu đã xử lý.
   */
  private handleVoucherChanged(error: Error): boolean {
    if (!(error instanceof ApiRequestError) || error.code !== 'VOUCHER_CHANGED') return false;
    const details = (error.details || {}) as Partial<VoucherChangedDetails>;
    const replacement = details.replacement ?? null;
    const requested = details.requested_code ? `Mã ${details.requested_code}` : 'Mã đã chọn';
    const next = replacement ? ` Đã chuyển sang mã ${replacement.code}.` : ' Đơn sẽ không áp mã.';
    this.voucherNotice.set(
      `${requested} không còn dùng được: ${details.reason_text || error.message}${next} Kiểm tra tổng mới rồi bấm đặt hàng lần nữa.`
    );
    this.selectedVoucherId.set(replacement?.voucher_id ?? null);
    if (replacement) {
      localStorage.setItem('checkout_voucher_id', replacement.voucher_id);
    } else {
      localStorage.removeItem('checkout_voucher_id');
    }
    return true;
  }

  private refreshQuote(cartKey: string, shipping: string, voucherId: string | null, declined: boolean): void {
    if (!cartKey) {
      this.quote.set(null);
      return;
    }
    this.quoteLoading.set(true);
    this.vouchers.quote(this.cartRefs(), shipping, { voucherId, decline: declined }).subscribe({
      next: (quote) => {
        this.quoteLoading.set(false);
        this.quote.set(quote ?? null);
        if (quote?.voucher_change) {
          this.voucherNotice.set(`${quote.voucher_change.reason_text} Tổng tiền đã được tính lại.`);
        }
      },
      error: (error: Error) => {
        this.quoteLoading.set(false);
        this.quote.set(null);
        this.voucherError.set(error.message || 'Không tính được tổng tiền. Vui lòng thử lại.');
      },
    });
  }

  private feeLabel(fee: string): string {
    if (this.freeship()) return 'Miễn phí';
    const threshold = this.freeShippingThreshold();
    return threshold ? `${fee} / Freeship từ ${formatVnd(threshold)}` : fee;
  }

  private composeAddress(): string {
    const existing = this.detail().trim();
    const parts = [existing, this.ward().trim(), this.district().trim(), this.province().trim()].filter(Boolean);
    if (parts.length > 1) {
      return parts.join(', ');
    }
    return existing;
  }

  private prefillProfile(profile: MemberProfile | null): void {
    if (!profile) {
      return;
    }
    const addr = (profile.saved_addresses || []).find((row) => row.is_default) || profile.saved_addresses?.[0];
    if (!this.name() && profile.full_name) {
      this.name.set(profile.full_name);
    }
    if (!this.phone() && profile.phone) {
      this.phone.set(profile.phone);
    }
    if (!this.email() && profile.email) {
      this.email.set(profile.email);
    }
    if (!this.detail() && addr) {
      this.name.set(this.name() || addr.name || profile.full_name || '');
      this.phone.set(this.phone() || addr.phone || profile.phone || '');
      this.detail.set(addr.detail || addr.address || '');
    }
  }

  private finishOrder(
    order: NonNullable<PlaceOrderResponse['order']>,
    items: ReturnType<CheckoutShippingPage['items']>,
    paymentMethod: string,
  ): void {
    this.checkout.saveCreatedOrder({
      order_id: order.order_id,
      order_code: order.order_code,
      payment_method: order.payment_method,
      shipping_address: order.shipping_address,
      shipping_method: this.shipping(),
    });
    this.checkout.completeCheckout(items);
    showToast(paymentMethod === 'STRIPE'
      ? 'Đơn đã tạo. Stripe đánh dấu đã thanh toán khi webhook payment_intent.succeeded tới API.'
      : 'Đặt hàng thành công!');
    this.submitting.set(false);
    void this.router.navigateByUrl('/checkout/confirm');
    void paymentMethod;
  }
}
