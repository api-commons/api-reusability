#!/usr/bin/env node
// Build preset inventory sets from the api-evangelist all/* provider repos.
// Reads each provider's apis.yml, resolves every API's OpenAPI file, and carries
// the curated apis.json properties (Documentation, SignUp, Login, …). Output is
// a static JSON bundle per provider under public/presets/, committed to the repo
// and fetched on demand by the app (all/* is not part of this repo, so these are
// generated locally, not in CI).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse } from 'yaml';

const ROOT = '/Users/kinlane/GitHub/all';
const OUT = new URL('../public/presets/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const PROVIDERS = [
  { id: 'twilio', org: 'Twilio', domain: 'communications' },
  { id: 'stripe', org: 'Stripe', domain: 'payments' },
  { id: 'atlassian', org: 'Atlassian', domain: 'developer-tools' },
];

// Map the many apis.yml property types down to the app's operational catalog,
// so chips stay meaningful and feed Axis B (drop everything else).
const TYPE_MAP = {
  documentation: 'Documentation', apireference: 'Documentation', gettingstarted: 'Documentation', reference: 'Documentation', docs: 'Documentation',
  signup: 'SignUp', register: 'SignUp', registration: 'SignUp',
  login: 'Login', authentication: 'Login', apikeys: 'Login', oauth: 'Login', auth: 'Login',
  sandbox: 'Sandbox', testing: 'Sandbox', testconsole: 'Sandbox', tryit: 'Sandbox', playground: 'Sandbox',
  support: 'Support', discord: 'Support', stackoverflow: 'Support', contact: 'Support', help: 'Support',
  pricing: 'Pricing', plans: 'Pricing',
  termsofservice: 'TermsOfService', terms: 'TermsOfService',
  license: 'License',
  statuspage: 'StatusPage', status: 'StatusPage',
  changelog: 'ChangeLog', versioning: 'ChangeLog', releasenotes: 'ChangeLog',
};
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
function catalogType(t) {
  const n = norm(t);
  if (TYPE_MAP[n]) return TYPE_MAP[n];
  if (n.includes('sdk') || n === 'cli') return 'SDK';
  if (n.includes('doc')) return 'Documentation';
  return null;
}

// Resolve an OpenAPI property url to a local file (apis.yml paths vary between
// properties/… and openapi/… and sometimes point at a remote URL).
function resolveOpenApi(dir, url) {
  if (!url) return null;
  const cands = [];
  if (!/^https?:/i.test(url)) cands.push(join(dir, url));
  const bn = basename(String(url).split('?')[0]);
  cands.push(join(dir, 'openapi', bn), join(dir, 'properties', bn));
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

for (const p of PROVIDERS) {
  const dir = join(ROOT, p.id);
  if (!existsSync(join(dir, 'apis.yml'))) { console.warn(`skip ${p.id}: no apis.yml`); continue; }
  const doc = parse(readFileSync(join(dir, 'apis.yml'), 'utf8'));
  const common = Array.isArray(doc.common) ? doc.common : [];
  const apis = [];
  let skipped = 0;

  for (const a of doc.apis || []) {
    const props = Array.isArray(a.properties) ? a.properties : [];
    const oapiProp = props.find((x) => String(x.type).toLowerCase() === 'openapi');
    const file = resolveOpenApi(dir, oapiProp?.url);
    if (!file) { skipped++; continue; }
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { skipped++; continue; }

    // Curated operational properties mapped to the app's catalog (per-API +
    // provider-common), deduped by catalog type.
    const seen = new Set();
    const properties = [];
    for (const x of [...props, ...common]) {
      if (!x || !x.type || !x.url) continue;
      const ct = catalogType(x.type);
      if (!ct || seen.has(ct)) continue;
      seen.add(ct);
      properties.push({ type: ct, url: String(x.url) });
    }

    apis.push({
      name: a.name || basename(file).replace(/\.(ya?ml|json)$/i, ''),
      openapi: text,
      grouping: { org: p.org, team: (Array.isArray(a.tags) && a.tags[0]) ? String(a.tags[0]) : 'Core', domain: p.domain },
      properties,
    });
  }

  const outFile = join(OUT, `${p.id}.json`);
  writeFileSync(outFile, JSON.stringify({ format: 'api-reusability-preset', set: p.id, org: p.org, apis }));
  const mb = (readFileSync(outFile).length / 1024 / 1024).toFixed(2);
  console.log(`${p.id}: ${apis.length} APIs, ${skipped} skipped → ${outFile} (${mb} MB)`);
}
