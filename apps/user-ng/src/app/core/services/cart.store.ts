import { Injectable, computed, signal } from '@angular/core';
import { showToast } from '../utils/toast';

export interface CartComboSubItem {
  product_id: string;
  product_name: string;
  product_image: string;
  variant_id: string;
  color?: string;
  size?: string;
  quantity?: number;
  available_variants?: Array<{
    variant_id: string;
    color?: string;
    size?: string;
    stock_quantity?: number;
    reserved_quantity?: number;
  }>;
}

export interface CartLine {
  variant_id: string;
  product_id: string;
  product_name: string;
  product_image: string;
  quantity: number;
  unit_price: number;
  color?: string;
  size?: string;
  is_combo?: boolean;
  sub_items?: CartComboSubItem[];
  combo_id?: string;
  combo_name?: string;
  combo_price?: number;
  combo_image?: string;
  items?: CartLine[];
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
  sub_items?: CartComboSubItem[];
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
   * Updates a specific sub-item variant (e.g. changing color/size of component) within a combo set.
   * Handles both container combo lines (with sub_items) and multi-line combos (sharing combo_id).
   */
  updateComboSubVariant(
    comboVariantId: string,
    subProductId: string,
    newVariant: { variant_id: string; color?: string; size?: string }
  ): void {
    const next = this.items().map((line) => {
      // Trường hợp 1: Dòng này là combo container có sub_items
      if (line.variant_id === comboVariantId || (line.is_combo && line.combo_id === comboVariantId)) {
        const subItems = (line.sub_items || []).map((sub) => {
          if (sub.product_id === subProductId) {
            return {
              ...sub,
              variant_id: newVariant.variant_id,
              color: newVariant.color ?? sub.color,
              size: newVariant.size ?? sub.size,
            };
          }
          return sub;
        });
        const items = (line.items || []).map((it) => {
          if (it.product_id === subProductId) {
            return {
              ...it,
              variant_id: newVariant.variant_id,
              color: newVariant.color ?? it.color,
              size: newVariant.size ?? it.size,
            };
          }
          return it;
        });
        return {
          ...line,
          sub_items: subItems.length > 0 ? subItems : line.sub_items,
          items: items.length > 0 ? items : line.items,
        };
      }
      // Trường hợp 2: Dòng này là sản phẩm thành phần của combo đa dòng (chung combo_id)
      if (line.combo_id === comboVariantId && line.product_id === subProductId) {
        return {
          ...line,
          variant_id: newVariant.variant_id,
          color: newVariant.color ?? line.color,
          size: newVariant.size ?? line.size,
        };
      }
      return line;
    });
    this.persist(next);
  }

  /**
   * Removes a variant line or every component of a combo set.
   */
  removeItem(variantId: string): void {
    const isCombo = variantId.startsWith('combo-');
    this.persist(
      this.items().filter((line) => {
        if (isCombo) return line.combo_id !== variantId && line.variant_id !== variantId;
        return line.variant_id !== variantId && line.combo_id !== variantId;
      }),
    );
  }

  /**
   * Collapses combo components into one set card, matching vanilla `groupCartItems`.
   */
  groupItems(cart = this.items()): GroupedCartItem[] {
    const grouped: GroupedCartItem[] = [];
    const comboMap = new Map<string, GroupedCartItem>();
    for (const item of cart) {
      if (item.is_combo && item.sub_items && item.sub_items.length > 0) {
        grouped.push({
          is_combo: true,
          variant_id: item.variant_id,
          product_id: item.product_id,
          product_name: item.product_name,
          product_image: item.product_image,
          quantity: item.quantity,
          unit_price: item.unit_price,
          sub_items: item.sub_items,
          items: item.sub_items.map((sub) => ({
            variant_id: sub.variant_id,
            product_id: sub.product_id,
            product_name: sub.product_name,
            product_image: sub.product_image,
            quantity: (sub.quantity || 1) * item.quantity,
            unit_price: 0,
            color: sub.color,
            size: sub.size,
          })),
        });
        continue;
      }
      if (!item.combo_id) {
        grouped.push({ ...item, is_combo: false });
        continue;
      }
      let comboGroup = comboMap.get(item.combo_id);
      if (!comboGroup) {
        comboGroup = {
          is_combo: true,
          variant_id: item.combo_id,
          product_id: item.product_id || item.combo_id,
          product_name: item.combo_name || 'Set đồ phối sẵn',
          product_image: item.combo_image || item.product_image || '',
          quantity: item.quantity,
          unit_price: 0,
          items: [],
          sub_items: [],
        };
        comboMap.set(item.combo_id, comboGroup);
      }
      comboGroup.items = [...(comboGroup.items || []), item];
      comboGroup.sub_items = [
        ...(comboGroup.sub_items || []),
        {
          product_id: item.product_id,
          product_name: item.product_name,
          product_image: item.product_image,
          variant_id: item.variant_id,
          color: item.color,
          size: item.size,
          quantity: item.quantity,
        },
      ];
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
      if (item.is_combo) {
        expanded.push({
          variant_id: item.variant_id,
          product_id: item.product_id,
          product_name: item.product_name,
          product_image: item.product_image,
          quantity: item.quantity,
          unit_price: item.unit_price,
          is_combo: true,
          sub_items: item.sub_items || [],
          items: item.items || [],
          combo_id: item.variant_id,
          combo_name: item.product_name,
          combo_price: item.unit_price,
        });
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
            is_combo: Boolean(item['is_combo']),
            sub_items: Array.isArray(item['sub_items']) ? (item['sub_items'] as CartComboSubItem[]) : undefined,
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
