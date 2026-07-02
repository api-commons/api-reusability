// Capability-layer helpers. A capability is the named unit of reuse above the
// raw APIs — this suggests a name for a cluster of implementations and picks the
// canonical one (the best-built implementation to standardize on).
import type { ApiScore } from './scoring';

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

// The canonical implementation = the highest composite score among members
// (fall back to the first). This is the one to consolidate on.
export function pickCanonical(apiIds: string[], scores: ApiScore[]): string | undefined {
  const byId = new Map(scores.map((s) => [s.id, s.composite]));
  let best: string | undefined;
  let bestScore = -1;
  for (const id of apiIds) {
    const c = byId.get(id) ?? 0;
    if (c > bestScore) { bestScore = c; best = id; }
  }
  return best;
}
