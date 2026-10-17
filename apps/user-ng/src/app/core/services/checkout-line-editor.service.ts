import { Injectable, inject } from '@angular/core';
import { map, Observable } from 'rxjs';
import { CatalogService } from './catalog.service';
import { CheckoutStore } from './checkout.store';
import { CartStore, type CartLine } from './cart.store';
import type { ProductVariant } from '../models/product.interface';

/** Live choices for an existing checkout line; reserved units cannot be purchased. */
export interface CheckoutVariantChoice extends ProductVariant {
  available: number;
  /** Current catalog unit price; checkout still requires the authoritative server quote. */
  unitPrice?: number;
}

/** Edits the selected checkout and matching cart lines before an order is created. */
@Injectable({ providedIn: 'root' })
export class CheckoutLineEditorService {
  private readonly catalog = inject(CatalogService);
  private readonly checkout = inject(CheckoutStore);
  private readonly cart = inject(CartStore);

  /** Fetches current variant availability instead of trusting saved cart stock. */
  choices(productId: string): Observable<CheckoutVariantChoice[]> {
    return this.catalog.getProduct(productId).pipe(map(product => (product.variants || []).map(variant => ({
      ...variant,
      available: Math.max(0, (variant.stock_quantity || 0) - (variant.reserved_quantity || 0)),
      unitPrice: product.sale_price ?? product.base_price,
    }))));
  }

  /** Changes one component; collisions combine quantities without dropping either line. */
  edit(line: CartLine, variant: CheckoutVariantChoice, quantity: number, lines: CartLine[]): CartLine[] {
    if (!Number.isInteger(quantity) || quantity < 1) throw new Error('Số lượng phải là số nguyên lớn hơn 0.');
    const same = (candidate: CartLine) => candidate.variant_id === line.variant_id && candidate.combo_id === line.combo_id;
    const rest = lines.filter(candidate => !same(candidate)).map(candidate => ({ ...candidate }));
    const collision = rest.find(candidate => candidate.variant_id === variant.variant_id && candidate.combo_id === line.combo_id);
    const variantTotal = rest.filter(candidate => candidate.variant_id === variant.variant_id).reduce((sum, candidate) => sum + candidate.quantity, quantity);
    if (variantTotal > variant.available) throw new Error('Số lượng vượt quá tồn kho có thể bán. Vui lòng chọn lại.');
    if (collision) collision.quantity += quantity;
    else rest.push({ ...line, variant_id: variant.variant_id, color: variant.color, size: variant.size, quantity, unit_price: !line.combo_id && variant.unitPrice !== undefined ? variant.unitPrice : line.unit_price });
    const currentCart = this.cart.items();
    if (this.checkout.source() === 'cart' && currentCart.some(same)) {
      const cartRest = currentCart.filter(candidate => !same(candidate)).map(candidate => ({ ...candidate }));
      const cartCollision = cartRest.find(candidate => candidate.variant_id === variant.variant_id && candidate.combo_id === line.combo_id);
      if (cartCollision) cartCollision.quantity += quantity;
      else cartRest.push({ ...line, variant_id: variant.variant_id, color: variant.color, size: variant.size, quantity, unit_price: !line.combo_id && variant.unitPrice !== undefined ? variant.unitPrice : line.unit_price });
      this.cart.replaceItems(cartRest);
    }
    this.checkout.setCheckoutItems(rest);
    return rest;
  }

  /** Updates variant (color/size) for a specific sub-item within a combo line. */
  editComboSubItem(
    line: CartLine,
    componentProductId: string,
    newVariant: { variant_id: string; color?: string; size?: string },
    lines: CartLine[]
  ): CartLine[] {
    const isContainer = (candidate: CartLine) =>
      candidate.variant_id === line.variant_id || (line.combo_id && candidate.combo_id === line.combo_id && candidate.is_combo);
    const isComponentLine = (candidate: CartLine) =>
      line.combo_id && candidate.combo_id === line.combo_id && candidate.product_id === componentProductId;

    const updateItem = (candidate: CartLine): CartLine => {
      if (isContainer(candidate)) {
        const updatedSub = (candidate.sub_items || []).map(sub => {
          if (sub.product_id === componentProductId) {
            return {
              ...sub,
              variant_id: newVariant.variant_id,
              color: newVariant.color ?? sub.color,
              size: newVariant.size ?? sub.size,
            };
          }
          return sub;
        });
        const updatedItems = (candidate.items || []).map(it => {
          if (it.product_id === componentProductId) {
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
          ...candidate,
          sub_items: updatedSub.length > 0 ? updatedSub : candidate.sub_items,
          items: updatedItems.length > 0 ? updatedItems : candidate.items,
        };
      }
      if (isComponentLine(candidate)) {
        return {
          ...candidate,
          variant_id: newVariant.variant_id,
          color: newVariant.color ?? candidate.color,
          size: newVariant.size ?? candidate.size,
        };
      }
      return candidate;
    };

    const next = lines.map(updateItem);

    if (this.checkout.source() === 'cart') {
      const currentCart = this.cart.items();
      const updatedCart = currentCart.map(updateItem);
      this.cart.replaceItems(updatedCart);
    }
    this.checkout.setCheckoutItems(next);
    return next;
  }

  /** Removes a whole combo or a single regular line, preserving unrelated cart items. */
  remove(line: CartLine, lines: CartLine[]): CartLine[] {
    const keep = (candidate: CartLine) =>
      line.combo_id ? candidate.combo_id !== line.combo_id : candidate.variant_id !== line.variant_id || !!candidate.combo_id;
    const next = lines.filter(keep);
    if (this.checkout.source() === 'cart') this.cart.replaceItems(this.cart.items().filter(keep));
    this.checkout.setCheckoutItems(next);
    return next;
  }
}
