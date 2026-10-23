# Choose a judging path

For the externally hosted manual browser companion, use [WEB_JUDGING.md](WEB_JUDGING.md). It starts in fixture mode, with judge-only live access supplied privately. The browser runs no LLM. The agent/MCP workflow and its local keyless tests follow below; [LLM_HOST.md](LLM_HOST.md) describes the separately verified model integration.

---

# Testing instructions

## Verified state

The default demo uses invented fixtures and needs no credential, network, Node
installation, or model API. A separate live backend diagnostic completed on
October 23, 2026: tag resolution, a scripted exact-match selection, local
confirmation, and three movie recommendations. An identical receipt replay
made no new HTTP request.

This verifies the backend contract and actual Qloo use for that diagnostic.
A separate actual model-host fixture run completed five MCP calls, including
confirmation and cached replay, with a test-harness-supplied choice. See
[host setup and evidence scope](LLM_HOST.md). A later actual model-host run
completed the same flow with real Qloo movie data using two HTTP requests.
Both model tests used supplied test choices. A real user's personal taste
choice and independent judge access remain unverified. Source is available
at [hgyu-mech/qloo-workbench](https://github.com/hgyu-mech/qloo-workbench).
No final submission has been made.

## Run the fixture walkthrough

Use Python 3.12, the version tested for this release:

```sh
python taste_product.py demo
```

The walkthrough's choice is scripted and all fixture records are invented.
To expose the same product as a local MCP server:

```sh
python qloo_workbench_mcp.py --mode demo
```

In a compatible MCP client, use the absolute Python executable as `command`
and the absolute script path followed by `--mode`, `demo` as `args`.
The client supplies the model. This service does not run a model on its own,
and the initial live backend diagnostic made no model calls. The later
model-host checkpoints cover fixtures and a separately reviewed live movie
flow. The supplied client template still starts fixtures only.

1. Call `taste_resolve` with a short public taste query.
2. Show the returned choices and ask the user to select one.
3. Call `taste_confirm` with that `resolution_id` and the exact
   `selected_tag_id`.
4. Pass the receipt to `taste_recommend` with `target_type` set to
   `movie`, `book`, or `artist`, and `limit` from one to three.
5. Try an invalid receipt or an altered replay. It must cause no new backend
   request. An identical successful replay must return cached data.

A receipt records a local choice. It does not authenticate a person or prove
that a human clicked a control. The host is responsible for asking and
faithfully relaying the user's choice.

## Browser workflow preview

```sh
python judge_preview.py --port 8765
```

Open the printed loopback URL. The mode banner stays visible and every result
is explicitly fictional. No selection is made automatically. Find choices,
select a radio button, confirm, and request a category. Repeat the same request
to inspect the cached flag and unchanged count. Reset starts a new local
session with no selection or receipt.

The browser preview uses the same `TasteWorkbench` core and a fixture backend.
It invokes no LLM, reads no credentials, calls no external API, and has no live
switch. Its server binds only to `127.0.0.1`; do not expose it through a public
tunnel or treat it as a production server. It is an additional local workflow
test build, not a compliant live judging endpoint.

The browser walkthrough was rendered and exercised in the submitting
environment. Fourteen separate tests used actual loopback HTTP to check the
flow, reset, isolation, expiry, malformed input, request restrictions, body
limit, timeout, and expired-session reset recovery. These are local checks,
not independent remote access.

```sh
python -m unittest -v test_judge_preview.py
```

Run that command separately: the core runner intentionally forbids all socket
creation, including loopback. Do not weaken that guard to add browser tests.

## Offline checks

```sh
python run_offline_tests.py
python -m unittest -v test_taste_product.py test_live_runtime.py
node --test live/test-transport.mjs
```

The current offline core checkpoint passed 106 Python tests and 26 Node tests.
Guarded/fake transports cover receipt boundaries, policy/expiry rejection,
shared budgets, secret reflection, size/time limits, canonical projection,
and failure stops. Public tests contain no actual Qloo response data.

The source has been checked on Windows. macOS/Linux execution is intended but
has not been independently verified.

## Completed live diagnostic and its limits

The final fresh run used one tag request and one Insights request, returned
three movies, and consumed no additional HTTP request on an identical replay.
Across the earlier separately reviewed backend diagnostics, the series made
nine HTTP attempts: five tag requests and four Insights requests, all 200.
Earlier local driver, response-size, and schema issues were corrected before
the final run. Those stops were not provider HTTP-error retries.

The parser preserves Qloo's generic entity `type` and category `subtype`
rather than requiring the movie category in the generic field. This matches
the [official response example](https://github.com/qloo/docs-public/blob/main/reference/basic-insights-use-case.md).

No authentication, payment, or rate-limit errors occurred in these live
attempts. Their stop paths were exercised offline; successful HTTP responses
do not establish a zero bill, numerical quota, or exact key expiry. The live
check covered movie output. A later actual model-host movie flow succeeded
with two additional HTTP requests, both 200, and cached replay: eleven total
diagnostic attempts. Live book/artist output and two-turn human preference
confirmation remain unverified.
Real response records and names are kept private.

## Conditional live setup

The included v1 policy remains false/null and blocks live startup. The
completed diagnostic used a separate v2 event-entitlement review marked
`inferred-not-provider-guarantee`, with private evidence integrity checking,
a shared cumulative two-attempt ledger, and a cutoff within 30 minutes.
It does not grant a reviewer a credential or an unused budget.
[Access and limits](ACCESS_AND_LIMITS.md)

Once an operator has reviewed their own access basis and a valid private
policy, install the pinned dependency and use the live entry point:

```sh
npm ci --ignore-scripts --no-audit --no-fund
python qloo_workbench_mcp.py --mode live --policy private/access-policy.json
```

Node.js 22.19 or newer is required. Keep the key in the backend process
environment or the owner's existing Windows credential. Never copy an owner's
credential or private review into a public client configuration.

The transport permits at most a 5 MiB body and uses a configured request
timeout of at most 15 seconds. Inspect the returned source metadata and private
attempt count without publishing real IDs, names, responses, or transcripts.

## Before final submission

A functional external application/test-build path and continued free judge
access still need independent verification. A local actual model-host movie
test is not remote judge access. Current judging ends November 5, 2026,
11:45 p.m. ET (November 6, 1:45 p.m. KST); that is not an exact provider key
expiry. A video is optional under the inspected rules.
[Official rules](https://qloo.devpost.com/rules)

Use the [submission checklist](SUBMISSION_CHECKLIST.md). No local test, private
diagnostic, policy record, or source ZIP is a final submission receipt.
