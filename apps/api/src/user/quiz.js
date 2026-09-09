import { HttpError, readJson, sendJson } from "../http.js";
import { selectOne, insertRow, updateRows } from "../supabase.js";
import { requireUserAuth } from "./auth.js";
import { createNotification } from "./notifications.js";

// In-memory store for guest style profiles
export const guestStyleProfiles = new Map();

export async function handleQuizRoute(req, res, corsHeaders, context) {
  const parts = req.url ? new URL(req.url, "http://localhost").pathname.split("/").filter(Boolean) : [];
  const action = parts[3]; // e.g. "migrate"

  // 1. POST /api/user/style-quiz/migrate
  if (action === "migrate" && req.method === "POST") {
    const profile = requireUserAuth(context);
    const guestSessionId = req.headers["x-guest-session-id"];
    
    let quizData = null;
    if (guestSessionId) {
      quizData = guestStyleProfiles.get(guestSessionId);
      guestStyleProfiles.delete(guestSessionId);
    }
    
    // Fallback/merge: Read body in case frontend sends sessionStorage data directly
    try {
      const body = await readJson(req);
      if (body && typeof body === "object") {
        quizData = { ...quizData, ...body };
      }
    } catch (e) {
      // Ignored if body is empty or invalid
    }
    
    if (!quizData || Object.keys(quizData).length === 0) {
      return sendJson(res, 200, { success: true, migrated: false, message: "No guest quiz data found to migrate" }, corsHeaders);
    }
    
    const {
      height_cm, weight_kg, chest_cm, waist_cm, hip_cm,
      body_shape, skin_tone, style_tags, preferred_occasions,
      favorite_brands, budget_range, age_group, favorite_colors
    } = quizData;

    const payload = {
      user_id: profile.user_id,
      height_cm: height_cm ? parseInt(height_cm, 10) : null,
      weight_kg: weight_kg ? parseInt(weight_kg, 10) : null,
      chest_cm: chest_cm ? parseInt(chest_cm, 10) : null,
      waist_cm: waist_cm ? parseInt(waist_cm, 10) : null,
      hip_cm: hip_cm ? parseInt(hip_cm, 10) : null,
      body_shape: body_shape || null,
      skin_tone: skin_tone || null,
      style_tags: style_tags || null,
      preferred_occasions: preferred_occasions || null,
      favorite_brands: favorite_brands || null,
      budget_range: budget_range || null,
      age_group: age_group || null,
      favorite_colors: favorite_colors || null,
      quiz_completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const existing = await selectOne("style_profile", { user_id: `eq.${profile.user_id}` });
    let result;
    if (existing) {
      result = await updateRows("style_profile", { user_id: `eq.${profile.user_id}` }, payload);
    } else {
      result = await insertRow("style_profile", payload);
    }

    await createNotification(
      profile.user_id,
      "quiz",
      "Style Quiz của bạn đã được cập nhật! ✨",
      "Hệ thống đã cập nhật gợi ý phối đồ cá nhân hóa dựa trên dữ liệu trắc nghiệm mới của bạn.",
      "/src/pages/ai/suggestions.html"
    );

    return sendJson(res, 200, { success: true, migrated: true, quiz: result }, corsHeaders);
  }

  // Check authentication
  let profile = null;
  try {
    profile = requireUserAuth(context);
  } catch (e) {
    // Guest flow
  }

  // 2. Member Flow
  if (profile) {
    // GET /api/user/style-quiz
    if (req.method === "GET") {
      const quiz = await selectOne("style_profile", { user_id: `eq.${profile.user_id}` });
      return sendJson(res, 200, { success: true, quiz: quiz || null }, corsHeaders);
    }

    // POST /api/user/style-quiz
    if (req.method === "POST") {
      const body = await readJson(req);
      const {
        height_cm, weight_kg, chest_cm, waist_cm, hip_cm,
        body_shape, skin_tone, style_tags, preferred_occasions,
        favorite_brands, budget_range, age_group, favorite_colors
      } = body;

      const payload = {
        user_id: profile.user_id,
        height_cm: height_cm ? parseInt(height_cm, 10) : null,
        weight_kg: weight_kg ? parseInt(weight_kg, 10) : null,
        chest_cm: chest_cm ? parseInt(chest_cm, 10) : null,
        waist_cm: waist_cm ? parseInt(waist_cm, 10) : null,
        hip_cm: hip_cm ? parseInt(hip_cm, 10) : null,
        body_shape: body_shape || null,
        skin_tone: skin_tone || null,
        style_tags: style_tags || null,
        preferred_occasions: preferred_occasions || null,
        favorite_brands: favorite_brands || null,
        budget_range: budget_range || null,
        age_group: age_group || null,
        favorite_colors: favorite_colors || null,
        quiz_completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      const existing = await selectOne("style_profile", { user_id: `eq.${profile.user_id}` });
      let result;
      if (existing) {
        result = await updateRows("style_profile", { user_id: `eq.${profile.user_id}` }, payload);
      } else {
        result = await insertRow("style_profile", payload);
      }

      await createNotification(
        profile.user_id,
        "quiz",
        "Đã hoàn thành Style Quiz! ✨",
        "Chúc mừng bạn đã hoàn thành trắc nghiệm phong cách. Hãy xem ngay các gợi ý phối đồ AI dành riêng cho bạn!",
        "/src/pages/ai/suggestions.html"
      );

      return sendJson(res, 200, { success: true, quiz: result }, corsHeaders);
    }
  } else {
    // 3. Guest Flow
    const guestSessionId = req.headers["x-guest-session-id"];
    if (!guestSessionId) {
      throw new HttpError(400, "BAD_REQUEST", "Missing X-Guest-Session-ID header");
    }

    // GET /api/user/style-quiz
    if (req.method === "GET") {
      const quiz = guestStyleProfiles.get(guestSessionId) || null;
      return sendJson(res, 200, { success: true, quiz }, corsHeaders);
    }

    // POST /api/user/style-quiz
    if (req.method === "POST") {
      const body = await readJson(req);
      guestStyleProfiles.set(guestSessionId, body);
      return sendJson(res, 200, { success: true, quiz: body }, corsHeaders);
    }
  }

  throw new HttpError(404, "NOT_FOUND", "Route style-quiz not found");
}

