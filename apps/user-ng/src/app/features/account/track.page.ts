import { Component, signal } from '@angular/core';
import { catchError, of } from 'rxjs';
import { inject } from '@angular/core';
import { ApiService } from '../../core/services/api.service';
import { useBodyClass } from '../../core/utils/body-class';

@Component({
  selector: 'app-account-track-page',
  host: { class: 'page-track-order' },
  templateUrl: './track.page.html',
})
export class AccountTrackPage {
  private readonly api = inject(ApiService);
  readonly query = signal('');
  readonly found = signal(false);
  readonly errorMessage = signal<string | null>(null);

  constructor() {
    useBodyClass('page-track-order');
  }

  /**
   * Looks up an order code through the original orders API.
   */
  search(): void {
    const code = this.query().trim();
    if (!code) {
      return;
    }
    this.api
      .get<{ orders?: Array<{ order_code?: string; order_id?: string; status?: string; status_label?: string }> }>('/api/user/orders')
      .pipe(catchError(() => of({ orders: [] })))
      .subscribe((data) => {
        const wanted = code.replace(/^#/, '').toUpperCase();
        const match = (data.orders || []).find(
          (order) => (order.order_code || '').toUpperCase() === wanted || order.order_id === code,
        );
        this.found.set(Boolean(match));
        this.errorMessage.set(match ? null : 'Không tìm thấy đơn hàng với mã này.');
        const empty = document.getElementById('js-track-empty-state');
        const grid = document.getElementById('js-track-grid');
        const codeNode = document.getElementById('js-track-code');
        const statusNode = document.getElementById('js-track-status');
        if (empty) {
          empty.style.display = match ? 'none' : 'block';
        }
        if (grid) {
          grid.style.display = match ? 'grid' : 'none';
        }
        if (match && codeNode) {
          codeNode.textContent = `#${match.order_code || match.order_id}`;
        }
        if (match && statusNode) {
          statusNode.textContent = match.status_label || match.status || '';
        }
      });
  }

  /**
   * Binds the original track search field.
   */
  onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }
}
