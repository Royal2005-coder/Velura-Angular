import test from 'node:test';
import assert from 'node:assert/strict';
import { loadManagementFacts } from '../../apps/api/src/insights/management-source-service.js';
import type { ManagementFactRepository } from '../../apps/api/src/insights/management-repository.js';

const query = { from: '2026-10-03T17:00:00Z', to: '2026-10-04T17:00:00Z' };
const snapshot = () => ({
  source: 'analytics.star.v2', dataset: 'operational', snapshotAt: '2026-10-04T00:00:00Z',
  sla: { contractualSlaAvailable: false, active_orders: 0, attention_rate_pct: null },
  promotion: { costAvailable: false, roi: null, redemptions: 0, discountAmount: null },
  retention: { predictedLtvAvailable: false, repeat_purchase_rate_pct: null },
  refunds: { profitImpactAvailable: false, completedAmount: null }, csat: {}, reviewCoverage: {},
  skuReturns: [], categoryReturns: [], returnReasons: [], discountSatisfaction: [], discountCsatJoinAvailable: false,
});
const repository = (value: unknown): ManagementFactRepository => ({ read: async () => value });

test('management joins preserve null denominators and do not invent costs or causation', async () => {
  const result = await loadManagementFacts(query, repository(snapshot()));
  assert.equal(result.availability, 'ready');
  assert.deepEqual(result.facts, snapshot());
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
test('infrastructure failures propagate to the existing dashboard fallback', async () => {
  const stub: ManagementFactRepository = { read: async () => { throw new Error('RPC unavailable'); } };
  await assert.rejects(() => loadManagementFacts(query, stub), /RPC unavailable/);
});
