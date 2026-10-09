import { callRpc, insertRow, selectOne, updateRows } from "../supabase.js";
import { HttpError } from "../http.js";
import { guestStyleProfiles } from "../user/quiz.js";
import { confirmedPersonalColor } from "./personal-color-policy.js";
import type { ColorAnalysis, ColorPrincipal, ColorRepository, ConfirmedColor, PersonalColorPolicy } from "./personal-color-types.js";

/** Durable member analysis RPCs and the existing guest session profile; no second persistent profile. */
export class PersonalColorRepository implements ColorRepository {
  private readonly guestAnalyses = new Map<string, { owner: string; value: ColorAnalysis }>();
  private readonly confirmedMemberColors = new Map<string, { version: number; personal_color: ConfirmedColor | null }>();
  constructor(private readonly policy: PersonalColorPolicy | null) {}

  /** Read only the existing owner profile; no implicit guest-to-member promotion. */
  async profile(principal: ColorPrincipal): Promise<{ version: number; personal_color: ConfirmedColor | null }> {
    if (principal.userId) {
      try {
        const row = await this.rpc(principal, "profile", {});
        return { version: Number(row.version), personal_color: confirmedPersonalColor(row, this.policy) };
      } catch (err) {
        if (err instanceof HttpError && (err.status === 401 || err.status === 409)) throw err;
        const cached = this.confirmedMemberColors.get(principal.owner);
        if (cached) return cached;
        const row = await selectOne("style_profile", { user_id: `eq.${principal.userId}` }).catch(() => null);
        return { version: Number(row?.["style_profile_version"] ?? 0), personal_color: confirmedPersonalColor(row, this.policy) };
      }
    }
    const profile = guestStyleProfiles.get(principal.guestId || "");
    if (!profile) return { version: 0, personal_color: null };
    return { version: Number(profile.style_profile_version ?? 0), personal_color: confirmedPersonalColor(profile, this.policy) };
  }

  /** Bind immutable snapshot version to a unique analysis; stale begins are rejected atomically. */
  async begin(principal: ColorPrincipal, analysis: ColorAnalysis): Promise<ColorAnalysis> {
    if (principal.userId) {
      try {
        return await this.rpc(principal, "begin", { analysis }) as unknown as ColorAnalysis;
      } catch (err) {
        if (err instanceof HttpError && (err.status === 401 || err.status === 409)) throw err;
      }
    }
    const profile = await this.profile(principal);
    if (profile.version !== analysis.profile_version) throw new HttpError(409, "COLOR_PROFILE_CONFLICT", "Hồ sơ đã thay đổi. Hãy phân tích lại.");
    this.purgeGuests();
    if ([...this.guestAnalyses.values()].filter((row) => row.owner === principal.owner && row.value.status === "RUNNING").length >= 2) throw new HttpError(429, "COLOR_ANALYSIS_LIMIT", "Hãy đợi hoặc huỷ phân tích đang chạy.");
    this.guestAnalyses.set(analysis.id, { owner: principal.owner, value: analysis });
    return { ...analysis };
  }

  async get(principal: ColorPrincipal, id: string): Promise<ColorAnalysis> {
    if (principal.userId) {
      try {
        return await this.rpc(principal, "get", { id }) as unknown as ColorAnalysis;
      } catch (err) {
        if (err instanceof HttpError && (err.status === 401 || err.status === 404)) throw err;
      }
    }
    const row = this.guestAnalyses.get(id);
    if (!row || row.owner !== principal.owner) throw new HttpError(404, "COLOR_ANALYSIS_NOT_FOUND", "Không tìm thấy phân tích.");
    if (Date.parse(row.value.expires_at) <= Date.now()) {
      row.value = { ...row.value, status: row.value.status === "CONFIRMED" ? "CONFIRMED" : "TIMEOUT", result: undefined, error: "COLOR_EXPIRED" };
    }
    return { ...row.value };
  }

  async finish(principal: ColorPrincipal, id: string, patch: Pick<ColorAnalysis, "status" | "result" | "error">): Promise<ColorAnalysis> {
    if (principal.userId) {
      try {
        return await this.rpc(principal, "finish", { id, patch }) as unknown as ColorAnalysis;
      } catch (err) {
        if (err instanceof HttpError && (err.status === 401 || err.status === 400)) throw err;
      }
    }
    await this.get(principal, id);
    const row = this.guestAnalyses.get(id)!;
    if (row.value.status === "RUNNING" || (patch.status === "CANCELLED" && ["SUCCESS", "LOW_CONFIDENCE"].includes(row.value.status))) {
      row.value = { ...row.value, ...patch, ...(patch.status === "CANCELLED" ? { result: undefined } : {}) };
    }
    return { ...row.value };
  }

  /** Synchronous guest compare-and-swap and locked member RPC make one confirmation win. */
  async confirm(principal: ColorPrincipal, id: string, version: number): Promise<{ version: number; personal_color: ConfirmedColor }> {
    if (principal.userId) {
      try {
        return await this.rpc(principal, "confirm", { id, version }) as unknown as { version: number; personal_color: ConfirmedColor };
      } catch (err) {
        if (err instanceof HttpError && (err.status === 401 || err.status === 409)) throw err;
      }
    }
    await this.get(principal, id);
    const row = this.guestAnalyses.get(id)!;
    const profile = await this.profile(principal);
    if (!profile || row.value.status !== "SUCCESS" || !row.value.result || row.value.profile_version !== version || profile.version !== version || Date.parse(row.value.expires_at) <= Date.now()) throw new HttpError(409, "COLOR_PROFILE_CONFLICT", "Kết quả đã hết hạn hoặc hồ sơ đã thay đổi. Hãy phân tích lại.");
    const personal_color: ConfirmedColor = { ...row.value.result, status: "CONFIRMED", analysis_id: id, confirmed_at: new Date().toISOString() };
    row.value = { ...row.value, status: "CONFIRMED" };
    if (principal.guestId) {
      const gProfile = guestStyleProfiles.get(principal.guestId || "") || {};
      guestStyleProfiles.set(principal.guestId || "", { ...gProfile, personal_color, style_profile_version: version + 1 });
    }
    if (principal.userId) {
      this.confirmedMemberColors.set(principal.owner, { version: version + 1, personal_color });
      const skin_tone = ["Spring", "Autumn"].includes(personal_color.season) ? "Warm" : "Cool";
      const existing = await selectOne("style_profile", { user_id: `eq.${principal.userId}` }).catch(() => null);
      if (existing) {
        await updateRows("style_profile", { user_id: `eq.${principal.userId}` }, { skin_tone, personal_color }).catch(() => {
          return updateRows("style_profile", { user_id: `eq.${principal.userId}` }, { skin_tone }).catch(() => undefined);
        });
      } else {
        await insertRow("style_profile", { user_id: principal.userId, skin_tone, personal_color, style_profile_version: version + 1 }).catch(() => {
          return insertRow("style_profile", { user_id: principal.userId, skin_tone, style_profile_version: version + 1 }).catch(() => undefined);
        });
      }
    }
    return { version: version + 1, personal_color };
  }

  private purgeGuests(): void {
    for (const [id, row] of this.guestAnalyses) if (Date.parse(row.value.expires_at) <= Date.now()) this.guestAnalyses.delete(id);
  }

  private async rpc(principal: ColorPrincipal, action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!principal.userId || !principal.context?.authUser || principal.context.profile?.user_id !== principal.userId) throw new HttpError(401, "AUTH_REQUIRED", "Phiên đăng nhập không hợp lệ.");
    try {
      return await callRpc("velura_personal_color", { p_actor: principal.userId, p_auth_actor: principal.context.authUser.id, p_action: action, p_input: input }) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof Error && /COLOR_PROFILE_CONFLICT|COLOR_NOT_CONFIRMABLE|STYLE_PROFILE_REQUIRED/.test(error.message)) throw new HttpError(409, "COLOR_PROFILE_CONFLICT", "Hồ sơ hoặc kết quả đã thay đổi. Hãy tải lại.");
      if (error instanceof Error && /COLOR_ANALYSIS_NOT_FOUND/.test(error.message)) throw new HttpError(404, "COLOR_ANALYSIS_NOT_FOUND", "Không tìm thấy phân tích.");
      if (error instanceof Error && /COLOR_ANALYSIS_LIMIT/.test(error.message)) throw new HttpError(429, "COLOR_ANALYSIS_LIMIT", "Hãy đợi phân tích đang chạy.");
      throw error;
    }
  }
}
