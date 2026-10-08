import { Injectable, inject } from '@angular/core';
import { Observable, defer, map, switchMap } from 'rxjs';
import { ApiService } from '../../core/services/api.service';
import { AiEngineService } from '../../core/services/ai-engine.service';
import { AuthService } from '../../core/services/auth.service';
import { StyleProfileService } from '../../core/services/style-profile.service';
import { guestSessionId } from '../../core/utils/guest-session';

/** Server-approved public policy; absence never enables image upload. */
export interface ColorCapabilities { enabled: boolean; reason?: string; policy_version?: string; max_upload_bytes?: number; retention_seconds?: number; palette?: Record<string, string>; taxonomy?: Record<string, string[]>; }
/** Preview output does not constitute saved profile data. */
export interface PersonalColorResult { season: string; subtype: string; palette: string[]; avoided: string[]; confidence: number; policy_version: string; }
/** Only this value may appear as effective Personal Color inside Style Profile. */
export interface ConfirmedPersonalColor extends PersonalColorResult { status: 'CONFIRMED'; analysis_id: string; confirmed_at: string; }
/** Owner-private analysis state, independent of the last confirmed result. */
export interface PersonalColorAnalysis { id: string; status: 'RUNNING' | 'SUCCESS' | 'LOW_CONFIDENCE' | 'VALIDATION_FAILED' | 'FAILED' | 'TIMEOUT' | 'CANCELLED' | 'CONFIRMED'; profile_version: number; policy_version: string; expires_at: string; result?: PersonalColorResult; error?: string; }
/** Current version protects profile edits and simultaneous confirmation. */
export interface PersonalColorProfile { version: number; personal_color: ConfirmedPersonalColor | null; }

/** Personal Color HTTP Model delegates existing private uploads and rejects stale-account callbacks. */
@Injectable({ providedIn: 'root' })
export class PersonalColorModel {
  private readonly api = inject(ApiService);
  private readonly ai = inject(AiEngineService);
  private readonly auth = inject(AuthService);
  private readonly profileModel = inject(StyleProfileService);

  /** Read actual production policy approval and gateway readiness. */
  capabilities(): Observable<ColorCapabilities> { return this.api.get<ColorCapabilities>('/api/user/personal-color/capabilities'); }
  /** Read the same member/session profile used by the Style Quiz. */
  profile(): Observable<PersonalColorProfile> { return this.scoped(() => this.api.get<PersonalColorProfile>('/api/user/personal-color/profile')); }
  /** Upload only after consent, then create analysis against the current Style Profile version. */
  analyze(file: File, capabilities: ColorCapabilities, version: number, consent: boolean): Observable<PersonalColorAnalysis> {
    return this.scoped(() => {
      if (!consent || !capabilities.enabled || !capabilities.policy_version || !capabilities.max_upload_bytes || file.size > capabilities.max_upload_bytes || !['image/png', 'image/jpeg'].includes(file.type)) throw new Error('Xác nhận đồng ý và chọn JPEG/PNG trong giới hạn cho phép.');
      const session = this.auth.session(), guest = guestSessionId();
      return this.ai.upload(file).pipe(switchMap((asset) => {
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
}
