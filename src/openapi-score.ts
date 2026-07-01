// Axis A — intrinsic OpenAPI reusability (design quality / completeness).
//
// A transparent, tunable checklist walked over the OpenAPI object. Each check
// yields a 0..1 ratio and carries a weight; the axis score is the weighted mean
// scaled to 0..100. This is Chase's "AI-scored spec completeness" made concrete
// and inspectable rather than a black box.
import { parseDoc, isObject, pct } from './doc';

export interface Check {
  key: string;
  label: string;
  weight: number;
  ratio: number; // 0..1
  detail: string; // human-readable ("12/18 operations")
  hint: string; // what to improve
}

export interface OpenApiScore {
  score: number; // 0..100
  checks: Check[];
  operationCount: number;
  parse: boolean; // did it parse as an OpenAPI doc?
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'];

interface Op {
  method: string;
  path: string;
  op: Record<string, any>;
}

function operationsOf(doc: any): Op[] {
  const out: Op[] = [];
  const paths = isObject(doc?.paths) ? doc.paths : {};
  for (const [path, item] of Object.entries<any>(paths)) {
    if (!isObject(item)) continue;
    for (const m of HTTP_METHODS) {
      if (isObject(item[m])) out.push({ method: m, path, op: item[m] });
    }
  }
  return out;
}

// Count $ref occurrences anywhere in a value (schema reuse signal).
function countRefs(v: any): number {
  if (Array.isArray(v)) return v.reduce((n, x) => n + countRefs(x), 0);
  if (isObject(v)) {
    let n = 0;
    for (const [k, val] of Object.entries(v)) {
      if (k === '$ref' && typeof val === 'string') n++;
      else n += countRefs(val);
    }
    return n;
  }
  return 0;
}

// Count inline schema objects under operations (no $ref) — the anti-reuse signal.
function countInlineSchemas(ops: Op[]): number {
  let inline = 0;
  for (const { op } of ops) {
    const bodies = [op.requestBody, ...Object.values<any>(op.responses || {})];
    for (const b of bodies) {
      const content = b?.content;
      if (!isObject(content)) continue;
      for (const media of Object.values<any>(content)) {
        const s = media?.schema;
        if (isObject(s) && !s.$ref && (s.properties || s.type === 'object')) inline++;
      }
    }
  }
  return inline;
}

const camelCaseName = /^[a-zA-Z][a-zA-Z0-9]*$/;

export function scoreOpenApi(text: string): OpenApiScore {
  const doc = parseDoc(text);
  const isOpenApi = isObject(doc) && (doc.openapi || doc.swagger);
  if (!isOpenApi) {
    return { score: 0, checks: [], operationCount: 0, parse: false };
  }

  const ops = operationsOf(doc);
  const N = ops.length || 1;
  const components = isObject(doc.components?.schemas) ? Object.keys(doc.components.schemas).length : 0;
  const refs = countRefs(doc.paths);
  const inline = countInlineSchemas(ops);

  const withDesc = ops.filter((o) => (o.op.description || o.op.summary || '').toString().trim()).length;
  const withOpId = ops.filter((o) => (o.op.operationId || '').toString().trim()).length;
  const withTags = ops.filter((o) => Array.isArray(o.op.tags) && o.op.tags.length).length;
  const withErrors = ops.filter((o) => {
    const codes = Object.keys(o.op.responses || {});
    return codes.some((c) => /^[45]/.test(c) || c === 'default');
  }).length;
  const with2xxSchema = ops.filter((o) => {
    const responses = o.op.responses || {};
    return Object.entries<any>(responses).some(([code, r]) => {
      if (!/^2/.test(code)) return false;
      const content = r?.content;
      return isObject(content) && Object.values<any>(content).some((m) => isObject(m?.schema));
    });
  }).length;

  // parameter documentation
  const allParams = ops.flatMap((o) => (Array.isArray(o.op.parameters) ? o.op.parameters : []));
  const docdParams = allParams.filter((p) => isObject(p) && (p.description || '').toString().trim()).length;

  const pathCasingConsistent = (() => {
    const segs = Object.keys(isObject(doc.paths) ? doc.paths : {})
      .flatMap((p) => p.split('/'))
      .filter((s) => s && !s.startsWith('{'));
    if (!segs.length) return 1;
    const kebab = segs.filter((s) => /^[a-z0-9-]+$/.test(s)).length;
    return kebab / segs.length; // reward kebab-case consistency
  })();

  const has = (v: unknown) => (v ? 1 : 0);
  const infoDesc = (doc.info?.description || '').toString().trim();
  const servers = Array.isArray(doc.servers) && doc.servers.length ? 1 : 0;
  const security = isObject(doc.components?.securitySchemes) && Object.keys(doc.components.securitySchemes).length ? 1 : 0;

  // schema-reuse ratio: refs vs. (refs + inline). >0 components AND refs used well.
  const reuseRatio = refs + inline === 0 ? (components > 0 ? 0.5 : 0) : refs / (refs + inline);

  const checks: Check[] = [
    { key: 'info', label: 'API-level description', weight: 1, ratio: has(infoDesc), detail: infoDesc ? 'present' : 'missing', hint: 'Add info.description so consumers understand what the API does.' },
    { key: 'servers', label: 'Servers declared', weight: 1, ratio: servers, detail: servers ? 'yes' : 'no', hint: 'Declare servers[] so the base URL is discoverable.' },
    { key: 'operationId', label: 'Operations have operationId', weight: 2, ratio: withOpId / N, detail: `${withOpId}/${ops.length}`, hint: 'operationId is what SDK/codegen and agents key on for reuse.' },
    { key: 'opDoc', label: 'Operations documented', weight: 2, ratio: withDesc / N, detail: `${withDesc}/${ops.length}`, hint: 'Add summary/description to every operation.' },
    { key: 'params', label: 'Parameters documented', weight: 1, ratio: allParams.length ? docdParams / allParams.length : 1, detail: `${docdParams}/${allParams.length}`, hint: 'Describe each parameter.' },
    { key: 'respSchema', label: 'Success responses have schemas', weight: 2, ratio: with2xxSchema / N, detail: `${with2xxSchema}/${ops.length}`, hint: 'A 2xx response with no schema cannot be reused programmatically.' },
    { key: 'errors', label: 'Error responses documented', weight: 1, ratio: withErrors / N, detail: `${withErrors}/${ops.length}`, hint: 'Document 4xx/5xx (or default) so consumers can handle failure.' },
    { key: 'reuse', label: 'Schema reuse via components/$ref', weight: 2, ratio: reuseRatio, detail: `${components} components, ${refs} $refs, ${inline} inline`, hint: 'Factor shared shapes into components.schemas and $ref them — the core reusable building block.' },
    { key: 'tags', label: 'Operations tagged', weight: 1, ratio: withTags / N, detail: `${withTags}/${ops.length}`, hint: 'Tags group operations and aid discovery.' },
    { key: 'security', label: 'Security schemes defined', weight: 1, ratio: security, detail: security ? 'yes' : 'no', hint: 'Define components.securitySchemes so auth is self-describing.' },
    { key: 'casing', label: 'Consistent path casing', weight: 0.5, ratio: pathCasingConsistent, detail: `${Math.round(pathCasingConsistent * 100)}% kebab-case`, hint: 'Consistent naming makes an API predictable and reusable.' },
  ];

  const wsum = checks.reduce((s, c) => s + c.weight, 0);
  const score = Math.round((checks.reduce((s, c) => s + c.weight * clamp01(c.ratio), 0) / wsum) * 100);

  return { score, checks, operationCount: ops.length, parse: true };
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0);
export { pct };
