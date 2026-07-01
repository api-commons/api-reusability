// Reusability report — a Markdown + JSON rollup of the whole inventory: per-API
// grades, org/team/domain scorecards, and the top consolidation opportunities.
// This is the artifact you'd paste into Confluence/Notion or publish via the helper.
import type { ApiRecord } from './storage';
import type { ApiScore } from './scoring';
import type { DuplicationReport } from './duplication';
import { rollup, type GroupBy } from './grouping';

export interface ReportInput {
  inventory: ApiRecord[];
  scores: ApiScore[];
  duplication: DuplicationReport;
}

const mean = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

export function buildReportJson(input: ReportInput) {
  const { inventory, scores, duplication } = input;
  const groupings: Record<GroupBy, unknown> = {
    org: rollup(inventory, scores, 'org'),
    team: rollup(inventory, scores, 'team'),
    domain: rollup(inventory, scores, 'domain'),
  };
  return {
    generated: new Date().toISOString(),
    summary: {
      apis: inventory.length,
      avgComposite: mean(scores.map((s) => s.composite)),
      avgOpenApi: mean(scores.map((s) => s.axisA.score)),
      avgApisJson: mean(scores.map((s) => s.axisB.score)),
      pathOverlapRate: duplication.pathOverlapRate,
      duplicateSchemas: duplication.duplicateSchemas,
    },
    apis: scores.map((s) => ({
      name: s.name,
      grade: s.letter,
      composite: s.composite,
      openapiScore: s.axisA.score,
      apisjsonScore: s.axisB.score,
      duplicationPenalty: Math.round(s.penalty * 100),
    })),
    groupings,
    consolidations: duplication.consolidations,
  };
}

export function buildReportMarkdown(input: ReportInput): string {
  const { inventory, scores, duplication } = input;
  const L: string[] = [];
  const avg = mean(scores.map((s) => s.composite));

  L.push('# API Reusability Report', '');
  L.push(`_Generated ${new Date().toISOString().slice(0, 10)} · ${inventory.length} APIs · average reusability **${avg}/100**_`, '');

  L.push('## Organization summary', '');
  L.push('| Metric | Value |', '| --- | --- |');
  L.push(`| APIs assessed | ${inventory.length} |`);
  L.push(`| Avg composite | ${avg}/100 |`);
  L.push(`| Avg OpenAPI (design) | ${mean(scores.map((s) => s.axisA.score))}/100 |`);
  L.push(`| Avg APIs.json (metadata) | ${mean(scores.map((s) => s.axisB.score))}/100 |`);
  L.push(`| Path overlap rate | ${duplication.pathOverlapRate}% |`);
  L.push(`| Duplicate schemas | ${duplication.duplicateSchemas} |`, '');

  for (const by of ['org', 'team', 'domain'] as GroupBy[]) {
    const rows = rollup(inventory, scores, by).filter((r) => r.key !== 'ungrouped' || rollup(inventory, scores, by).length === 1);
    if (!rows.length) continue;
    L.push(`## By ${by}`, '');
    L.push('| ' + by[0].toUpperCase() + by.slice(1) + ' | APIs | Grade | Composite | Design | Metadata |', '| --- | --- | --- | --- | --- | --- |');
    for (const r of rows) L.push(`| ${r.key} | ${r.apiCount} | ${r.letter} | ${r.avgComposite} | ${r.avgAxisA} | ${r.avgAxisB} |`);
    L.push('');
  }

  L.push('## Per-API grades', '');
  L.push('| API | Grade | Composite | Design | Metadata | Duplication |', '| --- | --- | --- | --- | --- | --- |');
  for (const s of [...scores].sort((a, b) => b.composite - a.composite)) {
    L.push(`| ${s.name} | ${s.letter} | ${s.composite} | ${s.axisA.score} | ${s.axisB.score} | ${Math.round(s.penalty * 100)}% |`);
  }
  L.push('');

  if (duplication.consolidations.length) {
    L.push('## Consolidation opportunities', '');
    for (const c of duplication.consolidations) L.push(`- ${c}`);
    L.push('');
  }

  return L.join('\n');
}
