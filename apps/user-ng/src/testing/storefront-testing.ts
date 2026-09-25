import { Type } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { convertToParamMap, provideRouter, ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { ApiService } from '../app/core/services/api.service';
import { CatalogService } from '../app/core/services/catalog.service';
import { ChatbotService } from '../app/core/services/chatbot.service';
import { ProductSummary } from '../app/core/models/product.interface';

const sampleProduct: ProductSummary = {
  product_id: 'p1',
  name: 'Áo linen Heritage',
  slug: 'ao-linen',
  base_price: 490000,
  sale_price: 390000,
  is_featured: true,
  sold_count: 3,
  category_slug: 'ao',
  category_name: 'Áo',
  collection: 'Heritage',
  thumbnail_url: '/assets/images/placeholder.jpg',
  images: ['/assets/images/placeholder.jpg'],
  variants: [{ variant_id: 'v1', color: 'trắng', size: 'M', stock_quantity: 4 }],
};

/**
 * JSON Model stub. Pages must not talk to HttpClient.
 */
export function stubApiService(): ApiService {
  return {
    get: (path: string) => {
      if (/\/products\/[^/]+$/.test(path)) {
        return of(sampleProduct);
      }
      if (path.includes('/products')) {
        return of([sampleProduct]);
      }
      if (path.includes('/categories')) {
        return of([{ category_id: 'c1', name: 'Áo', slug: 'ao' }]);
      }
      if (path.includes('/orders')) {
        return of({ orders: [] });
      }
      if (path.includes('/wishlist')) {
        return of({ items: [] });
      }
      if (path.includes('/style-quiz')) {
        return of({ quiz: null });
      }
      if (path.includes('/recommendations')) {
        return of({ quiz: null, combos: [], categories: [] });
      }
      if (path.includes('/content/blogs')) {
        return of({ rows: [] });
      }
      if (path.includes('/profile')) {
        return of({ full_name: 'Guest', email: 'guest@velura.test' });
      }
      if (path.includes('/chat')) {
        return of({ rows: [], messages: [], products: [], blogs: [] });
      }
      return of({});
    },
    post: () => of({}),
    patch: () => of({}),
    delete: () => of({}),
  } as unknown as ApiService;
}

export function stubCatalogService(): Pick<CatalogService, 'getCategories' | 'getProducts' | 'getProduct'> {
  return {
    getCategories: () => of([{ category_id: 'c1', name: 'Áo', slug: 'ao' }]),
    getProducts: () => of([sampleProduct]),
    getProduct: () => of(sampleProduct),
  };
}

export function stubChatbotService(): Pick<
  ChatbotService,
  'sendMessage' | 'listSessions' | 'listMessages' | 'deleteSession' | 'guestId' | 'saveSessionId' | 'clearSessionId'
> {
  return {
    sendMessage: () => of({ messages: [], products: [], blogs: [] }),
    listSessions: () => of({ rows: [] }),
    listMessages: () => of({ messages: [], products: [], blogs: [] }),
    deleteSession: () => of({}),
    guestId: () => '00000000-0000-4000-8000-000000000001',
    saveSessionId: () => undefined,
    clearSessionId: () => undefined,
  };
}

export function stubActivatedRoute(params: Record<string, string> = { id: 'p1', slug: 'heritage' }): ActivatedRoute {
  const map = convertToParamMap(params);
  return {
    snapshot: {
      paramMap: map,
      queryParamMap: convertToParamMap({}),
      data: { title: 'Velura', subtitle: 'test' },
    },
    paramMap: of(map),
    queryParamMap: of(convertToParamMap({})),
    data: of({ title: 'Velura', subtitle: 'test' }),
  } as unknown as ActivatedRoute;
}

let lastFixture: ComponentFixture<unknown> | undefined;

/**
 * Boots a storefront page ViewModel with Model stubs (lecture: HTTP lives in services).
 * `apiOverrides` thay từng hàm của ApiService giả cho ca test cần dữ liệu riêng.
 */
export async function createStorefrontPage<T>(page: Type<T>, apiOverrides: Partial<Record<'get' | 'post' | 'patch' | 'delete', unknown>> = {}): Promise<T> {
  lastFixture?.destroy();
  lastFixture = undefined;
  sessionStorage.clear();
  localStorage.clear();
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [page],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: { ...stubApiService(), ...apiOverrides } },
      { provide: CatalogService, useValue: stubCatalogService() },
      { provide: ChatbotService, useValue: stubChatbotService() },
      { provide: ActivatedRoute, useValue: stubActivatedRoute() },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(page);
  lastFixture = fixture as ComponentFixture<unknown>;
  fixture.detectChanges();
  return fixture.componentInstance;
}

/** Fixture của trang vừa dựng bằng `createStorefrontPage`, để đọc DOM đã render. */
export function lastStorefrontFixture(): ComponentFixture<unknown> {
  if (!lastFixture) throw new Error('createStorefrontPage chưa được gọi');
  return lastFixture;
}

export { sampleProduct };
