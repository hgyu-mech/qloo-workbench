# Submission checklist

This checklist is based on the official pages inspected on October 23, 2026.
It is a preparation record, not a submission receipt. Unchecked items remain
incomplete; offline tests cannot replace a required live capability.

## Schedule and eligibility

- [ ] Meet the submission deadline: October 30, 2026, 11:45 p.m. ET,
  equivalent to October 31, 12:45 p.m. KST. The internal preparation target is
  October 30 KST. [Official rules](https://qloo.devpost.com/rules)
- [x] Record the entrant's solo-entry, rights, organizer-exclusion and prior
  work confirmations privately. Personal eligibility evidence is excluded
  from this source package.
- [ ] Reconcile those facts with the actual authenticated form, including
  age, permitted residence, and organizer-related exclusions.
  [Eligibility rules](https://qloo.devpost.com/rules)
- [ ] Confirm build-period eligibility and record the original work and
  changes made during the event. The inspected submission period is
  September 30, 9:00 a.m. ET through October 30, 11:45 p.m. ET. The inspected
  existing-project sentence contains damaged wording; do not infer its
  detailed reuse conditions or treat the dates alone as reuse approval.
  [Current rules](https://qloo.devpost.com/rules)
- [x] The entrant confirmed willingness and availability if selected in the
  Top 3. The event requires a November 5 U.S. live presentation, Q&A, and
  advance preparation. Its exact time and resulting
  KST date were not established in the inspected public text. This is a
  finalist obligation, separate from an optional submission video.
  [Official overview](https://qloo.devpost.com/),
  [event updates](https://qloo.devpost.com/updates)

## Four required submission gates

### 1. Functioning application

- [ ] Provide an externally accessible functional application or test build
  that a judge can use through the complete product flow.
- [x] Validate actual model-selected MCP calls against fixtures. Codex CLI /
  `gpt-6.1-sol` completed resolve, confirmation, recommendation, cached replay,
  and readiness. The harness supplied the exact test selection in advance.
- [x] Validate combined live LLM execution. A separately reviewed actual
  model-host test completed the live movie flow and cached replay with two
  fresh Qloo HTTP requests and a supplied test choice.
- [ ] Validate a real user's two-turn selection through that host.
- [ ] Demonstrate that Qloo is central to the application's behavior and
  that the described capabilities match the working build.
  [Application requirements](https://qloo.devpost.com/)

Current status: the fixture flow and a private live movie backend diagnostic
passed. The live choice was agent-scripted, not a verified user preference.
Actual model-host fixture and separately reviewed live movie flows passed;
public application access and a human preference walkthrough remain unverified.
The keyless browser test build has also been rendered and its fixture flow
exercised locally; it has no LLM or live API switch and is not a remote endpoint.

### 2. Public source, license, and English materials

- [x] Publish the project source to a public GitHub, GitLab, or Bitbucket
  repository with a visible open-source license.
- [x] Include English project description, setup instructions, dependencies,
  and reproducible test/demo instructions.
- [x] Verify third-party software permissions and preserve required notices.
  The project license must not imply ownership or relicensing of Qloo data.
- [x] Inspect the public package itself for secrets, personal information,
  private paths, credential evidence, real API responses, caches, and live
  transcripts. Do not rely on `.gitignore` alone.
  [Source and language requirements](https://qloo.devpost.com/rules),
  [Qloo data guidance](https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide)

Source repository:
[hgyu-mech/qloo-workbench](https://github.com/hgyu-mech/qloo-workbench).
The source uses MIT with the approved public copyright holder `hgyu-mech`.
Public-source checks do not establish independent live judging access.

### 3. Actual Qloo behavior

- [x] Record a reviewed access basis for the completed diagnostic. It used
  `qloo-reviewed-event-v2` with `inferred-not-provider-guarantee`, not a
  fabricated `noOverageChargesConfirmed=true` claim. The v1 public example
  remains false/null.
- [x] Enforce a shared cumulative two-attempt ledger for that review and a
  local cutoff within 30 minutes. These controls are not provider billing
  controls or a deployment-wide quota.
- [x] Preserve numerical quota, rate, balance/reset, and exact provider expiry
  as unknown. Only the intended event host was used.
- [x] Complete actual `qloo_find_tags` output, a scripted exact returned
  `selected_tag_id`, and three `qloo_recommend` movie results with source
  provenance. An identical receipt replay caused no new HTTP request.
- [x] Exercise failure stops and private attempt accounting offline. The
  live diagnostics returned 200; no real auth/payment/rate-error response was
  observed. There was no automatic retry, alternate host/credential, or
  fixture fallback.
- [ ] Validate an actual user's selection through the chosen LLM host.
  A scripted diagnostic choice is not a user preference endorsement or
  human identity check.
- [x] Recheck the final public package to exclude all real API IDs, names,
  response records, caches, and live transcripts. Live evidence stays private.
  [Actual API requirement](https://qloo.devpost.com/),
  [API access requirements](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/API_ACCESS.md),
  [developer guide](https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide)

Current status: the final fresh backend flow passed using two requests.
The earlier backend series made nine HTTP attempts (five tags, four Insights).
A separately reviewed combined model-host movie test added two, bringing the
total to eleven (six tags, five Insights), all 200. Its supplied test choice
does not verify a human preference. All diagnostic ledgers are stopped.
Offline checks
passed 106 Python and 26 Node tests. The separate model-host fixture run used
the existing ChatGPT subscription and made zero Qloo HTTP requests.
No new payment action or inquiry email
was made. The access basis is a reviewed inference; an explicit provider
overage guarantee, actual bill, numerical allowance, and exact expiry were
not verified. The transport uses a 5 MiB body limit and a configured request
timeout of at most 15 seconds.
The browser preview passed 14 separate actual loopback HTTP tests, with no
external Qloo traffic. These are separate from the 106 network-denying tests.

### 4. Continued free judging access

- [ ] Verify the functional link from an independent judge-like environment.
  Supply any required test access without exposing the owner's credential.
- [ ] Maintain free judge access through the end of judging:
  November 5, 2026, 11:45 p.m. ET, equivalent to November 6, 1:45 p.m. KST.
- [ ] Check credential availability, aggregate usage controls, and the
  chosen host's access limits for that period. A per-process call limit
  does not establish a deployment-wide allowance.
- [ ] Keep the local cutoff distinct from the provider's exact key expiry.
  The guide's "through judging" statement is not an exact deactivation
  timestamp. [Judging access rules](https://qloo.devpost.com/rules),
  [key-period guidance](https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide)

Current status: no independent judge access or continued live operation has
been demonstrated.

## Supporting materials and final review

- [ ] Decide whether to include a video. It is optional under the inspected
  rules; do not treat its absence as a mandatory gate. If included, identify
  fixture scenes and actual live scenes accurately.
  [Submission requirements](https://qloo.devpost.com/)
- [ ] Review the authenticated Devpost form and complete its actual required
  fields. Its exact field layout has not been inspected in this preparation.
- [ ] Reconcile every claim, screenshot, command, dependency, and test result
  with the final package. The local core checkpoint passed 106 Python tests
  and 26 Node tests; those totals are offline evidence, separate from the
  completed live diagnostic.
- [ ] Preserve authorship and third-party rights records. Understand the
  rules' judging/promotional permissions before final submission.
  [IP and submission terms](https://qloo.devpost.com/rules)
- [x] Obtain the user's authorization for public MIT source with the
  copyright holder `hgyu-mech`.
- [ ] Obtain the user's authorization for registration, external app
  deployment, and final submission. Keep those states separate from source publication.
- [ ] After authorized submission, preserve the actual receipt and submitted
  links. File existence, a local ZIP, or a Devpost draft is not a receipt.

The English [description draft](DEVPOST_DESCRIPTION.md),
[testing instructions](JUDGING.md), and
[access notes](ACCESS_AND_LIMITS.md) support this checklist. They do not clear
the unchecked gates.
