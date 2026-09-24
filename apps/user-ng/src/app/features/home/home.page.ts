import { AfterViewInit, Component, ElementRef, Injector, OnDestroy, ViewChild, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { catchError, forkJoin, of } from 'rxjs';
import { COLLECTION_LOOKBOOKS } from '../../core/models/collection-lookbook';
import { CategorySummary, ProductSummary } from '../../core/models/product.interface';
import { CatalogService } from '../../core/services/catalog.service';
import { OffersService } from '../../core/services/offers.service';
import { toSignal } from '@angular/core/rxjs-interop';
import { bindHomeCarousel } from '../../core/utils/home-carousel';
import { ProductCard } from '../../shared/product-card/product-card';

@Component({
  selector: 'app-home-page',
  imports: [RouterLink, ProductCard],
  host: { style: 'display:block' },
  templateUrl: './home.page.html',
})
export class HomePage implements AfterViewInit, OnDestroy {
  private readonly catalog = inject(CatalogService);
  private readonly injector = inject(Injector);
  private carouselCleanups: Array<() => void> = [];

  @ViewChild('heroVideo') private heroVideo?: ElementRef<HTMLVideoElement>;
  @ViewChild('categoriesTrack') private categoriesTrack?: ElementRef<HTMLElement>;
  @ViewChild('productsTrack') private productsTrack?: ElementRef<HTMLElement>;
  @ViewChild('collectionsTrack') private collectionsTrack?: ElementRef<HTMLElement>;

  readonly loading = signal(true);
  readonly loadError = signal<string | null>(null);
  readonly categories = signal<CategorySummary[]>([]);
  readonly products = signal<ProductSummary[]>([]);
  readonly catalogProducts = signal<ProductSummary[]>([]);
  readonly personalized = signal<ProductSummary[]>([]);
  readonly personalizedSubtitle = signal('Được tuyển chọn dựa trên Style Profile cá nhân');
  readonly soundOn = signal(false);
  /** Chiến dịch đang chạy cho thanh tin ưu đãi, đọc từ API thay vì mảng viết cứng. */
  readonly banners = toSignal(inject(OffersService).highlights(), { initialValue: [] });
  readonly collections = computed(() => {
    const names = new Set(this.catalogProducts().map((item) => item.collection).filter(Boolean));
    const matched = COLLECTION_LOOKBOOKS.filter((item) => names.has(item.name));
    return matched.length ? matched : COLLECTION_LOOKBOOKS;
  });

  constructor() {
    this.loadHome();
  }

  /**
   * Starts the hero video after the view is ready; browsers ignore autoplay without muted.
   */
  ngAfterViewInit(): void {
    const video = this.heroVideo?.nativeElement;
    if (video) {
      video.muted = true;
      video.playsInline = true;
      void Promise.resolve(video.play()).catch(() => undefined);
    }
    if (!this.loading()) {
      this.bindCarousels();
    }
  }

  /**
   * Loads homepage category and featured product widgets.
   */
  loadHome(): void {
    this.loading.set(true);
    this.loadError.set(null);
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
        this.products.set((featured.length ? featured : catalog).slice(0, 8));
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

  /**
   * Toggles the original hero video mute control.
   */
  toggleSound(): void {
    const video = this.heroVideo?.nativeElement;
    if (!video) {
      return;
    }
    const next = !this.soundOn();
    video.muted = !next;
    this.soundOn.set(next);
    if (next) {
      void Promise.resolve(video.play()).catch(() => undefined);
    }
  }

  private bindPersonalized(catalog: ProductSummary[]): void {
    let bodyShape = '';
    try {
      const raw = JSON.parse(localStorage.getItem('velura_guest_quiz_data') || 'null') as { body_shape?: string } | null;
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
      bindHomeCarousel(this.productsTrack?.nativeElement, { label: 'Sản phẩm nổi bật', scrollRatio: 0.95, autoplay: 'forward' }),
      bindHomeCarousel(this.collectionsTrack?.nativeElement, { label: 'Bộ sưu tập đặc biệt', scrollRatio: 0.9, autoplay: 'backward' }),
    ];
  }
}
