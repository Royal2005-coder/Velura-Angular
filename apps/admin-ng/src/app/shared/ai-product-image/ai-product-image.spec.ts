import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { AdminAiEngineService, AiJob, AiJobInput } from '../../core/admin-ai-engine.service';
import { AdminSessionService } from '../../core/admin-session.service';
import { ProductImageApprovalService, ProductImageApprovalInput } from '../../core/product-image-approval.service';
import { AiProductImage } from './ai-product-image';

const qualityJob: AiJob = {
  id: 'quality-job', task: 'image_quality', status: 'success', created_at: '', expires_at: '',
  gate: { valid: true, metrics: { brightness: 120, sharpness: 40, background_score: 0.8 } },
};
const enhancedJob: AiJob = { ...qualityJob, id: 'enhanced-job', task: 'product_image_enhance' };
const approval = { approvalId: 'review-id', url: 'https://storage.example/reviewed.png', sourceRevision: 'a'.repeat(64), processingVersion: 'measured-quality-v2', expiresAt: '' };

const model = {
  upload: vi.fn((..._args: unknown[]) => of({ asset_id: 'source-asset', expires_at: '' })),
  create: vi.fn((_body: AiJobInput) => of<{ job: AiJob }>({ job: qualityJob })),
  capabilities: vi.fn(() => of({
    enabled: true, local_only: true, max_upload_bytes: 5 * 1024 * 1024, private_ttl_seconds: 900,
    tasks: [{ task: 'image_quality', enabled: true }, { task: 'product_image_enhance', enabled: true }],
  })),
  result: vi.fn((..._args: unknown[]) => of(new Blob(['processed'], { type: 'image/png' }))),
  cancel: vi.fn((..._args: unknown[]) => of({})),
};
const approvals = { approve: vi.fn((_body: ProductImageApprovalInput) => of(approval)) };
const session = { session: signal({ id: 'reviewer' }), canMutate: vi.fn(() => true) };

function sourceFile(content = 'source'): File {
  const file = new File([content], 'source.png', { type: 'image/png' });
  // DOM test implementations may omit Blob.arrayBuffer; preserve the real public hash/selection path.
  if (!file.arrayBuffer) Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode(content).buffer });
  return file;
}


describe('AiProductImage review and publication boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    model.create.mockReturnValue(of({ job: qualityJob }));
    approvals.approve.mockReturnValue(of(approval));
    session.canMutate.mockReturnValue(true);
    TestBed.configureTestingModule({
      imports: [AiProductImage],
      providers: [
        { provide: AdminAiEngineService, useValue: model },
        { provide: ProductImageApprovalService, useValue: approvals },
        { provide: AdminSessionService, useValue: session },
      ],
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  async function create(selectSource = true) {
    const fixture = TestBed.createComponent(AiProductImage);
    fixture.componentRef.setInput('productId', 'product-id');
    fixture.componentRef.setInput('expectedVersion', 4);
    fixture.componentRef.setInput('existingImage', 'https://storage.example/published.png');
    fixture.detectChanges();
    const page = fixture.componentInstance;
    await page.load();
    if (selectSource) {
      fixture.componentRef.setInput('sourceFile', sourceFile());
      fixture.detectChanges();
      if (session.canMutate()) await vi.waitFor(() => expect(page.preview()).toBe('blob:preview'));
    }
    return { page, fixture };
  }

  it('does not create or upload a job for an existing good image or metadata-only editor', async () => {
    const { page } = await create(false);
    expect(page.preview()).toBe('');
    expect(page.existingImage()).toContain('published.png');
    await page.assess();
    await page.enhance();
    expect(model.upload).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
  });

  it('selecting new bytes does not automatically assess, improve, approve or emit', async () => {
    const { page } = await create();
    const accepted = vi.fn();
    page.accepted.subscribe(accepted);
    expect(page.preview()).toBe('blob:preview');
    expect(model.upload).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
    expect(approvals.approve).not.toHaveBeenCalled();
    expect(accepted).not.toHaveBeenCalled();
  });

  it('a successful enhancement never auto-publishes or automatically approves/selects the result', async () => {
    const { page } = await create();
    const accepted = vi.fn();
    page.accepted.subscribe(accepted);
    page.consent.set(true);
    model.create.mockReturnValue(of({ job: enhancedJob }));
    await page.enhance();
    expect(page.result()).toBe('blob:preview');
    expect(page.selected()).toBeNull();
    expect(accepted).not.toHaveBeenCalled();
    expect(approvals.approve).not.toHaveBeenCalled();
    page.useEnhanced();
    await page.approve();
    expect(approvals.approve).not.toHaveBeenCalled();
    page.visuallyReviewed.set(true);
    await page.approve();
    expect(approvals.approve).toHaveBeenCalledWith({ productId: 'product-id', expectedVersion: 4, jobId: 'enhanced-job', selection: 'enhanced', reviewConfirmed: true });
    expect(accepted).toHaveBeenCalledWith(approval);
    expect(model.upload).toHaveBeenCalledTimes(1);
  });

  it('valid originals can be selected without invoking enhancement and unchanged source assessment is reused', async () => {
    const { page, fixture } = await create();
    page.consent.set(true);
    await page.assess();
    fixture.componentRef.setInput('sourceFile', page.sourceFile());
    fixture.detectChanges();
    await page.assess();
    expect(model.create).toHaveBeenCalledTimes(1);
    const firstCall = model.create.mock.calls[0] as unknown[] | undefined;
    expect((firstCall?.[0] as { task?: string } | undefined)?.task).toBe('image_quality');
    expect(page.qualityPassed()).toBe(true);
    page.useOriginal();
    page.visuallyReviewed.set(true);
    await page.approve();
    const firstApproveCall = approvals.approve.mock.calls[0] as unknown[] | undefined;
    expect((firstApproveCall?.[0] as { selection?: string } | undefined)?.selection).toBe('original');
  });

  it('worker failure and approval/save failure retain the published original and emit nothing', async () => {
    const { page } = await create();
    const accepted = vi.fn();
    page.accepted.subscribe(accepted);
    page.consent.set(true);
    model.create.mockReturnValue(throwError(() => new Error('worker unavailable')));
    await page.enhance();
    expect(page.result()).toBe('');
    expect(page.existingImage()).toContain('published.png');
    expect(page.busy()).toBe(false);
    expect(accepted).not.toHaveBeenCalled();
    model.create.mockReturnValue(of({ job: qualityJob }));
    await page.assess();
    page.useOriginal();
    page.visuallyReviewed.set(true);
    approvals.approve.mockReturnValue(throwError(() => new Error('version conflict')));
    await page.approve();
    expect(page.approved()).toBeNull();
    expect(page.existingImage()).toContain('published.png');
    expect(accepted).not.toHaveBeenCalled();
  });

  it('successful execution with a failing output gate cannot be selected for approval', async () => {
    const { page } = await create();
    page.consent.set(true);
    model.create.mockReturnValue(of({ job: { ...enhancedJob, gate: { valid: false, reasons: ['BLURRY'] } } }));
    await page.enhance();
    page.useEnhanced();
    page.visuallyReviewed.set(true);
    await page.approve();
    expect(page.selected()).toBeNull();
    expect(model.result).not.toHaveBeenCalled();
    expect(approvals.approve).not.toHaveBeenCalled();
  });

  it('replacement bytes invalidate the old assessment and human confirmation', async () => {
    const { page, fixture } = await create();
    page.consent.set(true);
    await page.assess();
    page.useOriginal();
    page.visuallyReviewed.set(true);
    fixture.componentRef.setInput('sourceFile', sourceFile('replacement'));
    fixture.detectChanges();
    await vi.waitFor(() => expect(page.preview()).toBe('blob:preview'));
    expect(page.qualityPassed()).toBe(false);
    expect(page.selected()).toBeNull();
    expect(page.visuallyReviewed()).toBe(false);
    expect(page.consent()).toBe(false);
  });

  it('non-mutating roles cannot select bytes, enqueue work or approve', async () => {
    session.canMutate.mockReturnValue(false);
    const { page } = await create();
    page.consent.set(true);
    await page.assess();
    await page.enhance();
    expect(page.preview()).toBe('');
    expect(model.upload).not.toHaveBeenCalled();
    expect(model.create).not.toHaveBeenCalled();
    expect(approvals.approve).not.toHaveBeenCalled();
  });
});
