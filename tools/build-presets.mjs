#!/usr/bin/env node
// Build preset inventory sets from the api-evangelist all/* provider repos.
// Reads each provider's apis.yml, resolves every API's OpenAPI file, and carries
// the curated apis.json properties (Documentation, SignUp, Login, …). Output is
// a static JSON bundle per provider under public/presets/, committed to the repo
// and fetched on demand by the app (all/* is not part of this repo, so these are
// generated locally, not in CI).
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse } from 'yaml';

const ROOT = '/Users/kinlane/GitHub/all';
const OUT = new URL('../public/presets/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

// `id` = output/set name; `dir` = the all/* repo (defaults to id).
const PROVIDERS = [
  { id: 'twilio', org: 'Twilio', domain: 'communications' },
  { id: 'stripe', org: 'Stripe', domain: 'payments' },
  { id: 'atlassian', org: 'Atlassian', domain: 'developer-tools' },
  { id: 'github', org: 'GitHub', domain: 'developer-tools' },
  { id: 'sendgrid', org: 'SendGrid', domain: 'email' },
  { id: 'plaid', org: 'Plaid', domain: 'fintech' },
  { id: 'openai', org: 'OpenAI', domain: 'ai' },
  { id: 'shopify', org: 'Shopify', domain: 'commerce' },
  { id: 'slack', org: 'Slack', domain: 'communications' },
  { id: 'claude', dir: 'anthropic', org: 'Claude', domain: 'ai' },
  { id: 'chatgpt', org: 'ChatGPT', domain: 'ai' },
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

// Map a raw property list to deduped catalog properties.
function mapProps(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (!x || !x.type || !x.url) continue;
    const ct = catalogType(x.type);
    if (!ct || seen.has(ct)) continue;
    seen.add(ct);
    out.push({ type: ct, url: String(x.url) });
  }
  return out;
}

for (const p of PROVIDERS) {
  const dir = join(ROOT, p.dir || p.id);
  if (!existsSync(join(dir, 'apis.yml'))) { console.warn(`skip ${p.id}: no apis.yml`); continue; }
  const doc = parse(readFileSync(join(dir, 'apis.yml'), 'utf8'));
  const common = Array.isArray(doc.common) ? doc.common : [];
  // Provider-wide operational properties (used for glob-fallback entries).
  const providerProps = mapProps([...(doc.apis || []).flatMap((a) => (Array.isArray(a.properties) ? a.properties : [])), ...common]);
  const apis = [];
  let skipped = 0;

  const MAX_SPEC_BYTES = 1200 * 1024; // skip giant specs (e.g. GitHub) — too big to score in-browser
  // A real OpenAPI/Swagger has a top-level `openapi:`/`swagger:` line (at column 0),
  // which overlays and other artifacts don't. (Specs may sort `components:` first,
  // so match anywhere, not just the head.)
  const isSpec = (t) => /^(openapi|swagger)\s*:/m.test(t);
  for (const a of doc.apis || []) {
    const props = Array.isArray(a.properties) ? a.properties : [];
    // Try each OpenAPI-typed property in order; take the first that resolves to a
    // file that actually validates as OpenAPI/Swagger (skips overlay/search art.).
    const oapiProps = props.filter((x) => String(x.type).toLowerCase() === 'openapi');
    let file = null, text = null;
    for (const op of oapiProps) {
      const f = resolveOpenApi(dir, op.url);
      if (!f) continue;
      let t; try { t = readFileSync(f, 'utf8'); } catch { continue; }
      if (!isSpec(t)) continue;
      file = f; text = t; break;
    }
    if (!file) { skipped++; continue; }
    if (Buffer.byteLength(text) > MAX_SPEC_BYTES) { skipped++; continue; }

    // Curated operational properties mapped to the app's catalog (per-API +
    // provider-common), deduped by catalog type.
    const properties = mapProps([...props, ...common]);

    apis.push({
      name: a.name || basename(file).replace(/\.(ya?ml|json)$/i, ''),
      openapi: text,
      grouping: { org: p.org, team: (Array.isArray(a.tags) && a.tags[0]) ? String(a.tags[0]) : 'Core', domain: p.domain },
      properties,
    });
  }

  // Fallback: some repos (e.g. ChatGPT) don't wire OpenAPI into apis.yml. If we
  // built nothing, glob the openapi/ dir directly for real specs.
  if (apis.length === 0) {
    const oapiDir = join(dir, 'openapi');
    if (existsSync(oapiDir)) {
      for (const fn of readdirSync(oapiDir)) {
        if (!/\.(ya?ml|json)$/i.test(fn) || /ratings|subway|overlay|search/i.test(fn)) continue;
        let t; try { t = readFileSync(join(oapiDir, fn), 'utf8'); } catch { continue; }
        if (!isSpec(t) || Buffer.byteLength(t) > MAX_SPEC_BYTES) { skipped++; continue; }
        const m = t.match(/^\s{0,4}title:\s*(.+)$/m);
        const name = m ? m[1].trim().replace(/^["']|["']$/g, '') : fn.replace(/\.(ya?ml|json)$/i, '');
        apis.push({ name, openapi: t, grouping: { org: p.org, team: 'Core', domain: p.domain }, properties: providerProps });
      }
    }
  }

  const outFile = join(OUT, `${p.id}.json`);
  writeFileSync(outFile, JSON.stringify({ format: 'api-reusability-preset', set: p.id, org: p.org, apis }));
  const mb = (readFileSync(outFile).length / 1024 / 1024).toFixed(2);
  console.log(`${p.id}: ${apis.length} APIs, ${skipped} skipped → ${outFile} (${mb} MB)`);
}
