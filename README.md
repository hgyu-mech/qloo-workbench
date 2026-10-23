# Qloo Workbench

Qloo Workbench is an MCP tool service for resolving a taste phrase, confirming
one returned tag, and requesting a shortlist with returned IDs and backend
provenance. Its tools separate discovery, confirmation, and recommendation.
A recommendation call cannot supply a different tag than the confirmed choice.

**Current status:** a live backend diagnostic passed on October 23, 2026:
tag resolution, a scripted selection of a returned tag, local confirmation,
and a three-movie shortlist. An identical receipt replay made no new HTTP
request. Actual Codex model-host runs then completed both the fixture flow
and a separately reviewed live Qloo movie flow, each with cached replay.
Their exact choices were supplied by an automated test harness. A human
selection walkthrough, independent judge access, and final submission remain
unverified. Source: [hgyu-mech/qloo-workbench](https://github.com/hgyu-mech/qloo-workbench).
The default demo still uses invented fixtures. The access
review is an inference about event-key use, not a provider billing guarantee.

## Why the confirmation step matters

A phrase such as "quiet and curious" can mean different things. The workbench
first asks the backend for up to three matching tags. A user selects one exact
returned ID. Only then can the client request movies, books, or artists using
that selected tag.

The confirmation creates a local opaque receipt. A recommendation without a
valid receipt performs no backend call. An identical replay of a successful
request returns the cached result; changing the target or limit cannot reuse
the receipt for another call. Receipts belong to one local session. They record
a selected ID and do not authenticate a person's identity.

Qloo supplies tag resolution and recommendation results in the live path. The application adds the choice boundary, session state, bounded calls,
and source projection. It does not train a preference model, calculate a
person's preference probability, or invent provider explanations.

## Run the offline demo

Use Python 3.12, the version used for the Python checks. The default demo uses
only the Python standard library and requires no account, credential, network,
Node.js installation, or separate model API key.

```sh
python taste_product.py demo
```

This walkthrough makes a scripted fixture selection. Its invented
`urn:tag:fixture:*` and `fixture-entity-*` identifiers are not real Qloo records,
and the walkthrough does not represent human confirmation or a live API test.

To serve the fixture tools over stdio MCP:

```sh
python qloo_workbench_mcp.py --mode demo
```

A compatible LLM client must supply the model and call these tools. The MCP
service does not run a model on its own. Codex CLI with `gpt-6.1-sol` has been
checked against fixtures and the live movie backend using the owner's
existing ChatGPT subscription.
See the [host template and verified scope](docs/LLM_HOST.md) and
[testing instructions](docs/JUDGING.md).

For a keyless browser walkthrough of the same fixture core, run:

```sh
python judge_preview.py --port 8765
```

Open the printed `127.0.0.1` address. Select and confirm a tag yourself, then
inspect a shortlist and its source details. The browser preview invokes no
LLM and no Qloo API. It binds only to loopback and is not a public server or
proof of live judging access. Stop it with Ctrl+C to discard session state.
Its 14 actual loopback HTTP tests run separately from the network-denying
core test runner:

```sh
python -m unittest -v test_judge_preview.py
```

## Tool sequence

| Tool | Input | Effect |
| --- | --- | --- |
| `taste_resolve` | `query`, 1 to 80 characters | Calls `qloo_find_tags` with `semantic: true` and `limit: 3`; presents only returned tags. |
| `taste_confirm` | `resolution_id`, `selected_tag_id` | Records one exact returned tag ID and creates a session-local receipt. No backend call. |
| `taste_recommend` | `receipt`, `target_type`, optional `limit` | Calls `qloo_recommend` with the selected tag, `explain: true`, and a limit from 1 to 3. |
| `taste_readiness` | No arguments | Reports the local mode, policy gate, and call budget. It does not verify authentication, quota, billing, or judge access. |

Supported target types are `movie`, `book`, and `artist`. After
`taste_resolve`, show the exact candidate labels and ask the user to choose.
Call `taste_confirm` with that result's `resolution_id` and the chosen
`selected_tag_id`; do not infer the user's selection. Pass the returned
`receipt` to `taste_recommend`.

Results retain returned entity IDs and names plus shared backend provenance,
including the endpoint and execution correlation ID. Any returned affinity or
popularity is a provider score, not a personal probability. Names and other
provider text are untrusted display data, never instructions or executable code.

## Live access and policy gates

The optional live path uses Qloo's pinned `@qloo/qloo-harness@0.1.26` canonical
MCP adapter and requires Node.js 22.19 or newer. The Python host accepts its
canonical result directly or inside MCP `structuredContent`.

The event host is `https://hackathon.api.qloo.com`. Official guidance states
that rate and monthly quotas apply and that keys remain active through judging.
The inspected public sources do not establish the numerical quota, the
credential's remaining balance, its exact deactivation timestamp, or a
guarantee against overage charges. See the
[official developer guide](https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide)
and [event access requirements](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/API_ACCESS.md).

The included `qloo-event-access-v1` example deliberately contains false/null
values and blocks startup before credential access or a child process. Its
`complimentaryConfirmed` and `noOverageChargesConfirmed` fields were not
changed to manufacture a provider guarantee.

The successful diagnostic used a separate `qloo-reviewed-event-v2` policy,
with `costCertainty: inferred-not-provider-guarantee`. It records the reviewed
event entitlement and absence of a fee notice, not a promise that billing is
impossible. The review is bound to private evidence bytes by SHA256, permits
two cumulative HTTP attempts through a shared ledger across backend restarts,
and expires within 30 minutes of review. This local cutoff is distinct from
the provider's unknown key expiry. A completed review does not grant a new
budget on restart. [Access and limits](docs/ACCESS_AND_LIMITS.md) explains both
schemas and the conditional live procedure.

The live transport is bounded to the intended host, a 5 MiB response-body
limit, and a configured request timeout of at most 15 seconds. It permits no
redirects, automatic retries, or alternate host/credential fallback. These
controls limit local activity; they do not prove a provider-wide balance or
prevent provider billing.

## Credentials and public data

A live backend can receive `QLOO_API_KEY` in its own process environment or
read an existing named Windows credential under its owner's account. The host
passes the selected key only to the backend child process. Do not place a key
in a client configuration, command line, browser bundle, repository, or demo
transcript. The child environment excludes other API keys and `NODE_OPTIONS`.

Keep real Qloo responses, caches, live transcripts, private access policies,
account evidence, and credentials out of the public source package. The
official guide permits private server-side caching and prohibits storing Qloo
response data in public repositories.
[Qloo caching guidance](https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide)

The source license does not relicense Qloo data. Original project code is
covered by [MIT](LICENSE); dependency and data boundaries are described in
[third-party notices](THIRD_PARTY_NOTICES.md).

## Verification and remaining work

Offline checks cover the preserved synthetic search/controller, the new
receipt flow, canonical projection, policy rejection, credential reflection
with fake keys, and the Node transport with fake fetch responses. A Python
subprocess test exercises the fixture stdio flow. Offline checks remain
separate from the live diagnostic. Actual model-host evidence is recorded
separately for a fixture session and a later live movie session.

```sh
python run_offline_tests.py
python -m unittest -v test_taste_product.py test_live_runtime.py
node --test live/test-transport.mjs
```

The current offline core checks passed 106 Python tests and 26 Node tests using
guarded or fake transports. The fixture launcher also completed the MCP flow
and rejected unconfirmed or altered requests.

The final live diagnostic completed one tag request and one recommendation
request, returned three movies, and replayed the successful receipt without
another request. Across the separately reviewed diagnostics in this
earlier backend series, nine HTTP attempts were made: five tag requests and
four Insights requests, all HTTP 200. Earlier runs stopped on local driver,
response-size, or schema handling; those issues were corrected before the
final fresh run. There were no observed authentication, payment, or rate-limit
errors. Successful HTTP responses do not establish a zero bill.

The selection in that diagnostic was agent-scripted from an exact returned
match. It was not a user's personal taste endorsement or a human identity
check. That initial live diagnostic made no model calls. A later fixture
model-host run was followed by a separate combined live model-host test:
five MCP calls, two fresh Qloo HTTP requests, three movies, and cached replay.
The aggregate diagnostic count is eleven HTTP attempts, all 200. Its new
two-attempt ledger was stopped afterward; older ledgers were preserved.
See [LLM_HOST.md](docs/LLM_HOST.md). Live book and artist output, human
preference selection, and independent judging access remain unverified. Real IDs, titles,
response bodies, and diagnostic transcripts stay out of the public package.

The source has been checked on Windows. macOS/Linux support is intended but
has not been independently verified.

Before final entry, validate actual user selection and independent judge
access through the complete submitted flow. The current rules require a functioning application,
actual Qloo use, English submission materials, and continued free judging
access; a video is optional.
[Official rules](https://qloo.devpost.com/rules)

The inspected submission deadline is October 30, 2026 at 11:45 p.m. ET
(October 31 at 12:45 p.m. KST). The Top 3 live presentation requirement is
separate from the optional video. Use the
[submission checklist](docs/SUBMISSION_CHECKLIST.md) to track unresolved gates.
An English [Devpost description draft](docs/DEVPOST_DESCRIPTION.md) is included
for preparation.

The earlier connector and synthetic search/controller are retained for
regression coverage. In particular, `check_connection.py` and
`qloo_connector.py` preserve the earlier one-request `/search` check; its live
cost flag is not the execution path for this product. Use
`qloo_workbench_mcp.py` as the current MCP entry point and `taste_product.py demo`
for the offline walkthrough.
