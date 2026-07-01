// Roll reusability up by org / team / domain so an organization can see how a
// group is doing overall, not just per API. Grouping keys come from each
// ApiRecord.grouping (set by the user or imported from apis.json tags).
import { letterFor } from './doc';
import type { ApiRecord } from './storage';
import type { ApiScore } from './scoring';

export type GroupBy = 'org' | 'team' | 'domain';

export interface GroupRollup {
  key: string; // group value, e.g. "payments"
  apiCount: number;
  avgComposite: number;
  letter: 'A' | 'B' | 'C' | 'D' | 'F';
  avgAxisA: number;
  avgAxisB: number;
  avgAxisC: number;
  members: { id: string; name: string; composite: number; letter: string }[];
}

const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

export function rollup(inv: ApiRecord[], scores: ApiScore[], by: GroupBy): GroupRollup[] {
  const scoreById = new Map(scores.map((s) => [s.id, s]));
  const groups = new Map<string, ApiRecord[]>();
  for (const a of inv) {
    const key = (a.grouping?.[by] || 'ungrouped').toString();
    (groups.get(key) || groups.set(key, []).get(key)!).push(a);
  }

  const out: GroupRollup[] = [];
  for (const [key, apis] of groups) {
    const ss = apis.map((a) => scoreById.get(a.id)).filter(Boolean) as ApiScore[];
    const avgComposite = mean(ss.map((s) => s.composite));
    out.push({
      key,
      apiCount: apis.length,
      avgComposite,
      letter: letterFor(avgComposite),
      avgAxisA: mean(ss.map((s) => s.axisA.score)),
      avgAxisB: mean(ss.map((s) => s.axisB.score)),
      avgAxisC: mean(ss.map((s) => s.axisC.score)),
      members: ss
        .map((s) => ({ id: s.id, name: s.name, composite: s.composite, letter: s.letter }))
        .sort((a, b) => b.composite - a.composite),
    });
  }
  return out.sort((a, b) => b.avgComposite - a.avgComposite);
}
