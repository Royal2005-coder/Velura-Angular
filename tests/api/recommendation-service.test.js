import test from "node:test";
import assert from "node:assert/strict";
import { attachRecommendationScore } from "../../apps/api/src/recommendation-service.js";

test("recommendation scoring prioritizes matching style profile signals", () => {
  const quiz = {
    body_shape: "Pear",
    skin_tone: "Warm",
    style_tags: ["Minimalism"],
    preferred_occasions: ["Office"],
    budget_range: "700k_1.5m"
  };

  const matched = attachRecommendationScore({
    product_id: "matched",
    name: "Quần suông tối giản công sở",
    style_tags: ["Minimalist", "Elegant"],
    suitable_body_shapes: ["Pear", "Hourglass"],
    color_tone: "Warm",
    occasions: ["Office"],
    sale_price: 1200000,
    is_featured: false
  }, quiz);

  const mismatched = attachRecommendationScore({
    product_id: "mismatched",
    name: "Đầm street party",
    style_tags: ["Street"],
    suitable_body_shapes: ["Apple"],
    color_tone: "Cool",
    occasions: ["Party"],
    sale_price: 2200000,
    is_featured: true
  }, quiz);

  assert.ok(matched.recommendation_score > mismatched.recommendation_score);
  assert.deepEqual(matched.recommendation_reasons, ["style", "body_shape", "skin_tone", "occasion", "budget"]);
  assert.deepEqual(mismatched.recommendation_reasons, []);
});

test("recommendation scoring understands Vietnamese style and body aliases", () => {
  const product = attachRecommendationScore({
    product_id: "aliases",
    name: "Set thanh lịch tối giản",
    style_tags: ["Minimalist"],
    suitable_body_shapes: ["Hourglass"],
    color_tone: "Neutral",
    occasions: ["Casual"],
    sale_price: 650000
  }, {
    body_shape: "Dáng đồng hồ cát",
    skin_tone: "Neutral",
    style_tags: ["Tối giản"],
    preferred_occasions: ["Đi chơi"],
    budget_range: "300k_700k"
  });

  assert.ok(product.recommendation_score >= 15);
  assert.ok(product.recommendation_reasons.includes("style"));
  assert.ok(product.recommendation_reasons.includes("body_shape"));
  assert.ok(product.recommendation_reasons.includes("occasion"));
});
