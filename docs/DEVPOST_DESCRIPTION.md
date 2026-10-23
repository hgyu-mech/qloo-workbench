# Qloo Workbench

## Inspiration

A phrase such as "quiet and curious" leaves room for interpretation. An agent can sound confident while choosing a meaning the user never intended. Qloo Workbench makes that choice visible before it requests a shortlist.

## What it does

Resolve a public taste phrase into up to three Qloo tags, inspect their exact labels, and explicitly confirm one. A session receipt binds that returned ID to a recommendation request for up to three movies, books, or artists. Results preserve the selected tag, returned entity IDs, type and subtype, source provenance, and provider scores when supplied.

An altered or unconfirmed receipt cannot request a recommendation. Repeating the identical successful request returns its cached result without another Qloo call. Reset clears the choices without replenishing the shared allowance. The receipt records a session choice; it does not authenticate a person or establish their preferences.

The public browser starts with clearly invented fixtures. Judges can unlock real Qloo with the separately supplied access password; they never enter the provider key. The browser is a manual core-workflow companion and runs no LLM.

## Agent integration and implementation

The agent path exposes four stdio MCP tools: `taste_resolve`, `taste_confirm`, `taste_recommend`, and `taste_readiness`. A compatible model client supplies the model. The Python standard-library core uses a pinned `@qloo/qloo-harness@0.1.26` adapter for live execution. The browser's JavaScript Worker calls the official event API directly, with D1-backed receipts, sessions, and cumulative attempt reservation.

Both live paths restrict the upstream host and routes, result size, response size, and timeout. There is no automatic retry or fallback to invented data. Provider text is treated as data. The web service also checks request origin, CSRF tokens, session expiry, and judge unlock limits, and bounds fixture requests and expired-record cleanup.

## Challenges and lessons

Real Qloo responses exposed a response limit that was too small and a generic entity type paired with a concrete movie subtype. Private response replay reproduced those failures. The implementation now aligns its body cap with the pinned official client, preserves returned type/subtype, and rejects mismatches. A separate review caught unbounded fixture records in the public service, leading to durable request limits and bounded cleanup that preserves the upstream ledger.

These changes keep the choice, evidence, and execution state inspectable. An affinity score is not a probability that a person will like an item.

## Verified behavior

- A real Codex CLI `gpt-6.1-sol` session completed resolve, confirm, movie recommendation, cached replay, and readiness through MCP. It used one tag request and one Insights request, both HTTP 200, returning three movie records. The harness supplied its test choice; this was not a two-turn human preference study.
- The publicly hosted browser separately completed real tag lookup, explicit selection and confirmation, three movie results, and cached replay. Its shared count remained 2/64 after replay; confirmation and replay used no extra upstream requests.
- Local checks passed 106 guarded Python core tests, 14 loopback preview HTTP tests, 26 Node fake-transport tests, and 27 Worker/D1 web tests. Session expiry/reset recovery was checked in the local browser; hosted deployment and ledger persistence were checked separately.

Actual API verification covers movies. Books and artists are implemented targets but have not received equivalent live verification. No separate model API key was used for the verified model run.

## Try it and access limits

[Open Qloo Workbench](https://qloo-workbench.dgrrgddgrrgd.chatgpt.site). Fixture mode requires no key and makes no Qloo or LLM calls. Judges receive live-access instructions privately. [Browser guide](https://github.com/hgyu-mech/qloo-workbench/blob/codex/initial-release/docs/WEB_JUDGING.md) and [MCP host guide](https://github.com/hgyu-mech/qloo-workbench/blob/codex/initial-release/docs/LLM_HOST.md) explain the two paths.

The hosted live safeguard is 64 cumulative Qloo HTTP attempts, including entrant checks, with a cutoff of November 6, 2026 at 13:45 KST. Reset and redeployment do not refill it. This is not a provider free balance: numerical provider quota, remaining balance, exact key expiry and billing hard-stop remain unconfirmed. No card, purchase, or paid conversion was added. Future availability depends on the provider and host as well as the remaining app allowance.

The [MIT source](https://github.com/hgyu-mech/qloo-workbench) and [source release](https://github.com/hgyu-mech/qloo-workbench/releases/tag/2026-10-23-web) include the complete MCP and browser implementations, English instructions, and invented fixtures. API keys, judge credentials, real Qloo responses, private caches, and live transcripts are excluded.
