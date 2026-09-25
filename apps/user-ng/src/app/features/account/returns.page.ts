import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { useBodyClass } from '../../core/utils/body-class';
import { isReturnableOrder, returnReasonText } from './return-window';

interface ReturnLine {
  item_id: string;
  product_name?: string;
  quantity?: number;
}

interface MemberOrder {
  order_id: string;
  order_code?: string;
  status?: string;
  status_label?: string;
  delivered_at?: string;
  updated_at?: string;
  created_at?: string;
  items?: ReturnLine[];
}

@Component({
  selector: 'app-account-returns-page',
  imports: [RouterLink],
  host: { class: 'page-return' },
  templateUrl: './returns.page.html',
})
export class AccountReturnsPage {
  private readonly api = inject(ApiService);

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly orders = signal<MemberOrder[]>([]);
  readonly selectedOrderId = signal<string | null>(null);
  readonly selectedItemIds = signal<string[]>([]);
  readonly returnType = signal<'refund' | 'exchange'>('refund');
  readonly reason = signal('');
  readonly description = signal('');
  readonly submitting = signal(false);
  readonly formError = signal<string | null>(null);
  readonly submitted = signal(false);
  readonly evidenceImages = signal<string[]>([]);

  readonly eligible = computed(() => this.orders().filter((order) => isReturnableOrder(order)));
  readonly selectedOrder = computed(() => this.eligible().find((order) => order.order_id === this.selectedOrderId()) || null);

  constructor() {
    useBodyClass('page-return');
    this.api
      .get<{ orders?: MemberOrder[] }>('/api/user/orders')
      .pipe(catchError(() => of(null)))
      .subscribe((data) => {
        this.loading.set(false);
        if (!data) {
          this.loadError.set('Không tải được danh sách đơn.');
          return;
        }
        const rows = data.orders || [];
        this.orders.set(rows);
        const first = rows.find((order) => isReturnableOrder(order));
        if (first) {
          this.selectedOrderId.set(first.order_id);
          this.selectedItemIds.set((first.items || []).map((item) => item.item_id));
        }
      });
  }

  /**
   * Same Vietnamese status shown on the order list and in admin.
   */
  statusLabel(order: MemberOrder): string {
    return order.status_label || order.status || '—';
  }

  /**
   * Chooses the delivered order the return request belongs to.
   */
  selectOrder(orderId: string): void {
    this.selectedOrderId.set(orderId);
    const order = this.eligible().find((row) => row.order_id === orderId);
    this.selectedItemIds.set((order?.items || []).map((item) => item.item_id));
    this.submitted.set(false);
    this.formError.set(null);
  }

  /**
   * Toggles one order line into the return request.
   */
  toggleItem(itemId: string): void {
    const current = this.selectedItemIds();
    this.selectedItemIds.set(
      current.includes(itemId) ? current.filter((id) => id !== itemId) : [...current, itemId],
    );
  }

  /**
   * Refund or exchange. Both values match `return_type` on the API.
   */
  setReturnType(value: 'refund' | 'exchange'): void {
    this.returnType.set(value);
  }

  /**
   * Reads the reason select.
   */
  setReason(event: Event): void {
    this.reason.set((event.target as HTMLSelectElement).value);
  }

  /**
   * Reads the optional description.
   */
  setDescription(event: Event): void {
    this.description.set((event.target as HTMLTextAreaElement).value);
  }

  /**
   * Handles customer selecting proof photos for return.
   */
  onFilesSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) {
      return;
    }
    const current = this.evidenceImages();
    const remaining = 5 - current.length;
    if (remaining <= 0) {
      this.formError.set('Chỉ được tải lên tối đa 5 hình ảnh minh chứng.');
      return;
    }
    const files = Array.from(input.files).slice(0, remaining);
    for (const file of files) {
      if (!file.type.startsWith('image/')) {
        continue;
      }
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        if (result) {
          this.evidenceImages.update((imgs) => (imgs.length < 5 ? [...imgs, result] : imgs));
        }
      };
      reader.readAsDataURL(file);
    }
    input.value = '';
  }

  /**
   * Removes an attached evidence image.
   */
  removeImage(index: number): void {
    this.evidenceImages.update((imgs) => imgs.filter((_, i) => i !== index));
  }

  /**
   * Sends the request. The API enforces the 30-day window and the delivered state.
   */
  submit(): void {
    const order = this.selectedOrder();
    if (!order || this.submitting()) {
      return;
    }
    const items = (order.items || [])
      .filter((item) => this.selectedItemIds().includes(item.item_id))
      .map((item) => ({ order_item_id: item.item_id, quantity: item.quantity || 1 }));
    if (!items.length) {
      this.formError.set('Chọn ít nhất một sản phẩm.');
      return;
    }
    if (!this.reason()) {
      this.formError.set('Chọn lý do đổi trả.');
      return;
    }
    this.submitting.set(true);
    this.formError.set(null);
    const note = [returnReasonText(this.reason()), this.description().trim()].filter(Boolean).join('. ');
    this.api
      .post<{ success?: boolean }>('/api/user/returns', {
        order_id: order.order_id,
        return_type: this.returnType(),
        description: note,
        evidence_images: this.evidenceImages(),
        items,
      })
      .subscribe({
        next: () => {
          this.submitting.set(false);
          this.submitted.set(true);
        },
        error: (error: Error) => {
          this.submitting.set(false);
          this.formError.set(error.message || 'Không gửi được yêu cầu đổi trả.');
        },
      });
  }
}
