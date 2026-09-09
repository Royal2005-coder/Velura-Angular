import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute } from '@angular/router';
import { map } from 'rxjs';

@Component({
  selector: 'app-feature-page',
  template: `
    <main class="product-list-page container">
      <header class="product-list-header">
        <h1 class="product-list-header__title">{{ title() }}</h1>
        <p class="product-list-header__subtitle">{{ subtitle() }}</p>
      </header>
    </main>
  `,
})
export class FeaturePage {
  private readonly route = inject(ActivatedRoute);
  readonly title = toSignal(this.route.data.pipe(map((data) => String(data['title'] || 'Velura'))), {
    initialValue: 'Velura',
  });
  readonly subtitle = toSignal(
    this.route.data.pipe(
      map(
        (data) =>
          String(
            data['subtitle'] ||
              'Trang này giữ layout Velura trong Angular. Module vanilla tương ứng sẽ được chuyển tiếp vào ViewModel.',
          ),
      ),
    ),
    {
      initialValue: '',
    },
  );
}
