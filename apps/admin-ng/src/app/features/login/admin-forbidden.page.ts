import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { AdminSessionService } from '../../core/admin-session.service';

@Component({
  selector: 'app-admin-forbidden-page',
  imports: [RouterLink],
  templateUrl: './admin-forbidden.page.html',
})
export class AdminForbiddenPage {
  private readonly session = inject(AdminSessionService);
  private readonly route = inject(ActivatedRoute);

  readonly homeRoute = this.session.firstRoute();
  readonly fromPage = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('from') || '')),
    { initialValue: this.route.snapshot.queryParamMap.get('from') || '' },
  );
}
