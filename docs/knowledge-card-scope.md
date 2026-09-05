# Candidate Knowledge Cards and Cross-Project Scope

## Candidate cards

Relay keeps the immutable terminal event JSON in `knowledge_documents.body` as
the Raw Event. A deterministic `knowledge_candidate_cards` projection provides
the reviewer-facing summary, problem statement, facts, symptoms, hypothesis,
verification plan, actions, applicability, tags, confidence and verification
state. Hypotheses are always rendered with an `unconfirmed:` prefix until a
reviewer has moved the candidate to a verified/approved lifecycle and recorded
a conclusion. Provider-generated fields are schema-checked and unknown
Evidence IDs are rejected; provider failures fall back to deterministic cards.

Card edits use the same reviewer ACL as lifecycle changes and write an
`edit.card` review containing before/after JSON, reason, reviewer and audit
metadata. Raw Event and Evidence rows are never overwritten.

## Scope and visibility

`knowledge_scope_bindings` separates source ownership from applicability:

- `project`/`environment` bindings remain private to the source Project ACL;
- `version`, `solution`, `module`, `organization` and `system` bindings can be
  reused only when explicitly promoted and reviewed;
- cross-Project `global`/`organization` visibility requires an explicit
  generalized body and `redaction_status=redacted`;
- source Project/Case/Deployment provenance remains auditable;
- private source Evidence is not propagated to cross-Project results. Only
  Evidence explicitly ACL-bound to the target Project may be returned.

Legacy documents without a binding are backfilled as project-scoped when they
have a `project_id`, otherwise private. They are never implicitly promoted to
global visibility.

Search, REST, MCP and the SampleManager diagnosis path use the same scope
filters. Results expose scope, applicability and specificity so more concrete
environment/project knowledge ranks above version, solution/module and system
guidance without hiding applicable global knowledge.
