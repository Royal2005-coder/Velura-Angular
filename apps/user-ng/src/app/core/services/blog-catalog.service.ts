import { Injectable, inject, signal } from '@angular/core';
import { catchError, of } from 'rxjs';
import { BlogPost } from '../models/blog-post';
import { ApiService } from './api.service';

interface ContentBlogRow {
  slug?: string;
  title?: string;
  excerpt?: string;
  image_url?: string;
  author?: string;
  read_minutes?: number;
  is_featured?: boolean;
  category_slug?: string;
  published_at?: string;
}

interface ContentBlogList {
  rows?: ContentBlogRow[];
}

const CATEGORY_BADGE: Record<BlogPost['category'], string> = {
  trend: 'Xu hướng',
  style: 'Phối đồ',
  interview: 'Phỏng vấn',
  sustainable: 'Bền vững',
  event: 'Sự kiện',
};

/**
 * Storefront journal catalog. Source of truth is `GET /api/content/blogs`.
 */
@Injectable({ providedIn: 'root' })
export class BlogCatalogService {
  private readonly api = inject(ApiService);
  private readonly postsState = signal<BlogPost[]>([]);

  constructor() {
    this.api
      .get<ContentBlogList>('/api/content/blogs?limit=50')
      .pipe(catchError(() => of({ rows: [] as ContentBlogRow[] })))
      .subscribe((payload) => this.postsState.set((payload.rows || []).map((row) => this.toPost(row))));
  }

  /**
   * Published journal posts from the content API. Empty when the API has none.
   */
  list(): BlogPost[] {
    return this.postsState();
  }

  /**
   * Finds one published article by slug.
   */
  bySlug(slug: string): BlogPost | undefined {
    return this.postsState().find((post) => post.slug === slug);
  }

  private toPost(row: ContentBlogRow): BlogPost {
    const category = this.toCategory(row.category_slug);
    return {
      slug: String(row.slug || ''),
      category,
      badge: CATEGORY_BADGE[category],
      title: String(row.title || ''),
      excerpt: String(row.excerpt || ''),
      image: String(row.image_url || '/assets/images/placeholder.jpg'),
      author: String(row.author || 'Velura Editorial'),
      date: this.formatDate(row.published_at),
      readMinutes: Number(row.read_minutes) || 5,
      featured: Boolean(row.is_featured),
    };
  }

  private toCategory(value: string | undefined): BlogPost['category'] {
    if (value === 'trend' || value === 'style' || value === 'interview' || value === 'sustainable' || value === 'event') {
      return value;
    }
    return 'trend';
  }

  private formatDate(value: string | undefined): string {
    if (!value) {
      return '';
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return value;
    }
    return new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(parsed);
  }
}
