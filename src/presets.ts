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
export const PRESET_SETS: PresetSet[] = [
  { id: 'sample', label: 'Demo org — 25 synthetic APIs', kind: 'builtin' },
  { id: 'twilio', label: 'Twilio — real APIs (all/*)', kind: 'file', url: `${base}presets/twilio.json` },
  { id: 'stripe', label: 'Stripe — real APIs (all/*)', kind: 'file', url: `${base}presets/stripe.json` },
  { id: 'atlassian', label: 'Atlassian — real APIs (all/*)', kind: 'file', url: `${base}presets/atlassian.json` },
  { id: 'github', label: 'GitHub — real APIs (all/*)', kind: 'file', url: `${base}presets/github.json` },
  { id: 'sendgrid', label: 'SendGrid — real APIs (all/*)', kind: 'file', url: `${base}presets/sendgrid.json` },
  { id: 'plaid', label: 'Plaid — real APIs (all/*)', kind: 'file', url: `${base}presets/plaid.json` },
  { id: 'openai', label: 'OpenAI — real APIs (all/*)', kind: 'file', url: `${base}presets/openai.json` },
  { id: 'shopify', label: 'Shopify — real APIs (all/*)', kind: 'file', url: `${base}presets/shopify.json` },
  { id: 'slack', label: 'Slack — real APIs (all/*)', kind: 'file', url: `${base}presets/slack.json` },
  { id: 'claude', label: 'Claude — real APIs (all/*)', kind: 'file', url: `${base}presets/claude.json` },
  { id: 'chatgpt', label: 'ChatGPT — real APIs (all/*)', kind: 'file', url: `${base}presets/chatgpt.json` },
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
