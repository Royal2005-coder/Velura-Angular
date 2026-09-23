import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { formatVnd } from '../../core/utils/money';
import { useBodyClass } from '../../core/utils/body-class';
import { orderStatusLabel } from './order-status';

interface MemberOrder {
  order_id: string;
  order_code?: string;
  status?: string;
  created_at?: string;
  total_amount?: number;
  item_count?: number;
  items?: Array<{ product_name?: string; product_image?: string }>;
}

@Component({
  selector: 'app-account-orders-page',
  imports: [RouterLink],
  host: { class: 'page-my-orders' },
  templateUrl: './orders.page.html',
})
export class AccountOrdersPage {
  private readonly api = inject(ApiService);
  readonly tab = signal('all');
  readonly query = signal('');
  readonly orders = signal<MemberOrder[]>([]);
  readonly loading = signal(true);
  readonly filtered = computed(() => {
    const tab = this.tab();
    const query = this.query().toLowerCase();
    return this.orders().filter((order) => {
      const status = (order.status || '').toLowerCase();
      const matchTab =
        tab === 'all' ||
        (tab === 'pending' && (status.includes('pending') || status.includes('confirm'))) ||
        (tab === 'shipping' && status.includes('ship')) ||
        (tab === 'delivered' && (status.includes('deliver') || status.includes('complete'))) ||
        (tab === 'cancelled' && status.includes('cancel'));
      const code = (order.order_code || order.order_id || '').toLowerCase();
      return matchTab && (!query || code.includes(query));
    });
  });

  constructor() {
    useBodyClass('page-my-orders');
    this.api
      .get<{ orders?: MemberOrder[] }>('/api/user/orders')
      .pipe(catchError(() => of({ orders: [] as MemberOrder[] })))
      .subscribe((data) => {
        this.orders.set(data.orders || []);
        this.loading.set(false);
      });
  }

  /**
   * Filters the original order tablist.
   */
  setTab(tab: string): void {
    this.tab.set(tab);
  }

  /**
   * Applies the original order search field.
   */
  onSearch(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value.trim());
  }

  /**
   * Formats an order total with the original VND helper.
   */
  totalLabel(order: MemberOrder): string {
    return formatVnd(order.total_amount) || '0₫';
  }

  /**
   * Same Vietnamese status the admin order screen shows.
   */
  statusLabel(order: MemberOrder): string {
    return orderStatusLabel(order.status);
  }
}
