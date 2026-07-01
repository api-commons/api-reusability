// Cross-API duplication signals — the "three teams already built that" problem
// (Chase / Ford / Cvent / Schneider). Operates over the whole inventory and
// surfaces where paths, schemas, parameters, and headers repeat across APIs, so
// they can be consolidated. Also yields a per-API duplication penalty (0..1)
// feeding the composite grade.
import { parseDoc, isObject } from './doc';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

export interface DupApi {
  id: string;
  name: string;
}

export interface Overlap {
  key: string; // the shared thing (templated path, schema signature, param, header)
  kind: 'path' | 'schema' | 'parameter' | 'header';
  apis: DupApi[]; // APIs that share it
  count: number;
}

export interface DuplicationReport {
  overlaps: Overlap[]; // sorted, most-shared first
  pathOverlapRate: number; // % of distinct paths that appear in >1 API
  duplicateSchemas: number;
  penalties: Record<string, number>; // apiId -> 0..1 penalty
  consolidations: string[]; // human-readable opportunities
}

interface Parsed {
  id: string;
  name: string;
  paths: string[];
  schemas: string[]; // normalized signatures
  params: string[]; // "in:name"
  headers: string[]; // header names (lowercased)
}

// Collapse concrete segments to {} so /users/123 and /users/456 both template.
const templatePath = (p: string) =>
  p.replace(/\{[^}]+\}/g, '{}')
    .replace(/\/\d+(?=\/|$)/g, '/{}')
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{20,}(?=\/|$)/gi, '/{}')
    .toLowerCase();

// A schema signature = sorted property names (+ type), so near-identical shapes
// collide regardless of order or title.
function schemaSig(s: any): string | null {
  if (!isObject(s)) return null;
  if (isObject(s.properties)) {
    const keys = Object.keys(s.properties).sort();
    if (keys.length) return 'obj:' + keys.join(',');
  }
  return null;
}

function collectSchemas(doc: any): string[] {
  const out = new Set<string>();
  const comp = doc?.components?.schemas;
  if (isObject(comp)) for (const s of Object.values(comp)) { const sig = schemaSig(s); if (sig) out.add(sig); }
  return [...out];
}

function parseApi(id: string, name: string, text: string): Parsed {
  const doc = parseDoc(text) || {};
  const pathsObj = isObject(doc.paths) ? doc.paths : {};
  const paths: string[] = [];
  const params = new Set<string>();
  const headers = new Set<string>();
  for (const [p, item] of Object.entries<any>(pathsObj)) {
    paths.push(templatePath(p));
    if (!isObject(item)) continue;
    const opParams = [
      ...(Array.isArray(item.parameters) ? item.parameters : []),
      ...HTTP_METHODS.flatMap((m) => (isObject(item[m]) && Array.isArray(item[m].parameters) ? item[m].parameters : [])),
    ];
    for (const par of opParams) {
      if (!isObject(par)) continue;
      if (par.name) params.add(`${par.in || 'query'}:${par.name}`);
      if (par.in === 'header' && par.name) headers.add(String(par.name).toLowerCase());
    }
  }
  return { id, name, paths: [...new Set(paths)], schemas: collectSchemas(doc), params: [...params], headers: [...headers] };
}

export function analyzeDuplication(apis: { id: string; name: string; openapi: string }[]): DuplicationReport {
  const parsed = apis.map((a) => parseApi(a.id, a.name, a.openapi));

  // build key -> apis maps for each kind
  const buckets: Record<Overlap['kind'], Map<string, DupApi[]>> = {
    path: new Map(), schema: new Map(), parameter: new Map(), header: new Map(),
  };
  const add = (kind: Overlap['kind'], key: string, api: Parsed) => {
    const m = buckets[kind];
    const arr = m.get(key) || [];
    if (!arr.find((x) => x.id === api.id)) arr.push({ id: api.id, name: api.name });
    m.set(key, arr);
  };
  for (const a of parsed) {
    a.paths.forEach((p) => add('path', p, a));
    a.schemas.forEach((s) => add('schema', s, a));
    a.params.forEach((p) => add('parameter', p, a));
    a.headers.forEach((h) => add('header', h, a));
  }

  const overlaps: Overlap[] = [];
  (Object.keys(buckets) as Overlap['kind'][]).forEach((kind) => {
    for (const [key, list] of buckets[kind]) {
      if (list.length > 1) overlaps.push({ key, kind, apis: list, count: list.length });
    }
  });
  overlaps.sort((a, b) => b.count - a.count);

  const distinctPaths = buckets.path.size;
  const sharedPaths = [...buckets.path.values()].filter((l) => l.length > 1).length;
  const pathOverlapRate = distinctPaths ? Math.round((sharedPaths / distinctPaths) * 100) : 0;
  const duplicateSchemas = [...buckets.schema.values()].filter((l) => l.length > 1).length;

  // Per-API penalty: fraction of an API's paths that also live in another API.
  const penalties: Record<string, number> = {};
  for (const a of parsed) {
    if (!a.paths.length) { penalties[a.id] = 0; continue; }
    const shared = a.paths.filter((p) => (buckets.path.get(p)?.length || 0) > 1).length;
    penalties[a.id] = shared / a.paths.length;
  }

  const consolidations = overlaps
    .filter((o) => o.kind === 'path' || o.kind === 'schema')
    .slice(0, 12)
    .map((o) =>
      o.kind === 'path'
        ? `Path \`${o.key}\` is implemented in ${o.count} APIs (${o.apis.map((a) => a.name).join(', ')}) — candidate for a shared service.`
        : `Schema \`${o.key}\` is duplicated across ${o.count} APIs (${o.apis.map((a) => a.name).join(', ')}) — factor into a shared component.`,
    );

  return { overlaps, pathOverlapRate, duplicateSchemas, penalties, consolidations };
}
