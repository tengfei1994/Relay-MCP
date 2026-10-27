# Nonproduction browser import evidence

On 2026-10-25, the headed browser used the existing administrator session at the isolated Relay service. It selected a ZIP containing one original 21.3 HTML page, that page's frozen html-3 normalized Markdown, and one previously accepted normalized 21.1 CHM source. These were genuine authorized source derivatives; they were not synthetic documentation.

The browser uploaded the ZIP, submitted version 21.3 with a per-file manifest override for the 21.1 CHM source, observed the asynchronous processing state, refreshed the page, and reopened the persisted batch details. Run `product-docs-73a948d962a9c43f05f7` reported **3 imported, 0 unchanged, 0 failed**. All three item results were visible after refresh. The run completed before the reload result was observed, so this is persisted-history recovery, not proof of reattaching to an actively running upload.

Independent database checks confirmed source hashes, parsed body hashes and versions. The HTML and its normalized Markdown produced the same normalized body hash. The provider ledger stayed at **3,960**, with zero embedding calls from this import.

| Evidence | SHA-256 |
| --- | --- |
| Uploaded ZIP | `4e9fbe9ffe5e610a93deb611f3e58161d8e42db08ed821242962b89b94c9d5f4` |
| Private result report | `12ecb9a880901d7b882af64b412b57c67bd4fed699de3fea9e7214f7e5d33759` |
| Original HTML | `df3dde3bd41185149e4db0eb929c5e8a4fd248409da8c02908e9d90dfa12c989` |
| Normalized 21.3 Markdown | `d3bd45f37d263df2a2cf2576730ae4a0b2163a75764e76d2375bec7a6ee88f8c` |
| Normalized 21.1 CHM | `c7472a3244ce0e016d27163d4817dd280063f25aca75b92877dc52ad6e185c89` |

Private files remain under `runtime/browser-upload-01` in nonproduction and the ignored local `runtime`/`output/playwright` directories. Screenshot: `output/playwright/real-formats-imported.png`.

This page imports global authoritative source documents into Relay's staging catalog. This result alone does **not** prove engine indexing, publication, retrieval or a page boundary with more than 50 published documents. The earlier embedding HTTP 403 was subsequently bypassed by the explicitly selected Flash model; see the full-corpus progress report for that separate migration.

## Actual failed-import recovery

The browser submitted a dedicated copy of the same genuine 839-byte normalized 21.3 source. Only that copy was temporarily made unreadable; the original source was unchanged. Run `product-docs-0adace5219b5ca34482c` failed with EACCES and displayed its item-level error. After restoring mode 0600 and verifying the unchanged source hash, the browser invoked **Retry failed**. Run `product-docs-a17aaad191ecad8dcd95` succeeded with **1 imported, 0 failed**. Its idempotency key identifies the original failed run, and both runs remain in history. The retry did not automatically refresh the old form's error display; refreshing history and selecting the new run exposed the successful result.

The independent metadata-only report `runtime/browser-upload-01/retry-result.json` has SHA-256 `b4bc7a9f773e32fc5f6d644126b0a0d9e8dbd12a00f467031bf7d510741a9ccb`. The resulting source is `product-document-e696ed6a82edb8fae5926684c115520a`; it shares the exact immutable revision with the earlier identical Markdown and normalized HTML. This is a genuine-source import with an injected filesystem failure, not an external provider failure. Import makes no model calls.

After deploying application archive `d13e00182ca549f5d2dc186328e490cb8581700fa049620c0ced212ae18a0b22`, opening an un-published imported legacy ID correctly returned the published-migration requirement. This confirms the publication barrier; it does not count as successful engine document-detail acceptance. Publication, detail rendering and engine paging remain separately evaluated.
