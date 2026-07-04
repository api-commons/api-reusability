// Build APIs.json 0.21 (YAML) — every API in the app is wrapped in a simple
// apis.json. `buildApiApisJson` wraps a single record; `buildIndex` assembles
// the whole inventory into one index. Each api entry carries its org/team/domain
// tags, its operational properties (docs/login/signup/sandbox/…), and — when
// scored — its reusability grade in x-reusability.
import { stringify } from 'yaml';
import { parseDoc } from './doc';
import { resolveProperties } from './properties';
import { loadCapabilities } from './storage';
import type { ApiRecord } from './storage';
import type { ApiScore } from './scoring';

const slug = (s: string) => s.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'api';

function baseURLOf(openapi: string): string {
  const d = parseDoc(openapi);
  const s = d?.servers;
  if (Array.isArray(s) && s[0]?.url) return String(s[0].url);
  return 'https://api.example.com';
}
function descOf(openapi: string, fallback: string): string {
  const d = parseDoc(openapi);
  return String(d?.info?.description || d?.info?.title || fallback).trim();
}

// One apis.json `apis[]` entry for a record, including the linked OpenAPI plus
// all operational properties, and (optionally) the reusability grade.
function entryFor(a: ApiRecord, score?: ApiScore) {
  const tags = [a.grouping?.org, a.grouping?.team, a.grouping?.domain].filter(Boolean) as string[];
  const props = resolveProperties(a).filter((p) => p.type);
  const entry: any = {
    name: a.name,
    description: descOf(a.openapi, a.name),
    image: '',
    baseURL: baseURLOf(a.openapi),
    humanURL: a.provenance?.url || '',
    tags,
    properties: [
      { type: 'OpenAPI', name: `${a.name} OpenAPI`, url: a.provenance?.url || `${slug(a.name)}.yaml` },
      ...props.map((p) => ({ type: p.type, ...(p.name ? { name: p.name } : {}), url: p.url })),
    ],
    'x-org': a.grouping?.org || '',
    'x-team': a.grouping?.team || '',
    'x-domain': a.grouping?.domain || '',
  };
  if (score) {
    entry['x-reusability'] = {
      grade: score.letter,
      composite: score.composite,
      designScore: score.axisA.score,
      operationalScore: score.axisB.score,
      composabilityScore: score.axisC.score,
      duplicationPenalty: Math.round(score.penalty * 100),
    };
  }
  return entry;
}

// Wrap a single API record as its own minimal apis.json document.
export function buildApiApisJson(a: ApiRecord, score?: ApiScore): string {
  const today = new Date().toISOString().slice(0, 10);
  return stringify({
    specificationVersion: '0.21',
    name: a.name,
    description: descOf(a.openapi, a.name),
    created: today,
    modified: today,
    apis: [entryFor(a, score)],
  });
}

export function buildIndex(inv: ApiRecord[], scores: ApiScore[], collectionName = 'Organization API Reusability Index'): string {
  const scoreById = new Map(scores.map((s) => [s.id, s]));
  const today = new Date().toISOString().slice(0, 10);
  const doc: any = {
    specificationVersion: '0.21',
    name: collectionName,
    description: `Reusability index assembled from ${inv.length} discovered API${inv.length === 1 ? '' : 's'}.`,
    created: today,
    modified: today,
    apis: inv.map((a) => entryFor(a, scoreById.get(a.id))),
  };
  // Capability layer — the named units of reuse and their implementations.
  const nameById = new Map(inv.map((a) => [a.id, a.name]));
  const caps = loadCapabilities();
  if (caps.length) {
    doc['x-capabilities'] = caps.map((c) => ({
      name: c.name,
      ...(c.domain ? { domain: c.domain } : {}),
      ...(c.description ? { description: c.description } : {}),
      canonical: c.canonicalId ? nameById.get(c.canonicalId) : undefined,
      implementations: c.apiIds.map((id) => nameById.get(id)).filter(Boolean),
    }));
  }
  return stringify(doc);
}
