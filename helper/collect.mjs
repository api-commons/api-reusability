#!/usr/bin/env node
// api-reusability local helper — pulls API specs from sources a browser can't
// reach safely (AWS API Gateway, Kong, Tyk) and writes a `reusability-bundle.json`
// you Import into the web app. Optionally publishes a report to Confluence.
//
// Zero npm dependencies — uses Node 18+ global fetch and (for AWS) the AWS CLI.
//
// Config: environment variables or ./helper-config.json (same keys, camelCase).
//   AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY   (or use your AWS CLI profile)
//   KONG_ADMIN_URL, KONG_TOKEN
//   TYK_URL, TYK_TOKEN
//   CONFLUENCE_BASE_URL, CONFLUENCE_TOKEN, CONFLUENCE_SPACE, CONFLUENCE_EMAIL
//
// Usage:
//   node helper/collect.mjs --kong --tyk --aws            # collect → reusability-bundle.json
//   node helper/collect.mjs --kong -o my-bundle.json
//   node helper/collect.mjs --publish-confluence report.md --title "API Reusability"
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

let fileCfg = {};
try { fileCfg = JSON.parse(readFileSync(new URL('./helper-config.json', import.meta.url), 'utf8')); } catch { /* optional */ }
const cfg = (k, envKey) => process.env[envKey] ?? fileCfg[k];

const bundle = { format: 'api-reusability-bundle', generated: new Date().toISOString(), apis: [] };
const add = (name, openapi, gateway, grouping = {}) =>
  bundle.apis.push({ name, lang: 'json', openapi, gateway, grouping, provenance: { source: 'helper', gateway } });

// ---- Kong Admin API: services + routes -> synthesized OpenAPI ----------------
async function collectKong() {
  const base = cfg('kongAdminUrl', 'KONG_ADMIN_URL');
  if (!base) return warn('Kong: set KONG_ADMIN_URL');
  const headers = { accept: 'application/json', ...(cfg('kongToken', 'KONG_TOKEN') ? { 'Kong-Admin-Token': cfg('kongToken', 'KONG_TOKEN') } : {}) };
  const services = await getJson(`${base.replace(/\/$/, '')}/services`, headers);
  for (const svc of services?.data ?? []) {
    const routes = await getJson(`${base.replace(/\/$/, '')}/services/${svc.id}/routes`, headers);
    const paths = {};
    for (const r of routes?.data ?? []) {
      for (const p of r.paths ?? ['/']) {
        paths[p] = Object.fromEntries((r.methods ?? ['GET']).map((m) => [m.toLowerCase(), {
          summary: `${m} ${p} (from Kong route ${r.name || r.id})`,
          operationId: `${m.toLowerCase()}_${p.replace(/[^a-z0-9]+/gi, '_')}`,
          responses: { 200: { description: 'OK' } },
        }]));
      }
    }
    const host = svc.host ? `${svc.protocol || 'https'}://${svc.host}${svc.port ? ':' + svc.port : ''}` : 'https://api.example.com';
    const oapi = { openapi: '3.0.3', info: { title: svc.name || svc.id, version: '0.0.0', description: `Discovered from Kong service ${svc.name || svc.id}.` }, servers: [{ url: host }], paths };
    add(svc.name || svc.id, JSON.stringify(oapi, null, 2), 'kong');
  }
  ok(`Kong: ${services?.data?.length ?? 0} service(s)`);
}

// ---- Tyk Dashboard API: apis[].api_definition -------------------------------
async function collectTyk() {
  const base = cfg('tykUrl', 'TYK_URL');
  if (!base) return warn('Tyk: set TYK_URL');
  const headers = { accept: 'application/json', ...(cfg('tykToken', 'TYK_TOKEN') ? { authorization: cfg('tykToken', 'TYK_TOKEN') } : {}) };
  const list = await getJson(`${base.replace(/\/$/, '')}/api/apis`, headers);
  const apis = list?.apis ?? list?.Data ?? list?.data ?? [];
  for (const item of apis) {
    const def = item.api_definition ?? item;
    // Tyk can carry an OpenAPI directly (OAS-native APIs) — prefer it.
    if (def.oas || def.openapi) { add(def.name || def.api_id, JSON.stringify(def.oas ?? def, null, 2), 'tyk'); continue; }
    const target = def.proxy?.target_url || 'https://api.example.com';
    const listen = def.proxy?.listen_path || '/';
    const oapi = { openapi: '3.0.3', info: { title: def.name || def.api_id, version: '0.0.0', description: `Discovered from Tyk API ${def.name || def.api_id}.` }, servers: [{ url: target }], paths: { [listen]: { get: { summary: `Proxy ${listen}`, operationId: 'proxy', responses: { 200: { description: 'OK' } } } } } };
    add(def.name || def.api_id, JSON.stringify(oapi, null, 2), 'tyk');
  }
  ok(`Tyk: ${apis.length} API(s)`);
}

// ---- AWS API Gateway: get-rest-apis + get-export (OpenAPI) via AWS CLI -------
function collectAws() {
  const region = cfg('awsRegion', 'AWS_REGION') || 'us-east-1';
  let restApis;
  try {
    restApis = JSON.parse(execFileSync('aws', ['apigateway', 'get-rest-apis', '--region', region, '--output', 'json'], { encoding: 'utf8' }));
  } catch (e) {
    return warn(`AWS: needs the AWS CLI configured (${e.message.split('\n')[0]})`);
  }
  for (const api of restApis.items ?? []) {
    try {
      // export the 'stage' if present, else skip export and synthesize a stub
      const stage = 'prod';
      const out = execFileSync('aws', ['apigateway', 'get-export', '--rest-api-id', api.id, '--stage-name', stage, '--export-type', 'oas30', '--region', region, '/dev/stdout'], { encoding: 'utf8' });
      add(api.name || api.id, out, 'aws');
    } catch {
      const oapi = { openapi: '3.0.3', info: { title: api.name || api.id, version: '0.0.0', description: `AWS API Gateway REST API ${api.id} (no exportable stage found).` }, paths: {} };
      add(api.name || api.id, JSON.stringify(oapi, null, 2), 'aws');
    }
  }
  ok(`AWS: ${restApis.items?.length ?? 0} REST API(s)`);
}

// ---- Confluence publish (report markdown -> storage page) -------------------
async function publishConfluence(mdFile, title) {
  const base = cfg('confluenceBaseUrl', 'CONFLUENCE_BASE_URL');
  const token = cfg('confluenceToken', 'CONFLUENCE_TOKEN');
  const space = cfg('confluenceSpace', 'CONFLUENCE_SPACE');
  const email = cfg('confluenceEmail', 'CONFLUENCE_EMAIL');
  if (!base || !token || !space) return warn('Confluence: set CONFLUENCE_BASE_URL, CONFLUENCE_TOKEN, CONFLUENCE_SPACE');
  const md = readFileSync(mdFile, 'utf8');
  const body = `<ac:structured-macro ac:name="markdown"><ac:plain-text-body><![CDATA[${md}]]></ac:plain-text-body></ac:structured-macro>`;
  const auth = email ? 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64') : `Bearer ${token}`;
  const res = await fetch(`${base.replace(/\/$/, '')}/rest/api/content`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: auth },
    body: JSON.stringify({ type: 'page', title, space: { key: space }, body: { storage: { value: body, representation: 'storage' } } }),
  });
  if (!res.ok) return err(`Confluence ${res.status}: ${await res.text()}`);
  const j = await res.json();
  ok(`Confluence: published “${title}” → ${base}${j._links?.webui ?? ''}`);
}

// ---- utils ------------------------------------------------------------------
async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}
const ok = (m) => console.log('✓ ' + m);
const warn = (m) => console.warn('⚠ ' + m);
const err = (m) => { console.error('✗ ' + m); process.exitCode = 1; };

// ---- main -------------------------------------------------------------------
(async () => {
  const pub = val('--publish-confluence');
  if (pub) { await publishConfluence(pub, val('--title', 'API Reusability Report')); return; }

  const any = has('--kong') || has('--tyk') || has('--aws');
  if (!any) { console.log('Specify sources: --kong --tyk --aws  (or --publish-confluence <report.md>)'); return; }
  if (has('--kong')) await collectKong().catch((e) => err('Kong: ' + e.message));
  if (has('--tyk')) await collectTyk().catch((e) => err('Tyk: ' + e.message));
  if (has('--aws')) collectAws();

  const outFile = val('-o', 'reusability-bundle.json');
  writeFileSync(outFile, JSON.stringify(bundle, null, 2));
  ok(`Wrote ${bundle.apis.length} API(s) → ${outFile}  (Import it in the web app)`);
})();
