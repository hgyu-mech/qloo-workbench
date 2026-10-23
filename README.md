# Qloo Workbench

Make the taste choice behind a recommendation visible. Resolve a phrase into Qloo tags, explicitly confirm one returned ID, then inspect a shortlist with its source evidence. An identical successful request reuses its result without another Qloo call.

**[Open the app](https://qloo-workbench.dgrrgddgrrgd.chatgpt.site)** · [Browser guide](docs/WEB_JUDGING.md) · [Agent/MCP guide](docs/LLM_HOST.md) · [Source release](https://github.com/hgyu-mech/qloo-workbench/releases/tag/2026-10-23-web)

## Try it

The public browser opens with clearly invented fixtures and no Qloo or LLM calls. Find choices, select a tag, confirm it, and request a shortlist. Judges receive a separate password privately to open real Qloo access; no API key is entered in the page. The browser is a manual core-workflow companion, not a hosted LLM.

The agent path exposes four stdio MCP tools: `taste_resolve`, `taste_confirm`, `taste_recommend`, and `taste_readiness`. A compatible model host supplies the model. A completed Codex CLI model session used real Qloo for tag lookup and three movie recommendations, then cached replay and readiness. The exact test choice was supplied by the harness; it is not evidence of a person's preference. See [LLM_HOST.md](docs/LLM_HOST.md).

## Run the keyless tools locally

Use Python 3.12 or newer. No Python package installation is required.

```text
python taste_product.py demo
python qloo_workbench_mcp.py demo
python run_offline_tests.py
```

The first command prints the invented fixture walkthrough; the second starts the fixture MCP server. The third guards against accidental network and credential access. [JUDGING.md](docs/JUDGING.md) has exact MCP calls and additional commands.

## Browser source

The `judging-site/` directory contains the Worker/D1 app, HTML frontend, SQL migration, and tests. It adds no npm dependencies. With Node.js 24.19 or newer:

```text
cd judging-site
node scripts/build.mjs
node --test test/*.test.mjs
node scripts/preview.mjs
```

Local preview is fixture-only. Server variable names appear in `.env.example`; credentials and actual Qloo response records are excluded. The original Python core and canonical official-harness adapter remain the agent integration.

## Evidence and limits

Actual API verification covers movies. Books and artists are implemented targets but have not received equivalent live verification. The hosted browser completed real tag lookup, explicit confirmation, three movie records, and identical cached replay with two Qloo HTTP attempts. Those two attempts are included in the shared hosted cap, not added on top of it.

The app reserves each upstream attempt durably, permits no automatic retry, and stops on provider or transport failures. Its shared allowance is **64 cumulative HTTP attempts**, with a cutoff of **November 6, 2026 at 13:45 KST**. Reset and redeployment do not refill the allowance. This is an owner safeguard, not the provider's free balance. Numerical provider quota, remaining balance, exact key expiry and billing hard-stop remain unconfirmed. [Access and limits](docs/ACCESS_AND_LIMITS.md) explains the separate completed diagnostic policies.

The public package contains code and invented fixtures. Real provider data, keys, judge credentials, caches and private transcripts are excluded. MIT covers this project's source; the official harness and services retain their own terms. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
