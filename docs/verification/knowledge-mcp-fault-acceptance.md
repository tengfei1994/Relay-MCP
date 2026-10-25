# #53 isolated transport fault acceptance — 2026-10-25

This is **deterministic injected-fault evidence**, not a cloud incident, live provider failure, model-success proof or semantic-quality benchmark. The running nonproduction Web, MCP, engine, profile, quota and full v3 migration were not contacted or changed by this packet.

## Executed packet

- Driver: `scripts/knowledge-mcp-fault-acceptance.ts`.
- Focused regression: `tests/knowledge-mcp-fault-acceptance.test.ts`.
- Private local report: `runtime/mcp53-injected-full-20261025.json`.
- Report SHA-256: `46386e7461e337af70e4a74a19251fb1acb532b511a0078ff9bd4a95e55685c5`.
- Executed driver SHA-256: `4a594d1f6b7f8caa86c044e5673df382704fb456dc3865fd8d5b48d454a9510f`.
- Status: `passed_injected_transport_faults`; started `2026-10-25T14:47:20.791Z`.

The driver creates fresh temporary app/Knowledge databases, synthetic credentials, one approved scoped Case, and one synthetic published/verified Product mapping. It starts three independently allocated loopback ports: an upstream HTTP fault server, the actual `knowledgeRoutes` on Fastify, and actual `registerKnowledgeTools` on SDK Streamable HTTP. It uses the unmodified `WeKnoraClient`, `product-backend` and handlers. The report pins those source hashes.

The fixture uses a synthetic authentication hook instead of real JWTs. Its MCP composition invokes the actual retrieval audit projector, but does not import the complete production MCP composition root. Real deployed JWT/outer-MCP audit coverage is recorded separately in [the seven-source zero-model acceptance](knowledge-mcp-real-acceptance.md). Neither server composition root nor worker startup is imported. No running business database is copied, and all fixture databases are removed after the packet. Reports are created with exclusive `wx` semantics and owner-only mode where supported.

## Observed results

| Injected condition | Actual HTTP handler | Actual MCP handler | Memory | Recovery |
| --- | --- | --- | --- | --- |
| Nonresponding upstream | 200, empty Product, `timeout` | usable degraded ContextPack | retained | passed |
| HTTP 429 | 200, empty Product, `rate_limited` | usable degraded ContextPack | retained | passed |
| HTTP 401 | 200, empty Product, `unauthorized` | usable degraded ContextPack | retained | passed |
| HTTP 200 with invalid JSON | 502 | `isError=true` | independently readable | passed |
| Authorized document with unverified chunk ID | 502 | `isError=true` | independently readable | passed |
| Fixture upstream listener stopped | 200, empty Product, `unavailable` | usable degraded ContextPack | retained | passed after listener restart |

The real handler timeout retained its default 30,000 ms; the paired HTTP/MCP scenario took **30,047 ms**. Supplementary actual-client requests independently checked safe error codes. The 429 client error preserved `retryAfterSeconds=7`. Supplementary timeout classification used a 150 ms client option; that does not substitute for the measured default handler timeout.

Every fault scenario sent exactly two actual upstream requests, one through each handler. Recovery used the same Relay/MCP instances, mapping, source scope and credentials. Only the synthetic upstream listener was stopped and restarted. Malformed JSON and forged references were rejected, not relabelled as successful degraded retrieval. Upstream error bodies and unverified snippets were not returned.

Foreign-actor requests returned HTTP 403 / MCP error without an upstream request. A wrong-environment HTTP request returned no Product or private Memory and made no upstream request. Every observed upstream search carried exactly the authorized document allowlist, no broad KB scope, and the expected synthetic credential.

Server-observed request counts were **28 fault HTTP + 15 Relay HTTP + 26 MCP HTTP = 69**. MCP counts include transport setup/control requests. Connection attempts while the fixture listener was closed are not counted as received upstream HTTP requests.

## Privacy and zero-model boundary

The fresh window contained **81 retrieval rows, 81 Knowledge audit rows, 20 MCP tool audits, four client traces and 6,109 bytes of Fastify logs**. Query digests retained their versioned metadata envelopes; raw query, synthetic credentials, private upstream errors, private Memory content and returned-snippet markers had zero raw/JSON/URL-encoded matches in captured telemetry and error outputs. Authorized successful responses intentionally retained necessary content.

The scan checks the known synthetic marker set, not arbitrary unknown secrets or historical logs. Log SHA-256: `5e849ae0cc0a228d6ccbc36a0f4a89c896a60c76f2846ab9030aeb3d778a6dba`. Combined telemetry SHA-256: `cb19e17d250842da038d3ed46f539ebeb84f1618b2dab03aff23214bb18e039d`.

Fresh database counters at completion: **zero configured providers, zero provider admissions, zero queued/running ingest jobs**. No real provider credentials, model endpoints, source packages or documents were used. This evidence does not claim that the real cloud service issued a 401/429, or that synthetic text proves bilingual/object/path/conflict retrieval quality.

## Reproduce

Run from the repository checkout; no remote endpoint or secret arguments are accepted:

```sh
node --import tsx scripts/knowledge-mcp-fault-acceptance.ts \
  --report runtime/mcp53-injected-NEW.json
```

The focused regression runs actual sockets for 429, invalid JSON, forged references, ACL and fixture restart, leaving the 30-second full timeout to the explicit full packet:

```sh
node --import tsx --test tests/knowledge-mcp-fault-acceptance.test.ts
npx tsc --noEmit --strict --esModuleInterop --skipLibCheck --target ES2022 \
  --module ESNext --moduleResolution bundler --allowImportingTsExtensions \
  scripts/knowledge-mcp-fault-acceptance.ts tests/knowledge-mcp-fault-acceptance.test.ts \
  src/server/index.ts
```

`src/server/index.ts` is included only in the static type-check command to supply the project's Fastify declaration merging; the driver never imports or executes it. The focused regression was observed failing before the driver existed, then passing. The fixture-restart assertion separately failed before implementation and passed afterward. The final focused test and static type check passed; the full packet then passed independently. No application source was modified for this packet.

These results complete the isolated timeout/429/401/invalid-JSON/invalid-reference/recovery portion of #53. They do not by themselves close #53: bilingual/object/path/version/conflict quality and any remaining publication-state/positive Solution scope criteria must be evaluated against their own evidence.
