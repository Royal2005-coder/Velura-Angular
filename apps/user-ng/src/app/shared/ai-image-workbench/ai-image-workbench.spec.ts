import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, Subject, throwError, timer, firstValueFrom } from 'rxjs';
import { AiEngineService, AiJob } from '../../core/services/ai-engine.service';
import { ApiService, UserIdentity } from '../../core/services/api.service';
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
    capabilities: Mock;
  };
  let api: {
    me: Mock;
  };
  const verifiedMemberIdentity: UserIdentity = {
    user: { id: 'u1' },
    profile: { user_id: 'u1', role: 'member', is_active: true },
    role: 'member',
    isAdmin: false,
  };
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    localStorage.setItem('velura_token', 't');
    localStorage.setItem('velura_user', JSON.stringify({ user_id: 'u1', role: 'member' }));
    model = {
      upload: vi.fn(() => of({ asset_id: 'asset', expires_at: '' })),
      create: vi.fn(() => of({ job: quality })),
      cancel: vi.fn(() => of({})),
      studioPreview: vi.fn(() => of(new Blob(['image'], { type: 'image/png' }))),
      job: vi.fn(() => of({ job: { ...quality, status: 'cancelled' as const } })),
      capabilities: vi.fn(() => of({ enabled: true, product_supported: true, variant_supported: true, tasks: [{ task: 'virtual_try_on', enabled: true }] })),
    };
    api = {
      me: vi.fn(() => of(verifiedMemberIdentity)),
    };
    TestBed.configureTestingModule({
      imports: [AiImageWorkbench],
      providers: [
        provideRouter([]),
        { provide: AiEngineService, useValue: model },
        { provide: ApiService, useValue: api },
      ],
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
  async function photo(p: AiImageWorkbench) {
    await p.select({
      target: { files: [new File(['image'], 'photo.png', { type: 'image/png' })], value: '' },
    } as unknown as Event);
  }
  it('never uploads without explicit consent', async () => {
    const p = page();
    ready(p);
    await photo(p);
    await p.validate();
    expect(model.upload).not.toHaveBeenCalled();
  });
  it('successful measurements with an invalid gate cannot unlock personal try-on', async () => {
    const p = page();
    ready(p);
    await photo(p);
    p.consent.set(true);
    await p.validate();
    expect(p.qualityPassed()).toBe(false);
    await p.generate();
    expect(model.create).toHaveBeenCalledTimes(1);
    expect(model.create.mock.calls[0][0].person_check).toBe(true);
  });
  it('disabled capability cannot queue a task despite confirmation', async () => {
    const p = page();
    await photo(p);
    p.consent.set(true);
    await p.validate();
    expect(model.create).not.toHaveBeenCalled();
  });
  it('cannot upload or queue an unsupported variant even after a successful quality proof', async () => {
    const p = page();
    ready(p);
    await photo(p);
    p.capabilities.update(value => value ? { ...value, variant_supported: false } : value);
    p.consent.set(true); p.qualityPassed.set(true);
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
    await photo(p);
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
  it('a new photo clears consent and the old quality proof', async () => {
    const p = page();
    ready(p);
    p.consent.set(true);
    p.qualityPassed.set(true);
    await photo(p);
    expect(p.consent()).toBe(false);
    expect(p.qualityPassed()).toBe(false);
  });
  it('retries an uncertain submission with the same idempotency key', async () => {
    const p = page();
    ready(p);
    await photo(p);
    p.consent.set(true);
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
  it('clears private previews and consent when the account changes', async () => {
    const fixture = TestBed.createComponent(AiImageWorkbench);
    fixture.detectChanges();
    const p = fixture.componentInstance;
    await photo(p);
    p.result.set('blob:private-result');
    p.consent.set(true);
    TestBed.inject(AuthService).applySession('token', { user_id: 'next-customer' });
    fixture.detectChanges();
    expect(p.preview()).toBe('');
    expect(p.result()).toBe('');
    expect(p.consent()).toBe(false);
  });
  it('requires a loaded studio preview and fresh consent before generating', async () => {
    localStorage.setItem('velura_token', 't');
    localStorage.setItem('velura_user', JSON.stringify({ user_id: 'u1', role: 'member' }));
    const p = page();
    ready(p);
    await p.verifyMemberIdentity();
    p.chooseMode('studio');
    p.consent.set(true);
    const response = new Subject<Blob>();
    model.studioPreview.mockReturnValue(response);
    const loading = p.selectStudio({ target: { value: 'licensed-model' } } as unknown as Event);
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
  it('resumes only a stored job matching the current product and variant on open', async () => {
    localStorage.setItem('velura_token', 't');
    localStorage.setItem('velura_user', JSON.stringify({ user_id: 'u1', role: 'member' }));
    const p = page();
    const capabilities = {
      enabled: true,
      product_supported: true,
      variant_supported: true,
      studio_assets: [],
      tasks: [{ task: 'virtual_try_on' as const, enabled: true }],
      max_upload_bytes: 100,
      private_ttl_seconds: 900,
      local_only: true,
    };
    Object.assign(model, {
      capabilities: vi.fn(() => of(capabilities)),
      result: vi.fn(() => of(new Blob(['image'], { type: 'image/png' }))),
    });
    sessionStorage.setItem(
      `velura_ai_job_u1_virtual_try_on_product_variant`,
      'resumed-job',
    );
    model.job.mockReturnValueOnce(
      of({
        job: {
          ...quality,
          id: 'resumed-job',
          task: 'virtual_try_on',
          status: 'success',
          product_id: 'other-product',
          variant_id: 'variant',
        },
      }),
    );
    await p.open();
    expect(p.job()).toBeNull();
    model.job.mockReturnValueOnce(
      of({
        job: {
          ...quality,
          id: 'resumed-job',
          task: 'virtual_try_on',
          status: 'success',
          product_id: 'product',
          variant_id: 'variant',
        },
      }),
    );
    await p.open();
    expect(p.job()?.id).toBe('resumed-job');
    expect(p.result()).toBe('blob:preview');
  });
  describe('availability and member gate', () => {
    function member(): void {
      localStorage.setItem('velura_token', 't');
      localStorage.setItem('velura_user', JSON.stringify({ user_id: 'u1', role: 'member' }));
      TestBed.inject(AuthService).refresh();
    }
    it('offers try-on only for products and exact variants the server marked supported', async () => {
      member();
      model.capabilities.mockReturnValueOnce(of({ enabled: true, product_supported: true, variant_supported: false, tasks: [] }));
      const p = page();
      await Promise.resolve();
      expect(p.offered()).toBe(false);
      expect(model.capabilities).toHaveBeenCalledWith('product', 'variant');
    });
    it('shows the entry point for a supported product and exact variant', async () => {
      member();
      const p = page();
      await firstValueFrom(timer(50));
      expect(p.offered()).toBe(true);
    });
    it('hides the entry point when readiness cannot be read', async () => {
      member();
      model.capabilities.mockReturnValueOnce(throwError(() => new Error('offline')));
      const p = page();
      await Promise.resolve();
      await Promise.resolve();
      expect(p.offered()).toBe(false);
    });
    it('asks a guest to sign in or register and never reads capabilities for the dialog', async () => {
      localStorage.clear();
      sessionStorage.clear();
      TestBed.inject(AuthService).refresh();
      const p = page();
      expect(p.memberRequired()).toBe(true);
      model.capabilities.mockClear();
      await p.open();
      expect(model.capabilities).not.toHaveBeenCalled();
    });
    it('lets a signed-in account open the dialog and fetch capabilities', async () => {
      member();
      const p = page();
      model.capabilities.mockClear();
      await p.open();
      expect(p.memberRequired()).toBe(false);
      expect(model.capabilities).toHaveBeenCalled();
    });
    it('rejects inactive and mismatched identities while allowing active admins', async () => {
      member();
      api.me.mockReturnValue(of({
        user: { id: 'u1' },
        profile: { user_id: 'u2', role: 'member', is_active: true },
        role: 'member',
        isAdmin: false,
      }));
      const p = page();
      const allowed = await p.verifyMemberIdentity();
      expect(allowed).toBe(false);
      expect(p.memberRequired()).toBe(false);

      api.me.mockReturnValue(of({
        user: { id: 'u1' },
        profile: { user_id: 'u1', role: 'member', is_active: false },
        role: 'member',
        isAdmin: false,
      }));
      expect(await p.verifyMemberIdentity()).toBe(false);

      api.me.mockReturnValue(of({
        user: { id: 'u1' },
        profile: { user_id: 'u1', role: 'admin', is_active: true },
        role: 'super_admin',
        isAdmin: true,
      }));
      expect(await p.verifyMemberIdentity()).toBe(true);
    });
    it('keeps a live session usable when /me is temporarily unavailable', async () => {
      member();
      api.me.mockReturnValue(throwError(() => new Error('offline')));
      const p = page();
      expect(await p.verifyMemberIdentity()).toBe(true);
    });
    it('blocks direct select, validate, generate, and studio bypass attempts for unverified users', async () => {
      localStorage.clear();
      sessionStorage.clear();
      TestBed.inject(AuthService).refresh();
      api.me.mockReturnValue(throwError(() => new Error('unauthenticated')));
      const p = page();
      ready(p);
      const openModalSpy = vi.spyOn(p as unknown as { openGateModal: () => void }, 'openGateModal');

      await p.select({ target: { files: [new File(['x'], 'x.png', { type: 'image/png' })] } } as unknown as Event);
      expect(p.preview()).toBe('');
      expect(openModalSpy).toHaveBeenCalled();

      await p.generate();
      expect(model.create).not.toHaveBeenCalled();

      await p.validate();
      expect(model.upload).not.toHaveBeenCalled();
    });
    it('ignores stale capability responses across rapid variant switches', async () => {
      const firstSubject = new Subject<{ enabled: boolean; product_supported: boolean; variant_supported: boolean; tasks: { task: 'virtual_try_on'; enabled: boolean }[] }>();
      const secondSubject = new Subject<{ enabled: boolean; product_supported: boolean; variant_supported: boolean; tasks: { task: 'virtual_try_on'; enabled: boolean }[] }>();

      model.capabilities.mockReturnValueOnce(firstSubject).mockReturnValueOnce(secondSubject);

      const fixture = TestBed.createComponent(AiImageWorkbench);
      fixture.componentRef.setInput('productId', 'prod-1');
      fixture.componentRef.setInput('variantId', 'var-1');
      fixture.detectChanges();

      fixture.componentRef.setInput('variantId', 'var-2');
      fixture.detectChanges();

      secondSubject.next({ enabled: true, product_supported: true, variant_supported: true, tasks: [{ task: 'virtual_try_on', enabled: true }] });
      secondSubject.complete();
      firstSubject.next({ enabled: true, product_supported: true, variant_supported: false, tasks: [{ task: 'virtual_try_on', enabled: true }] });
      firstSubject.complete();
      await firstValueFrom(timer(0));
      expect(fixture.componentInstance.offered()).toBe(true);
    });
  });
});
