import test from "node:test";
import assert from "node:assert/strict";
import { loyaltyActor, readPoints, LoyaltyService } from "../../apps/api/src/loyalty/loyalty-service.js";
import type { AuthContext, AuthUser, UserProfile } from "../../apps/api/src/types.js";
import type { LoyaltyRepository } from "../../apps/api/src/loyalty/loyalty-repository.js";

const memberUser: AuthUser = {
  id: "user-123",
  app_metadata: {},
  user_metadata: {},
  aud: "authenticated",
  created_at: ""
};

const memberProfile: UserProfile = {
  user_id: "user-123",
  email: "user@example.test",
  role: "member",
  is_active: true,
  created_at: "",
  updated_at: ""
};

const memberContext: AuthContext = {
  authUser: memberUser,
  profile: memberProfile,
  roleCode: "member",
  roleName: "Member",
  isAdmin: false,
  allowedPages: [],
  allowedModules: [],
  accessToken: "token"
};

const adminContext: AuthContext = {
  ...memberContext,
  isAdmin: true,
  roleCode: "admin"
};

const guestContext: AuthContext = {
  authUser: null,
  profile: null,
  roleCode: "guest",
  roleName: "Guest",
  isAdmin: false,
  allowedPages: [],
  allowedModules: [],
  accessToken: ""
};

test("loyaltyActor only recognizes active authenticated members", () => {
  assert.equal(loyaltyActor(memberContext), "user-123");
  assert.equal(loyaltyActor(adminContext), null);
  assert.equal(loyaltyActor(guestContext), null);
  assert.equal(loyaltyActor({ ...memberContext, profile: { ...memberProfile, is_active: false } }), null);
});

test("readPoints requires safe non-negative integer", () => {
  assert.equal(readPoints(0), 0);
  assert.equal(readPoints(500), 500);
  assert.equal(readPoints(null), 0);
  assert.equal(readPoints(undefined), 0);
  assert.throws(() => readPoints(-1), { status: 422, code: "INVALID_POINTS" });
  assert.throws(() => readPoints(1.5), { status: 422, code: "INVALID_POINTS" });
  assert.throws(() => readPoints("100"), { status: 422, code: "INVALID_POINTS" });
});

test("LoyaltyService.snapshot requires member and validates cursor", async () => {
  const repo: LoyaltyRepository = {
    snapshot: async (actor, before) => ({ actor, before, points: 100 }),
    quote: async () => ({
      available_points: 0,
      max_points: 0,
      points_spent: 0,
      points_discount_amount: 0,
      policy_approved: true,
      spending_enabled: true
    }),
    register: async () => ({})
  };
  const service = new LoyaltyService(repo);

  await assert.rejects(
    () => service.snapshot(guestContext),
    { status: 403, code: "LOYALTY_MEMBER_REQUIRED" }
  );

  await assert.rejects(
    () => service.snapshot(memberContext, "invalid-cursor"),
    { status: 422, code: "INVALID_HISTORY_CURSOR" }
  );

  const validCursor = "a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d";
  const res = await service.snapshot(memberContext, validCursor);
  assert.equal(res.actor, "user-123");
  assert.equal(res.before, validCursor);
});

test("LoyaltyService.quote blocks guests from spending points", async () => {
  const repo: LoyaltyRepository = {
    snapshot: async () => ({}),
    quote: async (_actor, _subtotal, _shipping, _discount, points) => ({
      available_points: 1000,
      max_points: 500,
      points_spent: points,
      points_discount_amount: points * 1000,
      policy_approved: true,
      spending_enabled: true
    }),
    register: async () => ({})
  };
  const service = new LoyaltyService(repo);

  await assert.rejects(
    () => service.quote(guestContext, 200000, 30000, 0, 100),
    { status: 403, code: "LOYALTY_MEMBER_REQUIRED" }
  );

  const guestZero = await service.quote(guestContext, 200000, 30000, 0, 0);
  assert.equal(guestZero.points_spent, 0);
  assert.equal(guestZero.spending_enabled, false);

  const quote = await service.quote(memberContext, 200000, 30000, 0, 100);
  assert.equal(quote.points_spent, 100);
  assert.equal(quote.points_discount_amount, 100000);
});

test("LoyaltyService.register validates referral code format", async () => {
  const repo: LoyaltyRepository = {
    snapshot: async () => ({}),
    quote: async () => ({
      available_points: 0,
      max_points: 0,
      points_spent: 0,
      points_discount_amount: 0,
      policy_approved: true,
      spending_enabled: true
    }),
    register: async (_input, code) => ({ registered: true, code })
  };
  const service = new LoyaltyService(repo);

  assert.throws(
    () => service.register({}, "INVALID"),
    { status: 422, code: "INVALID_REFERRAL_CODE" }
  );

  const validCode = "VLR" + "A".repeat(16);
  const res = await service.register({}, validCode);
  assert.equal(res.code, validCode);
});
