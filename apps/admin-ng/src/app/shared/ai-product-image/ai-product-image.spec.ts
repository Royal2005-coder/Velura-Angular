import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AdminAiEngineService } from '../../core/admin-ai-engine.service';
import { AiProductImage } from './ai-product-image';

describe('AiProductImage', () => {
  let model: { upload: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  beforeEach(() => {
    model = {
      upload: vi.fn(() => of({ asset_id: 'a', expires_at: '' })),
      create: vi.fn(() =>
        of({
          job: {
            id: 'j',
            task: 'image_quality',
            status: 'success',
            created_at: '',
            expires_at: '',
            gate: { valid: false, reasons: ['BLURRY'] },
          },
        }),
      ),
    };
    TestBed.configureTestingModule({
      imports: [AiProductImage],
      providers: [{ provide: AdminAiEngineService, useValue: model }],
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:original');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  function create() {
    const fixture = TestBed.createComponent(AiProductImage);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    page.capabilities.set({
      enabled: true,
      local_only: true,
      max_upload_bytes: 100,
      private_ttl_seconds: 900,
      tasks: [
        { task: 'image_quality', enabled: true },
        { task: 'product_image_enhance', enabled: true },
      ],
    });
    page.select({
      target: { files: [new File(['image'], 'source.png', { type: 'image/png' })], value: '' },
    } as unknown as Event);
    return page;
  }
  it('does not emit an unapproved or quality-failing original', async () => {
    const page = create();
    const accepted = vi.fn();
    page.accepted.subscribe(accepted);
    page.useOriginal();
    page.consent.set(true);
    await page.assess();
    page.useOriginal();
    expect(accepted).not.toHaveBeenCalled();
    expect(page.qualityPassed()).toBe(false);
  });
  it('never silently accepts the original when enhancement fails', async () => {
    const page = create();
    const accepted = vi.fn();
    page.accepted.subscribe(accepted);
    page.consent.set(true);
    model.create.mockReturnValue(throwError(() => new Error('worker down')));
    await page.enhance();
    expect(page.preview()).toBe('blob:original');
    expect(page.result()).toBe('');
    expect(page.busy()).toBe(false);
    expect(accepted).not.toHaveBeenCalled();
  });
  it('does not upload without per-photo rights consent', async () => {
    const page = create();
    await page.enhance();
    expect(model.upload).not.toHaveBeenCalled();
  });
});
