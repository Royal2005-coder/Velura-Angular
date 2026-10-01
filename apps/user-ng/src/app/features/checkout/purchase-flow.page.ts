import {
  Component,
  DestroyRef,
  ElementRef,
  ViewChild,
  effect,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';
import { CheckoutStore } from '../../core/services/checkout.store';
import {
  DEMO_LINES,
  DemoAddress,
  DemoOrder,
  PurchaseDemoStore,
  maskPhone,
  normalizePhone,
  validPhone,
} from '../../core/services/purchase-demo.store';
import { formatVnd, toPublicAsset } from '../../core/utils/money';

/** A single-page checkout with inline guest verification and a member address book; all mutations stay inside the demonstration Model. */
@Component({
  selector: 'app-purchase-flow',
  imports: [FormsModule, RouterLink],
  templateUrl: './purchase-flow.page.html',
  styleUrls: [
    '../shared/purchase-flow.css',
    '../shared/purchase-flow-forms.css',
    '../shared/purchase-flow-layout.css',
    '../shared/purchase-flow-responsive.css',
  ],
})
export class PurchaseFlowPage {
  readonly model = inject(PurchaseDemoStore);
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
  readonly quote = computed(() => this.order() || this.model.quote(this.lines()));
  readonly busy = signal(false);
  readonly error = signal('');
  readonly seconds = signal(300);
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
  readonly dialogMode = signal<'list' | 'editor'>('list');
  readonly pendingAddress = signal(-1);
  readonly deletingAddress = signal(-1);
  readonly clockLabel = computed(
    () =>
      `${Math.floor(this.seconds() / 60)
        .toString()
        .padStart(2, '0')}:${(this.seconds() % 60).toString().padStart(2, '0')}`,
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
  payment: 'COD' | 'VNPAY' = 'COD';
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
  password = '';
  confirmation = '';
  simulateFailure = false;
  invitationExpired = false;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private otpTimeout: ReturnType<typeof setTimeout> | undefined;

  constructor() {
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

    const existing = this.model
      .orders()
      .find((order) => order.id === this.route.snapshot.queryParamMap.get('order'));
    const canResume = existing && this.model.canAccess(existing);
    if (existing && !canResume) {
      void this.router.navigate(['/account/track'], {
        queryParams: { order: existing.id },
        replaceUrl: true,
      });
    } else if (existing && existing.status === 'cancelled') {
      void this.router.navigate(
        [this.member() ? '/account/orders' : '/guest/orders', existing.id],
        { replaceUrl: true },
      );
    } else if (existing) {
      this.order.set(existing);
      this.lines.set(existing.items);
      this.address = { ...existing.address };
      this.step.set(
        existing.payment === 'VNPAY' && existing.paymentState !== 'paid' ? 'gateway' : 'success',
      );
    }
    const timer = setInterval(() => {
      this.seconds.update((value) => Math.max(0, value - 1));
      this.resendSeconds.update((value) => Math.max(0, value - 1));
      if (this.step() === 'gateway' && this.seconds() === 0 && !this.busy()) this.result('expired');
    }, 1000);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      clearTimeout(this.timeout);
      clearTimeout(this.otpTimeout);
    });
    if (!existing) this.prefillDefault();
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
    if (this.busy() || this.sendingOtp()) return;
    this.validateField('phone');
    if (!validPhone(this.address.phone)) return;
    const phone = normalizePhone(this.address.phone);
    try {
      this.model.sendOtp(phone);
      this.otpError.set('');
      this.sendingOtp.set(true);
      this.otpVerified.set(false);
      this.otpPhone.set(phone);
      this.otpTimeout = setTimeout(() => {
        this.seconds.set(300);
        this.resendSeconds.set(30);
        this.digits.set(['', '', '', '', '', '']);
        this.sendingOtp.set(false);
      }, 400);
    } catch (error) {
      this.otpError.set((error as Error).message);
    }
  }
  /** Complete OTP verification inline; never advances to a separate delivery screen. */
  verify(): void {
    if (this.sendingOtp() || this.otpPhone() !== normalizePhone(this.address.phone)) return;
    try {
      this.model.verifyOtp(this.digits().join(''));
      this.otpVerified.set(true);
      this.otpError.set('');
    } catch (error) {
      this.otpVerified.set(false);
      this.otpError.set((error as Error).message);
    }
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
  useDraftAddress(): void {
    if (!this.validateDraft()) return;
    this.selectedAddress = this.saveDraft
      ? this.model.saveAddress(
          { ...this.addressDraft, isDefault: this.draftDefault },
          this.editingAddress,
        )
      : -1;
    this.applyAddress(this.addressDraft);
    this.closeAddressBook();
  }
  /** Save an edited address to the book without silently changing the checkout recipient. */
  saveAddressChanges(): void {
    if (!this.validateDraft()) return;
    const index = this.model.saveAddress(
      { ...this.addressDraft, isDefault: this.draftDefault },
      this.editingAddress,
    );
    this.pendingAddress.set(index);
    this.dialogMode.set('list');
  }
  /** Delete a confirmed saved entry; the currently entered delivery details remain intact. */
  deleteSavedAddress(index: number): void {
    this.model.removeAddress(index);
    this.deletingAddress.set(-1);
    this.pendingAddress.set(-1);
    if (this.selectedAddress === index) this.selectedAddress = -1;
    else if (this.selectedAddress > index) this.selectedAddress--;
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
      (!this.otpVerified() || normalizePhone(this.address.phone) !== this.model.verifiedPhone())
    ) {
      this.otpError.set('Vui lòng xác thực SĐT trước khi hoàn tất đơn hàng.');
      this.error.set('Thông tin giao hàng đã được giữ lại. Bạn chỉ cần xác thực SĐT.');
      return false;
    }
    return true;
  }
  /** Provide sample products only after the reviewer explicitly chooses them. */
  useSample(): void {
    this.lines.set(DEMO_LINES.map((line) => ({ ...line })));
  }
  /** A changed voucher immediately reprices the review, requiring the customer to confirm it. */
  expireVoucher(): void {
    this.model.voucherAvailable.set(false);
    this.voucherNotice.set(
      'Voucher vừa hết lượt. Tổng thanh toán đã được cập nhật; vui lòng kiểm tra lại trước khi đặt hàng.',
    );
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
  /** Place a simulated order once, retaining the draft on failure. */
  place(): void {
    if (this.busy() || this.order() || !this.validateCheckout()) return;
    this.busy.set(true);
    this.error.set('');
    this.timeout = setTimeout(() => {
      try {
        if (this.simulateFailure)
          throw new Error('Chưa thể tạo đơn. Thông tin của bạn đã được giữ lại, vui lòng thử lại.');
        if (this.stockProblem())
          throw new Error('Sản phẩm vừa thay đổi tồn kho. Vui lòng chỉnh sửa giỏ hàng.');
        const order = this.model.place(this.lines(), this.address, this.payment);
        if (this.member() && this.saveAddress) {
          this.selectedAddress = this.model.saveAddress(this.address, this.selectedAddress);
          this.saveAddress = false;
        }
        this.order.set(order);
        this.step.set(this.payment === 'COD' ? 'success' : 'gateway');
        this.seconds.set(300);
        void this.router.navigate([], {
          relativeTo: this.route,
          queryParams: { order: order.id },
          replaceUrl: true,
        });
      } catch (error) {
        this.error.set((error as Error).message);
      } finally {
        this.busy.set(false);
      }
    }, 450);
  }
  /** Model the payment return delay before displaying a verified demo result. */
  result(result: 'paid' | 'failed' | 'cancelled' | 'expired'): void {
    const order = this.order();
    if (!order || this.busy()) return;
    this.paymentResult.set('confirming');
    this.step.set('result');
    this.busy.set(true);
    this.timeout = setTimeout(() => {
      this.model.paymentResult(order.id, result);
      this.order.set(this.model.orders().find((row) => row.id === order.id) || null);
      this.paymentResult.set(result);
      this.busy.set(false);
      if (result === 'paid') this.step.set('success');
    }, 800);
  }
  /** Retry the same payment; its order code remains unchanged. */
  retry(): void {
    const order = this.order();
    if (order) this.model.paymentResult(order.id, 'pending');
    this.seconds.set(300);
    this.step.set('gateway');
  }
  /** Convert the existing unpaid order to COD. */
  useCod(): void {
    const order = this.order();
    if (!order) return;
    this.model.useCod(order.id);
    this.order.set(this.model.orders().find((row) => row.id === order.id) || null);
    this.step.set('success');
  }
  /** An invitation is optional and demo activation never writes a real password. */
  activate(): void {
    if (this.invitationExpired) {
      this.error.set('Liên kết đã hết hạn. Vui lòng yêu cầu liên kết mới.');
      return;
    }
    if (this.password.length < 8 || this.password !== this.confirmation) {
      this.error.set('Mật khẩu cần ít nhất 8 ký tự và xác nhận phải khớp.');
      return;
    }
    try {
      this.model.activateAccount(this.address.phone);
    } catch (error) {
      this.error.set((error as Error).message);
      return;
    }
    this.password = '';
    this.confirmation = '';
    this.error.set('');
    this.step.set('activated');
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
  private addressErrors(address: DemoAddress): Record<string, string> {
    const errors: Record<string, string> = {};
    const required = {
      name: 'họ tên người nhận',
      province: 'tỉnh / thành phố',
      district: 'quận / huyện',
      ward: 'phường / xã',
      detail: 'địa chỉ cụ thể',
    } as const;
    for (const [key, label] of Object.entries(required))
      if (!address[key as keyof typeof required].trim()) errors[key] = `Vui lòng nhập ${label}.`;
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
