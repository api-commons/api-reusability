// Capability-layer helpers. A capability is the named unit of reuse above the
// raw APIs — this suggests a name for a cluster of implementations and picks the
// canonical one (the best-built implementation to standardize on).
import type { ApiScore } from './scoring';
import type { Demand } from './storage';

// A single sortable magnitude for demand: consumers dominate, calls break ties.
export const demandMagnitude = (d?: Demand): number => (d ? (d.consumers || 0) * 1e7 + (d.calls || 0) : 0);

const STOP = new Set(['api', 'apis', 'the', 'and', 'for', 'of', 'v1', 'v2', 'v3', 'service', 'services', 'rest', 'com', 'io', 'core', 'public', 'internal', 'app']);

// Suggest a capability name from the shared significant word across member names.
export function suggestName(names: string[]): string {
  const freq: Record<string, number> = {};
  for (const n of names) {
    for (const t of n.toLowerCase().split(/[^a-z0-9]+/)) {
      if (t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t)) freq[t] = (freq[t] || 0) + 1;
    }
  }
  const top = Object.entries(freq).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : 'capability';
}

// The canonical implementation to consolidate on. Evidence-first: if any member
// has real demand (consumers/calls), pick the MOST-USED one — you standardize on
// what teams already depend on. Otherwise fall back to the highest composite
// score (the best-built).
export function pickCanonical(apiIds: string[], scores: ApiScore[], demand?: Map<string, number>): string | undefined {
  const comp = new Map(scores.map((s) => [s.id, s.composite]));
  const hasDemand = !!demand && apiIds.some((id) => (demand.get(id) || 0) > 0);
  let best: string | undefined;
  let bestKey = -1;
  for (const id of apiIds) {
    const key = hasDemand ? (demand!.get(id) || 0) : (comp.get(id) ?? 0);
    if (key > bestKey) { bestKey = key; best = id; }
  }
  return best;
}
