import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { AuthService } from './auth.service';
import { CartLine } from './cart.store';
import { isGuestPreview, isPreviewMode, isUserPreview } from '../utils/preview-mode';

/** Frontend-only order states; never interpreted as a real payment or fulfillment. */
export type DemoOrderStatus =
  | 'pending_payment'
  | 'pending'
  | 'paid'
  | 'confirmed'
  | 'preparing'
  | 'shipping'
  | 'delivered'
  | 'cancelled';
/** Delivery details for a demo customer; addresses are only kept in this tab. */
export interface DemoAddress {
  name: string;
  phone: string;
  email: string;
  province: string;
  district: string;
  ward: string;
  detail: string;
  note?: string;
  isDefault?: boolean;
}
/** A purchased line carries its own return entitlement, independent of other lines. */
export interface DemoOrderLine extends CartLine {
  returnCount: number;
  availableQuantity: number;
}
/** Demo orders are isolated from the production cart, account and API. */
export interface DemoOrder {
  id: string;
  member: boolean;
  /** Account ownership is independent of the delivery phone; absent for Guest orders. */
  userId?: string;
  address: DemoAddress;
  items: DemoOrderLine[];
  status: DemoOrderStatus;
  payment: 'COD' | 'VNPAY';
  paymentState: 'pending' | 'paid' | 'failed' | 'expired' | 'cancelled';
  subtotal: number;
  shipping: number;
  discount: number;
  total: number;
  voucher: string;
  createdAt: string;
  deliveredAt?: string;
  refund?: 'pending' | 'completed';
  refundCompletedAt?: string;
  cancellationReason?: string;
}
/** Each selected return line preserves the original variant and optional replacement. */
export interface DemoReturnLine {
  variantId: string;
  quantity: number;
  replacement?: string;
}
/** A return request follows the BA contact, inbound parcel and refund/exchange timeline. */
export interface DemoReturn {
  id: string;
  orderId: string;
  kind: 'refund' | 'exchange';
  items: DemoReturnLine[];
  reason: string;
  evidenceNames: string[];
  stage: number;
  createdAt: string;
  completedAt?: string;
  bank?: { name: string; last4: string; holder: string };
  replacementUnavailable?: boolean;
}
/** Named fixtures make frontend reviews repeatable without a running backend. */
export const DEMO_LINES: CartLine[] = [
  {
    product_id: 'demo-linen',
    variant_id: 'demo-linen-M-Kem',
    product_name: 'Áo sơ mi Linen',
    product_image: '/assets/images/placeholder.jpg',
    size: 'M',
    color: 'Kem',
    quantity: 1,
    unit_price: 390000,
  },
  {
    product_id: 'demo-skirt',
    variant_id: 'demo-skirt-S-Nâu',
    product_name: 'Chân váy dáng A',
    product_image: '/assets/images/placeholder.jpg',
    size: 'S',
    color: 'Nâu',
    quantity: 1,
    unit_price: 450000,
  },
];
export const ORDER_LABELS: Record<DemoOrderStatus, string> = {
  pending_payment: 'Chờ thanh toán',
  pending: 'Chờ xác nhận',
  paid: 'Đã thanh toán',
  confirmed: 'Đã xác nhận',
  preparing: 'Đang chuẩn bị hàng',
  shipping: 'Đang giao hàng',
  delivered: 'Giao hàng thành công',
  cancelled: 'Đã hủy',
};
/** Vietnam mobile numbers accept domestic or +84 notation and normalize to domestic. */
export function normalizePhone(value: string): string {
  return value.replace(/[\s.-]/g, '').replace(/^\+84/, '0');
}
/** Validation is for UI feedback only; a future backend must verify ownership. */
export function validPhone(value: string): boolean {
  return /^0[35789]\d{8}$/.test(normalizePhone(value));
}
/** OTP delivery notices hide exactly the final three digits. */
export function maskPhone(value: string): string {
  return normalizePhone(value).slice(0, -3) + '***';
}
/** Cancellation ends as soon as preparation begins, including paid online orders. */
export function canCancel(order: DemoOrder): boolean {
  return ['pending_payment', 'pending', 'paid', 'confirmed'].includes(order.status);
}
/** Missing delivery dates fail closed; the inclusive window is 30 elapsed days. */
export function withinReturnWindow(order: DemoOrder, now = Date.now()): boolean {
  const age = now - Date.parse(order.deliveredAt || '');
  return order.status === 'delivered' && Number.isFinite(age) && age >= 0 && age <= 30 * 86400000;
}
/** Session-only simulation Model. No API mutations, authentication tokens or real bank data. */
@Injectable({ providedIn: 'root' })
export class PurchaseDemoStore {
  private readonly auth = inject(AuthService);
  readonly userId = computed(() => this.auth.session()?.userId || null);
  readonly member = computed(() => this.userId() !== null);
  readonly orders = signal<DemoOrder[]>(this.readOrders());
  readonly requests = signal<DemoReturn[]>(
    this.read<DemoReturn[]>('returns', []).filter((request) =>
      this.orders().some((order) => order.id === request.orderId),
    ),
  );
  private readonly addressBooks = signal<Record<string, DemoAddress[]>>(
    this.readAddressBooks(),
  );
  readonly addresses = computed(() => {
    const id = this.userId();
    return id ? this.addressBooks()[id] || [] : [];
  });
  readonly verifiedPhone = signal('');
  readonly voucherAvailable = signal(true);
  readonly activeOrderId = signal(this.read<string>('active', ''));
  readonly activeOrder = computed(
    () => this.orders().find((order) => order.id === this.activeOrderId()) || null,
  );
  private otpPhone = '';
  private otpExpires = 0;
  private resendAt = 0;
  private attempts = 0;

  constructor() {
    let session = this.auth.session();
    effect(() => {
      const current = this.auth.session();
      if (current !== session) {
        session = current;
        this.verifiedPhone.set('');
        this.otpPhone = '';
        this.otpExpires = 0;
        this.resendAt = 0;
      }
    });
    // Unscoped legacy records cannot safely be assigned to a signed-in account.
    sessionStorage.removeItem('velura-ui-demo-addresses');
    sessionStorage.removeItem('velura-ui-demo-active');
    if (!isPreviewMode()) this.persist();
  }

  /** Frontend access contract; a future API must independently enforce ownership. */
  ownsOrder(order: DemoOrder): boolean {
    return this.member() && order.userId === this.userId();
  }

  /** Guest OTP grants access only to Guest orders of the verified phone, never an account. */
  canAccess(order: DemoOrder): boolean {
    return this.member()
      ? this.ownsOrder(order)
      : !order.member && this.verifiedPhone() === normalizePhone(order.address.phone);
  }

  /** Start an isolated six-digit challenge; no SMS is sent. */
  sendOtp(phone: string): void {
    if (!validPhone(phone)) throw new Error('Nhập SĐT Việt Nam hợp lệ, ví dụ 0901234567.');
    if (Date.now() < this.resendAt) throw new Error('Vui lòng chờ trước khi gửi lại mã.');
    this.verifiedPhone.set('');
    this.otpPhone = normalizePhone(phone);
    this.otpExpires = Date.now() + 300000;
    this.resendAt = Date.now() + 30000;
    this.attempts = 0;
  }
  /** Accept only the displayed demo code, with expiry and attempt limits. */
  verifyOtp(code: string): void {
    if (!this.otpPhone || Date.now() >= this.otpExpires)
      throw new Error('Mã đã hết hạn. Vui lòng gửi lại.');
    if (this.attempts >= 5) throw new Error('Đã nhập sai quá 5 lần. Vui lòng gửi lại mã.');
    this.attempts++;
    if (code !== '123456') throw new Error('Mã OTP không đúng. Vui lòng kiểm tra lại.');
    this.verifiedPhone.set(this.otpPhone);
  }
  /** Reviewable fixture offers; largest valid discount wins without stacking. */
  quote(items: CartLine[]): {
    subtotal: number;
    shipping: number;
    discount: number;
    total: number;
    voucher: string;
  } {
    const subtotal = items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
    const shipping = subtotal >= 500000 ? 0 : 30000;
    const offers = this.voucherAvailable()
      ? [
          {
            amount: subtotal >= 500000 ? Math.min(100000, Math.round(subtotal * 0.1)) : 0,
            label: 'Giảm 10%, tối đa 100.000đ',
          },
          { amount: subtotal >= 300000 ? 30000 : 0, label: 'Giảm 30.000đ' },
        ]
      : [];
    const best = offers.sort((a, b) => b.amount - a.amount)[0];
    const discount = best?.amount || 0;
    return {
      subtotal,
      shipping,
      discount,
      total: subtotal + shipping - discount,
      voucher: discount ? best.label : 'Chưa có voucher phù hợp',
    };
  }
  /** Save a demo address, keeping at most one default. */
  saveAddress(address: DemoAddress, index = -1): number {
    const userId = this.userId();
    if (!userId) throw new Error('Chỉ tài khoản đã đăng nhập mới có sổ địa chỉ.');
    const rows = this.addresses();
    const editing = index >= 0 && index < rows.length;
    const next = { ...address, note: undefined, isDefault: address.isDefault || !rows.length };
    const updated = rows.map((row, position) =>
      editing && position === index
        ? next
        : { ...row, isDefault: next.isDefault ? false : row.isDefault },
    );
    if (!editing) updated.push(next);
    if (!updated.some((row) => row.isDefault)) updated[0] = { ...updated[0], isDefault: true };
    this.addressBooks.update((books) => ({ ...books, [userId]: updated }));
    this.persist();
    return editing ? index : updated.length - 1;
  }
  /** Remove only a saved address; historical orders retain their own delivery snapshot. */
  removeAddress(index: number): void {
    const userId = this.userId();
    if (!userId) return;
    const rows = this.addresses().filter((_, position) => position !== index);
    if (rows.length && !rows.some((row) => row.isDefault))
      rows[0] = { ...rows[0], isDefault: true };
    this.addressBooks.update((books) => ({ ...books, [userId]: rows }));
    this.persist();
  }
  /** Preview activation only: never create a login or convert Guest orders into account orders. */
  activateAccount(phone: string): void {
    if (this.verifiedPhone() !== normalizePhone(phone))
      throw new Error('Vui lòng xác thực lại SĐT trước khi kích hoạt.');
  }
  /** Create exactly one simulated order after the customer reviews the final total. */
  place(items: CartLine[], address: DemoAddress, payment: 'COD' | 'VNPAY'): DemoOrder {
    if (
      !items.length ||
      items.some((item) => !Number.isInteger(item.quantity) || item.quantity < 1)
    )
      throw new Error('Giỏ hàng chưa hợp lệ.');
    if (!this.member() && this.verifiedPhone() !== normalizePhone(address.phone))
      throw new Error('Vui lòng xác thực lại SĐT.');
    const order: DemoOrder = {
      id: `DEMO-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      member: this.member(),
      userId: this.userId() || undefined,
      address: { ...address },
      items: items.map((item) => ({ ...item, returnCount: 0, availableQuantity: item.quantity })),
      payment,
      status: payment === 'COD' ? 'pending' : 'pending_payment',
      paymentState: 'pending',
      ...this.quote(items),
      createdAt: new Date().toISOString(),
    };
    this.orders.update((rows) => [order, ...rows]);
    this.activeOrderId.set(order.id);
    this.persist();
    return order;
  }
  /** A retry changes payment state on the same order; never creates another order. */
  paymentResult(id: string, result: DemoOrder['paymentState']): void {
    this.update(id, (order) => {
      if (order.status === 'cancelled' || order.paymentState === 'paid') return order;
      return {
        ...order,
        paymentState: result,
        status: result === 'paid' ? 'paid' : 'pending_payment',
      };
    });
  }
  /** Switch an unpaid online order to COD while preserving its order ID. */
  useCod(id: string): void {
    this.update(id, (order) =>
      order.paymentState === 'paid' || order.status === 'cancelled'
        ? order
        : { ...order, payment: 'COD', status: 'pending', paymentState: 'pending' },
    );
  }
  /** Recheck eligibility at confirmation to model an admin/customer status race. */
  cancel(id: string, reason: string): void {
    this.update(id, (order) => {
      if (!canCancel(order))
        throw new Error('Đơn hàng đã được chuẩn bị và không thể hủy tại thời điểm này.');
      return {
        ...order,
        status: 'cancelled',
        cancellationReason: reason,
        refund: order.payment === 'VNPAY' && order.paymentState === 'paid' ? 'pending' : undefined,
      };
    });
  }
  /** Reviewer control to exercise fulfillment, cancellation and deadline states. */
  scenario(id: string, status: DemoOrderStatus, days = 0): void {
    this.update(id, (order) => ({
      ...order,
      status,
      deliveredAt:
        status === 'delivered' ? new Date(Date.now() - days * 86400000).toISOString() : undefined,
    }));
  }
  /** Demo replacements belong to the same product; an unavailable size is omitted. */
  replacements(line: CartLine): string[] {
    return ['S / Kem', 'M / Kem', 'L / Kem', 'S / Nâu', 'M / Nâu'].filter(
      (value) => value !== `${line.size} / ${line.color}`,
    );
  }
  /** Validate each entitlement again and reserve quantities for the active request. */
  createReturn(
    orderId: string,
    kind: DemoReturn['kind'],
    items: DemoReturnLine[],
    reason: string,
    evidenceNames: string[],
  ): DemoReturn {
    const order = this.orders().find((row) => row.id === orderId);
    if (!order || !this.canAccess(order))
      throw new Error('Vui lòng xác thực chủ đơn trước khi thao tác.');
    if (!order || !withinReturnWindow(order))
      throw new Error('Đã hết thời hạn đổi/trả hoặc đơn chưa giao thành công.');
    if (!items.length || new Set(items.map((item) => item.variantId)).size !== items.length)
      throw new Error('Chọn sản phẩm muốn đổi/trả.');
    for (const item of items) {
      const line = order.items.find((row) => row.variant_id === item.variantId);
      if (
        !line ||
        line.returnCount >= 2 ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > line.availableQuantity
      )
        throw new Error('Sản phẩm đã hết lượt hoặc số lượng không hợp lệ.');
      if (kind === 'exchange' && !this.replacements(line).includes(item.replacement || ''))
        throw new Error('Chọn size/màu thay thế còn hàng.');
    }
    const request: DemoReturn = {
      id: `RET-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
      orderId,
      kind,
      items,
      reason,
      evidenceNames,
      stage: 0,
      createdAt: new Date().toISOString(),
    };
    this.update(orderId, (current) => ({
      ...current,
      items: current.items.map((line) => {
        const selected = items.find((item) => item.variantId === line.variant_id);
        return selected
          ? {
              ...line,
              returnCount: line.returnCount + 1,
              availableQuantity: line.availableQuantity - selected.quantity,
            }
          : line;
      }),
    }));
    this.requests.update((rows) => [request, ...rows]);
    this.persist();
    return request;
  }
  /** Display the common inbound timeline followed by the selected resolution branch. */
  timeline(kind: DemoReturn['kind']): string[] {
    return [
      'Đã ghi nhận',
      'Velura đang liên hệ',
      'Chờ gửi hàng',
      'Hàng đang về Velura',
      'Velura đã nhận hàng',
      ...(kind === 'refund'
        ? ['Đang hoàn tiền', 'Đã hoàn tiền']
        : ['Đang chuẩn bị hàng đổi', 'Hàng đổi đang giao', 'Hoàn tất']),
    ];
  }
  /** Reviewer progression keeps COD refunds pending until recipient details are supplied. */
  advanceRequest(id: string): void {
    this.assertRequestAccess(id);
    const request = this.requests().find((row) => row.id === id);
    if (
      !request ||
      request.stage >= this.timeline(request.kind).length - 1 ||
      request.replacementUnavailable
    )
      return;
    const order = this.orders().find((row) => row.id === request.orderId);
    if (
      request.kind === 'refund' &&
      order?.payment === 'COD' &&
      request.stage >= 4 &&
      !request.bank
    )
      throw new Error('Vui lòng bổ sung thông tin nhận hoàn tiền.');
    const nextStage = request.stage + 1;
    this.requests.update((rows) =>
      rows.map((row) =>
        row.id === id
          ? {
              ...row,
              stage: nextStage,
              completedAt:
                nextStage === this.timeline(row.kind).length - 1
                  ? new Date().toISOString()
                  : undefined,
            }
          : row,
      ),
    );
    if (request.kind === 'exchange' && nextStage === this.timeline('exchange').length - 1) {
      this.update(request.orderId, (current) => ({
        ...current,
        items: current.items.map((line) => {
          const item = request.items.find((selected) => selected.variantId === line.variant_id);
          return item
            ? { ...line, availableQuantity: line.availableQuantity + item.quantity }
            : line;
        }),
      }));
    }
    this.persist();
  }
  /** Store only masked demonstration bank details after customer-service contact. */
  saveBank(id: string, name: string, account: string, holder: string): void {
    this.assertRequestAccess(id);
    if (!name.trim() || !/^\d{6,20}$/.test(account) || !holder.trim())
      throw new Error('Vui lòng nhập ngân hàng, số tài khoản 6–20 số và tên chủ tài khoản.');
    this.requests.update((rows) =>
      rows.map((row) =>
        row.id === id ? { ...row, bank: { name, last4: account.slice(-4), holder } } : row,
      ),
    );
    this.persist();
  }
  /** Reviewer can exercise the replacement stock conflict and the refund fallback. */
  replacementConflict(id: string, refund = false): void {
    this.assertRequestAccess(id);
    this.requests.update((rows) =>
      rows.map((row) =>
        row.id === id
          ? { ...row, replacementUnavailable: !refund, kind: refund ? 'refund' : row.kind }
          : row,
      ),
    );
    this.persist();
  }
  /** Resolve an exchange shortage with another available variant of that same item. */
  replaceUnavailable(id: string, variantId: string, replacement: string): void {
    this.assertRequestAccess(id);
    const request = this.requests().find((row) => row.id === id);
    const line = this.orders()
      .find((row) => row.id === request?.orderId)
      ?.items.find((item) => item.variant_id === variantId);
    if (!request || !line || !this.replacements(line).includes(replacement))
      throw new Error('Chọn variant còn hàng của cùng sản phẩm.');
    this.requests.update((rows) =>
      rows.map((row) =>
        row.id === id
          ? {
              ...row,
              replacementUnavailable: false,
              items: row.items.map((item) =>
                item.variantId === variantId ? { ...item, replacement } : item,
              ),
            }
          : row,
      ),
    );
    this.persist();
  }
  /** Complete a simulated cancellation refund without claiming a bank transaction. */
  finishRefund(id: string): void {
    this.update(id, (order) => ({
      ...order,
      refund: order.refund === 'pending' ? 'completed' : order.refund,
      refundCompletedAt:
        order.refund === 'pending' ? new Date().toISOString() : order.refundCompletedAt,
    }));
  }
  private update(id: string, change: (order: DemoOrder) => DemoOrder): void {
    const order = this.orders().find((row) => row.id === id);
    if (!order || !this.canAccess(order))
      throw new Error('Vui lòng xác thực chủ đơn trước khi thao tác.');
    this.orders.update((rows) => rows.map((order) => (order.id === id ? change(order) : order)));
    this.persist();
  }
  private assertRequestAccess(id: string): void {
    const request = this.requests().find((row) => row.id === id);
    const order = this.orders().find((row) => row.id === request?.orderId);
    if (!order || !this.canAccess(order))
      throw new Error('Vui lòng xác thực chủ đơn trước khi thao tác.');
  }
  private persist(): void {
    if (isPreviewMode()) return;
    for (const [key, value] of Object.entries({
      orders: isPreviewMode() ? this.orders() : this.orders().filter((order) => !!order.userId),
      returns: this.requests().filter((request) =>
        this.orders().some((order) => order.id === request.orderId && (isPreviewMode() || !!order.userId)),
      ),
      'address-books': this.addressBooks(),
    }))
      sessionStorage.setItem(`velura-ui-demo-${key}`, JSON.stringify(value));
  }

  private readOrders(): DemoOrder[] {
    const stored = this.read<DemoOrder[]>('orders', []);
    if (!isPreviewMode()) return stored.filter((order) => !!order.userId);
    const fixture = this.previewOrder(isUserPreview());
    return [fixture, ...stored.filter((order) => order.id !== fixture.id)];
  }

  private readAddressBooks(): Record<string, DemoAddress[]> {
    const books = this.read<Record<string, DemoAddress[]>>('address-books', {});
    if (isUserPreview() && !books['preview-user-001']) {
      books['preview-user-001'] = [
        {
          name: 'Nguyễn An',
          phone: '0901234567',
          email: 'nguyenan@example.com',
          province: 'TP. Hồ Chí Minh',
          district: 'TP. Thủ Đức',
          ward: 'Thảo Điền',
          detail: '28 Nguyễn Văn Hưởng',
          isDefault: true,
        },
      ];
    }
    return books;
  }

  private previewOrder(userOrder: boolean): DemoOrder {
    const items = DEMO_LINES.map((item) => ({
      ...item,
      returnCount: 0,
      availableQuantity: item.quantity,
    }));
    const delivered = isGuestPreview() || window.location.pathname.includes('returns');
    return {
      id: userOrder ? 'PREVIEW-USER-001' : 'PREVIEW-GUEST-001',
      member: userOrder,
      userId: userOrder ? 'preview-user-001' : undefined,
      address: {
        name: 'Nguyễn An',
        phone: '0901234567',
        email: 'nguyenan@example.com',
        province: 'TP. Hồ Chí Minh',
        district: 'TP. Thủ Đức',
        ward: 'Thảo Điền',
        detail: '28 Nguyễn Văn Hưởng',
      },
      items,
      status: delivered ? 'delivered' : 'pending',
      payment: 'COD',
      paymentState: 'pending',
      subtotal: 840000,
      shipping: 0,
      discount: 84000,
      total: 756000,
      voucher: 'DEMO10',
      createdAt: new Date().toISOString(),
      deliveredAt: delivered ? new Date(Date.now() - 5 * 86400000).toISOString() : undefined,
    };
  }
  private read<T>(key: string, fallback: T): T {
    try {
      return (
        (JSON.parse(sessionStorage.getItem(`velura-ui-demo-${key}`) || 'null') as T) ?? fallback
      );
    } catch {
      return fallback;
    }
  }
}
