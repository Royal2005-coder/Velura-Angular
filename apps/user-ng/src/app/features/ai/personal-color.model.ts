import { Injectable, inject } from '@angular/core';
import { Observable, defer, map, switchMap } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { AuthService } from '../../core/services/auth.service';
import { StyleProfileService } from '../../core/services/style-profile.service';
import { guestSessionId } from '../../core/utils/guest-session';

/** Server-approved public policy; absence never enables image upload. */
export interface ColorCapabilities { enabled: boolean; reason?: string; policy_version?: string; max_upload_bytes?: number; retention_seconds?: number; palette?: Record<string, string>; taxonomy?: Record<string, string[]>; }
/** Preview output does not constitute saved profile data. */
export interface PersonalColorResult { season: string; subtype: string; palette: string[]; avoided: string[]; confidence: number; policy_version: string; }
/** Only this value may appear as effective Personal Color inside Style Profile. */
export interface ConfirmedPersonalColor extends PersonalColorResult { status: 'CONFIRMED'; analysis_id: string; confirmed_at: string; }
/** Scientific CIE L*a*b* ITA° and Sclera-calibrated skin depth diagnostics from `gemini-decision-1`. */
export interface PersonalColorDiagnostics {
  base_skin_depth: 'LIGHT_TONE' | 'DARK_TONE';
  skin_depth: 'FAIR' | 'LIGHT' | 'MEDIUM' | 'TAN' | 'DEEP';
  undertone: 'COOL' | 'WARM' | 'NEUTRAL_OLIVE';
  contrast_level: 'LOW' | 'MEDIUM' | 'HIGH';
  ita_angle: number;
  white_balance_shift: 'BALANCED' | 'WARM_CAST' | 'COOL_CAST' | 'EXTREME_CAST';
  recommended_hex_palette: string[];
  avoid_hex_palette: string[];
  requires_human_review: boolean;
}
/** Owner-private analysis state, independent of the last confirmed result. */
export interface PersonalColorAnalysis { id: string; status: 'RUNNING' | 'SUCCESS' | 'LOW_CONFIDENCE' | 'VALIDATION_FAILED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED' | 'CONFIRMED'; profile_version: number; policy_version: string; expires_at: string; result?: PersonalColorResult; diagnostics?: PersonalColorDiagnostics; error?: string; }
/** Current version protects profile edits and simultaneous confirmation. */
export interface PersonalColorProfile { version: number; personal_color: ConfirmedPersonalColor | null; }

interface GuestColorSnapshot { sessionId: string; personalColor: ConfirmedPersonalColor; }

const GUEST_COLOR_SNAPSHOT_KEY = 'velura_session_personal_color';

/** Personal Color HTTP Model delegates existing private uploads and rejects stale-account callbacks. */
@Injectable({ providedIn: 'root' })
export class PersonalColorModel {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly profileModel = inject(StyleProfileService);

  /** Read actual production policy approval and gateway readiness. */
  capabilities(): Observable<ColorCapabilities> { return this.api.get<ColorCapabilities>('/api/user/personal-color/capabilities'); }
  /** Read the same member/session profile used by the Style Quiz, restoring only a server-confirmed guest display snapshot after an API restart. */
  profile(): Observable<PersonalColorProfile> {
    return this.scoped(() => this.api.get<PersonalColorProfile>('/api/user/personal-color/profile')).pipe(map((profile) => {
      if (this.auth.session()) return profile;
      if (profile.personal_color) {
        this.rememberGuestColor(profile.personal_color);
        return profile;
      }
      const recovered = this.readGuestColor();
      // Keep the live server version for every future write; the tab snapshot is display-only.
      return recovered ? { ...profile, personal_color: recovered } : profile;
    }));
  }
  /** Upload portrait image directly to personal color uploads endpoint (supports guest sessions and members). */
  upload(file: File): Observable<{ asset_id: string; expires_at: string }> {
    return this.scoped(() => {
      const body = new FormData();
      body.append('file', file);
      return this.api.post<{ asset_id: string; expires_at: string }>('/api/user/personal-color/uploads', body);
    });
  }
  /** Upload only after consent, then create analysis against the current Style Profile version. */
  analyze(file: File, capabilities: ColorCapabilities, version: number, consent: boolean): Observable<PersonalColorAnalysis> {
    return this.scoped(() => {
      if (!consent || !capabilities.enabled || !capabilities.policy_version || !capabilities.max_upload_bytes || file.size > capabilities.max_upload_bytes || !['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Xác nhận đồng ý và chọn JPEG/PNG trong giới hạn cho phép.');
      const session = this.auth.session(), guest = guestSessionId();
      return this.upload(file).pipe(switchMap((asset) => {
        if (session !== this.auth.session() || guest !== guestSessionId()) throw new Error('Phiên người dùng đã thay đổi.');
        return this.api.post<PersonalColorAnalysis>('/api/user/personal-color/analyses', { asset_id: asset.asset_id, policy_version: capabilities.policy_version, expected_version: version, consent: true });
      }));
    });
  }
  /** Poll without exposing private image paths or adopting previews as confirmed data. */
  analysis(id: string): Observable<PersonalColorAnalysis> { return this.scoped(() => this.api.get<PersonalColorAnalysis>(`/api/user/personal-color/analyses/${encodeURIComponent(id)}`)); }
  /** Cancel only the current owner's analysis; confirmed color is unchanged. */
  cancel(id: string): Observable<PersonalColorAnalysis> { return this.scoped(() => this.api.post<PersonalColorAnalysis>(`/api/user/personal-color/analyses/${encodeURIComponent(id)}/cancel`, {})); }
  /** Refresh personalization only after server atomic confirmation succeeds. */
  confirm(analysis: PersonalColorAnalysis): Observable<PersonalColorProfile> {
    return this.scoped(() => this.api.post<PersonalColorProfile>(`/api/user/personal-color/analyses/${encodeURIComponent(analysis.id)}/confirm`, { expected_version: analysis.profile_version })).pipe(map((profile) => {
      if (profile.personal_color?.status !== 'CONFIRMED' || profile.personal_color.analysis_id !== analysis.id) throw new Error('Kết quả chưa được xác nhận.');
      this.rememberGuestColor(profile.personal_color);
      this.profileModel.revision.update((revision) => revision + 1);
      return profile;
    }));
  }
  /** Refresh personalization with an atomic manual season choice. */
  confirmManual(season: string, version: number, subtype?: string): Observable<PersonalColorProfile> {
    return this.scoped(() => this.api.post<PersonalColorProfile>('/api/user/personal-color/manual', {
      season,
      subtype: subtype || season,
      expected_version: version,
    })).pipe(map((profile) => {
      if (profile.personal_color?.status !== 'CONFIRMED') throw new Error('Kết quả chưa được xác nhận.');
      this.rememberGuestColor(profile.personal_color);
      this.profileModel.revision.update((revision) => revision + 1);
      return profile;
    }));
  }
  private scoped<T>(request: () => Observable<T>): Observable<T> {
    return defer(() => {
      const session = this.auth.session(), guest = guestSessionId();
      return request().pipe(map((value) => {
        if (session !== this.auth.session() || guest !== guestSessionId()) throw new Error('Phiên người dùng đã thay đổi. Vui lòng tải lại.');
        return value;
      }));
    });
  }

  private rememberGuestColor(color: ConfirmedPersonalColor): void {
    if (this.auth.session() || typeof sessionStorage === 'undefined') return;
    sessionStorage.setItem(GUEST_COLOR_SNAPSHOT_KEY, JSON.stringify({ sessionId: guestSessionId(), personalColor: color } satisfies GuestColorSnapshot));
  }

  private readGuestColor(): ConfirmedPersonalColor | null {
    if (this.auth.session() || typeof sessionStorage === 'undefined') return null;
    try {
      const value = JSON.parse(sessionStorage.getItem(GUEST_COLOR_SNAPSHOT_KEY) || 'null') as unknown;
      if (!value || typeof value !== 'object') return null;
      const snapshot = value as { sessionId?: unknown; personalColor?: unknown };
      if (snapshot.sessionId !== guestSessionId() || !snapshot.personalColor || typeof snapshot.personalColor !== 'object') return null;
      const color = snapshot.personalColor as Record<string, unknown>;
      if (color['status'] !== 'CONFIRMED' || !['Spring', 'Summer', 'Autumn', 'Winter'].includes(String(color['season'] || ''))) return null;
      if (!Array.isArray(color['palette']) || !Array.isArray(color['avoided']) || typeof color['analysis_id'] !== 'string' || typeof color['confirmed_at'] !== 'string') return null;
      return color as unknown as ConfirmedPersonalColor;
    } catch {
      return null;
    }
  }
}
