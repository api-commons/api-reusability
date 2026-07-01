// Axis B — APIs.json metadata richness (discoverability / operational reuse).
//
// Reusability isn't only about the OpenAPI shape; it's also whether an API is
// findable and supported. This scores the apis.json (0.21) description of an API
// against the properties that make it adoptable: documentation, support, terms,
// license, tags, and links to companion artifacts. Answers the "does it have
// documentation, etc." requirement and Elsevier's "mark things as reusable".
import { parseDoc, isObject } from './doc';

export interface MetaCheck {
  key: string;
  label: string;
  present: boolean;
  hint: string;
}

export interface ApisJsonScore {
  score: number; // 0..100
  checks: MetaCheck[];
  hasApisJson: boolean;
}

// Normalize either a full apis.json doc or a single `apis[]` entry into one
// entry object plus its property list.
function entryOf(doc: any): { entry: Record<string, any>; props: any[] } {
  if (!isObject(doc)) return { entry: {}, props: [] };
  // full apis.json — take the first api entry, merge in top-level common props
  if (Array.isArray(doc.apis) && doc.apis.length) {
    const e = doc.apis[0];
    const props = [...(Array.isArray(e.properties) ? e.properties : []), ...(Array.isArray(doc.common) ? doc.common : [])];
    return { entry: e, props };
  }
  // already a single entry
  const props = Array.isArray(doc.properties) ? doc.properties : [];
  return { entry: doc, props };
}

const hasProp = (props: any[], types: string[]) =>
  props.some((p) => isObject(p) && types.some((t) => String(p.type || '').toLowerCase().includes(t.toLowerCase())));

export function scoreApisJson(text?: string): ApisJsonScore {
  const doc = text ? parseDoc(text) : null;
  const { entry, props } = entryOf(doc);
  const hasApisJson = !!text && isObject(doc);

  const desc = String(entry.description || '').trim();
  const tags = entry.tags || (doc && doc.tags);

  const checks: MetaCheck[] = [
    { key: 'desc', label: 'Rich description', present: desc.length >= 40, hint: 'Write a description that explains what the API is for (40+ chars).' },
    { key: 'docs', label: 'Documentation link', present: hasProp(props, ['Documentation', 'x-documentation']), hint: 'Add a Documentation property so developers can learn the API.' },
    { key: 'openapi', label: 'OpenAPI linked', present: hasProp(props, ['OpenAPI', 'Swagger']), hint: 'Link the OpenAPI so the interface is machine-readable.' },
    { key: 'support', label: 'Support / contact', present: hasProp(props, ['Support', 'x-support', 'contact']), hint: 'Add a Support property (email, portal, or contact).' },
    { key: 'terms', label: 'Terms of Service', present: hasProp(props, ['TermsOfService', 'Terms', 'x-terms']), hint: 'Publish terms of service so teams know the rules of use.' },
    { key: 'license', label: 'License', present: hasProp(props, ['License', 'x-license']), hint: 'State a license so reuse rights are clear.' },
    { key: 'tags', label: 'Tags / categories', present: Array.isArray(tags) ? tags.length > 0 : !!tags, hint: 'Tag the API so it surfaces in discovery.' },
    { key: 'companions', label: 'Companion artifacts (MCP/Plans/RateLimits)', present: hasProp(props, ['MCP', 'Plans', 'RateLimits', 'x-mcp', 'x-plans', 'x-ratelimits']), hint: 'Publish MCP / Plans / Rate Limits to make the API agent- and consumer-ready.' },
  ];

  const present = checks.filter((c) => c.present).length;
  const score = Math.round((present / checks.length) * 100);
  return { score, checks, hasApisJson };
}
