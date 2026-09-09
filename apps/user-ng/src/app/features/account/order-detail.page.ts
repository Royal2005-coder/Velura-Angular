import { Component, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, of } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { useBodyClass } from '../../core/utils/body-class';

@Component({
  selector: 'app-account-order-detail-page',
  imports: [RouterLink],
  host: { class: 'page-order-detail' },
  templateUrl: './order-detail.page.html',
})
export class AccountOrderDetailPage {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  readonly loading = signal(true);

  constructor() {
    useBodyClass('page-order-detail');
    const id = this.route.snapshot.paramMap.get('id') || '';
    this.api
      .get<{ order_code?: string; status?: string; created_at?: string; tracking_code?: string }>(`/api/user/orders/${id}`)
      .pipe(catchError(() => of(null)))
      .subscribe((order) => {
        this.loading.set(false);
        if (!order) {
          return;
        }
        const code = document.getElementById('js-order-code');
        const status = document.getElementById('js-order-status');
        const date = document.getElementById('js-order-date');
        const tracking = document.getElementById('js-tracking-code');
        if (code) {
          code.textContent = order.order_code || id;
        }
        if (status) {
          status.textContent = order.status || '';
        }
        if (date) {
          date.textContent = `Ngày đặt: ${order.created_at || ''}`;
        }
        if (tracking && order.tracking_code) {
          tracking.textContent = order.tracking_code;
        }
      });
  }
}
