import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { handleQuizRoute, guestStyleProfiles } from "../../apps/api/src/user/quiz.js";
import { asJsonObject, type AuthContext, type HttpRequest, type HttpResponse, type JsonObject } from "../../apps/api/src/types.js";

const guest: AuthContext = { authUser: null, profile: null, roleCode: "guest", roleName: "Guest", isAdmin: false, allowedPages: [], allowedModules: [], accessToken: "" };

function submission(id: string, body: JsonObject, authorization?: string) {
  const req: HttpRequest = Object.assign(Readable.from([JSON.stringify(body)]), {
    method: "POST", url: "/api/user/style-quiz", headers: { "x-guest-session-id": id, ...(authorization ? { authorization } : {}) },
  });
  const res: HttpResponse = { writeHead: () => undefined, setHeader: () => undefined, end: () => undefined };
  return handleQuizRoute(req, res, {}, guest);
}

test("quiz updates preserve confirmed color and invalidate pending analysis versions", async () => {
  const id = `gs_${randomUUID()}`;
  const confirmed: JsonObject = { status: "CONFIRMED", season: "Spring", analysis_id: randomUUID() };
  guestStyleProfiles.set(id, { body_shape: "Pear", personal_color: confirmed, style_profile_version: 4 });
  try {
    await submission(id, { body_shape: "Hourglass", personal_color: { season: "Winter" }, style_profile_version: 900, role: "admin" });
    const saved = asJsonObject(guestStyleProfiles.get(id));
    assert.equal(saved.body_shape, "Hourglass");
    assert.deepEqual(saved.personal_color, confirmed);
    assert.equal(saved.style_profile_version, 5);
    assert.equal(saved.role, undefined);
  } finally { guestStyleProfiles.delete(id); }
});

test("an invalid member credential cannot fall back to guest profile mutation", async () => {
  const id = `gs_${randomUUID()}`;
  try {
    await assert.rejects(submission(id, { body_shape: "Pear" }, "Bearer invalid-token"), { status: 401 });
    assert.equal(guestStyleProfiles.has(id), false);
  } finally { guestStyleProfiles.delete(id); }
});

test("predictable guest identifiers are rejected before storing a profile", async () => {
  await assert.rejects(submission("shared-guest", { body_shape: "Pear" }), { status: 400 });
  assert.equal(guestStyleProfiles.has("shared-guest"), false);
});
