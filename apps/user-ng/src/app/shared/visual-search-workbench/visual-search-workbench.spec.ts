import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { VisualSearchModel, type VisualResult } from '../../core/services/visual-search.service';
import { sampleProduct } from '../../../testing/storefront-testing';
import { VisualSearchWorkbench } from './visual-search-workbench';

const result: VisualResult = { attributes: { category: 'dam-vay', color: null, fit: null, material: null, style: null }, matches: [], featured: [sampleProduct], catalog_version: 'v1', personalized: false };
describe('VisualSearchWorkbench', () => {
  const model = { validate: vi.fn(), search: vi.fn(), cancel: vi.fn(), crop: vi.fn(), camera: vi.fn() };
  beforeEach(() => {
    model.validate.mockResolvedValue(undefined);
    model.search.mockReturnValue(of(result));
    model.cancel.mockReturnValue(of({}));
    model.search.mockClear();
    TestBed.configureTestingModule({ imports: [VisualSearchWorkbench], providers: [{ provide: VisualSearchModel, useValue: model }, { provide: AuthService, useValue: { session: signal(null) } }] });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:garment');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  async function select(page: VisualSearchWorkbench): Promise<void> {
    page.select({ target: { files: [new File(['image'], 'dress.png', { type: 'image/png' })], value: '' } } as unknown as Event);
    await Promise.resolve(); await Promise.resolve();
  }
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
});
