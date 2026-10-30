import { Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, map, of } from 'rxjs';
import { BlogPost, BlogProductSummary } from '../models/blog-post';
import { ApiService } from './api.service';

interface ContentBlogProductRow {
  product_id?: string;
  name?: string;
  slug?: string;
  images?: string[];
  base_price?: number;
  sale_price?: number | null;
}

interface ContentBlogRow {
  slug?: string;
  title?: string;
  excerpt?: string;
  content?: string;
  content_html?: string;
  meta_title?: string | null;
  meta_description?: string | null;
  canonical_url?: string | null;
  og_image_url?: string | null;
  tags?: string[];
  image_url?: string;
  author?: string;
  read_minutes?: number;
  is_featured?: boolean;
  category_slug?: string;
  published_at?: string;
  products?: ContentBlogProductRow[];
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

  /**
   * Loads one published article even when it is outside the first list page.
   */
  fetchBySlug(slug: string): Observable<BlogPost | null> {
    return this.api.get<ContentBlogRow>(`/api/content/blogs/${encodeURIComponent(slug)}`).pipe(
      map((row) => (row && row.slug ? this.toPost(row) : null)),
      catchError(() => of(null)),
    );
  }

  private toPost(row: ContentBlogRow): BlogPost {
    const category = this.toCategory(row.category_slug);
    return {
      slug: String(row.slug || ''),
      category,
      badge: CATEGORY_BADGE[category],
      title: String(row.title || ''),
      excerpt: String(row.excerpt || ''),
      content: String(row.content || ''),
      contentHtml: String(row.content_html || '') || this.legacyContentHtml(row.content),
      metaTitle: String(row.meta_title || ''),
      metaDescription: String(row.meta_description || ''),
      canonicalUrl: String(row.canonical_url || ''),
      ogImage: this.assetUrl(row.og_image_url),
      tags: Array.isArray(row.tags) ? row.tags.map((tag) => String(tag || '').trim()).filter(Boolean) : [],
      image: this.assetUrl(row.image_url) || '/assets/images/placeholder.jpg',
      author: String(row.author || 'Velura Editorial'),
      date: this.formatDate(row.published_at),
      publishedAt: row.published_at,
      readMinutes: Number(row.read_minutes) || 5,
      featured: Boolean(row.is_featured),
      products: this.toProducts(row.products),
    };
  }

  /** The CMS once stored Vite dev paths; production serves the same file under /assets. */
  private assetUrl(value: string | null | undefined): string {
    const url = String(value || '').trim();
    return url.startsWith('/src/assets/') ? url.slice(4) : url;
  }

  private toProducts(rows: ContentBlogProductRow[] | undefined): BlogProductSummary[] {
    return (rows || [])
      .filter((row) => row.product_id && row.name)
      .slice(0, 30)
      .map((row) => {
        const price = Number(row.sale_price ?? row.base_price ?? 0);
        const base = Number(row.base_price ?? 0);
        return {
          product_id: String(row.product_id),
          name: String(row.name),
          slug: String(row.slug || ''),
          image: String((row.images || []).find((url) => typeof url === 'string' && url.trim()) || '/assets/images/placeholder.jpg'),
          price: Number.isFinite(price) ? price : 0,
          compareAtPrice: Number.isFinite(base) && base > price ? base : null,
        };
      });
  }

  /**
   * Old posts stored `{intro,takeaways,sections}` JSON in the content column. Render it as
   * readable article HTML until an editor saves the post in the rich composer.
   */
  private legacyContentHtml(value: string | undefined): string {
    const source = String(value || '').trim();
    if (!source.startsWith('{')) return '';
    let parsed: unknown;
    try { parsed = JSON.parse(source); } catch { return ''; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return '';
    const record = parsed as Record<string, unknown>;
    const escape = (part: string): string => part.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const intro = typeof record['intro'] === 'string' ? record['intro'].trim() : '';
    const takeaways = Array.isArray(record['takeaways'])
      ? record['takeaways'].map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)
      : [];
    const sections = Array.isArray(record['sections'])
      ? record['sections'].flatMap((raw) => {
          if (!raw || typeof raw !== 'object') return [];
          const section = raw as Record<string, unknown>;
          const heading = typeof section['heading'] === 'string' ? section['heading'].trim() : '';
          const body = Array.isArray(section['body'])
            ? section['body'].map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean)
            : [];
          return heading || body.length ? [{ heading, body }] : [];
        })
      : [];
    if (!intro && !takeaways.length && !sections.length) return '';
    const parts: string[] = [];
    if (intro) parts.push(`<p>${escape(intro)}</p>`);
    if (takeaways.length) parts.push(`<h2>Điểm chính</h2><ul>${takeaways.map((item) => `<li>${escape(item)}</li>`).join('')}</ul>`);
    for (const section of sections) {
      if (section.heading) parts.push(`<h2>${escape(section.heading)}</h2>`);
      for (const paragraph of section.body) parts.push(`<p>${escape(paragraph)}</p>`);
    }
    return parts.join('');
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
