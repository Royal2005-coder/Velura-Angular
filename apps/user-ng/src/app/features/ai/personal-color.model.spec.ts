import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { StyleProfileService } from '../../core/services/style-profile.service';
import { PersonalColorModel, type PersonalColorProfile } from './personal-color.model';

const confirmed: PersonalColorProfile = {
  version: 4,
  personal_color: {
    status: 'CONFIRMED',
    season: 'Autumn',
    subtype: 'Warm Autumn',
    palette: ['terracotta', 'olive'],
    avoided: ['sky'],
    confidence: 0.91,
    policy_version: 'approved-policy',
    analysis_id: 'analysis-guest',
    confirmed_at: '2026-11-22T00:00:00Z',
  },
};

describe('PersonalColorModel guest result recovery', () => {
  const session = signal(null);
  const get = vi.fn();
  const post = vi.fn();

  beforeEach(() => {
    sessionStorage.clear();
    get.mockReset();
    post.mockReset();
    TestBed.configureTestingModule({ providers: [
      { provide: ApiService, useValue: { get, post } },
      { provide: AuthService, useValue: { session } },
      { provide: StyleProfileService, useValue: { revision: signal(0) } },
    ] });
  });

  afterEach(() => TestBed.resetTestingModule());

  it('restores the server-confirmed result in the same guest tab after the API loses volatile guest state', async () => {
    const model = TestBed.inject(PersonalColorModel);
    get.mockReturnValueOnce(of(confirmed));
    expect((await firstValueFrom(model.profile())).personal_color?.season).toBe('Autumn');

    get.mockReturnValueOnce(of({ version: 0, personal_color: null } satisfies PersonalColorProfile));
    const restored = await firstValueFrom(model.profile());

    expect(restored.version).toBe(0);
    expect(restored.personal_color?.analysis_id).toBe('analysis-guest');
    expect(restored.personal_color?.season).toBe('Autumn');
  });

  it('never restores a confirmed result into another guest tab', async () => {
    const model = TestBed.inject(PersonalColorModel);
    get.mockReturnValueOnce(of(confirmed));
    await firstValueFrom(model.profile());
    sessionStorage.setItem('velura_guest_session_id', 'another-tab');
    get.mockReturnValueOnce(of({ version: 0, personal_color: null } satisfies PersonalColorProfile));

    expect((await firstValueFrom(model.profile())).personal_color).toBeNull();
  });
});
