import { Injectable, computed, inject, signal } from '@angular/core';
import { CartLine, CartStore } from './cart.store';

export interface CheckoutShipping {
  name: string;
  phone: string;
  email: string;
  address: string;
  note?: string;
}

export interface CheckoutMethods {
  shippingMethod: string;
  shippingFee: number;
  paymentMethod: string;
}

export interface CreatedOrder {
  order_id?: string;
  /** Mã đơn cho khách (`VLR…`). Không phải mã vận đơn. */
  order_code?: string;
  payment_method?: string;
  shipping_address?: string;
  shipping_method?: string;
}

const SHIPPING_KEY = 'checkout_shipping';
const METHODS_KEY = 'checkout_methods';
const ITEMS_KEY = 'checkout_items';
const GUEST_PAYLOAD_KEY = 'guest_checkout_payload';
const CREATED_ORDER_KEY = 'created_order';

/**
 * Checkout session matching vanilla localStorage / sessionStorage keys.
 */
@Injectable({ providedIn: 'root' })
export class CheckoutStore {
  private readonly cart = inject(CartStore);

  readonly shipping = signal<CheckoutShipping>(this.readShipping());
  readonly methods = signal<CheckoutMethods>(this.readMethods());

  readonly items = signal<CartLine[]>(this.readCheckoutItems());
  readonly checkoutItems = computed(() => this.items());
  readonly subtotal = computed(() =>
    this.items().reduce((sum, line) => sum + line.unit_price * line.quantity, 0),
  );

  /**
   * Updates quantity of an item in checkout and syncs with the persistent cart.
   */
  updateItemQty(variantId: string, quantity: number): void {
    if (quantity <= 0) {
      this.removeItem(variantId);
      return;
    }
    const next = this.items().map((line) => {
      if (line.variant_id === variantId) {
        return { ...line, quantity };
      }
      return line;
    });
    this.items.set(next);
    sessionStorage.setItem(ITEMS_KEY, JSON.stringify(next));
    this.cart.updateQty(variantId, quantity);
  }

  /**
   * Replaces a variant in checkout with another variant of the same product, keeping quantity.
   */
  replaceItemVariant(fromVariantId: string, next: CartLine): void {
    const current = this.items();
    const previous = current.find((line) => line.variant_id === fromVariantId);
    const quantity = previous?.quantity || next.quantity || 1;
    const filtered = current.filter((line) => line.variant_id !== fromVariantId);
    const merged = [...filtered, { ...next, quantity }];
    this.items.set(merged);
    sessionStorage.setItem(ITEMS_KEY, JSON.stringify(merged));
    this.cart.replaceVariant(fromVariantId, next);
  }

  /**
   * Removes an item from checkout and syncs with the persistent cart.
   */
  removeItem(variantId: string): void {
    const next = this.items().filter((line) => line.variant_id !== variantId);
    this.items.set(next);
    sessionStorage.setItem(ITEMS_KEY, JSON.stringify(next));
    this.cart.removeItem(variantId);
  }

  /**
   * Persists shipping fields used by vanilla `checkout_shipping`.
   */
  saveShipping(shipping: CheckoutShipping): void {
    this.shipping.set(shipping);
    localStorage.setItem(SHIPPING_KEY, JSON.stringify(shipping));
  }

  /**
   * Persists shipping/payment methods used by vanilla `checkout_methods`.
   */
  saveMethods(methods: CheckoutMethods): void {
    this.methods.set(methods);
    localStorage.setItem(METHODS_KEY, JSON.stringify(methods));
  }

  /**
   * Returns buy-now lines when present, otherwise the current cart.
   */
  readCheckoutItems(): CartLine[] {
    try {
      const raw = sessionStorage.getItem(ITEMS_KEY);
      if (raw) {
        const items = JSON.parse(raw) as CartLine[];
        if (Array.isArray(items) && items.length) {
          return items;
        }
      }
    } catch {
      return this.cart.items();
    }
    return this.cart.items();
  }

  /**
   * Stores the guest OTP payload used by `/api/user/orders/otp-verify`.
   */
  saveGuestPayload(payload: Record<string, unknown>): void {
    sessionStorage.setItem(GUEST_PAYLOAD_KEY, JSON.stringify(payload));
  }

  /**
   * Reads the guest OTP payload saved before the OTP step.
   */
  readGuestPayload(): Record<string, unknown> | null {
    try {
      const raw = sessionStorage.getItem(GUEST_PAYLOAD_KEY);
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /**
   * Stores the created order shown on the success page.
   */
  saveCreatedOrder(order: CreatedOrder): void {
    localStorage.setItem(CREATED_ORDER_KEY, JSON.stringify(order));
  }

  /**
   * Reads the order confirmation payload.
   */
  readCreatedOrder(): CreatedOrder | null {
    try {
      const raw = localStorage.getItem(CREATED_ORDER_KEY);
      return raw ? (JSON.parse(raw) as CreatedOrder) : null;
    } catch {
      return null;
    }
  }

  /**
   * Removes checked-out lines from the cart and clears checkout session keys.
   */
  completeCheckout(orderedItems: CartLine[]): void {
    const ordered = new Set(orderedItems.map((line) => line.variant_id));
    this.cart.replaceItems(this.cart.items().filter((line) => !ordered.has(line.variant_id)));
    this.items.set([]);
    sessionStorage.removeItem(ITEMS_KEY);
    sessionStorage.removeItem(GUEST_PAYLOAD_KEY);
    localStorage.removeItem(SHIPPING_KEY);
    localStorage.removeItem(METHODS_KEY);
    localStorage.removeItem('checkout_discount');
    localStorage.removeItem('checkout_voucher_id');
    localStorage.removeItem('checkout_voucher_code');
    localStorage.removeItem('checkout_voucher_declined');
  }

  private readShipping(): CheckoutShipping {
    try {
      const raw = JSON.parse(localStorage.getItem(SHIPPING_KEY) || '{}') as CheckoutShipping;
      return {
        name: raw.name || '',
        phone: raw.phone || '',
        email: raw.email || '',
        address: raw.address || '',
        note: raw.note || '',
      };
    } catch {
      return { name: '', phone: '', email: '', address: '' };
    }
  }

  private readMethods(): CheckoutMethods {
    try {
      const raw = JSON.parse(localStorage.getItem(METHODS_KEY) || '{}') as CheckoutMethods;
      return {
        shippingMethod: raw.shippingMethod || 'standard',
        shippingFee: Number(raw.shippingFee || 0),
        paymentMethod: raw.paymentMethod || 'COD',
      };
    } catch {
      return { shippingMethod: 'standard', shippingFee: 0, paymentMethod: 'COD' };
    }
  }
}
