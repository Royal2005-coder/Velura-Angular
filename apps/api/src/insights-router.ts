import { sendJson } from './http.js';
import { requirePermission } from './rbac.js';
import { buildDashboardSummary } from './dashboard.js';
import { generateGeminiText, isGeminiConfigured } from './gemini-client.js';
import { moduleForInsightScope, parseInsightScope } from './insights.js';
import { narrativeFacts, validateNarrative } from './insights/validated-narrative.js';
import type { RouteArgs } from './types.js';

/** Insights read facts; narrative generation is a separate mutation denied to read-only viewers. */
export async function handleInsightsRoute({ req, res, url, parts, context, headers }: RouteArgs): Promise<boolean> {
  if (parts[0] !== 'api' || parts[1] !== 'v1' || parts[2] !== 'admin' || parts[3] !== 'insights') return false;
  if (req.method === 'POST' && parts[4] === 'recommend' && parts.length === 5) {
    requirePermission(context!, 'dashboard', 'update');
    const summary = await buildDashboardSummary(url.searchParams);
    const facts = narrativeFacts(summary), lines = facts.map(fact => `Quan sát: ${fact.observation} [${fact.id}; ${fact.ruleVersion}; ${fact.source}; ${fact.period}]`);
    let narrative: string[] = [];
    if (facts.length && isGeminiConfigured()) {
      try {
        const text = await generateGeminiText([
          'Select at most 3 useful statements from these validated facts. Return a JSON array only.',
          'Each item must contain id, ruleVersion, period, source, kind, text.',
          'kind is observation or recommendation. Copy the selected statement exactly; no new numbers, causes or paraphrase.',
          'Hypotheses are unavailable because no validated causal hypothesis is supplied.', JSON.stringify(facts),
        ].join('\n'), { temperature: 0, maxOutputTokens: 1200 });
        narrative = validateNarrative(text, facts);
      } catch { narrative = []; }
    }
    sendJson(res, 200, { source: narrative.length ? 'validated-ai' : 'facts', availability: facts.length ? 'ready' : 'unavailable',
      lines, narrative, facts, meta: summary.meta, management: summary.management }, headers);
    return true;
  }
  if (req.method !== 'GET' || parts.length !== 4) return false;
  const scope = parseInsightScope(url.searchParams.get('scope'));
  requirePermission(context!, moduleForInsightScope(scope), 'read');
  const summary = await buildDashboardSummary(url.searchParams);
  const groupsForScope: Record<string, readonly string[]> = {
    hq: ['AD_DB_01','AD_DB_02','AD_DB_03','AD_DB_04','AD_DB_05','AD_DB_06','AD_DB_07','AD_DB_08','AD_DB_09'],
    products: ['AD_DB_03','AD_DB_07'], orders: ['AD_DB_01','AD_DB_02'], reviews: ['AD_DB_03','AD_DB_04','AD_DB_08'],
    returns: ['AD_DB_05','AD_DB_07'], pricing: ['AD_DB_06','AD_DB_08'], promotions: ['AD_DB_06','AD_DB_08'],
    accounts: ['AD_DB_09'], logs: [],
  };
  const groups = summary.management.groups.filter(group => groupsForScope[scope].includes(group.id));
  sendJson(res, 200, { scope, range: summary.range, from: summary.from, to: summary.to,
    voice: null, management: summary.management, meta: summary.meta,
    board: { scope, range: summary.range, periodLabel: summary.range, headline: 'Phân tích từ nguồn đã đối chiếu',
      questions: groups.map(group => ({ id: group.id, question: group.title,
        answer: group.availability === 'insufficient_data' ? group.dataNote : group.phenomenon,
        severity: group.severity, evidence: group.availability === 'insufficient_data' ? [] : [
          { label: 'Phạm vi', value: group.scope }, { label: 'Mức độ', value: group.magnitude },
          { label: 'Nguồn / quy tắc', value: `${group.source} / ${group.ruleVersion}` },
        ] })),
      actions: groups.filter(group => group.availability !== 'insufficient_data' && group.action).map(group => ({
        id: group.id, title: group.action!.label, reason: group.consequence, route: group.action!.route,
        routeLabel: group.action!.label, severity: group.severity, clientSteer: 'Đối chiếu bằng chứng trước khi quyết định',
      })) } }, headers);
  return true;
}
