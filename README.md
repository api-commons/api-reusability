# API Reusability

A browser-first tool for assessing **how reusable the APIs across your organization
really are** — modeled on [Spotlight Discovery](https://github.com/api-commons/spotlight-discovery)
and [Spotlight Validator](https://github.com/api-commons/spotlight-validator).

Live at **[reusability.apicommons.org](https://reusability.apicommons.org)**. Runs
entirely in your browser — no backend, keys stay in `localStorage`.

## What it does

1. **Discover** evidence of APIs from multiple sources:
   - **APIs.io** catalog search (no key)
   - **GitHub / GitLab / Bitbucket** code search (your token)
   - **HAR upload** — synthesize an evidence-based OpenAPI from real traffic
     (paths, parameters, headers, response schema)
   - **Gateways & Confluence** via the [local helper CLI](helper/) (AWS API Gateway,
     Kong, Tyk) — browsers can't reach these safely, so a tiny Node script pulls
     the specs into a bundle you Import.
2. **Index** everything as OpenAPI into a single **APIs.json 0.21 (YAML)** — the
   durable, re-importable reusability index for your org.
3. **Score** reusability on two axes plus cross-API duplication, and roll it up by
   **org / team / domain**.

## The reusability score

| Axis | Question | Signals |
| --- | --- | --- |
| **A — OpenAPI design** | How reusable is the interface? | operationIds, documented ops/params, response schemas, error responses, security, servers, tags, and — weighted highest — **schema reuse via `components` + `$ref`** |
| **B — APIs.json metadata** | How discoverable & adoptable is it? | description, documentation, linked OpenAPI, support, terms, license, tags, companion artifacts (MCP/Plans/Rate Limits) |
| **Duplication** | Is it already built elsewhere? | repeated paths, near-identical schemas, shared params/headers across APIs → consolidation opportunities |

**Composite** = `wA·design + wB·metadata + wD·(1 − duplication)`, graded A–F. Weights
are tunable in **Config → Scoring weights** — your org's definition of reuse is
published on the **Rubric** tab, not left undefined.

Also includes an **intent search** ("what are you trying to build?") to surface reuse
candidates before a team builds from scratch, and a **reuse ledger** to record when a
team actually adopts an existing API.

## Develop

```bash
npm install
npm run dev      # localhost dev server
npm run build    # -> dist/ (what GitHub Pages serves)
```

Deploys to GitHub Pages via `.github/workflows/pages.yml` on push to `main`.

## Why it's built this way

Grounded in what enterprise API practitioners describe as reusability: semantic
discovery "before you go down the rabbit hole and build it from scratch," a shared
taxonomy so teams can mark things reusable, composition of existing APIs into named
units, and — critically — the ability to *report reuse actually happening*.
