import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-site-footer',
  imports: [RouterLink],
  templateUrl: './site-footer.html',
})
export class SiteFooter {
  readonly auth = inject(AuthService);

  /** Tên phương thức thanh toán đang mở tooltip khi chạm trên thiết bị cảm ứng */
  readonly activeTooltip = signal<string | null>(null);

  /**
   * Bật/tắt hiển thị tooltip khi chạm trên màn hình di động / tablet
   */
  toggleTooltip(name: string): void {
    this.activeTooltip.update((curr) => (curr === name ? null : name));
  }
}
