# Qloo Workbench browser demo

This is the browser companion to [Qloo Workbench](https://github.com/hgyu-mech/qloo-workbench). It runs the same product contract: resolve a taste phrase into returned tags, explicitly confirm one tag, request a small shortlist, inspect source fields, and replay an identical request from cache.

The browser interface is a manual workflow. It does not run an LLM. The main repository separately exposes four MCP tools for compatible model clients. Actual model + Qloo movie integration was verified separately; browser fixture tests are not evidence of a live API call.

## Run locally

Use Node.js 24.19 or newer. No npm dependency installation is needed.

```sh
node scripts/build.mjs
node --test test/*.test.mjs
node scripts/validate-artifact.mjs
node scripts/preview.mjs
```

Open `http://127.0.0.1:6162/`. The local preview uses invented fixtures and disables the live API. It stores test sessions in the ignored `.local/preview.sqlite` file. Stop it with Ctrl+C. Delete no production database to reset a request counter.

## Hosted configuration

The app uses a Worker ESM entry and a separate D1 database bound as `DB`. The supplied build produces `dist/server/index.js` and the hosting manifest. The schema and journal in `drizzle/` are applied by the managed hosting workflow. The request handler does not create tables.

Configure runtime values through native server secret storage, never source files or the browser:

- `QLOO_API_KEY` — the entrant's event credential; secret.
- `JUDGE_PASSWORD` — an independent judging access code of at least 16 characters; secret.
- `QLOO_BASE_URL` and `QLOO_TRUSTED_BASE_URL` — both `https://hackathon.api.qloo.com`.
- `QLOO_ENABLE_LIVE` — `false` until the deployment and event access policy are approved.
- `QLOO_POLICY_ID`, `QLOO_VALID_UNTIL`, `QLOO_MAX_HTTP_ATTEMPTS` — a reviewed policy ID, cutoff and cumulative attempt safeguard.

The latest permitted cutoff is November 6, 2026 at 13:45 KST. The attempt cap is a local operational limit, not Qloo's free quota or a billing guarantee. Changing a policy ID or redeploying must not be used to reset an exhausted or stopped ledger. Provider quota, remaining balance, exact key expiry and overage terms are not established by this app.

## What the web adapter sends

The server calls only the event API's `/v2/tags` and `/v2/insights` endpoints using bounded GET requests. It sends the entered public taste phrase, then the exact selected tag ID, category and limit. It does not send the visitor's login, session identifier, email, device ID, or judge access code. Queries containing contact details, URLs or the credential are rejected. Visitors should enter public taste concepts only.

The adapter preserves projected provider IDs, names, type/subtype and affinity when supplied. It does not invent a per-item explanation. Affinity is not a personal probability. Redirects, oversized or malformed responses, authentication failures, timeouts and automatic retries are blocked. A failed live request consumes its reserved attempt and stops the reviewed policy for inspection.

Access-code attempts are limited within a session and by a short-lived server bucket that survives new cookies. On the hosted edge the bucket uses a keyed hash of the connecting address and a five-minute window; the raw address is neither stored nor forwarded to Qloo. Without an edge address, a shared fallback bucket applies. This is an abuse safeguard, not visitor identity verification.

## Tests and limits

Tests use Node's bundled SQLite to exercise D1-shaped SQL, fake upstream responses and a network denial guard. They cover choice/receipt binding, replay, concurrent reservations, expiry, persistence across a database reopen, failure stops, HTTP sessions, CSRF and origin checks. They do not prove hosted D1 behavior, public availability or live Qloo access. Those require separate deployment checks.

The default fixture walkthrough needs neither a key nor a model account. A published live demo additionally requires approved hosted credentials and judging access. Publishing a fixture-only build does not satisfy the contest's live demonstration requirement.
