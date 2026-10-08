import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { AdminSessionService } from '../../core/admin-session.service';
import { AdminCatalogContentService, CatalogDraft, CatalogSource } from '../../core/admin-catalog-content.service';
import { CatalogContentEditor } from './catalog-content-editor';

const source: CatalogSource = { productId: 'product', version: 1, revision: 'r1', fields: { name: 'Áo' }, photos: [] };
const claim = { text: 'Áo', sources: [{ field: 'name', quote: 'Áo' }] };
const draft: CatalogDraft = {
  id: 'draft', product_id: 'product', source, version: 1, status: 'draft', reviewed: null, created_at: '',
  metadata: { model: 'model', schema: 'schema', prompt: 'prompt', sourceRevision: 'r1' },
  generated: { title: claim, short: claim, long: claim, highlights: [], care: [], styling: [], seoTitle: claim, metaDescription: claim, proposedSlug: 'ao', primaryKeywords: [claim], secondaryKeywords: [], alt: [], tags: [] },
};
const model = {
  drafts: vi.fn(() => of({ source, drafts: [draft] })),
  generate: vi.fn(() => of({ id: 'batch', status: 'complete' as const, completed: 1, total: 1, items: [] })),
  batch: vi.fn(() => of({ id: 'batch', status: 'complete' as const, completed: 1, total: 1, items: [] })),
  review: vi.fn(() => of({ ...draft, status: 'approved' as const, reviewed: draft.generated, version: 2 })),
  publish: vi.fn(() => of({ ...draft, status: 'published' as const, reviewed: draft.generated, version: 3 })),
  facts: vi.fn(() => of({ ...source, version: 2, revision: 'r2' })),
};
describe('CatalogContentEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({ imports: [CatalogContentEditor], providers: [
      { provide: AdminCatalogContentService, useValue: model },
      { provide: AdminSessionService, useValue: { session: signal(null), canMutate: () => true } },
    ] });
  });
  afterEach(() => TestBed.resetTestingModule());
  it('does not publish on generation or approval', async () => {
    const fixture = TestBed.createComponent(CatalogContentEditor); fixture.detectChanges();
    fixture.componentRef.setInput('products', [{ productId: 'product', expectedVersion: 1 }]);
    const component = fixture.componentInstance;
    await component.generate(); component.select(structuredClone(draft)); await component.review('approve');
    expect(model.generate).toHaveBeenCalledTimes(1);
    expect(model.publish).not.toHaveBeenCalled();
    expect(component.selected()?.status).toBe('approved');
  });
  it('local edits invalidate the publish action until explicitly approved again', async () => {
    const fixture = TestBed.createComponent(CatalogContentEditor); fixture.detectChanges();
    const component = fixture.componentInstance;
    component.select({ ...draft, status: 'approved', reviewed: draft.generated });
    component.editor.set(JSON.stringify({ ...draft.generated, proposedSlug: 'changed' }));
    await component.publish();
    expect(component.changedSinceApproval()).toBe(true);
    expect(model.publish).not.toHaveBeenCalled();
  });
  it('keeps live content unchanged when the server rejects a stale publication', async () => {
    const fixture = TestBed.createComponent(CatalogContentEditor); fixture.detectChanges();
    fixture.componentRef.setInput('liveContent', { title: 'Original', description: 'Original description', seoTitle: 'Original SEO', metaDescription: 'Original meta', slug: 'original' });
    const component = fixture.componentInstance;
    component.select({ ...draft, status: 'approved', reviewed: draft.generated });
    model.publish.mockImplementationOnce(() => throwError(() => ({ error: { message: 'SOURCE_REVISION_STALE' } })));
    const published = vi.fn(); component.published.subscribe(published);
    await component.publish();
    expect(component.error()).toBe('SOURCE_REVISION_STALE');
    expect(component.liveContent().title).toBe('Original');
    expect(component.selected()?.status).toBe('approved');
    expect(published).not.toHaveBeenCalled();
  });
  it('missing material/care is not replaced by advice in the review preview', () => {
    const fixture = TestBed.createComponent(CatalogContentEditor); fixture.detectChanges();
    const component = fixture.componentInstance; component.source.set(source); component.select(draft);
    expect(component.sourceFields()).toEqual([{ field: 'name', value: 'Áo' }]);
    expect(component.preview()?.care).toEqual([]);
    expect(component.preview()?.styling).toEqual([]);
  });
  it('a failed generation does not clear review history or change current content', async () => {
    const fixture = TestBed.createComponent(CatalogContentEditor); fixture.detectChanges();
    fixture.componentRef.setInput('products', [{ productId: 'product', expectedVersion: 1 }]);
    const component = fixture.componentInstance; component.select(draft); component.drafts.set([draft]);
    model.generate.mockImplementationOnce(() => throwError(() => new Error('unavailable')));
    await component.generate();
    expect(component.selected()?.id).toBe('draft'); expect(component.drafts()).toEqual([draft]);
    expect(component.error()).not.toBe(''); expect(model.publish).not.toHaveBeenCalled();
  });
});
