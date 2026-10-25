# Flash retrieval: frozen 55-case regression

This is the actual authenticated Relay Product HTTP evaluation after the keyword-first default repair, completed on 2026-10-25 UTC in the isolated nonproduction environment. It is not a semantic-precision or Wiki-quality pass.

The 5,372-page manifest, all 55 queries, relevance labels, source projection and request limits were unchanged. Each case returned 10 distinct sources. All 55 completed with no citation, publication, version, scope, mapping or chunk-integrity flags. The run consumed exactly 55 logical embedding admissions; the retained embedding ledger reached 15,347 of the authorized 16,000. Upstream billable requests/tokens are not inferred from logical admissions.

| Measurement | Local FTS control | Original hybrid | Keyword-first hybrid |
| --- | ---: | ---: | ---: |
| Source Recall@10 | 0.752727 | 0.619502 | 0.831681 |
| Source MRR | 0.738636 | 0.663961 | 0.724848 |
| Source nDCG@10 | 0.725033 | 0.575430 | 0.708052 |
| Zero-recall cases | See control report | 12 | 3 |

Final category Recall@10: Chinese wording around English objects 0.937500; configuration keys 0.833333; English titles 0.779762; object identifiers 0.958333; source paths 1.000000; explicit version filter 0.766667; VGL 0.815873; XML 0.557292. End-to-end HTTP latency was P50 6,458.61 ms, P95 6,841.51 ms, maximum 9,107.99 ms. This includes the remote model and differs from the local FTS workload; no unsupported performance pass is claimed.

The fixed keyword-first policy follows #53's object/path/command requirements. Only an absent or entirely nonpositive retrieval-weight configuration receives keyword 0.7 / vector 0.3; explicit configurations retain their previous behavior. The policy was frozen before this full rerun. See [implementation and CPU evidence](keyword-first-rrf-defaults.md).

Recall improves over both controls, but MRR and nDCG remain below local FTS. There are 399 returned sources outside the frozen occurrence-based relevance labels; these are **unjudged**, not automatically false positives. Semantic Precision@10 and factual accuracy remain `not_evaluated`. The labels are not a human semantic gold set. No new acceptance threshold was invented after observing results; #55's agreed-quality-threshold gate remains open.

| Evidence | SHA-256 |
| --- | --- |
| Frozen manifest | `6e151fcae5636df1e6a682294e4985b53d6a0e59054193112321142566188b95` |
| Frozen fixture | `63f1adda80e849a8d92727d512de507019000ab9bfdb6476458250532bc4c271` |
| FTS control | `de6fdfb80ac491ca181efefabd58c2229cd4560798d219b03ab6981b9ba0a683` |
| Original HTTP run | `e3d3baeb7c0b241ec4fabf2414a101c6885dca0e88d2aae2100579a4d42566ab` |
| Final HTTP run | `e0f4254a15c030f809cc612a6e9396d96c8f7df73fe843f254f15b4f9f8e5985` |
| Engine upgrade and preserved state | `9e6eb46ec96ca35db2cfd5a973ec70bcbad787c8c291011e0f897a2f0b43a5f8` |

Private final report: `runtime/full-213-v4-flash/retrieval-http-20261025T180042827612349Z.json` beneath the approved nonproduction root. Reports retain failed and successful attempts without exporting source bodies, queries, prompts or credentials to Git.
