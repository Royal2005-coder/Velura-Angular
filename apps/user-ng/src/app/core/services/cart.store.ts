import { Injectable, computed, signal } from '@angular/core';
import { showToast } from '../utils/toast';

export interface CartLine {
  variant_id: string;
  product_id: string;
  product_name: string;
  product_image: string;
  quantity: number;
  unit_price: number;
  color?: string;
  size?: string;
  combo_id?: string;
  combo_name?: string;
  combo_price?: number;
  combo_image?: string;
}

export interface GroupedCartItem {
  is_combo: boolean;
  variant_id: string;
  product_id: string;
  product_name: string;
  product_image: string;
  quantity: number;
  unit_price: number;
  color?: string;
  size?: string;
  items?: CartLine[];
}

const CART_KEY = 'velura_cart';
const COUNT_KEY = 'velura_cart_count';

/**
 * Cart badge and line items. Reads the same `velura_cart` key as the vanilla storefront.
 */
@Injectable({ providedIn: 'root' })
export class CartStore {
  readonly items = signal<CartLine[]>(this.readLines());
  readonly itemCount = computed(() => this.items().reduce((sum, line) => sum + line.quantity, 0));
  readonly subtotal = computed(() =>
    this.items().reduce((sum, line) => sum + line.unit_price * line.quantity, 0),
  );

  /**
   * Replaces the header badge from an explicit count (legacy callers).
   */
  setCount(count: number): void {
    const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    localStorage.setItem(COUNT_KEY, String(safe));
  }

  /**
   * Adds or increments a variant line using the original cart payload shape.
   */
  addItem(item: CartLine, options?: { silent?: boolean }): void {
    this.persist(this.mergeLine(this.items(), item));
    if (!options?.silent) {
      showToast(`Đã thêm ${item.product_name} vào giỏ hàng!`);
    }
  }

  /**
   * Adds every component of a combo set and shows one original toast.
   */
  addCombo(items: CartLine[], toastMessage: string): void {
    let cart = this.items();
    for (const item of items) {
      cart = this.mergeLine(cart, item);
    }
    this.persist(cart);
    showToast(toastMessage);
  }

  /**
   * Updates a line or combo-set quantity using the original cart stepper.
   */
  updateQty(variantId: string, quantity: number): void {
    if (quantity <= 0) {
      this.removeItem(variantId);
      return;
    }
    const isCombo = variantId.startsWith('combo-');
    this.persist(
      this.items().map((line) => {
        if (isCombo ? line.combo_id === variantId : line.variant_id === variantId) {
          return { ...line, quantity };
        }
        return line;
      }),
    );
  }

  /**
   * Swaps one line to another variant of the same product, keeping quantity.
   */
  replaceVariant(fromVariantId: string, next: CartLine): void {
    const current = this.items();
    const previous = current.find((line) => line.variant_id === fromVariantId);
    const quantity = previous?.quantity || next.quantity || 1;
    const without = current.filter((line) => line.variant_id !== fromVariantId);
    this.persist(this.mergeLine(without, { ...next, quantity }));
  }

  /**
   * Removes a variant line or every component of a combo set.
   */
  removeItem(variantId: string): void {
    const isCombo = variantId.startsWith('combo-');
    this.persist(
      isCombo
        ? this.items().filter((line) => line.combo_id !== variantId)
        : this.items().filter((line) => line.variant_id !== variantId),
    );
  }

  /**
   * Collapses combo components into one set card, matching vanilla `groupCartItems`.
   */
  groupItems(cart = this.items()): GroupedCartItem[] {
    const grouped: GroupedCartItem[] = [];
    const comboMap = new Map<string, GroupedCartItem>();
    for (const item of cart) {
      if (!item.combo_id) {
        grouped.push({ ...item, is_combo: false });
        continue;
      }
      let comboGroup = comboMap.get(item.combo_id);
      if (!comboGroup) {
        comboGroup = {
          is_combo: true,
          variant_id: item.combo_id,
          product_id: item.combo_id,
          product_name: item.combo_name || 'Set đồ phối sẵn',
          product_image: item.combo_image || item.product_image || '',
          quantity: item.quantity,
          unit_price: 0,
          items: [],
        };
        comboMap.set(item.combo_id, comboGroup);
      }
      comboGroup.items = [...(comboGroup.items || []), item];
    }
    for (const comboGroup of comboMap.values()) {
      const parts = comboGroup.items || [];
      comboGroup.quantity = parts[0]?.quantity || 1;
      const comboPrice = parts[0]?.combo_price;
      comboGroup.unit_price =
        comboPrice !== undefined && comboPrice > 0
          ? comboPrice
          : parts.reduce((sum, item) => sum + (item.unit_price || 0), 0);
      grouped.push(comboGroup);
    }
    return grouped;
  }

  /**
   * Expands grouped checkout rows back into variant lines for the order API.
   */
  expandGroupedItems(items: GroupedCartItem[]): CartLine[] {
    const expanded: CartLine[] = [];
    for (const item of items) {
      if (item.is_combo && item.items?.length) {
        for (const sub of item.items) {
          expanded.push({ ...sub, quantity: sub.quantity });
        }
      } else {
        expanded.push({
          variant_id: item.variant_id,
          product_id: item.product_id,
          product_name: item.product_name,
          product_image: item.product_image,
          quantity: item.quantity,
          unit_price: item.unit_price,
          color: item.color,
          size: item.size,
        });
      }
    }
    return expanded;
  }

  /**
   * Replaces the localStorage cart after checkout, matching vanilla remaining-cart sync.
   */
  replaceItems(cart: CartLine[]): void {
    this.persist(cart);
  }

  private mergeLine(cart: CartLine[], item: CartLine): CartLine[] {
    const next = [...cart];
    const comboKey = item.combo_id || '';
    const existing = next.find(
      (line) => line.variant_id === item.variant_id && (line.combo_id || '') === comboKey,
    );
    if (existing) {
      existing.quantity += item.quantity || 1;
      return next;
    }
    next.push({ ...item, quantity: item.quantity || 1 });
    return next;
  }

  private persist(cart: CartLine[]): void {
    this.items.set(cart);
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
    localStorage.setItem(COUNT_KEY, String(cart.reduce((sum, line) => sum + line.quantity, 0)));
  }

  private readLines(): CartLine[] {
    try {
      const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]') as unknown;
      if (!Array.isArray(raw)) {
        return [];
      }
      return raw
        .map((row) => {
          const item = row as Record<string, unknown>;
          return {
            variant_id: String(item['variant_id'] || ''),
            product_id: String(item['product_id'] || ''),
            product_name: String(item['product_name'] || ''),
            product_image: String(item['product_image'] || ''),
            quantity: Number(item['quantity'] || 1),
            unit_price: Number(item['unit_price'] || 0),
            color: typeof item['color'] === 'string' ? item['color'] : undefined,
            size: typeof item['size'] === 'string' ? item['size'] : undefined,
            combo_id: typeof item['combo_id'] === 'string' ? item['combo_id'] : undefined,
            combo_name: typeof item['combo_name'] === 'string' ? item['combo_name'] : undefined,
            combo_price: typeof item['combo_price'] === 'number' ? item['combo_price'] : undefined,
            combo_image: typeof item['combo_image'] === 'string' ? item['combo_image'] : undefined,
          };
        })
        .filter((line) => line.variant_id || line.product_id);
    } catch {
      return [];
    }
  }
}
