# Devpost description draft

This is an English preparation draft. It has not been submitted. Replace the
status section with verified evidence only after the remaining gates pass.
The authenticated Devpost form and its exact field layout have not been
inspected; the sections below are draft copy, not a claim about form fields.

## Project name

Qloo Workbench

## Short description

An agent's taste interpretation should be a choice you can inspect. These MCP
tools confirm a returned tag before requesting a Qloo shortlist, preserving
the chosen ID, source evidence, and cached replay history.

## The problem

A taste request can be ambiguous. If an agent silently chooses a tag and then
recommends items, the user may receive a plausible list built on a meaning they
never intended. Qloo Workbench makes that choice visible before a
recommendation request is allowed.

## What the application does

The client calls `taste_resolve` with a short taste phrase. The backend returns
up to three candidate tags. The client shows those exact labels and asks the
user to choose. `taste_confirm` accepts one returned `selected_tag_id` and
issues a local opaque receipt.

Only a valid receipt permits `taste_recommend` to request movies, books, or
artists. The request carries the chosen tag and returns at most three items.
The result preserves returned entity IDs and names together with backend
provenance. Missing choices, unknown IDs, cross-session receipts, and altered
receipt replays cannot trigger a new recommendation call.

An identical replay of a successful request returns cached data. A backend
failure stops further calls in that session. A receipt records a local choice;
it does not prove human identity or authenticate a user.

## Qloo's role

The live path uses `qloo_find_tags` for semantic tag discovery and
`qloo_recommend` for the shortlist, through
`@qloo/qloo-harness@0.1.26`. Qloo supplies the taste resolution and
recommendation data. The application adds explicit confirmation, bounded
execution, session receipts, and a minimal projection of source evidence.

The workbench does not train a preference model or describe an affinity score
as a person's preference probability. It does not invent item-specific Qloo
explanations when none are returned. Provider text remains untrusted data.

## How it is built

A Python standard-library service exposes `taste_resolve`, `taste_confirm`,
`taste_recommend`, and a local `taste_readiness` tool over stdio MCP.
The product backend is injectable, allowing the same choice flow to be tested
with invented canonical-shaped fixtures.

A local browser preview uses that same core for explicit click-based choices,
source inspection, replay, and reset. It uses invented fixtures only and does
not run an LLM or a live API. It is not a public judging endpoint.

The optional live host uses a pinned Node.js adapter. A reviewed private
access policy must pass before credential access or child startup. The
transport restricts the host, request count, response size, redirects,
retries, and fallback behavior. A policy file records reviewed terms; it
cannot disable billing at the provider.
[Access policy details](ACCESS_AND_LIMITS.md)

The LLM is supplied by a compatible MCP client. The service itself does not
run a model. Actual Codex CLI / `gpt-6.1-sol` sessions completed the fixture
flow and a separately reviewed real Qloo movie flow using the owner's existing
ChatGPT subscription. The tests supplied exact choices in advance; neither
was a human preference confirmation.
[Host setup and verified scope](LLM_HOST.md)

## What has been verified

Offline checks exercise receipt gating, exact selected-tag propagation,
replay behavior, cross-session rejection, expiry, canonical result projection,
failure stops, fake credential reflection, and transport boundaries using
fake responses. The current offline core checks passed 106 Python tests and
26 Node tests. A launcher subprocess also completed the fixture MCP sequence.
Fourteen separate actual loopback HTTP checks cover the local browser preview.

A separate fresh live diagnostic completed tag resolution, a scripted
selection of a returned exact match, local confirmation, and three movie
recommendations. It used two HTTP requests. Replaying the successful receipt
returned the same result without another request. The earlier backend
diagnostic series made nine HTTP attempts, all 200. Local driver,
response-size, and schema issues were corrected before its final fresh run.
A later actual model-host live session completed five MCP calls
and received three movie records using two fresh HTTP requests, both 200.
Its identical replay was cached. The aggregate is eleven HTTP attempts. The
separate fixture model run used zero Qloo HTTP requests. Exact test choices
were supplied by the harness, not by a user expressing a personal preference.

The default walkthrough explicitly labels all tags and entities as invented
and makes a scripted choice. It is a demonstration of the workflow, not a
real Qloo recommendation or proof of human confirmation.

## Current submission status

- The private backend and combined model-host movie flows passed. Eleven HTTP attempts across the
  reviewed diagnostics returned 200, with no observed authentication, payment,
  or rate-limit errors. Real book/artist output has not been verified.
- The successful two-request run used a separate v2 review with
  `costCertainty: inferred-not-provider-guarantee`, a shared cumulative
  two-attempt ledger, and a cutoff within 30 minutes. The v1 public example
  retains its false/null values.
- Numerical quota, rate, remaining balance/reset, exact provider expiry, and
  an explicit billing hard-stop remain unknown. No payment method, purchase,
  paid conversion, or inquiry email was added. This is not proof of a zero bill.
- Real model-host sessions completed fixture and live movie tool flows.
  Two-turn human choice remains unverified. The automated
  test's supplied selection is not a user preference endorsement.
- Licensed source is published at
  [hgyu-mech/qloo-workbench](https://github.com/hgyu-mech/qloo-workbench).
  Independent functional judge access remains unverified.
- No final Devpost submission is represented by this draft.

The current submission rules require a functioning application using Qloo,
licensed public source with English materials, and free access for judging.
The private live diagnostic establishes actual Qloo behavior for its checked
flow; public application access and full judging readiness remain incomplete.
[Official submission rules](https://qloo.devpost.com/rules)

## Next verification

Validate a real user's explicit selection and independent
judge access. Retain the checked backend's bounded requests, source metadata,
receipt behavior, and private attempt count. Keep actual API IDs, names,
responses, and transcripts out of the public repository, as required by the
[official developer guide](https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide).

The repository URL, functional application link, and any optional video link
must be supplied only after they exist and have been checked.
