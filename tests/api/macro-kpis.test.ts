import test from 'node:test';
import assert from 'node:assert/strict';
import { getMacroKpis } from '../../apps/api/src/features/dashboard/macro-kpis.service.ts';

test('getMacroKpis returns structured 5 macro KPIs with valid formats', async () => {
  const result = await getMacroKpis({ range: '7d' });
  assert.equal(result.status, 'success');
  assert.ok(result.data);
  assert.ok(result.data.period);
  assert.equal(result.data.period.cache_ttl_seconds, 600);
  assert.equal(result.data.period.range, '7d');

  const { net_revenue, gross_margin, aov, repeat_rate, return_rate } = result.data.kpis;

  // 1. Net Revenue
  assert.equal(net_revenue.title, 'Doanh thu thuần');
  assert.equal(net_revenue.unit, 'VND');
  assert.equal(net_revenue.is_inverted_metric, false);
  assert.ok(typeof net_revenue.value === 'number');
  assert.ok(typeof net_revenue.formatted === 'string');

  // 2. Gross Margin
  assert.equal(gross_margin.title, 'Biên LN gộp');
  assert.equal(gross_margin.unit, 'pct');
  assert.equal(gross_margin.is_inverted_metric, false);
  assert.ok(typeof gross_margin.value === 'number');
  assert.ok(gross_margin.formatted.includes('%'));

  // 3. AOV
  assert.equal(aov.title, 'AOV Đơn hàng');
  assert.equal(aov.unit, 'VND');
  assert.equal(aov.is_inverted_metric, false);
  assert.ok(typeof aov.value === 'number');

  // 4. Repeat Rate
  assert.equal(repeat_rate.title, 'Khách mua lại');
  assert.equal(repeat_rate.unit, 'pct');
  assert.equal(repeat_rate.is_inverted_metric, false);
  assert.ok(typeof repeat_rate.value === 'number');
  assert.ok(repeat_rate.formatted.includes('%'));

  // 5. Return Rate (Inverted Metric)
  assert.equal(return_rate.title, 'Tỷ lệ đổi trả');
  assert.equal(return_rate.unit, 'pct');
  assert.equal(return_rate.is_inverted_metric, true, 'Return rate must be flagged as inverted metric');
  assert.ok(typeof return_rate.value === 'number');
  assert.ok(return_rate.formatted.includes('%'));
});

test('getMacroKpis serves cached data on repeated calls within TTL', async () => {
  const first = await getMacroKpis({ range: '30d' });
  const second = await getMacroKpis({ range: '30d' });

  assert.equal(first.status, 'success');
  assert.equal(second.status, 'success');
  assert.equal(first.data.period.cached_at, second.data.period.cached_at);
  assert.deepEqual(first.data.kpis, second.data.kpis);
});
