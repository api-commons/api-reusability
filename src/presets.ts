// Preset inventory sets you can load to explore example reports. The synthetic
// demo org is built in; Twilio / Stripe / Atlassian are real APIs generated from
// the api-evangelist all/* repos (see tools/build-presets.mjs) and fetched on
// demand from static JSON under /presets/.
import { SAMPLES, type Sample } from './samples';

export interface PresetSet {
  id: string;
  label: string;
  kind: 'builtin' | 'file';
  url?: string;
}

const base = import.meta.env.BASE_URL; // '/' on Pages
const file = (id: string, label: string): PresetSet => ({ id, label, kind: 'file', url: `${base}presets/${id}.json` });

// The synthetic demo (autoload default) stays pinned first; the real providers
// are listed alphabetically. Labels are "Name — category".
const DEMO: PresetSet = { id: 'sample', label: 'Demo org — 25 synthetic APIs', kind: 'builtin' };
const PROVIDERS: PresetSet[] = [
  file('adyen', 'Adyen — payments'),
  file('asana', 'Asana — productivity'),
  file('atlassian', 'Atlassian — developer tools'),
  file('bigcommerce', 'BigCommerce — commerce'),
  file('binance', 'Binance — crypto'),
  file('box', 'Box — storage'),
  file('chainstack', 'Chainstack — infrastructure'),
  file('chatgpt', 'ChatGPT — AI'),
  file('claude', 'Claude — AI'),
  file('cloudflare', 'Cloudflare — infrastructure'),
  file('coveo', 'Coveo — search'),
  file('ebay', 'eBay — commerce'),
  file('fastly', 'Fastly — infrastructure'),
  file('fireblocks', 'Fireblocks — crypto'),
  file('github', 'GitHub — developer tools'),
  file('hubspot', 'HubSpot — CRM'),
  file('klarna', 'Klarna — payments'),
  file('mastercard', 'Mastercard — payments'),
  file('openai', 'OpenAI — AI'),
  file('plaid', 'Plaid — fintech'),
  file('sendgrid', 'SendGrid — email'),
  file('sentry', 'Sentry — developer tools'),
  file('shopify', 'Shopify — commerce'),
  file('slack', 'Slack — communications'),
  file('stripe', 'Stripe — payments'),
  file('twilio', 'Twilio — communications'),
  file('vtex', 'VTEX — commerce'),
  file('walmart', 'Walmart — commerce'),
  file('webflow', 'Webflow — commerce'),
  file('workday', 'Workday — HR'),
  file('worldpay', 'Worldpay — payments'),
  file('zendesk', 'Zendesk — CRM'),
].sort((a, b) => a.label.localeCompare(b.label));
export const PRESET_SETS: PresetSet[] = [DEMO, ...PROVIDERS];

export async function loadPresetSet(id: string): Promise<Sample[]> {
  const set = PRESET_SETS.find((s) => s.id === id);
  if (!set) throw new Error(`Unknown set: ${id}`);
  if (set.kind === 'builtin') return SAMPLES;
  const res = await fetch(set.url!);
  if (!res.ok) throw new Error(`${set.url} → ${res.status}`);
  const doc = await res.json();
  return (doc.apis || []).map((a: any) => ({
    name: String(a.name || 'API'),
    grouping: a.grouping || {},
    openapi: String(a.openapi || ''),
    properties: Array.isArray(a.properties) ? a.properties : [],
  }));
}
