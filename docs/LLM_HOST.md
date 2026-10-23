# Connect an MCP host

The service provides tools; your compatible client supplies the model. The
included client template is keyless and starts only invented offline fixtures.
It does not install a client, change an existing configuration, grant a model
subscription, or enable live Qloo access.

## Client setup

Open [mcp-client.example.json](../mcp-client.example.json) and replace both
placeholder paths with the absolute paths for your machine. Adapt its
`mcpServers` section to the format supported by your client. Keep any existing
servers and settings. The Python executable must support Python 3.12 and the
script path must point to this extracted build.

The child command is:

```sh
python /absolute/path/to/QlooWorkbench/qloo_workbench_mcp.py --mode demo
```

This is stdio MCP, not an HTTP address. The process waits for the client's
protocol messages; running that command alone does not open a chat window.
No Qloo key or model key belongs in this template.

Allow the four `taste_*` tools only for this fixture session. Tool approval
behavior depends on the host. If an unattended host has approval policy
`never` but the tools require confirmation, it will reject the call. Resolve
that using the host's explicit per-tool authorization for these local fixture
tools; do not enable live calls or unrelated services to make the test pass.

## Two-turn human walkthrough

First ask:

> Resolve "quiet and curious" with the workbench. Show the exact returned
> labels and ask me to choose. Stop before confirming or recommending. Keep
> the fixture mode visible.

Then select one displayed label. The model should use the returned ID in
`taste_confirm`, pass its receipt to `taste_recommend`, and show the returned
shortlist. Repeating the identical recommendation should set
`cached_receipt_replay` to `true` without increasing `backend_calls`.

Keep the same MCP process and session for both turns. A receipt from a stopped
server is invalid in a new process. In demo mode all records contain
`[FICTIONAL]`; they are invented workflow examples, not Qloo recommendations.

## Actual host checkpoint

On October 23, 2026, an installed Codex CLI
`0.163.0-alpha.11.2` ran `gpt-6.1-sol` through the owner's existing ChatGPT
subscription. Its JSON event stream recorded five completed MCP calls:

1. `taste_resolve`
2. `taste_confirm`
3. `taste_recommend`
4. The identical `taste_recommend` replay
5. `taste_readiness`

The first recommendation returned three invented books; the replay was
cached and final fixture backend count was two. The test harness supplied an
exact fixture label in advance. This was an automated test choice, not a
human's preference or evidence that the model waited for a human response.

The isolated run ignored the user's config, used a read-only sandbox,
required only this fixture MCP server, disabled shell/apps/web/delegation,
and restricted auth to ChatGPT. It used no Platform API key and made zero
Qloo HTTP requests. The user's configuration and separate capability-only
Qloo connector were preserved. An initial host check exposed rejection of
standard `tools/list` metadata; the server now accepts that initial request
while rejecting unissued pagination cursors.

These results verify actual model tool use against fixtures.

A later, separately reviewed session used the same actual model host with the
real Qloo movie backend. The model completed the same five-call sequence:
resolve, confirm, recommend, identical cached replay, and readiness. The run
returned three real movie records using one tag request and one Insights
request, both HTTP 200. Final backend count was two and replay caused no new
HTTP request. The harness supplied the exact public taste label in advance;
it was not a two-turn human preference confirmation.

The live run used a fresh private v2 review and shared two-attempt ledger,
not an extension or reset of an older grant. It was stopped after the test.
The earlier backend series made nine HTTP attempts; this combined model run
added two, bringing the aggregate to eleven. All observed responses were 200.
The reviewed access basis remains an inference, not a provider billing
guarantee or ongoing judging permission.

Combined live model-tool use is therefore verified for this movie test.
Two-turn human selection, live book/artist output, and independent judge
access remain unverified. Raw local transcripts and actual Qloo records are
excluded from this source package.

## Access boundaries

Judges are not required to use this owner's Codex account. Do not share an
owner's authentication files, key, credential entry, or access policy. A
compatible model host may have its own plan limits or costs; this package
does not promise universally free model access. The owner subscription
checkpoint is not permission to expose Codex execution as a public service.

Live mode still requires independently reviewed Qloo access. Completed
diagnostic policies are stopped and provide no remaining judging budget.
See [judging instructions](JUDGING.md) and
[access conditions](ACCESS_AND_LIMITS.md).

Official references: [MCP host configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Codex non-interactive runs](https://learn.chatgpt.com/docs/non-interactive-mode),
[authentication](https://learn.chatgpt.com/docs/auth),
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference),
and [MCP pagination](https://modelcontextprotocol.io/specification/2024-11-05/server/utilities/pagination).
