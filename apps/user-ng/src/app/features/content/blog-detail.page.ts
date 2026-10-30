import { DOCUMENT } from '@angular/common';
import { Component, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { Meta, Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map, switchMap } from 'rxjs';
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
  private readonly titleService = inject(Title);
  private readonly metaService = inject(Meta);
  private readonly document = inject(DOCUMENT);

  constructor() {
    useBodyClass('page-blog-detail');
    this.applyArticleSeo();
  }

  readonly slug = toSignal(this.route.paramMap.pipe(map((params) => params.get('slug') || '')), {
    initialValue: '',
  });
  readonly post = toSignal(
    this.route.paramMap.pipe(
      map((params) => params.get('slug') || ''),
      switchMap((slug) => {
        const cached = this.catalog.bySlug(slug);
        // The detail endpoint is the only payload with attached products; keep the list copy
        // as an offline/failed-request fallback.
        return this.catalog.fetchBySlug(slug).pipe(map((fresh) => fresh || cached || null));
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

  /** One price format for the article's product cards. */
  money(value: number): string {
    return `${Number(value || 0).toLocaleString('vi-VN')}đ`;
  }

  /**
   * Applies the SEO configuration saved with the post: title, description, canonical,
   * Open Graph/Twitter cards and BlogPosting JSON-LD. Every change is reverted on cleanup so a
   * later SPA page never inherits this article's metadata.
   *
   * CMS HTML is escaped by Angular's DOM sanitizer in the template; JSON-LD is written with
   * `textContent`, never as markup.
   */
  private applyArticleSeo(): void {
    effect((onCleanup) => {
      const article = this.post();
      if (!article) return;
      const origin = this.document.location?.origin || 'https://velura.vn';
      const canonical = (article.canonicalUrl || `${origin}/blog/${encodeURIComponent(article.slug)}`).trim();
      const pageTitle = (article.metaTitle || `${article.title} | Velura Journal`).trim();
      const description = (article.metaDescription || article.excerpt || '').trim();
      const image = (article.ogImage || article.image || '').trim();
      const tags = article.tags || [];
      const restores: Array<() => void> = [];

      const previousTitle = this.titleService.getTitle();
      this.titleService.setTitle(pageTitle);

      const setMeta = (attribute: 'name' | 'property', key: string, content: string): void => {
        if (!content) return;
        const selector = `${attribute}="${key}"`;
        const previous = this.metaService.getTag(selector)?.getAttribute('content') ?? null;
        const attrs: Record<string, string> = { [attribute]: key, content };
        this.metaService.updateTag(attrs);
        restores.push(() => {
          if (previous === null) this.metaService.removeTag(selector);
          else this.metaService.updateTag({ [attribute]: key, content: previous });
        });
      };

      setMeta('name', 'description', description);
      setMeta('property', 'og:type', 'article');
      setMeta('property', 'og:title', article.metaTitle || article.title);
      setMeta('property', 'og:description', description);
      setMeta('property', 'og:url', canonical);
      setMeta('property', 'og:image', image);
      setMeta('name', 'twitter:card', 'summary_large_image');
      setMeta('name', 'twitter:title', article.metaTitle || article.title);
      setMeta('name', 'twitter:description', description);
      setMeta('name', 'twitter:image', image);
      if (tags.length) setMeta('name', 'keywords', tags.join(', '));
      if (article.publishedAt) setMeta('property', 'article:published_time', article.publishedAt);

      const head = this.document.head;
      let link = head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
      const previousHref = link?.getAttribute('href') ?? null;
      if (!link) {
        link = this.document.createElement('link');
        link.setAttribute('rel', 'canonical');
        head.appendChild(link);
      }
      link.setAttribute('href', canonical);
      restores.push(() => {
        if (previousHref === null) link?.remove();
        else link?.setAttribute('href', previousHref);
      });

      const jsonLd = this.document.createElement('script');
      jsonLd.type = 'application/ld+json';
      jsonLd.textContent = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: article.title,
        description,
        image,
        url: canonical,
        mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
        author: { '@type': 'Person', name: article.author },
        publisher: {
          '@type': 'Organization',
          name: 'Velura',
          logo: { '@type': 'ImageObject', url: `${origin}/favicon.ico` },
        },
        ...(article.publishedAt ? { datePublished: article.publishedAt, dateModified: article.publishedAt } : {}),
        ...(tags.length ? { keywords: tags.join(', ') } : {}),
      });
      head.appendChild(jsonLd);

      onCleanup(() => {
        this.titleService.setTitle(previousTitle);
        for (const restore of restores.reverse()) restore();
        jsonLd.remove();
      });
    });
  }
}
