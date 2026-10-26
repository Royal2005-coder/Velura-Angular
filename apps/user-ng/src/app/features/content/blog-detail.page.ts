import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, map, of } from 'rxjs';
import type { ProductSummary } from '../../core/models/product.interface';
import { CatalogService } from '../../core/services/catalog.service';
import { BlogCatalogService } from '../../core/services/blog-catalog.service';
import { useBodyClass } from '../../core/utils/body-class';
import { ProductCard } from '../../shared/product-card/product-card';

/** Display shape for one section in structured editorial content. */
interface ArticleSection {
  heading: string;
  paragraphs: string[];
}

/** Catalog SKU and editorial note attached to a published article. */
interface ArticleProductReference {
  sku: string;
  note: string;
}

/** Parsed article presentation, retaining HTML bodies that use the legacy format. */
interface ArticleBody {
  intro: string;
  takeaways: string[];
  sections: ArticleSection[];
  products: ArticleProductReference[];
  html: string;
}

/** Resolved live catalog product paired with the article's note. */
interface RelatedArticleProduct {
  product: ProductSummary;
  note: string;
}

/** Converts the current content API body into display fields while preserving ordinary HTML articles. */
function parseArticleBody(raw: string): ArticleBody {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { intro: '', takeaways: [], sections: [], products: [], html: raw };
    }
    const source = parsed as Record<string, unknown>;
    const sections = Array.isArray(source['sections'])
      ? source['sections'].flatMap((value): ArticleSection[] => {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
          const section = value as Record<string, unknown>;
          const body = section['body'];
          const paragraphs = typeof body === 'string'
            ? [body]
            : Array.isArray(body) ? body.filter((line): line is string => typeof line === 'string') : [];
          return [{ heading: typeof section['heading'] === 'string' ? section['heading'] : '', paragraphs }];
        })
      : [];
    const products = Array.isArray(source['products'])
      ? source['products'].flatMap((value): ArticleProductReference[] => {
          if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
          const product = value as Record<string, unknown>;
          return typeof product['sku'] === 'string'
            ? [{ sku: product['sku'], note: typeof product['note'] === 'string' ? product['note'] : '' }]
            : [];
        })
      : [];
    const hasStructuredFields = typeof source['intro'] === 'string'
      || Array.isArray(source['takeaways'])
      || Array.isArray(source['sections'])
      || Array.isArray(source['products']);
    if (!hasStructuredFields) return { intro: '', takeaways: [], sections: [], products: [], html: raw };
    return {
      intro: typeof source['intro'] === 'string' ? source['intro'] : '',
      takeaways: Array.isArray(source['takeaways'])
        ? source['takeaways'].filter((line): line is string => typeof line === 'string')
        : [],
      sections,
      products,
      html: '',
    };
  } catch {
    return { intro: '', takeaways: [], sections: [], products: [], html: raw };
  }
}

@Component({
  selector: 'app-blog-detail-page',
  imports: [RouterLink, ProductCard],
  host: { class: 'page-blog-detail' },
  templateUrl: './blog-detail.page.html',
})
export class BlogDetailPage {
  private readonly catalog = inject(BlogCatalogService);
  private readonly productCatalog = inject(CatalogService);
  private readonly route = inject(ActivatedRoute);
  private readonly products = toSignal(
    this.productCatalog.getProducts().pipe(catchError(() => of([] as ProductSummary[]))),
    { initialValue: [] as ProductSummary[] },
  );

  constructor() {
    useBodyClass('page-blog-detail');
  }

  readonly slug = toSignal(this.route.paramMap.pipe(map((params) => params.get('slug') || '')), {
    initialValue: '',
  });
  readonly post = computed(() => this.catalog.bySlug(this.slug()));
  /** Structured article data from the content API, or sanitized HTML when the record uses HTML. */
  readonly articleBody = computed(() => {
    const raw = this.post()?.content?.trim();
    return raw ? parseArticleBody(raw) : null;
  });
  /** Article product references resolve only to real products returned by the catalog API. */
  readonly relatedProducts = computed<RelatedArticleProduct[]>(() => {
    const products = new Map(this.products().map((product) => [product.sku?.toLowerCase() || '', product]));
    return (this.articleBody()?.products || []).flatMap((reference) => {
      const product = products.get(reference.sku.toLowerCase());
      return product ? [{ product, note: reference.note }] : [];
    });
  });
}
