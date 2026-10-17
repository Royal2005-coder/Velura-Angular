import test from "node:test";
import assert from "node:assert/strict";
import { keepGroundedSentences } from "../../apps/api/src/insights/grounded-brief.ts";
import { groundedReviewReply, readReplySuggestions } from "../../apps/api/src/reviews/review-reply-ai.ts";
import { narrativeFacts, validateNarrative } from '../../apps/api/src/insights/validated-narrative.js';
import { buildDashboardSummary } from '../../apps/api/src/dashboard.js';
import { emptyManagementFacts } from './analytics-fixtures.js';

test("khuyến nghị bị loại nếu thêm số không có trong bản tóm tắt", () => {
  const brief = ["Phiếu đổi trả: 4.", "Tỷ lệ đổi trả trên đơn đã giao: 12%."];
  const kept = keepGroundedSentences(
    "Có 4 phiếu đổi trả, tỷ lệ 12%. Nên thêm ngân sách 50000000 đồng.",
    brief
  );
  assert.deepEqual(kept, ["Có 4 phiếu đổi trả, tỷ lệ 12%."]);
});

test("gợi ý phản hồi review chỉ nhận chuỗi đủ dài từ JSON", () => {
  assert.deepEqual(readReplySuggestions({ replies: ["Xin lỗi vì áo bị lỗi chỉ.", ""] }), ["Xin lỗi vì áo bị lỗi chỉ."]);
  assert.deepEqual(readReplySuggestions({ replies: "không phải mảng" }), []);
  assert.deepEqual(
    readReplySuggestions('```json\n{"replies":["Velura đã ghi nhận áo bị lỗi chỉ."]}\n```'),
    ["Velura đã ghi nhận áo bị lỗi chỉ."]
  );
});

test("câu dự phòng đánh giá tiêu cực nhắc đúng góp ý và không hứa hoàn tiền", () => {
  const reply = groundedReviewReply({
    rating: 1,
    comment: "Áo bị rách chỉ ở lai",
    productName: "Áo linen"
  });
  assert.match(reply, /Áo linen/);
  assert.match(reply, /Áo bị rách chỉ ở lai/);
  assert.doesNotMatch(reply, /voucher|hoàn tiền/i);
});

test('AI receives only complete reconciled rule evidence from the selected persisted period', async () => {
  const facts = emptyManagementFacts();
  const summary = await buildDashboardSummary(null, new Date('2026-10-04T01:00:00Z'), {
    read: async () => ({
      schemaVersion: 3, source: 'analytics.star.v3', dataset: 'operational', snapshotAt: facts.snapshotAt,
      reconciled: true, freshness: 'stale', facts,
      summary: { business: { revenue: 100, orderCount: 2, averageOrderValue: 50 }, operations: {} },
    }),
    refresh: async () => { throw new Error('Unexpected mutation'); },
  });
  const evidence = narrativeFacts(summary);
  assert.deepEqual(evidence.map(item => item.id), ['AD_DB_01', 'AD_DB_06']);
  assert.equal(evidence[0].source, 'analytics.star.v3');
  assert.equal(evidence[0].period, `[${summary.from}, ${summary.toExclusive})`);
  assert.equal(evidence[0].kpis.revenue, 100);
  for (const meta of [{ ...summary.meta, validated: false }, { ...summary.meta, reconciled: false }, { ...summary.meta, source: 'oltp.rpc' }]) {
    assert.deepEqual(narrativeFacts({ ...summary, meta }), []);
  }
  assert.deepEqual(narrativeFacts({ ...summary, from: null }), []);
});

test('AI cannot invent amounts, causes or change rule, source and period references', () => {
  const fact = { id: 'AD_DB_01', ruleVersion: 'management.v3', source: 'analytics.star.v3', period: '[2026-10-03, 2026-10-04)', observation: 'Observed revenue 100.', hypothesis: null, recommendation: 'Review measured category contribution.', kpis: { revenue: 100 } };
  const statement = { id: fact.id, ruleVersion: fact.ruleVersion, source: fact.source, period: fact.period, kind: 'observation', text: fact.observation };
  assert.equal(validateNarrative(JSON.stringify([statement]), [fact]).length, 1);
  for (const change of [
    { text: 'Observed revenue 200.' }, { text: 'Promotion caused revenue growth.' }, { kind: 'hypothesis', text: 'Promotion caused revenue growth.' },
    { id: 'unknown' }, { source: 'oltp.rpc' }, { ruleVersion: 'management.v2' }, { period: 'another period' },
  ]) assert.deepEqual(validateNarrative(JSON.stringify([{ ...statement, ...change }]), [fact]), []);
  assert.deepEqual(validateNarrative(JSON.stringify([statement, { ...statement, text: 'Invented KPI.' }]), [fact]), []);
});
