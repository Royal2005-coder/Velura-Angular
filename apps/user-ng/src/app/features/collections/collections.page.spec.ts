import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { COLLECTION_LOOKBOOKS, CollectionLookbook } from '../../core/models/collection-lookbook';
import { ProductSummary } from '../../core/models/product.interface';
import { ApiService } from '../../core/services/api.service';
import { CatalogService } from '../../core/services/catalog.service';
import {
  createStorefrontPage,
  sampleProduct,
  stubActivatedRoute,
  stubApiService,
  stubCatalogService,
} from '../../../testing/storefront-testing';
import { CollectionsPage } from './collections.page';

function product(id: string, overrides: Partial<ProductSummary> = {}): ProductSummary {
  return { ...sampleProduct, product_id: id, name: `Sản phẩm ${id}`, collection: 'Soft Ceremony', ...overrides };
}

function lookbook(overrides: Partial<CollectionLookbook> = {}): CollectionLookbook {
  return { ...COLLECTION_LOOKBOOKS[0], id: 'soft-ceremony', name: 'Soft Ceremony', productIds: [], ...overrides };
}

/** Dựng CollectionsPage với danh sách collection + sản phẩm của ca test và trả fixture để đọc DOM. */
async function renderCollections(collections: CollectionLookbook[], products: ProductSummary[]) {
  TestBed.resetTestingModule();
  await TestBed.configureTestingModule({
    imports: [CollectionsPage],
    providers: [
      provideRouter([]),
      { provide: ApiService, useValue: stubApiService() },
      { provide: ActivatedRoute, useValue: stubActivatedRoute() },
      {
        provide: CatalogService,
        useValue: { ...stubCatalogService(), getCollections: () => of(collections), getProducts: () => of(products) },
      },
    ],
  }).compileComponents();
  const fixture = TestBed.createComponent(CollectionsPage);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const root = fixture.nativeElement as HTMLElement;
  return { page: fixture.componentInstance, root };
}

function cardTitles(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('.collection-item-card__title')).map((el) => (el.textContent ?? '').trim());
}

describe('CollectionsPage', () => {
  it('creates the ViewModel with a stub Model (no HttpClient)', async () => {
    const page = await createStorefrontPage(CollectionsPage);
    expect(page).toBeTruthy();
  });

  it('shows exactly the productIds in CMS order and ignores same-collection products that were not chosen', async () => {
    const products = [
      product('a'),
      product('b'),
      product('c'),
      // Cùng tên collection nhưng không được chọn => không được xuất hiện.
      product('not-chosen', { collection: 'Soft Ceremony' }),
    ];
    const { root } = await renderCollections([lookbook({ productIds: ['c', 'a'] })], products);
    expect(cardTitles(root)).toEqual(['Sản phẩm c', 'Sản phẩm a']);
  });

  it('drops ids that are no longer in the catalog without error', async () => {
    const { root } = await renderCollections(
      [lookbook({ productIds: ['gone', 'b', 'missing'] })],
      [product('a'), product('b')],
    );
    expect(cardTitles(root)).toEqual(['Sản phẩm b']);
  });

  it('shows the empty state instead of guessing products when productIds is empty', async () => {
    const { root } = await renderCollections([lookbook({ productIds: [] })], [product('a'), product('b')]);
    expect(root.querySelectorAll('.collection-item-card').length).toBe(0);
    expect(root.querySelector('.collections-empty-notice')).toBeTruthy();
  });

  it('renders the cover image and no cutouts when heroMode is cover', async () => {
    const { root } = await renderCollections(
      [lookbook({ heroMode: 'cover', banner: 'https://cdn.example.com/cover.png' })],
      [],
    );
    const cover = root.querySelector<HTMLImageElement>('.collection-hero__cover');
    expect(cover?.getAttribute('src')).toBe('https://cdn.example.com/cover.png');
    expect(root.querySelectorAll('.collection-model').length).toBe(0);
  });

  it('renders the five cutouts and no cover image when heroMode is models', async () => {
    const { root } = await renderCollections(
      [lookbook({ heroMode: 'models', banner: 'https://cdn.example.com/cover.png' })],
      [],
    );
    expect(root.querySelectorAll('.collection-model').length).toBe(5);
    expect(root.querySelector('.collection-hero__cover')).toBeNull();
  });

  it('falls back to the cutouts when cover mode has no banner image', async () => {
    const { root } = await renderCollections([lookbook({ heroMode: 'cover', banner: '' })], []);
    expect(root.querySelectorAll('.collection-model').length).toBe(5);
    expect(root.querySelector('.collection-hero__cover')).toBeNull();
  });

  it('shows the short description as hero lede only when homeStory is set', async () => {
    const withLede = await renderCollections([lookbook({ homeStory: 'Mô tả ngắn của bộ sưu tập' })], []);
    expect(withLede.root.querySelector('.collection-hero__lede')?.textContent?.trim()).toBe('Mô tả ngắn của bộ sưu tập');
    const withoutLede = await renderCollections([lookbook({ homeStory: '' })], []);
    expect(withoutLede.root.querySelector('.collection-hero__lede')).toBeNull();
  });
});
