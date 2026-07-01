// The common APIs.json property catalog — the single, shared definition of the
// operational metadata that makes an API adoptable. Both the properties editor
// (dropdown) and the Axis B scorer read from this list, so the published rubric
// and the UI can never drift apart. Weights express how much each property
// contributes to operational reusability.
import { parseDoc, isObject } from './doc';
import type { ApiRecord, ApiProperty } from './storage';

export interface PropDef {
  type: string; // canonical apis.json property type
  label: string; // UI label
  help: string; // what it is / why it matters
  weight: number; // contribution to Axis B
}

// Documentation, Sign Up, Login and Sandbox are the self-service onboarding
// signals practitioners weight most — can a consumer find, register for, and try
// the API without a meeting? They carry the most weight here.
export const COMMON_PROPERTIES: PropDef[] = [
  { type: 'Documentation', label: 'Documentation', help: 'Reference / guides a developer can read', weight: 2 },
  { type: 'SignUp', label: 'Sign Up', help: 'Self-service registration to get access', weight: 1.5 },
  { type: 'Login', label: 'Login', help: 'Authentication / sign-in entry point', weight: 1 },
  { type: 'Sandbox', label: 'Sandbox', help: 'A place to try the API before integrating', weight: 1.5 },
  { type: 'Support', label: 'Support', help: 'How to get help (portal, email, contact)', weight: 1 },
  { type: 'Pricing', label: 'Pricing / Plans', help: 'Cost and access tiers', weight: 1 },
  { type: 'TermsOfService', label: 'Terms of Service', help: 'Rules of use', weight: 1 },
  { type: 'License', label: 'License', help: 'Reuse rights', weight: 1 },
  { type: 'StatusPage', label: 'Status', help: 'Uptime / incident status', weight: 0.5 },
  { type: 'SDK', label: 'SDK', help: 'Client libraries', weight: 0.5 },
  { type: 'ChangeLog', label: 'Changelog', help: 'Version history / release notes', weight: 0.5 },
];

export const propDef = (type: string) => COMMON_PROPERTIES.find((p) => p.type === type);

// Synonyms so imported apis.json properties still match a catalog entry
// regardless of exact spelling / x- prefixes.
const SYNONYMS: Record<string, string[]> = {
  Documentation: ['documentation', 'docs', 'apidocs', 'reference'],
  SignUp: ['signup', 'register', 'registration', 'getstarted', 'onboarding'],
  Login: ['login', 'signin', 'authentication', 'auth', 'oauth'],
  Sandbox: ['sandbox', 'testconsole', 'tryit', 'playground', 'testenvironment', 'demo'],
  Support: ['support', 'contact', 'help', 'helpdesk'],
  Pricing: ['pricing', 'plans', 'plan', 'billing'],
  TermsOfService: ['termsofservice', 'terms', 'tos'],
  License: ['license', 'licensing'],
  StatusPage: ['statuspage', 'status', 'uptime'],
  SDK: ['sdk', 'clientlibraries', 'libraries', 'library'],
  ChangeLog: ['changelog', 'releasenotes', 'releases'],
};
const norm = (s: string) => String(s || '').toLowerCase().replace(/^x-/, '').replace(/[^a-z0-9]+/g, '');

// Does a property list contain a property matching this catalog def?
export function hasType(props: ApiProperty[], def: PropDef): boolean {
  const wanted = new Set([norm(def.type), ...(SYNONYMS[def.type] || [])]);
  return props.some((p) => wanted.has(norm(p.type)));
}

// Parse a legacy apis.json fragment (full doc or single entry) into properties.
export function parseApisJsonProps(text?: string): ApiProperty[] {
  if (!text) return [];
  const doc = parseDoc(text);
  if (!isObject(doc)) return [];
  const entry = Array.isArray(doc.apis) ? doc.apis[0] : doc;
  const props = [
    ...(Array.isArray(entry?.properties) ? entry.properties : []),
    ...(Array.isArray(doc.common) ? doc.common : []),
  ];
  return props
    .filter((p: any) => isObject(p) && p.type)
    .map((p: any) => ({ type: String(p.type), name: p.name ? String(p.name) : undefined, url: String(p.url || '') }));
}

// The properties for a record: structured `properties` if present, otherwise
// derived from any legacy apis.json text.
export function resolveProperties(rec: Pick<ApiRecord, 'properties' | 'apisjson'>): ApiProperty[] {
  if (Array.isArray(rec.properties)) return rec.properties;
  return parseApisJsonProps(rec.apisjson);
}
