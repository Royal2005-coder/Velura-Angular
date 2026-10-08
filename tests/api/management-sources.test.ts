import test from 'node:test';
import assert from 'node:assert/strict';
import { loadManagementFacts } from '../../apps/api/src/insights/management-source-service.js';
import type { ManagementFactRepository } from '../../apps/api/src/insights/management-repository.js';
import { emptyManagementFacts as snapshot } from './analytics-fixtures.js';

const query = { from: '2026-10-03T17:00:00Z', to: '2026-10-04T17:00:00Z' };
const repository = (value: unknown): ManagementFactRepository => ({ read: async () => value });

test('an empty measured cohort retains null averages and unsupported costs', async () => {
  const result = await loadManagementFacts(query, repository(snapshot()));
  assert.equal(result.availability, 'ready');
  assert.equal(result.facts?.csat.average_score, null);
  assert.equal(result.facts?.sla.attention_rate_pct, null);
  assert.equal(result.facts?.retention.repeat_purchase_rate_pct, null);
  assert.equal(result.facts?.promotion.roi, null);
});
test('unsynchronized, demo and incomplete sources cannot appear as real ready facts', async () => {
  for (const value of [null, { ...snapshot(), snapshotAt: null }, { ...snapshot(), dataset: 'demo' },
    { ...snapshot(), skuReturns: null }, { ...snapshot(), csat: null }]) {
    const result = await loadManagementFacts(query, repository(value));
    assert.equal(result.availability, 'insufficient_data');
    assert.equal(result.facts, null);
  }
});
test('unsupported ROI and LTV definitions need review before cards consume the snapshot', async () => {
  for (const value of [{ ...snapshot(), promotion: { costAvailable: true, roi: 100 } },
    { ...snapshot(), retention: { predictedLtvAvailable: true } }, { ...snapshot(), discountCsatJoinAvailable: true }]) {
    assert.equal((await loadManagementFacts(query, repository(value))).facts, null);
  }
});
test('invalid periods and IDs fail before any fact repository read', async () => {
  let calls = 0;
  const stub: ManagementFactRepository = { read: async () => { calls++; return snapshot(); } };
  for (const invalid of [{ ...query, to: query.from }, { ...query, from: 'invalid' }, { ...query, productId: 'unsafe-id' }]) {
    await assert.rejects(() => loadManagementFacts(invalid, stub), /không hợp lệ/);
  }
  assert.equal(calls, 0);
});
test('infrastructure failures propagate rather than fabricating a fallback KPI', async () => {
  const stub: ManagementFactRepository = { read: async () => { throw new Error('RPC unavailable'); } };
  await assert.rejects(() => loadManagementFacts(query, stub), /RPC unavailable/);
});

test('missing, null, negative and fractional counts cannot reach report arithmetic', async () => {
  for (const count of [undefined, null, -1, 1.5, '0', Infinity]) {
    const value = snapshot();
    const invalid = { ...value, reviewCoverage: { ...value.reviewCoverage, delivered_orders: count } };
    assert.equal((await loadManagementFacts(query, repository(invalid))).availability, 'insufficient_data');
  }
});

test('zero CSAT samples require a null score and measured samples stay within ticket bounds', async () => {
  for (const csat of [
    { tickets: 1, sample_count: 0, average_score: 0, closed_without_score: 1 },
    { tickets: 1, sample_count: 0, average_score: 5, closed_without_score: 1 },
    { tickets: 1, sample_count: 2, average_score: 4, closed_without_score: 0 },
    { tickets: 2, sample_count: 1, average_score: 6, closed_without_score: 0 },
    { tickets: 2, sample_count: 1, average_score: 4, closed_without_score: 2 },
  ]) assert.equal((await loadManagementFacts(query, repository({ ...snapshot(), csat }))).facts, null);
});

test('source rates must reconcile their real denominators', async () => {
  const value = snapshot();
  const sla = { ...value.sla, active_orders: 3, known_state_orders: 3, attention_orders_24h: 1, attention_rate_pct: 33.33, average_hours_in_state: 12 };
  assert.equal((await loadManagementFacts(query, repository({ ...value, sla }))).availability, 'ready');
  for (const attention_rate_pct of [0, 100, null]) {
    assert.equal((await loadManagementFacts(query, repository({ ...value, sla: { ...sla, attention_rate_pct } }))).facts, null);
  }
});

test('incomplete collection rows and unsupported rating domains remain unavailable', async () => {
  for (const row of [
    { delivered_units: 10 },
    { delivered_units: 10, requested_units: 11, received_units: 0, requested_rate_pct: 110, received_rate_pct: 0 },
  ]) assert.equal((await loadManagementFacts(query, repository({ ...snapshot(), categoryReturns: [row] }))).facts, null);
  assert.equal((await loadManagementFacts(query, repository({ ...snapshot(), discountSatisfaction: [
    { orders: 2, reviewed_orders: 1, review_count: 1, low_rating_count: 0, average_rating: 9 },
  ] }))).facts, null);
});
