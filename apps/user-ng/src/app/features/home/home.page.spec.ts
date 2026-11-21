import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { COLLECTION_LOOKBOOKS, CollectionLookbook, normalizeCollectionLookbook } from '../../core/models/collection-lookbook';
import { ApiService } from '../../core/services/api.service';
import { CatalogService } from '../../core/services/catalog.service';
import { ChatbotService } from '../../core/services/chatbot.service';
import { StyleProfileService } from '../../core/services/style-profile.service';
import {
  createStorefrontPage,
  stubActivatedRoute,
  stubApiService,
  stubCatalogService,
  stubChatbotService,
} from '../../../testing/storefront-testing';
import { HERO_LOOKS, HomePage, buildHomeRunwayLooks } from './home.page';

/** Một collection CMS đủ điều kiện lên runway: có `showOnHome` và ảnh người mẫu riêng. */
function runwayCollection(index: number, overrides: Partial<CollectionLookbook> = {}): CollectionLookbook {
  return {
    ...COLLECTION_LOOKBOOKS[0],
    id: `col-${index}`,
    code: `col-${index}`,
    name: `Bộ sưu tập ${index}`,
    storyHeadline: `Tiêu đề ${index}`,
    homeStory: `Mô tả ngắn ${index}`,
    categoryLink: `/products?category=c${index}`,
    showOnHome: true,
    homeModel: `/assets/images/models/model_cutout_${index}.png`,
    homeSortOrder: index,
    ...overrides,
  };
}

/** Dựng HomePage với CatalogService trả đúng danh sách collection của ca test. */
async function createHomeWith(collections: CollectionLookbook[]): Promise<HomePage> {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [HomePage],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: stubApiService() },
      { provide: CatalogService, useValue: { ...stubCatalogService(), getCollections: () => of(collections) } },
      { provide: ChatbotService, useValue: stubChatbotService() },
      { provide: ActivatedRoute, useValue: stubActivatedRoute() },
      {
        provide: StyleProfileService,
        useValue: {
          revision: signal(0), guestAnswers: () => null, guestDraft: () => null,
          saveGuestDraft: () => undefined, claimGuestDraft: () => of(undefined),
          saveQuiz: () => of(undefined), loadQuiz: () => of(null),
          loadRecommendations: () => of({ quiz: null, combos: [], categories: [] }),
        },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(HomePage);
  fixture.detectChanges();
  return fixture.componentInstance;
}

describe('HomePage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(HomePage);
    expect(page).toBeTruthy();
  });

  it('loads featured catalog into signals from the CatalogService stub', async () => {
    const page = await createStorefrontPage(HomePage);
    expect(page.loading()).toBe(false);
    expect(page.loadError()).toBeNull();
    expect(page.products().length).toBeGreaterThan(0);
    expect(page.categories().some((row) => row.slug === 'ao')).toBe(true);
  });

  it('keeps the static runway when the CMS returns no homepage collections', async () => {
    const page = await createStorefrontPage(HomePage);
    expect(page.heroLooks()).toEqual(HERO_LOOKS);
  });

  it('replaces the runway with 5 CMS models ordered by homeSortOrder, each carrying its own collection name', async () => {
    const collections = [4, 2, 5, 1, 3].map((index) => runwayCollection(index));
    const page = await createHomeWith(collections);
    const looks = page.heroLooks();
    expect(looks.map((look) => look.collectionName)).toEqual([1, 2, 3, 4, 5].map((index) => `Bộ sưu tập ${index}`));
    expect(looks.map((look) => look.image)).toEqual([1, 2, 3, 4, 5].map((index) => `/assets/images/models/model_cutout_${index}.png`));
    expect(new Set(looks.map((look) => look.image)).size).toBe(5);
    expect(looks[0].link).toBe('/collections?collection=col-1');
    expect(looks[0].eyebrow).toBe('VELURA');
  });

  it('keeps HERO_LOOKS when only 4 collections are valid', async () => {
    const page = await createHomeWith([1, 2, 3, 4].map((index) => runwayCollection(index)));
    expect(page.heroLooks()).toEqual(HERO_LOOKS);
  });
});

describe('buildHomeRunwayLooks', () => {
  it('uses only the first 5 by order when 6 collections are valid', () => {
    const looks = buildHomeRunwayLooks([6, 5, 4, 3, 2, 1].map((index) => runwayCollection(index)));
    expect(looks?.map((look) => look.id)).toEqual(['col-1', 'col-2', 'col-3', 'col-4', 'col-5']);
  });

  it('drops collections that are on the homepage but have no homeModel, or are not showOnHome', () => {
    const collections = [
      runwayCollection(1),
      runwayCollection(2, { homeModel: '' }),
      runwayCollection(3),
      runwayCollection(4, { showOnHome: false }),
      runwayCollection(5),
      runwayCollection(6),
    ];
    // 4 hợp lệ (1, 3, 5, 6) => không đủ 5, giữ HERO_LOOKS.
    expect(buildHomeRunwayLooks(collections)).toBeNull();
    // Thêm một bộ hợp lệ => đủ 5, hai bộ không hợp lệ vẫn bị loại.
    const full = [...collections, runwayCollection(7)];
    expect(buildHomeRunwayLooks(full)?.map((look) => look.id)).toEqual(['col-1', 'col-3', 'col-5', 'col-6', 'col-7']);
  });

  it('breaks homeSortOrder ties with the API order', () => {
    const looks = buildHomeRunwayLooks([1, 2, 3, 4, 5].map((index) => runwayCollection(index, { homeSortOrder: 0 })));
    expect(looks?.map((look) => look.id)).toEqual(['col-1', 'col-2', 'col-3', 'col-4', 'col-5']);
  });

  it('describes with homeStory, falls back to storyDesc cut at 160 characters', () => {
    const long = 'x'.repeat(200);
    const collections = [1, 2, 3, 4, 5].map((index) =>
      runwayCollection(index, index === 2 ? { homeStory: '', storyDesc: long } : {}),
    );
    const looks = buildHomeRunwayLooks(collections);
    expect(looks?.[0].description).toBe('Mô tả ngắn 1');
    expect(looks?.[1].description.length).toBe(160);
    expect(looks?.[1].description.endsWith('…')).toBe(true);
  });

  it('rejects the static fallback lookbooks because none is placed on the homepage', () => {
    expect(buildHomeRunwayLooks(COLLECTION_LOOKBOOKS)).toBeNull();
  });
});

describe('normalizeCollectionLookbook CMS fields', () => {
  it('maps the homepage/cover/combo columns and defaults them when the API predates migration 132', () => {
    const mapped = normalizeCollectionLookbook({
      code: 'a', name: 'A', hero_mode: 'cover', home_model_url: '/assets/images/models/model_cutout_2.png',
      show_on_home: true, home_sort_order: 3, product_ids: ['p1', 'p2'], home_story: '',
    });
    expect(mapped).toMatchObject({
      heroMode: 'cover', homeModel: '/assets/images/models/model_cutout_2.png', showOnHome: true,
      homeSortOrder: 3, productIds: ['p1', 'p2'], homeStory: '',
    });
    const legacy = normalizeCollectionLookbook({ code: 'b', name: 'B', story_desc: 'chi tiết' });
    expect(legacy).toMatchObject({ heroMode: 'models', homeModel: '', showOnHome: false, homeSortOrder: 0, productIds: [], homeStory: '' });
  });
});
