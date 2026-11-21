import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BlogCatalogService } from '../../core/services/blog-catalog.service';
import { useBodyClass } from '../../core/utils/body-class';
import { LoadingOverlay } from '../../shared/loading-overlay/loading-overlay';

@Component({
  selector: 'app-blog-page',
  imports: [RouterLink, LoadingOverlay],
  host: { class: 'page-blog' },
  templateUrl: './blog.page.html',
})
export class BlogPage {
  private readonly catalog = inject(BlogCatalogService);

  constructor() {
    useBodyClass('page-blog');
  }

  readonly loading = computed(() => this.catalog.loading?.() ?? false);
  readonly category = signal('all');
  readonly featured = computed(() => this.catalog.list().find((post) => post.featured) || this.catalog.list()[0]);
  readonly posts = computed(() => {
    const category = this.category();
    const rows = this.catalog.list();
    return category === 'all' ? rows : rows.filter((post) => post.category === category);
  });

  /**
   * Filters the original journal category tabs.
   */
  setCategory(category: string): void {
    this.category.set(category);
  }
}
