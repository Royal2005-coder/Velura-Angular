import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { BlogCatalogService } from '../../core/services/blog-catalog.service';
import { useBodyClass } from '../../core/utils/body-class';

@Component({
  selector: 'app-blog-detail-page',
  imports: [RouterLink],
  host: { class: 'page-blog-detail' },
  templateUrl: './blog-detail.page.html',
})
export class BlogDetailPage {
  private readonly catalog = inject(BlogCatalogService);
  private readonly route = inject(ActivatedRoute);

  constructor() {
    useBodyClass('page-blog-detail');
  }

  readonly slug = toSignal(this.route.paramMap.pipe(map((params) => params.get('slug') || '')), {
    initialValue: '',
  });
  readonly post = computed(() => this.catalog.bySlug(this.slug()));
}
