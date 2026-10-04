import {
  Component,
  DestroyRef,
  ElementRef,
  ViewChild,
  effect,
  computed,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { OrderAccountApiStore } from '../../core/services/order-account-api.store';
import { CheckoutStore } from '../../core/services/checkout.store';
import { VoucherService } from '../../core/services/voucher.service';
import { VoucherWallet } from '../../shared/voucher-wallet/voucher-wallet';
import type { AppliedVoucher, CheckoutQuote } from '../../core/models/voucher.interface';
import { ApiRequestError } from '../../core/models/api-request-error';
import {
  PurchaseFlowApiService,
  type PurchaseCheckoutResponse,
} from '../../core/services/purchase-flow-api.service';
import {
  DemoAddress,
  DemoOrder,
  maskPhone,
  normalizePhone,
  validPhone,
} from '../../core/services/purchase-demo.store';
import { formatVnd, toPublicAsset } from '../../core/utils/money';
import { AddressSelector } from '../../shared/address-selector/address-selector';
import type { AddressGeographySelection, GeographyMode } from '../../core/models/address-geography';
import { PurchaseCustomerStore } from '../../core/services/purchase-customer.store';

/** Checkout một trang của KAN-27; mọi mutation đơn hàng đi qua Model API KAN-28. */
@Component({
  selector: 'app-purchase-flow',
  imports: [FormsModule, RouterLink, AddressSelector, VoucherWallet],
  templateUrl: './purchase-flow.page.html',
  styleUrls: [
    '../shared/purchase-flow.css',
    '../shared/purchase-flow-forms.css',
    '../shared/purchase-flow-layout.css',
    '../shared/purchase-flow-responsive.css',
  ],
})
export class PurchaseFlowPage {
  readonly model = inject(PurchaseCustomerStore);
  private readonly purchaseApi = inject(PurchaseFlowApiService);
  private readonly orderAccount = inject(OrderAccountApiStore);
  private readonly checkout = inject(CheckoutStore);
  private readonly auth = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  @ViewChild('addressDialog') private addressDialog!: ElementRef<HTMLDialogElement>;
  readonly step = signal<'form' | 'gateway' | 'result' | 'success' | 'invite' | 'activated'>(
    'form',
  );
  readonly member = this.model.member;
  readonly lines = signal(this.checkout.readCheckoutItems().map((line) => ({ ...line })));
  private readonly vouchers = inject(VoucherService);
  readonly serverQuote = signal<CheckoutQuote | null>(null);
  readonly quoteLoading = signal(false);
  readonly quoteError = signal('');
  readonly shippingMethod = signal('standard');
  readonly voucherId = signal<string | null>(localStorage.getItem('checkout_voucher_id'));
  readonly voucherDeclined = signal(localStorage.getItem('checkout_voucher_declined') === 'true');
  readonly preferredVoucher = localStorage.getItem('checkout_voucher_code') || this.voucherId();
  private quoteVersion = 0;
  private guestCheckoutToken = '';
  readonly quote = computed(() => this.order() || {
    subtotal: this.serverQuote()?.subtotal ?? 0,
    shipping: this.serverQuote()?.shipping_fee ?? 0,
    discount: this.serverQuote()?.discount_amount ?? 0,
    total: this.serverQuote()?.total_amount ?? 0,
    voucher: this.serverQuote()?.voucher?.name || 'Chưa áp dụng mã giảm giá',
  });
  readonly busy = signal(false);
  readonly resumeLoading = signal(false);
  readonly resumeLocked = signal(false);
  readonly error = signal('');
  readonly seconds = signal(60);
  readonly paymentSeconds = signal(900);
  readonly resendSeconds = signal(0);
  readonly digits = signal(['', '', '', '', '', '']);
  readonly order = signal<DemoOrder | null>(null);
  readonly paymentResult = signal<'paid' | 'failed' | 'cancelled' | 'expired' | 'confirming'>(
    'confirming',
  );
  readonly voucherNotice = signal('');
  readonly stockProblem = signal('');
  readonly money = formatVnd;
  readonly image = (url: string) => toPublicAsset(url, '/assets/images/placeholder.jpg');
  readonly masked = computed(() => maskPhone(this.otpPhone()));
  readonly otpPhone = signal('');
  readonly otpVerified = signal(false);
  readonly otpError = signal('');
  readonly sendingOtp = signal(false);
  readonly fieldErrors = signal<Record<string, string>>({});
  readonly dialogErrors = signal<Record<string, string>>({});
  readonly addressBusy = signal(false);
  readonly addressGeographyValid = signal(false);
  readonly draftGeographyValid = signal(false);
  readonly addressGeographyMode = signal<GeographyMode>('current');
  readonly draftGeographyMode = signal<GeographyMode>('current');
  readonly dialogMode = signal<'list' | 'editor'>('list');
  readonly pendingAddress = signal(-1);
  readonly deletingAddress = signal(-1);
  readonly clockLabel = computed(
    () =>
      `${Math.floor(this.seconds() / 60)
        .toString()
        .padStart(2, '0')}:${(this.seconds() % 60).toString().padStart(2, '0')}`,
  );
  readonly paymentClockLabel = computed(
    () =>
      `${Math.floor(this.paymentSeconds() / 60)
        .toString()
        .padStart(2, '0')}:${(this.paymentSeconds() % 60).toString().padStart(2, '0')}`,
  );
  readonly bookEntries = computed(() => {
    const entries: Array<{ address: DemoAddress; savedIndex: number | null }> = this.model
      .addresses()
      .map((address, savedIndex) => ({ address, savedIndex }));
    for (const order of this.model.orders().filter((order) => this.model.ownsOrder(order))) {
      if (!entries.some((entry) => this.sameAddress(entry.address, order.address)))
        entries.push({ address: order.address, savedIndex: null });
    }
    return entries;
  });
  addressDraft: DemoAddress = {
    name: '',
    phone: '',
    email: '',
    province: '',
    district: '',
    ward: '',
    detail: '',
  };
  saveDraft = true;
  draftDefault = false;
  editingAddress = -1;
  payment: 'COD' | 'STRIPE' | 'VNPAY' | 'MOMO' = 'COD';
  address: DemoAddress = {
    name: '',
    phone: '',
    email: '',
    province: '',
    district: '',
    ward: '',
    detail: '',
  };
  saveAddress = false;

  selectedAddress = -1;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private otpTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    effect(() => {
      this.lines(); this.shippingMethod(); this.voucherId(); this.voucherDeclined(); this.model.userId();
      untracked(() => this.refreshQuote());
    });
    let initialUser = this.model.userId();
    effect(() => {
      const currentUser = this.model.userId();
      if (currentUser !== initialUser) {
        initialUser = currentUser;
        clearTimeout(this.timeout);
        clearTimeout(this.otpTimeout);
        this.addressDialog?.nativeElement.close();
        this.address = {
          name: '',
          phone: '',
          email: '',
          province: '',
          district: '',
          ward: '',
          detail: '',
        };
        this.order.set(null);
        this.otpVerified.set(false);
        this.guestCheckoutToken = '';
        this.busy.set(false);
        this.step.set('form');
        void this.router.navigateByUrl(this.member() ? '/checkout/user' : '/checkout/guest');
      }
    });
    const session = this.auth.session();
    if (session) {
      this.address = {
        ...this.address,
        name: session.fullName || '',
        phone: session.phone || '',
        email: session.email || '',
      };
    }

    const requestedOrder = this.route.snapshot.queryParamMap.get('order');
    const savedCheckout = this.checkout.readCreatedOrder();
    const matchingSnapshot = savedCheckout?.checkout_snapshot
      && (savedCheckout.order_id === requestedOrder || savedCheckout.order_code === requestedOrder)
      ? savedCheckout : null;
    if (requestedOrder) {
      this.resumeLocked.set(true);
      void this.resumeExistingOrder(requestedOrder, matchingSnapshot?.order_access_token);
    }
    const timer = setInterval(() => {
      this.seconds.update((value) => Math.max(0, value - 1));
      this.paymentSeconds.update((value) => Math.max(0, value - 1));
      this.resendSeconds.update((value) => Math.max(0, value - 1));
      if (this.step() === 'gateway' && this.paymentSeconds() === 0 && !this.busy())
        this.result('expired');
    }, 1000);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      clearTimeout(this.timeout);
      clearTimeout(this.otpTimeout);
    });
    if (!requestedOrder) this.prefillDefault();
    effect(() => {
      this.model.addresses();
      const userId = this.model.userId();
      untracked(() => {
        if (userId && !this.resumeLocked() && !this.order() && !this.address.detail.trim() && this.selectedAddress < 0) this.prefillDefault();
      });
    });
  }
  /** Resume a persisted order using its real UUID, totals and payment facts; never create a second order. */
  private async resumeExistingOrder(id: string, scopedGuestToken?: string): Promise<void> {
    const session = this.auth.session();
    this.resumeLoading.set(true);
    this.busy.set(true);
    this.quoteVersion++;
    this.serverQuote.set(null);
    this.quoteLoading.set(false);
    this.error.set('');
    try {
      const order = await this.orderAccount.loadPaymentOrder(id, scopedGuestToken);
      if (session !== this.auth.session()) return;
      if (order.status === 'cancelled') throw new Error('Đơn hàng đã hủy. Vui lòng mở chi tiết đơn hàng.');
      this.order.set(order);
      this.lines.set(order.items.map((line) => ({ ...line })));
      this.address = { ...order.address };
      const token = this.orderAccount.guestAccessToken() || scopedGuestToken;
      const existing = this.checkout.readCreatedOrder();
      const sameOrder = existing?.order_id === order.orderId;
      const expiresAt = sameOrder ? existing?.payment_expires_at : undefined;
      this.checkout.saveCreatedOrder({
        order_id: order.orderId, order_code: order.id, payment_method: order.payment,
        shipping_address: order.address.detail, checkout_snapshot: order,
        order_access_token: this.member() ? undefined : token,
        payment_expires_at: expiresAt,
      });
      if (order.payment === 'COD' || order.paymentState === 'paid') {
        this.step.set('success');
        return;
      }
      if (order.status !== 'pending_payment') throw new Error('Đơn đã chuyển sang xử lý. Vui lòng xem trạng thái trong chi tiết đơn hàng.');
      const expires = Date.parse(expiresAt || '');
      const seconds = Number.isFinite(expires) ? Math.max(0, Math.ceil((expires - Date.now()) / 1000)) : 0;
      this.paymentSeconds.set(seconds);
      this.paymentResult.set(this.route.snapshot.queryParamMap.get('stripe') === 'cancel' ? 'cancelled'
        : order.paymentState === 'failed' ? 'failed'
        : order.paymentState === 'expired' || (Number.isFinite(expires) && seconds === 0) ? 'expired' : 'confirming');
      this.step.set(Number.isFinite(expires) && seconds > 0 && this.paymentResult() === 'confirming' ? 'gateway' : 'result');
      if (order.payment === 'STRIPE') {
        this.purchaseApi.verifyPayment(order.orderId || order.id, this.member() ? undefined : token)
          .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: (result) => {
              if (session !== this.auth.session() || this.order()?.orderId !== order.orderId) return;
              if (result.paid === true || result.payment_status === 'paid') {
                this.order.set({ ...order, paymentState: 'paid' });
                this.step.set('success');
              }
            },
            error: (error: Error) => { if (session === this.auth.session()) this.error.set(error.message || 'Chưa xác minh được thanh toán.'); },
          });
      }
    } catch (error) {
      if (session === this.auth.session()) this.error.set(error instanceof Error ? error.message : 'Chưa tải được đơn hàng.');
    } finally {
      if (session === this.auth.session()) { this.resumeLoading.set(false); this.busy.set(false); }
    }
  }

  /** Retry a failed order lookup while keeping checkout locked to that same existing order. */
  retryOrderLoad(): void {
    const id = this.route.snapshot.queryParamMap.get('order');
    if (!id || this.resumeLoading()) return;
    const saved = this.checkout.readCreatedOrder();
    const token = saved?.order_id === id || saved?.order_code === id ? saved.order_access_token : undefined;
    void this.resumeExistingOrder(id, token);
  }

  /** Edit in place; changing a guest phone immediately invalidates its previous OTP. */
  editField(
    field: 'name' | 'phone' | 'email' | 'province' | 'district' | 'ward' | 'detail' | 'note',
    value: string,
  ): void {
    this.address = { ...this.address, [field]: value };
    if (field === 'phone' && normalizePhone(value) !== this.otpPhone()) {
      clearTimeout(this.otpTimeout);
      this.sendingOtp.set(false);
      this.otpVerified.set(false);
      this.guestCheckoutToken = '';
      this.otpPhone.set('');
      this.digits.set(['', '', '', '', '', '']);
      this.otpError.set('');
    }
    if (this.fieldErrors()[field]) this.validateField(field);
  }
  /** Show field-specific errors without sending the customer to another screen. */
  validateField(field: string): void {
    this.fieldErrors.update((errors) => ({
      ...errors,
      [field]: this.addressErrors(this.address)[field] || '',
    }));
  }
  /** Send an inline OTP challenge for a captured phone number, retaining all delivery fields. */
  sendOtp(): void {
    if (this.busy() || this.sendingOtp() || this.resendSeconds() > 0) return;
    this.validateField('phone');
    if (!validPhone(this.address.phone)) return;
    const phone = normalizePhone(this.address.phone);
    this.sendingOtp.set(true);
    this.otpVerified.set(false);
    this.guestCheckoutToken = '';
    this.purchaseApi.sendOtp({
      full_name: this.address.name,
      phone,
      email: this.address.email,
    }).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => {
        if (phone !== normalizePhone(this.address.phone)) return;
        this.otpError.set(response.success === false ? response.message || 'Không thể gửi OTP.' : '');
        this.otpPhone.set(phone);
        this.seconds.set(60);
        this.resendSeconds.set(30);
        this.digits.set(['', '', '', '', '', '']);
        this.sendingOtp.set(false);
      },
      error: (error: Error) => {
        if (phone !== normalizePhone(this.address.phone)) return;
        this.sendingOtp.set(false);
        this.otpError.set(error.message || 'Không thể gửi OTP.');
      },
    });
  }
  /** Complete OTP verification inline; never advances to a separate delivery screen. */
  verify(): void {
    if (this.sendingOtp() || this.otpPhone() !== normalizePhone(this.address.phone)) return;
    const otp = this.digits().join('');
    this.otpVerified.set(false);
    if (!/^\d{6}$/.test(otp)) {
      this.otpError.set('Vui lòng nhập đủ mã OTP gồm 6 chữ số.');
      return;
    }
    this.sendingOtp.set(true);
    this.otpError.set('');
    const phone = this.otpPhone();
    this.purchaseApi.verifyOtp(phone, otp).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => {
        if (phone !== normalizePhone(this.address.phone)) return;
        this.guestCheckoutToken = response.success === true ? response.guest_checkout_token || '' : '';
        this.otpVerified.set(!!this.guestCheckoutToken);
        this.otpError.set(this.guestCheckoutToken ? '' : response.message || 'Chưa xác thực được số điện thoại. Vui lòng thử lại.');
        this.sendingOtp.set(false);
      },
      error: (error: Error) => {
        if (phone !== normalizePhone(this.address.phone)) return;
        this.otpVerified.set(false);
        this.otpError.set(error.message || 'Mã OTP không hợp lệ.');
        this.sendingOtp.set(false);
      },
    });
  }
  /** Open a native modal with a separate pending selection, keeping checkout unchanged until confirmed. */
  openAddressBook(): void {
    if (!this.member()) return;
    this.dialogMode.set('list');
    this.dialogErrors.set({});
    this.deletingAddress.set(-1);
    this.pendingAddress.set(
      this.bookEntries().findIndex((entry) => this.sameAddress(entry.address, this.address)),
    );
    this.addressDialog.nativeElement.showModal();
  }
  /** Closing or pressing Escape discards only the unapplied modal draft. */
  closeAddressBook(): void {
    this.addressDialog.nativeElement.close();
    this.dialogErrors.set({});
  }
  /** Start a new address or edit a copy so typing never mutates saved entries. */
  editAddress(entryIndex = -1): void {
    const entry = this.bookEntries()[entryIndex];
    this.editingAddress = entry?.savedIndex ?? -1;
    this.addressDraft = entry
      ? { ...entry.address }
      : {
          name: this.address.name,
          phone: this.address.phone,
          email: this.address.email,
          province: '',
          district: '',
          ward: '',
          detail: '',
        };
    this.saveDraft = true;
    this.draftDefault = !!entry?.address.isDefault;
    this.dialogErrors.set({});
    this.dialogMode.set('editor');
  }
  /** Return to the address list without applying unfinished edits. */
  backToAddresses(): void {
    this.dialogMode.set('list');
    this.dialogErrors.set({});
  }
  /** Confirm the pending saved or historical address and fill all delivery inputs at once. */
  applySelectedAddress(): void {
    const entry = this.bookEntries()[this.pendingAddress()];
    if (!entry) return;
    this.selectedAddress = entry.savedIndex ?? -1;
    this.applyAddress(entry.address);
    this.closeAddressBook();
  }
  /** Use a validated new address now, optionally saving it and its default preference. */
  async useDraftAddress(): Promise<void> {
    if (this.addressBusy() || !this.validateDraft()) return;
    this.addressBusy.set(true);
    try {
      this.selectedAddress = this.saveDraft
        ? await this.model.saveAddress({ ...this.addressDraft, isDefault: this.draftDefault }, this.editingAddress)
        : -1;
      this.applyAddress(this.addressDraft);
      this.closeAddressBook();
    } catch (error) { this.dialogErrors.set({ form: error instanceof Error ? error.message : 'Chưa lưu được địa chỉ.' }); }
    finally { this.addressBusy.set(false); }
  }
  /** Save an edited address to the book without silently changing the checkout recipient. */
  async saveAddressChanges(): Promise<void> {
    if (this.addressBusy() || !this.validateDraft()) return;
    this.addressBusy.set(true);
    try {
      const index = await this.model.saveAddress({ ...this.addressDraft, isDefault: this.draftDefault }, this.editingAddress);
      this.pendingAddress.set(index);
      this.dialogMode.set('list');
    } catch (error) { this.dialogErrors.set({ form: error instanceof Error ? error.message : 'Chưa lưu được địa chỉ.' }); }
    finally { this.addressBusy.set(false); }
  }
  /** Delete a confirmed saved entry; the currently entered delivery details remain intact. */
  async deleteSavedAddress(index: number): Promise<void> {
    if (this.addressBusy()) return;
    this.addressBusy.set(true);
    try {
      await this.model.removeAddress(index);
      this.deletingAddress.set(-1);
      this.pendingAddress.set(-1);
      if (this.selectedAddress === index) this.selectedAddress = -1;
      else if (this.selectedAddress > index) this.selectedAddress--;
    } catch (error) { this.dialogErrors.set({ form: error instanceof Error ? error.message : 'Chưa xóa được địa chỉ.' }); }
    finally { this.addressBusy.set(false); }
  }
  /** Select a default address on initial load while retaining this order's delivery note. */
  chooseAddress(index: number): void {
    const address = this.model.addresses()[index];
    if (address) {
      this.selectedAddress = index;
      this.applyAddress(address);
    }
  }
  /** Validate everything at the single final action, including ownership of the current phone. */
  validateCheckout(): boolean {
    const errors = this.addressErrors(this.address);
    this.fieldErrors.set(errors);
    if (Object.keys(errors).length) {
      this.error.set('Vui lòng kiểm tra các thông tin được đánh dấu bên dưới.');
      return false;
    }
    if (
      !this.member() &&
      (!this.otpVerified() || normalizePhone(this.address.phone) !== this.otpPhone())
    ) {
      this.otpError.set('Vui lòng xác thực SĐT trước khi hoàn tất đơn hàng.');
      this.error.set('Thông tin giao hàng đã được giữ lại. Bạn chỉ cần xác thực SĐT.');
      return false;
    }
    return true;
  }
  /** Chooses a real wallet voucher; repeat wallet emissions never start a quote loop. */
  selectVoucher(voucher: AppliedVoucher | null): void {
    const id = voucher?.voucher_id || null;
    if (id !== this.voucherId()) this.voucherId.set(id);
  }
  /** Persists a customer's explicit refusal so automatic best-selection cannot undo it. */
  declineVoucher(declined: boolean): void {
    this.voucherDeclined.set(declined);
    localStorage.setItem('checkout_voucher_declined', String(declined));
  }
  /** Reads authoritative prices and ignores an obsolete quote after an account or cart change. */
  refreshQuote(): void {
    if (!this.lines().length || this.order()) return;
    const version = ++this.quoteVersion;
    this.serverQuote.set(null);
    this.quoteLoading.set(true);
    this.quoteError.set('');
    this.vouchers.quote(this.lines(), this.shippingMethod(), { voucherId: this.voucherId(), decline: this.voucherDeclined() })
      .pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
        next: (quote) => {
          if (version !== this.quoteVersion) return;
          this.serverQuote.set(quote); this.quoteLoading.set(false);
          this.voucherNotice.set(quote.voucher_change?.reason_text || '');
        },
        error: (error: Error) => {
          if (version !== this.quoteVersion) return;
          this.quoteLoading.set(false); this.quoteError.set(error.message || 'Chưa tải được tổng thanh toán.');
        },
      });
  }
  /** Existing demo members may sign in; ownership verification still does not activate an account. */
  knownMemberPhone(): boolean {
    return this.model
      .orders()
      .some(
        (order) =>
          order.member &&
          normalizePhone(order.address.phone) === normalizePhone(this.address.phone),
      );
  }
  /** Support typing and pasting a six-digit code, advancing keyboard focus. */
  digit(index: number, event: Event): void {
    const input = event.target as HTMLInputElement;
    const value = input.value.replace(/\D/g, '');
    this.fillDigits(index, value);
    if (value)
      (
        input.parentElement?.children[Math.min(5, index + value.length)] as HTMLInputElement
      )?.focus();
  }
  /** Paste a full OTP without requiring six separate keystrokes. */
  paste(event: ClipboardEvent): void {
    event.preventDefault();
    this.fillDigits(0, event.clipboardData?.getData('text') || '');
  }
  /** Backspace moves to the previous empty code cell. */
  backspace(index: number, event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.value && index > 0)
      (input.parentElement?.children[index - 1] as HTMLInputElement)?.focus();
  }
  /** Tạo đơn thật đúng một lần qua API KAN-28 và giữ nguyên form nếu backend từ chối. */
  place(): void {
    if (this.resumeLocked() || this.busy() || this.order() || this.quoteLoading() || !this.serverQuote() || !this.validateCheckout()) return;
    this.busy.set(true);
    this.error.set('');
    const shippingAddress = [
      this.address.detail,
      this.address.ward,
      this.address.district,
      this.address.province,
    ].filter(Boolean).join(', ');
    const quote = this.quote();
    const payload: Record<string, unknown> = {
      shipping_name: this.address.name,
      shipping_phone: normalizePhone(this.address.phone),
      shipping_email: this.address.email,
      shipping_address: shippingAddress,
      shipping_province: this.address.province,
      shipping_district: this.address.district,
      shipping_ward: this.address.ward,
      shipping_method: this.shippingMethod(),
      shipping_fee: quote.shipping,
      subtotal: quote.subtotal,
      discount_amount: quote.discount,
      total_amount: quote.total,
      voucher_id: this.serverQuote()?.voucher?.voucher_id || null,
      decline_voucher: this.voucherDeclined(),
      payment_method: this.payment,
      items: this.lines(),
      save_address: this.member() && this.saveAddress,
      address_is_default: false,
      note: this.address.note || '',
    };
    const request = this.member()
      ? this.purchaseApi.checkoutMember(payload)
      : this.purchaseApi.checkoutGuest({
          ...payload,
          phone: normalizePhone(this.address.phone),
          otp_code: this.digits().join(''),
          guest_checkout_token: this.guestCheckoutToken,
          order: payload,
        });
    const userId = this.model.userId();
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => { if (userId === this.model.userId()) this.finishCheckout(response); },
      error: (error: Error) => {
        if (userId !== this.model.userId()) return;
        this.busy.set(false);
        if (error instanceof ApiRequestError && error.code === 'VOUCHER_CHANGED') { this.refreshQuote(); this.voucherNotice.set('Tổng thanh toán đã thay đổi. Vui lòng kiểm tra và xác nhận lại.'); }
        this.error.set(error.message || 'Chưa thể tạo đơn. Thông tin của bạn đã được giữ lại.');
      },
    });
  }

  /** Ánh xạ response API sang state trình bày của giao diện KAN-27. */
  private finishCheckout(response: PurchaseCheckoutResponse): void {
    if (!response.success || !response.order?.order_id) {
      this.busy.set(false);
      this.error.set(response.message || 'Chưa thể tạo đơn. Thông tin của bạn đã được giữ lại.');
      return;
    }
    const quote = this.quote();
    const order: DemoOrder = {
      id: response.order.order_code || response.order.order_id,
      orderId: response.order.order_id,
      member: this.member(),
      userId: this.model.userId() || undefined,
      address: { ...this.address },
      items: this.lines().map((line) => ({ ...line, returnCount: 0, availableQuantity: line.quantity })),
      status: this.payment === 'COD' ? 'pending' : 'pending_payment',
      payment: this.payment,
      paymentState: this.payment === 'COD' ? 'pending' : 'pending',
      subtotal: quote.subtotal,
      shipping: quote.shipping,
      discount: quote.discount,
      total: Number(response.order.total_amount ?? quote.total),
      voucher: quote.voucher,
      createdAt: new Date().toISOString(),
    };
    this.order.set(order);
    const paymentExpiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    this.checkout.saveCreatedOrder({
      order_id: response.order.order_id,
      order_code: response.order.order_code,
      payment_method: response.order.payment_method || this.payment,
      shipping_address: [this.address.detail, this.address.ward, this.address.district, this.address.province].filter(Boolean).join(', '),
      shipping_method: this.shippingMethod(),
      activation_required: response.activation_required === true,
      order_access_token: response.order_access_token,
      checkout_snapshot: order,
      payment_expires_at: this.payment !== 'COD' ? paymentExpiresAt : undefined,
    });
    this.checkout.completeCheckout(this.lines());
    this.busy.set(false);
    this.paymentSeconds.set(900);
    if (response.stripe?.url) {
      window.location.assign(response.stripe.url);
      return;
    }
    this.step.set(this.payment === 'COD' ? 'success' : 'result');
    if (this.payment !== 'COD') { this.paymentResult.set('failed'); this.error.set('Đơn đã lưu nhưng chưa mở được cổng thanh toán. Hãy thử lại trên cùng đơn.'); }
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { order: order.id },
      replaceUrl: true,
    });
  }
  /** An interrupted attempt does not establish either payment or fulfillment success. */
  result(result: 'failed' | 'cancelled' | 'expired'): void {
    const order = this.order();
    if (!order || this.busy()) return;
    this.paymentResult.set('confirming');
    this.step.set('result');
    this.busy.set(true);
    this.timeout = setTimeout(() => {
      const updated: DemoOrder = { ...order, paymentState: result, status: 'pending_payment' };
      this.order.set(updated);
      this.persistPaymentSnapshot(updated);
      this.paymentResult.set(result);
      this.busy.set(false);
    }, 800);
  }
  /** Retry the same payment; its order code remains unchanged. */
  retry(): void {
    const order = this.order();
    if (!order || this.busy()) return;
    this.busy.set(true);
    const userId = this.model.userId();
    this.purchaseApi.retryPayment(order.orderId || order.id, normalizePhone(this.address.phone), this.checkout.readCreatedOrder()?.order_access_token).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => { if (userId !== this.model.userId()) return; this.busy.set(false); if (response.stripe?.url) window.location.assign(response.stripe.url); else this.error.set(response.message || 'Chưa mở được phiên thanh toán mới.'); },
      error: (error: Error) => { if (userId !== this.model.userId()) return; this.busy.set(false); this.error.set(error.message); },
    });
  }
  /** Convert the existing unpaid order to COD. */
  useCod(): void {
    const order = this.order();
    if (!order || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const userId = this.model.userId();
    this.purchaseApi.switchToCod(order.orderId || order.id, normalizePhone(this.address.phone), this.checkout.readCreatedOrder()?.order_access_token).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (response) => {
        if (userId !== this.model.userId()) return;
        if (response.success !== true) {
          this.busy.set(false);
          this.error.set(response.message || 'Chưa thể chuyển đơn sang COD.');
          return;
        }
        const codOrder: DemoOrder = {
          ...order,
          payment: 'COD',
          paymentState: 'pending',
          status: 'pending',
        };
        this.order.set(codOrder);
        this.persistPaymentSnapshot(codOrder);
        this.busy.set(false);
        this.step.set('success');
      },
      error: (error: Error) => {
        if (userId !== this.model.userId()) return;
        this.busy.set(false);
        this.error.set(error.message || 'Chưa thể chuyển đơn sang COD.');
      },
    });
  }

  /** Đồng bộ trạng thái màn thanh toán để reload không rơi về giỏ hàng trống. */
  private persistPaymentSnapshot(order: DemoOrder, expiresAt?: string): void {
    const saved = this.checkout.readCreatedOrder();
    if (!saved) return;
    this.checkout.saveCreatedOrder({
      ...saved,
      checkout_snapshot: order,
      payment_expires_at: expiresAt ?? saved.payment_expires_at,
    });
  }
  private fillDigits(index: number, value: string): void {
    const digits = [...this.digits()];
    const clean = value.replace(/\D/g, '').slice(0, 6 - index);
    if (!clean) digits[index] = '';
    [...clean].forEach((digit, offset) => (digits[index + offset] = digit));
    this.digits.set(digits);
    if (digits.join('').length === 6) this.verify();
  }
  private applyAddress(address: DemoAddress): void {
    this.address = {
      ...address,
      email: address.email || this.address.email,
      note: this.address.note || '',
    };
    this.fieldErrors.set({});
    this.error.set('');
  }
  private validateDraft(): boolean {
    const errors = this.addressErrors(this.addressDraft);
    this.dialogErrors.set(errors);
    return !Object.keys(errors).length;
  }
  /** Persist verified administrative names while clearing invalid parent-child selections. */
  updateGeography(selection: AddressGeographySelection): void {
    this.address = { ...this.address, province: selection.province, district: selection.district, ward: selection.ward };
    this.addressGeographyValid.set(selection.valid);
    this.addressGeographyMode.set(selection.mode);
  }

  /** Keep the address editor's validity separate from the checkout delivery address. */
  updateDraftGeography(selection: AddressGeographySelection): void {
    this.addressDraft = { ...this.addressDraft, province: selection.province, district: selection.district, ward: selection.ward };
    this.draftGeographyValid.set(selection.valid);
    this.draftGeographyMode.set(selection.mode);
  }

  private addressErrors(address: DemoAddress): Record<string, string> {
    const errors: Record<string, string> = {};
    const required = {
      name: 'họ tên người nhận',
      province: 'tỉnh / thành phố',
      ward: 'phường / xã',
      detail: 'địa chỉ cụ thể',
    } as const;
    const draft = address === this.addressDraft;
    if ((draft ? this.draftGeographyMode() : this.addressGeographyMode()) === 'legacy' && !address.district.trim()) errors['district'] = 'Vui lòng chọn quận / huyện trong địa chỉ cũ.';
    if (!(draft ? this.draftGeographyValid() : this.addressGeographyValid())) errors['ward'] = 'Vui lòng chọn đầy đủ địa phương hợp lệ.';
    for (const [key, label] of Object.entries(required))
      if (!address[key as keyof typeof required].trim()) errors[key] = `Vui lòng nhập ${label}.`;
    if (address.name.trim() && address.name.trim().split(/\s+/).length < 2)
      errors['name'] = 'Họ và tên phải có ít nhất 2 từ.';
    if (!validPhone(address.phone)) errors['phone'] = 'Nhập SĐT Việt Nam hợp lệ (10 số hoặc +84).';
    if (address.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.email))
      errors['email'] = 'Email chưa đúng định dạng.';
    return errors;
  }
  private sameAddress(a: DemoAddress, b: DemoAddress): boolean {
    return ['name', 'phone', 'province', 'district', 'ward', 'detail'].every(
      (key) => a[key as keyof DemoAddress] === b[key as keyof DemoAddress],
    );
  }
  private prefillDefault(): void {
    const index = this.model.addresses().findIndex((address) => address.isDefault);
    if (index >= 0 && this.member()) this.chooseAddress(index);
  }
}
