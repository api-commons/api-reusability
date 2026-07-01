// Client-side persistence: discovered API inventory (scored) + config.
// No backend — everything lives in the browser's localStorage, same model as
// api-discovery / spotlight-validator.

export interface Provenance {
  source: 'apis.io' | 'github' | 'gitlab' | 'bitbucket' | 'har' | 'helper' | 'url' | 'manual' | 'sample';
  url?: string; // where it was found / its source URL
  repo?: string; // owner/repo (or workspace/repo)
  path?: string; // file path in the repo
  ref?: string; // branch/ref
  aid?: string; // APIs.io artifact id
  gateway?: 'aws' | 'kong' | 'tyk'; // helper-collected gateway origin
}

// Grouping keys used to roll reusability up by org / team / domain.
export interface Grouping {
  org?: string;
  team?: string;
  domain?: string;
}

// An APIs.json property — the operational metadata that makes an API adoptable
// (Documentation, SignUp, Login, Sandbox, Support, Pricing, …). type + url is the
// apis.json shape; these feed the Axis B (operational reusability) score.
export interface ApiProperty {
  type: string;
  name?: string;
  url: string;
}

// One discovered API in the inventory. `openapi` is the normalized spec text
// (from apis.io, GitHub, a HAR synthesis, or the helper bundle). `apisjson` is
// the optional apis.json entry describing it (metadata richness / Axis B).
export interface ApiRecord {
  id: string;
  name: string;
  lang: 'yaml' | 'json';
  openapi: string; // the OpenAPI document text
  properties?: ApiProperty[]; // operational APIs.json properties (docs/login/signup/sandbox/…)
  apisjson?: string; // legacy: raw apis.json fragment (still read on import for back-compat)
  grouping: Grouping;
  provenance: Provenance;
  savedAt: number;
}

// A recorded reuse event — a team adopting an existing API instead of rebuilding.
// Lets an org report reuse actually happening (Chase's ask).
export interface ReuseEvent {
  id: string;
  apiId: string; // ApiRecord.id that was reused
  apiName: string;
  team?: string;
  note?: string;
  extended?: boolean; // reused-and-extended vs. reused as-is
  at: number;
}

const INV = 'api-reusability:inventory';
const CFG = 'api-reusability:config';
const LEDGER = 'api-reusability:reuse-ledger';

// Scoring weights for the composite grade. Exposed in Config so the rubric is
// tunable — the definition of "reuse" is not hard-coded.
export interface Weights {
  openapi: number; // Axis A weight (design)
  apisjson: number; // Axis B weight (operational)
  composability: number; // Axis C weight (composability / agent-readiness)
  duplication: number; // duplication-penalty weight
}
export const DEFAULT_WEIGHTS: Weights = { openapi: 0.4, apisjson: 0.25, composability: 0.15, duplication: 0.2 };

export interface Config {
  // discovery
  githubToken?: string;
  gitlabToken?: string;
  bitbucketUser?: string;
  bitbucketToken?: string;
  sources?: Record<string, boolean>; // search source toggles (apis.io/github/gitlab/bitbucket)
  // helper-only connectors (keys held here so the Config UI is complete; the
  // actual calls run in the local helper CLI, never from the browser)
  confluenceBaseUrl?: string;
  confluenceToken?: string;
  awsRegion?: string;
  awsKey?: string;
  awsSecret?: string;
  kongAdminUrl?: string;
  kongToken?: string;
  tykUrl?: string;
  tykToken?: string;
  // scoring
  weights?: Weights;
}

const read = <T>(k: string, fallback: T): T => {
  try {
    const v = JSON.parse(localStorage.getItem(k) || 'null');
    return v ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (k: string, v: unknown) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* disabled / quota */
  }
};

// Inventory
export const loadInventory = (): ApiRecord[] => read<ApiRecord[]>(INV, []);
export const saveInventory = (a: ApiRecord[]) => write(INV, a);
export function upsertApi(a: ApiRecord) {
  const all = loadInventory();
  const i = all.findIndex((x) => x.id === a.id);
  if (i >= 0) all[i] = a;
  else all.push(a);
  saveInventory(all);
}
export const removeApi = (id: string) => saveInventory(loadInventory().filter((a) => a.id !== id));
export const getApi = (id: string) => loadInventory().find((a) => a.id === id);

// Sample-data helpers. Sample records carry provenance.source === 'sample' so
// they can be cleared or reloaded independently of anything the user adds.
const SEEDED = 'api-reusability:seeded';
export const hasSamples = () => loadInventory().some((a) => a.provenance.source === 'sample');
export const clearSamples = () => saveInventory(loadInventory().filter((a) => a.provenance.source !== 'sample'));
export const wasSeeded = () => { try { return localStorage.getItem(SEEDED) === '1'; } catch { return false; } };
export const markSeeded = () => { try { localStorage.setItem(SEEDED, '1'); } catch { /* */ } };

// Reuse ledger
export const loadLedger = (): ReuseEvent[] => read<ReuseEvent[]>(LEDGER, []);
export const saveLedger = (e: ReuseEvent[]) => write(LEDGER, e);
export function addReuseEvent(e: ReuseEvent) {
  const all = loadLedger();
  all.push(e);
  saveLedger(all);
}
export const removeReuseEvent = (id: string) => saveLedger(loadLedger().filter((e) => e.id !== id));

// Config
export const loadConfig = (): Config => read<Config>(CFG, {});
export const saveConfig = (c: Config) => write(CFG, c);
export const weightsOf = (c: Config): Weights => ({ ...DEFAULT_WEIGHTS, ...(c.weights || {}) });

export const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? 'a' + Math.random().toString(36).slice(2) + Date.now().toString(36);
