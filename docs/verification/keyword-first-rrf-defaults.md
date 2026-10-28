# Keyword-first managed retrieval defaults

The policy comes from Relay #53: preserve technical keywords such as object
names, commands, fields, VGL, XML, paths and versions. It is not selected by
optimizing weights against five cases. The pinned engine remains v0.8.3 at
`3e22822c1d2397be730c458c7539d0eb8c113a24`.

## Causal diagnostic

The frozen 55-case HTTP run remains unchanged and is not a semantic human gold
standard. Its source Recall@10 was 0.619502. Five existing low-recall cases were
fixed before the diagnostic, with no query or label changes. Each query received
one embedding through the existing Relay gateway, then its private vector was
reused for CPU comparisons of the same document index and candidate pool.

The qwen admission ledger increased from 15,285 to 15,290; Wiki remained 27.
An initial stale internal credential produced HTTP 401 with zero admissions;
after explicit authorization, the corrected managed credential was used. No
admitted or ambiguous model result was retried. Query/vector cache files are
0600 inside a 0700 private runtime directory. No query, source text, credential
or vector is included in this report.

The actual legacy Product endpoint asks its backend for 500 results, the client
caps the upstream request at 100, and hybrid retrieval recalls 500 chunks per
modality. Earlier 250-candidate lexical SQL checks were diagnostic smaller-pool
comparisons, not exact endpoint reproductions. The final causal comparison uses
the actual 500-candidate pool.

| Fixed case suffix | Category | Best keyword rank | Best vector rank | Expected source ranks: current .7/.3 | Expected source ranks: .3/.7 |
|---|---|---:|---:|---|---|
| `1df62b3eb917aa2225eb4a8b` | VGL | 12 | 88 | 27 | 10 |
| `0bdadd9fbe211f1a540f6b0b` | XML | 37 | absent from 500 | 145 | 45 |
| `0018981e812cda9cd1e7f6bf` | Chinese / English object | 1 | absent from 500 | 73 | 1 |
| `0036766c202f4f1e9dbd5ead` | Version | 1–4 | 277–374 | 43, 44, 54, 78 | 3, 4, 5, 6 |
| `00742d284bfdceb6f871238f` | Object identifier | 4 | absent from 500 | 50 | 7 |

The source ranks are offline best-chunk aggregations of fused candidates. The
current-weight reconstruction shares 9/9/8/10/9 sources with the frozen HTTP
top ten, so it is a close diagnostic rather than a complete pipeline replay.
Changing only weights recovers expected top-ten sources in four of the five
cases. XML remains outside the top ten. Symmetric fusion recovers VGL/version;
source-level RRF with the old vector-heavy weights recovers only VGL. These
results show a ranking mechanism, not a pass of the frozen 55-case evaluation.

The private metadata report is
`runtime/retrieval-causal-five-20261026/diagnostic-metadata.json`, SHA-256
`2519b1afc91e80e25b99da9a912a7c9ac5b599100927cbb0645b96e8602b9a98`.
The fixture hash is
`63f1adda80e849a8d92727d512de507019000ab9bfdb6476458250532bc4c271`.

## Minimal compatible patch

Patch `0004-keyword-first-rrf-defaults` changes only the effective default pair:

- Nil configuration or both weights nonpositive: vector 0.3 / keyword 0.7.
- Any positive explicit weight: retain the existing positive values and legacy
  fallback pair 0.7 / 0.3 for a missing counterpart. Partial configurations retain
  their previous effective ratios.
- Preserve RRF k, all other settings, fusion math and source aggregation.

No tenant configuration ownership system, settings mutation, separate console,
model change, document re-embedding or publication change is introduced.

Patch SHA-256:
`5cadf1d80b2555b3effdbad10619d650b89522e8f26693a2e0a75238e26dcaf2`.
Regression asset SHA-256:
`ae92ed4335d919a791f048c66174f5619beb65ffc224ec1d33af7ba5d4bf214e`.

TDD evidence includes the original keyword-priority RED failure and a second
partial-configuration compatibility RED failure, followed by passing new and
existing fusion tests. The immutable build emits
`relay-keyword-first-rrf-proof.json` bound to the binary and test-log hashes.
Deployment and an unchanged 55-case HTTP regression remain separate steps.

## Frozen build artifact

The final isolated bundle is
`runtime/knowledge-engine/build-keyword-first-v2/bundle` under the nonproduction
root. Model privacy/protocol, docparser content, managed retry/queue and RRF
regressions passed; the Linux binary compiled. All 130 manifest file hashes and
proof bindings were verified. Fusion and SQLite retriever implementation hashes
remain equal to the preceding pinned bundle.

- Binary: `c3d7212c9e823b845269018127fb57834a112b95dfa02d06e6caedef65aa1d98`
- Manifest: `67237d0f6a6bc1f13c99a0f0d10e27d46ea1b3868287e8aa022465b5a86884ce`
- Keyword proof: `0a19ff1e198caa2e8def111ea1bd99a4ef9c29338ed52a20fb80d67a1487e61d`
- Upstream lock: `7ae0c924edb156549803358450003771df0ca77165bf32e652fdabd7af7f4e4b`

After successful tests and compilation, the official 7-Zip fetch failed.
Packaging resumed with the same pinned 26.05 tool from the completed v1 build;
the original installer reverified its checksums, and the original build-script
tail generated proofs and the manifest. The failed log and separate recovery
receipt are retained. The v1 bundle is superseded by v2 and is not a deployment
candidate. This work did not deploy, restart, mutate active engine settings or
make any model calls beyond the five diagnostic admissions above.

The coordinating deployment and unchanged 55-case HTTP regression subsequently completed. All cases passed reference/scope integrity checks; Recall@10 improved, while MRR/nDCG remain below the local FTS control. See [the complete final result and limits](flash-retrieval-final.md). This does not turn the diagnostic or CPU packet into a semantic gold-set pass.
