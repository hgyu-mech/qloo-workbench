# Third-party software and data

The MIT license in this repository covers the original Qloo Workbench source.
It does not relicense Qloo API data or third-party packages.

The live adapter uses `@qloo/qloo-harness` **0.1.26**, published by Qloo under
the MIT license. Its canonical MCP module and Qloo client are used through a
version-bound adapter. The dependency is installed from npm; it is not copied
into the submission ZIP. Preserve its license and bundled
`THIRD_PARTY_NOTICES.md` when redistributing that package or its dependencies.

- Official project: <https://github.com/qloo/qloo-hackathon-kit>
- npm package: <https://www.npmjs.com/package/@qloo/qloo-harness>
- Package source: <https://github.com/qloo/agentic-qloo/tree/main/apps/qloo-harness>
- Protocol: <https://modelcontextprotocol.io/specification/2024-11-05>

Qloo API access remains subject to the event credential's terms and Qloo's
applicable agreements. Public source and demo fixtures do not grant API access.

Actual Qloo responses belong in private server storage only. Do not commit
responses, caches, live transcripts, credentials or access-policy evidence to
a public repository. Demo fixture records are invented and explicitly labelled.

Official API and caching guidance:
<https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide>
<https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/API_ACCESS.md>
