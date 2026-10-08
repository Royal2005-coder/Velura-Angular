import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { AiEngineService, AiJob } from '../../core/services/ai-engine.service';
import { AiImageWorkbench } from './ai-image-workbench';
import { AuthService } from '../../core/services/auth.service';
import type { Mock } from 'vitest';

const quality: AiJob = {
  id: 'job-quality',
  task: 'image_quality',
  status: 'success',
  created_at: '',
  expires_at: '',
  gate: { valid: false, reasons: ['BLURRY'] },
};
describe('AiImageWorkbench', () => {
  let model: {
    upload: Mock;
    create: Mock;
    cancel: Mock;
    studioPreview: Mock;
    job: Mock;
  };
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    model = {
      upload: vi.fn(() => of({ asset_id: 'asset', expires_at: '' })),
      create: vi.fn(() => of({ job: quality })),
      cancel: vi.fn(() => of({})),
      studioPreview: vi.fn(() => of(new Blob(['image'], { type: 'image/png' }))),
      job: vi.fn(() => of({ job: { ...quality, status: 'cancelled' as const } })),
    };
    TestBed.configureTestingModule({
      imports: [AiImageWorkbench],
      providers: [{ provide: AiEngineService, useValue: model }],
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  function page() {
    const fixture = TestBed.createComponent(AiImageWorkbench);
    fixture.componentRef.setInput('productId', 'product');
    fixture.componentRef.setInput('variantId', 'variant');
    fixture.detectChanges();
    return fixture.componentInstance;
  }
  function ready(p: AiImageWorkbench) {
    p.capabilities.set({
      enabled: true,
      product_supported: true,
      variant_supported: true,
      studio_assets: [{ id: 'licensed-model', label: 'Người mẫu nữ mô phỏng' }],
      tasks: [{ task: 'virtual_try_on', enabled: true }],
      max_upload_bytes: 100,
      private_ttl_seconds: 900,
      local_only: true,
    });
  }
  function photo(p: AiImageWorkbench) {
    p.select({
      target: { files: [new File(['image'], 'photo.png', { type: 'image/png' })], value: '' },
    } as unknown as Event);
  }
  it('never uploads without explicit consent', async () => {
    const p = page();
    ready(p);
    photo(p);
    await p.validate();
    expect(model.upload).not.toHaveBeenCalled();
  });
  it('successful measurements with an invalid gate cannot unlock personal try-on', async () => {
    const p = page();
    ready(p);
    photo(p);
    p.consent.set(true);
    await p.validate();
    expect(p.qualityPassed()).toBe(false);
    await p.generate();
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(model.create.mock.calls[0][0].person_check).toBe(true);
  });
  it('disabled capability cannot queue a task despite confirmation', async () => {
    const p = page();
    photo(p);
    p.consent.set(true);
    await p.validate();
    expect(model.create).not.toHaveBeenCalled();
  });
  it('cannot upload or queue an unsupported variant even after a successful quality proof', async () => {
    const p = page();
    ready(p); photo(p);
    p.capabilities.update(value => value ? { ...value, variant_supported: false } : value);
    p.consent.set(true); p.qualityPassed.set(true);
    await p.generate();
    expect(model.upload).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
  });
  it('adopts actual server state after cancellation instead of fabricating cancelled success', async () => {
    const p = page();
    p.job.set({ ...quality, status: 'running', expires_at: new Date(Date.now() + 60000).toISOString() });
    model.job.mockReturnValue(of({ job: { ...quality, status: 'failed' } }));
    await p.cancel();
    expect(p.job()?.status).toBe('failed');
    expect(p.result()).toBe('');
    expect(p.busy()).toBe(false);
  });
  it('studio selection does not transfer an unused personal photo', async () => {
    const p = page();
    ready(p);
    photo(p);
    p.mode.set('studio');
    p.studio.set('licensed-model');
    p.studioImage.set('blob:studio-model');
    p.consent.set(true);
    model.create.mockReturnValue(
      of({ job: { ...quality, task: 'virtual_try_on', status: 'validation_failed' } }),
    );
    await p.generate();
    expect(model.upload).not.toHaveBeenCalled();
    expect(model.create.mock.calls[0][0].person_asset_id).toBeUndefined();
  });
  it('a new photo clears consent and the old quality proof', () => {
    const p = page();
    ready(p);
    p.consent.set(true);
    p.qualityPassed.set(true);
    photo(p);
    expect(p.consent()).toBe(false);
    expect(p.qualityPassed()).toBe(false);
  });
  it('retries an uncertain submission with the same idempotency key', async () => {
    const p = page();
    ready(p);
    photo(p);
    p.consent.set(true);
    model.create.mockReturnValueOnce(throwError(() => new Error('response lost')));
    await p.validate();
    await p.validate();
    expect(model.create.mock.calls[0][0].idempotency_key).toBe(
      model.create.mock.calls[1][0].idempotency_key,
    );
  });
  it('does not display an old garment result after changing the selected variant', () => {
    const fixture = TestBed.createComponent(AiImageWorkbench);
    fixture.detectChanges();
    fixture.componentInstance.result.set('blob:old-garment');
    fixture.componentRef.setInput('variantId', 'another-variant');
    fixture.detectChanges();
    expect(fixture.componentInstance.result()).toBe('');
  });
  it('clears private previews and consent when the account changes', () => {
    const fixture = TestBed.createComponent(AiImageWorkbench);
    fixture.detectChanges();
    const p = fixture.componentInstance;
    photo(p);
    p.result.set('blob:private-result');
    p.consent.set(true);
    TestBed.inject(AuthService).applySession('token', { user_id: 'next-customer' });
    fixture.detectChanges();
    expect(p.preview()).toBe('');
    expect(p.result()).toBe('');
    expect(p.consent()).toBe(false);
  });
  it('requires a loaded studio preview and fresh consent before generating', async () => {
    const p = page();
    ready(p);
    p.chooseMode('studio');
    p.consent.set(true);
    const response = new Subject<Blob>();
    model.studioPreview.mockReturnValue(response);
    const loading = p.selectStudio({ target: { value: 'licensed-model' } } as unknown as Event);
    expect(p.consent()).toBe(false);
    expect(p.studioLoading()).toBe(true);
    p.setConsent({ target: { checked: true } } as unknown as Event);
    expect(p.consent()).toBe(false);
    await p.generate();
    expect(model.create).not.toHaveBeenCalled();
    response.next(new Blob(['studio'], { type: 'image/png' }));
    response.complete();
    await loading;
    expect(p.studioImage()).toBe('blob:preview');
    expect(p.studioLoading()).toBe(false);
  });
  it('does not queue studio work when preview retrieval fails', async () => {
    const p = page();
    ready(p);
    p.chooseMode('studio');
    model.studioPreview.mockReturnValue(throwError(() => new Error('not found')));
    await p.selectStudio({ target: { value: 'licensed-model' } } as unknown as Event);
    p.consent.set(true);
    await p.generate();
    expect(model.create).not.toHaveBeenCalled();
    expect(p.studioImage()).toBe('');
  });
});
