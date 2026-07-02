# API Reusability — local helper

The web app runs entirely in your browser, which is great for privacy but means it
**cannot** reach the places API evidence actually lives inside an enterprise:
gateways, catalogs, runtime clusters, schema registries, and security tools —
they're either CORS-blocked or need long-lived secrets that don't belong in a web
page.

So those connectors run here, on your machine, as a tiny Node script with **no npm
dependencies**. It pulls specs, writes a `reusability-bundle.json`, and you
**Import** that file in the web app.

## Requirements

- Node 18+ (built-in global `fetch`).
- `aws` CLI (for AWS API Gateway) and `kubectl` (for Kubernetes), if you use those.

## Configure

Environment variables, or a `helper-config.json` next to `collect.mjs` (git-ignored):

```json
{
  "backstageBaseUrl": "https://backstage.internal", "backstageToken": "…",
  "swaggerhubOwner": "my-org", "swaggerhubToken": "…",
  "postmanApiKey": "PMAK-…",
  "apigeeOrg": "my-org", "apigeeToken": "ya29.…",
  "azureApimSub": "…", "azureApimRg": "…", "azureApimService": "…", "azureToken": "…",
  "mulesoftOrgId": "…", "mulesoftToken": "…",
  "kongAdminUrl": "https://kong:8001", "kongToken": "…",
  "tykUrl": "https://tyk-dashboard", "tykToken": "…",
  "awsRegion": "us-east-1",
  "k8sContext": "prod",
  "kafkaRegistryUrl": "https://schema-registry:8081", "kafkaRegistryAuth": "Basic …",
  "crunch42Token": "…",
  "datadogApiKey": "…", "datadogAppKey": "…", "datadogSite": "datadoghq.com",
  "discoveryUrl": "https://salt-or-noname-or-traceable/export", "discoveryToken": "…",
  "confluenceBaseUrl": "https://org.atlassian.net/wiki", "confluenceEmail": "you@org.com", "confluenceToken": "…", "confluenceSpace": "PLATFORM"
}
```

## Collect

```bash
node helper/collect.mjs --backstage --swaggerhub --postman     # catalogs
node helper/collect.mjs --apigee --azure-apim --mulesoft       # gateways
node helper/collect.mjs --k8s --kafka-registry                 # runtime & events
node helper/collect.mjs --42crunch --datadog --discovery       # shadow-API discovery
node helper/collect.mjs --all                                  # everything configured
```

Produces `reusability-bundle.json` → in the web app: **Import → pick the bundle**.
Each API is scored and added to the inventory.

## Connectors — where the evidence lives

| Flag | Source | Pulls |
| --- | --- | --- |
| **Catalogs** | | |
| `--backstage` | Backstage Software Catalog | `kind: API` entities' inline `spec.definition` (OpenAPI) + owner/system |
| `--swaggerhub` | SwaggerHub registry | each API's published OpenAPI |
| `--postman` | Postman API definitions | each API's OpenAPI schema |
| `--bruno` | Bruno collections (local dir) | `.bru` request files → synthesized OpenAPI (`--bruno-dir <path>`) |
| **Gateways** | | |
| `--aws` | AWS API Gateway | `get-export` OAS30 per REST API/stage (AWS CLI) |
| `--kong` | Kong Admin API | services + routes → synthesized OpenAPI |
| `--tyk` | Tyk Dashboard | OAS-native APIs, else a proxy stub |
| `--apigee` | Google Apigee | API products' operations (paths + methods) |
| `--azure-apim` | Azure API Management | each API exported as OpenAPI |
| `--mulesoft` | MuleSoft Anypoint Exchange | REST-API assets' OpenAPI/OAS file |
| **Runtime & events** | | |
| `--k8s` | Kubernetes | Ingress + Gateway-API HTTPRoute rules → synthesized OpenAPI per host (kubectl) |
| `--kafka-registry` | Confluent/Kafka Schema Registry | subjects → OpenAPI stub carrying each event schema |
| **Security & observability** | | |
| `--42crunch` | 42Crunch API Security | each catalogued API's OpenAPI |
| `--datadog` | Datadog Software Catalog | observed `kind: API` entities (enrich with their OpenAPI) |
| `--discovery` | **Any shadow-API scanner** | a JSON list `[{name, openapi\|openapiUrl}]` exported by Salt / Noname (Akamai) / Traceable / etc. — `--discovery-url <url>` or a file |
| **Demand / adoption** | | |
| `--demand` | **Any usage source** (gateway analytics, Datadog/New Relic, access-log rollups) | a JSON list `[{name, consumers, calls, period}]` — `DEMAND_URL` or `--demand-url <url\|file>`. The app matches records to inventory APIs by name and uses them to pick the *most-used* implementation as a capability's canonical |

## Publish a report to Confluence

Export a Markdown report from the app (**Report → Export Markdown**), then:

```bash
node helper/collect.mjs --publish-confluence api-reusability-report.md --title "API Reusability — Q3"
```

## Notes

- Gateway- and catalog-derived specs are **faithful but sometimes shallow** — a
  gateway rarely carries full schemas, so treat them as a discovery starting point,
  then enrich. The score honestly reflects what's published.
- The **`--discovery`** connector is the pragmatic bridge to the API-security
  vendors (Salt, Noname/Akamai, Traceable, 42Crunch's exports, WAF logs): point it
  at any endpoint or file that lists discovered APIs and it ingests them. This is
  where **shadow and zombie APIs** — the hidden duplication — show up.
- Connectors are intentionally dependency-free and written to each product's
  documented REST shape. Verify against your instance's version and adjust as needed.
