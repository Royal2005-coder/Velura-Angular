import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { VisualSearchModel, type AiSearchResult, type VisualResult } from '../../core/services/visual-search.service';
import { sampleProduct } from '../../../testing/storefront-testing';
import { VisualSearchWorkbench } from './visual-search-workbench';

const result: VisualResult = { attributes: { category: 'dam-vay', color: null, fit: null, material: null, style: null }, matches: [], featured: [sampleProduct], catalog_version: 'v1', personalized: false };
const composedResult: AiSearchResult = { ...result, mode: 'composed', query_text: 'red flared dress', matches: [{ ...sampleProduct, similarity: 0.65, tier: 'similar', em_score: 0.4, is_score: 0.6 }], featured: [] };
describe('VisualSearchWorkbench', () => {
  const model = { validate: vi.fn(), search: vi.fn(), cancel: vi.fn(), crop: vi.fn(), camera: vi.fn(), searchComposed: vi.fn(), cancelAiSearch: vi.fn() };
  beforeEach(() => {
    model.validate.mockResolvedValue(undefined);
    model.search.mockReturnValue(of(result));
    model.cancel.mockReturnValue(of({}));
    model.searchComposed.mockReturnValue(of(composedResult));
    model.cancelAiSearch.mockReturnValue(of({}));
    model.search.mockClear();
    model.searchComposed.mockClear();
    model.cancelAiSearch.mockClear();
    model.cancel.mockClear();
    TestBed.configureTestingModule({ imports: [VisualSearchWorkbench], providers: [
      provideRouter([]),
      { provide: ApiService, useValue: { get: () => of({ items: [] }), post: () => of({}), delete: () => of({}) } },
      { provide: VisualSearchModel, useValue: model }, { provide: AuthService, useValue: { session: signal(null) } },
    ] });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:garment');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  async function select(page: VisualSearchWorkbench): Promise<void> {
    page.select({ target: { files: [new File(['image'], 'dress.png', { type: 'image/png' })], value: '' } } as unknown as Event);
    await Promise.resolve(); await Promise.resolve();
  }
  it('offers one local image picker and keeps live camera as the distinct alternative', () => {
    const fixture = TestBed.createComponent(VisualSearchWorkbench);
    fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(root.textContent).toContain('Chọn ảnh từ máy');
    expect(root.textContent).not.toContain('Chụp bằng thiết bị');
    expect(root.textContent).toContain('Mở máy ảnh');
  });
  it('requires consent and never treats featured products as similarity IDs', async () => {
    const fixture = TestBed.createComponent(VisualSearchWorkbench);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    const matches = vi.fn(); page.matches.subscribe(matches);
    await select(page);
    page.search(); expect(model.search).not.toHaveBeenCalled();
    page.consent.set(true); page.search();
    expect(matches).toHaveBeenCalledWith([]);
    expect(page.result()?.featured[0].product_id).toBe(sampleProduct.product_id);
    expect(page.preview()).toBe('');
    expect(model.search).toHaveBeenCalledTimes(1);
  });
  it('requires a visible crop before uploading and ignores late cancelled results', async () => {
    const fixture = TestBed.createComponent(VisualSearchWorkbench);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    await select(page);
    page.crop.set({ x: 10, y: 0, width: 90, height: 100 }); page.consent.set(true); page.search();
    expect(model.search).not.toHaveBeenCalled();
    page.crop.set({ x: 0, y: 0, width: 100, height: 100 });
    const pending = new Subject<VisualResult>(); model.search.mockReturnValue(pending);
    page.search(); page.cancel(); pending.next(result);
    expect(page.result()).toBeNull();
    expect(page.preview()).toBe('');
    expect(page.busy()).toBe(false);
  });
  it.each([
    { status: 503, code: 'VISUAL_INDEX_UNAVAILABLE', message: 'Chỉ mục tìm kiếm hình ảnh chưa sẵn sàng. Vui lòng thử lại sau.' },
    { status: 422, code: 'VISUAL_IMAGE_NO_DETAIL', message: 'Ảnh chỉ có một màu, chưa có chi tiết để tìm kiếm.' },
  ])('shows $code as an error without recommendations, but healthy no-match retains a suggestion rail', async ({ status, code, message }) => {
    const fixture = TestBed.createComponent(VisualSearchWorkbench);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    model.search.mockReturnValue(throwError(() => new HttpErrorResponse({ status, error: { error: { code, message } } })));
    await select(page); page.consent.set(true); page.search(); fixture.detectChanges();
    const root: HTMLElement = fixture.nativeElement;
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(root.querySelector('.vs-category-fallback')).toBeNull();
    expect(root.querySelectorAll('app-product-card')).toHaveLength(0);
    model.search.mockReturnValue(of(result));
    await select(page); page.consent.set(true); page.search(); fixture.detectChanges();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelector('.vs-category-fallback')).not.toBeNull();
    expect(root.querySelectorAll('app-product-card')).toHaveLength(1);
  });
  it('composes photo + text feedback through the AI endpoint and shows the understood modifier', async () => {
    const fixture = TestBed.createComponent(VisualSearchWorkbench);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    const matches = vi.fn(); page.matches.subscribe(matches);
    await select(page);
    page.modifier.set('màu đỏ, dáng xòe');
    page.consent.set(true);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Tìm theo ảnh + mô tả');
    page.search();
    expect(model.search).not.toHaveBeenCalled();
    expect(model.searchComposed).toHaveBeenCalledTimes(1);
    expect(model.searchComposed.mock.calls[0][2]).toBe('màu đỏ, dáng xòe');
    expect(matches).toHaveBeenCalledWith([sampleProduct.product_id]);
    expect((page.result() as AiSearchResult | null)?.query_text).toBe('red flared dress');
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.vs-understood')?.textContent).toContain('red flared dress');
  });
  it('cancels a composed query on the AI search lifecycle and ignores its late result', async () => {
    const fixture = TestBed.createComponent(VisualSearchWorkbench);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    await select(page);
    page.modifier.set('tay dài');
    page.consent.set(true);
    const pending = new Subject<AiSearchResult>();
    model.searchComposed.mockReturnValue(pending);
    page.search();
    expect(page.busy()).toBe(true);
    page.cancel();
    expect(model.cancelAiSearch).toHaveBeenCalledTimes(1);
    expect(model.cancel).not.toHaveBeenCalled();
    pending.next(composedResult);
    expect(page.result()).toBeNull();
    expect(page.busy()).toBe(false);
  });
});
