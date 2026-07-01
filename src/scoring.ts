// Composite reusability score per API: combines Axis A (OpenAPI), Axis B
// (APIs.json), and the cross-API duplication penalty using the tunable weights
// from Config. Duplication contributes as (1 - penalty), so heavily-duplicated
// APIs score lower — reuse is rewarded, re-implementation is not.
import { scoreOpenApi, type OpenApiScore } from './openapi-score';
import { scoreApisJson, type ApisJsonScore } from './apisjson-score';
import { analyzeDuplication, type DuplicationReport } from './duplication';
import { resolveProperties } from './properties';
import { letterFor, parseDoc } from './doc';
import type { ApiRecord, Weights } from './storage';
import { DEFAULT_WEIGHTS } from './storage';

// Build the Axis B input for a record from its OpenAPI description, grouping
// tags, and operational properties.
function axisBInput(a: ApiRecord) {
  const d = parseDoc(a.openapi);
  return {
    description: d?.info?.description ? String(d.info.description) : undefined,
    tags: [a.grouping?.org, a.grouping?.team, a.grouping?.domain].filter(Boolean) as string[],
    properties: resolveProperties(a),
  };
}

export interface ApiScore {
  id: string;
  name: string;
  axisA: OpenApiScore;
  axisB: ApisJsonScore;
  penalty: number; // 0..1 duplication penalty
  composite: number; // 0..100
  letter: 'A' | 'B' | 'C' | 'D' | 'F';
}

export function scoreInventory(inv: ApiRecord[], weights: Weights = DEFAULT_WEIGHTS): {
  scores: ApiScore[];
  duplication: DuplicationReport;
} {
  const duplication = analyzeDuplication(inv.map((a) => ({ id: a.id, name: a.name, openapi: a.openapi })));
  const wsum = weights.openapi + weights.apisjson + weights.duplication || 1;

  const scores: ApiScore[] = inv.map((a) => {
    const axisA = scoreOpenApi(a.openapi);
    const axisB = scoreApisJson(axisBInput(a));
    const penalty = duplication.penalties[a.id] ?? 0;
    const composite = Math.round(
      (weights.openapi * axisA.score + weights.apisjson * axisB.score + weights.duplication * (1 - penalty) * 100) / wsum,
    );
    return { id: a.id, name: a.name, axisA, axisB, penalty, composite, letter: letterFor(composite) };
  });

  return { scores, duplication };
}
