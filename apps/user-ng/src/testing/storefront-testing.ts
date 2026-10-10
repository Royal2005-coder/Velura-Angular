import { AiEngineService } from '../app/core/services/ai-engine.service';
import { Type, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { convertToParamMap, provideRouter, ActivatedRoute } from '@angular/router';
import { of } from 'rxjs';
import { ApiService } from '../app/core/services/api.service';
import { CatalogService } from '../app/core/services/catalog.service';
import { ChatbotService, type ChatHandoffStatus } from '../app/core/services/chatbot.service';
import { ProductSummary } from '../app/core/models/product.interface';
import { AddressGeographyService } from '../app/core/services/address-geography.service';
import { StyleProfileService } from '../app/core/services/style-profile.service';
import type { GeographyMode } from '../app/core/models/address-geography';
import { VisualSearchModel } from '../app/core/services/visual-search.service';

/** Page specs receive administrative data from a mocked Model, never HttpClient. */
export function stubAddressGeographyService(): Pick<AddressGeographyService, 'load'> {
  return { load: (mode: GeographyMode) => of({ mode, source: 'fixture', retrieved_at: '', provinces: mode === 'current' ? [
    { code: 79, name: 'Thành phố Hồ Chí Minh', wards: [{ code: 26728, name: 'Xã Châu Pha' }, { code: 26704, name: 'Phường An Khánh' }] },
    { code: 1, name: 'Thành phố Hà Nội', wards: [{ code: 4, name: 'Phường Ba Đình' }] },
  ] : [
    { code: 79, name: 'Thành phố Hồ Chí Minh', districts: [{ code: 760, name: 'Quận 1', wards: [{ code: 26734, name: 'Phường Bến Nghé' }] }] },
    { code: 1, name: 'Thành phố Hà Nội', districts: [{ code: 1, name: 'Quận Ba Đình', wards: [{ code: 1, name: 'Phường Phúc Xá' }] }] },
  ] }) };
}

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
  'sendMessage' | 'listSessions' | 'listMessages' | 'deleteSession' | 'lifecycle' | 'guestId' | 'saveSessionId' | 'clearSessionId' | 'activeHandoff' | 'activeSession'
> {
  return {
    activeHandoff: signal<ChatHandoffStatus>('ai'),
    activeSession: signal(''),
    sendMessage: () => of({ messages: [], products: [], blogs: [] }),
    listSessions: () => of({ rows: [] }),
    listMessages: () => of({ messages: [], products: [], blogs: [] }),
    deleteSession: () => of({}),
    lifecycle: () => of({}),
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
      queryParams: {},
      data: { title: 'Velura', subtitle: 'test' },
    },
    paramMap: of(map),
    queryParamMap: of(convertToParamMap({})),
    queryParams: of({}),
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
      { provide: AiEngineService, useValue: { capabilities: () => of({enabled:false,local_only:true,tasks:[],max_upload_bytes:5242880,private_ttl_seconds:900}) } },
      { provide: VisualSearchModel, useValue: { cancel: () => of({}) } },
      { provide: AddressGeographyService, useValue: stubAddressGeographyService() },
      { provide: StyleProfileService, useValue: { revision: signal(0), guestAnswers: () => null, saveQuiz: () => of(undefined), loadRecommendations: () => of({ quiz: null, combos: [], categories: [] }) } },
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
