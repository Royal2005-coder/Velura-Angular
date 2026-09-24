import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { formatVnd } from '../../core/utils/money';
import { useBodyClass } from '../../core/utils/body-class';
import { environment } from '../../../environments/environment';
import { orderStatusLabel } from './order-status';

export interface MemberOrderItem {
  product_name?: string;
  product_image?: string;
  quantity?: number;
  unit_price?: number;
}

export interface MemberOrder {
  order_id: string;
  order_code?: string;
  tracking_code?: string;
  status?: string;
  created_at?: string;
  total_amount?: number;
  item_count?: number;
  items?: MemberOrderItem[];
}

@Component({
  selector: 'app-account-orders-page',
  imports: [RouterLink],
  host: { class: 'page-my-orders' },
  templateUrl: './orders.page.html',
})
export class AccountOrdersPage {
  private readonly api = inject(ApiService);

  /** Active status filter tab ('all' | 'pending' | 'shipping' | 'delivered' | 'cancelled'). */
  readonly tab = signal<'all' | 'pending' | 'shipping' | 'delivered' | 'cancelled'>('all');

  /** Search query string entered by the user. */
  readonly query = signal('');

  /** Raw list of member orders fetched from backend API. */
  readonly orders = signal<MemberOrder[]>([]);

  /** Indicates whether order list is currently being fetched. */
  readonly loading = signal(true);

  /** Filtered list of orders matching selected tab and search query. */
  readonly filtered = computed(() => {
    const tab = this.tab();
    const query = this.query().toLowerCase();
    return this.orders().filter((order) => {
      const status = (order.status || '').toLowerCase();

      // Mapping as requested by User Flow spec
      let matchTab = false;
      if (tab === 'all') {
        matchTab = true;
      } else if (tab === 'pending') {
        // Đang xử lý: Chờ xác nhận, Chờ thanh toán, Đã xác nhận, Đang chuẩn bị hàng
        matchTab = ['pending', 'waiting_payment', 'confirmed', 'preparing', 'processing'].some((s) =>
          status.includes(s)
        );
      } else if (tab === 'shipping') {
        // Đang giao: Đang giao hàng
        matchTab = ['shipping', 'delivering', 'in_transit'].some((s) => status.includes(s));
      } else if (tab === 'delivered') {
        // Hoàn thành: Giao thành công, Hoàn thành
        matchTab = ['delivered', 'completed'].some((s) => status.includes(s));
      } else if (tab === 'cancelled') {
        // Đã hủy: Đã hủy
        matchTab = ['cancelled', 'canceled', 'failed_delivery', 'delivery_failed'].some((s) =>
          status.includes(s)
        );
      }

      const code = (order.order_code || order.tracking_code || order.order_id || '').toLowerCase();
      return matchTab && (!query || code.includes(query));
    });
  });

  constructor() {
    useBodyClass('page-my-orders');
    this.api
      .get<{ orders?: MemberOrder[] }>('/api/user/orders')
      .pipe(catchError(() => of({ orders: [] as MemberOrder[] })))
      .subscribe((data) => {
        const list = data.orders || [];
        if (list.length > 0) {
          this.orders.set(list);
        } else if (environment.mockAuth) {
          this.orders.set(this.getMockOrders());
        } else {
          this.orders.set([]);
        }
        this.loading.set(false);
      });
  }

  private getMockOrders(): MemberOrder[] {
    return [
      {
        order_id: 'ord-101',
        order_code: 'CM123456',
        tracking_code: 'VN18492048291',
        status: 'shipping',
        created_at: '2026-09-20T10:30:00Z',
        total_amount: 599000,
        item_count: 3,
        items: [
          { product_name: 'Áo sơ mi linen trắng Velura', product_image: '/assets/images/about_01.jpg', quantity: 2 },
          { product_name: 'Quần suông ống rộng màu be', product_image: '/assets/images/about_02.jpg', quantity: 1 }
        ]
      },
      {
        order_id: 'ord-102',
        order_code: 'CM987654',
        tracking_code: 'GHN-89218492',
        status: 'pending',
        created_at: '2026-09-22T14:15:00Z',
        total_amount: 850000,
        item_count: 2,
        items: [
          { product_name: 'Đầm lụa dệt hoa dáng xòe', product_image: '/assets/images/about_01.jpg', quantity: 1 },
          { product_name: 'Chân váy xếp ly công sở', product_image: '/assets/images/about_02.jpg', quantity: 1 }
        ]
      },
      {
        order_id: 'ord-103',
        order_code: 'CM555888',
        tracking_code: 'VTP-771239',
        status: 'completed',
        created_at: '2026-09-15T09:00:00Z',
        total_amount: 1290000,
        item_count: 4,
        items: [
          { product_name: 'Áo khoác Blazer dáng Rộng', product_image: '/assets/images/about_02.jpg', quantity: 1 }
        ]
      },
      {
        order_id: 'ord-104',
        order_code: 'CM333222',
        tracking_code: 'NJV-110022',
        status: 'cancelled',
        created_at: '2026-09-10T16:45:00Z',
        total_amount: 320000,
        item_count: 1,
        items: [
          { product_name: 'Áo thun cotton cao cấp Premium', product_image: '/assets/images/about_01.jpg', quantity: 1 }
        ]
      }
    ];
  }

  /**
   * Sets the active order filter tab.
   */
  setTab(tab: 'all' | 'pending' | 'shipping' | 'delivered' | 'cancelled'): void {
    this.tab.set(tab);
  }

  /**
   * Updates search query from text input field.
   */
  onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value.trim());
  }

  /**
   * Formats an order total price into VND format.
   */
  totalLabel(order: MemberOrder): string {
    return formatVnd(order.total_amount) || '0₫';
  }

  /**
   * Returns human-readable Vietnamese order status string.
   */
  statusLabel(order: MemberOrder): string {
    return orderStatusLabel(order.status);
  }

  /**
   * Formats order creation date into a clean DD/MM/YYYY string.
   */
  orderDateLabel(order: MemberOrder): string {
    if (!order.created_at) return '';
    const d = new Date(order.created_at);
    if (Number.isNaN(d.getTime())) return order.created_at;
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  }

  /**
   * Returns appropriate status badge CSS modifier class.
   */
  statusBadgeClass(order: MemberOrder): string {
    const status = (order.status || '').toLowerCase();
    if (['shipping', 'delivering'].some((s) => status.includes(s))) {
      return 'order-card__status-badge--shipping';
    }
    if (['delivered', 'completed'].some((s) => status.includes(s))) {
      return 'order-card__status-badge--delivered';
    }
    if (['cancelled', 'canceled'].some((s) => status.includes(s))) {
      return 'order-card__status-badge--cancelled';
    }
    return 'order-card__status-badge--pending';
  }

  isCompleted(order: MemberOrder): boolean {
    return ['delivered', 'completed'].includes((order.status || '').toLowerCase());
  }

  isShipping(order: MemberOrder): boolean {
    return ['shipping', 'delivering', 'in_transit'].some((status) => (order.status || '').toLowerCase().includes(status));
  }
}

