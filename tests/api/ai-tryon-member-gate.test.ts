import test from "node:test";
import assert from "node:assert/strict";
import { requiresMember } from "../../apps/api/src/ai/ai-router.js";

test("virtual try-on and personal-photo checks require a member; visual search and enhancement do not", () => {
  assert.equal(requiresMember({ task: "virtual_try_on" }), true);
  assert.equal(requiresMember({ task: "image_quality", person_check: true }), true);
  assert.equal(requiresMember({ task: "image_quality" }), false);
  assert.equal(requiresMember({ task: "image_embedding" }), false);
  assert.equal(requiresMember({ task: "product_image_enhance" }), false);
});
