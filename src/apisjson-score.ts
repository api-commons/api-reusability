// Axis B — operational reusability (APIs.json metadata richness).
//
// Whether an API is findable, onboardable, operable, and consumable: docs,
// getting-started, sign-up, login, sandbox, rate limits, status, changelog,
// error codes, webhooks, support, SDK/CLI/Postman, pricing, terms. The catalog +
// weights live in properties.ts (Axis B entries) so the UI and rubric never drift.
import { propsByAxis, hasType } from './properties';
import type { ApiProperty } from './storage';

export interface MetaCheck {
  key: string;
  label: string;
  weight: number;
  present: boolean;
  hint: string;
}

export interface ApisJsonScore {
  score: number; // 0..100
  checks: MetaCheck[];
  propertyCount: number;
}

export interface ApisJsonInput {
  description?: string;
  tags?: string[];
  properties: ApiProperty[];
}

export function scoreApisJson(input: ApisJsonInput): ApisJsonScore {
  const props = input.properties || [];
  const desc = (input.description || '').trim();

  const checks: MetaCheck[] = [
    { key: 'desc', label: 'Rich description', weight: 1, present: desc.length >= 40, hint: 'Describe what the API is for (40+ chars).' },
    { key: 'tags', label: 'Tagged / categorized', weight: 0.5, present: !!(input.tags && input.tags.length), hint: 'Assign org/team/domain so it surfaces in discovery.' },
    ...propsByAxis('B').map((def) => ({
      key: def.type,
      label: def.label,
      weight: def.weight,
      present: hasType(props, def),
      hint: `Add a ${def.label} property — ${def.help}.`,
    })),
  ];

  const total = checks.reduce((s, c) => s + c.weight, 0) || 1;
  const score = Math.round((checks.reduce((s, c) => s + (c.present ? c.weight : 0), 0) / total) * 100);
  return { score, checks, propertyCount: props.length };
}
