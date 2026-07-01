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

export const PRESET_SETS: PresetSet[] = [
  { id: 'sample', label: 'Demo org — 25 synthetic APIs', kind: 'builtin' },
  // AI
  file('openai', 'OpenAI — AI'),
  file('claude', 'Claude — AI'),
  file('chatgpt', 'ChatGPT — AI'),
  // Payments, fintech & crypto
  file('stripe', 'Stripe — payments'),
  file('adyen', 'Adyen — payments'),
  file('mastercard', 'Mastercard — payments'),
  file('klarna', 'Klarna — payments'),
  file('worldpay', 'Worldpay — payments'),
  file('plaid', 'Plaid — fintech'),
  file('fireblocks', 'Fireblocks — crypto'),
  file('binance', 'Binance — crypto'),
  // Commerce & retail
  file('shopify', 'Shopify — commerce'),
  file('bigcommerce', 'BigCommerce — commerce'),
  file('vtex', 'VTEX — commerce'),
  file('ebay', 'eBay — commerce'),
  file('walmart', 'Walmart — commerce'),
  file('webflow', 'Webflow — commerce'),
  // Developer tools & infrastructure
  file('github', 'GitHub — developer tools'),
  file('atlassian', 'Atlassian — developer tools'),
  file('sentry', 'Sentry — developer tools'),
  file('cloudflare', 'Cloudflare — infrastructure'),
  file('fastly', 'Fastly — infrastructure'),
  file('chainstack', 'Chainstack — infrastructure'),
  file('box', 'Box — storage'),
  // CRM, SaaS & enterprise
  file('zendesk', 'Zendesk — CRM'),
  file('hubspot', 'HubSpot — CRM'),
  file('asana', 'Asana — productivity'),
  file('coveo', 'Coveo — search'),
  file('workday', 'Workday — HR'),
  // Communications & messaging
  file('twilio', 'Twilio — communications'),
  file('slack', 'Slack — communications'),
  file('sendgrid', 'SendGrid — email'),
];

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
