import { isJsonObject, type JsonObject } from '../types.js';

/** A narrative statement always references a validated KPI/rule and the persisted period/source. */
export interface NarrativeFact {
  id: string; ruleVersion: string; period: string; source: string;
  observation: string; hypothesis: string | null; recommendation: string; kpis: JsonObject;
}
/** Only complete, source-validated management cards may be narrated. */
export function narrativeFacts(summary: JsonObject): NarrativeFact[] {
  const meta = isJsonObject(summary.meta) ? summary.meta : {}, management = isJsonObject(summary.management) ? summary.management : {};
  const from = typeof summary.from === 'string' ? Date.parse(summary.from) : NaN;
  const to = typeof summary.toExclusive === 'string' ? Date.parse(summary.toExclusive) : NaN;
  if (meta.validated !== true || meta.reconciled !== true || meta.source !== 'analytics.star' ||
    !Number.isFinite(from) || !Number.isFinite(to) || from >= to || !Array.isArray(management.groups)) return [];
  return management.groups.filter(isJsonObject).filter(group => group.availability === 'ready' &&
    group.source === 'analytics.star.v3' && group.ruleVersion === 'management.v3' &&
    isJsonObject(group.kpis) && Object.values(group.kpis).every(value => value === null || typeof value === 'number' && Number.isFinite(value)) &&
    [group.id, group.ruleVersion, group.source, group.phenomenon, group.scope, group.magnitude, group.consequence].every(value => typeof value === 'string' && value.trim().length > 0))
    .map(group => ({ id: String(group.id), ruleVersion: String(group.ruleVersion), source: String(group.source),
      period: `[${String(summary.from)}, ${String(summary.toExclusive)})`,
      observation: `${group.phenomenon} ${group.scope} ${group.magnitude}`,
      hypothesis: null, recommendation: String(group.consequence), kpis: isJsonObject(group.kpis) ? group.kpis : {},
    }));
}
/** Model chooses canonical evidence; free prose, invented causal explanations and mismatched refs are rejected. */
export function validateNarrative(text: string, facts: readonly NarrativeFact[]): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return []; }
  if (!Array.isArray(parsed) || parsed.length > 3) return [];
  const lines: string[] = [];
  for (const raw of parsed) {
    if (!isJsonObject(raw) || !['observation','hypothesis','recommendation'].includes(String(raw.kind))) return [];
    const fact = facts.find(item => item.id === raw.id);
    if (!fact || raw.period !== fact.period || raw.source !== fact.source || raw.ruleVersion !== fact.ruleVersion) return [];
    const kind = raw.kind as 'observation' | 'hypothesis' | 'recommendation';
    const expected = fact[kind];
    if (expected === null || raw.text !== expected) return [];
    const label = kind === 'observation' ? 'Quan sát' : kind === 'hypothesis' ? 'Giả thuyết' : 'Khuyến nghị';
    lines.push(`${label}: ${expected} [${fact.id}; ${fact.ruleVersion}; ${fact.source}; ${fact.period}]`);
  }
  return lines;
}
