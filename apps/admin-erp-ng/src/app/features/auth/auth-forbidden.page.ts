import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { AdminErpSessionService } from '../../core/admin-erp-session.service';

/**
 * Shown inside the shell when the role cannot open a route.
 */
@Component({
  selector: 'app-auth-forbidden-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="forbidden erp-card" aria-labelledby="forbidden-title">
      <span class="forbidden__code">403</span>
      <h1 id="forbidden-title">Bạn không có quyền truy cập</h1>
      <p>
        Vai trò hiện tại không được mở workspace này.
        @if (fromPage()) {
          <span> Yêu cầu bị chặn tại page key <strong>{{ fromPage() }}</strong>.</span>
        }
      </p>
      <a class="erp-btn erp-btn--primary" [routerLink]="homeRoute">Về workspace được phép</a>
    </section>
  `,
  styles: [
    `
      .forbidden {
        display: grid;
        justify-items: start;
        gap: 10px;
        max-width: 640px;
        padding: 32px;
      }
      .forbidden__code {
        color: var(--erp-accent-strong);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.16em;
      }
      h1 {
        font-family: var(--erp-display);
        font-size: 28px;
        color: var(--erp-ink);
      }
      p {
        color: var(--erp-muted);
        font-size: 13px;
        line-height: 1.6;
      }
      .erp-btn {
        margin-top: 8px;
      }
    `,
  ],
})
export class AuthForbiddenPage {
  private readonly session = inject(AdminErpSessionService);
  private readonly route = inject(ActivatedRoute);

  readonly homeRoute = this.session.firstRoute();
  readonly fromPage = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('from') || '')),
    { initialValue: this.route.snapshot.queryParamMap.get('from') || '' },
  );
}
