# Try Qloo Workbench

Public app: https://qloo-workbench.dgrrgddgrrgd.chatgpt.site

## No-key walkthrough

The page starts in **Fixture mode**, with clearly invented tags and titles. This mode uses neither Qloo nor a model. Click **Find choices**, select a returned tag, click **Confirm selected tag**, then **Get recommendations**. Inspect the chosen tag and source evidence. **Replay cached result** reuses the same result. Reset starts a fresh choice.

## Live judging

Open **Live Qloo access for judges** and enter the access password supplied privately in the Devpost entry. Do not enter a Qloo API key. Search for a public taste phrase such as `science fiction`, explicitly select and confirm a returned tag, then request up to three movies. Repeating that successful request uses its cache.

The browser is the manual selection/confirmation/recommendation companion. It does not run an LLM. To exercise the agent integration, use the four MCP tools and compatible model host described in [LLM_HOST.md](LLM_HOST.md). The original MCP implementation uses the pinned official harness; the web adapter calls the same event API routes directly. Neither relies on unsupported harness chat, plan or build modes.

## Limits and availability

The hosted app has a shared, durable maximum of **64 Qloo HTTP attempts**, including the entrant's live checks, until **November 6, 2026 at 13:45 KST** (`2026-11-06T04:45:00Z`). This is an owner-defined safeguard, not a provider free balance. A normal uncached resolve/recommend flow uses two attempts; confirmation and successful identical replay use none. Failed upstream attempts count too. Reset, fresh cookies and redeployment do not refill this allowance. Authentication, payment, rate-limit, malformed response or transport failure stops live operation safely.

The entrant's Qloo API key remains a server secret. The judge password is separate and is not included in public source. Numerical provider quota, remaining balance, exact key expiry and a provider-enforced billing hard stop remain unconfirmed. No card, purchase or paid conversion is required by the app. Continued service also depends on the provider and host being available; a cutoff is not a guarantee of uninterrupted access.

Fixture requests also have a durable limit of 20 per connection bucket and 200 globally per five-minute window. This resource safeguard is separate from the Qloo attempt cap. Expired transient records are cleaned in bounded batches; the upstream ledger is preserved.

## Source and local use

Browser implementation: `judging-site/`. Use Node.js 24.19 or newer. From that directory run `node scripts/build.mjs`, `node --test test/*.test.mjs`, then `node scripts/preview.mjs`. This local preview is fixture-only. There are no new npm dependencies. Runtime variable names are in `.env.example`; no credentials are included.

The release includes source and invented fixtures, not real Qloo responses, caches, API keys or live transcripts. The MIT license applies to this project's code; third-party services retain their own terms.
