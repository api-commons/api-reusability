import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import {
  loadInventory, upsertApi, removeApi, getApi, loadLedger, addReuseEvent, removeReuseEvent,
  loadConfig, saveConfig, weightsOf, newId,
  type ApiRecord, type Provenance, type Grouping, type Config, type ReuseEvent,
} from './storage';
import { ARTIFACTS, artifactById, type ArtifactType } from './artifacts';
import { searchSource, loadHit, enabledSources, type Hit, type SourceId, type Tokens } from './sources';
import { scoreInventory, type ApiScore } from './scoring';
import { rollup, type GroupBy } from './grouping';
import { buildIndex } from './apisjson-index';
import { buildReportMarkdown, buildReportJson } from './report';
import { parseHar } from './har';
import { parseDoc, detectLang, isObject } from './doc';
import { initEngage } from './engage';
import './style.css';

self.MonacoEnvironment = { getWorker: (_id, label) => (label === 'json' ? new JsonWorker() : new EditorWorker()) };
const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

let lang: 'yaml' | 'json' = 'yaml';
let provenance: Provenance = { source: 'manual' };
let activeId: string | null = null;

const editor = monaco.editor.create($('#editor'), {
  value: '', language: 'yaml', theme: 'vs-dark', automaticLayout: true, minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false,
});

// ---- helpers ----------------------------------------------------------------
function downloadFile(name: string, text: string, mime = 'application/yaml') {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
const status = (t: string, ok = true) => { const el = $('#save-status'); el.textContent = t; el.style.color = ok ? 'var(--muted)' : '#f14c4c'; };
const gradeClass = (l: string) => `grade grade-${l}`;

// current scores cache (recomputed on inventory change)
let scores: ApiScore[] = [];
let dup = scoreInventory([]).duplication;
function recompute() {
  const r = scoreInventory(loadInventory(), weightsOf(loadConfig()));
  scores = r.scores;
  dup = r.duplication;
}
const scoreFor = (id: string) => scores.find((s) => s.id === id);

// ---- editor / provenance ----------------------------------------------------
function setContent(text: string) {
  let out = text;
  try { out = lang === 'json' ? JSON.stringify(parseYaml(text), null, 2) : stringifyYaml(parseYaml(text)); } catch { /* keep raw */ }
  const m = editor.getModel();
  if (m) monaco.editor.setModelLanguage(m, lang === 'json' ? 'json' : 'yaml');
  editor.setValue(out);
}
function showProvenance() {
  const p = provenance;
  const where = p.source === 'apis.io' ? `APIs.io${p.aid ? ` · ${p.aid}` : ''}`
    : p.source === 'har' ? 'HAR upload (evidence-based)'
    : p.source === 'helper' ? `helper${p.gateway ? ` · ${p.gateway}` : ''}`
    : p.repo ? `${p.source}: ${p.repo}${p.path ? `/${p.path}` : ''}${p.ref ? ` @ ${p.ref}` : ''}`
    : p.url || p.source;
  $('#provenance').innerHTML = `Source: <strong>${esc(String(where))}</strong>` + (p.url ? ` · <a href="${esc(p.url)}" target="_blank" rel="noopener">open ↗</a>` : '');
}
$('#lang-yaml').addEventListener('click', () => setLang('yaml'));
$('#lang-json').addEventListener('click', () => setLang('json'));
function setLang(l: 'yaml' | 'json') {
  if (l === lang) return;
  const t = editor.getValue();
  let conv = t; try { conv = l === 'json' ? JSON.stringify(parseYaml(t), null, 2) : stringifyYaml(parseYaml(t)); } catch { /* */ }
  lang = l;
  const m = editor.getModel(); if (m) monaco.editor.setModelLanguage(m, l === 'json' ? 'json' : 'yaml');
  editor.setValue(conv);
  $('#lang-yaml').classList.toggle('active', l === 'yaml');
  $('#lang-json').classList.toggle('active', l === 'json');
}

// ---- artifact type + source selectors ---------------------------------------
const typeSelect = $<HTMLSelectElement>('#artifact-type');
typeSelect.innerHTML = ARTIFACTS.map((a) => `<option value="${a.id}">${a.label}</option>`).join('');
typeSelect.value = 'openapi';
let currentArtifact: ArtifactType = artifactById('openapi');
typeSelect.addEventListener('change', () => { currentArtifact = artifactById(typeSelect.value); });

const sourceSelect = $<HTMLSelectElement>('#source');
let currentSource: SourceId = 'apis.io';
function populateSources() {
  const enabled = enabledSources(loadConfig().sources);
  sourceSelect.innerHTML = enabled.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
  if (!enabled.some((s) => s.id === currentSource)) currentSource = 'apis.io';
  sourceSelect.value = currentSource;
}
populateSources();
sourceSelect.addEventListener('change', () => { currentSource = sourceSelect.value as SourceId; });
function gitTokens(): Tokens {
  const c = loadConfig();
  return { github: c.githubToken, gitlab: c.gitlabToken, bitbucketUser: c.bitbucketUser, bitbucket: c.bitbucketToken };
}

// ---- search -----------------------------------------------------------------
const results = $('#results');
const qInput = $<HTMLInputElement>('#q');
const hideResults = () => { results.hidden = true; results.innerHTML = ''; };
const msg = (t: string) => { results.innerHTML = `<div class="hit-msg">${esc(t)}</div>`; results.hidden = false; };
let lastHits: Hit[] = [];

async function runSearch() {
  const q = qInput.value.trim();
  const srcLabel = sourceSelect.options[sourceSelect.selectedIndex]?.textContent || currentSource;
  msg(`Searching ${srcLabel} for ${currentArtifact.label}…`);
  try {
    lastHits = await searchSource(currentSource, currentArtifact, q, gitTokens());
    if (!lastHits.length) { msg(currentArtifact.searchNote || `No ${currentArtifact.label} results on ${srcLabel}.`); return; }
    results.innerHTML = lastHits.map((h, i) => `<div class="hit" data-i="${i}">
      <span class="hit-name">${esc(h.name)}</span>
      <span class="hit-sub">${esc(h.repo || h.type || h.source)}${h.path ? ` · ${esc(h.path)}` : ''}</span>
    </div>`).join('');
    results.hidden = false;
    results.querySelectorAll<HTMLElement>('.hit').forEach((el) => el.addEventListener('click', () => selectHit(lastHits[Number(el.dataset.i)])));
  } catch (e) {
    msg(`${srcLabel} search failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
async function selectHit(h: Hit) {
  msg(`Loading ${h.name}…`);
  try {
    const content = await loadHit(h, gitTokens());
    provenance = h.source === 'apis.io'
      ? { source: 'apis.io', url: h.url, aid: h.aid } as Provenance
      : { source: h.source, repo: h.repo, path: h.path, ref: h.ref, url: h.url };
    activeId = null;
    $<HTMLInputElement>('#api-name').value = h.name;
    setContent(content);
    showProvenance();
    hideResults();
    status('Loaded — set grouping and Add to inventory.');
  } catch (e) {
    msg(`Could not load: ${e instanceof Error ? e.message : String(e)}`);
  }
}
$('#search').addEventListener('click', runSearch);
qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
document.addEventListener('click', (e) => { if (!results.hidden && !(e.target as HTMLElement).closest('.search-wrap')) hideResults(); });

// ---- HAR upload -------------------------------------------------------------
$<HTMLInputElement>('#har-file').addEventListener('change', async (e) => {
  const files = (e.target as HTMLInputElement).files;
  if (!files?.length) return;
  let added = 0;
  const errs: string[] = [];
  for (const f of Array.from(files)) {
    try {
      const apis = parseHar(await f.text());
      for (const api of apis) {
        upsertApi({
          id: newId(), name: api.host, lang: 'yaml', openapi: api.openapiYaml,
          grouping: readGrouping(), provenance: { source: 'har', url: f.name }, savedAt: Date.now(),
        });
        added++;
      }
    } catch (err) {
      errs.push(`${f.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  (e.target as HTMLInputElement).value = '';
  recompute(); renderInventory(); switchTab('inventory');
  status(`Added ${added} API${added === 1 ? '' : 's'} from HAR${errs.length ? ` · ${errs.length} error(s)` : ''}`, !errs.length);
  if (errs.length) window.alert(errs.join('\n'));
});

// ---- Import (helper/inventory bundle, apis.json index, or single spec) -------
$<HTMLInputElement>('#import-file').addEventListener('change', async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!f) return;
  const text = await f.text();
  const doc = parseDoc(text);
  // 1) reusability bundle (from the helper or an Export bundle) — full round-trip
  if (isObject(doc) && Array.isArray(doc.apis) && doc.apis.some((a: any) => a.openapi)) {
    let n = 0;
    for (const a of doc.apis) {
      if (!a.openapi) continue;
      upsertApi({
        id: newId(), name: a.name || 'imported', lang: a.lang === 'json' ? 'json' : 'yaml',
        openapi: typeof a.openapi === 'string' ? a.openapi : stringifyYaml(a.openapi),
        apisjson: a.apisjson ? (typeof a.apisjson === 'string' ? a.apisjson : stringifyYaml(a.apisjson)) : undefined,
        grouping: a.grouping || {}, provenance: a.provenance || { source: 'helper', gateway: a.gateway }, savedAt: Date.now(),
      });
      n++;
    }
    recompute(); renderInventory(); switchTab('inventory');
    status(`Imported ${n} API${n === 1 ? '' : 's'} from bundle.`);
    return;
  }
  // 2) otherwise treat as a single spec to inspect/add
  lang = detectLang(text);
  provenance = { source: 'url', url: f.name };
  activeId = null;
  $<HTMLInputElement>('#api-name').value = (doc?.info?.title || f.name).toString();
  $('#lang-yaml').classList.toggle('active', lang === 'yaml'); $('#lang-json').classList.toggle('active', lang === 'json');
  setContent(text);
  showProvenance();
  status('Loaded file — set grouping and Add to inventory.');
});

// ---- grouping + add to inventory --------------------------------------------
function readGrouping(): Grouping {
  const g: Grouping = {};
  const org = $<HTMLInputElement>('#grp-org').value.trim();
  const team = $<HTMLInputElement>('#grp-team').value.trim();
  const domain = $<HTMLInputElement>('#grp-domain').value.trim();
  if (org) g.org = org; if (team) g.team = team; if (domain) g.domain = domain;
  return g;
}
function writeGrouping(g: Grouping) {
  $<HTMLInputElement>('#grp-org').value = g.org || '';
  $<HTMLInputElement>('#grp-team').value = g.team || '';
  $<HTMLInputElement>('#grp-domain').value = g.domain || '';
}
$('#add-inventory').addEventListener('click', () => {
  const content = editor.getValue().trim();
  if (!content) { status('Nothing to add — load or paste a spec first.', false); return; }
  const parsed = parseDoc(content);
  if (!isObject(parsed) || !(parsed.openapi || parsed.swagger)) {
    if (!window.confirm('This does not look like an OpenAPI document. Add it anyway?')) return;
  }
  const name = $<HTMLInputElement>('#api-name').value.trim() || parsed?.info?.title || 'Untitled API';
  const rec: ApiRecord = activeId && getApi(activeId)
    ? { ...getApi(activeId)!, name, lang, openapi: content, grouping: readGrouping(), savedAt: Date.now() }
    : { id: newId(), name, lang, openapi: content, grouping: readGrouping(), provenance, savedAt: Date.now() };
  activeId = rec.id;
  upsertApi(rec);
  recompute(); renderInventory();
  const s = scoreFor(rec.id);
  status(`Added ✓ — reusability ${s ? `${s.composite}/100 (${s.letter})` : 'scored'}`);
});

// ---- inventory list + intent search -----------------------------------------
function pathsOf(openapi: string): string[] {
  const d = parseDoc(openapi);
  return isObject(d?.paths) ? Object.keys(d.paths) : [];
}
function intentRank(inv: ApiRecord[], query: string): ApiRecord[] {
  const tokens = query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  if (!tokens.length) return inv;
  const scored = inv.map((a) => {
    const d = parseDoc(a.openapi);
    const hay = [a.name, d?.info?.title, d?.info?.description, ...pathsOf(a.openapi), a.grouping.domain, a.grouping.team]
      .filter(Boolean).join(' ').toLowerCase();
    const hits = tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    return { a, hits };
  });
  return scored.filter((s) => s.hits > 0).sort((x, y) => y.hits - x.hits).map((s) => s.a);
}
function renderInventory() {
  const inv = loadInventory().sort((a, b) => b.savedAt - a.savedAt);
  $('#inv-count').textContent = String(inv.length);
  const query = $<HTMLInputElement>('#intent').value.trim();
  const shown = query ? intentRank(inv, query) : inv;
  const note = $('#intent-note') as HTMLElement;
  if (query) { note.hidden = false; note.innerHTML = `<strong>${shown.length}</strong> reuse candidate${shown.length === 1 ? '' : 's'} match “${esc(query)}” — check these before building something new.`; }
  else note.hidden = true;

  const list = $('#inventory-list');
  list.innerHTML = shown.length
    ? shown.map((a) => {
        const s = scoreFor(a.id);
        const g = [a.grouping.org, a.grouping.team, a.grouping.domain].filter(Boolean).join(' · ');
        return `<li class="${a.id === activeId ? 'active' : ''}" data-id="${a.id}">
          <span class="${gradeClass(s?.letter || 'F')}" title="composite reusability">${s ? s.composite : '—'}</span>
          <span class="store-name" title="${esc(a.name)}">${esc(a.name)}</span>
          <span class="store-meta">${esc(a.provenance.source)}${g ? ` · ${esc(g)}` : ''} · A ${s?.axisA.score ?? '—'} · B ${s?.axisB.score ?? '—'}</span>
          <button class="store-btn" type="button">Load</button>
          <button class="store-del" type="button" title="Remove">&times;</button>
        </li>`;
      }).join('')
    : `<li class="store-empty">${query ? 'No matches — nothing like that exists yet, safe to build.' : 'No APIs yet — search, upload a HAR, or import a spec, then Add to inventory.'}</li>`;
  list.querySelectorAll<HTMLLIElement>('li[data-id]').forEach((li) => {
    const id = li.dataset.id!;
    li.querySelector<HTMLButtonElement>('.store-btn')?.addEventListener('click', () => {
      const a = getApi(id); if (!a) return;
      activeId = a.id; lang = a.lang; provenance = a.provenance;
      $('#lang-yaml').classList.toggle('active', lang === 'yaml'); $('#lang-json').classList.toggle('active', lang === 'json');
      $<HTMLInputElement>('#api-name').value = a.name;
      writeGrouping(a.grouping);
      const m = editor.getModel(); if (m) monaco.editor.setModelLanguage(m, lang === 'json' ? 'json' : 'yaml');
      editor.setValue(a.openapi);
      showProvenance(); renderInventory();
    });
    li.querySelector<HTMLButtonElement>('.store-del')?.addEventListener('click', () => {
      removeApi(id); if (id === activeId) activeId = null; recompute(); renderInventory(); populateLedgerApis();
    });
  });
}
let intentT: number | undefined;
$<HTMLInputElement>('#intent').addEventListener('input', () => { clearTimeout(intentT); intentT = window.setTimeout(renderInventory, 150); });
$('#intent-clear').addEventListener('click', () => { $<HTMLInputElement>('#intent').value = ''; renderInventory(); });

// ---- report -----------------------------------------------------------------
function renderReport() {
  const inv = loadInventory();
  const body = $('#report-body');
  if (!inv.length) { body.innerHTML = '<p class="store-empty">No APIs in the inventory yet.</p>'; return; }
  const j = buildReportJson({ inventory: inv, scores, duplication: dup });
  const groupTable = (by: GroupBy) => {
    const rows = rollup(inv, scores, by);
    if (rows.length <= 1 && rows[0]?.key === 'ungrouped') return '';
    return `<h3>By ${by}</h3><table class="scorecard"><thead><tr><th>${by}</th><th>APIs</th><th>Grade</th><th>Composite</th><th>Design</th><th>Metadata</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.key)}</td><td>${r.apiCount}</td><td><span class="${gradeClass(r.letter)}">${r.letter}</span></td><td>${r.avgComposite}</td><td>${r.avgAxisA}</td><td>${r.avgAxisB}</td></tr>`).join('')}</tbody></table>`;
  };
  body.innerHTML = `
    <div class="summary-grid">
      <div class="stat"><span class="stat-n">${j.summary.apis}</span><span class="stat-l">APIs</span></div>
      <div class="stat"><span class="stat-n">${j.summary.avgComposite}</span><span class="stat-l">avg reuse</span></div>
      <div class="stat"><span class="stat-n">${j.summary.avgOpenApi}</span><span class="stat-l">design</span></div>
      <div class="stat"><span class="stat-n">${j.summary.avgApisJson}</span><span class="stat-l">metadata</span></div>
      <div class="stat"><span class="stat-n">${j.summary.pathOverlapRate}%</span><span class="stat-l">path overlap</span></div>
      <div class="stat"><span class="stat-n">${j.summary.duplicateSchemas}</span><span class="stat-l">dup schemas</span></div>
    </div>
    ${groupTable('org')}${groupTable('team')}${groupTable('domain')}
    <h3>Per-API grades</h3>
    <table class="scorecard"><thead><tr><th>API</th><th>Grade</th><th>Composite</th><th>Design</th><th>Metadata</th><th>Dup</th></tr></thead><tbody>
      ${[...scores].sort((a, b) => b.composite - a.composite).map((s) => `<tr><td>${esc(s.name)}</td><td><span class="${gradeClass(s.letter)}">${s.letter}</span></td><td>${s.composite}</td><td>${s.axisA.score}</td><td>${s.axisB.score}</td><td>${Math.round(s.penalty * 100)}%</td></tr>`).join('')}
    </tbody></table>
    ${dup.consolidations.length ? `<h3>Consolidation opportunities</h3><ul class="conso">${dup.consolidations.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : ''}
  `;
}
$('#export-md').addEventListener('click', () => {
  const inv = loadInventory(); if (!inv.length) return window.alert('Nothing to report yet.');
  downloadFile('api-reusability-report.md', buildReportMarkdown({ inventory: inv, scores, duplication: dup }), 'text/markdown');
});
$('#export-json').addEventListener('click', () => {
  const inv = loadInventory(); if (!inv.length) return window.alert('Nothing to report yet.');
  downloadFile('api-reusability-report.json', JSON.stringify(buildReportJson({ inventory: inv, scores, duplication: dup }), null, 2), 'application/json');
});
$('#rescore').addEventListener('click', () => { recompute(); renderInventory(); renderReport(); });

// ---- reuse ledger -----------------------------------------------------------
function populateLedgerApis() {
  const sel = $<HTMLSelectElement>('#ledger-api');
  const inv = loadInventory();
  sel.innerHTML = inv.length ? inv.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('') : '<option value="">— add APIs first —</option>';
}
function renderLedger() {
  const evs = loadLedger().sort((a, b) => b.at - a.at);
  $('#ledger-count').textContent = String(evs.length);
  const list = $('#ledger-list');
  list.innerHTML = evs.length
    ? evs.map((e) => `<li data-id="${e.id}">
        <span class="store-name">${esc(e.apiName)}${e.extended ? ' <span class="ext">extended</span>' : ''}</span>
        <span class="store-meta">reused${e.team ? ` by ${esc(e.team)}` : ''} · ${new Date(e.at).toISOString().slice(0, 10)}</span>
        <button class="store-del" type="button" title="Remove">&times;</button>
      </li>`).join('')
    : '<li class="store-empty">No reuse logged yet — record when a team adopts an existing API.</li>';
  list.querySelectorAll<HTMLLIElement>('li[data-id]').forEach((li) => {
    li.querySelector<HTMLButtonElement>('.store-del')?.addEventListener('click', () => { removeReuseEvent(li.dataset.id!); renderLedger(); });
  });
}
$('#ledger-add').addEventListener('click', () => {
  const apiId = $<HTMLSelectElement>('#ledger-api').value;
  if (!apiId) return;
  const api = getApi(apiId); if (!api) return;
  const ev: ReuseEvent = {
    id: newId(), apiId, apiName: api.name,
    team: $<HTMLInputElement>('#ledger-team').value.trim() || undefined,
    extended: $<HTMLInputElement>('#ledger-extended').checked,
    at: Date.now(),
  };
  addReuseEvent(ev);
  $<HTMLInputElement>('#ledger-team').value = ''; $<HTMLInputElement>('#ledger-extended').checked = false;
  renderLedger();
});

// ---- rubric -----------------------------------------------------------------
function renderRubric() {
  $('#rubric-body').innerHTML = `
    <h2>What we mean by “reusable”</h2>
    <p>Enterprises keep re-implementing the same capability across silos not because teams are bad at APIs, but because they can't <em>find</em>, <em>trust</em>, or <em>compose</em> what already exists. This tool makes reusability a measurable, published definition — so “reuse” isn't left undefined.</p>
    <h3>Axis A — OpenAPI design (how reusable is the interface?)</h3>
    <p>A transparent, weighted checklist over the OpenAPI: API-level description, <code>operationId</code>s, documented operations &amp; parameters, success-response schemas, error responses, security schemes, servers, tags, consistent path casing, and — most heavily weighted — <strong>schema reuse via <code>components</code> + <code>$ref</code></strong> rather than inline shapes. A spec you can generate an SDK or agent tool from is a reusable one.</p>
    <h3>Axis B — APIs.json metadata (how discoverable &amp; adoptable is it?)</h3>
    <p>Reuse also needs findability and support: a rich description, documentation, linked OpenAPI, support/contact, terms of service, license, tags, and companion artifacts (MCP / Plans / Rate Limits). This is reusability “as defined by apis.json.”</p>
    <h3>Cross-API duplication (is it already built elsewhere?)</h3>
    <p>Across the whole inventory we detect repeated paths, near-identical schemas, and shared parameters/headers — the “three teams already built that” signal — and surface consolidation opportunities. Heavily-duplicated APIs carry a penalty.</p>
    <h3>Composite grade</h3>
    <p>Composite = <code>wA·design + wB·metadata + wD·(1 − duplication)</code>, graded A–F. The weights are yours to tune in <strong>Config → Scoring weights</strong>, because every org's definition of reuse is a little different.</p>
    <p class="src-note">Grounded in what enterprise practitioners told us reusability actually is: semantic discovery “before you build from scratch,” a shared taxonomy so teams can mark things reusable, and composition of existing APIs into named units.</p>
  `;
}

// ---- tabs -------------------------------------------------------------------
function switchTab(name: string) {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  for (const id of ['inventory', 'report', 'ledger', 'rubric', 'config']) ($('#tab-' + id) as HTMLElement).hidden = id !== name;
  if (name === 'report') renderReport();
  if (name === 'ledger') { populateLedgerApis(); renderLedger(); }
  if (name === 'rubric') renderRubric();
}
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab!)));
$('#nav-rubric').addEventListener('click', (e) => { e.preventDefault(); switchTab('rubric'); });

// ---- config -----------------------------------------------------------------
const CFG_MAP: Array<[string, keyof Config]> = [
  ['cfg-gh-token', 'githubToken'], ['cfg-gl-token', 'gitlabToken'], ['cfg-bb-user', 'bitbucketUser'], ['cfg-bb-token', 'bitbucketToken'],
  ['cfg-aws-region', 'awsRegion'], ['cfg-aws-key', 'awsKey'], ['cfg-aws-secret', 'awsSecret'],
  ['cfg-kong-url', 'kongAdminUrl'], ['cfg-kong-token', 'kongToken'], ['cfg-tyk-url', 'tykUrl'], ['cfg-tyk-token', 'tykToken'],
  ['cfg-conf-url', 'confluenceBaseUrl'], ['cfg-conf-token', 'confluenceToken'],
];
(function initConfig() {
  const cfg = loadConfig();
  for (const [id, key] of CFG_MAP) {
    const el = $<HTMLInputElement>('#' + id);
    el.value = (cfg[key] as string) ?? '';
    let t: number | undefined;
    el.addEventListener('input', () => {
      clearTimeout(t);
      t = window.setTimeout(() => { const c = loadConfig(); const v = el.value.trim(); if (v) (c[key] as string) = v; else delete c[key]; saveConfig(c); }, 300);
    });
  }
  // source toggles
  for (const id of ['github', 'gitlab', 'bitbucket'] as const) {
    const el = $<HTMLInputElement>('#src-' + id);
    el.checked = (cfg.sources?.[id]) ?? (id === 'github');
    el.addEventListener('change', () => {
      const c = loadConfig();
      c.sources = { ...(c.sources || {}), [id]: el.checked };
      saveConfig(c);
      populateSources();
    });
  }
  // scoring weights
  const w = weightsOf(cfg);
  const wmap: Array<[string, keyof typeof w]> = [['w-openapi', 'openapi'], ['w-apisjson', 'apisjson'], ['w-duplication', 'duplication']];
  for (const [id, key] of wmap) {
    const el = $<HTMLInputElement>('#' + id);
    el.value = String(w[key]);
    el.addEventListener('change', () => {
      const c = loadConfig();
      const val = parseFloat(el.value);
      c.weights = { ...weightsOf(c), [key]: Number.isFinite(val) ? val : 0 };
      saveConfig(c);
      recompute(); renderInventory();
    });
  }
  $<HTMLInputElement>('#cfg-show').addEventListener('change', (e) => {
    const type = (e.target as HTMLInputElement).checked ? 'text' : 'password';
    for (const id of ['cfg-gh-token', 'cfg-gl-token', 'cfg-bb-token', 'cfg-aws-key', 'cfg-aws-secret', 'cfg-kong-token', 'cfg-tyk-token', 'cfg-conf-token'])
      $<HTMLInputElement>('#' + id).type = type;
  });
})();

// ---- download APIs.json index -----------------------------------------------
$('#download-apisjson').addEventListener('click', () => {
  const inv = loadInventory();
  if (!inv.length) { window.alert('No APIs in the inventory to index yet.'); return; }
  downloadFile('apis.yaml', buildIndex(inv, scores));
});

// ---- boot -------------------------------------------------------------------
recompute();
renderInventory();
showProvenance();

initEngage(() => {
  const inv = loadInventory();
  const parts = [`APIs in inventory: ${inv.length}`];
  if (scores.length) parts.push(`Avg reusability: ${Math.round(scores.reduce((s, x) => s + x.composite, 0) / scores.length)}/100`);
  if (dup.pathOverlapRate) parts.push(`Path overlap rate: ${dup.pathOverlapRate}%`);
  return 'Context from the API Reusability tool:\n- ' + parts.join('\n- ');
});
