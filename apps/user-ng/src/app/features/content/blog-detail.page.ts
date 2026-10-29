import { Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map, of, switchMap } from 'rxjs';
import { BlogCatalogService } from '../../core/services/blog-catalog.service';
import { BlogPost } from '../../core/models/blog-post';
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
  readonly post = toSignal(
    this.route.paramMap.pipe(
      map((params) => params.get('slug') || ''),
      switchMap((slug) => {
        const cached = this.catalog.bySlug(slug);
        return cached?.content ? of(cached) : this.catalog.fetchBySlug(slug);
      }),
    ),
    { initialValue: null as BlogPost | null },
  );

  /** CMS body is plain text; split for readable paragraphs and let Angular escape it. */
  paragraphs(content?: string): string[] {
    return String(content || '')
      .split(/\n+/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean);
  }
}
