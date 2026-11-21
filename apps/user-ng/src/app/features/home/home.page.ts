import { AfterViewInit, Component, ElementRef, Injector, OnDestroy, ViewChild, afterNextRender, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, UrlTree } from '@angular/router';
import { catchError, forkJoin, of, take } from 'rxjs';
import { COLLECTION_LOOKBOOKS, CollectionLookbook } from '../../core/models/collection-lookbook';
import { CategorySummary, ProductSummary } from '../../core/models/product.interface';
import { AuthService } from '../../core/services/auth.service';
import { CatalogService } from '../../core/services/catalog.service';
import { BlogCatalogService } from '../../core/services/blog-catalog.service';
import { OffersService } from '../../core/services/offers.service';
import { StyleProfileService } from '../../core/services/style-profile.service';
import { toSignal } from '@angular/core/rxjs-interop';
import { bindHomeCarousel } from '../../core/utils/home-carousel';
import { isExternalCmsLink, navigateCmsLink, parseInternalCmsLink } from '../../core/utils/cms-link';
import { ProductCard } from '../../shared/product-card/product-card';
import { useBodyClass } from '../../core/utils/body-class';
import { toPublicAsset } from '../../core/utils/money';
import type { BlogPost } from '../../core/models/blog-post';

export interface HeroLook {
  id: string;
  collectionName: string;
  title: string;
  eyebrow: string;
  season: string;
  description: string;
  badge: string;
  looksCount: string;
  image: string;
  link: string;
}

export const HERO_LOOKS: HeroLook[] = [
  {
    id: 'soft-ceremony',
    collectionName: 'Soft Ceremony',
    title: 'Soft Ceremony.',
    eyebrow: 'VELURA',
    season: 'SPRING / SUMMER 2027',
    description: 'Những thiết kế mềm mại, tinh tế cho những dịp tiệc nhẹ, hẹn hò và các buổi gặp gỡ đặc biệt — sang trọng, hiện đại, dễ ứng dụng.',
    badge: 'ELEGANT',
    looksCount: '10 LOOKS',
    image: '/assets/images/models/runway-soft-ceremony.png',
    link: '/collections?collection=soft-ceremony',
  },
  {
    id: 'the-urban-rhythm',
    collectionName: 'The Urban Rhythm',
    title: 'Urban Rhythm.',
    eyebrow: 'VELURA',
    season: 'SPRING / SUMMER 2027',
    description: 'Phom dáng hiện đại, đường cắt sắc sảo — bảng màu beige, charcoal, olive dễ mix-and-match cho cả ngày làm việc bận rộn lẫn buổi dạo phố cuối tuần.',
    badge: 'CASUAL',
    looksCount: '16 LOOKS',
    image: '/assets/images/models/runway-the-urban-rhythm.png',
    link: '/collections?collection=the-urban-rhythm',
  },
  {
    id: 'weekend-escape',
    collectionName: 'Weekend Escape',
    title: 'Weekend Escape.',
    eyebrow: 'VELURA',
    season: 'SPRING / SUMMER 2027',
    description: 'Phom dáng nhẹ nhàng, chất liệu thoáng mát — dạo phố, cà phê hay du lịch đều thoải mái, thanh lịch trong mọi hành trình.',
    badge: 'TRAVEL',
    looksCount: '14 LOOKS',
    image: '/assets/images/models/runway-weekend-escape.png',
    link: '/collections?collection=weekend-escape',
  },
  {
    id: 'midnight-mirage',
    collectionName: 'Midnight Mirage',
    title: 'Midnight Mirage.',
    eyebrow: 'VELURA',
    season: 'SPRING / SUMMER 2027',
    description: 'Street style Hàn Quốc — kết hợp nét cá tính, tối giản và hiện đại. Bảng màu trung tính pha pastel, trẻ trung và dễ phối đồ mọi ngày.',
    badge: 'STREET',
    looksCount: '8 LOOKS',
    image: '/assets/images/models/runway-midnight-mirage.png',
    link: '/collections?collection=midnight-mirage',
  },
  {
    id: 'the-afterglow',
    collectionName: 'The Afterglow',
    title: 'The Afterglow.',
    eyebrow: 'VELURA',
    season: 'SPRING / SUMMER 2027',
    description: 'Dư âm vương giả — lụa satin, corset tinh tế và sắc hồng tulle cùng xanh Sapphire tôn vinh vẻ đẹp kiêu sa, lộng lẫy như một tiểu thư vương giả.',
    badge: 'COUTURE',
    looksCount: '12 LOOKS',
    image: '/assets/images/models/runway-the-afterglow.png',
    link: '/collections?collection=the-afterglow',
  },
];

/** Số người mẫu cố định của runway 3D trang chủ. */
export const HOME_RUNWAY_SIZE = 5;
const HOME_DESCRIPTION_MAX = 160;

function homeDescription(collection: CollectionLookbook): string {
  const text = (collection.homeStory || collection.storyDesc || '').trim();
  if (!text) return 'Những thiết kế thanh lịch tôn vinh phong cách riêng của bạn.';
  return text.length > HOME_DESCRIPTION_MAX ? `${text.slice(0, HOME_DESCRIPTION_MAX - 1).trimEnd()}…` : text;
}

/**
 * Dựng runway trang chủ từ CMS: các bộ sưu tập `showOnHome` có `homeModel`, sắp theo `homeSortOrder` rồi thứ tự gốc.
 * Mỗi người mẫu mang tên và link của chính bộ sưu tập. Chỉ khi có đúng 5 người mẫu hợp lệ mới trả về danh sách
 * (nhiều hơn 5 lấy 5 đầu); ít hơn 5 trả `null` để trang giữ `HERO_LOOKS` tĩnh.
 */
export function buildHomeRunwayLooks(collections: readonly CollectionLookbook[]): HeroLook[] | null {
  const eligible = collections
    .map((collection, order) => ({ collection, order }))
    .filter(({ collection }) => collection.showOnHome && collection.homeModel.trim().length > 0)
    .sort((a, b) => a.collection.homeSortOrder - b.collection.homeSortOrder || a.order - b.order)
    .slice(0, HOME_RUNWAY_SIZE);
  if (eligible.length !== HOME_RUNWAY_SIZE) return null;
  return eligible.map(({ collection }) => ({
    id: collection.id,
    collectionName: collection.name || 'Velura Collection',
    title: collection.storyHeadline || collection.name,
    eyebrow: 'VELURA',
    season: collection.colNumber || 'SPRING / SUMMER 2027',
    description: homeDescription(collection),
    badge: collection.badge || 'ELEGANT',
    looksCount: collection.kicker || '10 LOOKS',
    image: collection.homeModel,
    link: collection.categoryLink || `/collections#${collection.id}`,
  }));
}

interface UnpaidNotice {
  orderId: string;
  orderCode: string;
}

/**
 * Đọc thông báo đơn online vừa bị hủy hoặc hết hạn thanh toán, do checkout ghi vào session.
 */
function readUnpaidNotice(): UnpaidNotice | null {
  try {
    const raw = sessionStorage.getItem('velura_unpaid_notice');
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<UnpaidNotice>;
    const orderId = parsed.orderId || '';
    const orderCode = parsed.orderCode || orderId;
    if (!orderCode) {
      return null;
    }
    return { orderId, orderCode };
  } catch {
    return null;
  }
}

@Component({
  selector: 'app-home-page',
  imports: [RouterLink, ProductCard],
  templateUrl: './home.page.html',
})
export class HomePage implements AfterViewInit, OnDestroy {
  private readonly catalog = inject(CatalogService);
  private readonly blogCatalog = inject(BlogCatalogService);
  private readonly auth = inject(AuthService);
  private readonly styleProfile = inject(StyleProfileService);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private carouselCleanups: Array<() => void> = [];

  @ViewChild('categoriesTrack') private categoriesTrack?: ElementRef<HTMLElement>;
  @ViewChild('productsTrack') private productsTrack?: ElementRef<HTMLElement>;

  readonly heroLooks = signal<HeroLook[]>(HERO_LOOKS);
  readonly activeModelIndex = signal(2); // Model 3 (In Bloom) starts in center

  readonly activeLook = computed(() => this.heroLooks()[this.activeModelIndex()] || this.heroLooks()[0] || HERO_LOOKS[0]);

  readonly modelCounterLabel = computed(() => {
    const totalCount = this.heroLooks().length;
    const num = (this.activeModelIndex() + 1).toString().padStart(2, '0');
    const total = totalCount.toString().padStart(2, '0');
    return `${num} / ${total}`;
  });

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly categories = signal<CategorySummary[]>([]);
  readonly products = signal<ProductSummary[]>([]);
  readonly catalogProducts = signal<ProductSummary[]>([]);
  readonly personalized = signal<ProductSummary[]>([]);
  readonly personalizedSubtitle = signal('Được tuyển chọn dựa trên Style Profile cá nhân');
  /** Reads published journal entries from the existing content API for the home editorial block. */
  readonly journalPosts = computed(() => this.blogCatalog.list().slice(0, 4));
  /** The first published editorial entry leads the homepage journal layout. */
  readonly featuredJournalPost = computed<BlogPost | null>(() => this.journalPosts()[0] ?? null);
  /** Supporting journal entries use the same live content response as the featured entry. */
  readonly supportingJournalPosts = computed(() => this.journalPosts().slice(1, 4));
  readonly unpaidNotice = signal(readUnpaidNotice());
  readonly unpaidOrdersLink = computed(() => (this.auth.isLoggedIn() ? '/account/orders' : '/account/track'));
  /** Chiến dịch đang chạy cho thanh tin ưu đãi, đọc từ API thay vì mảng viết cứng. */
  readonly banners = toSignal(inject(OffersService).highlights(), { initialValue: [] });
  readonly collections = computed(() => {
    const products = this.catalogProducts();
    const names = new Set(products.map((item) => item.collection).filter(Boolean));
    return COLLECTION_LOOKBOOKS
      .filter((item) => names.has(item.name))
      .map((item) => {
        const product = products.find((candidate) => candidate.collection === item.name);
        return {
          ...item,
          banner: toPublicAsset(product?.thumbnail_url || product?.images?.[0], '/assets/images/placeholder.jpg'),
        };
      });
  });
  readonly quizPopupOpen = signal(false);

  constructor() {
    useBodyClass('page-home');
    this.loadHome();
    if (this.auth.consumeNewMemberWelcome()) {
      setTimeout(() => {
        this.quizPopupOpen.set(true);
      }, 1200);
    }
  }

  closeQuizPopup(): void {
    this.quizPopupOpen.set(false);
  }

  ngAfterViewInit(): void {
    if (!this.loading()) {
      this.bindCarousels();
    }
  }

  getModelDistance(index: number): number {
    const current = this.activeModelIndex();
    const total = this.heroLooks().length;
    let diff = index - current;
    while (diff > total / 2) diff -= total;
    while (diff < -total / 2) diff += total;
    return diff;
  }

  /** Checks whether a hero CTA URL points to an external HTTPS target. */
  isExternalLink(url: string | null | undefined): boolean {
    return isExternalCmsLink(url);
  }

  /** Parses an internal CMS link into a `UrlTree` so query strings like `?category=dam-vay` stay intact. */
  cmsLink(url: string | null | undefined): UrlTree | string {
    return parseInternalCmsLink(this.router, url, '/products');
  }

  onModelClick(index: number): void {
    if (this.activeModelIndex() === index) {
      const looks = this.heroLooks();
      const link = looks[index]?.link || '/products';
      navigateCmsLink(this.router, link, '/products');
    } else {
      this.activeModelIndex.set(index);
    }
  }

  prevModel(): void {
    const current = this.activeModelIndex();
    const total = this.heroLooks().length;
    this.activeModelIndex.set((current - 1 + total) % total);
  }

  nextModel(): void {
    const current = this.activeModelIndex();
    const total = this.heroLooks().length;
    this.activeModelIndex.set((current + 1) % total);
  }

  /**
   * Safe image error fallback preventing infinite retry loop and missing assets.
   * Falls back to the bundled cutout of the same runway position, so one broken upload never duplicates another model.
   */
  onModelImgError(event: Event, index: number): void {
    const img = event.target as HTMLImageElement | null;
    if (!img || img.dataset['fallback']) return;
    img.dataset['fallback'] = '1';
    img.src = `/assets/images/models/model_cutout_${(index % HOME_RUNWAY_SIZE) + 1}.png`;
  }

  /**
   * Loads homepage category and featured product widgets.
   */
  loadHome(): void {
    this.loading.set(true);
    this.loadError.set(null);

    if (typeof this.catalog.getCollections === 'function') {
      this.catalog
        .getCollections()
        .pipe(
          take(1),
          catchError(() => of<CollectionLookbook[]>([]))
        )
        .subscribe((collections) => {
          const runway = buildHomeRunwayLooks(collections ?? []);
          if (runway) {
            this.heroLooks.set(
              runway.map((look) => ({
                ...look,
                link: `/collections?collection=${encodeURIComponent(look.id)}`,
              }))
            );
          }
        });
    }

    forkJoin({
      categories: this.catalog.getCategories().pipe(catchError(() => of<CategorySummary[]>([]))),
      products: this.catalog.getProducts().pipe(
        catchError((error: Error) => {
          this.loadError.set(error.message);
          return of<ProductSummary[]>([]);
        }),
      ),
    }).subscribe({
      next: ({ categories, products }) => {
        this.categories.set(categories);
        const catalog = products.filter((item) => {
          const name = (item.name || '').toLowerCase();
          return !name.includes('test') && !name.includes('validation') && !name.includes('commit');
        });
        this.catalogProducts.set(catalog);
        const activeFeatured = catalog
          .filter((item) => item.is_featured && (item.sold_count || 0) > 0)
          .sort((a, b) => (b.sold_count || 0) - (a.sold_count || 0));
        const quietFeatured = catalog.filter((item) => item.is_featured && (item.sold_count || 0) === 0);
        const featured = [...activeFeatured, ...quietFeatured];
        this.products.set((featured.length ? featured : catalog).slice(0, 4));
        this.bindPersonalized(catalog);
        this.loading.set(false);
        afterNextRender(() => {
          this.bindCarousels();
          window.setTimeout(() => this.bindCarousels(), 200);
        }, { injector: this.injector });
      },
    });
  }

  ngOnDestroy(): void {
    this.carouselCleanups.forEach((cleanup) => cleanup());
  }

  /**
   * Maps a category slug to the existing Velura icon asset.
   */
  categoryIcon(slug: string | undefined): string {
    const key = slug || 'ao';
    return `/assets/images/category-icons/icon-${key}.png`;
  }

  dismissUnpaid(): void {
    sessionStorage.removeItem('velura_unpaid_notice');
    this.unpaidNotice.set(null);
  }

  private bindPersonalized(catalog: ProductSummary[]): void {
    let bodyShape = '';
    try {
      const raw = this.styleProfile.guestAnswers();
      bodyShape = raw?.body_shape || '';
    } catch {
      bodyShape = '';
    }
    if (!bodyShape) {
      this.personalized.set([]);
      return;
    }
    const shapeMap: Record<string, string> = {
      Hourglass: 'Đồng hồ cát',
      Pear: 'Quả lê',
      Apple: 'Quả táo',
      Rectangle: 'Chữ nhật',
      'Inverted Triangle': 'Tam giác ngược',
    };
    const matched = catalog
      .filter((item) =>
        (item.suitable_body_shapes || []).map((shape) => shape.toLowerCase()).includes(bodyShape.toLowerCase()),
      )
      .slice(0, 4);
    this.personalized.set(matched);
    this.personalizedSubtitle.set(`Các thiết kế được gợi ý riêng cho dáng người ${shapeMap[bodyShape] || bodyShape}`);
  }

  private bindCarousels(): void {
    this.carouselCleanups.forEach((cleanup) => cleanup());
    this.carouselCleanups = [
      bindHomeCarousel(this.categoriesTrack?.nativeElement, { label: 'Danh mục nổi bật', scrollRatio: 0.75 }),
    ];
  }
}
