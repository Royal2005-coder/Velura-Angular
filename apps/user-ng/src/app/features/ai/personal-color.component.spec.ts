import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AuthService } from '../../core/services/auth.service';
import { PersonalColorComponent } from './personal-color.component';
import { PersonalColorModel, type PersonalColorProfile } from './personal-color.model';

const confirmed: PersonalColorProfile = { version: 2, personal_color: { status: 'CONFIRMED', season: 'Spring', subtype: 'Spring', palette: ['warm'], avoided: ['cool'], confidence: 0.9, policy_version: 'approved-policy', analysis_id: 'old', confirmed_at: '2026-10-01T00:00:00Z' } };
describe('PersonalColorComponent', () => {
  const model = { capabilities: vi.fn(), profile: vi.fn(), analyze: vi.fn(), analysis: vi.fn(), cancel: vi.fn(), confirm: vi.fn() };
  beforeEach(() => {
    model.capabilities.mockReturnValue(of({ enabled: true, policy_version: 'approved-policy', max_upload_bytes: 100, retention_seconds: 30 }));
    model.profile.mockReturnValue(of(confirmed));
    TestBed.configureTestingModule({ imports: [PersonalColorComponent], providers: [{ provide: PersonalColorModel, useValue: model }, { provide: AuthService, useValue: { session: signal(null) } }] });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:portrait');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  it('keeps confirmed color and revokes the portrait on failed reanalysis', () => {
    const fixture = TestBed.createComponent(PersonalColorComponent);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    model.analyze.mockReturnValue(throwError(() => new Error('Worker unavailable')));
    page.selectFile({ target: { files: [new File(['photo'], 'portrait.png', { type: 'image/png' })], value: '' } } as unknown as Event);
    page.consent.set(true);
    page.analyze();
    expect(page.profile()?.personal_color?.analysis_id).toBe('old');
    expect(page.previewUrl()).toBe('');
    expect(page.error()).toBe('Worker unavailable');
  });
  it('requires server SUCCESS and a matching profile version before confirmation', () => {
    const fixture = TestBed.createComponent(PersonalColorComponent);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    page.analysis.set({ id: 'new', status: 'LOW_CONFIDENCE', profile_version: 2, policy_version: 'approved-policy', expires_at: '' });
    expect(page.canConfirm()).toBe(false);
    page.analysis.update(value => value ? { ...value, status: 'SUCCESS', profile_version: 1 } : value);
    expect(page.canConfirm()).toBe(false);
    page.analysis.update(value => value ? { ...value, profile_version: 2 } : value);
    expect(page.canConfirm()).toBe(true);
    model.confirm.mockReturnValue(throwError(() => new Error('Version changed')));
    page.confirm();
    expect(page.profile()?.personal_color?.analysis_id).toBe('old');
  });
  it('does not upload while policy is disabled', () => {
    model.capabilities.mockReturnValue(of({ enabled: false, reason: 'COLOR_POLICY_UNAPPROVED' }));
    const fixture = TestBed.createComponent(PersonalColorComponent);
    fixture.detectChanges();
    const page = fixture.componentInstance;
    page.selectFile({ target: { files: [new File(['photo'], 'portrait.png', { type: 'image/png' })], value: '' } } as unknown as Event);
    expect(page.previewUrl()).toBe('');
    expect(page.canAnalyze()).toBe(false);
  });
});
