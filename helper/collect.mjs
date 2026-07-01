#!/usr/bin/env node
// api-reusability local helper — pulls API specs from the places evidence lives
// inside an enterprise (sources a browser can't reach safely — CORS + secrets)
// and writes a `reusability-bundle.json` you Import into the web app. Optionally
// publishes a report to Confluence.
//
// Zero npm dependencies — Node 18+ global fetch; kubectl/aws CLIs where noted.
//
// Config: environment variables OR ./helper-config.json (camelCase keys). See the
// README for the full key list. Run `node helper/collect.mjs` with no flags for help.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

let fileCfg = {};
try { fileCfg = JSON.parse(readFileSync(new URL('./helper-config.json', import.meta.url), 'utf8')); } catch { /* optional */ }
const cfg = (k, envKey) => process.env[envKey] ?? fileCfg[k];

const bundle = { format: 'api-reusability-bundle', generated: new Date().toISOString(), apis: [] };
const GATEWAYS = new Set(['aws', 'kong', 'tyk', 'apigee', 'azure-apim', 'mulesoft']);
// openapi may be a string or an object; grouping is {org,team,domain}
function add(name, openapi, source, grouping = {}) {
  const text = typeof openapi === 'string' ? openapi : JSON.stringify(openapi, null, 2);
  bundle.apis.push({
    name, lang: 'json', openapi: text, grouping,
    provenance: { source: 'helper', ...(GATEWAYS.has(source) ? { gateway: source } : {}), url: source },
  });
}
const stub = (title, server, desc) => ({ openapi: '3.0.3', info: { title, version: '0.0.0', description: desc }, ...(server ? { servers: [{ url: server }] } : {}), paths: {} });

// ============================ GATEWAYS =======================================

async function collectKong() {
  const base = cfg('kongAdminUrl', 'KONG_ADMIN_URL');
  if (!base) return warn('Kong: set KONG_ADMIN_URL');
  const headers = { accept: 'application/json', ...(cfg('kongToken', 'KONG_TOKEN') ? { 'Kong-Admin-Token': cfg('kongToken', 'KONG_TOKEN') } : {}) };
  const services = await getJson(`${trim(base)}/services`, headers);
  for (const svc of services?.data ?? []) {
    const routes = await getJson(`${trim(base)}/services/${svc.id}/routes`, headers);
    const paths = {};
    for (const r of routes?.data ?? []) {
      for (const p of r.paths ?? ['/']) {
        paths[p] = Object.fromEntries((r.methods ?? ['GET']).map((m) => [m.toLowerCase(), {
          summary: `${m} ${p} (Kong route ${r.name || r.id})`, operationId: `${m.toLowerCase()}_${slug(p)}`, responses: { 200: { description: 'OK' } },
        }]));
      }
    }
    const host = svc.host ? `${svc.protocol || 'https'}://${svc.host}${svc.port ? ':' + svc.port : ''}` : 'https://api.example.com';
    add(svc.name || svc.id, { openapi: '3.0.3', info: { title: svc.name || svc.id, version: '0.0.0', description: `Kong service ${svc.name || svc.id}.` }, servers: [{ url: host }], paths }, 'kong', { domain: 'gateway' });
  }
  ok(`Kong: ${services?.data?.length ?? 0} service(s)`);
}

async function collectTyk() {
  const base = cfg('tykUrl', 'TYK_URL');
  if (!base) return warn('Tyk: set TYK_URL');
  const headers = { accept: 'application/json', ...(cfg('tykToken', 'TYK_TOKEN') ? { authorization: cfg('tykToken', 'TYK_TOKEN') } : {}) };
  const list = await getJson(`${trim(base)}/api/apis`, headers);
  const apis = list?.apis ?? list?.Data ?? list?.data ?? [];
  for (const item of apis) {
    const def = item.api_definition ?? item;
    if (def.oas || def.openapi) { add(def.name || def.api_id, def.oas ?? def, 'tyk', { domain: 'gateway' }); continue; }
    const target = def.proxy?.target_url || 'https://api.example.com';
    const listen = def.proxy?.listen_path || '/';
    add(def.name || def.api_id, { openapi: '3.0.3', info: { title: def.name || def.api_id, version: '0.0.0', description: `Tyk API ${def.name || def.api_id}.` }, servers: [{ url: target }], paths: { [listen]: { get: { summary: `Proxy ${listen}`, operationId: 'proxy', responses: { 200: { description: 'OK' } } } } } }, 'tyk', { domain: 'gateway' });
  }
  ok(`Tyk: ${apis.length} API(s)`);
}

function collectAws() {
  const region = cfg('awsRegion', 'AWS_REGION') || 'us-east-1';
  let restApis;
  try { restApis = JSON.parse(execFileSync('aws', ['apigateway', 'get-rest-apis', '--region', region, '--output', 'json'], { encoding: 'utf8' })); }
  catch (e) { return warn(`AWS: needs the AWS CLI configured (${e.message.split('\n')[0]})`); }
  for (const api of restApis.items ?? []) {
    try {
      const out = execFileSync('aws', ['apigateway', 'get-export', '--rest-api-id', api.id, '--stage-name', cfg('awsStage', 'AWS_STAGE') || 'prod', '--export-type', 'oas30', '--region', region, '/dev/stdout'], { encoding: 'utf8' });
      add(api.name || api.id, out, 'aws', { domain: 'gateway' });
    } catch { add(api.name || api.id, stub(api.name || api.id, '', `AWS API Gateway REST API ${api.id} (no exportable stage).`), 'aws', { domain: 'gateway' }); }
  }
  ok(`AWS: ${restApis.items?.length ?? 0} REST API(s)`);
}

// Google Apigee — API products carry the operations (paths + methods).
async function collectApigee() {
  const org = cfg('apigeeOrg', 'APIGEE_ORG');
  const token = cfg('apigeeToken', 'APIGEE_TOKEN');
  if (!org || !token) return warn('Apigee: set APIGEE_ORG + APIGEE_TOKEN (gcloud auth print-access-token)');
  const base = cfg('apigeeBaseUrl', 'APIGEE_BASE_URL') || 'https://apigee.googleapis.com';
  const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
  const data = await getJson(`${trim(base)}/v1/organizations/${org}/apiproducts?expand=true`, headers);
  for (const prod of data?.apiProduct ?? []) {
    const paths = {};
    for (const cfgOp of prod.operationGroup?.operationConfigs ?? []) {
      for (const op of cfgOp.operations ?? []) {
        const p = op.resource || '/';
        paths[p] = paths[p] || {};
        for (const m of (op.methods?.length ? op.methods : ['GET'])) paths[p][m.toLowerCase()] = { summary: `${m} ${p} (${cfgOp.apiSource || prod.name})`, operationId: `${m.toLowerCase()}_${slug(p)}`, responses: { 200: { description: 'OK' } } };
      }
    }
    add(prod.displayName || prod.name, { openapi: '3.0.3', info: { title: prod.displayName || prod.name, version: '0.0.0', description: prod.description || `Apigee API product ${prod.name}.` }, paths }, 'apigee', { domain: 'gateway' });
  }
  ok(`Apigee: ${data?.apiProduct?.length ?? 0} API product(s)`);
}

// Azure API Management — list APIs, export each as OpenAPI.
async function collectAzureApim() {
  const sub = cfg('azureApimSub', 'AZURE_APIM_SUB');
  const rg = cfg('azureApimRg', 'AZURE_APIM_RG');
  const svc = cfg('azureApimService', 'AZURE_APIM_SERVICE');
  const token = cfg('azureToken', 'AZURE_TOKEN');
  if (!sub || !rg || !svc || !token) return warn('Azure APIM: set AZURE_APIM_SUB/RG/SERVICE + AZURE_TOKEN (az account get-access-token)');
  const v = cfg('azureApiVersion', 'AZURE_API_VERSION') || '2022-08-01';
  const mgmt = 'https://management.azure.com';
  const svcPath = `${mgmt}/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.ApiManagement/service/${svc}`;
  const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
  const list = await getJson(`${svcPath}/apis?api-version=${v}`, headers);
  for (const api of list?.value ?? []) {
    const id = api.name;
    try {
      const exp = await getJson(`${svcPath}/apis/${id}?format=openapi-link&export=true&api-version=${v}`, headers);
      const link = exp?.value?.link || exp?.properties?.value?.link;
      const spec = link ? await (await fetch(link)).text() : null;
      add(api.properties?.displayName || id, spec || stub(id, '', `Azure APIM API ${id}.`), 'azure-apim', { domain: 'gateway' });
    } catch { add(api.properties?.displayName || id, stub(id, '', `Azure APIM API ${id} (export failed).`), 'azure-apim', { domain: 'gateway' }); }
  }
  ok(`Azure APIM: ${list?.value?.length ?? 0} API(s)`);
}

// MuleSoft Anypoint Exchange — REST-API assets with an OpenAPI/OAS file.
async function collectMulesoft() {
  const org = cfg('mulesoftOrgId', 'MULESOFT_ORG_ID');
  const token = cfg('mulesoftToken', 'MULESOFT_TOKEN');
  if (!org || !token) return warn('MuleSoft: set MULESOFT_ORG_ID + MULESOFT_TOKEN (Bearer)');
  const base = cfg('mulesoftBaseUrl', 'MULESOFT_BASE_URL') || 'https://anypoint.mulesoft.com';
  const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
  const assets = await getJson(`${trim(base)}/exchange/api/v2/assets?organizationId=${org}&types=rest-api&limit=100`, headers);
  for (const a of assets ?? []) {
    const oas = (a.files || []).find((f) => /oas|openapi/i.test(f.classifier));
    let spec = null;
    if (oas?.externalLink) { try { spec = await (await fetch(oas.externalLink)).text(); } catch { /* */ } }
    add(a.name || a.assetId, spec || stub(a.name || a.assetId, '', `MuleSoft Exchange asset ${a.assetId}.`), 'mulesoft', { domain: 'gateway' });
  }
  ok(`MuleSoft: ${assets?.length ?? 0} asset(s)`);
}

// ============================ CATALOGS =======================================

// Backstage Software Catalog — API-kind entities carry spec.definition inline.
async function collectBackstage() {
  const base = cfg('backstageBaseUrl', 'BACKSTAGE_BASE_URL');
  if (!base) return warn('Backstage: set BACKSTAGE_BASE_URL');
  const headers = { accept: 'application/json', ...(cfg('backstageToken', 'BACKSTAGE_TOKEN') ? { authorization: `Bearer ${cfg('backstageToken', 'BACKSTAGE_TOKEN')}` } : {}) };
  const entities = await getJson(`${trim(base)}/api/catalog/entities?filter=kind=api`, headers);
  let n = 0;
  for (const e of entities ?? []) {
    const def = e.spec?.definition;
    if (!def) continue;
    add(e.metadata?.title || e.metadata?.name, def, 'backstage', { team: e.spec?.owner, domain: e.spec?.system });
    n++;
  }
  ok(`Backstage: ${n} API entit${n === 1 ? 'y' : 'ies'} with a definition`);
}

// SwaggerHub registry — list an owner's APIs, pull each default version spec.
async function collectSwaggerHub() {
  const owner = cfg('swaggerhubOwner', 'SWAGGERHUB_OWNER');
  const token = cfg('swaggerhubToken', 'SWAGGERHUB_TOKEN');
  if (!owner) return warn('SwaggerHub: set SWAGGERHUB_OWNER (+ SWAGGERHUB_TOKEN for private)');
  const base = cfg('swaggerhubBaseUrl', 'SWAGGERHUB_BASE_URL') || 'https://api.swaggerhub.com';
  const headers = { accept: 'application/json', ...(token ? { authorization: token } : {}) };
  const reg = await getJson(`${trim(base)}/apis/${owner}?limit=100`, headers);
  for (const api of reg?.apis ?? []) {
    const name = (api.properties || []).find((p) => p.type === 'X-Name')?.value || api.name;
    const swaggerUrl = (api.properties || []).find((p) => /swagger|openapi/i.test(p.type) || /swagger\.json|openapi/i.test(p.url || ''))?.url;
    let spec = null;
    if (swaggerUrl) { try { spec = await (await fetch(swaggerUrl, { headers })).text(); } catch { /* */ } }
    add(name, spec || stub(name, '', `SwaggerHub API ${owner}/${name}.`), 'swaggerhub', { domain: 'registry' });
  }
  ok(`SwaggerHub: ${reg?.apis?.length ?? 0} API(s)`);
}

// Postman — API definitions with an OpenAPI schema.
async function collectPostman() {
  const key = cfg('postmanApiKey', 'POSTMAN_API_KEY');
  if (!key) return warn('Postman: set POSTMAN_API_KEY');
  const headers = { accept: 'application/json', 'x-api-key': key };
  const list = await getJson('https://api.getpostman.com/apis', headers);
  let n = 0;
  for (const api of list?.apis ?? []) {
    try {
      const detail = await getJson(`https://api.getpostman.com/apis/${api.id}?include=schemas,versions`, headers);
      const schema = detail?.api?.schemas?.[0] || detail?.schemas?.[0];
      const content = schema?.schema || schema?.content;
      add(api.name, content || stub(api.name, '', `Postman API ${api.id} (no OpenAPI schema).`), 'postman', { domain: 'collection' });
    } catch { add(api.name, stub(api.name, '', `Postman API ${api.id}.`), 'postman', { domain: 'collection' }); }
    n++;
  }
  ok(`Postman: ${n} API(s)`);
}

// Bruno — git-native .bru request files in a local folder → synthesized OpenAPI.
function collectBruno() {
  const dir = cfg('brunoDir', 'BRUNO_DIR') || val('--bruno-dir');
  if (!dir) return warn('Bruno: set BRUNO_DIR (or --bruno-dir <path>)');
  const bru = [];
  (function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); const s = statSync(p); if (s.isDirectory()) walk(p); else if (f.endsWith('.bru')) bru.push(p); } })(dir);
  const paths = {};
  for (const f of bru) {
    const t = readFileSync(f, 'utf8');
    const method = (t.match(/\b(get|post|put|patch|delete)\s*\{/i) || [])[1];
    const url = (t.match(/url:\s*(\S+)/) || [])[1];
    if (!method || !url) continue;
    let path = '/'; try { path = new URL(url).pathname; } catch { path = url; }
    paths[path] = paths[path] || {};
    paths[path][method.toLowerCase()] = { summary: `${method} ${path} (Bruno)`, operationId: `${method.toLowerCase()}_${slug(path)}`, responses: { 200: { description: 'OK' } } };
  }
  add('Bruno collection', { openapi: '3.0.3', info: { title: 'Bruno collection', version: '0.0.0', description: `Synthesized from ${bru.length} .bru files in ${dir}.` }, paths }, 'bruno', { domain: 'collection' });
  ok(`Bruno: ${bru.length} request file(s)`);
}

// ============================ RUNTIME & EVENTS ===============================

// Kubernetes — Ingress + Gateway-API HTTPRoute rules → synthesized OpenAPI per host.
function collectK8s() {
  const ctx = cfg('k8sContext', 'K8S_CONTEXT');
  const ctxArgs = ctx ? ['--context', ctx] : [];
  const byHost = {};
  const pull = (kind, args) => { try { return JSON.parse(execFileSync('kubectl', [...ctxArgs, 'get', kind, '-A', '-o', 'json', ...args], { encoding: 'utf8' })).items || []; } catch { return null; } };
  const ing = pull('ingress', []);
  if (ing === null) return warn('Kubernetes: needs kubectl configured (kubectl get ingress failed)');
  for (const i of ing) for (const rule of i.spec?.rules ?? []) {
    const host = rule.host || i.metadata?.namespace || 'cluster';
    byHost[host] = byHost[host] || {};
    for (const p of rule.http?.paths ?? []) {
      const path = p.path || '/';
      byHost[host][path] = byHost[host][path] || {};
      byHost[host][path].get = { summary: `GET ${path} (ingress ${i.metadata?.name})`, operationId: `get_${slug(path)}`, responses: { 200: { description: 'OK' } } };
    }
  }
  for (const r of pull('httproutes.gateway.networking.k8s.io', []) || []) for (const rule of r.spec?.rules ?? []) {
    const host = (r.spec?.hostnames || [])[0] || r.metadata?.namespace || 'cluster';
    byHost[host] = byHost[host] || {};
    for (const m of rule.matches ?? []) { const path = m.path?.value || '/'; byHost[host][path] = byHost[host][path] || {}; byHost[host][path].get = { summary: `GET ${path} (HTTPRoute ${r.metadata?.name})`, operationId: `get_${slug(path)}`, responses: { 200: { description: 'OK' } } }; }
  }
  for (const [host, paths] of Object.entries(byHost)) add(host, { openapi: '3.0.3', info: { title: host, version: '0.0.0', description: `Discovered from Kubernetes ingress/HTTPRoute for ${host}.` }, servers: [{ url: `https://${host}` }], paths }, 'kubernetes', { domain: 'runtime' });
  ok(`Kubernetes: ${Object.keys(byHost).length} host(s)`);
}

// Confluent / Kafka Schema Registry — subjects → an OpenAPI stub carrying the schema.
async function collectKafkaRegistry() {
  const url = cfg('kafkaRegistryUrl', 'KAFKA_REGISTRY_URL');
  if (!url) return warn('Kafka registry: set KAFKA_REGISTRY_URL');
  const auth = cfg('kafkaRegistryAuth', 'KAFKA_REGISTRY_AUTH');
  const headers = { accept: 'application/json', ...(auth ? { authorization: auth } : {}) };
  const subjects = await getJson(`${trim(url)}/subjects`, headers);
  for (const s of subjects ?? []) {
    let schema = null;
    try { const v = await getJson(`${trim(url)}/subjects/${encodeURIComponent(s)}/versions/latest`, headers); schema = v?.schema; } catch { /* */ }
    let parsed; try { parsed = JSON.parse(schema); } catch { parsed = { type: 'string' }; }
    add(s, { openapi: '3.0.3', info: { title: s, version: '0.0.0', description: `Kafka schema-registry subject ${s} (event API).` }, paths: {}, components: { schemas: { [slug(s)]: parsed } } }, 'kafka-registry', { domain: 'events' });
  }
  ok(`Kafka registry: ${subjects?.length ?? 0} subject(s)`);
}

// ============================ SECURITY & OBSERVABILITY =======================

// 42Crunch — API Security platform: list APIs, pull each OpenAPI.
async function collect42Crunch() {
  const base = cfg('crunch42Url', 'CRUNCH42_URL') || 'https://platform.42crunch.com';
  const token = cfg('crunch42Token', 'CRUNCH42_TOKEN');
  if (!token) return warn('42Crunch: set CRUNCH42_TOKEN');
  const headers = { accept: 'application/json', authorization: `Bearer ${token}` };
  const list = await getJson(`${trim(base)}/api/v1/apis`, headers);
  const apis = list?.apis ?? list ?? [];
  for (const a of apis) {
    let spec = null;
    try { const d = await getJson(`${trim(base)}/api/v1/apis/${a.id || a.apiId}`, headers); spec = d?.specfile ? Buffer.from(d.specfile, 'base64').toString('utf8') : (d?.openapi || null); } catch { /* */ }
    add(a.name || a.id, spec || stub(a.name || a.id, '', `42Crunch API ${a.id}.`), '42crunch', { domain: 'security' });
  }
  ok(`42Crunch: ${apis.length} API(s)`);
}

// Datadog Software Catalog — API-kind entities (discovered/observed services).
async function collectDatadog() {
  const apiKey = cfg('datadogApiKey', 'DATADOG_API_KEY');
  const appKey = cfg('datadogAppKey', 'DATADOG_APP_KEY');
  if (!apiKey || !appKey) return warn('Datadog: set DATADOG_API_KEY + DATADOG_APP_KEY');
  const site = cfg('datadogSite', 'DATADOG_SITE') || 'datadoghq.com';
  const headers = { accept: 'application/json', 'DD-API-KEY': apiKey, 'DD-APPLICATION-KEY': appKey };
  const data = await getJson(`https://api.${site}/api/v2/catalog/entity?filter[kind]=api&page[limit]=100`, headers);
  for (const e of data?.data ?? []) {
    const name = e.attributes?.name || e.id;
    add(name, stub(name, '', `Datadog software-catalog API entity ${e.id} (observed). Enrich with its OpenAPI.`), 'datadog', { domain: 'observability', team: e.attributes?.owner });
  }
  ok(`Datadog: ${data?.data?.length ?? 0} API entit${(data?.data?.length ?? 0) === 1 ? 'y' : 'ies'}`);
}

// Generic discovery — any tool (Salt / Noname / Traceable / …) that can export a
// JSON list of discovered APIs: [{ name, openapi | openapiUrl }]. One connector
// covers every shadow-API scanner that can emit or serve such a list.
async function collectDiscovery() {
  const url = cfg('discoveryUrl', 'DISCOVERY_URL') || val('--discovery-url');
  if (!url) return warn('Discovery: set DISCOVERY_URL (an endpoint/file returning [{name, openapi|openapiUrl}])');
  const token = cfg('discoveryToken', 'DISCOVERY_TOKEN');
  const headers = { accept: 'application/json', ...(token ? { authorization: token } : {}) };
  const list = /^https?:/i.test(url) ? await getJson(url, headers) : JSON.parse(readFileSync(url, 'utf8'));
  const items = Array.isArray(list) ? list : list?.apis ?? [];
  for (const it of items) {
    let spec = it.openapi;
    if (!spec && it.openapiUrl) { try { spec = await (await fetch(it.openapiUrl, { headers })).text(); } catch { /* */ } }
    add(it.name || 'discovered-api', spec || stub(it.name || 'discovered-api', '', 'Discovered API (shadow/zombie) — enrich with its OpenAPI.'), 'discovery', { domain: it.domain || 'discovered' });
  }
  ok(`Discovery: ${items.length} API(s)`);
}

// ============================ CONFLUENCE PUBLISH =============================

async function publishConfluence(mdFile, title) {
  const base = cfg('confluenceBaseUrl', 'CONFLUENCE_BASE_URL');
  const token = cfg('confluenceToken', 'CONFLUENCE_TOKEN');
  const space = cfg('confluenceSpace', 'CONFLUENCE_SPACE');
  const email = cfg('confluenceEmail', 'CONFLUENCE_EMAIL');
  if (!base || !token || !space) return warn('Confluence: set CONFLUENCE_BASE_URL, CONFLUENCE_TOKEN, CONFLUENCE_SPACE');
  const md = readFileSync(mdFile, 'utf8');
  const body = `<ac:structured-macro ac:name="markdown"><ac:plain-text-body><![CDATA[${md}]]></ac:plain-text-body></ac:structured-macro>`;
  const auth = email ? 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64') : `Bearer ${token}`;
  const res = await fetch(`${trim(base)}/rest/api/content`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify({ type: 'page', title, space: { key: space }, body: { storage: { value: body, representation: 'storage' } } }) });
  if (!res.ok) return err(`Confluence ${res.status}: ${await res.text()}`);
  ok(`Confluence: published “${title}” → ${base}${(await res.json())._links?.webui ?? ''}`);
}

// ============================ REGISTRY / MAIN ================================

const CONNECTORS = [
  // gateways
  { flag: '--kong', run: collectKong }, { flag: '--tyk', run: collectTyk }, { flag: '--aws', run: collectAws },
  { flag: '--apigee', run: collectApigee }, { flag: '--azure-apim', run: collectAzureApim }, { flag: '--mulesoft', run: collectMulesoft },
  // catalogs
  { flag: '--backstage', run: collectBackstage }, { flag: '--swaggerhub', run: collectSwaggerHub }, { flag: '--postman', run: collectPostman }, { flag: '--bruno', run: collectBruno },
  // runtime & events
  { flag: '--k8s', run: collectK8s }, { flag: '--kafka-registry', run: collectKafkaRegistry },
  // security & observability
  { flag: '--42crunch', run: collect42Crunch }, { flag: '--datadog', run: collectDatadog }, { flag: '--discovery', run: collectDiscovery },
];

const trim = (u) => String(u).replace(/\/$/, '');
const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'x';
async function getJson(url, headers) { const res = await fetch(url, { headers }); if (!res.ok) throw new Error(`${url} → ${res.status}`); return res.json(); }
const ok = (m) => console.log('✓ ' + m);
const warn = (m) => console.warn('⚠ ' + m);
const err = (m) => { console.error('✗ ' + m); process.exitCode = 1; };

(async () => {
  const pub = val('--publish-confluence');
  if (pub) { await publishConfluence(pub, val('--title', 'API Reusability Report')); return; }

  const selected = has('--all') ? CONNECTORS : CONNECTORS.filter((c) => has(c.flag));
  if (!selected.length) {
    console.log('Collect API evidence into reusability-bundle.json — pick sources (or --all):');
    console.log('  ' + CONNECTORS.map((c) => c.flag).join(' '));
    console.log('Publish a report:  --publish-confluence <report.md> --title "…"');
    return;
  }
  for (const c of selected) {
    try { await c.run(); } catch (e) { err(`${c.flag}: ${e.message}`); }
  }
  const outFile = val('-o', 'reusability-bundle.json');
  writeFileSync(outFile, JSON.stringify(bundle, null, 2));
  ok(`Wrote ${bundle.apis.length} API(s) → ${outFile}  (Import it in the web app)`);
})();
