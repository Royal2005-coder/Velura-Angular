import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

@Component({
  selector: 'app-admin-feature-page',
  template: `
    <main class="admin-content">
      <p class="admin-page-crumb">{{ title() }}</p>
      <section class="dashboard-section">
        <header class="dashboard-section__header">
          <div>
            <span class="dashboard-eyebrow">Angular admin shell</span>
            <h3>{{ title() }}</h3>
          </div>
        </header>
        <p>{{ subtitle() }}</p>
      </section>
    </main>
  `,
})
export class AdminFeaturePage {
  private readonly route = inject(ActivatedRoute);
  readonly title = toSignal(this.route.data.pipe(map((data) => String(data['title'] || 'Admin'))), {
    initialValue: 'Admin',
  });
  readonly subtitle = toSignal(
    this.route.data.pipe(
      map(
        (data) =>
          String(
            data['subtitle'] ||
              'Module vanilla tương ứng sẽ được chuyển vào service + ViewModel, không giữ mock HTML.',
          ),
      ),
    ),
    { initialValue: '' },
  );
}
