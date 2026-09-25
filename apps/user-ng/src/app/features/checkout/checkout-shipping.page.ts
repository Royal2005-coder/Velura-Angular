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
    id?: string;
    name?: string;
    phone?: string;
    detail?: string;
    province?: string;
    district?: string;
    ward?: string;
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
  host: {
    style: 'display:block',
    '(document:click)': 'closeAllDropdowns()',
  },
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
  readonly province = signal(this.checkout.shipping().province || '');
  readonly district = signal(this.checkout.shipping().district || '');
  readonly ward = signal(this.checkout.shipping().ward || '');
  readonly detail = signal(this.checkout.shipping().detail || this.checkout.shipping().address);
  readonly note = signal(this.checkout.shipping().note || '');

  /** Coolmate options: mã giới thiệu, quà tặng, người nhận khác, hóa đơn VAT, giao hàng HC */
  readonly referralCode = signal(this.checkout.shipping().referral_code || '');
  readonly referralApplied = signal(Boolean(this.checkout.shipping().referral_code));
  readonly isGift = signal(this.checkout.shipping().is_gift || false);
  readonly giftGender = signal<'nam' | 'nu'>(this.checkout.shipping().gift_gender || 'nam');
  readonly giftName = signal(this.checkout.shipping().gift_name || '');
  readonly giftMessage = signal(this.checkout.shipping().gift_message || '');
  readonly isOtherRecipient = signal(this.checkout.shipping().is_other_recipient || false);
  readonly otherName = signal(this.checkout.shipping().other_name || '');
  readonly otherPhone = signal(this.checkout.shipping().other_phone || '');
  readonly isVatInvoice = signal(this.checkout.shipping().is_vat_invoice || false);
  readonly vatCompanyName = signal(this.checkout.shipping().vat_company_name || '');
  readonly vatTaxCode = signal(this.checkout.shipping().vat_tax_code || '');
  readonly vatCompanyAddress = signal(this.checkout.shipping().vat_company_address || '');
  readonly vatEmail = signal(this.checkout.shipping().vat_email || '');
  readonly showDeliveryPolicy = signal(false);

  /** Member address book */
  readonly savedAddresses = signal<NonNullable<MemberProfile['saved_addresses']>>([]);
  readonly addressModalOpen = signal(false);
  readonly addressMode = signal<'default' | 'saved' | 'new'>('default');
  readonly saveNewAddress = signal(false);
  readonly defaultAddress = signal<NonNullable<MemberProfile['saved_addresses']>[number] | null>(null);

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

  /** Quản lý Coolmate variant selector pills và dropdowns. */
  readonly activeDropdown = signal<{ variantId: string; type: 'color' | 'size' } | null>(null);
  private readonly variantsCache = new Map<string, Array<{ variant_id: string; size?: string; color?: string; stock_quantity?: number }>>();
  readonly variantsVersion = signal(0);
  readonly loadingVariants = signal(false);
  readonly outOfStockVariantIds = signal<Set<string>>(new Set());

  readonly editingVariantId = computed(() => this.activeDropdown()?.variantId ?? null);
  readonly variantChoices = computed(() => {
    this.variantsVersion();
    const id = this.editingVariantId();
    if (!id) return [];
    const item = this.items().find((i) => i.variant_id === id);
    if (!item) return [];
    return this.variantsCache.get(item.product_id) || [];
  });

  /** Quản lý QR Payment Demo (VNPay / MoMo / Napas 247). */
  readonly qrModalOpen = signal(false);
  readonly pendingOrder = signal<NonNullable<PlaceOrderResponse['order']> | null>(null);
  readonly pendingItems = signal<CartLine[]>([]);
  readonly qrSeconds = signal(900);
  private qrTimerId: number | null = null;

  readonly pendingOrderCode = computed(() => this.pendingOrder()?.order_code || 'VLR-2026-DEMO');
  readonly qrImageUrl = computed(() => {
    const amount = this.total();
    const code = encodeURIComponent(this.pendingOrderCode());
    return `https://img.vietqr.io/image/BIDV-6150764893-compact2.png?amount=${amount}&addInfo=${code}&accountName=NGUYEN%20TO%20HOANG%20GIA`;
  });
  readonly qrCountdownLabel = computed(() => {
    const s = this.qrSeconds();
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  });
  readonly qrBankName = 'BIDV (Ngân hàng TMCP Đầu tư và Phát triển Việt Nam)';
  readonly qrAccountNumber = '6150764893';
  readonly qrAccountHolder = 'NGUYEN TO HOANG GIA';
  readonly qrAmountFormatted = computed(() => formatVnd(this.pendingOrder() ? this.total() : 0) || this.totalLabel());

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

  toggleGift(): void {
    this.isGift.update((v) => !v);
  }

  setGiftGender(gender: 'nam' | 'nu'): void {
    this.giftGender.set(gender);
  }

  setGiftName(event: Event): void {
    this.giftName.set((event.target as HTMLInputElement).value);
  }

  setGiftMessage(event: Event): void {
    this.giftMessage.set((event.target as HTMLTextAreaElement).value);
  }

  toggleOtherRecipient(): void {
    this.isOtherRecipient.update((v) => !v);
  }

  setOtherName(event: Event): void {
    this.otherName.set((event.target as HTMLInputElement).value);
  }

  setOtherPhone(event: Event): void {
    this.otherPhone.set((event.target as HTMLInputElement).value);
  }

  toggleVatInvoice(): void {
    this.isVatInvoice.update((v) => !v);
  }

  setVatField(field: 'company' | 'tax' | 'address' | 'email', event: Event): void {
    const val = (event.target as HTMLInputElement).value;
    if (field === 'company') this.vatCompanyName.set(val);
    else if (field === 'tax') this.vatTaxCode.set(val);
    else if (field === 'address') this.vatCompanyAddress.set(val);
    else if (field === 'email') this.vatEmail.set(val);
  }

  setReferralCode(event: Event): void {
    this.referralCode.set((event.target as HTMLInputElement).value);
  }

  applyReferralCode(): void {
    const code = this.referralCode().trim();
    if (!code) {
      this.referralApplied.set(false);
      showToast('Đã xóa mã giới thiệu');
      return;
    }
    this.referralApplied.set(true);
    showToast(`Đã ghi nhận mã giới thiệu: ${code}`);
  }

  toggleDeliveryPolicy(): void {
    this.showDeliveryPolicy.update((v) => !v);
  }

  openAddressModal(): void {
    this.addressModalOpen.set(true);
  }

  closeAddressModal(): void {
    this.addressModalOpen.set(false);
  }

  setAddressMode(mode: 'default' | 'saved' | 'new'): void {
    this.addressMode.set(mode);
    if (mode === 'default') {
      const def = this.defaultAddress() || this.savedAddresses()[0];
      if (def) {
        if (def.name) this.name.set(def.name);
        if (def.phone) this.phone.set(def.phone);
        this.detail.set(def.detail || def.address || '');
        this.province.set(def.province || '');
        this.district.set(def.district || '');
        this.ward.set(def.ward || '');
        this.saveNewAddress.set(false);
        showToast('Đã chọn địa chỉ mặc định');
      } else {
        showToast('Chưa có địa chỉ mặc định, bạn có thể nhập địa chỉ mới');
      }
    } else if (mode === 'new') {
      this.detail.set('');
      this.province.set('');
      this.district.set('');
      this.ward.set('');
      this.saveNewAddress.set(true);
      showToast('Vui lòng nhập địa chỉ mới');
    }
  }

  toggleSaveNewAddress(event: Event): void {
    this.saveNewAddress.set((event.target as HTMLInputElement).checked);
  }

  selectSavedAddress(addr: NonNullable<MemberProfile['saved_addresses']>[number]): void {
    if (addr.name) this.name.set(addr.name);
    if (addr.phone) this.phone.set(addr.phone);
    if (addr.detail || addr.address) {
      this.detail.set(addr.detail || addr.address || '');
    }
    if (addr.province) this.province.set(addr.province);
    if (addr.district) this.district.set(addr.district);
    if (addr.ward) this.ward.set(addr.ward);
    this.addressMode.set('saved');
    this.saveNewAddress.set(false);
    this.addressModalOpen.set(false);
    showToast('Đã chọn địa chỉ từ sổ địa chỉ');
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
    this.activeDropdown.set(null);
  }

  isDropdownOpen(line: CartLine, type: 'color' | 'size'): boolean {
    const cur = this.activeDropdown();
    return cur !== null && cur.variantId === line.variant_id && cur.type === type;
  }

  toggleDropdown(line: CartLine, type: 'color' | 'size', event?: Event): void {
    if (event) {
      event.stopPropagation();
    }
    const cur = this.activeDropdown();
    if (cur && cur.variantId === line.variant_id && cur.type === type) {
      this.activeDropdown.set(null);
      return;
    }
    this.activeDropdown.set({ variantId: line.variant_id, type });
    if (!this.variantsCache.has(line.product_id)) {
      this.loadingVariants.set(true);
      this.api
        .get<{ variants?: Array<{ variant_id: string; size?: string; color?: string; stock_quantity?: number }> }>(
          `/api/user/products/${line.product_id}`
        )
        .subscribe({
          next: (product) => {
            this.variantsCache.set(line.product_id, product.variants || []);
            this.variantsVersion.update((v) => v + 1);
            this.loadingVariants.set(false);
          },
          error: () => {
            this.variantsCache.set(line.product_id, []);
            this.variantsVersion.update((v) => v + 1);
            this.loadingVariants.set(false);
          },
        });
    }
  }

  toggleVariants(line: CartLine): void {
    if (this.isDropdownOpen(line, 'color') || this.isDropdownOpen(line, 'size')) {
      this.activeDropdown.set(null);
    } else {
      this.toggleDropdown(line, 'color');
    }
  }

  pickVariant(line: CartLine, variant: { variant_id: string; color?: string; size?: string }): void {
    this.activeDropdown.set(null);
    this.checkout.replaceItemVariant(line.variant_id, {
      ...line,
      variant_id: variant.variant_id,
      color: variant.color || line.color,
      size: variant.size || line.size,
    });
    this.outOfStockVariantIds.update((set) => {
      const copy = new Set(set);
      copy.delete(line.variant_id);
      return copy;
    });
  }

  getColorsForLine(line: CartLine): string[] {
    this.variantsVersion();
    const list = this.variantsCache.get(line.product_id) || [];
    const set = new Set<string>();
    if (line.color) set.add(line.color);
    for (const v of list) {
      if (v.color) set.add(v.color);
    }
    return Array.from(set);
  }

  getSizesForLine(line: CartLine): string[] {
    this.variantsVersion();
    const list = this.variantsCache.get(line.product_id) || [];
    const set = new Set<string>();
    if (line.size) set.add(line.size);
    for (const v of list) {
      if (v.size) set.add(v.size);
    }
    return Array.from(set);
  }

  pickColor(line: CartLine, color: string): void {
    this.activeDropdown.set(null);
    if (line.color === color) return;
    const list = this.variantsCache.get(line.product_id) || [];
    const match = list.find((v) => v.color === color && v.size === line.size) || list.find((v) => v.color === color);
    if (match) {
      this.checkout.replaceItemVariant(line.variant_id, {
        ...line,
        variant_id: match.variant_id,
        color: match.color || color,
        size: match.size || line.size,
      });
      this.outOfStockVariantIds.update((set) => {
        const copy = new Set(set);
        copy.delete(line.variant_id);
        return copy;
      });
    }
  }

  pickSize(line: CartLine, size: string): void {
    this.activeDropdown.set(null);
    if (line.size === size) return;
    const list = this.variantsCache.get(line.product_id) || [];
    const match = list.find((v) => v.size === size && v.color === line.color) || list.find((v) => v.size === size);
    if (match) {
      this.checkout.replaceItemVariant(line.variant_id, {
        ...line,
        variant_id: match.variant_id,
        color: match.color || line.color,
        size: match.size || size,
      });
      this.outOfStockVariantIds.update((set) => {
        const copy = new Set(set);
        copy.delete(line.variant_id);
        return copy;
      });
    }
  }

  closeAllDropdowns(): void {
    this.activeDropdown.set(null);
  }

  copyText(text: string, message: string): void {
    if (navigator?.clipboard?.writeText) {
      void navigator.clipboard.writeText(text);
      showToast(message);
    } else {
      showToast(`Đã sao chép: ${text}`);
    }
  }

  confirmDemoPayment(): void {
    const order = this.pendingOrder();
    const items = this.pendingItems();
    if (!order) return;
    this.clearQrTimer();
    this.qrModalOpen.set(false);
    this.finishOrder(order, items, this.payment().toUpperCase());
  }

  closeQrModal(): void {
    const order = this.pendingOrder();
    const items = this.pendingItems();
    this.clearQrTimer();
    this.qrModalOpen.set(false);
    if (order) {
      this.finishOrder(order, items, this.payment().toUpperCase());
    }
  }

  private startQrTimer(): void {
    this.clearQrTimer();
    this.qrSeconds.set(900);
    this.qrTimerId = window.setInterval(() => {
      this.qrSeconds.update((v) => {
        if (v <= 1) {
          this.clearQrTimer();
          return 0;
        }
        return v - 1;
      });
    }, 1000);
  }

  private clearQrTimer(): void {
    if (this.qrTimerId !== null) {
      window.clearInterval(this.qrTimerId);
      this.qrTimerId = null;
    }
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
    if (this.isOtherRecipient()) {
      const oPhone = this.otherPhone().trim();
      if (oPhone && !/^0\d{9}$/.test(oPhone.replace(/\s/g, ''))) {
        showToast('Số điện thoại người nhận thay không hợp lệ (10 số, bắt đầu bằng 0)!');
        return;
      }
    }
    if (this.isVatInvoice()) {
      if (!this.vatCompanyName().trim() || !this.vatTaxCode().trim()) {
        showToast('Vui lòng điền Tên công ty và Mã số thuế để xuất hoá đơn VAT!');
        return;
      }
    }
    const paymentMethod = this.payment().toUpperCase();
    this.checkout.saveShipping({
      name,
      phone,
      email,
      address,
      note: this.note().trim(),
      province: this.province().trim(),
      district: this.district().trim(),
      ward: this.ward().trim(),
      detail: this.detail().trim(),
      referral_code: this.referralCode().trim(),
      is_gift: this.isGift(),
      gift_gender: this.giftGender(),
      gift_name: this.giftName().trim(),
      gift_message: this.giftMessage().trim(),
      is_other_recipient: this.isOtherRecipient(),
      other_name: this.otherName().trim(),
      other_phone: this.otherPhone().trim(),
      is_vat_invoice: this.isVatInvoice(),
      vat_company_name: this.vatCompanyName().trim(),
      vat_tax_code: this.vatTaxCode().trim(),
      vat_company_address: this.vatCompanyAddress().trim(),
      vat_email: this.vatEmail().trim(),
    });
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
      note: this.note().trim(),
      referral_code: this.referralCode().trim(),
      is_gift: this.isGift(),
      gift_gender: this.giftGender(),
      gift_name: this.giftName().trim(),
      gift_message: this.giftMessage().trim(),
      is_other_recipient: this.isOtherRecipient(),
      other_name: this.otherName().trim(),
      other_phone: this.otherPhone().trim(),
      is_vat_invoice: this.isVatInvoice(),
      vat_company_name: this.vatCompanyName().trim(),
      vat_tax_code: this.vatTaxCode().trim(),
      vat_company_address: this.vatCompanyAddress().trim(),
      vat_email: this.vatEmail().trim(),
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
          if (this.auth.isLoggedIn() && this.addressMode() === 'new' && this.saveNewAddress()) {
            this.api.post('/api/user/addresses', {
              name,
              phone,
              detail: this.detail().trim(),
              province: this.province().trim(),
              district: this.district().trim(),
              ward: this.ward().trim(),
              address,
              is_default: false,
            }).subscribe({
              next: () => {},
              error: () => {},
            });
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
          if (paymentMethod === 'VNPAY' || paymentMethod === 'MOMO') {
            this.submitting.set(false);
            this.pendingOrder.set(res.order);
            this.pendingItems.set(items);
            this.qrModalOpen.set(true);
            this.startQrTimer();
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
            note: payload.note,
            referral_code: payload.referral_code,
            is_gift: payload.is_gift,
            gift_gender: payload.gift_gender,
            gift_name: payload.gift_name,
            gift_message: payload.gift_message,
            is_other_recipient: payload.is_other_recipient,
            other_name: payload.other_name,
            other_phone: payload.other_phone,
            is_vat_invoice: payload.is_vat_invoice,
            vat_company_name: payload.vat_company_name,
            vat_tax_code: payload.vat_tax_code,
            vat_company_address: payload.vat_company_address,
            vat_email: payload.vat_email,
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
    const d = this.detail().trim();
    const w = this.ward().trim();
    const dist = this.district().trim();
    const p = this.province().trim();
    const parts = [d, w, dist, p].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : d;
  }

  private prefillProfile(profile: MemberProfile | null): void {
    if (!profile) {
      return;
    }
    if (profile.saved_addresses) {
      this.savedAddresses.set(profile.saved_addresses);
    }
    const addr = (profile.saved_addresses || []).find((row) => row.is_default) || profile.saved_addresses?.[0] || null;
    if (addr) {
      this.defaultAddress.set(addr);
    }
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
      if (addr.province) this.province.set(addr.province);
      if (addr.district) this.district.set(addr.district);
      if (addr.ward) this.ward.set(addr.ward);
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
