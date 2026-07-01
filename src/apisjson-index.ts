// Build a single APIs.json 0.21 (YAML) index of the whole discovered inventory.
// Each api entry carries its org/team/domain tags and its reusability grade in
// x-reusability, plus a link to its OpenAPI. This is the durable, re-importable
// artifact the tool produces — the org's reusability index.
import { stringify } from 'yaml';
import { parseDoc, isObject } from './doc';
import type { ApiRecord } from './storage';
import type { ApiScore } from './scoring';

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'api';

function baseURLOf(openapi: string): string {
  const d = parseDoc(openapi);
  const s = d?.servers;
  if (Array.isArray(s) && s[0]?.url) return String(s[0].url);
  return 'https://api.example.com';
}
function descOf(openapi: string): string {
  const d = parseDoc(openapi);
  return String(d?.info?.description || d?.info?.title || '').trim();
}

export function buildIndex(inv: ApiRecord[], scores: ApiScore[], collectionName = 'Organization API Reusability Index'): string {
  const scoreById = new Map(scores.map((s) => [s.id, s]));
  const today = new Date().toISOString().slice(0, 10);

  const apis = inv.map((a) => {
    const s = scoreById.get(a.id);
    const tags = [a.grouping?.org, a.grouping?.team, a.grouping?.domain].filter(Boolean) as string[];
    const entry: any = {
      name: a.name,
      description: descOf(a.openapi) || a.name,
      image: '',
      baseURL: baseURLOf(a.openapi),
      humanURL: a.provenance?.url || '',
      tags,
      properties: [{ type: 'OpenAPI', name: `${a.name} OpenAPI`, url: a.provenance?.url || `${slug(a.name)}.yaml` }],
      'x-org': a.grouping?.org || '',
      'x-team': a.grouping?.team || '',
      'x-domain': a.grouping?.domain || '',
      'x-reusability': s
        ? {
            grade: s.letter,
            composite: s.composite,
            openapiScore: s.axisA.score,
            apisjsonScore: s.axisB.score,
            duplicationPenalty: Math.round(s.penalty * 100),
          }
        : undefined,
    };
    // fold in any consumer-supplied apis.json properties (docs/support/etc.)
    const extra = a.apisjson ? parseDoc(a.apisjson) : null;
    if (isObject(extra)) {
      const props = Array.isArray(extra.properties)
        ? extra.properties
        : Array.isArray(extra.apis?.[0]?.properties)
          ? extra.apis[0].properties
          : [];
      if (props.length) entry.properties.push(...props);
    }
    return entry;
  });

  const doc: any = {
    specificationVersion: '0.21',
    name: collectionName,
    description: `Reusability index assembled from ${inv.length} discovered API${inv.length === 1 ? '' : 's'}.`,
    created: today,
    modified: today,
    apis,
    rules: [{ type: 'SpectralRules', name: 'Spotlight Rules', url: 'https://spotlight-rules.com/spec/' }],
  };
  return stringify(doc);
}
