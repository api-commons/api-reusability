# API Reusability — local helper

The web app at [reusability.apicommons.org](https://reusability.apicommons.org) runs
entirely in your browser. That's great for privacy, but a browser **cannot** safely
reach an internal API gateway or Confluence:

- **CORS** blocks cross-origin admin APIs (Kong Admin, Tyk Dashboard, AWS).
- Putting **long-lived gateway/cloud secrets in a web page** is unsafe — they'd be
  exposed to any script on the page.

So gateway and Confluence connectors run here, on your machine, as a tiny Node
script with **no npm dependencies**. It pulls specs, writes a
`reusability-bundle.json`, and you **Import** that file in the web app.

## Requirements

- Node 18+ (uses the built-in global `fetch`).
- For AWS: the [AWS CLI](https://aws.amazon.com/cli/) configured (`aws configure`)
  with `apigateway:GET` permissions.

## Configure

Set environment variables, or drop a `helper-config.json` next to `collect.mjs`:

```json
{
  "kongAdminUrl": "https://kong-admin.internal:8001",
  "kongToken": "…",
  "tykUrl": "https://tyk-dashboard.internal",
  "tykToken": "…",
  "awsRegion": "us-east-1",
  "confluenceBaseUrl": "https://your-org.atlassian.net/wiki",
  "confluenceEmail": "you@org.com",
  "confluenceToken": "…",
  "confluenceSpace": "PLATFORM"
}
```

`helper-config.json` is git-ignored — keep your secrets out of the repo.

## Collect specs into a bundle

```bash
# any combination of sources
node helper/collect.mjs --kong --tyk --aws
node helper/collect.mjs --kong -o payments-bundle.json
```

Produces `reusability-bundle.json`:

```json
{
  "format": "api-reusability-bundle",
  "apis": [
    { "name": "payments", "openapi": "…OpenAPI JSON…", "gateway": "kong", "grouping": {} }
  ]
}
```

Then in the web app: **Import → pick the bundle**. Every API is scored and added to
the inventory. Set org/team/domain on each (or pre-fill `grouping` in the bundle).

## Publish a report to Confluence

Export a Markdown report from the app (**Report → Export Markdown**), then:

```bash
node helper/collect.mjs --publish-confluence api-reusability-report.md --title "API Reusability — Q3"
```

## What each connector extracts

| Source | Pulls | Becomes |
| --- | --- | --- |
| **Kong** | `/services` + `/services/:id/routes` | one OpenAPI per service (paths from routes/methods) |
| **Tyk** | `/api/apis` | the API's OAS if OAS-native, else a proxy stub OpenAPI |
| **AWS API Gateway** | `get-rest-apis` + `get-export` (OAS30) | the exported OpenAPI per REST API/stage |

These are intentionally faithful-but-shallow: gateway metadata rarely carries full
schemas, so treat gateway-derived specs as a discovery starting point, then enrich.
