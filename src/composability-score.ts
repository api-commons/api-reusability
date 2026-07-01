// Axis C — composability / agent-readiness.
//
// The emerging dimension of reuse the providers taught us: 60%+ ship Arazzo
// workflows, 40%+ ship an MCP server, most ship prebuilt integrations. This is
// the Chase/Elsevier "capabilities are the unit of reuse" thesis made measurable —
// can the API be reused as a capability, by an agent, or wired into a workflow?
import { propsByAxis, hasType } from './properties';
import type { ApiProperty } from './storage';

export interface ComposeCheck {
  key: string;
  label: string;
  weight: number;
  present: boolean;
  hint: string;
}

export interface ComposabilityScore {
  score: number; // 0..100
  checks: ComposeCheck[];
}

export function scoreComposability(properties: ApiProperty[]): ComposabilityScore {
  const props = properties || [];
  const checks: ComposeCheck[] = propsByAxis('C').map((def) => ({
    key: def.type,
    label: def.label,
    weight: def.weight,
    present: hasType(props, def),
    hint: `Publish ${def.label} — ${def.help}.`,
  }));
  const total = checks.reduce((s, c) => s + c.weight, 0) || 1;
  const score = Math.round((checks.reduce((s, c) => s + (c.present ? c.weight : 0), 0) / total) * 100);
  return { score, checks };
}
