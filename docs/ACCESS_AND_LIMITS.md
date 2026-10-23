# Access and limits

A private live backend diagnostic passed on October 23, 2026. Its access basis
was reviewed event-key use without a disclosed price or paid conversion.
This is an inference, not an explicit provider guarantee that overage billing
is impossible. A policy file records the review; it cannot disable billing
at the provider.

The official event guide states that rate and monthly quotas apply, limits
may be increased per user, and keys remain active through judging. Numerical
quota, rate, balance/reset, and the exact provider expiry remain unknown.
The eleven observed HTTP 200 responses do not reveal those values or prove a
zero bill. No payment method, purchase, paid conversion, or inquiry email was
added for the diagnostic.
[Event guide](https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide#quotas-limits--key-expiration),
[API access requirements](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/API_ACCESS.md),
[Terms](https://www.qloo.com/legal/terms)

## Two distinct policy schemas

The public `access-policy.example.json` uses `qloo-event-access-v1`.
It deliberately retains false/null values and must fail before credential
access or child startup. That schema requires reviewed confirmation of
complimentary use and no overage charges, valid evidence, and a local cutoff;
its attempt limit can be one to four. Do not turn
`complimentaryConfirmed` or `noOverageChargesConfirmed` true merely to bypass
the gate. This diagnostic did not use those booleans to represent an inference.

The separate `qloo-reviewed-event-v2` schema records:

- `reviewBasis: event-entitlement-no-price-notice`;
- `costCertainty: inferred-not-provider-guarantee`;
- five reviewed facts: an event key was issued, the user authorized zero new
  spending, no fee notice was found in the issuance, no payment fields were
  displayed in the issuance form, and no paid conversion was made;
- a private review record whose exact bytes match the recorded SHA256;
- exactly two HTTP attempts and a local validity period of at most 30 minutes
  from the review time.

The public form's lack of payment fields is an observation about that form,
not an independent check of account billing state. The general terms require
fee disclosure before fees take effect and allow additional service-specific
terms. The v2 record preserves that uncertainty.
[Key request form](https://forms.gle/zz12orkLHTAneLGz6),
[Terms sections 2 and 7](https://www.qloo.com/legal/terms)

A v2 review uses one durable two-attempt ledger shared across backend restarts
for the same review record. The review and evidence are checked before calls;
restarting a child does not reset its allowance. The local cutoff is neither
the provider's key expiry nor a promise of access through judging. An expired
or exhausted review stops execution. A new diagnostic review is a separate,
deliberate scope decision, never an automatic retry or budget reset.

The policy, review record, shared ledger, and supporting account evidence
remain private. Their existence does not establish a provider-wide remaining
balance or a deployment-wide quota.

## Transport controls

Only HTTPS GET requests to `hackathon.api.qloo.com` for `/v2/tags` and
`/v2/insights` are permitted. The transport enforces the selected returned tag,
a result limit of at most three, a 5 MiB response-body limit, and a configured
request timeout of at most 15 seconds. It blocks redirects and uses no
automatic retry, alternate credential, alternate host, or fixture fallback.

Authentication, payment, rate-limit, transport, malformed-response, and local
budget failures stop the workflow. A payment instruction is not accepted or
executed. These controls limit activity; they are not provider billing controls.

One successful resolve/confirm/recommend diagnostic used two HTTP requests.
Confirmation was local. The final identical receipt replay caused no new
request. Earlier separately reviewed diagnostics stopped on local driver,
size, or schema handling; the earlier backend verification series made nine
HTTP attempts. A separate combined model-host diagnostic then used one tag
and one Insights request, bringing the total to eleven, all 200. Its exact
test selection was harness-supplied. Its separately reviewed two-attempt
ledger was stopped after the run; the old stopped ledgers were preserved.
This history grants no future requests or judging access.

All supported Qloo surfaces share the credential and its provider quota.
Switching from MCP to a CLI does not create a new allowance.
[Official API access requirements](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/API_ACCESS.md)

## Credentials and data

The backend can receive `QLOO_API_KEY` in its own process environment or use
an existing named Windows credential under its owner's account. The selected
key is passed only to the backend child and its `X-Api-Key` header. It is not
written to a client configuration, command line, browser bundle, repository,
or public transcript. Other API keys and `NODE_OPTIONS` are not inherited.

Keep actual responses, entity/tag IDs, names, private captures, caches,
transcripts, policies, and review evidence out of the public package. Public
fixtures remain invented. Qloo permits private server-side caching and
prohibits storing response data in public repositories.
[Official data guidance](https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide)

The documentation MCP service is a reference service. Do not send it a Qloo
credential or use its request-execution tool for this application.
[Official surface distinction](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/API_ACCESS.md)

## Judging access is a separate gate

Current rules require free judge access until November 5, 2026, 11:45 p.m. ET
(November 6, 1:45 p.m. KST). That obligation is separate from a 30-minute local
review and from the provider's unknown expiry timestamp. Independent judge
access, aggregate deployment controls, and a public functional link remain
unverified. [Official rules](https://qloo.devpost.com/rules)
